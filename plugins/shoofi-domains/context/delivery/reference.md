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

## 2b. Delivery-only bookings (store books a courier, no order)
`services/delivery/delivery-only.js` + three `auth.required` routes in
`routes/delivery/orders.js`, all scoped by the `app-name` header. Authoritative write-up:
**`shoofi-server/docs/delivery-only-bookings.md`**.

| Route | Returns | Refusal |
|---|---|---|
| `GET /api/delivery/delivery-only/towns` | towns reachable from this store's pickup zone, each with `priceFrom/priceTo`, ETA and the store fee | `{enabled:false, reason}` |
| `POST /api/delivery/delivery-only/book` | `{success, bookId, storeFee}` | 403 gate / 400 `Town not serviceable` / 200 `{success:false, reason:"no_eligible_driver"}` |
| `POST /api/delivery/delivery-only/list` | this store's bookings, newest 200 | — |

`DELIVERY_ONLY_REASONS` (`delivery-only.js:35`): `platform_disabled`, `store_disabled`,
`store_has_no_location`, `store_outside_any_pickup_zone`, `no_area_match`,
`no_company_covers_area`, `town_not_serviceable`, `town_has_no_geometry`,
`no_eligible_driver`, `duplicate_booking` — mapped to Arabic in the partner app's
`screens/delivery-only/reasons.ts`.

**Booking document:** `isDeliveryOnly: true`, `originalBookId = idempotencyKey` (client-supplied,
**required**, ≥8 chars — `bookDelivery()` invents a random one when absent, which silently
disables its de-dupe), `dropoffParentCityId` + `dropoffTownName{AR,HE}`, `deliveryOnlyFee`
(`storeAmount`/`driverAmount`/`cityAreaId`/`vatIncluded`/`snapshotAt`, frozen by
`snapshotDeliveryOnlyFee`), `deliveryOnlyPriceRange`, `isApproximateLocation: true`,
`price` (the goods), `pickupTime` = ready-minutes. **No `order`**, **no `twinGroupId`** (absent,
not `undefined` — the driver DB has `ignoreUndefined` off, so undefined would persist as `null`
and surface in `{twinGroupId:{$exists:true}}` queries).

**De-dupe is two-layered:** a lock `delivery_only_lock:<key>` → `{duplicate:true, inProgress:true}`,
then an `originalBookId` lookup → `{duplicate:true, bookId}`. Both return **success**, so a retry
after a timeout confirms the existing booking instead of reading as "no courier available".

**List visibility is server-side:** default `{status: {$in: [1,2,3,5]}}` (an active work queue),
`isAll:true` drops the status filter entirely. Not a date toggle — there is no time window
either way. Known limits: `.limit(200)` with no pagination, and the partner's عرض الكل
checkbox is `useState(false)` so it resets on every visit.

**Logs** (OpenSearch `shoofi-server-logs`): `[delivery-only] booked|book refused|book failed|
book duplicate-inflight|book replay|book errored`, and `[delivery-cancel] bookId=… isDeliveryOnly=…
driverId=…`. `/towns` refusals are deliberately **not** logged — the screen polls it on every
open and focus, and every call is a refusal while the platform flag is off.

**Tests:** `test/integration/delivery-only-region-fee.js`, `delivery-support-gate.js`,
`store-delivery-only-expense.js`; `scripts/delivery-only-preflight.js` is a read-only prod
pre-flight for stores/regions that would book at ₪0.

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
means another container won). Scored path (`delayed-assignment.js`) ranks by distance to store +
distance to customer + route deviation + order-load penalty + same-store batching bonus +
uncollected penalty + overdue penalty + **pickup-headroom penalty** (config in
`deliveryConfig {type:'driver-assignment'}`; see CORE invariants 12-13 — a new weight must be
defaulted at the read site as well as in `DEFAULT_CONFIG`, and the arrival estimate is scored,
so `assumedDriverSpeedKmh` is a dispatch lever). Two-tier sort: over-cap couriers go last
regardless of score, so no score term can pull one past a courier below the cap.

**`routeDeviation` has a floor of 0 and the clamp on it never fires.** It is
`d(driver,store) + d(driver,customer) − d(store,customer)`, which is **≥ 0 for every driver
position** by the triangle inequality, so the `Math.max(0, routeDeviation)` guarding the weighted
term only absorbs floating-point noise (measured min `2.7e-10` over a grid covering the service
area). It reaches 0 only when the driver sits exactly on the store→customer line.

