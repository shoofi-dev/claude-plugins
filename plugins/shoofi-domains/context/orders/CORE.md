---
domain: orders
last-verified: shoofi-server@a0e8bdb2 / 2026-09-23
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
`utils/order-pricing.js` + `utils/order-pricing-shadow.js`, `routes/order-amend.js`,
order crons. Docs: `docs/combo-deals.md` (the order-line half). Clients: checkout+tracking (app), accept/prepare (partner), pickup/deliver
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
10. **A store delay ACCUMULATES the live fields and freezes the originals ONCE — and
    `delayMinutes` is never a running total.** `POST /api/order/update-delay`
    (`routes/order.js`) writes three preserve-once fields (`order.originalOrderDate`, and on the
    `bookDelivery` row `originalPickupTime` + `originalExpectedDeliveryAt`, each written as
    `existing || current`) beside three that accumulate (`orderDate`, `pickupTime`,
    `expectedDeliveryAt`). `delayMinutes` on **both** documents is overwritten with the LAST
    declared delay: after 10 then 10 it reads `10`, not `20`. Total accumulated delay is only
    recoverable by diffing an original against its live twin — anything summing `delayMinutes`
    is wrong on every twice-delayed order.
    Two consequences that have already caused bugs, both in reporting rather than here:
    (a) `pickupTime` is deliberately **not** wrapped at 24, so `"24:05"` is a real stored value
    and a `HH:mm` parser that rejects it discards the row; (b) a promise and a pickup clock must
    be compared **within the same era** — the frozen promise against the frozen clock, or the
    live against the live. Mixing them makes a zero-minute ETA sentinel
    (`services/delivery/late-delivery.js`) look like a genuine promise and vice versa, which is
    exactly what `originalExpectedDeliveryAt` exists to prevent. Delivery owns the reading rule;
    orders owns the fields, and this is the contract between them.

11. **Line pricing has ONE server reference and two client copies that must stay in lockstep:**
    `utils/order-pricing.js` `calculateExtrasPrice(extras, selections, { soldByWeight })` is a
    port of `shoofi-app/stores/extras/index.ts` and `shoofi-partner/stores/extras/index.ts`.
    The weight extra prices as the delta from `defaultValue` when the product has
    `soldByWeight === true` (`calculateItemUnitPrice` reads the flag off the product loaded by
    `loadPricedProducts`, which must keep returning it) or when the weight is the only
    non-header extra; otherwise as an add-on with the first step bundled. Creation charges
    the client total and only **shadow-compares** (`utils/order-pricing-shadow.js` →
    `order.serverPricing.driftDetected`); **amend** (`routes/order-amend.js` `repriceOrder`)
    is server-authoritative through `calculateOrderPricing`. **Combo lines add a fourth
    function to the same lockstep:** `calculateComboExtrasPrice(comboProduct, item, components)`
    (`utils/order-pricing.js`) is a port of `shoofi-app/helpers/combo-pricing.ts`
    (`calculateComboX`) and its `shoofi-partner` twin, and `loadPricedProducts` must keep
    loading every `item_id` ∪ every `comboSelections[].productId` in ONE find with NO projection
    — the combo needs `productType` + `combo`, its components need `extras` + `soldByWeight`.
    Change one copy, change all three (both functions), and extend
    `test/integration/order-pricing-parity.js` (it has a "Combo deals" section). Catalog side
    of the same rule: menu-catalog CORE invariants 7 and 9; `docs/sold-by-weight.md`,
    `docs/combo-deals.md`.
