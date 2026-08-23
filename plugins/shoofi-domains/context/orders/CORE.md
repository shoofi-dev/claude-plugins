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

## Known status (human-confirmed — do NOT "fix")
- **BY DESIGN:** `verifiedAppName` in `routes/order.js` is a pass-through; the multi-tenant
  cross-check is intentionally disabled. Leave it.
- **BY DESIGN:** fraud **rejection** is intentionally off — risky orders route to
  FRAUD_REVIEW(`13`) for manual handling. Do not enable hard-blocking.
- **Awareness (not bugs):** coins-redeem-after-charge failure logs CRITICAL for manual
  reconciliation; HYP "verified=false but paid" is logged paid-but-stuck; background work in
  store-accept runs after the 200 response so failures never reach the client.

## Recipe — add a field to an order, end-to-end
**There are two independent order-creation paths and the twin one drops anything you don't
name.** Every step below has a place where a missing line fails *silently* — the order is
created, nothing errors, and the value is simply gone.

1. **Customer app — TWO places, not one.**
   - `hooks/checkout/use-checkout-submit.ts`: the `TPropsCheckoutSubmit` type + the block for
     the relevant shipping method, and every `checkoutSubmitOrder` call site in
     `screens/checkout/index.tsx` (there are **three** — the ZCredit Apple Pay pre-create, the
     main submit, and the HYP wallet sheet; missing one loses the field for that payment
     method only).
   - `stores/cart` `getCartData`: it builds `finalOrder` **field by field, with no spread of
     the caller's object**. A field set in the submit hook and not named here is dropped on
     the floor for every single-store order while the UI keeps working perfectly.
   - If the field must survive tapping a twin store, add it to `saveCheckoutSnapshot` /
     restore and to `TwinCheckoutSnapshot` in `stores/twin-order`.
2. **Server — TWO routes.**
   - `POST /api/order/create` (`routes/order.js`): `orderDoc` is `{...parsedBodey}` with a
     nested `order: {...parsedBodey.order}`, so an unknown field arrives **automatically** and
     with **no validation of any kind** (there is no Joi/celebrate/express-validator in this
     repo). Name it explicitly anyway so the contract is greppable, and sanitize it — for
     unbounded customer text, clamp server-side and `delete` the raw value off `parsedBodey`
     first, or the spread re-adds it behind your back.
   - `POST /api/twin-order/place` and `/api/twin-order/digital-place-pending`
     (`routes/twin-order.js`): these **never touch `/api/order/create`**. `buildSkeletonOrder`
     is a hard-coded destructured parameter list producing a hard-coded `orderDoc` whose
     nested `order` carries only `items`, `payment_method`, `receipt_method`, `address`,
     `geo_positioning`. Anything else is **silently absent**. Add it to the builder and to all
     **four** call sites (two per route, one per leg), and to both `sidePayloadShared` builders
     in the checkout screen. Failure mode: works everywhere, missing only on twin orders.
   - Decide explicitly whether it also belongs in the `customers.orders[]` snapshot (usually
     **no** — the snapshot is deliberately minimal and never updated).
   - If support must be able to edit it later, note that `ALLOWED_ORDER_UPDATE_FIELDS` is a
     **top-level key whitelist** and cannot express a nested `order.<field>` path. Widening it
     means adding `"order"`, which `test/integration/order-update-whitelist.js` explicitly
     forbids (it would let any caller overwrite `order.items`). A nested field therefore needs
     its **own endpoint**, not an entry in that Set. `/api/order/update` also drops unknown
     keys with only a `console.warn` and still returns **200**, so a wrong guess here fails
     silently.
   - ⚠️ **An editable field must be edited on BOTH twin legs.** The twin trap is not only a
     write-time problem — it bites again on every later mutation. A twin basket is two order
     documents, and `shoofi-shoofir/components/delivery-driver/TwinOrderCard.tsx` renders the
     value as `primary || secondary`. So a support tool that edits one leg leaves the *other*
     leg's stale value on the courier's screen, and the agent is told it succeeded. For a
     field whose whole point is correcting or removing something (an abusive note, a phoned-in
     correction) that is the failure the tool existed to prevent. Resolve the peer through
     **`shoofi.twinOrderGroups`** (`services/twin-order/twin-group-service.js: getGroup`) — it
     is the only source carrying the peer's `orderObjectId` **and** `appName`.
     `order.twinGroup.peerOrderId` is the **display** id and cannot safely address a document:
     `generateUniqueOrderId` (`routes/order.js`) builds it from timestamp+random and then keeps
     only 2 of its 3 segments, with **no uniqueness index** behind it. The same rule applies to
     any join into `delivery-company.bookDelivery`, which is **one collection spanning every
     tenant** — matching on `bookId` alone can hit another store's delivery. Join on the
     ObjectId; use `bookId` only paired with `appName`. Report an unresolvable peer; never
     guess.
3. **Consumers** — partner display, driver app, admin monitoring, as needed. **The driver app
   and the support delivery board both read through an explicit projection whitelist**
   (`routes/delivery/orders.js`, `routes/analytics.js`) — see `delivery/CORE.md` invariant 10.
   The admin order-detail modal is unprojected, so it will show your field while those two show
   nothing; do not take the modal working as proof the field shipped.
4. **Copy** — app/driver translations are **DB-backed** (`GET /api/getTranslations` → central
   `shoofi.translations`); `translations/languages/*.json` in the repos are vestigial. A key
   with no row renders as the raw key string. **he + ar only, default ar — there is no
   English**, so a single i18next `defaultValue` shows the wrong language to half the users.
   Resolve the fallback per language and pass it as the default. `shoofi-delivery-web` has no
   i18n at all — hardcoded Hebrew.
5. **Verify** — `npm run lint` (0 errors), `npm run routes:check` if routes moved, tests via
   the `shoofi-testing` cover-changes skill. **One PR per repo**, cross-linked.

## Definition of done
Inherit `_shared-guardrails.md` §7. Here specifically: for any change near a transition,
state which statuses can reach/leave the path and confirm you didn't weaken a guard; prefer
the `investigate-order` skill for diagnosis; never claim `smoke` passed without infra; fix
the doc + `context/assert/orders.assert.json` in the same PR if you find drift.
