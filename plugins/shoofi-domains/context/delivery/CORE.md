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
10. **`assignedAt` is NOT rewritten by the reassign path you reach for first.**
    `POST /api/delivery/admin/reassign` writes it only inside the `isPendingAssignment`
    branch (`routes/delivery/admin.js:200-218`); the `else` — "Regular reassignment", the
    path **3,680 of 3,735** completed Jun-Aug reassignments took — writes `reassignedAt` and
    `reassignmentMetadata` and leaves `assignedAt` alone. So on almost every reassigned
    delivery `assignedAt` still holds the **first** courier's dispatch, not the current
    one's. The two paths that *do* overwrite it are the bulk admin dispatch
    (`routes/delivery/driver.js:375`) and twin manual assign (`routes/twin-order.js:1624`).
    Anything asking "when did *this* courier get the job" must read `reassignedAt` first and
    fall back to `assignedAt`, never the other way round — grepping for `assignedAt` writers
    finds `driver.js:375` and suggests the opposite conclusion.
    Two shape facts that travel with it: `assignedAt` is **mixed BSON** — a moment offset
    string on 20,640 completed Jun-Aug rows and a real `Date` on 990 (twin path) — so read it
    through `momentTZ.tz(...)` in JS and **never range-query it**, which silently matches
    nothing; and it is absent from most of the 82k-row collection but present on
    **21,630/21,643 (99.9%)** of *completed* rows, so sizing it over the whole collection
    reads as "three quarters of deliveries have no dispatch instant" and is wrong for every
    reporting window. `assignDriverAt` is scheduled intent, not a dispatch — `assignedAt`
    precedes it on 59.7% of rows.
11. **There is no reassignment history.** Every reassign is a `$set` overwrite on the one
    `book-delivery` document — no array, no log collection — so only the most recent previous
    courier survives, and on a job passed A → B → C you can charge B and cannot see A. The
    previous courier is written under **three** different keys by three writers:
    `reassignmentMetadata.previousDriver` (`routes/delivery/admin.js:212`),
    `reassignmentMetadata.previousDriverId` (`routes/delivery/driver.js:375`), and
    `assignmentMetadata.previousDriver` (`routes/twin-order.js:1624`, which writes **no**
    `reassignedAt` at all — the timestamp falls back to
    `assignmentMetadata.manuallyAssignedAt`, a BSON `Date`). All three hold an **ObjectId**,
    sitting next to a **string** `reassignedBy`. Read all three or twin reassignments become
    invisible; `services/delivery/late-delivery.js` normalises them (`PREVIOUS_DRIVER_KEYS`,
    `reassignmentOf`, `previousDriverIdOf`) and is the one place to reuse. Two guards that
    matter: a `reassignedAt` earlier than the row's own `created` is an artefact of the `$set`
    overwrite on re-booked documents (**4,292 rows**) and is no usable signal; and **757 of
    9,991** reassignments hand the job back to the *same* driver — a company admin who also
    drives — so "went to a different courier" is a condition to test, not an assumption.
    A previous courier's **name** exists nowhere on the delivery, only their ObjectId:
    resolve it from `delivery-company.customers` by `_id` and ship a fallback label, because
    a handful are deleted drivers. Never use the embedded `driver.fullName` snapshot for it —
    it names whoever finished the job, and it drifts (one courier in Jun-Aug is stored as both
    "עומר" and "עיסה עומר").

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
