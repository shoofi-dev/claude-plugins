---
domain: delivery
last-verified: shoofi-server@327fa80 / 2026-09-18
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
partner booking trigger + **delivery-only booking screens**.
Also yours: `services/delivery/delivery-only.js` and the three
`/api/delivery/delivery-only/*` routes in `routes/delivery/orders.js`.
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
**`isActive` trap — an area is dispatchable only on a STRICT `true`.** `findBestAreaForLocation`
builds `areaQuery.isActive = true` (`services/delivery/assignDriver.js`), and the coverage-alert
and store-availability crons filter the same way. But **`POST /api/delivery/area/add` never sets
the field** (`routes/delivery/geography.js`) — so an area created through that route has
`isActive: undefined` and **is already not serving**, silently, from birth. (`/admin/area/quick-add`
in `routes/delivery/admin.js` does set `isActive: true`; the two creation paths disagree.)
Consequences: `find({isActive: true})` and `find({isActive: {$ne: false}})` return **different
sets**, and the second one is wrong for anything dispatch-related. Note the asymmetry with the
scope documents above it — `cityAreas.isActive` and `parentCities.isActive` really are read as
`{$ne: false}`, so absent means active *there*. Same field name, opposite default, one collection
apart. Anything reasoning about whether an area was serving must use `isActive === true`.

## Delivery-only — a courier with no order behind it
A store can book a driver for goods **Shoofi never sold**: owner picks a town, gives a phone
and a ready-time, a courier goes. `services/delivery/delivery-only.js` +
`GET|POST /api/delivery/delivery-only/{towns,book,list}` (`routes/delivery/orders.js`).
Full write-up: **`shoofi-server/docs/delivery-only-bookings.md`**.

- The document is an ordinary `bookDelivery` with **`isDeliveryOnly: true` and no `order`**
  (the single exception is `order.order.commentToCourier`). Same `DELIVERY_STATUS` enum, same
  assignment engine, same driver app — it invents no statuses and no second pipeline.
- `customerLocation` is a **dispatch point inside the chosen town**, flagged
  `isApproximateLocation: true` — not an address. The driver phones the customer for the
  real one, which is also why a town is quoted as a **price range** (`deliveryOnlyPriceRange`,
  frozen at booking) and not a price: one town holds many areas at different prices.
- Towns are recovered **geometrically** (dropoff polygon → `cities` → `parent-cities`); areas
  carry no dropoff city id. Matching `areas.geometryId` to `parentCities.geometryId` matches
  nothing in prod — that bug shipped once and emptied the dropdown for every store.
- **Gate = OR of two flags**, both named `isDeliveryOnlySupport`: central `shoofi.store {id:1}`
  (on for everybody) and `<appName>.store {id:1}` (on for one store). Resolved server-side and
  exposed as the computed `isDeliveryOnlyActive` on `GET /api/store`; never re-implement it.
- **Three separate numbers, never mixed:** `price` = the goods (driver pays the store, collects
  from the customer — never Shoofi revenue, never a commission base);
  `deliveryOnlyFee.storeAmount` = store→Shoofi; `deliveryOnlyFee.driverAmount` = driver→Shoofi.
  Both fees are **region** (`city-areas`) values, so a town whose region is unset books at a
  silent ₪0 — `node scripts/delivery-only-preflight.js` (read-only) lists those.
- Reports **exclude** delivery-only from ordinary delivery counts
  (`isDeliveryOnly: { $ne: true }` in `driver-reports.js`, `payments/summaries.js`,
  `exec-dashboard/delivery-metrics.js`) and add the two fees as their own settlement lines.
- The store's list is filtered **server-side**: default = active work queue (`1,2,3,5`),
  عرض الكل = no status filter at all (not a date toggle), newest 200, `appName`-scoped.