This is the rule for **anything that substitutes a synthetic driver position** (the stale-GPS
degrade is the live example): the deviation term **rises**, it does not cancel. Moving a driver to
a point `P` costs `3.5·d(P,store) + 1.5·d(P,customer) − 0.5·d(store,customer)` from the three
geometric weights (3.0 / 1.0 / 0.5) — so **two** distance terms move, not one.
⚠️ **And since the arrival estimate became scored, a fourth term moves too.** `d(P,store)` feeds
`estimatedArrivalAtStore`, which feeds `pickupHeadroom`, which charges
`(60 / assumedDriverSpeedKmh) × pickupHeadroom` per km — 2.4 points/km at the shipped defaults.
So a synthetic position costs **5.9 points per km, not 3.5**, until `MAX_PICKUP_HEADROOM_PENALTY`
(20) caps the headroom share. Any estimate of what re-pricing a driver's position will do has to
count all four.

The only substitution that would zero the deviation is `storeLocation` itself, which also zeroes
`distanceToStore` and makes the substituted driver the **best** candidate on the board; never use
it as a fallback position.
**Idempotency**: de-dupe on `originalBookId`; never bypass the atomic claim.

## 4. Coverage / price / ETA
`findBestDeliveryCompany` (`book-delivery.js`) selects the store→company by **haversine
vs `company.coverageRadius`** (not a geo index) then load+distance. ⚠️ **In production this
path cannot match anything**: its guard is `if (!company?.location?.coordinates ||
!company.coverageRadius) return null` (`book-delivery.js:802`) and neither field exists on any
of the 173 companies (§7), so it returns `null` unconditionally. Its only live caller is
`utils/store-service.js:154`. Flagged 2026-09-29, awaiting a human verdict — do not "fix" it by
inventing coverage values. Price/ETA:
`POST /api/delivery/company/price-by-location` (`geography.js`) resolves geometry→areas→
`company.supportedAreas` → `{areaId, price, minOrder, eta}`.

> ⚠️ **That endpoint is NOT what quotes a customer's shipping, and the two prices
> disagree.** The figure the customer is charged comes from
> `POST /api/delivery/available-drivers` (`routes/delivery/driver.js`) →
> `checkStoreDeliveryAvailability` (`services/delivery/availability.js`) →
> `findBestAreaForLocation` (`services/delivery/assignDriver.js`) → **`area.price`**,
> which the app reads as `availableDrivers?.area?.price` and posts back as
> `order.shippingPrice`. `price-by-location` reads the delivery COMPANY's own copy in
> `supportedAreas[]` and needs a `companyId`. Measured 2026-10-09 over
> `delivery-company.store` (the delivery-company documents, despite the collection
> name): **3,656 of 17,871 company-area pairs carry a different price from the area
> itself — 20.5%** — and the common shape is `supportedAreas[].price: 0` against a real
> `areas.price` of ₪20-25. Quote a customer off `supportedAreas` and a fifth of them are
> wrong, most of those free. `areas.price` is the tariff; n=217, min ₪15, max ₪100,
> avg ₪36.35.
>
> ⚠️ **`checkStoreDeliveryAvailability` is expensive — do not call it just for a price.**
> It wraps `findBestAreaForLocation` and then fires one `customers.find` **per supporting
> company**; an area is listed by ~88 companies on average and 198 at worst. For a
> tariff alone call `findBestAreaForLocation` directly (two indexed geo queries over a
> 39-doc `areas-geometry` and an 18-doc `cities`), which is what
> `services/delivery/area-tariff.js` does.
>
> ⚠️ **`order.shippingPrice` is client-quoted and validated nowhere.** Harmless while the
> fee is only ADDED to the total; it stops being harmless the moment something is derived
> from it — a free-delivery discount becomes an uncapped cash payout to the courier at
> `routes/driver-reports.js:164`. Measured over 17,031 delivered bookings in 60 days it
> equals `area.price` on 97.0%, so a server-side ceiling is inert on the honest path.

