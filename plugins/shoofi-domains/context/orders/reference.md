# Orders — Domain Context

> **Who you are:** the agent that owns the **orders** domain of `shoofi-server` —
> the money/identity spine of the platform. You inherit `_shared-guardrails.md`;
> this doc adds orders-specific truth. You do full tasks autonomously and ship a
> PR (never merge). Order creation, status transitions, and payment-touching code
> are **high-risk**: you may change them, but open a **draft PR flagged HIGH-RISK**
> with a minimal diff, extra tests, and a clear explanation of what could go wrong
> (guardrails §2). When genuinely unsure, do less and put the open question in the PR.

## 0. Scope — what you own, and the hard line through it

**You own** the order lifecycle: creation, status transitions, twin orders,
order reads/admin/monitoring, the customer order history, order-related crons,
and the *secondary* hooks that hang off an order (coins, world-cup, attribution,
coupon usage) — but only their order-side wiring.

Primary files: `routes/order.js` (~7k lines), `routes/twin-order.js`,
`routes/order-fraud-checks.js`, `routes/order-fraud-detector.js`,
`routes/order-origin-validator.js`, `routes/admin/order-monitoring.js`,
`routes/admin/twin-order-config.js`, `services/twin-order/*`,
`utils/order-stock.js` (stock semantics), `utils/crons/*order*`,
`services/monitoring/centralized-flow-monitor.js`, `routes/order-history.js` +
`services/orders/order-history.js` (the partner's one-day history, CORE invariant 21),
`routes/kopa/orders.js` + `services/kopa/orders.js` (Kopa's order reads, CORE invariant 29, C5),
`routes/kopa/{reasons,tables,till-orders,kds,settings}.js` + `services/kopa/` same names (the
Kopa till: in-store sales in `kopaTillOrders`, never `orders`; CORE invariant 30, C5).
Status constants: `consts/consts.js`.

**⚠️ HIGH-RISK code (change via draft PR flagged HIGH-RISK; never merge):**
- `POST /api/order/create` — the creation pipeline (`order.js`)
- Any **status-transition** code: `/api/order/update` (`4174`), `/update/viewd`
  (`4706`), `/start-preparing` (`5854`), `/updateCCPayment` (`1817`), Apple Pay /
  ZCredit finalize & callbacks (`2509`, `2583`, `finalizeApplePayOrder` `2234`),
  twin `place`/`pay`/`digital-*`/`cancel`/`degrade` (`twin-order.js`)
- Anything the shared guardrails mark payments/invoicing (🔒 never modify — those
  stay off-limits; if the root cause is there, describe it in the PR and hand off).

For high-risk code you own: minimal diff, extra tests, a rollback note, and an
explicit "what could break" section in the PR body. Open it as a **draft**.

## 1. Multi-tenant scoping (get this wrong and you corrupt live orders)
- **Orders live in the STORE DB**, selected per request:
  `db = await getOrInitializeDb(req.headers['app-name'], req.app.db)`.
- **Customers are ALWAYS central `shoofi`** — `getCustomerAppName()` ignores
  appName and returns `req.app.db['shoofi']` (`utils/app-name-helper.js`).
  So `customers` + `customers.orders[]` are central, orders are per-store.
- Central `shoofi` also holds: `orderFlowEvents`, `twinOrderGroups` (the `db.twinOrderGroups`
  handle maps to it since 2026-11-06; before, to an empty `twin-order-groups`), `couponUsages`,
  `fraudChecks`, `deviceCustomers`, `ipCustomers`, `applePaySessions`,
  `hypPaySessions`, `pendingFeedbackNotifications`, `stores`, `store{id:1}` (platform creds).
- `delivery-company` holds `bookDelivery` + twin config (`readConfig`).
- ⚠️ `verifiedAppName()` (`order.js`) is currently a **pass-through** — its
  cross-check is commented out. Treat store selection as trust-on-header today
  (see §10).

## 2. Status lifecycle — the state machine (know it cold)
Status is a **string** on the store `orders.status`. Values (`consts/consts.js`):

`0` unpaid-CC (implicit) · `1` IN_PROGRESS · `2` COMPLETED · `3` WAITING_FOR_DRIVER
· `4` CANCELLED · `5` REJECTED · `6` PENDING · `7` CANCELLED_BY_ADMIN · `8`
CANCELLED_BY_CUSTOMER · `9` CANCELLED_BY_DRIVER · `10` PICKED_UP · `11`
PICKED_UP_BY_DRIVER · `12` DELIVERED · `13` FRAUD_REVIEW · `14` FUTURE_ORDER_PENDING
· `15` RAMADAN_IFTAR_PENDING.

Buckets (`docs/customer-orders-snapshot.md`): **completed** `2,3,10,11,12` ·
**cancelled** `4,5,7,8,9` · **in-flight** `1,6,13,14`.

**Transitions & who triggers them:**
- **Create** → `0` (CC) / `6` (cash/digital) / `1` (school) / `13` (fraud) / `14`,`15` (future/ramadan). Trigger: customer app.
- **Payment success** → `6` (or `1` school). Trigger: CC branch, Apple Pay finalize (atomic `findOneAndUpdate {status:"0"}`), HYP.
- **Store accept** (`/update/viewd`) → `6`→`1` (or `14`/`15`); sets `isViewd`,`viewdAt`; **books delivery in background**. Trigger: partner app.
  `orderDate` is rewritten to the ready time **only in the default branch** (`currentTime + readyMinutes`, and `currentTime` is the *tablet's* clock, not the server's). A `14` keeps the customer's requested `orderDate` and gets `startPreparingAt = orderDate - readyMinutes` + `isPrinted:true`; a `15` re-sets `orderDate` to itself. See §5 "order dates".
- **Future → in-progress** (`/start-preparing`) → `14`→`1`.
- **Cancel/reject** → `4,5,7,8,9`; cascades stock restore + delivery cancel + refunds (§3, §6).
- **Cron** `fix-stuck-orders` bumps stale `1` → `3` (delivery) or `2` (takeaway).
- **The delivery leg never writes `orders.status`.** Driver `approve`/`waiting-in-store`/
  `start`/`complete`/`cancel` (`routes/delivery/orders.js`) update only
  `delivery-company.bookDelivery` (+ flow events / pushes); `complete` reads the store order
  only to schedule the feedback push. So "delivered" = `bookDelivery.status "4"` +
  `bookDelivery.completedAt` — the order stays at `3`/`2`. `10`/`11` come from the
  partner's `order/update`; no live client sends `9`/`12` (label-only), though
  `/api/order/update` still handles a `9` if one arrives.
- **Twin cascade** mutates the peer side **directly via services**, not routes (avoids recursion).

**Transition guards you must not weaken:** PENDING(`6`) only from FRAUD_REVIEW
(`order.js`); `/update/viewd` rejects already-cancelled (`4732`);
`start-preparing` only from `14`. Fields: `status`, `statusUpdatedAt`,
`statusUpdateReason`, `completedAt`, `viewdAt`, `isViewd`, `isPrinted`, `orderDate`.
**`readyMinutes` is NOT an order field** — accept takes it as a request param and does not
persist it (~0% of prod orders carry it; only `/update-start-preparing` writes it, on future
orders). Recover it from the `order_viewed` flow event's `metadata.readyMinutes`, or as
`orderDate − viewdAt` (default branch only; `orderDate` is on the tablet's clock, `viewdAt`
the server's). Anything reading `order.readyMinutes` (e.g. `computeOrderDelays` in
`admin/order-monitoring.js`) gets `null`.

## 3. Order creation pipeline (understand; do not edit without sign-off)
`POST /api/order/create` (`order.js`) — ordered side effects:
**saved-address guard** (only when `shoofi.store{id:1}.requireSavedDeliveryAddress === true`,
default off: a DELIVERY order to an address that is not one of the customer's saved ones →
400 `DELIVERY_ADDRESS_REQUIRED`; APPLEPAY / HYP exempt — customers CORE invariant 19) →
lock (Redis `SET NX` + in-mem fallback + 30s dup check) → fraud checks → generate
`originalOrderId`/`orderId` → image upload → decide initial status → validate coins
(no debit) → price corrections, in this order: coupon entitlement (`enforceCouponEntitlement`:
ownership + partial-use balance only) → store promotions + the delivery deal-vs-coupon
conflict (`enforcePromotions`, `resolveDeliveryConflict`) → **fixed-delivery-price coupon
recompute** (`enforceDeliveryPriceCoupon`, CORE invariant 14). Each one corrects `total`
and never rejects → build `orderDoc` → **insert into store `orders`** (authoritative) →
`[shippingPriceCheck]` fired and **never awaited** (log-only; a DELIVERY fee below the area
tariff → one warn line + `order.shippingPriceCheck`, CORE invariant 20) →
**stock decrement if status≠"0"** → first-order attribution → Apple Pay session
self-heal → fraud persistence → **push `customers.orders[]` snapshot (central)** (+ seed
`addresses[]` for a customer with none — a real address only, with an `_id`:
`addressToSaveFromOrder`, customers CORE invariant 19) →
remember the confirmed delivery address (`rememberConfirmedAddress`, **fire-and-forget**,
after the snapshot write that would clobber it — customers CORE invariant 19) →
notify store owner (**a repeating alert, not one push**, **fired in the background and
never awaited** — `fireStoreOwnerNotifications`, see §7) → flow event →
(CC/HYP branch: charge → set `6`/`1`/`13`, stock,
coupon usage, coins, invoice) → success flow event → release lock in `finally`.
Delivery is **not** booked here — it's booked at store-accept.

## 4. Twin orders (one customer, two stores, one driver)
Lifecycle lives in `shoofi.twinOrderGroups` (`tg_...`). Group states
(`services/twin-order/twin-group-service.js`): `pending_payment` →
`primary_dispatched` → `secondary_dispatched` → `completed`; plus `cancelled`,
`degraded_to_single`. Key facts:
- **Eligibility** (`filterEligibleStores`, `services/twin-order/twin-eligibility.js`, called
  by `/eligible-stores`): a candidate within `storeRadiusM` of the primary OR
  `customerRadiusM` of the customer, never a coupon or test store; the route first keeps only
  open, not-busy stores that deliver. **VAT status is not a criterion.** An exempt (עוסק פטור)
  store may pair with a regular one, and neither placement route checks it: manual
  invoicing documents each store under its own status (payments CORE invariant 9). The old
  `rejectMixedVatPair` guard was removed on 2026-11-02. Do not bring it back without that
  invariant changing.
- **Place** (`twin-order.js`) validates BOTH sides' coins before inserting
  either; inserts a skeleton order into each store with
  `twinGroup:{groupId, role, peerAppName, peerOrderId, ...}`; pushes both snapshots.
- **Pay** (`781`) = **one combined ZCredit capture** for both totals + fee → both
  sides `6`. No partial-refund coordination (single capture).
- **Fee**: customer always pays the full base delivery fee; coupons never reduce
  the combination fee (`twin-fee-service.js`).
- **Coupons**: each side's `appliedCoupon` is the client's split (`shoofi-app
  utils/coupon-split.ts`). A delivery coupon goes 100% to the primary, the only side with
  `shippingPrice`, and the sides are stored as posted. The one server re-price is the
  fixed-delivery-price coupon: `enforceTwinSideDeliveryPrice` runs after
  `enforceTwinSidePromotions` in `/place` and `/digital-place-pending`. It gives one ₪X on the
  primary's tariff-capped fee, and a claim on the secondary (fee 0) is removed (CORE invariant 14).
  Not handled: `degradeToSingle` with `keepSide:'secondary'` moves the FULL primary fee onto the
  kept order (`$inc total`) while the primary's coupon usage stays. This was already true for
  every delivery coupon before this change.
- **Customer notes**: `commentToCourier` is ONE note for the shared courier and is written on
  both legs. `commentToStore` is ONE NOTE PER STORE: `primary.commentToStore` goes on the primary
  leg and `secondary.commentToStore` on the secondary. `buildSkeletonOrder` cleans each value,
  and a leg never carries the peer's note (CORE invariant 25).
- **Dispatch**: longer-prep side dispatched first (`pickupSequence` 1); the second side
  (`pickupSequence` 2) is held back from its store's new-orders lists while the first-dispatch
  order is LIVE and NOT YET ACCEPTED — one rule, `resolveTwinSecondaryVisibility`
  (`utils/twin-order-visibility.js`), used by `GET order/admin/not-viewd`,
  `GET order/admin/all/not-viewd` and `GET order/admin/my-stores/new-orders-count` (they
  disagreed until 2026-11-10; a first store cancelled before accepting hid the second order
  forever in the multi-store view and badge). Visible when this order is `twinGroup.degraded`
  or already opened (`viewdAt`), the first-dispatch order is missing or cancelled/rejected
  (4/5/7/8/9, string or number), the group is `degraded_to_single`/`cancelled`, or the first
  order was accepted (`viewdAt`, any status after). Fail open. `twinPeerInfo` (the readyMinutes
  cap) only for a live, accepted peer. The peer is looked up by `peerOrderId` pinned to
  `twinGroup.groupId` (the short number repeats), falling back to the group id.
  **The second store's persistent alert** (push + reminder cron) fires on the first store's accept
  (`order/update/viewd`) — and, since 2026-11-10, also when the first store is DROPPED
  (`degradeToSingle` → `releaseSecondStore`: kept order is pickupSequence 2, status 6/14, not
  opened, no alert on record) with a `twin_second_store_released` flow event. An undo that puts
  the first store back to "not accepted" re-hides an unopened kept order and records
  `twin_second_store_rehidden`. The admin bundle (`twin-order/admin/group/:id/full`) and the
  monitoring `twin.group` carry `secondStoreWaiting` + `secondStoreWaitingDetail {waitingStore,
  blockingStore}` while the second order is hidden.
- **Cancel/degrade** (CORE invariant 27): `cascadeCancel` cancels both legs, stamps
  `cancelMoneyDecision: "undecided"` on each card leg it cancels and records NO refund amount
  (no group money decision exists yet). `degradeToSingle` keeps one leg and records
  `degrade.refundOwed` = the dropped leg's `total − shippingPrice` (before any shipping
  transfer) + `combinationFee.customerPays`, and **0 unless that leg was card-captured** (cash,
  never-paid, failed → `refundBreakdown.basis: "not_card_captured"`, no auto-refund attempt).
  **The group's `paymentStatus` stays as it was — `both_captured` after a degrade**; the
  refund's state is only `degrade.refund{Attempted,Completed,ReferenceNumber,Error}`. Groups
  degraded before 2026-11-06 read `pending` (overwritten) and carry the old `orderPrice`-based
  `refundOwed`. No automatic ZCredit reversal (`degradeAutoRefund` is not read); a degrade with no
  decision owes `refundOwed` as `undecided` on the group's money ledger (CORE invariant 28), and
  returns the dropped leg's coins / coupon uses / deal uses. `undoDegrade` is refused (route: 409
  `{ message, reason }`, nothing written) by
  `undoDegradeBlockReason`: `money_already_handled` — `degrade.refundAttempted ||
  degrade.refundCompleted`, either order has `cancelCompensation`, or either order has a
  `cancelMoneyDecision` with `cancelMoneyDecisionAt` after `degrade.triggeredAt` (a missing
  timestamp counts as after), or the group's `moneyLedger` moved since the degrade (anything but
  capture/release and the degrade's own undecided decide/owe); else `kept_side_cancelled` — the
  kept order is in 4/5/7/8/9.
  Before 2026-11-06 undo's group write went to `db.twinOrderGroups`, aliased to the empty
  `twin-order-groups`, so it never restored a group. All three write `orderFlowEvents` on both
  legs (`twin_cascade_cancel`, `twin_degrade`, `twin_undo_degrade`) with the admin as actor.