## Invariants — never weaken
1. **`DELIVERY_STATUS` is authoritative in `consts/consts.js`**: `1` waiting-approve → `2`
   approved → `3` collected/pickup → `4` delivered; `5` waiting-in-store; cancels `-1` driver,
   `-2` store, `-3` admin. **This is NOT `ORDER_STATUS`** (where DELIVERED = `12`) — never mix
   the two. Each client keeps its own copy; a change is a multi-repo PR.
   **The stored value is a STRING on 95,989 production rows and a BSON `int` on 72 of them**
   (all `-3`, created 2025-08-05 → 2025-11-30; no current writer produces them — every one
   goes through the const). A string-only `$in` therefore under-counts silently: the delivery
   list's own filter builds `match.status = { $in: status }` from the client's strings
   (`routes/analytics.js:314-316`), so ticking "בוטל על ידי המנהל" returns 1,107 rows when
   1,179 exist. **Any query that filters on `status` must accept both types**
   (`{$in: ["-3", -3]}`); display is safe, because a JS object lookup coerces the key. The
   cancels are not a corner either — `-3` is the second-largest status in the collection after
   `4`, 1,089 of them `cancelledBy: "admin"`, so a label map or a report that omits it is
   blanking a four-figure population, not an edge case.
2. **Assignment idempotency:** de-dupe on `originalBookId`; the pending→assigned claim is an
   atomic `updateOne({isPendingAssignment:true})` (`matchedCount===0` = another container won).
   Never bypass either.
   **Delayed assignment is ON in production, and the window is 15 — not the code's 10.**
   `DEFAULT_CONFIG` in `services/delivery/delayed-assignment.js:17-19` says
   `useDelayedAssignment: false, assignmentWindowMinutes: 10`; both are overridden by
   `delivery-company.delivery-config {type:'driver-assignment'}`, which holds
   `{useDelayedAssignment: true, assignmentWindowMinutes: 15}`. Read the DB document, never
   the constant. Consequence: the platform is *designed* to dispatch at `pickupTime − 15`
   (`delayed-assignment.js:483-485`), so "this courier only got twelve minutes' notice" is
   normal operation rather than an anomaly — 559 of 4,957 completed deliveries in 1–17 Aug
   2026 reached their first courier under ten minutes before pickup. Any rule that measures
   notice-before-pickup from the other end (the late-delivery grace,
   `services/delivery/late-delivery.js`) is measuring the same quantity as
   `assignmentWindowMinutes` and moves as a step function of it: the lever for that
   population is the config value, not the report.
3. **Never write `customers.isActive` directly** — always `setDriverActiveStatus`
   (`services/delivery/driver-status-service.js`), which writes `driverStatusHistory` in
   lock-step and pushes a websocket update. Direct writes create phantom history.
4. **`isActive` ≠ `isAvailable` ≠ `isOnline`** — three separate flags, don't conflate.
5. **Twins always go pending** and (single mode) must share ONE driver: the
   `twinPickupSequence:1` side drives selection, the peer mirrors it, and `assignDriverAt` is
   aligned to the later side. Breaking any of it splits a twin.
6. **Manual-admin routing:** companies with `isControlledByAdmin && manualAssignmentOnly` route
   to a company **admin**, not a driver. Don't auto-assign them.
   **`centralizedFlowMonitor.trackOrderFlowEvent` RETHROWS — always wrap it.** It logs and then
   `throw error` (`services/monitoring/centralized-flow-monitor.js:63-66`), so an `await`ed call
   with no local try/catch turns a monitoring failure into a 5xx on the dispatch route *after*
   the `bookDelivery` write has committed — and skips everything after it, which on the reassign
   routes is both driver notifications. The old driver is never told they lost the order, the new
   one is never told they have it, and the database says they own it. It reads like fire-and-forget
   telemetry and is not. Wrap every call in its own try/catch and place it **after** the
   notifications, not before (`routes/delivery/admin.js` reassign is the worked example). This is
   the delivery-side instance of the shared "a secondary feature must never fail the primary
   flow" rule, and the one place the code does not enforce it for you.
7. **Collection name ≠ property name:** `db.bookDelivery` is bound to the MongoDB collection
   **`book-delivery`** (hyphenated) — `services/database/DatabaseInitializationService.js:28`.
   Querying `delivery-company.bookDelivery` directly returns **zero documents silently**
   (Mongo just reports an empty collection), so a read-only investigation looks like "no twin
   deliveries exist". Check the binding in that file before querying production by hand.
