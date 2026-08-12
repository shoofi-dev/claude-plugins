---
domain: orders
last-verified: shoofi-server@561e3ca / 2026-07-28
scope: full-stack (shoofi-server + app + partner + shoofir + delivery-web)
reference: ./reference.md   # data model, endpoint tables, flows, per-repo client detail
---

# Orders — CORE (always read)

The money/identity spine: order creation, the status lifecycle, twin orders, tracking.
Read `reference.md` when you need the endpoint tables, the full data model, or the
per-repo client sections.

## Scope
**Yours:** order creation, status transitions, twin orders, order reads/admin/monitoring,
customer order history, order crons, and the order-side wiring of secondary features
(coins, world-cup, attribution, coupon usage).
Server: `routes/order.js`, `routes/twin-order.js`, `routes/order-fraud-*.js`,
`routes/admin/order-monitoring.js`, `services/twin-order/*`, `utils/order-stock.js`,
order crons. Clients: checkout+tracking (app), accept/prepare (partner), pickup/deliver
(shoofir), monitoring/twin-admin (delivery-web).

**Not yours:** payment internals (`payments`), settlement/payouts (`accountant`), driver
assignment & areas (`delivery`), auth (`customers`). Hand off in the PR.

## ⚠️ HIGH-RISK — draft PR, flagged, never merge
Order creation (`processCreditCardPayment`/`processHypTokenPayment`/`finalizeApplePayOrder`
paths in `routes/order.js`), **any status-transition code**, and twin place/pay/cancel/degrade.
You may change them: minimal diff, extra tests, a "what could break" section, rollback note.
Payments/invoicing files stay off-limits — describe the fix and hand off.

## Invariants — never weaken
1. **Status source of truth is the server** — `ORDER_STATUS` in `consts/consts.js`
   (`1` in-progress … `6` pending … `13` fraud-review, `14` future, `15` ramadan; completed
   bucket `2,3,10,11,12`, cancelled `4,5,7,8,9`). Each client repo keeps its **own copy** in
   `consts/shared.ts` — a status change is a **multi-repo PR**.
2. **Transition guards:** PENDING(`6`) only from FRAUD_REVIEW; store-accept rejects
   already-cancelled; `start-preparing` only from `14`. **ACCEPT is `order/update/viewd`**,
   not `order/update`.
3. **Stock idempotency:** `decrementOrderStock`/`restoreOrderStock` gated on
   `stockDecremented && !stockRestored` + `store.isStockManagment`. Decrement **only** on
   confirmation — a failed charge must never consume stock.
4. **Payment idempotency:** Apple Pay finalize is an atomic `findOneAndUpdate({status:"0"})`;
   the ZCredit callback can arrive **before** the order exists (self-heal path). Twin = one
   combined capture.
5. **`customers.orders[]` is a create-time snapshot with NO status.** Never infer
   completion/revenue from it — join the store `orders` collection. Reuse
   `getSuccessfulOrdersByCustomerIds` (`utils/customer-orders.js`). See `docs/customer-orders-snapshot.md`.
6. **Secondary never breaks primary** — coins, world-cup, attribution, notifications are
   try/caught and swallowed. Never let one throw into the order path.
7. **Multi-tenant:** orders live in the **store** DB (`getOrInitializeDb(app-name)`);
   **customers are central** (`shoofi`). Don't cross them.
8. **Twin peers** are mutated by `services/twin-order/*` directly, never via
   `/api/order/update` (recursion).
9. **`isFutureOrder`/`isRamadanIftar` are written only when TRUE — never `false`.** Both come
   from one client-side `orderTimingMode` (`shoofi-app/screens/checkout/index.tsx`) and are
   attached conditionally in `submitOrder` (`shoofi-app/stores/cart/index.ts`), so on a
   same-day order the fields are **absent**, not `false`. They are **mutually exclusive** — a
   ramadan-iftar order can be up to `MAX_RAMADAN_DAYS_AHEAD` = 3 days ahead
   (`shoofi-app/components/checkout/FutureOrderPicker.tsx`) and never carries `isFutureOrder`.
   "Is this order for a later day?" must therefore test **both**, **truthily** — as the server
   does (`routes/order.js`: `$or: [{isFutureOrder:{$ne:true}},{isFutureOrder:{$exists:false}}]`).
   Testing `isFutureOrder` alone silently misses every ramadan order.

10. **`order.order.receipt_method` is client-written, unvalidated, and there is no
    `PICKUP`.** The set is `DELIVERY` | `TAKEAWAY` | `DRIVEIN` (**no underscore**) | `TABLE`,
    declared per repo in `consts/shared.ts` `SHIPPING_METHODS` — `shoofi-shoofir` and
    `shoofi-delivery-web` omit `driveIn`, the same drift as `ORDER_STATUS`. `routes/order.js`
    spreads `...parsedBodey.order` straight into `orderDoc.order`, so the server **never
    normalises, uppercases or whitelists** it; the only server-side write is
    `twin-order.js` (`receipt_method: receiptMethod || 'DELIVERY'`). **`TAKEAWAY` is the one
    and only self-collection method** — a literal `"PICKUP"` is written by no client and
    stored on no order. `PICKUP`/`PICKED_UP` here means the **driver collecting from the
    restaurant** (`ORDER_STATUS.PICKED_UP = "10"`, `consts/consts.js`), which is how it keeps
    getting mistaken for one. So anything grouping by receipt method must tolerate an unknown
    key and must **not** offer a pickup bucket. Both mistakes have shipped: the growth
    dashboard carried a `PICKUP: "איסוף עצמי"` slice that could never receive a count
    (`shoofi-delivery-web/src/views/admin/growth/RevenueAnalytics.tsx`, removed on branch
    `feat/growth-receipt-breakdown-readable`), and `routes/analytics.js` **still** matches
    `"DRIVE_IN"` with an underscore, so the store-stats `driveInOrders` it reports is
    permanently 0 for every store.

## Known status (human-confirmed — do NOT "fix")
- **BY DESIGN:** `verifiedAppName` in `routes/order.js` is a pass-through; the multi-tenant
  cross-check is intentionally disabled. Leave it.
- **BY DESIGN:** fraud **rejection** is intentionally off — risky orders route to
  FRAUD_REVIEW(`13`) for manual handling. Do not enable hard-blocking.
- **Awareness (not bugs):** coins-redeem-after-charge failure logs CRITICAL for manual
  reconciliation; HYP "verified=false but paid" is logged paid-but-stuck; background work in
  store-accept runs after the 200 response so failures never reach the client.

## Recipe — add a field to an order, end-to-end
1. **Customer app** — add it where the cart payload is built (`stores/cart` `getCartData`).
2. **Server** — accept it in the `orderDoc` build inside `POST /api/order/create`. Decide
   explicitly whether it also belongs in the `customers.orders[]` snapshot (usually **no** —
   the snapshot is deliberately minimal and never updated).
3. **Consumers** — partner display, driver app, admin monitoring, as needed.
4. **Verify** — `npm run lint` (0 errors), `npm run routes:check` if routes moved, tests via
   the `shoofi-testing` cover-changes skill. **One PR per repo**, cross-linked.

## Definition of done
Inherit `_shared-guardrails.md` §7. Here specifically: for any change near a transition,
state which statuses can reach/leave the path and confirm you didn't weaken a guard; prefer
the `investigate-order` skill for diagnosis; never claim `smoke` passed without infra; fix
the doc + `context/assert/orders.assert.json` in the same PR if you find drift.