**`expectedDeliveryAt = pickupTime + max(area.maxETA, 8 min + km/18 km/h)`** — the
store→customer distance, with the admin's `maxETA` as a **floor**. One implementation,
`services/delivery/delivery-promise.js:computeDeliveryPromise`, called by both writers
(`delayed-assignment.js:createPendingDelivery` and `book-delivery.js:bookDelivery`); the
constants are overridable per-deployment as `promiseBaseMinutes` / `promiseSpeedKmh` in
`deliveryConfig {type:'driver-assignment'}`. It was a flat `pickupTime + area.maxETA` until
2026-09-29, which made lateness climb straight through the distance bands (29.3% at 0-1 km
→ 62.7% at 5+ km over 25,753 completed deliveries) while the promise moved ~2 minutes.
> ⚠️ **The floor is load-bearing, not a detail: this computation may only ever LENGTHEN a
> promise.** Every consumer — the customer's order timer, the ops late alert
> (`routes/delivery/admin.js:104`, `:881`), the overdue term in driver scoring
> (`driver-load.js`) — is safe against it precisely because it can never hand back a
> tighter number than `maxETA`. Anything unusable (no coordinates, a `Number(null)`-style
> zero pair, a distance over 60 km) degrades to the floor alone, which is the pre-2026-09-29
> value. Do not "simplify" it into a plain distance formula.
> ⚠️ **`maxETA: 0` is UNSET, not a floor of zero** (`areaFloorMinutes` tests `> 0`) — the one
> place a real zero is not honoured, and the reason is the rule above. The pending path read
> `parseInt(area?.maxETA || 30)`, so a zero has always meant **30 minutes** in production;
> honouring it would let the distance term alone govern and promise ~18 min at 3 km, which is
> *shorter* than today. Zeros are machine-minted, not typed — `routes/delivery/admin.js:2294`
> fills a gap area with `refArea?.maxETA || 0` and `:2306` rounds a ratio onto one.
> ⚠️ **The promise is a DISPATCH lever, not only a customer-facing number.** A courier's
> modelled free time is `parsePromisedEta` on the run he is already carrying
> (`delayed-assignment.js:calculateDriverScore`, the `usingFutureLocation` branch), which
> feeds `estimateArrivalAtStore` → the `pickupHeadroom` term (invariant 13). So a longer
> promise **relaxes the overdue term (−15/order) and tightens the headroom term (+1 pt per
> minute, capped at 20)** on the same courier — "it can only lengthen" is a statement about
> the promise, never about the score. It also decides WHICH in-flight order is taken as his
> future location (latest promise wins), so a far drop can now outrank a nearer one booked
> later and move `distanceToStore` itself. Covered by
> `test/integration/delivery-promise-dispatch-interaction.js`.
> ⚠️ **`expectedDeliveryAt` is NOT recomputed on reassignment** (`admin.js:150`, `:358`,
> `driver.js:266`) and that is deliberate — the promise is made to the customer at booking
> and the app has already shown it. The one legitimate mutator is
> `POST /api/order/update-delay`, which **SHIFTS** it and preserves
> `originalExpectedDeliveryAt`; see the verdict at `routes/order.js:6749-6754`.
> ⚠️ **Historical rows (pre-2026-09-29) can carry a promise equal to `pickupTime`.** `maxETA`
> is stored as whatever the admin UI sent (`geography.js` assigns `req.body.maxETA` untyped),
> and `moment.add(NaN, 'minutes')` is a **silent no-op** that leaves the moment valid — it
> does not produce `"Invalid date"`. The old immediate path had no fallback at all and the
> old pending path's `|| 30` did not rescue `"abc"`. Any on-time metric must still drop these
> — they score late essentially always, so counting them measures a config gap, not courier
> performance. Detect by comparing `expectedDeliveryAt`'s `HH:mm` to the stored `pickupTime`
> (`services/delivery/late-delivery.js:isZeroEtaPromise`). Verified by execution against
> moment 2.30.1, not inferred. `computeDeliveryPromise` cannot produce the value (it floors
> at 1 minute), so the ~27 bookings/quarter in `maxETA: 0` areas that used to be excluded as
> unmeasurable now **re-enter** the late-delivery denominator — a falling `unmeasurable`
> count is that fix landing, and the pre/post-2026-09-29 populations are not comparable.
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
- `store` (company) — `supportedCities[ObjectId], supportedAreas
  [{areaId,price,minOrder,eta}], isControlledByAdmin, manualAssignmentOnly, accounting`.
  ⚠️ **No `location` and no `coverageRadius`** — verified 2026-09-29 as the union of every key
  across all 173 documents. Do not reach for `company.location` as a fallback position for a
  courier: it is `undefined` for every company, so `company.location.coordinates[0]` throws,
  and inside `calculateDriverScore` that lands in the catch and returns `score: 9999` with
  `distanceToStore: 0` — silently mis-ranking instead of erroring.