8. **A shift `date` is a business-day LABEL, not a wall-clock date.** The day runs
   `driverShiftConfig.timeSlotTemplate.startHour → endHour` — **09:00 → 02:00** in prod for
   every live area. Generation rolls `endHour += 24` and stores *every* slot of that day,
   including the `00:00`/`01:00` tail, under the **starting** date
   (`services/driver-shift/shift-service.js`). So `{date:"2026-08-06", startTime:"00:00"}`
   means **midnight on 7 Aug**, and each date holds exactly `[00:00, 01:00, 09:00 … 23:00]`.
   Never key "now" with `moment().format('YYYY-MM-DD')` and never compare bare `HH:mm` —
   after midnight both silently read the *following* night's slots. Corollary:
   `endTime <= startTime` is legal (`"23:00"→"00:00"`; `"24:00"` also exists in older data),
   so any `end > start` assertion or lexicographic `HH:mm` compare is a bug.
9. **Permanent drivers are per-weekday.** `dayTimeSlots[].dayOfWeek` is authoritative; the flat
   `timeSlots` array is the **union across all weekdays** and is meaningless without
   `daysOfWeek` beside it. Always resolve through
   `ShiftService.getPermanentDriverSlotsForDay(permDriver, dayOfWeek)` — iterating `timeSlots`
   alone books a driver into every slot they hold on *any* day. An overnight tail belongs to
   the weekday whose **night** it is (invariant 8), so "Mon 18:00→02:00" is entirely
   `dayOfWeek: 1`.
10. **`bookDelivery.pickupTime` is a wall-clock `"HH:mm"` string that wraps past midnight —
    it is not a timestamp.** Both create paths write
    `moment(...).utcOffset(offset).format("HH:mm")` (`services/delivery/book-delivery.js:104-113`,
    `services/delivery/delayed-assignment.js:429-435`), and `format("HH:mm")` carries no date,
    so a 23:50 booking with 25 ready-minutes stores `"00:15"` meaning **tomorrow**. In
    production 82,414/82,414 rows are strings — never numeric, despite the numeric
    `deliveryData.pickupTime` minutes the create paths receive and then overwrite — and **1,774
    have a pickup clock earlier than their own `created` clock**. To get an instant, snap the
    clock onto `created`’s date and **roll forward a day if it lands before `created`**, and sum
    `hours*60 + minutes` rather than `set({hour})`, because `routes/order.js:6694` adds
    `delayMinutes` with no mod-24 and has written `"24:00"`/`"24:06"` (3 rows). Two
    consequences are already in the data:
    - `originalPickupTime` (`"HH:mm"`, 823 rows, written only by
      `POST /api/order/update-delay`, `routes/order.js:6690-6715`) moves `pickupTime` **without
      recomputing `expectedDeliveryAt`**, so on those rows the stored promise still belongs to
      the *original* clock. Any check comparing `expectedDeliveryAt` against a pickup clock must
      use `originalPickupTime || pickupTime`.
    - The immediate path re-parses the already-wrapped `"HH:mm"` back onto the booking’s own
      date (`services/delivery/book-delivery.js:191-198`), which for a 23:50 booking lands
      `expectedDeliveryAt` ~24 hours in the **past** — 284 production rows, 2025-07 to 2025-10,
      none in 2026 (late-night orders now take the delayed path). Treat
      `expectedDeliveryAt < created` as unmeasurable; it is impossible by construction.
    The shared reader that gets all of this right is `services/delivery/late-delivery.js`
    (`pickupInstantOf`, `parsePromisedEta`) — use it rather than re-deriving.
11. **`bookDelivery.storeReadyAt` does not exist — nothing writes it, ever.** 0 of 82,414
    production documents carry the field and no code in any Shoofi repo assigns it. It is not
    legacy; it was never written. Three report consumers nonetheless read it off a delivery and
    subtracted store-side delay from the courier’s lateness, so every published “delayed above
    5 min, **net** of kitchen delay” number was gross and always had been — the subtraction
    never once fired. The store-ready instant does exist, in `shoofi.orderFlowEvents` as
    `{ eventType: "status_change", status: "3" }` keyed by
    `orderNumber === bookDelivery.bookId` (`routes/analytics.js:1136-1154` does this
    correctly). Removed from `utils/crons/growth-snapshots.js` and `lib/churn-360/signals.js`
    in shoofi-server `fix/late-delivery-shared-rule`. **Generalise the lesson: before adding a
    `bookDelivery.<field>` read, confirm something writes it.** `driver`, `company`, `area` and
    `order` are whole embedded documents, so a wished-for or misspelled field reads as
    `undefined` rather than throwing, and a guarded `if (d.field)` branch then quietly never
    runs — which looks identical to a correction that is simply rare.

