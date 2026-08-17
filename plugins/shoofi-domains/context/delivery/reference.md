# Delivery / Logistics — Domain Context

> **Who you are:** the agent that owns **delivery / logistics** — driver assignment,
> the delivery-area model, `bookDelivery`, driver shifts/availability/location, and
> coverage. You inherit `_shared-guardrails.md`; this doc adds delivery truth. Not a
> money domain, but **assignment & coverage correctness is critical** (a bad match =
> no driver, or a driver in the wrong zone). The **area model has misleading legacy
> names — get it wrong and you cause the platform's #1 class of delivery bugs.**
> Driver **payouts** are NOT yours — they belong to `accountant` (§8).

## 0. Scope
Server: `routes/delivery.js` (barrel) + `routes/delivery/{orders,driver,admin,company,
geography}.js`, `routes/geo.js`, `routes/driver-shift-manager.js`, `services/delivery/*`
(`assignDriver.js`, `delayed-assignment.js`, `book-delivery.js`, `assignment-scheduler.js`,
`driver-status-service.js`), `lib/delivery/helpers`, delivery crons. Clients: driver app
(shoofir), admin (delivery-web), partner booking (§ Clients). **NOT yours:**
`routes/driver-reports.js` + MASAV = accountant; `routes/order.js` = orders (you're the callee at handoff).

## 1. The delivery-company DB & the AREA MODEL (read this first, every task)
Everything lives in **`delivery-company`** DB: there `store` = a delivery **company**
(not a shop), `customers` = **drivers/admins/employees**. **Read `docs/delivery-areas-model.md`.**
Legacy names — do not trust the word, trust this:
- **`cities`** = a **pickup ZONE** (has a `geometry` polygon)
- **`parentCities`** = the **TOWN** (`cityIds[]`)
- **`cityAreas`** = a multi-town **REGION**
- **`areas`** = a single **pickup→dropoff CONNECTION**: `cityId` (string) = pickup zone,
  `geometryId` = dropoff polygon, plus `price`, `minETA`, `maxETA`, `isActive`
- **`areasGeometry`** = reusable dropoff polygons (may carry `cashRestricted`)

**Coverage is keyed on `area.cityId` = the PICKUP zone.** A company is dispatchable only
if it supports **BOTH** `store.supportedCities` (ObjectId[] — permission) **AND**
`store.supportedAreas` (`[{areaId,price,minOrder,eta}]` — wired connection).
`supportedCities` alone is NOT enough (`assignDriver.js`). Driver override:
`customers.personalSupportedAreas` ([areaId]) — if non-empty it **fully replaces** company coverage.
**ID trap:** `area.cityId` is a **string**; cities/supportedCities are **ObjectIds** — always normalize (`getId()`/`.toString()`).

## 2. bookDelivery lifecycle & DELIVERY_STATUS
`delivery-company.bookDelivery`, one per delivery. `bookId = order.orderId`,
`originalBookId = order.originalOrderId` (set at partner-accept, `order.js`).
**Status constants are authoritative in `consts/consts.js`** (`DELIVERY_STATUS`):
`1` WAITING_FOR_APPROVE → `2` APPROVED → `3` COLLECTED_FROM_RESTAURANT (pickup) →
`4` DELIVERED; `5` WAITING_IN_STORE; cancels `-1` by-driver, `-2` by-store, `-3` by-admin.
Transitions: driver `approve`/`start`/`complete`/`cancel`/`waiting-in-store`
(`routes/delivery/orders.js`); admin `assign`/`reassign`/`cancel` + generic
`order/status/update` (`admin.js`); store cancel `-2`. Every transition writes a
`centralizedFlowMonitor` event. (⚠️ status-value inconsistencies exist — see §10.)

## 3. Driver assignment (`services/delivery/`)
**Area match** (`assignDriver.js findBestAreaForLocation`): customer point →
`areasGeometry.$geoIntersects` (dropoff candidates) → `areas` with those `geometryId` →
verify the **store** point sits inside that area's `cities` zone → the match gives
pickup zone (`area.cityId`) + dropoff geometry.
**Driver eligibility** (`findAllMatchingDrivers`): company must match BOTH `supportedAreas`
(areaId) AND `supportedCities` (cityId); `personalSupportedAreas` overrides. Then a
store allow/block list (`storeAssignmentMode`/`assignedStoreAppNames`).
**Load/selection**: counts active `bookDelivery` (status `1,2,3`) per driver, drops those
at `maxOrdersByAdmin`, sorts ascending by load, **random tie-break**.
**Manual-admin routing**: companies with `isControlledByAdmin && manualAssignmentOnly`
route the order to a company **admin**, not a driver (`assignmentMethod:'manual-admin-routed'`).
**Immediate vs delayed**: `book-delivery.js` picks delayed (`createPendingDelivery`,
`isPendingAssignment:true`, `assignDriverAt = pickupTime − assignmentWindowMinutes`) when
`config.useDelayedAssignment` (code default off, **`true` in production** — see CORE
invariant 2; `assignmentWindowMinutes` is **15** there, not the code's 10) **or the order is a twin**
(twins ALWAYS pend). The **assignment-scheduler** (60s, Redis-locked) processes due
pendings; the claim is atomic (`updateOne {isPendingAssignment:true}` → `matchedCount===0`
means another container won). Scored path (`delayed-assignment.js`) ranks by distance +
order-load penalty + same-store batching bonus (config in `deliveryConfig {type:'driver-assignment'}`).
**Idempotency**: de-dupe on `originalBookId`; never bypass the atomic claim.

## 4. Coverage / price / ETA
`findBestDeliveryCompany` (`book-delivery.js`) selects the store→company by **haversine
vs `company.coverageRadius`** (not a geo index) then load+distance. Price/ETA:
`POST /api/delivery/company/price-by-location` (`geography.js`) resolves geometry→areas→
`company.supportedAreas` → `{areaId, price, minOrder, eta}`. `expectedDeliveryAt =
pickupTime + area.maxETA`.
> ⚠️ **A missing or non-numeric `maxETA` does NOT fail — it produces a promise equal to
> `pickupTime`.** `maxETA` is stored as whatever the admin UI sent (`geography.js` assigns
> `req.body.maxETA` untyped), and `moment.add(NaN, 'minutes')` is a **silent no-op** that
> leaves the moment valid — it does not produce `"Invalid date"`. So `expectedDeliveryAt`
> comes out well-formed and exactly equal to the pickup time: a promise to deliver the
> instant the courier collects. The immediate-assignment path (`book-delivery.js`) has no
> fallback; the pending path (`delayed-assignment.js`) uses `|| 30`, which rescues
> null/undefined/empty but **not** a non-numeric string like `"abc"`. Any on-time metric
> must drop these — they score late essentially always, so counting them measures a config
> gap, not courier performance. Detect by comparing `expectedDeliveryAt`'s `HH:mm` to the
> stored `pickupTime` (see `services/exec-dashboard/delivery-metrics.js:parsePromisedEta`).
> Verified by execution against moment 2.30.1, not inferred.
 Geo helpers in `lib/delivery/helpers` (`computeSupportedAreasForCities`,
`resolveParentCityGeometryId`, `populateAreaGeometry`, `calculateDistance`, …).

## 5. Driver shifts, availability, location, active-status
- **Active-status chokepoint:** NEVER write `customers.isActive` directly — always
  `services/delivery/driver-status-service.js:setDriverActiveStatus` (it writes
  `driverStatusHistory` in lock-step + WS-pushes `driver_status_updated`). Direct writes create phantom history.
- **`isActive` (on shift/enabled) ≠ `isAvailable` ≠ `isOnline`** — three separate flags.
- **Location**: `POST /api/delivery/driver/location` writes `currentLocation` (GeoJSON) +
  `driverLocationHistory` (TTL) + broadcasts to admin/tracking. Driver app sends fg (10s) + background.
- **Shifts** (`routes/driver-shift-manager.js`, `driverShifts` collection): booking system
  gated by `useBookingSystem`; peak-hours per `cityArea`; permanent-drivers; block/unblock.

## 6. Crons (prod-only, Redis-locked; `docs/distributed-cron-jobs.md`)
`assignment-scheduler` (60s — assign due pendings) · `delivery-pickup-checker` (3m) ·
`delivery-completion-delay-checker` (4m) · `delivery-coverage-alert` (5m →
`shoofi.deliveryCoverageAlerts`) · `store-delivery-availability` · `driver-shift` (hourly
deactivate off-shift / remind) · `driver-daily-hours` (precompute hours) ·
`driver-inactivate` (**currently disabled** — commented out in app.js).

## 7. Data model (delivery-company DB)
- `bookDelivery` — `{status, isPendingAssignment, assignDriverAt, pickupTime, created,
  expectedDeliveryAt, area(embedded), company(embedded), driver(embedded), bookId,
  originalBookId, appName, customerLocation, order(snapshot), twinGroupId,
  twinPickupSequence, twinAssignmentMode, twinPeer, twinDegraded, *DelayNotified*}`.
- `store` (company) — `location, coverageRadius, supportedCities[ObjectId], supportedAreas
  [{areaId,price,minOrder,eta}], isControlledByAdmin, manualAssignmentOnly, accounting`.
- `customers` (drivers) — `role, isActive, isAvailable, isOnline, companyId(string),
  currentLocation, lastLocationUpdate, personalSupportedAreas[areaId], maxOrdersByAdmin,
  storeAssignmentMode, assignedStoreAppNames[]`.
- Geo: `cities, parentCities, cityAreas, areas, areasGeometry`. Ops: `driverStatusHistory,
  driverLocationHistory(TTL), driverShifts, driverDailyHours, deliveryConfig`.

## 8. Cross-domain edges (hand off, don't reach in)
- **ORDERS (you're the callee)**: at partner-accept `routes/order.js` builds `deliveryData`
  and fire-and-forgets `deliveryService.bookDelivery(...)` — **only if the GLOBAL switch
  `shoofi.store {id:1}.isSendNotificationToDeliveryCompany` is on** (else NO bookDelivery is
  created platform-wide, §10). Order cancellation mirrors into `bookDelivery` (→ `-3`). You don't edit `order.js`.
- **PAYOUTS = accountant**: driver/company pay (`routes/driver-reports.js`, `driverDailyHours`,
  `shoofi.compensations`) and MASAV are the accountant's. You provide the delivery data; they compute pay.
- **NOTIFICATIONS**: driver/store/customer push + WS (`driver_location_update`,
  `driver_status_updated`, `pickup_delayed`, `delivery_delayed`) via the notification domain.

## C — Client repos (full-stack)
### C1. shoofi-shoofir — DRIVER app (the main delivery client)
`app-type: shoofi-shoofir`, default `app-name: delivery-company`. **Location**:
`hooks/useDriverLocationTracking.ts` (fg 10s) + `utils/locationBackgroundTask.ts`
(background, requires "always" permission), both POST `delivery/driver/location`, with an
AsyncStorage offline-retry queue. **Availability/active**: `delivery/driver/availability`
+ `.../update-active-status`. **Shifts**: `services/driverShiftService.ts` → `/driver-shift-manager/*`.
**Assignment**: arrives via push/WS (not polling); lifecycle actions POST `delivery/driver/order/*`.
`DELIVERY_STATUS` copy = `1..4` (`consts/shared.ts`). Key: `stores/delivery-driver/index.ts`,
`screens/delivery-driver/*`, `hooks/{useDriverLocationTracking,use-websocket}.ts`.
**Company-admin dispatch lives HERE, not in partner:** an admin of an `isControlledByAdmin`
company (`profile.role === 'admin'`, `screens/delivery-driver/index.tsx`) gets `isAdmin`
passed into `OrderCard`, which renders the assigned-driver row + `DriverReassignModal` →
`POST delivery/admin/:adminId/order/:orderId/reassign`. This is the **only** mobile surface
that picks a driver. Twin pairs collapse into `TwinOrderCard` (`groupTwinPairs`, unless
`twinAssignmentMode === 'split'`), so anything admin-only must be wired into BOTH cards or
it silently does not exist for twins.
**Dead/inherited (leave alone):** `services/deliveryDriverService.ts` (legacy fetch dup,
`app-name: shoofi-app`), `getNearbyOrders`/`getSchedule` (no UI callers), customer-app city/address remnants.

### C2. shoofi-delivery-web — ADMIN (delivery control + area config)
`app-type: shoofi-admin`. **Management**: `apis/admin/delivery/*` → `delivery/admin/{assign,
reassign,cancel,drivers,orders,alerts}`; boards `DeliveryMonitor`, `DeliveryListAnalytics`,
`OpsDashboard`. **Live driver map**: `GET delivery/drivers/locations` + WS
(`views/admin/driver-locations/DriverLocationsMap.tsx`). **The area/coverage CONTROL PANEL**
lives here: `views/admin/delivery-areas/*` — full CRUD for cities, parent-cities, city-areas,
delivery-areas, company-areas, geometries (draw/fill-gaps/suggest). **Config**:
`views/admin/settings/DeliverySettings.tsx` (`admin/delivery-config`, `admin/twin-order-config`).
Shift admin: `apis/admin/driver-shift-manager.ts`. `DELIVERY_STATUS` copy = `1..5`.
This is where a human curates coverage — treat it as the source of truth UI for §1/§4.

### C3. shoofi-partner — STORE-OWNER (booking trigger + coverage check)
`app-type: shoofi-partner`. Books delivery: `order/book-delivery` (`{updateData:{isDeliverySent},
orderId}`), `order/book-custom-delivery` (ad-hoc), reads `delivery/book/:bookId` +
`delivery/order/:orderId/driver`. Store-side coverage/ETA: `hooks/useAvailableDrivers.ts` →
`POST /delivery/available-drivers` (`stores/shoofi-admin`). Key: `stores/orders/index.tsx`,
`screens/book-delivery/*`, `hooks/useAvailableDrivers.ts`.
**Partner has NO driver-assignment surface** — it books and reads, it never picks a driver.
**Dead/inherited (leave alone):** `components|screens|stores/delivery-driver/*` (a pre-admin
copy of the shoofir driver UI — no `isAdmin`, no reassign, no `DriverReassignModal`, and no
navigation entry point despite being registered in `navigation/MainStackNavigator.tsx`),
customer-app city/address remnants, `screens/menu/menu.tsx.backup`.

## 10. Known status / flagged for verdict (do NOT silently "fix")
1. **CONFIRMED BUG — FIXED** (partner PR #4): partner `DELIVERY_STATUS` was `0..3`, off by one
   from the server's `1..4`, so `order-timer.tsx` showed "delivered" at pickup. Partner constants
   aligned to the server. **Server `consts/consts.js` is the single source of truth** — clients copy it.
2. **Delivered-status ambiguity server-side** — `consts/consts.js` says `4`, but
   `updateDelivery` legacy uses `"0"`, and the driver location broadcast filters on `{2,3,5}`;
   the delay-checker doc says `4`. Trust `consts/consts.js`; flag before relying on a literal.
3. **CLARIFIED (human-confirmed):** `isSendNotificationToDeliveryCompany` is a **GLOBAL
   platform switch** read from the central `shoofi.store {id:1}` — the master on/off for the
   delivery-company/driver integration. When off, **no `bookDelivery` is created platform-wide**.
   The **per-store** `storeData.isSendNotificationToDeliveryCompany` reads (`order.js/5351/5422`)
   are **LEGACY — ignore them**; the central flag is authoritative (hands-off cleanup per §1c policy).
4. **KNOWN — KEEP (by design):** the scored-assignment recency filter is intentionally
   disabled (`delayed-assignment.js`) — stale-location drivers are still eligible on purpose
   (don't starve assignment). Do NOT re-enable it without an explicit task.
5. **`driver-inactivate-cron` disabled** (commented in app.js) — confirm intended.
6. **Dead/inherited** across clients (per `_shared-guardrails.md` §1c) — noted above; hands-off.

## 11. Definition of done
Inherit `_shared-guardrails.md` §7. For delivery specifically: any change to assignment,
coverage, or the area model must state which of pickup-zone/dropoff-geometry/`supportedCities`/
`supportedAreas` it affects and confirm the string-vs-ObjectId normalization; never write
`isActive` outside `setDriverActiveStatus`; preserve assignment idempotency (atomic claim +
`originalBookId`) and twin coordination; and confirm status values against `consts/consts.js`, not a client copy.