- `customers` (drivers) — `role, isActive, isAvailable, isOnline, companyId(string),
  currentLocation, lastLocationUpdate, lastFixAt, locationMetadata,
  personalSupportedAreas[areaId], maxOrdersByAdmin,
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
**Delivery-only:** `components/delivery-driver/OrderCard.tsx` renders a `طلب يدوي` badge on its
own row and **replaces the order table with a two-line money block** (تدفع للمتجر / تحصّل من الزبون,
both `order.price`) — the order panel would otherwise render an all-zero table, since there is
no order.
**Dead/inherited (leave alone):** `services/deliveryDriverService.ts` (legacy fetch dup,
`app-name: shoofi-app`), `getNearbyOrders`/`getSchedule` (no UI callers), customer-app city/address remnants.

### C2. shoofi-delivery-web — ADMIN (delivery control + area config)
`app-type: shoofi-admin`. **Management**: `apis/admin/delivery/*` → `delivery/admin/{assign,
reassign,cancel,drivers,orders,alerts}`; boards `DeliveryMonitor`, `DeliveryListAnalytics`,
`OpsDashboard`. **Live driver map**: `GET delivery/drivers/locations` + WS
(`views/admin/driver-locations/DriverLocationsMap.tsx`); its pins and the restaurant↔customer
colour pairing (`getOrderColor(bookId)`, a hash into a fixed 15-slot palette) live in
`src/utils/driver-map-markers.ts` so every admin map draws the same order in the same colour.
The live-ops board (`views/admin/live-ops/`) reads `POST analytics/deliveries` like the delivery
list, resolves `pickupTime` (bare `"HH:mm"`, wraps at midnight) against `expectedDeliveryAt`,
and re-assigns through `delivery/admin/reassign` with the same 409 `needsConfirmation` handshake. **The area/coverage CONTROL PANEL**
lives here: `views/admin/delivery-areas/*` — full CRUD for cities, parent-cities, city-areas,
delivery-areas, company-areas, geometries (draw/fill-gaps/suggest). **Config**:
`views/admin/settings/DeliverySettings.tsx` (`admin/delivery-config`, `admin/twin-order-config`).
Shift admin: `apis/admin/driver-shift-manager.ts`. `DELIVERY_STATUS` copy = `1..5`.
**Delivery-only:** `DeliveryListAnalytics.tsx` marks these rows with a `ידנית` badge and shows a
`ביטול משלוח` button — `isDeliveryOnly && !CLOSED_DELIVERY_STATUSES.includes(status)` — which
POSTs `delivery/order/status/update` with `status: -3`. That route clears `isPendingAssignment`
and pushes the driver a cancellation (see CORE invariants 10–11).
This is where a human curates coverage — treat it as the source of truth UI for §1/§4.

### C3. shoofi-partner — STORE-OWNER (booking trigger + coverage check)
`app-type: shoofi-partner`. Books delivery: `order/book-delivery` (`{updateData:{isDeliverySent},
orderId}`), `order/book-custom-delivery` (ad-hoc), reads `delivery/book/:bookId` +
`delivery/order/:orderId/driver`. Store-side coverage/ETA: `hooks/useAvailableDrivers.ts` →
`POST /delivery/available-drivers` (`stores/shoofi-admin`). Key: `stores/orders/index.tsx`,
`screens/book-delivery/*`, `hooks/useAvailableDrivers.ts`.
**Delivery-only booking (§2b) lives here:** `screens/delivery-only/{book,list}/index.tsx`,
`stores/delivery-only/index.ts` (`isBookable = enabled && towns.length > 0`), `reasons.ts`.
The town dropdown is `react-native-dropdown-picker`, whose list renders **inline** — siblings
after it paint over it, and `zIndex` fixes only iOS while `elevation` reorders the whole
subtree on the Urovo POS, so the quote lines below it are unmounted while it is open.
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