10. **`isPendingAssignment` is a queue-membership CLAIM TOKEN, not a status — and every exit
    from the queue must burn it, not only cancel.** `processPendingAssignments`
    (`services/delivery/delayed-assignment.js`) dispatches on
    `{isPendingAssignment: true, assignDriverAt: {$lte: now}}` every 60s, so a booking that
    keeps the token is re-dispatched forever. Cancels are the obvious case (the cancel
    un-cancels itself minutes later), but until 2026-09 the *forward* transitions —
    approve, collect, deliver, waiting-in-store — wrote a status and a timestamp and left the
    token set. Two bookings marked DELIVERED by support through
    `POST /api/delivery/order/status/update`, neither of which ever had a driver, reached
    85,296 dispatch attempts each: 97.6% of every row in
    `delivery-company.assignment-decisions`, which makes that collection unreadable as a
    measure of dispatch pressure until you filter them out. The token is minted in exactly
    one place (`createPendingDelivery`, always alongside status `"1"`), so
    **`WAITING_FOR_APPROVE` is the only status a genuinely-queued booking can hold** — the
    status filter in the scan excludes all seven others. That filter is a second line of
    defence, not the fix; and keep it a `$nin`, never an `$in` of `"1"`, because `$nin` also
    matches documents with no `status` field and a malformed pending row must stay
    dispatchable rather than silently vanish. Two places read the token where the status
    filter cannot help, because they are different queries: the twin sequence-2 defer gate
    reads the *peer's* flag (a stranded peer defers a live booking forever, logged only as
    `DEFERRED`, which raises no alert), and `GET /api/admin/delivery-config/pending` lists the
    admin "ready for assignment" screen. Both must test queue membership — use
    `isAwaitingAssignment()` / `PENDING_ASSIGNMENT_EXCLUDED_STATUSES`, exported from
    `delayed-assignment.js`. Do **not** add anything to the atomic claim filter itself
    (invariant 2) while doing so.
11. **Never assume a delivery has an order.** `deliveryOrder.order` is absent on every
    delivery-only booking, so anything keyed on `order.customerId`, `order.total` or
    `order.orderId` silently no-ops there. That is exactly how admin cancellation used to
    notify nobody while the driver was still driving to the store.
12. **A new `scoringWeights` key must be defaulted in TWO places or it ships dead.** The live
    `delivery-company.delivery-config {type:'driver-assignment'}` document holds exactly three
    weights — `{distanceToStore: 3, distanceToCustomer: 1, routeDeviation: 0.5}` — while
    `DEFAULT_CONFIG.scoringWeights` in `services/delivery/delayed-assignment.js` carries every
    term the scorer actually charges. `getAssignmentConfig` merges the two **per key**; it used
    to read `config.scoringWeights || DEFAULT_CONFIG.scoringWeights`, a wholesale swap, so any
    weight present in code and absent from the document arrived `undefined` and multiplied out
    to `NaN` — in production only, while every spec passed. And the merge is not sufficient on
    its own: `config` also reaches `calculateDriverScore` from the simulator and from the specs,
    which hold their own copies of that table and never pass through `getAssignmentConfig`.
    Default at the read site too. A `NaN` total is silent rather than loud — it makes every
    comparison in `byConcurrencyTierThenScore` (`services/delivery/driver-load.js`) false and
    leaves the candidate order down to whatever `Array.prototype.sort` happened to do, which
    for two twin peers scored microseconds apart is a coin flip no decision log can reproduce.