- Never route twin peer transitions through `/api/order/update` — use the services (recursion).

## 5. Data model — the join map (memorize the snapshot trap)
- **Store `<app>.orders`** = authoritative. Join key `_id` (ObjectId). Display
  `orderId` (`"8475-2384"`), `originalOrderId` (`"8475-570235-2384"`).
- **`orders.order.items[]`** = the wire shape the cart sends and the document keeps:
  `{ item_id, qty, price, selectedExtras, nameAR/nameHE, … }` — the extras DEFINITION is not
  on the line; `utils/order-pricing.js` re-reads it from `products`. A **combo line**
  (`docs/combo-deals.md`) is the same shape with `item_id` = the combo product plus
  `comboSelections[{ sectionId, slot, productId, nameAR, nameHE, surcharge, selectedExtras, extrasPrice }]`
  — ONE line however many slots. Only `sectionId` / `productId` / `selectedExtras` are read
  server-side; `surcharge`, `extrasPrice` and the names are ticket snapshots. `comboIssues`
  is never persisted on an item (amend strips it); creation keeps them under
  `serverPricing.comboIssues`. CORE invariants 11–12.
- **`orders.shippingPriceCheck`** = `{ expected, submitted, areaId, paused, checkedAt }`,
  `$set` after the insert ONLY when a DELIVERY order's posted `shippingPrice` is below its
  area's tariff (paused areas included). Absent on every other order, so
  `find({ shippingPriceCheck: { $exists: true } })` lists the flagged ones. Diagnostic only:
  no reader, no index, money unchanged. A `book-delivery.order` snapshot taken before the `$set`
  lands does not carry it. CORE invariant 20.
- **`orders.isFirstOrderAtStore`** (top level, boolean or ABSENT) = "the customer's first
  order at this store", written once at insert by `/api/order/create` and both twin place
  routes (`applyFirstOrderFlag`, `services/orders/first-order-at-store.js`), never rewritten.
  Absent = unknown (failed lookup, or an order from before 2026-11-08), so a reader badges only
  `=== true`. Index `customerId_idx` `{ customerId: 1 }`. Rules: CORE invariant 24.