12. **A COMBO IS ONE ORDER LINE** (`docs/combo-deals.md`). `item_id` = the combo product,
    every existing item field unchanged, plus
    `comboSelections[{ sectionId, slot, productId, nameAR, nameHE, surcharge, selectedExtras, extrasPrice }]`.
    The server reads ONLY `sectionId`, `productId` and `selectedExtras`; the rest are display
    snapshots for tickets.
    - **Catalog surcharge only.** A pick's money is the CATALOG `option.surcharge`
      (`Number(option.surcharge)` off the combo's own section) plus the COMPONENT's own extras
      definition priced against `sel.selectedExtras`. `sel.surcharge` and `sel.extrasPrice`
      are never charged — the same "item.price is the untrusted input" rule as every line.
      X (surcharges + nested extras + combo-level extras) takes the place of a plain product's
      extras: `price = discounted(combo.price) + (d > 0 ? Math.round(X × (1 − d/100)) : X)`,
      `originalPrice = baseOriginal + X` undiscounted (the existing asymmetry). The client's
      "you save ₪N" is display only and never reaches the server.
    - **Issues are recorded at create and refused at amend.** The pricer never throws: a pick
      the catalogue cannot price is priced as far as it can be and recorded —
      `COMBO_SELECTION_NOT_IN_SECTION` (ignored for the price), `COMBO_COMPONENT_MISSING`
      (surcharge still charged, nested extras unknown), `COMBO_SLOT_COUNT_MISMATCH
      { expected, got }` — on the line (`item.comboIssues`) and top-level (`comboIssues[]` with
      `itemIndex`/`item_id`). Creation persists them as `serverPricing.comboIssues` and
      suppresses `driftDetected` ONLY for `COMBO_COMPONENT_MISSING` (a data gap, like
      `missingProductIds`); the other two mean the client priced a different deal than the
      catalogue describes and ARE drift. Amend has no client number to fall back on, so any
      `comboIssues` after `repriceOrder` is `409 COMBO_SELECTION_INVALID` — the same posture as
      `PRODUCT_NOT_FOUND`.
    - **Stock is symmetric by construction.** `expandStockLines(items)` (`utils/order-stock.js`)
      turns a line into `item_id × qty` PLUS every `comboSelections[].productId × qty`,
      aggregated (a burger in two slots of a combo ordered twice moves four burgers).
      Decrement, restore and the amend delta (`applyStockDelta`, `minQty: 0`) all go through
      it — whatever confirm took is exactly what cancel gives back. A component at 0 disables
      the component only; the combo document is never touched (the menu snapshot carries
      `isInStore`). Invariant 3's gates are unchanged.
    - **Amend is qty/remove only (phase 1).** A change carrying `selectedExtras` or
      `comboSelections` for a combo line is `400 COMBO_EXTRAS_NOT_AMENDABLE` (`indexes` names
      them); `comboSelections` ride along untouched and are never diffed; `comboIssues` is
      stripped with the other bookkeeping fields before `order.items` is written, so the
      persisted item shape never carries it.

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
   top-level failure in `screens/checkout/index.tsx` sends no `step`, but it is a
   **duplicate**: it fires after the stepped event for the same press, so ~half the rows have
   no step. Count reasons from the stepped rows only; the step-less row adds a price snapshot,
   not a reason (verified 2026-09-24: 158 of 168 blocked sessions had both).
   `payment_method_invalid` is mostly friction, not loss — until 2026-09 checkout started
   with NO payment method and forgot the choice on remount, so ~94% of those customers picked
   one and ordered within 30 min. Checkout now remembers and pre-selects it (see the
   checkout draft below); the cash default is still commented out, on purpose.
2. **Submitted and never paid** — status `"0"` order rows, per store DB. See the
   `FAILED_PAYMENT_STATUS` note; that is the only layer carrying an issuer reason.
3. **Never reached checkout** — `page_viewed` with `properties.page_name` ∈
   {`ProductAddToCart`, `Cart`} and no `order_submit_success`. Add-to-cart uses
   `trackPageView`, not `trackEvent`, so it is a `page_viewed` row and easy to miss.
   The cart's continue button logs `cart_checkout_pressed`, and `cart_checkout_blocked`
   with `reason` ∈ {`store_closed`, `store_busy`, `store_custom_message`,
   `school_order_time_invalid`, `store_status_error`} (from `screens/cart/cart.tsx`). Before
   those events, a cart stopped by a closed/busy store left no trace at all.

Checkout-screen events that explain the "reached checkout, didn't send" layer:
- **`checkout_left`** — checkout lost focus (`reason`: `blur`|`unmount`) without a completed
  order: `seconds_on_screen`, `attempted`, and the payment method / shipping / timing / price
  the customer had at that moment.
- **The checkout draft** (`shoofi-app/stores/checkout-draft`) keeps the payment METHOD and
  the future slot across checkout remounts: in memory only, per cart store, 2 h, cleared on
  order completion. It never holds card data — the chosen card is the server-side default,
  re-read by `PaymentMethodCMP.getCCData`. With no draft, checkout pre-selects the customer's
  last successful method (AsyncStorage, per customer id), after checking it against
  `/payment-methods`; wallets are never pre-selected on a ZCredit-wallet store (they need the
  session the customer's tap creates). Logged as `checkout_choice_restored`
  (`source`: `draft`|`last_used`). A restored slot the picker no longer offers is replaced
  with the first slot and logged as `order_timing_auto_changed`
  (`reason: restored_slot_unavailable`).
- **`page_viewed` `Checkout`** carries `cart_store` and `browsed_store`. The future-order
  picker is gated on `storeDataStore.storeData` — whatever store was loaded last — so
  checkout repoints it at the cart's store on focus (`checkout_store_data_refreshed`), and
  the cart reads the future-order flags from the cart's store it has just fetched.
- **`order_timing_changed`** is what the customer chose, but it also fires `now→now` on
  every picker mount — noise, not a choice. Changes the SCREEN makes (auto-flip to future
  delivery, twin mode forcing `now`) log `order_timing_auto_changed` with a `reason`.
- **`future_order_picker_opened` / `_closed`**, and **`future_order_no_slots`** when future
  ordering is enabled but no day has a slot left.
- Why the draft exists: in Sep 2026, 13 of 47 orders whose last timing pick was `future` were
  sent as ASAP after the customer left and re-entered checkout.

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