13. **`assignmentMetadata.estimatedArrivalAtStore` is scored, not a diagnostic — so
    `assumedDriverSpeedKmh` is a dispatch lever.** The scored path's total is
    `distance + orderPenalty + customer + routeDeviation + sameStoreBonus + uncollectedPenalty
    + overduePenalty + pickupHeadroomPenalty` (`services/delivery/delayed-assignment.js`), and
    the last term is `min(max(0, 10 − headroomMinutes) × w, 20)` where headroom is the pickup
    clock minus the predicted arrival. It was added Sep 2026; for a year the estimate was
    written beside the assignment and read by nothing, and 490 of 3,718 scored allocations
    (13%) went to a courier the engine itself predicted would reach the store after the food
    was ready — 97% of them couriers mid-run, priced at their next drop point by the
    future-location shortcut. Two consequences: lowering `assumedDriverSpeedKmh` in that config
    document now moves couriers down the ranking rather than only flattering a report, and the
    headroom term is **capped in points, never a filter** — a delivery the engine fails to
    assign is never inserted at all, so there is no pending record to retry from. The term
    needs a pickup *instant*, so it is computed via `late-delivery.currentPickupInstantOf`
    (invariant 10) and `bookDelivery.created` is threaded into the scorer for it; with no
    resolvable clock or no estimate it contributes 0 and reports
    `pickupHeadroomMinutes: null` — which is "no opinion", not "plenty of time". Both
    twin-mirroring spreads null it on purpose, because the peer's estimate was measured against
    the peer's store. Every component has a `scoreBreakdown` key, always present even at 0;
    `scripts/analyze-assignments.js` sums them key by key, so a component missing from its
    `totals` object is dropped from `avgTotal` too and the percentages stay plausible while
    describing a score they no longer break down.

## Known status (human-confirmed — do NOT "fix")
- **NOT ROLLED OUT (as of 2026-09-18):** prod `shoofi.store {id:1}` has **no**
  `isDeliveryOnlySupport` field, so the gate returns `platform_disabled`/`store_disabled` for
  every store and the partner button is hidden platform-wide. The feature is built and merged;
  it is waiting on the admin Settings toggle, not on code.
- **BY DESIGN:** `isSendNotificationToDeliveryCompany` on the **central** `shoofi.store {id:1}`
  is the **GLOBAL master switch** for the delivery-company/driver integration — when off,
  **no `bookDelivery` is created platform-wide**. The **per-store**
  `storeData.isSendNotificationToDeliveryCompany` reads in `routes/order.js` are **LEGACY —
  ignore them**; the central flag wins.
- **BY DESIGN — keep it off:** the scored-assignment **recency filter is intentionally
  disabled** in `services/delivery/delayed-assignment.js` (stale-location drivers stay eligible
  so assignment isn't starved). Do not re-enable without an explicit task.
- **How old a courier's position is: `lastFixAt`, and mind the rollout gap.** Two timestamps sit
  side by side in the same `$set` in `POST /api/delivery/driver/location`
  (`routes/delivery/driver.js`) and they mean different things. **`lastFixAt`** is a BSON **Date**
  and is the **device** fix time, so it is the real recency — the driver app replays failed posts
  from AsyncStorage, so one request can carry a fix that is hours old. **`lastLocationUpdate`** is
  an **offset string** and is the server **receive** time, kept that way deliberately so existing
  consumers keep working; a phone re-POSTing a cached fix therefore looks fresh by that measure
  forever. Prefer `lastFixAt`.
  But do **not** read it alone: it shipped 2026-09-12, and of the 224 couriers holding a
  `currentLocation` on 2026-09-29 only **83** had it — **141 had none**, the oldest of those
  carrying a `lastLocationUpdate` 319 days old. Any staleness rule that keys on `lastFixAt`
  exclusively silently ignores the couriers most likely to be stale. Fall back to
  `lastLocationUpdate` when `lastFixAt` is absent: for a courier who has not posted in weeks both
  are equally old, and the receive-time weakness only appears on a phone that IS posting — which
  has `lastFixAt`. `parseDeviceFixTime` also falls back to receive time for an absent, unparseable
  or implausible client timestamp, so `lastFixAt` is not a guarantee of device provenance either.
  ⚠️ **Compare both as instants, never as strings.** `lastLocationUpdate` carries its offset, so
  a lexicographic `$gte` (which is what the disabled filter above used) mis-windows across
  Israeli DST. Only `lastLocationUpdate` is indexed (`utils/init-location-indexes.js`);
  `lastFixAt` is not, so filter in JS after the fetch rather than in the query.
- **A delivery company has NO location.** `delivery-company.store` carries no `location` and no
  `coverageRadius` — verified 2026-09-29 across all 173 documents. So "assume the courier is at
  his depot" is not an available fallback, however natural it sounds: `company` IS attached to
  every scored candidate (`delayed-assignment.js`, where `{...driver, company}` is built), which
  makes `driver.company.location` look free and correct right up to the point it throws. In
  `calculateDriverScore` that throw is caught and returns `score: 9999` / `distanceToStore: 0`,
  so the failure is a silently mis-ranked fleet, not an error anyone sees. Use the **pickup
  zone's** interior point instead (`cities.geometry` → `pointInsideGeometry`, never
  `computePolygonCentroid`). Consequence worth knowing: `findBestDeliveryCompany` guards on both
  missing fields and therefore returns `null` for every input in production (reference §4).
