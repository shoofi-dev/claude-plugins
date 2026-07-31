---
domain: delivery
last-verified: shoofi-server@561e3ca / 2026-07-28
scope: full-stack (shoofi-server + shoofir + delivery-web + partner booking)
reference: ./reference.md   # endpoint tables, assignment scoring, crons, data model, clients
---

# Delivery / Logistics — CORE (always read)

Driver assignment, the delivery-area model, `bookDelivery`, shifts/availability/location,
coverage. Not a money domain — but **assignment and coverage correctness is critical**
(a bad match means no driver, or a driver in the wrong zone).

## Scope
Server: `routes/delivery.js` + `routes/delivery/*`, `routes/geo.js`,
`routes/driver-shift-manager.js`, `services/delivery/*` (`assignDriver`, `delayed-assignment`,
`book-delivery`, `assignment-scheduler`, `driver-status-service`), delivery crons.
Clients: driver app (shoofir), admin delivery + **area control panel** (delivery-web),
partner booking trigger.
**Not yours:** driver **payouts** = `accountant`; order lifecycle = `orders` (you're the callee
at the booking handoff — never edit `routes/order.js`).

## ⚠️ The area model — misleading legacy names (the #1 source of delivery bugs)
**Read `docs/delivery-areas-model.md` before any coverage work.** Everything lives in the
**`delivery-company`** DB, where `store` = a delivery **company** and `customers` = **drivers**.
- **`cities`** = a **pickup ZONE** (has a geometry polygon)
- **`parentCities`** = the **TOWN**
- **`cityAreas`** = a multi-town **REGION**
- **`areas`** = a single **pickup→dropoff CONNECTION**: `cityId` = pickup zone (a **string**),
  `geometryId` = dropoff polygon, plus `price`/`minETA`/`maxETA`/`isActive`
- **`areasGeometry`** = reusable dropoff polygons

**Coverage is keyed on `area.cityId` = the PICKUP zone.** A company is dispatchable only if it
has **BOTH** `supportedCities` (permission) **AND** `supportedAreas` (the wired connection) —
`supportedCities` alone is not enough. Driver `personalSupportedAreas`, when non-empty,
**fully replaces** company coverage.
**ID trap:** `area.cityId` is a **string**, cities/`supportedCities` are **ObjectIds** — always
normalize (`getId()` / `.toString()`).

## Invariants — never weaken
1. **`DELIVERY_STATUS` is authoritative in `consts/consts.js`**: `1` waiting-approve → `2`
   approved → `3` collected/pickup → `4` delivered; `5` waiting-in-store; cancels `-1` driver,
   `-2` store, `-3` admin. **This is NOT `ORDER_STATUS`** (where DELIVERED = `12`) — never mix
   the two. Each client keeps its own copy; a change is a multi-repo PR.
2. **Assignment idempotency:** de-dupe on `originalBookId`; the pending→assigned claim is an
   atomic `updateOne({isPendingAssignment:true})` (`matchedCount===0` = another container won).
   Never bypass either.
3. **Never write `customers.isActive` directly** — always `setDriverActiveStatus`
   (`services/delivery/driver-status-service.js`), which writes `driverStatusHistory` in
   lock-step and pushes a websocket update. Direct writes create phantom history.
4. **`isActive` ≠ `isAvailable` ≠ `isOnline`** — three separate flags, don't conflate.
5. **Twins always go pending** and (single mode) must share ONE driver: the
   `twinPickupSequence:1` side drives selection, the peer mirrors it, and `assignDriverAt` is
   aligned to the later side. Breaking any of it splits a twin.
6. **Manual-admin routing:** companies with `isControlledByAdmin && manualAssignmentOnly` route
   to a company **admin**, not a driver. Don't auto-assign them.
7. **Collection name ≠ property name:** `db.bookDelivery` is bound to the MongoDB collection
   **`book-delivery`** (hyphenated) — `services/database/DatabaseInitializationService.js:28`.
   Querying `delivery-company.bookDelivery` directly returns **zero documents silently**
   (Mongo just reports an empty collection), so a read-only investigation looks like "no twin
   deliveries exist". Check the binding in that file before querying production by hand.

## Known status (human-confirmed — do NOT "fix")
- **BY DESIGN:** `isSendNotificationToDeliveryCompany` on the **central** `shoofi.store {id:1}`
  is the **GLOBAL master switch** for the delivery-company/driver integration — when off,
  **no `bookDelivery` is created platform-wide**. The **per-store**
  `storeData.isSendNotificationToDeliveryCompany` reads in `routes/order.js` are **LEGACY —
  ignore them**; the central flag wins.
- **BY DESIGN — keep it off:** the scored-assignment **recency filter is intentionally
  disabled** in `services/delivery/delayed-assignment.js` (stale-location drivers stay eligible
  so assignment isn't starved). Do not re-enable without an explicit task.
- **FIXED:** the partner app's `DELIVERY_STATUS` was off by one (showed "delivered" at pickup);
  it now matches the server. Server `consts/consts.js` is the single source of truth.
- **Awareness:** a legacy `updateDelivery` path uses different status literals; `driver-inactivate-cron`
  is currently disabled (commented out in `app.js`).

## Recipe — change assignment or coverage
1. State which of **pickup-zone / dropoff-geometry / `supportedCities` / `supportedAreas` /
   `personalSupportedAreas`** your change affects — that sentence catches most bugs by itself.
2. Confirm string-vs-ObjectId normalization on every `cityId` comparison.
3. Preserve idempotency (invariant 2) and twin coordination (invariant 5).
4. Verify status values against `consts/consts.js`, **never** a client copy.

## Definition of done
Inherit `_shared-guardrails.md` §7, plus the four recipe points above. If a client's status
copy diverges from the server, that's a **multi-repo PR**, not a local patch.
