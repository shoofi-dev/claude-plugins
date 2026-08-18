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

## Where an order that never happened lives
**There is no server-side cart.** The cart is MobX + AsyncStorage in
`shoofi-app/stores/cart/index.ts` and nothing about it reaches the server until submit, so
"the customer built a cart and left" exists ONLY as events in central **`shoofi.apps-logs`**
(written by `routes/app-logs.js`). Three layers answer "abandoned", an order of magnitude
apart — always establish which is meant:

1. **Blocked before submit** — `checkout_validation_failed`, `properties.step` ∈
   {`store_closed`, `store_closed_select_time`, `shipping_method_invalid`, `address_invalid`,
   `payment_method_invalid`, `car_details_missing`, `future_order_date_missing`}, from
   `shoofi-app/hooks/checkout/use-checkout-validate.ts`. **"Store closed" and "no delivery
   available" create NO order document at all** — this is their only record anywhere. The
   top-level failure in `screens/checkout/index.tsx` sends no `step`, so ~half the rows have
   none; bucket them rather than dropping them.
2. **Submitted and never paid** — status `"0"` order rows, per store DB. See the
   `FAILED_PAYMENT_STATUS` note; that is the only layer carrying an issuer reason.
3. **Never reached checkout** — `page_viewed` with `properties.page_name` ∈
   {`ProductAddToCart`, `Cart`} and no `order_submit_success`. Add-to-cart uses
   `trackPageView`, not `trackEvent`, so it is a `page_viewed` row and easy to miss.

Traps that cost a day if you meet them cold:
- **`apps-logs.created` is a real BSON `Date`** — the exact opposite of `orders.created`. One
  query cannot span both, and mixing them matches nothing and raises nothing.
- **The only indexes are `_id` and `{userId, created}`.** A match on `created` alone is a full
  scan of a ~4.6 GB collection. Bound `_id` instead (`ObjectId.createFromTime`, widened by a
  minute and re-filtered on `created`) — index-covered, and roughly 50× faster.
- **No TTL and no retention job**, so history is complete back to the first event on
  **2026-02-06**. Anything earlier is *no data*, not zero — report it as null.
- **No `appName` field on the document**, so a per-store split is impossible from this data.
  `app_type` is always `"shoofi-shopping"`: the partner and driver apps do not log at all.
- **The launch event is not a usable "app open".** `ota_check_started` (`trigger: "launch"`,
  `shoofi-app/hooks/useOTAUpdates.ts`) fires before `userDetailsStore` hydrates, so ~99% of
  launch rows carry `userId: null`, and it only exists from 2026-07-29.
- **"Did they actually use it?" = did the device-day emit anything that is NOT `ota_*`.** The
  OTA hook is the only writer in the client that is not a user action (it fires on mount and
  on an `AppState` resume, then emits its check/download consequences). There is no background
  execution path at all — no registered task, no headless JS, no silent-push handler, and the
  server never sends `content-available` — so nothing runs while the app is away, and an
  `ota_*`-only device-day is "came to the front, nothing was looked at". Note `page_viewed` is
  NOT a clean "a screen rendered" proxy: `StoreSelectAuto` fires during boot with no screen,
  `ProductAddToCart` is a button press, and `Menu1`/`Menu2` sit outside their `isFocused`
  guard so they fire on blur too (`shoofi-app/screens/menu/menu.tsx`).
- **`user_visit_id` IS a stable identity** — the `device-id` header, generated once into
  AsyncStorage and **not cleared on logout** — measured at 97.9% one device per customer. Do
  not confuse it with `orders.deviceId`, which prefers the per-order `unique_hash` and churns
  every order.
- **⚠️ `userId: null` does NOT mean "logged out"** — it means *we did not learn who this was*.
  `userDetailsStore.userDetails` is in-memory only and filled by a network round-trip, so a
  fully signed-in customer emits `userId: null` for a whole session in three cases: events
  fired before that call returns; a token-hydration race where `authStore.isLoggedIn()` is
  still false when `App.tsx`'s `prepare()` tests it, so `getUserDetails()` is never called at
  all for that run; and a failed or timed-out call, which is **never retried**. So any
  "anonymous" figure is an **upper bound**, and must be labelled in devices or sessions rather
  than people. Resolve identity across the whole (device × business day) — if any event that
  day carried a `userId`, the day is that customer — which drops measured anonymity from ~99%
  on the launch event to ~12%. Keep it as a SET: a device can carry two customers in a day.
- **Impersonation is invisible in this data.** A `master` operator can drive the app as a
  customer (`shoofi-app/stores/auth/impersonation.ts`) and `trackEvent` sends no impersonation
  marker, so those sessions are indistinguishable from the real customer's and inflate any
  unique-user count.
- **`POST /api/app-logs/insert` is unauthenticated and takes `userId` from the body.** A
  product metric, never an auditable one.
- Logging is killable per store via `isAppLogsEnabled`, and the collection handle is bound to
  `db.driversBonuses` by `DatabaseInitializationService` — always use
  `db.collection('apps-logs')` explicitly.

Worked example: `services/exec-dashboard/engagement-metrics.js`.

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
