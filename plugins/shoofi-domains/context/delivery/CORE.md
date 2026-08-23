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
10. **The SCORED path is the live one — `assignBestDeliveryDriver` is effectively dead.**
    `DEFAULT_CONFIG.useDelayedAssignment` is `false` in code
    (`services/delivery/delayed-assignment.js:19`), but production overrides it: the
    `delivery-company.delivery-config {type:'driver-assignment'}` doc carries
    `useDelayedAssignment: true` (set 2026-01-17). `book-delivery.js:62-63` reads
    `config.useDelayedAssignment || isTwin`, so **every** order pends and is assigned by
    `assignDriverByScore` — not just twins. Across 120 days of `book-delivery`,
    `assignmentMetadata.assignmentMethod` was `score-based` on 12,963 assignments against
    **37** carrying no metadata at all, and the immediate path is the only one that writes
    none. Tuning `findAllMatchingDrivers`' load-sort therefore changes almost nothing; the
    behaviour anyone reports comes from `findScoredDrivers`. Read the config doc before
    trusting the code default.

11. **Driver load, capacity and the order penalty have ONE definition:
    `services/delivery/driver-load.js`.** Both engines and
    `availability-status-service.js` import it; never re-derive any of the three inline.
    - **In-flight is `["1","2","3","5"]`.** `"5"` (WAITING_IN_STORE, `consts/consts.js`) is
      carried work — the driver is standing in the restaurant *waiting for the food* and moves
      forward to `"3"` once he has it (`routes/delivery/orders.js`). Both engines used to
      count only `["1","2","3"]`, so a driver waiting in two stores scored as fully idle while
      every other screen showed him busy.
    - **In-flight ≠ collected. Only `"3"` means the courier has the food.**
      `UNCOLLECTED_ORDER_STATUSES = ["1","2","5"]`: `"1"` he has not accepted, `"2"` he is
      driving to the store, `"5"` he is standing in it empty-handed. A courier on `"1"/"2"/"5"`
      is **stalled, not busy** — give him a second pickup and both orders run late, which is
      why `getUncollectedPenalty` charges for each one. The distinction has exactly one
      writer: `POST /api/delivery/driver/order/start` sets `status:"3"` **and** stamps
      `startedAt` (`routes/delivery/orders.js`). Two consequences worth knowing before you
      rely on either field: the admin-web `POST /api/delivery/update` path can move a row to
      `"3"` **without** writing `startedAt`, so `startedAt` is not guaranteed present on a
      collected row; and `/start` has no status guard on its filter, so a repeat call
      overwrites `startedAt` and can drag a `"4"` DELIVERED row back to `"3"`. Prefer
      `status === "3"` as the collected test and treat `startedAt` as best-effort.
    - **A courier holding `maxConcurrentOrders` (default 2) is skipped while anyone below the
      cap exists**, however close he is — `isWithinConcurrencyCap`, sorted on ahead of the
      score. It is a sort TIER, never a filter: the immediate engine never inserts a
      `bookDelivery` row for a delivery it fails to assign (`services/delivery/book-delivery.js`)
      and has no retry, so anything that can empty the candidate list strands the order
      permanently. Over-cap couriers stay in the list, last.
    - **`maxOrdersByAdmin` is NOT a literal cap.** Every admin write path stores `null` when
      the cap field is left blank (`routes/delivery/driver.js`, `routes/delivery/company.js`),
      and one of them stored `0`; 116 of 238 driver records in production carry `null` or `0`.
      Compared directly, `0 < null` and `0 < 0` are false, so the filter dropped **idle**
      drivers out of the candidate set and the order went to a loaded one. Always read it
      through `getDriverCapacity` — blank means no cap.
    - **The effective ceiling is the LOWER of the two limits, and a per-driver limit set
      ABOVE the platform cap buys nothing extra.** `isWithinConcurrencyCap` requires
      `held < maxConcurrentOrders` **and** `held < getDriverCapacity(driver)`. 28 of the 238
      driver records are set above 2 (nineteen 3s, eight 4s, one 5) and they are
      disproportionately the couriers who actually work, so this is the branch most
      production drivers hit. A limit above the cap changes exactly one thing: it decides
      who can absorb the **overflow**. `driverHasCapacity` (the hard filter, per-driver limit
      only) keeps such a courier in the candidate list, so when nobody is below the cap the
      3rd order can land on him; a courier at his own limit is dropped even then. Raising a
      driver's admin limit is therefore not a way to give him more concurrent work — only
      `delivery-config.maxConcurrentOrders` does that.
    - **Inside the over-cap group, order by total load — not by score, not by pickup
      progress.** Both comparators (`byConcurrencyTierThenScore`, `assignDriver.byDriverLoad`)
      switch keys once every candidate is past the cap. On score alone a courier holding 4 on
      the store's doorstep (~16.5) beats one holding 2 four kilometres out (~17.0), because
      the order penalty tops out near the distance weight — so the closest courier collected
      every overflow order and drifted to six. Pickup progress is the right question for a
      legitimate 2nd order; for an illegitimate 3rd the only fair question is who is carrying
      the least.
    - **The `orderPenalties` table stops at 4.** `getOrderPenalty` extrapolates past the top
      rung at the table's own last marginal step. A `Math.min(count, 4)` clamp makes the 5th
      order onward free, and at weight `distanceToStore: 3.0` a free order is worth 5 km of
      distance — that is how a driver holding 11 deliveries kept winning.
    - **`processPendingAssignments` is SEQUENTIAL on purpose.** A successful assignment writes
      `status: "1"`, which is exactly what the next delivery in the tick reads as driver load.
      `Promise.allSettled` over the tick meant every delivery scored against the same
      pre-batch state and one driver near the store took the whole burst. Do not re-parallelise
      it.

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