- **FIXED:** the partner app's `DELIVERY_STATUS` was off by one (showed "delivered" at pickup);
  it now matches the server. Server `consts/consts.js` is the single source of truth.
- **Awareness:** a legacy `updateDelivery` path uses different status literals; `driver-inactivate-cron`
  is currently disabled (commented out in `app.js`).
- **FIXED (Aug 2026):** invariant 8 was violated in six places — the
  `update-active-status` guard, both `driver-shift-cron` passes,
  `isShiftInProgress`, `checkBookingConflict`, `shiftWindows`, and the false
  `$or` in `driver-daily-hours` + `driver-reports`. All now go through
  **`utils/shift-time.js`**, the single business-day helper. Use it; never
  re-derive a slot window locally.
- **BY DESIGN — fail-closed is deliberately scoped.** The guard refuses (and the
  cron deactivates) when no slot covers "now", but ONLY when the day has slots
  AND `isWithinBusinessDay`. Two escapes, both load-bearing: outside 09:00–02:00
  the template produces no slots by design, so blocking there would be a lockout
  with no booking path out of it; and a day with NO slots means the area does not
  run on the shift system, where an hourly sweep would switch off drivers who
  never had a shift to miss. The guard and the cron share the predicate so they
  cannot disagree.
- **STILL BROKEN (client side):** `ShiftsCalendar.tsx` day/list view and both
  Excel exports sort `startTime` lexicographically, floating the tail to the top;
  and both `getBusinessDayStartHour` copies INFER the start hour from the loaded
  week instead of reading `timeSlotTemplate.startHour`, so a sparse day reorders
  the board. The grid view and the driver app's `shifts.tsx` are correct.
- **BY DESIGN so far — money is NOT affected by the above.** The min-hourly guarantee is
  computed from `inWorkingHoursMinutes` (`workingHoursWindow` = `[D 09:00, D+1 02:00]`, the one
  correct business-day implementation in the codebase). `inShiftMinutes` is display-only —
  payload, PDF column, tooltip — so the shift bugs need **no settlement backfill**. Separately,
  `DriverPayments.tsx` computes its *own* per-calendar-day guarantee from a midnight-split
  `activeMinutes`; that one can move a payout and is tracked separately.
- **DEAD CONFIG:** `ShiftService.isBookingWindowOpen` is hard `return true`, so
  `bookingWindow.opensDayOfWeek` / `opensForWeekOffset` do nothing, and
  `bookingClosesHoursBefore` is stored and admin-editable but read by **no server code**.
  Real gating today is `cityAreas.bookingDisabledWeeks`. There is also no waiting-list
  promotion anywhere — `waitingList` is only pushed, pulled and displayed.

## Recipe — change assignment or coverage
1. State which of **pickup-zone / dropoff-geometry / `supportedCities` / `supportedAreas` /
   `personalSupportedAreas`** your change affects — that sentence catches most bugs by itself.
2. Confirm string-vs-ObjectId normalization on every `cityId` comparison.
3. Preserve idempotency (invariant 2) and twin coordination (invariant 5).
4. Verify status values against `consts/consts.js`, **never** a client copy.

## Definition of done
Inherit `_shared-guardrails.md` §7, plus the four recipe points above. If a client's status
copy diverges from the server, that's a **multi-repo PR**, not a local patch.