- **`orders.order.address`** (the INNER `order`, beside `items` / `commentToCourier`; there is no
  top-level `orders.address`) = a snapshot of the **saved address** the customer delivered to. The
  customer app sends the address object whole (`screens/checkout/index.tsx` `addressLocationRef` →
  `getCartData` `address: order.address`, `stores/cart/index.ts`) and `/api/order/create` keeps it
  through `order: { ...parsedBodey.order, … }`. Beside `street` / `streetNumber` / `city` /
  `location` it carries the customer's own label `name` ("בית", "عمل"), the building details
  `floorNumber` / `apartmentNumber` / `entrance`, and **`notes` = the courier landmark** (the
  app's «סימן דרך לשליח», "white house next to the mosque"). All optional free text, often `""`.
  - **`notes` is not `commentToCourier`.** `notes` is saved WITH the address and repeats on every
    order sent there; `commentToCourier` is typed per order at checkout (support can edit it,
    `routes/order-comment-to-courier.js`). Show them as two labelled things.
  - **Only as complete as the saved address.** Before shoofi-server #534 (merged 2026-11-10)
    adding an address (`controllers/customerAddressController.js` `buildAddress`) stored
    `floorNumber` and `notes` but dropped `apartmentNumber` / `entrance`; editing it
    (`updateAddress`) kept them. Since #534 add keeps both when sent, so only addresses added
    earlier and never edited lack them. Customers domain (customers CORE).
  - **Never rewritten for content.** Support's `update-address-to-current-location`
    (`routes/customer.js`) moves `order.address.location` (+ `isCurrentLocation`, `updatedAt`,
    `updatedBySupport`) and `order.geo_positioning`; `notes` and the building details stay.
  - Copied whole into the `bookDelivery.order` snapshot at store accept (the booking's `order` is the
    order document), and into `customers.orders[].address` at create.
- **`orders.order.commentToStore`** (string or ABSENT) = the customer's note to the store, from
  the cart page. Cleaned by `sanitizeCommentToStore` (`utils/comment-to-store.js`): strings only,
  whitespace runs collapsed but a single line break kept, ≤ 200 chars, absent when empty. Kept on
  every receipt method. On a twin, each leg has its own store's note. Written only at insert,
  with no edit path, and not in `customers.orders[]`. Do not confuse it with
  `orders.order.commentToCourier` (customer → courier, DELIVERY only, support-editable) or with
  top-level `orders.note` (the store staff's own note, `/api/order/update` whitelist).
  CORE invariant 25.
- **`shoofi.customers.orders[]`** = a **write-once snapshot with NO status field.**
  `{ orderId(ObjectId→orders._id), appName, created, total, orderIdNumber(=orders.orderId),
  originalOrderId, ... }`. **NEVER infer status/completion/revenue from it** — join
  back to the store `orders` by `orderId`→`_id`. Reuse
  `getSuccessfulOrdersByCustomerIds` (`utils/customer-orders.js`). Read
  `docs/customer-orders-snapshot.md` before ANY logic about a customer's order status.
- **`shoofi.customers` has NO `phone` index in prod.** `utils/create-indexes.js` defines
  `phone_index` but is a standalone script never run against `shoofi` — a lookup by phone
  is a collection scan.
- **`shoofi.orderFlowEvents`** = append-only audit timeline keyed on `orderNumber`
  (`order_created`, `payment_*`, `status_change`, `delivery_booked`, ...). Read via
  admin order-monitoring + the `investigate-order` skill. Traps:
  - **No TTL, no retention.** `cleanupOldEvents` (`centralized-flow-monitor.js`) is never
    called; history runs back to 2025-07-24 (~11.8M docs, 2026-10-06).
  - **`order_viewed` `metadata.previousStatus` is always wrong** — `/update/viewd` reads it
    from the order re-fetched *after* its `$set`, so it equals the new status. Pre-accept
    status (normally `6`) is not recorded there; take it from the prior event.
- **`delivery-company.bookDelivery`** (Mongo collection `book-delivery`) carries three order keys:
  `bookId` = the order's short `orderId`, `originalBookId` = its full `originalOrderId`, and
  `appName` = the store's DB name. It mirrors `DELIVERY_STATUS` (`1` waiting_approve … `3`
  collected/pickup … `4` delivered). CORE invariants 22 (matching a delivery) and 23 (locating an
  order's row: `deliveryRowFilterForOrder(order, appName)`, `utils/delivery-row.js`).
  - **The short number is not unique, across stores or within one.** `orderId` is the first 4 +
    last 4 digits of the 14-digit `originalOrderId` (`generatedOrderId`, `routes/order.js`; the
    twin routes cut it the same way), roughly 5×10^7 values. Prod on 2026-11-08: 88 `bookId`s were
    shared by 2+ stores out of 106,071 rows, the newest collision from 2026-11-07; and 12
    (appName, orderId) pairs in `customers.orders[]` belonged to two different orders (GCP
    "0880-8715", GCP "4587-1395", cacao "7660-8910", …). The full id had 0 collisions across
    173,659 orders.
  - **Who writes what.** Every booking writes `bookId: order.orderId`,
    `originalBookId: order.originalOrderId` and `appName: storeData.appName || order.appName`
    together: store accept `POST /api/order/update/viewd`, twin sides included, and
    `POST /api/order/start-preparing`. `originalBookId` is on all 85,304
    rows created since 2025-12-12. The 20,771 rows without it are all older; the newest is from
    2025-12-12. The one duplicate `originalBookId` is a single vapego order booked twice (one row
    `-3`), not a collision. `services/delivery/book-delivery.js` **invents a random
    `originalBookId`** when the booking passed none, so a row having one does not prove it came
    from an order. Delivery-only bookings use `String(idempotencyKey)`. 96 rows carry the
    `appName` fallback `"shoofi-app"`. Every `created` is an offset string (106,076 of 106,076),
    and a booking is always made after its order. Across the past 14 days' delivered rows, the
    gap from order to booking ran from +5 s upward, and none was negative.
  - **No index on `originalBookId`** (indexes: `bookId`, `{bookId, status, completedAt}`,
    `created`, `order._id`, …). On 2026-11-08 an `$or` with an `originalBookId` branch scanned
    104,734 docs (339 ms). Query on `bookId` and compare the full id in code. The order's own row
    always shares its `bookId`, so it is always in that result.
  - **Matched correctly:** `filterOutDeliveredOrders` (`utils/active-orders.js`, behind
    `GET /api/order/customer-active-orders`).
    - It reads delivered rows by `bookId ∈ …, appName ∈ …` (indexed) and projects `bookId`,
      `appName`, `originalBookId` and `created`. It groups the rows by exact `appName|bookId`,
      because the two `$in`s are a cross product.
    - A row is the order's delivery (`isDeliveryOfOrder`) when `originalBookId ===
      order.originalOrderId`.
    - **Only if either side lacks the full id**, it accepts a row booked no more than
      `BOOKING_BEFORE_ORDER_MARGIN_MINUTES` (10) before the order (`isBookedAfterOrder`). A row
      whose `created` is missing or unreadable is not accepted. That rules out every older
      same-store row, including all legacy rows without `originalBookId`.
    - The endpoint passes the store DB it read each order from (`appNameOf`), falling back to
      `order.appName`.
    - Kept, never dropped: an order with no known store, and every order when the delivery DB
      read throws.
    - History: before the fix it matched on `bookId` alone. On 2026-11-08 GCP's live CASH order
      1096-8335 never reached the customer's ActiveOrders screen or tab-bar bubble, because
      burger-house had a delivered 1096-8335 from 2026-09-21. The customer ordered again. Fixed in
      shoofi-dev/shoofi-server#513. Tests: `test/integration/customer-active-orders-per-store.js`.
      The app half (the just-placed order shown before the poll, and an error state instead of
      "no orders") is in C1 "Tracking".
  - **Located with `deliveryRowFilterForOrder`** (CORE invariant 23, shoofi-server#514, merged
    2026-11-08): `/api/order/update` cancel and ready-for-pickup (find, then write by `_id`),
    `update-delay`, order-amend `syncDeliverySnapshot`, twin `cascadeCancel` / `degradeToSingle` /
    `undoDegrade` (via `legDeliveryFilter`), twin `group/:groupId/full` and `assign-driver`,
    support `update-address-to-current-location`, admin order-monitoring `computeOrderDelays`,
    support-agent `find_order`. `routes/order-comment-to-courier.js` pairs `bookId` + `leg.appName`.
  - **Delivery-side writes, located by `locateDeliveryRow`** (delivery CORE invariant 20,
    2026-11-08): `POST /api/delivery/admin/cancel` (delivery-web sends `{deliveryId, bookId}`) and
    `POST /api/delivery/update` → `updateDelivery`. A legacy shared `bookId` writes its single live
    row or gets a 409.
  - **Still keyed on `bookId` alone:** the reads `GET /api/delivery/book/:bookId`
    (owner-scoped for a mobile token), `GET /api/delivery/order/:id`, `POST /api/delivery/orders/batch`
    (no caller), the impersonation driver lookup in `routes/shoofi-admin-users.js`, and the
    analytics `bookId: {$in}` joins (live-ops, churn-360, support-analytics). A bare `updateOne`
    on a shared number hits whichever row Mongo returns first.
- **`shoofi.twinOrderGroups`** links `orders.twinGroup` ↔ group `primary`/`secondary`.
- **`orders.marketingTouch`** (optional, top level) =
  `{ kind, placement, itemId, campaignId?, linkType?, at: Date }`: the last marketing
  tap or push open before checkout, ≤ 24 h old. Written only at insert, by
  `/api/order/create` and both twin place routes, through `sanitizeMarketingTouch`
  (`utils/marketing-touch.js`). Absent = not attributed. A twin pair carries the same
  value on both legs, so count checkouts by `twinGroup.groupId`. Rules: CORE invariant 15.
  Not indexed, and nothing reports off it: it is the fallback input of the order facts.
- **`shoofi.marketingOrderFacts`** — one document per CHECKOUT (twin collapsed,
  `_id: "twin:<groupId>"`, else `"order:<appName>:<orderObjectId>"`). It holds the touches
  (server events + this fallback), the normalised status and the final amounts, and the
  reconcile cron keeps it true. Written after the response by `scheduleOrderFact`. Full shape:
  shoofi-server `docs/marketing-attribution.md`; rules: CORE invariant 16.
- **Order dates — `datetime` is when it was PLACED, `orderDate` is when it is DUE.** Both are
  client-supplied ISO-8601 **offset strings** (`"2026-08-03T15:00:00+03:00"`, never UTC, never
  a `Date`) built by `moment().format()` in `shoofi-app/stores/cart/index.ts` and stored
  verbatim — `POST /api/order/create` copies them into `orderDoc` untouched. Only `created` is
  server-computed. `orderDate` always exists (it falls back to *now* at create), but its
  meaning **shifts across the lifecycle**: the requested handover time at create, the ready
  time after a non-future accept (§2), and `+delayMinutes` after `/update-delay` (which
  preserves `originalOrderDate`). For a same-day order the two land on the same calendar day,
  which is why code that displays "the order's date" tends to pick `datetime` and go unnoticed
  until a future/ramadan order arrives — see shoofi-dev/shoofi-partner#8. Date windows must be
  built as offset strings to compare correctly.

- **Whole-history readers.** The unit-economics dashboard (shoofi-server
  `services/unit-economics/`, `docs/unit-economics.md`) sweeps EVERY completed order in every
  non-mock store DB (projection: `customerId`, `created`, `shippingPrice`, `appliedCoupon`,
  `order.receipt_method`, `twinGroup.groupId`) and counts a twin group as one customer basket.
  It relies on `COMPLETED_STATUSES` and on `created` being an Israel-offset ISO string (it reads
  the local date off the first 13 characters, falling back to moment-timezone otherwise).

- **Per-customer history reader — For you / AI helper** (shoofi-server
  `services/ordering-intelligence/taste.js` `loadCompletedOrders`, menu-catalog's code,
  `docs/ai-helper.md`). It follows CORE invariant 5: `customers.orders[]` only says where to
  look — its newest `MAX_ORDERS` = 30 entries whose `created` is inside `HISTORY_DAYS` = 90 —
  and each store's `orders` keeps `status ∈ COMPLETED_STATUSES`. The cap is taken **before** the
  status filter, so unpaid/cancelled snapshot rows use up slots. Projection: `created`,
  `orderDate`, `originalOrderDate`, `order.items.{item_id, qty, nameAR, nameHE, selectedExtras}`
  — rename one and a taste fact silently disappears. On top of it:
  - `deliveredOrders` (`GET /api/ai-helper/profile`, `ai-helper-service.js`) = `totalOrders` =
    **completed** orders in that window (per-instance 10-min cache) — **not** courier-delivered
    (`bookDelivery.completedAt`). The app routes ≥ 2 (`HISTORY_MIN_ORDERS`,
    `shoofi-app/stores/ai-helper`) to the history onboarding.
  - `facts.js` `meal_time` buckets `orderMs = originalOrderDate || orderDate || created` by
    **Israel** hour: the DUE time frozen before any delay (CORE invariant 10) — after a default
    accept that is the tablet-clock ready time (§2), for `14`/`15` the requested time — never when
    the order was placed. `likes_spicy` matches `selectedExtras` (`"id"` and legacy `["id"]`)
    against the product's CURRENT extras.
  - `inferred` on `shoofi.tasteProfiles` is a **lazy cache, not an order hook**:
    `refreshInferredIfStale` (`taste-profile.js`) rewrites it on `GET /profile` when older than
    `INFERRED_TTL_MS` (1 h), customers only; nothing reads it yet. There is no single
    delivered/completed transition to hook (CORE invariant 1) — don't add one to a
    status-transition path for it.

## 6. Idempotency & invariants — never break these
1. **Stock**: `decrementOrderStock`/`restoreOrderStock` gated by the
   `stockDecremented && !stockRestored` pair (`order-stock.js`) + `store.isStockManagment`.
   Decrement **only** on confirmation (never `status:"0"`) — a failed charge must
   never consume stock. Restore covers every cancel actor incl. driver `9`.
2. **Payment**: Apple Pay finalize uses atomic `findOneAndUpdate({_id,status:"0"})`
   to guarantee single finalize; the callback can arrive **before** the order exists
   (self-heal `order.js`). Twin = single combined capture.
3. **Amount-mismatch backstop**: charged vs `order.total` drift ≥0.01 → force
   FRAUD_REVIEW (`finalizeApplePayOrder:2254`); twin excluded.
4. **Creation lock** must always release in `finally`.
5. **Secondary features must NEVER fail the primary order** — coins, world-cup,
   attribution, coupon minting, invoices, notifications, external-provider, flow
   events are all try/caught and swallowed. Coins-redeem-after-charge failure is
   logged **CRITICAL** (customer charged discounted total, coins not debited →
   manual reconciliation, `order.js`).

## 7. Cross-domain boundaries — hand off, don't reach in
- **PAYMENTS / INVOICING** (🔒 never modify): `processCreditCardPayment`,
  `processHypTokenPayment`, `finalizeApplePayOrder`, ZCredit calls, `utils/hyp-pay.js`,
  `twin-payment-service.js`, invoicing. If a fix's root cause is here → write it up, stop.
- **DELIVERY**: `services/delivery/book-delivery.js` (booked at accept) +
  `bookDelivery` mirror; driver assignment is the delivery agent's turf
  (`docs/delivery-areas-model.md`).
- **STOCK / menu**: `utils/order-stock.js` (shared with menu-catalog) — stock
  semantics only; coordinate on changes.
- **NOTIFICATIONS**: `services/notification/*`, websocket, persistent-alerts, SMS.
  ⚠️ The store-owner new-order alert does **not** come from `services/notification/*`
  directly — `sendStoreOwnerNotifications` (`routes/order.js`) delegates to
  `utils/persistent-alerts.js`, which inserts a `shoofi.persistentAlerts` doc and
  **keeps re-pushing it until the partner accepts the order**. `persistent-alerts-cron`
  runs on `*/1 * * * *`, and `sendReminders` throttles per alert on `MAX_REMINDERS = 5`
  + `REMINDER_INTERVAL_MS = 60 * 1000` (`utils/persistent-alerts.js`) — **5 reminders on
  5 consecutive minutes, then permanent silence**, per store user. The every-minute
  cadence is a **deliberate product decision, not an oversight** (see the comment on
  `REMINDER_INTERVAL_MS`): the store must approve ASAP, and an accept 25 minutes late is
  a bad outcome. Its cost — a still-pending order is never announced again after minute
  5 — was shown to the requester and accepted. **Do not "fix" it back to a wider
  spacing**; that trade-off is a product call. Note the observable cadence is the same
  one the dead filter used to produce by accident (below) — the difference is that it is
  now explicit, pinned, and no longer an artefact of the cron period.
  ⚠️ **The cutoff is deliberately not round.** `REMINDER_TICK_SKEW_MS = 5 * 1000`, and
  the query builds `cutoff` from `REMINDER_CUTOFF_AGE_MS` (= interval − skew), never
  `now - REMINDER_INTERVAL_MS`. Since the interval now *equals* the cron period, a flat
  cutoff is a coin flip per tick: a stamp written at second 0.x of one tick is a few ms
  short of 60s old when read at second 0.y of the next whenever y < x, so the alert waits
  another whole minute and "5 in 5 minutes" silently becomes "5 somewhere in 5–10",
  non-deterministically. Nothing fails when that regresses — do not simplify it away.
  The gap is an `$or` on `lastReminderSent` (null / `$exists:false` /
  `{$type:'date', $lte:cutoff}`) next to `reminderCount: { $lt: MAX_REMINDERS }`. Each
  alert in the sweep has its own try/catch, so one malformed doc no longer aborts the run
  for every store. The record's own `reminderInterval`/`maxReminders` fields are
  denormalised at insert and **never read back** — the sweep uses the module constants.
  **Why the throttle was dead until then** (the non-obvious part): `lastReminderSent` used
  to be written as a serialised moment (`{_isAMomentObject, _d: Date, …}`), which never
  compares against a Date in a Mongo query — so the filter was commented out and
  `reminderCount < 5` was the only brake. It is a real `Date` now; the extra
  `{"lastReminderSent._d": {$lte: cutoff}}` branch exists only for moment-shaped docs
  written before the fix (the cleanup cron deletes alerts after 24h).
  `clearPersistentAlert` (on `isViewd`) is what stops it, and it is the `persistentAlerts`
  collection — not `notifications` — that holds the pending state.
  ⚠️ **The alert never holds a customer response.** Every create path (cash / inline
  Apple Pay, ZCredit token, HYP_TOKEN, HYP wallets), `/api/order/updateCCPayment` and
  `finalizeApplePayOrder` call `fireStoreOwnerNotifications`, which starts
  `sendStoreOwnerNotifications` and returns; its `.catch` (and the helper's own catches)
  log `[STORE_ALERT_FAILED]` with `orderNumber`/`appName`/`stage`. Each call sits after the
  order's final-status write, and nothing after it reads the result — keep both true. The
  one awaited caller left is the fraud-approval branch of `/api/order/update` (13 → 6,
  an admin request, already try/caught). Why: brixta 2026-10-03, an awaited alert on a
  stalled Expo socket held the create response 128s and 257s, and the customer
  resubmitted (5095-6430/7257-3591, 6096-0808/0490-5740).
  **Push transport** (`services/notification/notification-service.js`
  `sendPushNotification`): each Expo/Firebase attempt is raced against
  `PUSH_SEND_TIMEOUT_MS` (default 10000); `retryAttempts = 2` = **at most one retry**,
  and **no retry after a timeout** (the abandoned request is not cancelled — neither SDK
  takes a signal). A timeout is a **failed** push: `results.push = 'failed'` and an
  `orderFlowEvents` row `eventType: 'notification_push_failed'`, `status: 'failed'`,
  `metadata.reason: 'timeout'`, `metadata.durationMs` (other failures carry
  `reason: 'error'` / `'rejected'`; `push_sent` rows carry `durationMs` too). Log tags
  (winston → OpenSearch `shoofi-server-logs`, fields folded into `message`):
  `[PUSH_TIMEOUT]` error — recipientId, recipientType, notificationType, appName,
  orderNumber, provider, elapsedMs, timeoutMs; `[PUSH_FAILED]` warn — thrown or
  ticket-rejected attempt; `[PUSH_SLOW]` warn — any send over `PUSH_SLOW_WARN_MS`
  (default 3000), even a successful one.
- **FRAUD**: `order-fraud-*`, `fraud-config-loader`, `fraud-check-storage` →
  `shoofi.fraudChecks`/`deviceCustomers`/`ipCustomers`.
- **GROWTH/COINS (secondary)**: `coinsService`, `worldCupService`, attribution — must never fail the order.
  Coins admin routes (CORE invariant 19): `/api/admin/coins/{expire, customer/:customerId,
  customer/:customerId/earned, store/:storeAppName/stats}` in `routes/coins.js` (`COINS_ADMIN`) and
  `/api/admin/coins-settings` + `/api/admin/store/:appName/coins-settings` (GET and POST) in the
  Coins Settings block of `routes/shoofi-admin.js` (`COINS_SETTINGS_ADMIN`). All eight are
  `auth.required` + a role check, so no token is 401 and customer, partner and driver tokens are
  403. Seven take `DASHBOARD_ROLES`; `expire` is master-only (`COINS_EXPIRE_ADMIN`) and audited
  as `expire_coins`. The customer routes `/api/coins/*` are `auth.required` and read the
  customer from the token. Store `coinsSettings` is also written by the ungated
  `POST /api/store/update`.

## 8. Crons (prod-only, `ENABLE_CRONS=true`; distributed locks — `docs/distributed-cron-jobs.md`)
- `order-overdue-checker` (5 min): flags overdue `1`/`3` orders + runs the **twin overdue sweeper**.
- `delivery-pickup-checker` (3 min) / `delivery-completion-delay-checker` (4 min): `bookDelivery` delay alerts.
- `fix-stuck-orders` (daily 7am): iterates ALL store DBs; stale `1` → `3`/`2`. School variant separate.
- `fraud-check-schedule`, `feedback-notification`, `persistent-alerts`, `growth-snapshots` (feeds twin prep-time).

## 9. Where you may act freely vs. must stop
**Safe zone — implement + PR normally (still inherit all gates):**
- Read/query/admin/reporting: order listing, `customer-orders*`, `admin/order-monitoring/*`,
  statistics, search, timeline. Bug fixes here (wrong filter, bad join, snapshot misuse).
- Cron **observability** (logging, metrics) that doesn't change status logic.
- Non-status fields: printing, `isViewd`/`isPrinted` flags for read purposes, notifications wording.
- Anything the task explicitly authorizes with human sign-off.

**High-risk zone (change via draft PR, HIGH-RISK flagged, never merge):** anything
in §0's list — creation, status transitions, twin place/pay/cancel/degrade, stock
decrement/restore logic, transition guards. Minimal diff + extra tests + a "what
could break" section. Payments/invoicing files stay off-limits — hand off in the PR.

## 10. Known status (human-confirmed) — do NOT "fix" these
- **BY DESIGN — leave it:** `verifiedAppName()` is a pass-through (`order.js`);
  the multi-tenant cross-check is intentionally disabled — order creation trusts
  the `app-name` header today. Do not "re-enable" it without an explicit task.
- **BY DESIGN — leave it:** fraud **rejection** is intentionally off. `performFraudChecks`
  routes risky orders to FRAUD_REVIEW(`13`) for manual handling; `shouldBlockCustomer`
  exists but the hard-block path stays disabled on purpose. Do not turn it on.
- **Awareness (not a bug):** coins-redeem-after-charge failure → CRITICAL log +
  manual reconciliation, not auto-refund (`order.js`).
- **Awareness (not a bug):** HYP "verified=false but paid" → logged paid-but-stuck; no auto-recovery.
- **Awareness:** background work in `/update/viewd` (delivery booking, external
  provider, twin coordination) runs after the 200 response — failures never reach the client.
- **DEFERRED (Sari, 2026-10-16) — do not build without a new decision:** the For-you in-chat
  **checkout** card. Adding to the cart from the chat is built (2026-10-17, CORE invariant 13);
  ordering still hands off to the existing cart → checkout (C1). Reasons: the client-computed
  total in `shoofi-app/screens/checkout/index.tsx`, `postChargeOrderActions` (same file), and
  customer consent. See CORE Known status.

# PART 2 — Client repos (full-stack view)
You own orders across the clients too. Each subsection is where that repo drives
or displays the order. **A change per repo = a PR per repo** (guardrails §1b).

## C1. shoofi-app — the CUSTOMER app (React Native, MobX)
Role: **places** the order and **tracks** it. The origin of the whole lifecycle.
- **API client**: axios (`utils/http-interceptor/index.ts`), token `@storage_userToken`
  as `"Token …"`, `app-type: shoofi-shopping`, `app-name` per-call = target store `appName`,
  plus a **`device-id`** header for fraud detection, and **`x-client-features: combo`** from
  the bundle that can render combo deals — without it the server strips combos from the menu
  (menu-catalog reference §6b). `helpers/combo-pricing.ts` is the client copy of
  `calculateComboExtrasPrice` (CORE invariant 11).
- **Public pre-checkout reads** (CORE invariant 18): `admin/check-order-time-valid` (the cart's
  `isOrderTimeValid` on submit, maybe logged out) and `admin/calander/disabled/hours/:date` (the
  `pick-time` dialog, not reachable from the cart on main: `onPickTime` is defined, never bound).
  Both stay unauthenticated on purpose and return no order.
- **Order creation** = **`POST order/create` as multipart/form-data** (`body` = JSON
  cart payload + `img` files), built by `stores/cart/index.ts` (`getCartData` →
  `produtsAdapter`) via `hooks/checkout/use-checkout-submit.ts` from
  `screens/checkout/index.tsx`. **Client computes the totals** (`total`, `orderPrice`,
  `shippingPrice`) and the server trusts them (matches the server doc's pricing note).
  `shippingPrice` = `availableDrivers.area.price || 0` (the PRE-discount tariff; coupons ride on
  `discountAmount`, deals on `total`), so a quote with no `area` posts ₪0 — the paused-area
  bug. The server only logs and flags a fee below the tariff (CORE invariant 20).
  Initial status is `"0"` (CC) or `"6"` (digital success), decided client-side. **The target
  store is the cart's stamp:** checkout passes `storeData: cartStoreData || storeDataStore.storeData`
  and `submitOrder` sends `app-name: order.storeData?.appName` — so whatever stamps an empty
  cart decides the store DB the order lands in (CORE invariant 13).
  Optional **`marketingTouch`** on the same body (CORE invariant 15). The server accepts it
  from shoofi-server's `feat/order-marketing-touch` onwards. `submitOrder` gets it from
  `prepareMarketingForOrder()` (`services/marketing-events.ts`), which first sends the
  queued taps (≤1.5s, never throws) so the server can credit the order from its own events.
  It belongs in `submitOrder`, not `getCartData`, because `getCartData` also feeds the
  legacy `updateOrderAdmin`. On twin checkouts it goes TOP-LEVEL on the `twin-order/place`
  / `digital-place-pending` JSON body, not inside `primary`/`secondary`.
- **Payment**: CC is charged **server-side inside `order/create`** (client passes
  `paymentData`; the client-side charge is deprecated). Apple/Google Pay use a ZCredit
  session + `order/save-apple-pay-session` → `update-apple-pay-order-session` →
  `verify-apple-pay-payment` (retried). HYP via `payments/hyp-tokenize-session` + `hyp-process-token`.
- **Twin (customer side)**: `stores/twin-order` + `stores/twin-cart` (second-store cart);
  combined checkout calls `twin-order/{eligible-stores, quote, place, pay,
  digital-place-pending, digital-finalize}`. Secondary side `shippingPrice:0` (combination fee covers it).
- **Tracking = POLLING every 30s** — **no websocket for customer order status** (WS is only
  used for store/menu refresh elsewhere). Detail: `screens/order/item`, timer `order-timer.tsx`
  keyed on status, ETA via `delivery/book/{bookId}`.
  - **One list, one poll** (`stores/orders/index.tsx`): `ordersStore.activeOrders` is what the
    ActiveOrders tab (`screens/order/active/index.tsx`), the tab-bar order bubble
    (`components/layout/footer-tabs/BottomTabBar.tsx`) and the For-you chips all render.
    `subscribeActiveOrders` runs ONE `GET order/customer-active-orders` timer for every
    subscriber. Extra refreshes: the tab bar on `ORDER_SUBMITTED` and on app-foreground, the
    ActiveOrders tab on focus.
  - **Stale-response guard:** each `refreshActiveOrders` takes a sequence number. A success is
    applied only if it is newer than the last applied one (`activeOrdersAppliedSeq`); a failure
    counts only when it is the latest request. Logout bumps the sequence, so a response in
    flight from the old session is dropped.
  - **A failed load is not "no orders":** the list already shown is kept and
    `activeOrdersError` is set. With nothing to show, the tab renders an error and a retry button
    (`components/order/orders-load-error`, `retryActiveOrders`). "No orders" appears only
    after the server returned `[]`. A 200 that is not an array counts as a failure. Order history
    (`screens/order/history/index.tsx`) works the same way, with its own sequence guard.
  - **The just-placed order shows before the poll returns it** (`helpers/placed-order.ts`,
    built after GCP 1096-8335 on 2026-11-08: three minutes of "no orders", then a duplicate
    order). `use-checkout-submit` **stages** a local copy from the create response
    (`{ message, orderId }`, where `orderId` is the Mongo `_id`; the response carries no
    `originalOrderId` and no short number) and from the body it sent. It never stages a recorded
    payment failure (`errorMessage`). `postChargeOrderActions` (`screens/checkout/index.tsx`)
    **shows** it, right before `ORDER_SUBMITTED`. Staging and showing are separate because Apple
    Pay creates the order at `"0"` before the sheet is paid. A twin checkout or an admin edit
    discards the staged copy: a twin pair is drawn from both server docs. The copy is marked
    `isPlacedLocally` and drawn by `placed-order-card.tsx`: store, "sent", payment method,
    total and time. It shows no status, number or timer, and it does not open details.
    - **Matched** to the server's copy on `_id`, or on `originalOrderId` when both carry it.
      **Never on the short `orderId`** (CORE invariant 22).
    - **Drop rule:** the copy is dropped for good the first time the server lists it. From then
      on the server list alone decides, so a delivered or cancelled order that leaves the list
      is not brought back. A copy the server never lists is dropped after
      `PLACED_ORDER_TTL_MS` = 10 min (20 poll cycles), checked on every refresh, failed ones
      included. A copy is never shown more than `STAGED_ORDER_MAX_AGE_MS` = 30 min after
      staging. Logout or a different token clears it. It lives in memory only, so an app restart
      drops it.
- **Key files**: `stores/cart/index.ts` (payload builder + `order/create`),
  `stores/orders/index.tsx` (the shared active-orders list), `helpers/placed-order.ts`,
  `stores/twin-order/index.ts`,
  `hooks/checkout/use-checkout-submit.ts`, `screens/checkout/index.tsx`,
  `screens/order/{active,item,history}/*`, `consts/{api.js,shared.ts}`.
- **Gotchas**: `order/create` is **multipart** (twin / Apple-Pay / HYP calls are JSON);
  the client `ORDER_STATUS` enum **omits `"0"` and `"13"`** (used only as literals) — keep
  in mind when reasoning about pending-payment/fraud states on the customer side.
- **The For-you chat ADDS to the cart but never places an order** (`screens/for-you/ForYouScreen.tsx`,
  menu-catalog's code; the cart side is CORE invariant 13). All behind `isChatOrderingEnabled`:
  - **Read-only parts.** The cart dock (`components/for-you/CartDock.tsx` — reads `cartStore`,
    writes nothing) and the context chips (`components/for-you/context-chips.ts`): with items in
    the cart "complete the order" → `navigate("cart")` → normal checkout; with an active order
    (the shared `ordersStore.activeOrders` list — the chat runs no poll) "where is my order?" →
    the `active-orders` tab. The dock's ₪ is `cartStore.getProductsPrice()` (Σ line price × qty)
    — **not** the order total: no delivery fee, coupon or coins (checkout's `TotalPriceCMP`).
  - **Quick-add** (`hooks/useChatAddToCart.ts`, built 2026-10-17): the "+" on a `SuggestionCard`
    or a `CrossSellPill` loads the store and its menu with the fetch-only
    `getStoreDataFromServer` / `getMenuFromServer` (2-min per-store cache), builds the line as the
    menu's product screen does (`helpers/chat-cart-line.ts` `buildCartLine`; choices in
    `ChatProductSheet`, `single` / `multi` only) and calls `cartStore.addProductToCartForStore`.
    Straight in only when there is nothing to choose and no default pre-chosen. A dish the store
    no longer sells (not `isInStore`, stock 0, a mandatory choice all out of stock) is said in
    the chat (`add_unavailable`) and nothing is added. Anything it cannot do exactly like the
    menu opens the store at the dish instead (`openStoreAtProduct`, logged
    `for_you_quick_add_fallback` + `reason`): a twin order or twin cart, a school cart, an
    age-checked store not yet approved, combo / by-weight / pizza / counter / free-count /
    unsupported extras, a failed load, a cart with no stored store.
  - **Another store's cart:** the chat asks (`store_conflict`, replace / keep); "replace" re-reads
    the cart, `resetCart()`s it if it is still another store's, then adds; "keep" changes
    nothing. The stepper's "−" is `updateProductCount` / `removeProduct` on the dish's LAST line
    (`removeProduct` clears the cart's store stamp when the cart empties).
  - **Server traffic:** `/api/store` + `/api/menu` (fetch-only) and `/api/for-you/suggest` with
    `cart: { appName, productIds }` (drink / sweet, and one `cross_sell` per store per chat after
    the first add). No order API changed; server `docs/ai-helper.md` records a local end-to-end
    check (the order landed in the dish's store with the chosen extras, shadow-pricing drift 0).
    The in-chat checkout card stays DEFERRED (CORE Known status, §10).

- **Note to the store** (CORE invariant 25): the cart page's note box →
  `order.commentToStore`, sent on every receipt method, trimmed, ≤ `COMMENT_TO_STORE_MAX_LENGTH`
  (200), left out when blank. On `main` (2026-11-10) it is one string, `cartStore.storeNote`, and
  `getCartData` sends it; twin checkout sends no store note. Branch
  `feat/store-note-per-twin-store` (built, not merged) changes this:
  - **Per store:** the note is kept in `cartStore.storeNotes: Record<appName, string>`. It lives
    in memory only and is cleared by `resetCart` and `resetCartForNewStore`.
  - **Single store:** `getCartData` sends the note for `order.storeData.appName`.
  - **Twin:** both twin builders, `/twin-order/place` (`handleTwinCheckout`) and
    `/twin-order/digital-place-pending`, take `primary.commentToStore` /
    `secondary.commentToStore` from `cartStore.twinCommentToStoreFields(primaryAppName,
    secondaryAppName)`. The notes are never put in `sidePayloadShared`; `commentToCourier`
    stays shared.
  - **Cart UI:** one box on a single-store cart (testID `cart-store-note-input`). A twin cart has
    one box inside each store's section (`twin-cart-store-note-input-primary` / `-secondary`),
    with a placeholder naming the store.
  - **Tests:** `__tests__/stores/cart-store-notes.test.ts`,
    `__tests__/screens/twin-checkout-store-notes.test.ts`, `__tests__/helpers/store-note.test.ts`.

## C2. shoofi-shoofir — the DRIVER app (React Native, MobX)
Role: executes the **delivery leg**; drives `bookDelivery` status only — never the order's.
- **API client**: axios in `utils/http-interceptor/index.ts` — token `@storage_userToken`
  as `Authorization: "Token …"`; headers `app-type: shoofi-shoofir`, `app-name`
  default `"delivery-company"` (per-call overridable). Base `consts/api.js`.
- **Lifecycle endpoints** (`stores/delivery-driver/index.ts`, payload `{orderId, driverId, bookId}`):
  `delivery/driver/order/approve` → `waiting-in-store` → `start` (pickup) →
  `complete` (delivered) → `cancel`. Plus `delivery/list`, `delivery/update`,
  `delivery/driver/location|availability|nearby-orders`.
- **Status scheme (important):** the driver UI works on the **bookDelivery
  `DELIVERY_STATUS`** numeric strings (`consts/shared.ts`: 1 waiting-approve, 2
  approved, 3 collected/pickup, 4 delivered, 5 waiting-in-store, -1 cancelled) —
  **NOT** the customer `ORDER_STATUS` 0-15. **Nothing bridges them:** the driver endpoints
  (`routes/delivery/orders.js`) write only `bookDelivery`, so `orders.status` never learns
  about pickup/delivery (§2). Delivered = `bookDelivery.completedAt`. Don't conflate the two schemes.
- **Twin**: two bookDelivery docs sharing `twinGroupId` render as one `TwinOrderCard`;
  `twinAssignmentMode` single|split (split = each driver sees only their side).
- **Realtime**: `hooks/use-websocket.ts` (WS `?appType=shoofi-shoofir`), notifications
  trigger order refetch; `hooks/useDriverLocationTracking.ts` posts GPS (fg 10s / bg).
- **Key files**: `stores/delivery-driver/index.ts` (core state + all calls),
  `screens/delivery-driver/index.tsx`, `components/delivery-driver/OrderCard.tsx`,
  `consts/{api.js,shared.ts}`, `hooks/{use-websocket,use-notifications,useDriverLocationTracking}.ts`.
- **Gotchas**: two HTTP layers exist — `axiosInstance` (live) vs
  `services/deliveryDriverService.ts` (legacy raw `fetch`, `app-name: shoofi-app`,
  no auth); UI hardcodes numeric status strings instead of importing `DELIVERY_STATUS`;
  `DELIVERY_DRIVER_README.md` status section is stale. Verify `ADD_NOTE`/`DELETE_NOTE` server names.

## C3. shoofi-partner — the STORE-OWNER app (React Native, MobX)
Role: receives orders, **accepts**, prepares, prints, and drives status forward.
- **API client**: axios (`utils/http-interceptor/index.ts`), token `@storage_userToken`
  as `"Token …"`, `app-type: shoofi-partner`, `app-name` = `@storage_storeDB` (per-call overridable).
- **Endpoints** (`stores/orders/index.tsx`, controller `order/`): `admin/orders` (list),
  `admin/all/not-viewd` (incoming feed, when `isAdmin(ROLES.all)`, which is every prod store
  user: 394/394 carry `roles: ["all"]` on 2026-10-30), `admin/not-viewd` (the same feed for a
  store user without `all`, and before user details load), **`update/viewd` = ACCEPT** (→ `6→1`, future `14→1`,
  sends `readyMinutes` — not persisted, §2), `update` (forward/back status + note), `update-item-collected`,
  `start-preparing` / `update-start-preparing`, `update-delay`, `printed`,
  `book-delivery`, `*-custom-delivery`, `future-orders-ready`, `drive-in-arrival-confirm`,
  and `admin/history` (`getOrderHistory(date)`, the v3 history tab; on shoofi-partner
  `feat/orders-board-v3`, not on `main` as of 2026-11-08).
  (`addRefund` is gone: the app dialog was deleted under HQ #1a2f9e and the server route removed
  in shoofi-server 29ed5252, 2026-11-03.)
- **Transition rule**: ACCEPT goes through **`order/update/viewd`** (NOT `order/update`);
  all other forward/back transitions use `order/update` with an explicit `status` the
  client computes (`1→3` delivery / `1→2` takeaway; `3→11`; `2→11|10`; `15→1`).
- **Status constants** match server 0-15 (`consts/shared.ts`).
- **Twin**: read-only from the order payload (`order.twinGroup`, `twinPeerInfo.orderDate`);
  the partner caps the **second store's** prep window (`TWIN_SECONDARY_EARLY_MAX_MIN=10`).
  No twin endpoint is called — twin timing is server-computed.
- **Gates (CORE invariant 18)**: everything the partner reads from the order admin takes
  `ORDERS_DASHBOARD_OR_STORE_MEMBER`, so the phone must own the `app-name` store:
  - the live feed `admin/all/not-viewd` (and `admin/not-viewd`);
  - `admin/orders` (the list and the print sweep);
  - `admin/school-project-orders-for-print`, `future-orders-ready`, `get-custom-delivery`;
  - `admin/not-printed` (defined in `stores/orders`, never called);
  - the `calander` writes (`stores/calander`, behind the dashboard's commented-out calendar
    item).

  The partner always sends `@storage_storeDB` as the header, and that is the token's store or
  one of its phone's memberships. Even mid-`switchStore` (store first, token second) it passes.
  `admin/my-stores/new-orders-count` (`utils/cross-store-alerts`) stays `auth.required`: it is
  token-scoped and ignores the header.
  `admin/history` is the other way round: `auth.required` + `requireStoreMembership()` (the
  store-analytics gate, `routes/order-history.js`), partner-only, and the `reports` role only
  decides whether `totals` is filled. A store user without it gets the list and `totals: null`,
  never a 403 (CORE invariant 21).
  **Any 401 signs the store out** (`utils/http-interceptor` → `OPEN_GENERAL_SERVER_ERROR_DIALOG`
  `isSignOut: true` → `resetAppState` + restart), so a partner-polled route must never 401 a
  logged-in terminal.
- **"New customer" badge source** (CORE invariant 24): `order.isFirstOrderAtStore` arrives
  on the whole documents of `admin/orders`, `admin/all/not-viewd` and `admin/not-viewd`. Badge
  only on `=== true`; absent (old orders, a failed lookup) = no badge. The v3 history endpoint
  (`admin/history`, shoofi-server#497, CORE invariant 21) projects its rows without it.
- **Realtime**: WS `?appType=shoofi-partner`; handles `order_status_updated`,
  `unviewed_orders_updated`, `future_order_*` (NOT `menu_refresh`). The `print_order` /
  `print_not_printed` frames still arrive (the server sends `print_not_printed` when
  `/api/order/printed` sets `status:false`), but their `App.tsx` handlers are commented out.
  **Nothing prints from a websocket frame.**
- **Auto-print** (CORE invariant 17). Printing is a `PRINT_NOT_PRINTED` DeviceEventEmitter
  event → `printNotPrinted` → `forLoop` in `App.tsx`. A tablet prints only if its store user
  has the `all` AND `print` roles (`userDetailsStore.isAdmin` is a literal `indexOf`, so
  `roles:["all"]` alone never prints). Every such tablet prints on its own.
  - **Triggers**: accept (`screens/admin/order/new-orders/list`, the explicit approved
    order, gated on the approve promise); the row's print button
    (`screens/admin/order/list`: explicit order, then a bookkeeping
    `updateOrderPrinted(id, false)`); school-orders screens. An explicit order skips the
    fetch, the debounce and every filter.
  - **The sweep**: after a batch with no failure, and on a non-explicit trigger, the tablet
    posts `admin/orders` with `isNotPrinted:true`, `ordersDate: moment().format()`,
    `statusList: autoPrintSweepStatuses()` = `1,2,3,6` (+ forced `14`/`15`). It drops orders
    over the attempt cap and queues 3 at a time. `utils/print-batch.ts` stops a repeat
    within one sweep (10 re-entries, same-batch detection). `utils/print-attempts.ts` stops
    it across sweeps (`MAX_AUTO_PRINT_ATTEMPTS = 2` per order per app session; counted when
    the print fails, the capture fails or the mark call fails; cleared on a successful mark).
    **Server side**: without `ordersDate`, `admin/orders` applies no date window at all, and
    `isNotPrinted` only adds `isPrinted:false` (`isViewd:true` is always required). Before
    2026-10-29 the sweep sent no date and statuses `1,2,3,4,5,6,10,11,12`, so one unmarkable
    order came back on every sweep on every day.
  - **Business day**: the server picks the window with `getBusinessDayBoundaries` from
    wall-clock now. For "today" that is the current business day, including the overnight
    tail. ⚠️ **Known bug (not fixed, noted 2026-11-08 in shoofi-server `feat/partner-order-history`):**
    the overnight branch tests the CURRENT clock time, not the date asked. When the weekday
    before `ordersDate` has overnight hours and the request is made before that close + 90 min
    (any date, e.g. 01:30 for a 01:00 close), it returns the business day BEFORE `ordersDate`
    (start = its opening the evening before, end = its close on `ordersDate`). Right for "today"
    just after midnight, which is what it was written for; wrong for any other date asked in
    that window. A new day-scoped reader must use
    `utils/store-service.js` `getBusinessDayBoundariesForDateRange` instead (as `admin/history`
    and the payments screen do). One known gap: on a store with normal (non-overnight) hours, an order whose
    `orderDate` falls after midnight but before the next opening is outside the sweep. Its
    accept-time explicit print is unaffected.
  - **Driver result** (`helpers/printer/index.ts` `printImagesWithOutcome`): `"printed" |
    "unconfirmed" | "failed"` (`utils/print-outcome.ts`). Only Epson can be `"unconfirmed"`:
    `sendData`'s `CODE_ERR_TIMEOUT`, message `"Print timeout occurred."`, which comes after
    the data reached the printer. `printCopyWithRetry` retries only `"failed"` (2 attempts per
    copy); `outcomeCountsAsPrinted` marks `"printed"` and `"unconfirmed"`. The native
    timeout is `sendDataTimeoutMs`: 10s + 6ms per printed dot-line at 510 dots wide, clamped
    to 30–60s, and the ceiling when the PNG size is unreadable. The JS ceiling is that + 15s.
    `testPrint` (boolean) is kept as `!== "failed"`. Urovo/Sunmi map their boolean to
    printed/failed.
  - **Capture**: `getInvoiceSP` returns one slot per queued order (or distribution group),
    `null` where capture failed (`utils/print-queue.ts` `captureAlignedToQueue`). The loop
    pairs `orderInvoicesPS[i]` with `queue[i]` and never prints or marks a `null` slot.
  - **Ticket layout: one Text per line.** The ticket is captured from a hidden host as an
    image, and anything that overflows the host is simply not in it. A `label: value` line
    built as a row of two Texts overflows: React Native measures the value against the
    whole row, so it wraps at the ticket's width and then starts after the label. Under
    forced RTL its end runs past the LEFT edge and is cut off. On 2026-11-04 pastito's
    tickets lost "فلفل" from "…ثوم, فلفل أسود", and a line of paid add-ons lost its last
    items and prices. Extras lines are therefore ONE Text built by
    `helpers/invoice-extra-line.ts` (`invoiceExtraLine`), drawn by
    `components/shared/InvoiceOrderExtrasDisplay.tsx`. The same rule holds for any new
    ticket line. To see the exact printed image on a simulator, run Metro with
    `EXPO_PUBLIC_DUMP_INVOICE=1`: the capture is logged as a data-uri.
  - **Diagnosing a loop**: `<store>.client-error` rows with `error.source:
    "printer-testPrint"` (and `error.outcome` since 2026-10-29). `customerId` there is the
    `shoofi.store-users` `_id` of the tablet's user. Then the store's
    `isPrinted:false, isViewd:true` orders, which are exactly what the sweep can return.
- **The loud new-order alarm has ONE source, and an id ledger decides whether it rings.**
  `schedulePushNotification` (`utils/notification/index.ts`, `sound: 'store.wav'`) *is* the
  alarm, and its only live callers are the two in `hooks/use-notifications.ts` — the 30s poll
  and the badge refresh (`fetchUnviewedOrdersCount`). Everything else is quiet: the
  `notification` websocket frame is handled by `showLocalNotification` in that same hook with
  `sound: "default"`. So **"we get no notification" often means "we got the quiet banner and
  not the alarm"** — establish which one before you look at the server. (Two globals play
  `store.wav` for unrelated events — `components/global/{DriveInArrivalGlobal,
  FutureOrderReminderGlobal}.tsx`; neither is the new-order path.)
  Whether it rings is decided by `newOrderAlertsStore` (`stores/new-order-alerts/index.ts`),
  a per-store ledger of order ids persisted in AsyncStorage: `takeNewOrders` returns only the
  ids it has not rung for (and records them), `seedSeen` records them **without** ringing, and
  `takeNewOrdersOnRefresh` primes once per store per app session then rings. Both ring paths
  dedupe on order id, and both are gated on `shoofiAdminStore.storeData?.isUnviewOrdersEnabled`
  — the platform switch that owns the whole new-order ring.
- ⚠️ **Never seed that ledger on the badge-refresh path — it silences the alarm entirely.**
  The badge refresh, not the poll, is what learns about a new order first — and it does so
  through the **push**, not a websocket frame. At creation the server sends each store user a
  `store.wav` push (`utils/persistent-alerts.js` `sendPersistentAlert`, called from
  `sendStoreOwnerNotifications` in `routes/order.js`), and the app's
  `Notifications.addNotificationReceivedListener` (`hooks/use-notifications.ts`) calls
  `fetchUnviewedOrdersCount` for **every** notification the device receives while it is
  running. So the refresh runs within a second — a good 30s before the `*/30s` poll can look
  at the order. Anything that marks the order "alerted" there means the poll finds nothing new
  and the local `store.wav` alarm never plays; the store gets the incoming push plus one soft
  default-sound ping and nothing else. That is exactly what `de7daff` (2026-08-13) did by
  calling `seedSeen` here, and what shoofi-dev/shoofi-partner#22 (`adc0e85`, merged `70c1f89`)
  fixed with `takeNewOrdersOnRefresh` — prime once so a fresh login does not announce a
  backlog, ring on every refresh after that.
  **It is NOT `unviewed_orders_updated`.** That frame is emitted only on ACCEPT
  (`routes/order.js`, inside `sendOrderNotifications`, whose one caller is
  `/api/order/update/viewd`); `/api/order/create` emits no frame of that type. It lands on the
  same `fetchUnviewedOrdersCount`, which makes it easy to mistake for the creation trigger —
  it is not, and a fix reasoned from that frame will target the wrong path.
- **Key files**: `stores/orders/index.tsx` (core + transition logic),
  `screens/admin/order/new-orders/list/index.tsx` (ACCEPT + twin caps),
  `screens/admin/order/list/index.tsx` (dashboard, transitions), `hooks/{use-websocket,use-notifications}.ts`, `App.tsx`.
- **Gotcha**: no explicit REJECT endpoint — the accept screen is accept-only; rejection/cancel
  is a generic `order/update` to status `4`/`5` from the main list.

- **Customer note to the store** (CORE invariant 25): `order.order.commentToStore` arrives on
  the whole order documents the partner already reads (`admin/orders`, `admin/not-viewd`,
  `admin/all/not-viewd`), with no server projection change. Branch `feat/customer-note-to-store`
  (built in parallel, not on `main` as of 2026-11-10) shows it as «ملاحظة الزبون» on the order
  screens and on both printed tickets: the regular printer and the Urovo native printer. It is
  read-only. The partner's own `orders.note` (sent with `order/update`) is a different field.
  One reader: `helpers/order-customer-note.ts` `getCustomerNote` (strings only — a non-string
  must never reach a `<Text>`; it re-applies the server's `sanitizeCommentToStore` rules so old raw
  values look the same; a THIRD copy of the 200 cap next to server + app — keep them in step),
  rendered by `components/order-customer-note`: list v1/v2 (outside the collapsible part),
  new-orders v1/v2 (above the items), item details and the school list. Tickets print a stacked
  label + text box after the items, directly above the staff «ملاحظة:» line, `textAlign: "left"`
  (the printed RIGHT edge under forced RTL; never a label/value row — the partner#41 clipping).
  **Not yet on the v3 redesign** (`components/orders-v3/*`, only on the unmerged stack #47–#58):
  hook `OrderCardV3` / `NewOrderViewV3` to the same helper once that stack rebases.

## C4. shoofi-delivery-web — the ADMIN dashboard (React web)
Role: oversight — list/monitor, manual intervention, fraud queue, **twin group admin**, config.
- **API client**: axios (`src/utils/http-interceptor/index.ts`), **Bearer** token
  `@storage_userToken`, `app-type: shoofi-admin`, `app-name` per-call (store `appName`);
  401 → auto-refresh via `admin/users/refresh-token`. Base ends in `/api/`, so calls omit the leading `/api`.
- **Endpoints**: `order/admin/all-orders` (list/counts/fraud/pending), `order/update`
  (manual status/cancel/fraud-reject, stamped `updatedBySource:"shoofi_support"`),
  `order/update/viewd` (approve), `admin/order/delete/{id}`, `admin/impersonation/order-token`
  (open-as store/driver/customer, **master-only**), `admin/order-monitoring/summary/{orderNumber}`
  (timeline; every `admin/order-monitoring/*` route is `auth.required` +
  `checkAdminRole` with ALL admin roles — customer tokens 403, no token 401), `twin-order/admin/{group/:id/full, degrade, undo-degrade, cancel, assign-driver}`,
  `admin/twin-order-config` (GET/POST), `delivery/admin/{cancel,assign,reassign,drivers,orders}`,
  `order/admin/future-orders-count` (the sidebar badge; `app-name: shoofi` counts every store),
  `order/admin/coupon-orders` (`AppliedCoupons`, `generate-stores-summaries`),
  `order/statistics/new-orders/:page` (`HeaderStats`), `shoofiAdmin/external-order-providers`
  (`StoreForm`). These, plus `order/admin/all-orders`, take `ORDERS_DASHBOARD` (any
  `DASHBOARD_ROLES` seat, CORE invariant 18).
  Also the coins admin routes (CORE invariant 19, every dashboard role; `admin/coins/expire` is
  master-only):
  `admin/coins-settings` (GET/POST, `src/views/admin/settings/ShoofiSettings.tsx`, the platform
  on/off switch), `admin/store/{appName}/coins-settings` (GET/POST, `src/views/admin/stores/StoreForm.tsx`)
  and `admin/coins/customer/{id}/earned` (`src/apis/admin/customers/customer-details.ts`, the
  customer modal's coins tab). Nothing calls `admin/coins/expire`, `admin/coins/customer/{id}` or
  `admin/coins/store/{appName}/stats`.
- **Refunds**: `order/addRefund` no longer exists (removed 2026-11-03). Money is decided per
  CHARGE in the cancel dialog (`money/cancel`, keep/refund) and lives in the charge's
  `moneyLedger` / `moneySummary` (CORE invariant 28). The old `twin-order/admin/cancel` route
  records no amount on the group doc; its legs settle `undecided` through the ledger. Only a
  degrade writes `degrade.refundOwed`/`refundBreakdown`. Compensations:
  `shoofiAdmin/compensations/*`.
- **Cancel money (CORE invariant 28) — the admin side, shoofi-delivery-web#346:**
  - **A support cancel of one twin side leaves it `7`** (CANCELLED_BY_ADMIN), not `5`; the
    customer app's `twin-active-order-header.tsx` `getGroupStatus` checks the degraded pair before
    "any side cancelled" (shoofi-app#96), else order history would read "ההזמנה בוטלה".
  - **One cancel dialog** (`src/components/Modals/CancelMoneyDialog.tsx`, rules in
    `src/utils/cancel-dialog.ts`, calls in `src/apis/admin/money.ts`) for single orders and both
    twin cards: `money/cancel-preview` → scope choice (twin: this side / the other side by name /
    both, or only "remaining"), the server's amount + breakdown + coins/coupons returned, keep or
    refund (asked only when money is at stake — otherwise it sends `decision: "none"`), then
    `money/cancel`. **A 404 from cancel-preview
    (a server without `/api/money`) falls back to the old dialog** (`isMoneyApiMissing`).
  - **MoneyLine** (`src/components/MoneyLine.tsx`, `src/utils/money-summary.ts`) renders
    `order.moneySummary` on every order card / twin card / live-ops row; a twin leg shows its
    GROUP's line ("חלק מתשלום משולב"). No `moneySummary` → the legacy `charge-state.ts` badge.
  - **"חייבים ללקוח"** (`src/views/admin/money/MoneyOwed.tsx`, `/admin/money-owed`,
    `src/utils/money-owed.ts`): the owed queue (`money/owed`), record a portal refund
    (`money/record-refund`), resolve an in-doubt HYP refund (`money/resolve-unknown`). Finance =
    `MONEY_FINANCE_ROLES = ["master", "accountant"]` (`menu-access.ts`) — a NEW grant to
    `accountant` (Sari, 2026-11-06). **"החלף קופון להחזר"** (`MoneyFinanceModals.tsx`
    `ChangeDecisionModal` → `money/change-decision {to: "refund"}`) on a cancelled order / twin
    card with a keep coupon, finance + master only.
  - **Status dropdown** (`src/utils/cancel-money.ts` `statusChoicesFor` /
    `statusChangeNeedsCancelDialog`): an order with money at stake no longer offers the
    cancel/reject statuses there (they would be stamped `undecided` with nobody asked) — cancels go
    through "בטל הזמנה" and its dialog; "בטל הזמנה" is hidden on status 5.
  - **Undo guard** (`src/utils/twin-cancel.ts` `undoDegradeBlock`) mirrors the server's
    `undoDegradeBlockReason` and also reads `group.moneySummary` (a coupon, a refund or a refund in
    doubt since the degrade hides undo).
  - Monitoring: `admin/order-monitoring/summary` carries `moneySummary` (+ `orderObjectId`,
    `appName`) and `twin.group.moneySummary`; `analytics/deliveries` `storeOrder` carries
    `moneySummary`.
- **Twin admin auth**: every `twin-order/admin/*` action takes `TWIN_ADMIN_ROLES` (every
  dashboard seat but `accountant`; support works on `viewer`), `group/:id/full` and
  `GET admin/twin-order-config` any dashboard seat, `POST admin/twin-order-config` admin (+ master).
- **Cancel money UI (shoofi-delivery-web#346)**: `src/utils/cancel-money.ts` — the status
  dropdown hides the cancel/reject statuses on an order with money at stake (they would be
  stamped `undecided` with nobody asked); those cancels go through "בטל הזמנה", which asks keep
  or refund; "בטל הזמנה" is hidden on status 5. `src/utils/twin-cancel.ts` — `undoDegradeBlock`
  mirrors the server's `undoDegradeBlockReason` (hides undo with `UNDO_BLOCK_TEXT`), and the
  twin cancel/degrade confirms no longer promise an automatic refund or coupon.
  `src/utils/charge-state.ts` — an `undecided` cancel (and a `cancel_no_decision` flag) gets
  its own badge; an undecided cancelled twin leg names no per-leg amount.
- **Twin admin**: full lifecycle control (degrade / undo / cancel / assign single|split)
  + the twin-order-config screen (`degradeAutoRefund`, timeouts, enable switch).
- **State**: not centralized — component-local `useState`; MobX only for store open/close.
- **Key files**: `src/apis/admin/order/*`, `src/views/admin/orders.tsx`,
  `src/components/Cards/{CardOrder,CardTwinOrder}.tsx`,
  `src/components/Cards/order-actions/{useOrderActions,OrderActionsMenu}.tsx` — the per-order
  "⋯" actions (cancel + money decision, compensation, HYP re-charge, status update incl.
  approve-on-behalf with ready minutes, amend, master-only impersonation): handlers, gates and
  modals. Extracted from `CardOrder` so every admin screen runs the same actions — add an
  action there, not in a card,
  `src/views/admin/live-ops/` — the live-ops board (`/admin/live-ops`, feature-flagged):
  fraud review (`13`) and pending store approval (`6`, NOT `14` — that is an accepted future
  order) beside the delivery tasks; approve/reject/approve-on-behalf are sent after a 5 s
  undo window with the order card's payloads. Delivery rows show the STORE order's status
  from `storeOrder.status` (the `analytics/deliveries` join), labelled with
  `ORDER_STATUS_TEXT_HEBREW`; a "⚡ תאום" pill on both sides of a twin pair (orders:
  `twinGroup.{groupId,role,peerOrderId,pickupSequence}`; deliveries: `twinGroupId`,
  `twinPickupSequence`, `twinPeer.orderId`; none once degraded) opens the unchanged
  `TwinOrderCard` in an overlay, seeded with the whole order.
  **"מה מתקרב"** (`live-ops/components/Upcoming.tsx`, rules in `logic/upcoming.ts`) puts on
  the board the two kinds of order nothing else surfaces:
  - **future orders**: `isFutureOrder`, not in a terminal status, `orderDate` from today
    through 3 days, grouped by Israel day. Status `6` is awaiting the store. Status `14` is
    accepted, with prep at `startPreparingAt`; it becomes "prep due" once that has passed;
  - **school orders**: `isSchoolProject`; created as `1` with `isViewd:true`, so they skip
    every approval queue and the reminder / overdue / stuck crons. They are grouped by
    service day, then store → school → class.
  One cross-store read feeds it, `GET /api/admin/live-ops/upcoming` (shoofi-server
  `routes/admin/live-ops.js`, `services/live-ops/`, `docs/live-ops-upcoming.md`; any dashboard
  role; read-only over orders). Two server-stored ticks per store and service day,
  "store confirmed" and "courier dispatched", are written to `shoofi.liveOpsChecks` with who
  and when (`PUT …/school-checks`). School couriers are dispatched by hand, so the courier
  tick is a person's word. Thresholds are in `shoofi.liveOpsSettings` (`PUT …/settings`,
  master / admin / manager): school deadline 10:00 and T-90/45/30 before ready-by.
  ⚠️ **School service day is INFERRED**: `orderDate` when it is a later Israel day than
  `created`, else the day after `created`. `orderDate` on a school order comes from the
  client body and its meaning is unverified in production. Check with
  `db.orders.find({isSchoolProject:true}).sort({created:-1}).limit(20)`.
  `src/components/OrderMonitoring/OrderFlowDashboard.tsx`,
  `src/views/admin/settings/DeliverySettings.tsx`, `src/views/admin/fraud/FraudReview.tsx`.
- **The delivery address on admin surfaces** (§5 `orders.order.address`): `CardOrder`'s location
  modal ("⋯" → "הצג מיקום על המפה") renders `src/components/Cards/OrderAddressLines.tsx` — «שם
  הכתובת» (`order.order.address.name`; until 2026-11-10 it read a top-level `order.address.name`
  that never exists, so it never showed), «כתובת מלאה», then קומה / דירה / כניסה and «סימן דרך
  לשליח» (`notes`). The card's "פרטי משלוח" block shows «סימן דרך לשליח» beside the editable
  «הערות לשליח». The delivery board (`src/views/admin/analytics/DeliveryListAnalytics.tsx`) puts
  it on its own labelled line («סימן דרך:») in the «הערות לשליח» cell. One reader for all of them:
  `src/utils/order-address-details.ts` (trims, drops empty values, prefers the live order and
  falls back to the `bookDelivery.order` snapshot). Nothing renders for an empty value.
  ⚠️ The board reads it off `POST /api/analytics/deliveries`, whose `bookDelivery` projection
  (`routes/analytics.js`) is a whitelist: the line stays empty unless it lists
  `'order.order.address.notes'` — listed field by field with `floorNumber` / `apartmentNumber` /
  `entrance` since shoofi-server `feat/address-note-apartment-entrance` (2026-11-10), pinned by
  `test/integration/delivery-comment-to-courier-projection.js`; never the whole address. `CardOrder`
  is unaffected: `order/admin/all-orders` and `analytics/order/:id` return the whole order, and
  `delivery/order/:id` the whole booking (credentials redacted).
- **⚠️ Cross-repo consistency flags (candidate bugs — human verdict):**
  1. **Status-enum divergence** — admin-web `src/consts/shared.ts` uses
     `FUTURE_ORDER_PENDING:"16"` and `PENDING_START_PREPARING:"14"`, but the server &
     partner use `14`=FUTURE_ORDER_PENDING / `15`=RAMADAN. A wrong constant here mislabels
     or mis-transitions future orders. **Verify before trusting admin-side future-order logic.**
  2. **`admin/order/delete/{id}`** is called with **plain axios (no auth interceptor)** —
     confirm this is intended.

- **Customer note to the store** (CORE invariant 25), branch `feat/admin-customer-note-to-store`
  (built, not on `main` as of 2026-11-10):
  - **Reader:** `src/components/Cards/OrderStoreNote.tsx` reads `order.order.commentToStore`.
    `getCommentToStore` shows it only when it is a non-blank string, trimmed.
  - **Where it shows:** `CardOrder` renders it read-only right under the items, above
    «פרטי בית העסק», labelled «הערת הלקוח למסעדה», for any receipt method. Through that card it
    also reaches `/admin/orders`, `OrderDetailModal` (so the analytics screens), the live-ops
    order-details overlay and the twin card's per-side items.
  - **Where it does not show, on purpose:** the live-ops board rows/cards and
    `DeliveryListAnalytics`. Those are courier-dispatch views.
  - **No edit path and no `bookDelivery` mirror.** It is not «הערות לשליח» (`commentToCourier`),
    which is delivery-only and editable through `POST /api/order/comment-to-courier`.

## C5. shoofi-kopa — the store till back-office (web)
Kopa (repo `shoofi-kopa`) is the store's back-office web app. It calls the server like the
partner app: a partner token, `app-type: shoofi-partner`, the store in `app-name`. Its order
reads are three new read-only routes in shoofi-server `routes/kopa/orders.js` (logic in
`services/kopa/orders.js`, tests `test/integration/kopa/orders.js`), built on
`feat/kopa-phase1` (2026-11-11, not on `main` yet). Rules: CORE invariant 29.

- **Gate (all three):** `KOPA_REPORTS` (`services/kopa/access.js`) = `auth.required` +
  `requireStoreMembership()` + `requireStoreRole("reports", "all")` (an owner holding `all` without
  `reports` passes; 38 of 406 prod docs, 2026-11-11). The store is
  `req.storeMembership.appName`, never the raw header. No token → 401; a customer token → 403;
  a member of another store → 403; a non-`isAdmin` doc or one whose `roles` has neither `reports` nor `all` →
  403 `Insufficient role`. `storeUserHasRole` does not treat `all` as a superset, so
  `KOPA_REPORTS` lists `all` explicitly. The store-analytics routes do not, and those 38 owners
  still get 403 there. (Corrected 2026-11-11: this line used to say they get 403 here too.)
- **`POST /api/kopa/orders`** — body `{ from, to, page?, limit?, receiptMethod?, paymentMethod?,
  status?, productId? }`. `from`/`to` are real `YYYY-MM-DD` days, `from ≤ to`, at most 93 days
  (both ends counted), else 400. `limit` defaults to 50 and is clamped to 200. `status` is a
  status string, a bucket (`completed` | `cancelled` | `inProgress`) or an array of them, and
  must be in the listed set. The filters must be plain strings: an object is a 400.
  `productId` matches `order.items.item_id` or a combo component
  (`order.items.comboSelections.productId`).
  Response `{ message, from, to, window: {start, end}, orders, totalCount, page, limit, hasMore,
  summary }`. The summary is over the whole filtered range:
  `{ byPayment: { CASH, CREDITCARD, OTHER }, total, cancelled, inProgress: {count} }`.
  Each bucket is `{count, amount}`. Rows are an allowlist: `_id, orderId, status, created,
  orderDate, viewdAt, completedAt, cancelledAt, amount, orderPrice, originalOrderPrice, total,
  shippingPrice, customerDetails{name, phone}, order{items[{item_id, nameAR, nameHE, qty, price,
  selectedExtras, note, comboSelections?}], receipt_method, payment_method, commentToStore},
  appliedCoupon{discountAmount}, usedCoins{amount, shekelValue}, promotions{items, delivery},
  cancelReason, updatedByName, amendments[{at, byName, reason, previousTotal, newTotal, diff}],
  twinGroupId`. It makes two reads. The first is every match, with a 5-field projection
  (summary, count and the sort by the instant of `created`). The second is the page's
  `_id`s only, with `ORDER_PROJECTION`.
- **`GET /api/kopa/cancel-log?from=&to=`** — same range rules. Response `{ message, from, to,
  window, rows, totalCount, truncated }`, newest first, capped at 2000 rows. The rows are:
  - **order** rows: one per order in `CANCELLED_STATUSES` (`4,5,7,8,9`) in the window,
    `price = orderPrice`, `priceBasis: "order_price"`.
  - **item** rows: one per `amendments[].diff` entry with `change: "removed"`, on any listed
    order in the window, `qty = diff.from`.

  Every row carries `{ kind, orderId, _id, name, price, by, at, reason }`, plus `status`,
  `byRole` (`support|store|customer|driver|system`) and `orderCreated` (and `itemId`, `qty`,
  `priceBasis` on items). Where "who" comes from is CORE invariant 29.
- **`GET /api/kopa/stories`** — `shoofi.stories` that are not archived, with `storeAppName`
  = the store OR `link.appName` = the store. Prod 2026-11-11 had 154 stories: 141 with no
  `link` (legacy, `target` only) and 0 whose `link.appName` differs from `storeAppName`. So the
  scope is reliable: it is the owning store. Rows: `_id, storeAppName, isOwnStory, mediaType,
  media{uri}, thumbnail{uri}, durationMs, caption{ar, he}, link, publishedAt, expiresAt,
  isActive, state (draft|inactive|scheduled|expired|live), viewsCount`. Never `approval` (it
  names admins), `marketingItemId` or `cityAreas`. The `stories` TTL index deletes a story a
  day after `expiresAt`, so `expired` rows only last that long.

### Kopa till: phases 3, 4 and 6 (CORE invariant 30)
These routes write only Kopa collections (`services/kopa/store-data.js` `STORE`), never `orders`,
`products` or `categories`. They are built on `feat/kopa-phase1` (2026-11-11, uncommitted) and
are not yet mounted in `routes/kopa/index.js`. Gates are in `services/kopa/access.js`:
- `KOPA_TILL` is `cashier | all | reports`.
- `KOPA_OWNER` is `all`.
- Both put the store and the acting staff member (`req.storeMembership.me`) on the request.

Who acted is stored as `{ staffId, staffName }`. Errors are
`{ message, code }` (plus `productIds` / `comboIssues` / `orderId` / `tableIds` where named). A
`createIndex` is never awaited (`ensureIndexes`).

#### Kopa phase 3: cancellation reasons (`routes/kopa/reasons.js`)
- `GET /api/kopa/cancel-reasons?appliesTo=item|order&includeInactive=1` (`KOPA_TILL`): returns
  `{ message, reasons }`, active only by default, sorted by `order`. `appliesTo=item` also lists
  `both`.
- `POST` (`KOPA_OWNER`): body `{ nameAR?, nameHE? (one required, ≤ 80), appliesTo = "both",
  returnToStock = false, order = 0 (int 0-10000), active = true }`. Returns 201 `{ message,
  reason }`. At most 200 per store.
- `PATCH /:id` (`KOPA_OWNER`): partial. `DELETE /:id` (`KOPA_OWNER`): soft, `active: false`.
  Both return `{ message, reason }` and 404 on an unknown id.

#### Kopa phase 4: tables (`routes/kopa/tables.js`)
- **Collections.** `kopaTables` holds `{ number (int 1-99999, unique per store), seats,
  sectionId (string | null), visible, layout: { x, y, w, h, shape: square|circle|rect, rotation } }`.
  `kopaTableSections` holds sections `{ nameAR, nameHE, order }` and ONE layout doc
  `{ _id: "floorLayout", walls: [{ x1, y1, x2, y2 }], canvas: { orientation:
  landscape|portrait } }`. Every section query excludes the layout doc.
- `GET /api/kopa/tables` (`KOPA_TILL`): returns `{ message, tables, sections, layout: { walls,
  canvas, updatedAt } }`. Every table is listed, hidden ones too. Each carries `status:
  "free" | "occupied"` and `occupiedBy: { orderId, number, total, balance, createdAt } | null`
  (an OPEN till order on it).
- `POST /api/kopa/tables`, `PATCH` / `DELETE /api/kopa/tables/:id` (`KOPA_OWNER`).
  - A duplicate number is 409 `TABLE_NUMBER_TAKEN`.
  - PATCH merges a partial `layout` over the stored one.
  - Hiding or deleting a table with an open order is 409 `TABLE_OCCUPIED`.
  - Delete is a hard delete. A till order keeps its own `tableNumber`.
- `PUT /api/kopa/tables/layout` (`KOPA_OWNER`): body `{ tables: [{ id, layout }], walls,
  canvas: { orientation } }`.
  - Validation is all-or-nothing: an unknown id is 400 with `tableIds`, and nothing is written.
  - The positions are bulk-written, and the walls and canvas are upserted onto `floorLayout`.
  - Returns the GET shape.
- `GET` / `POST /api/kopa/table-sections`, `PATCH` / `DELETE /api/kopa/table-sections/:id`
  (read `KOPA_TILL`, write `KOPA_OWNER`). Deleting a section a table uses is 409
  `SECTION_IN_USE`.

#### Kopa phase 4: till orders (`routes/kopa/till-orders.js`, all `KOPA_TILL`)
- **Document (`kopaTillOrders`).**
  - Header fields: `{ number (nextSeq "tillOrder", gapless), status: open|paid|cancelled,
    receiptMethod: TABLE|TAKEAWAY|DELIVERY, tableId, tableNumber, customer: { name, phone,
    profileId? } | null, staffId, staffName, waiterId, waiterName, isStaffMeal`.
  - Lines and money: `items, subtotal, total, amountDue, payments, paidAmount, balance, unpaid,
    unpaidAt, cancel, createdAt, updatedAt, closedAt, rev }`.
  - Phase 4d adds `discount?`, `discountLog?`, `tip?`, `refunds?` and `refundedAmount?`, and
    `refundedQty` / `refunded` on a line. They are written by `services/kopa/till-money.js`;
    shapes and rules are in payments reference §6b.
  - A line is `{ lineId, productId | null, nameAR, nameHE, qty (1-999), unitPrice, lineTotal,
    selectedExtras, comboSelections?, note, kitchenIds, status: new|preparing|ready|served|cancelled,
    statusTimes, addedAt, addedBy, cancel? }`.
  - A payment is `{ paymentId, method, amount, tendered?, change?, clientPaymentId?, staffId,
    staffName, at }`.
- `POST /api/kopa/till/orders`: body `{ receiptMethod, tableId?, customer?, waiterId?,
  isStaffMeal?, items? }`. Returns 201 `{ message, order }`.
  - TAKEAWAY and DELIVERY need `customer.name` + `phone`.
  - TABLE needs a visible table with no open order. Otherwise 409 `TABLE_OCCUPIED` with
    `orderId`.
  - `waiterId` must be a `storeUsers` doc of this store.
  - An item is `{ productId, qty, selectedExtras, comboSelections?, note }` or
    `{ productId: null, nameAR, nameHE?, price, qty, note }`.
- `GET /api/kopa/till/orders?status=&from=&to=&tableId=&unpaid=1&limit=` returns `{ message,
  orders, totalCount }`, newest first.
  - `from` / `to` are a `YYYY-MM-DD` Israel day or an ISO time, on `createdAt`, ≤ 93 days.
  - `limit` defaults to 100, max 500.
- `GET /api/kopa/till/orders/:id` returns `{ message, order }`, or 404.
- `POST /:id/items` takes `{ items }`. `PATCH /:id/items/:lineId` takes `{ qty?, note? }` and
  works only while the line is `new`, else 409 `LINE_NOT_EDITABLE`.
  `POST /:id/items/:lineId/cancel` takes `{ reasonId }` (an item reason). Each returns
  `{ message, order }`.
- `POST /:id/cancel` takes `{ reasonId }` (an order reason). It is 409 `PAYMENT_RECORDED` once
  any payment exists.
- `POST /:id/move` takes `{ tableId }`. It works on TABLE orders only, to a free visible
  table.
- `POST /:id/payments` takes `{ method, amount, tendered?, clientPaymentId? }`.
  - It returns 201 `{ message, order, payment, replay: false }`.
  - A repeated `clientPaymentId` returns 200 with the original payment and `replay: true`.
    This holds after the order is paid too. The same id with another method or amount is
    409 `CLIENT_PAYMENT_ID_REUSED`.
  - The order is paid when the payments reach `amountDue` (total + tip).

  Refusals:
  - 409 `OVERPAY` (amount > balance, tip included);
  - 400 `TENDERED_TOO_LOW`;
  - 409 `ALREADY_UNPAID`;
  - 409 `CONFLICT` (another device wrote first);
  - 409 `ORDER_NOT_OPEN`.

  `amount: 0` closes a zero-balance order that has live lines (a staff meal).

#### Kopa phase 4: kitchen screen (`routes/kopa/kds.js`, `KOPA_TILL`)
- `GET /api/kopa/kds?kitchenId=&receiptMethod=` returns `{ message, tickets: [{ orderId,
  number, receiptMethod, tableId, tableNumber, customerName, isStaffMeal, createdAt,
  waitingSince, lines: [{ lineId, productId, nameAR, nameHE, qty, selectedExtras,
  comboSelections, note, kitchenIds, status, statusTimes, addedAt }] }], lineCount }`.
  - Only lines of open orders that are not served or cancelled are shown.
  - Tickets are sorted oldest waiting line first. No prices or payments are returned.
  - `kitchenId` is matched lowercased. A line with no kitchen shows only with no `kitchenId`
    (or `all`).
- `PATCH /api/kopa/kds/:orderId/lines/:lineId` takes `{ status: preparing|ready|served }`. It
  moves forward only, else 409 `NOT_FORWARD`. Returns `{ message, orderId, line }`.

#### Kopa phase 6: store settings (`routes/kopa/settings.js`, `KOPA_OWNER`)
- `GET /api/kopa/settings` returns `{ message, settings: { wifi: { ssid, password }, guestWifi,
  gateway, externalIp, receipts: { enabled }, updatedAt, updatedBy } }`, with defaults when
  nothing has been saved.
- `PUT /api/kopa/settings` is a partial update of `{ wifi?, guestWifi?, gateway?, externalIp? }`.
  - SSID ≤ 32 characters, password ≤ 63.
  - `gateway` / `externalIp` take an IPv4 or IPv6 address, or `""`.
  - Unknown keys are 400 `UNKNOWN_FIELD`.
  - A `receipts` value other than the stored one is 400 `RECEIPTS_LOCKED`.

## Cross-repo invariants (the whole-domain view)
- **Status source of truth = server** (store `orders.status`). Clients each keep their
  own `ORDER_STATUS` copy in `consts/shared.ts` — they must stay in sync with
  `shoofi-server/consts/consts.js`. The **admin-web copy has already drifted** (above).
  A change to statuses is a **multi-repo PR** touching every client's constants.
- **Driver app speaks `DELIVERY_STATUS`** (bookDelivery), everyone else speaks
  `ORDER_STATUS`; nothing bridges them — delivery progress lives only on `bookDelivery`.
  Don't cross the wires.
- **ACCEPT is `order/update/viewd`** (partner + admin); generic transitions are `order/update`.
- Every client sends `app-name` (tenant) + its own `app-type`; the server branches on `app-type`.

## 11. Definition of done
Inherit `_shared-guardrails.md` §7 fully. For orders specifically:
- Prefer the `investigate-order` skill for read/diagnosis tasks.
- Any change near a transition: state which statuses can reach/leave the code path,
  and confirm you did not weaken a §2 guard.
- Never claim smoke passed without infra. Report what you verified, and every
  guardrail boundary where you stopped and proposed rather than edited.
