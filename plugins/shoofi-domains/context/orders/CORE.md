---
domain: orders
last-verified: shoofi-partner@fix/owner-walkthrough + feat/school-orders-v3 / 2026-11-14 (reference C3 customer note: v3 readers OrderCardV3, NewOrderViewV3, SchoolOrderCardV3); shoofi-partner@feat/table-order-label / 2026-11-13 (reference C3 table orders: helpers/order-table.ts, order-table-badge, both tickets, storeData guard); shoofi-server@feat/HIGH-RISK-kopa-table-orders 4f3ae1f4 / 2026-11-13 (invariant 31 + reference C5 "Kopa QR table orders": a diner's table order is an `orders` doc, `source: "kopa-qr"`; invariant 30 exception note); shoofi-server@feat/kopa-phase5 407a0533 / 2026-11-12 (invariant 30 + reference C5: till payments need an open till session); shoofi-server@feat/kopa-phase1 (phases 3/4/6, uncommitted) / 2026-11-11 (invariant 30, reference C5 Kopa phases 3/4/6); shoofi-server@feat/kopa-phase1 / 2026-11-11 (invariant 29, reference C5 Kopa); shoofi-server@fix/twin-cancel-safety / 2026-11-10 (invariants 27-28; invariant 18 addRefund note); shoofi-app@fix/active-orders-visible-and-errors / 2026-11-08 (invariant 26, reference C1 Tracking); shoofi-server@fix/delivery-side-row-by-original-id / 2026-11-08 (invariant 23 delivery-side writes); shoofi-server@fix/HIGH-RISK-comment-to-store / 2026-11-10 (invariant 25); shoofi-server@59cd5fdd + shoofi-delivery-web@feat/admin-order-address-note / 2026-11-10 (reference §5 `orders.order.address` snapshot incl. `notes` landmark + floor/apartment/entrance; C4 admin CardOrder + delivery board show them); shoofi-server@feat/first-order-at-store / 2026-11-08 (invariant 24); shoofi-server@fix/partner-summary-figures / 2026-11-09 (invariant 21 tie-out: partner/summary is the store report only with `figures: "report"` (totalRevenue = totalIncomes); without it the legacy answer, unchanged); shoofi-server@fix/delivery-row-by-original-order-id / 2026-11-08 (invariant 23); shoofi-server@fix/active-orders-delivered-filter-per-store / 2026-11-08 (invariant 22, originalOrderId match); shoofi-server@feat/partner-order-history / 2026-11-08 (invariant 21, invariant 18 exception list); shoofi-server@feat/shipping-price-check-log / 2026-11-03 (invariant 20); shoofi-server@fix/orders-admin-auth / 2026-10-30 (invariant 18); shoofi-server@fix/coins-admin-auth / 2026-10-30 (invariant 19); shoofi-partner@fix/print-loop-timeout / 2026-10-29 (invariant 17); shoofi-server@feat/marketing-attribution / 2026-10-28 (invariants 15-16); shoofi-server@964d45ac (feat/order-marketing-touch) / 2026-10-28 (invariant 15); shoofi-server@3ede94f5 (feat/coupon-fixed-delivery-price) / 2026-10-26 (invariant 14); rest shoofi-server@a62db9f7 (fix/for-you-pilot-readiness) / 2026-10-18
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
Server: `routes/order.js`, `routes/twin-order.js`, `routes/money.js`, `services/money/*`, `services/orders/cancel-money.js`, `routes/order-fraud-*.js`,
`routes/admin/order-monitoring.js`, `services/twin-order/*`, `utils/order-stock.js`,
`utils/order-pricing.js` + `utils/order-pricing-shadow.js`, `routes/order-amend.js`,
`utils/delivery-row.js` (how an order finds its delivery row, invariant 23),
`services/coupons/delivery-price-enforcement.js` + `services/twin-order/twin-delivery-price.js`
(the order-side guard for fixed-delivery-price coupons, invariant 14), `utils/marketing-touch.js`
(order-side marketing attribution, invariant 15), `services/marketing/order-facts.js` +
`services/marketing/reconcile.js` (one marketing fact per checkout, kept true by a cron —
invariant 16), who may call the coins admin routes (`routes/coins.js` `/api/admin/coins/*` and the
Coins Settings block of `routes/shoofi-admin.js`, invariant 19), `services/orders/shipping-price-check.js`
(the log-only delivery-fee check, invariant 20), `routes/order-history.js` +
`services/orders/order-history.js` (the partner's one-day order history, invariant 21),
`routes/kopa/orders.js` + `services/kopa/orders.js` (Kopa's orders, cancel log and stories,
invariant 29), the Kopa till: `routes/kopa/{reasons,tables,till-orders,kds,settings}.js` +
`services/kopa/{reasons,tables,till-orders,kds,settings}.js` (in-store sales in
`kopaTillOrders`, invariant 30), order crons. Docs: `docs/combo-deals.md` (the order-line half). Clients: checkout+tracking (app), accept/prepare (partner), pickup/deliver
(shoofir), monitoring/twin-admin (delivery-web).

**Not yours:** payment internals (`payments`), settlement/payouts (`accountant`), driver
assignment & areas (`delivery`), auth (`customers`), the For-you chat / AI helper
(suggestions `menu-catalog`, taste-profile ownership + login merge `customers`) — it READS
orders, ADDS to the cart only through `addProductToCartForStore` and never places an order
(reference §5, C1). Yours: that cart entry point (invariant 13) and the deferred in-chat
checkout (Known status). Hand off in the PR.

## ⚠️ HIGH-RISK — draft PR, flagged, never merge
Order creation (`processCreditCardPayment`/`processHypTokenPayment`/`finalizeApplePayOrder`
paths in `routes/order.js`), **any status-transition code**, and twin place/pay/cancel/degrade.
You may change them: minimal diff, extra tests, a "what could break" section, rollback note.
Payments/invoicing files stay off-limits — describe the fix and hand off.

## Invariants — never weaken
1. **Status source of truth is the server** — `ORDER_STATUS` in `consts/consts.js`
   (`1` in-progress … `6` pending … `13` fraud-review, `14` future, `15` ramadan; completed
   bucket `2,3,10,11,12`, cancelled `4,5,7,8,9`). Each client repo keeps its **own copy** in
   `consts/shared.ts` — a status change is a **multi-repo PR**. The driver endpoints
   never write `orders.status`: delivered = `bookDelivery.completedAt`, and
   `readyMinutes` is not an order field (reference §2). So there is **no single
   "delivered/completed" transition to hook** — completion is written on several paths
   (partner/admin `order/update`, the `fix-stuck-orders` crons) and arrival only on
   `bookDelivery`. A consumer that needs post-completion data reads lazily instead (the AI
   helper's `inferred` taste cache), and the AI helper's `deliveredOrders` counts COMPLETED
   statuses, not courier deliveries (reference §5).
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
   try/caught and swallowed. Never let one throw into the order path. **Notifications must
   also never HOLD it:** the store-owner new-order alert is fired with
   `fireStoreOwnerNotifications` (`routes/order.js`) and **not awaited** on every create
   path, `updateCCPayment` and `finalizeApplePayOrder`, always after the order is persisted
   at its final status. try/catch is not enough: a push that hangs never throws, and on
   brixta 2026-10-03 an awaited one held the create response 128s/257s → app timeout →
   customer resubmitted → duplicate orders. Push sends themselves have a hard timeout
   (`PUSH_SEND_TIMEOUT_MS`, 10s, at most 1 retry, none after a timeout — reference §7).
   Only the admin fraud-approval path in `/api/order/update` still awaits it.
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
    `test/integration/order-pricing-parity.js` (it has a "Combo deals" section). **The For-you
    chat adds one more copy of the unit formula:** `shoofi-app/helpers/chat-cart-line.ts`
    `priceLine` repeats `screens/meal/index2.tsx` (base + discounted extras over the same
    `extrasStore.calculateExtrasPrice`) on purpose, so the menu screen stays untouched — change
    the formula there too, and in `calculateItemUnitPrice`. Catalog side
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
13. **A cart filled outside a store's menu must name its store — the order goes wherever the
    cart is stamped.** Checkout submits with `storeData: cartStoreData || storeDataStore.storeData`
    (`cartStoreData` = the `@storage_cart_storeData` snapshot written with the first line), and
    `submitOrder` sends its `appName` as `app-name` on `order/create`. `addProductToCart` stamps
    an EMPTY cart with the BROWSED store (`storeDataStore.storeData`, else `@storage_storeDB`) —
    the menu's assumption (reorder loads the order's store first for the same reason). So the
    For-you chat (`shoofi-app/hooks/useChatAddToCart.ts`, behind `isChatOrderingEnabled`, built
    2026-10-17) adds ONLY through `cartStore.addProductToCartForStore(line, storeData)`: it stamps
    an empty cart with the GIVEN store (`setCartStoreDBName` + `setCartStoreData`,
    `isSchoolProject` false, `@storage_cartCreatedDate`), never reads or writes the browsed
    store, and **throws** on a cart of another store. The chat never calls `addProductToCart` /
    `resetCartForNewStore` and never moves the browsed-store globals (`setStoreDBName`,
    `getStoreData`, `getMenu`, `@storage_storeDB`) — it loads with the fetch-only
    `getStoreDataFromServer` / `getMenuFromServer`; the cart screen (mount) and checkout (focus)
    repoint `storeDataStore` to the cart's store themselves. Another store's cart is never mixed
    or silently emptied: the chat asks, and "replace" = `resetCart()` + add. Twin flows and
    school carts get no chat add (it opens the store instead). App tests:
    `__tests__/stores/cart-add-for-store.test.ts`, `__tests__/hooks/use-chat-add-to-cart.test.tsx`.

13. **A STORE PROMOTION IS THE STORE'S PRICE, NOT A COUPON** (`docs/promotions.md` in
    shoofi-server). It lives on **`order.promotions = { items, delivery }`** — one deal of each
    kind (but see "combined" below), each `{ promotionId, type, titleHE, titleAR, discountAmount, deliveryMode?,
    eligibleItemIds, fundedBy: "store" }` — and **never in `appliedCoupon`** (the coupon slot is
    the customer's coupon only). Order of pricing: items → **items deal** → coupon (minimum and %
    measured on the price AFTER the deal) → coins; fee → **delivery deal**. Shape on the order:
    the items deal is netted into `orderPrice`, `originalOrderPrice` stays the LIST price;
    `shippingPrice` is **never lowered** — the delivery deal comes off `total` only.
    - **Creation clamps, never rejects** (`enforcePromotions`, `routes/order.js`): every claimed
      deal is re-derived from the catalogue-priced items; an over-claim is added back
      (items → `orderPrice` AND `total`; delivery → `total`) and logged on
      `promotionEntitlement`. A deal that ended, a used-up cap, a cart that no longer qualifies
      or a deal in the wrong slot is dropped; a deleted promotion or a catalogue gap keeps the
      client's number; the server never RAISES a claim. The delivery fee a deal may discount is
      bounded by `resolveDeliveryTariffCeiling` (never 0).
    - **The one conflict with a coupon**: a delivery deal and a delivery coupon
      (`discountType: 'delivery'` or `type: 'free_delivery'`) never both apply — the larger
      wins, a tie goes to the deal, and the dropped coupon is not sent so it is not spent
      (`resolveDeliveryConflict`; the app picks first, creation re-checks). The app's flag for a
      coupon it shows but does not send is `couponSuppressed` (`components/total-price/index.tsx`
      → `promotionsStore.checkoutSelection` → `use-checkout-submit.ts`). Since shoofi-app#87 it also
      covers a delivery coupon on a pickup or drive-in order (payments reference "Coupons"). The
      server has no matching check for that case.
    - **Uses** are one row per (order, promotion) in `shoofi.promotionRedemptions` (unique,
      idempotent), written at the four `couponUsages` write points with the same status gates
      and released on cancel. NOT `couponUsages` — settlement and every coupon cap read that.
    - **Twin orders**: each side carries ITS OWN store's deal, judged on its own items
      (`services/twin-order/twin-promotions.js`, run per side in `/place` and
      `/digital-place-pending` before coins); never split like the twin coupon. Only the
      primary carries the fee, so only its store's delivery deal applies; the combination fee
      is never discounted. Uses are recorded with the twin coupon usages (cash: the route; card:
      `applyCaptureSuccess`) and released in `cascadeCancel`.
    - **Amend re-runs the rules** (`repricePromotions` in `utils/order-pricing.js`): the items
      deal on the new items, then the delivery deal on the subtotal after it; never above the
      checkout grant; `promotionPricing.<kind>.basis` = `recomputed` | `kept-original` |
      `catalogue-gap`.
      **A store edit never makes the customer pay more**: the amend passes
      `previousItemsPrice` and the deals keep at least `granted − removedValue` (items first,
      then delivery) — the store absorbs it, `protectedAmount` reports it (without this a lost
      "10% over ₪200" charged MORE for less food, and a card hold refused the edit). The amend
      also writes `promotions` into the `bookDelivery` snapshot (cash courier reimbursement)
      and reconciles `promotionRedemptions` (removed deal → row deleted, reduced → new amount).
    - **Once per order (`promotion.repeatInCart`)**: the quantity types (`items_for_price`,
      `buy_x_pay_y`, `amount_off_per_item`) repeat as often as the cart allows — 4 sides under
      "2 for ₪40" = two bundles. `repeatInCart: false` (admin checkbox "המבצע חל כמה פעמים
      באותה הזמנה", unticked) = one bundle / one free group / `minItems` units, cheapest first.
      **Absent = true** (deals saved before the flag). `REPEATABLE_TYPES` in
      `utils/promotion-discount.js`; read only by `evaluatePromotion`, so quote, creation
      clamp, amend, twins and the preview all follow it. "4 sides, one bundle" is this flag.
    - **Combined items deals (`promotion.combinable`)**: two items deals stack only when BOTH
      are `combinable: true` (absent = false — deals saved before the flag never stack;
      delivery deals never combine). `pickItemsDeals` (`utils/promotion-discount.js`) takes the
      best single deal or the best stack, trying every order (≤ 6 deals); no unit is discounted
      twice (`evaluation.consumed` / `removeConsumed`), and an order-level minimum is measured on
      the price after the earlier deals. The order keeps ONE `promotions.items`: total +
      `"A + B"` title + **`combined: [parts]`** — so every reader that sums/shows it (checkout,
      partner ticket, `orderPrice` → settlement) needs no change, and **per-deal readers MUST go
      through `dealParts(deal)`**: the redemption ledger (row per part), the creation clamp
      (re-derives the stack from the claimed promotions), amend repricing + ledger reconcile
      (`allocateAcrossParts`). Reading `promotions.items.promotionId` alone silently ignores
      the second deal.
    - **Describing a deal in words** (`POST /api/admin/promotions/assist`,
      `services/promotions/promotion-assistant.js`): Claude proposes the deal FORM's fields
      from the store's own catalogue; `applyPromotionProposal` keeps only what the form can
      hold (known type/config keys, ids from THIS store) and the person saves through the
      normal create route. It writes nothing. Requests a deal cannot express (Shoofi funding,
      several stores, daily hours, one customer) come back as `noFit` → coupon drafts.
    - **One ranking, three readers**: `rankDeals` (`promotion-service.js`) is the only place
      that picks the winning deal of each kind — `quotePromotions` (the menu/cart/checkout
      quote) and the admin form's live preview (`previewPromotionQuote`,
      `POST /api/admin/promotions/preview`) both call it. The preview ranks the UNSAVED draft
      with the store's other running deals (minus the saved copy of the deal being edited),
      ignores the draft's dates/active switch, skips caps and writes nothing. Do not give the
      preview its own ranking: it exists to tell support what checkout will really do.

14. **A FIXED DELIVERY PRICE COUPON IS RE-PRICED BY THE SERVER, unlike every other coupon**
    (`docs/fixed-delivery-price.md` in shoofi-server). `type: 'delivery_price'`,
    `discountType: 'delivery'`, `deliveryPrice: X`, cap `maxDiscount` (=`value`, required),
    percent split only. Discount = `min(cap, max(0, fee − X))` from ONE formula,
    `computeDeliveryPriceDiscount` (`utils/coupon-discount.js`), which every caller reaches through
    `computeCouponDiscount`. Its own type is there so that it FAILS CLOSED: a reader that does not
    know the type gives ₪0 off, never `min(value, fee)`. It needs this because it is the one
    coupon whose discount GROWS with the client-quoted `shippingPrice`, so an inflated fee costs
    the customer nothing while the funder and the cash courier pay `fee − X`.
    - **Creation guard** (`enforceDeliveryPriceCoupon`, `services/coupons/delivery-price-enforcement.js`)
      runs in `/api/order/create` **after** the entitlement block AND after the promotions block
      (its `resolveDeliveryConflict`), and **before** `const orderDoc = {`. So the order is:
      ownership/balance → deals + the deal-vs-coupon conflict (on the POSTED amount) →
      fixed-price recompute → orderDoc. It runs only when the coupon DOCUMENT or the snapshot says
      `delivery_price`.
      - fee = `DELIVERY ? min(shippingPrice, resolveDeliveryTariffCeiling) − kept delivery deal : 0`.
        The deal subtraction only matters if the promotions block failed and both survived.
      - The snapshot's money fields (`MONEY_FIELDS`) are overwritten from the document, and the
        split is re-resolved (`resolveCouponSplit`, now in `utils/coupon-discount.js`) on the final
        discount.
      - Final = `min(posted, server)`: never more than quoted (the charge was made for the quote).
        The difference is added back to `total` and recorded on `order.deliveryPriceCouponEntitlement`.
      - **₪0 drops the coupon** (`appliedCoupon = null`), so no `couponUsages` row burns a redemption.
        This covers pickup, a fee ≤ X, a code whose document is not `delivery_price`
        (`snapshot-type-mismatch`) and a missing document.
      - **A thrown check also drops a `delivery_price` coupon** (`check-failed`). This is the one
        deliberate exception to "a failed secondary check keeps the client's number": the order
        still goes through, it just goes through without an unverifiable discount.
      - It corrects and never rejects, because with Apple Pay / HYP the money is already taken.
        A conflict decided on an inflated posted amount can drop a deal and then trim the coupon.
        The customer gets less, never more.
    - **Twin**: ONE ₪X for the whole twin order, on the PRIMARY's real fee. The combination fee is
      never discounted. A fixed-price coupon on the secondary (fee forced to 0) comes off.
      `enforceTwinSideDeliveryPrice` (`services/twin-order/twin-delivery-price.js`) runs in BOTH
      `/place` and `/digital-place-pending`, right after the two `enforceTwinSidePromotions` calls.
      Twin placement still re-validates nothing else about coupons.
    - **Amend** (`amendedDeliveryPriceDiscount`, `utils/order-pricing.js`) **never grows it**.
      Amend keeps the fee, so the creation discount is the ceiling: a well-formed snapshot gives
      `min(kept, recomputed)`, and a snapshot missing `deliveryPrice`/`maxDiscount` keeps
      `min(kept, fee after deal)`. For this type, `routes/order-amend.js` writes the re-split
      `appliedCoupon.coupon.{shoofiDiscount,storeDiscount}` in the same `$set` as `discountAmount`.
      For ANY order, a non-finite `pricing.total` is `409 AMEND_UNPRICEABLE` and is never written.
    - **Unchanged for every other coupon type:** `discountAmount` and the snapshot stay
      client-trusted at creation, except `enforceCouponEntitlement` (ownership + partial-use
      balance). `shippingPrice` is still never corrected or rejected (the tariff ceiling only
      BOUNDS a derived discount; a fee BELOW the area tariff is only logged and flagged —
      invariant 20). Twin side coupons are still stored as posted.
    - Readers on the order side need no change: the partner invoice, shoofir `order-payment.ts`,
      admin `CardOrder`/`CardTwinOrder` and the app's `order-header` all read `discountAmount`,
      so a delivery coupon prints `shippingPrice − discountAmount` = ₪X.

15. **`order.marketingTouch` IS ATTRIBUTION ONLY, SANITIZED AT THE DOOR, AND NEVER FAILS AN ORDER.**
    The customer's last banner / story / popup / note tap or push open (≤ 24 h old), optional on
    the create body: `{ kind: tap|push_open, placement: banner|story|popup|note|push, itemId,
    campaignId?, linkType?: none|store|product|deal|coupon|page, at }`, stored as
    `marketingTouch` with `at` a **Date**. One sanitizer, `sanitizeMarketingTouch`
    (`utils/marketing-touch.js`): pure, sync, never throws, never rejects.
    - **Whitelist, not pass-through.** `/api/order/create` spreads `...parsedBodey` onto the
      order, so the route sanitizes and then **`delete`s the raw `parsedBodey.marketingTouch`**
      before `const orderDoc = {` (the `commentToCourier` pattern). Drop that delete and any
      client JSON lands on the order verbatim.
    - **Drop rules.** Bad `kind`/`placement`/`itemId`/`at`, `push_open` without `push` (or
      the reverse), `at` unparseable, > 5 min in the future, or > 24 h old → no field at all.
      Bad `campaignId`/`linkType` → only that key goes. Strings are trimmed and must be
      ≤ 64 chars. An over-long id counts as invalid; it is not truncated. **Absent = not
      attributed**, so `$exists` is meaningful.
    - **Twin:** `/place` and `/digital-place-pending` read the TOP-LEVEL `body.marketingTouch`,
      sanitize it ONCE and pass the same value to all four `buildSkeletonOrder` legs. Both
      orders carry it beside `twinGroup.groupId`. A report counting checkouts must collapse
      a pair by `twinGroup.groupId`. A report counting store orders or revenue keeps both.
    - **Survives every payment path because it is written only at insert.** The Apple Pay
      repoint (`update-apple-pay-order-session`), `finalizeApplePayOrder`, the CC/HYP
      branches and twin `/pay` all `$set` named fields and never rebuild the document. A
      status-`"0"` row carries a touch too, so attribution reports filter on status like
      every revenue reader. The one whole-body writer, the legacy `POST /api/order/update/all`
      (`$set: { ...parsedBodey }`), throws `ReferenceError: offsetHours is not defined` before
      it writes (verified 2026-10-28), so today it cannot overwrite the touch. Whoever revives
      it must `delete parsedBodey.marketingTouch` first.
    - **Not** in the `customers.orders[]` snapshot (recipe step 2). **No index on it, on
      purpose:** nothing reports off `order.marketingTouch` directly. It is the FALLBACK input
      of the order facts (invariant 16), read once per checkout by `_id`. A report reads
      `shoofi.marketingOrderFacts`, never a cross-store scan of this field.
    - Server tests: `test/integration/order-marketing-touch.js`. The client half (shoofi-app
      remembers the touch and posts it) is `services/marketing-events.ts`
      `prepareMarketingForOrder` (customers CORE invariant 11).

16. **ONE MARKETING FACT PER CHECKOUT, BUILT AFTER THE RESPONSE, KEPT TRUE BY A CRON**
    (`shoofi.marketingOrderFacts`, shoofi-server `docs/marketing-attribution.md`).
    - **The hook is the only order-path change, and it does nothing on the path.** The three
      insert sites call `scheduleOrderFact(req, res, ref)`: `/api/order/create` right after
      `db.orders.insertOne(orderDoc)`, and twin `/place` and `/digital-place-pending` right
      after `attachOrders`. It is synchronous, does no I/O, never throws and is **never
      awaited**. It reads the `device-id` header and `req.auth.imp`, then registers
      `res.once("finish"|"close")`. The fact is built in `setImmediate` after the response. So
      a card charged in the same request is recorded at its paid status, and nothing the hook
      does can hold or fail the order (invariant 6). Never `await` it, never move it before
      the insert, and never let it read the request body.
    - **Twin = one fact** (`_id: "twin:<groupId>"`, both legs in `orders[]` with `role`). A
      single order is `"order:<appName>:<orderObjectId>"`. The deterministic `_id` and
      idempotent upserts make a cron double-run, a retried request and a backfill race
      converge. Never give a fact a generated `_id`.
    - **Status is mapped, never trusted raw** (`normalizeOrderStatus`):
      - `"0"` → `pending_payment` (< 24h) or `payment_failed`.
      - `1,6,13,14,15` → placed; `2,3,10,11,12` → completed; `5` → rejected.
      - `4,7,8,9,-3,"cancelled"` → cancelled. `"-3"` and `"cancelled"` are twin-service writes.
        They are in NO constant and in no `CANCELLED_STATUSES` list, so a report that copies
        `utils/customer-orders.js` misses a cancelled twin side.
      - `"cancelled"` + `cancelReason: twin_place_failed` → payment_failed.
      - A twin takes its best leg's status.

      A change to `ORDER_STATUS` must be mirrored in `services/marketing/order-facts.js`.
    - **Final amounts, not create-time ones.** `amounts.net` is the live legs'
      `total − paymentAuth.refundedAmount`. Amend rewrites `total` and J5 capture takes the
      amended total, so `total` is final. A cancelled twin side contributes 0. `initialTotal`
      keeps the create-time figure. Never project `ccPaymentRefData` into a fact.
    - **The cron is the guarantee; there are no status-transition hooks.**
      `utils/crons/marketing-attribution-cron.js` runs:
      - every 15 min: facts with `reconcile.nextAt ≤ now` re-read their legs (one `_id $in`
        per store);
      - at :00/:30: a 48h `_id`-range backfill (insert-only) creates facts for orders the hook
        missed;
      - hourly: the rollup of today and yesterday;
      - 04:50 Israel: a re-read of every fact of the last 7 days.
      - hourly at :20: each push campaign's before/after impact, once its window has closed
        (customers CORE invariant 11; reads store orders by `_id` range, writes no fact).

      Don't add a hook on a transition path for this. Completion is written on several paths
      (invariant 1), and the cron already sees all of them.
    - **A touch counts only if it happened BEFORE the checkout** (`touchPrecedesCheckout`,
      `services/marketing/order-facts.js`):
      - received by the server (`marketingEvents.createdAt`) before the checkout → counts,
        whatever its client `at` (a device clock can run ahead);
      - received after it (a late flush) → counts only if its client `at` is strictly before
        the checkout, with no forward skew;
      - the order's own `marketingTouch` always counts (it rode on the order body).

      Server touches store `receivedAt` so the rule can be re-applied to a stored fact. It is
      applied at checkout, in the one-time late refresh, when reconcile re-checks stored
      touches (drops failures, recomputes `attribution`, stamps `reconcile.touchesHealedAt`,
      re-judges `touchReused`), in `computeTouchReused` (an earlier checkout only "used" a
      touch that preceded it) and in the nightly `refreshTouchReused`. Without it, the late
      refresh credited a tap made after an order to that order and every earlier one, and
      flipped the next real order to `touchReused` (found in local e2e, 2026-10-28). The
      event lookup stays index-backed: the `at` range on `{viewerKey, kind, at}` is the scan
      bound, and the received-before / tapped-before `$or` is a residual filter. Never drop
      the `$or`, and never widen the `at` bound beyond `created + 5 min` (the ingest route's
      own skew).
    - **Every checkout is recorded**, attributed or not: that is the baseline. Test phones
      (`config/test-phones.js`), impersonation (an `imp` token) and mock stores are recorded
      with `excludeFromReports: true`.
    - Backfill's logged `created` counts only real inserts (`recordCheckoutFactResult` →
      `upsertedCount`), so a racing second instance reports 0.
    - Tests: `test/integration/marketing-attribution.js`. It drives the real create and twin
      routers on mongodb-memory-server.

17. **PARTNER AUTO-PRINT: A SENT TICKET IS A PRINTED TICKET, AND THE NOT-PRINTED SWEEP IS
    BOUNDED** (shoofi-partner, `App.tsx` + `helpers/printer/print.ts` + `utils/print-{outcome,
    attempts,queue,batch}.ts`; reference C3 "Auto-print"). `isPrinted` is the ONLY "already
    printed" signal. The tablet sets it through `POST /api/order/printed` (`auth.required`,
    no role gate) after a ticket prints. After every successful batch, the tablet asks
    `admin/orders` for `isNotPrinted` orders and prints those too (the "sweep").
    Three rules, each one a fix for a loop seen in prod (super-abu-shaqra, 2026-10-28, order
    6370-3519 printed over and over):
    - **Epson's completion timeout is "unconfirmed", never a failure.** `"Print timeout
      occurred."` (`CODE_ERR_TIMEOUT` from `sendData`) arrives AFTER the data reached the
      printer, so the paper comes out. It is not retried, and the order IS marked printed.
      `sendData` gets a height-scaled timeout (30s floor, 60s ceiling, `sendDataTimeoutMs`).
      The old library default was 5000ms, shorter than a long ticket takes over Bluetooth.
      Real failures (connect, paper, buffer, our own JS ceiling) stay `"failed"`: they are
      retried once and not marked.
    - **The sweep sends `ordersDate` (the current business day).** Without it the server
      applies NO date window (`routes/order.js` builds one only `if (ordersDate)`). The sweep
      sends `AUTO_PRINT_SWEEP_STATUSES` = `1,2,3,6` (+ forced `14`/`15`), never cancelled,
      rejected or already-left-the-store statuses. It also skips an order after
      `MAX_AUTO_PRINT_ATTEMPTS` (2) attempts this app session that did not get it marked.
      Explicit prints (accept, the row's print button) are never filtered or capped.
    - **Image i belongs to queue[i].** A failed capture keeps a `null` slot
      (`captureAlignedToQueue`) and is not printed. Skipping it used to shift later images
      onto the wrong order and mark an unprinted one printed.
    So: never make a print path's success depend on Epson's completion callback alone, and
    never drop the sweep's date or cap. A stuck order is diagnosed from
    `<store>.client-error` `source: "printer-testPrint"` rows (they now carry `outcome`),
    plus the store's only `isPrinted:false, isViewd:true` orders.
18. **THE STORE-CALENDAR AND ORDER-ADMIN READS ARE GATED PER AUDIENCE, AND THE PARTNER GATE IS
    STORE MEMBERSHIP, NOT "THE TOKEN'S OWN STORE"** (shoofi-server `services/orders/admin-access.js`).
    Until 2026-10-30, anyone who sent a store's `app-name` could close its hours, or read its
    orders with the customers' names and phones. Some routes had no auth; others had
    `auth.required` only, which a customer token passes (shared secret). Each route declares
    its gate itself:
    - **`ORDERS_DASHBOARD_OR_STORE_MEMBER`** = `auth.required` + `storeMemberGate`. A
      `DASHBOARD_ROLES` admin token passes for any store. A `shoofi-partner` token passes when
      its own `storeUsers` doc (`req.auth.id`) has `appName` = the `app-name` header, or when
      another `storeUsers` doc with the same phone is on that store. That second test is the one
      `POST /api/customer/switch-store` makes before minting a token. Used on:
      - **`GET /api/order/admin/all/not-viewd`, the partner's LIVE new-order feed**;
      - `GET admin/not-viewd`, `GET admin/not-printed`;
      - `POST admin/orders/:page?` (the order list and the auto-print sweep, invariant 17);
      - `POST admin/school-project-orders-for-print`;
      - `GET /api/order/future-orders-ready` (`FutureOrderReminderGlobal`);
      - `POST /api/order/get-custom-delivery` (`screens/book-delivery/list`; the store's own
        `bookDelivery`);
      - the four `POST /api/admin/calander/{disable/hour/insert,disable/hour/insert/multi,enable/hour,enable/hour/multi}`.
    - **Why not exact match** (the #346 `ownStoreGate`): the feed is a new-order poll.
      `authStore.switchStore` (shoofi-partner) persists the new store name BEFORE the new
      token, so a poll in between carries store B with A's token. A 403 is silent in the
      app, and it blanks the store's new orders.
    - **`ORDERS_DASHBOARD`** = `auth.required` + `checkAdminRole(DASHBOARD_ROLES)`, on
      `GET /api/order/admin/future-orders-count`, `POST /api/order/admin/coupon-orders`,
      `POST /api/order/admin/all-orders/:page?`, `POST /api/order/statistics/new-orders/:page?`,
      `POST /api/order/byDate` (no caller) and `GET /api/shoofiAdmin/external-order-providers`.
      Only the admin web calls them.
    - **Every `/api/order/admin/*` route in `routes/order.js` carries one of the two.** The one
      exception there is `GET admin/my-stores/new-orders-count` (`auth.required`): it takes the
      store set from the token's phone (`storeUsers`), ignores `app-name` and returns counts only.
      **`POST admin/history` lives in its own router (`routes/order-history.js`) and takes the
      store-analytics gate instead** (`auth.required` + `requireStoreMembership()`): partner-only
      by decision, an admin-web token is 403 (invariant 21). The static test in
      `orders-admin-auth.js` reads `routes/order.js` only; `order-history.js` pins its own gate. The customer's
      own reads (`customer-orders`, `customer-active-orders`, `customer-orders-history`,
      `customer-last-completed-order`, `customer-invoices`) stay `auth.required`, because they
      select by `req.auth.id`. A static test fails for a new login-only admin route.
    - **Public by decision:** `GET /api/admin/calander/disabled/hours/:date` (the time pickers;
      projected to `{_id, date, hour}`) and `GET /api/admin/check-order-time-valid` (the customer
      cart on submit, maybe logged out; returns only the school ordering window). Neither returns
      an order. Gating them would 401 a logged-out customer.
    - **Who really calls `not-viewd`:** almost nobody, in steady state. All 394 prod `storeUsers`
      docs (2026-10-30) carry `isAdmin: true` + `roles: ["all"]`, so once user details load the
      partner polls **`admin/all/not-viewd`** instead (`isAdmin(ROLES.all)`, `stores/orders`).
      `not-viewd` is reached by a store user without `all` (`POST /api/customer/store-users/:appName`
      defaults `roles: []`) and by the new-orders screen before details load. Both send a token.
    - ⚠️ **A 401 signs the partner out.** Its interceptor treats any 401 as sign-out
      (`resetAppState`, then a restart). A gate on a partner-polled route must never 401 a
      logged-in terminal. Pinned by `test/integration/orders-admin-auth.js`.
    - **The feed after the change, prod 2026-10-30:** in the previous 7 days, 90 stores accepted
      3,218 orders. Every one of those stores has at least one `storeUsers` doc on it with a live
      token, so its terminal polls with a token whose own `appName` is the header store (an exact
      match). The switch-store window (header = new store, token = old store, same phone) is
      tested both ways.
    - **Still `auth.required` only, outside this sweep:** the order MUTATIONS (`update`,
      `update/viewd`, `printed`, `update-delay`, `start-preparing`, `update-start-preparing`,
      `update-item-collected`, `book-delivery`, `book-custom-delivery`, `update-custom-delivery`,
      `drive-in-arrival(-confirm)`, `update/all`). These are status transitions, so any change
      is high-risk. The ungated money path `updateCCPayment` belongs to payments
      (`addRefund` was removed on 2026-11-03, shoofi-server 29ed5252).

19. **THE COINS ADMIN ROUTES ARE DASHBOARD-ONLY, GATED ON THE ROUTE ITSELF.** Coins have no
    domain of their own; orders owns their order-side wiring and, since 2026-10-30, who may call
    their admin routes. Until then seven of these eight had no auth: anyone could read any
    customer's coin wallet, switch coins off platform-wide, set a store's `earnPercent` /
    `coinValue` (free money for customers), or run the expiry sweep.
    - **Seven on the dashboard gate, the sweep master-only.** `auth.required` +
      `checkAdminRole(DASHBOARD_ROLES)` (`utils/analytics-access.js`, so `viewer` and
      `accountant` pass) on seven routes. In `routes/coins.js` it is `COINS_ADMIN` on
      `GET /api/admin/coins/customer/:customerId[/earned]` and
      `GET /api/admin/coins/store/:storeAppName/stats`. `POST /api/admin/coins/expire` is
      `COINS_EXPIRE_ADMIN` = `checkAdminRole(["master"])`: it is the only code that permanently
      deletes coins, nobody calls it, and prod had no sweep rows, so narrowing it took access
      from no one. A run is audited as `expire_coins` (`services/audit/admin-audit-routes.js`).
      In `routes/shoofi-admin.js` it is
      `COINS_SETTINGS_ADMIN`, built inside the Coins Settings block from locally named requires,
      on `GET|POST /api/admin/coins-settings` and `GET|POST /api/admin/store/:appName/coins-settings`.
      Not in `utils/restricted-admin-routes.js`.
    - **No mobile caller, so no per-audience branch.** The admin web is the only client
      (`ShoofiSettings.tsx`, `StoreForm.tsx`, `customer-details.ts`). The customer app reads
      `store.coinsSettings` from store data and never calls these routes. The partner app's coins
      toggle is commented out in `screens/admin/store-managment`, so a partner token gets 403
      even for its own store. A mobile app that needs one of these later gets a per-audience
      check (guardrails §3a), never a role-only gate: mobile tokens carry no `roles`.
    - **The settings are still writable another way.** `POST /api/store/update` (`routes/store.js`)
      `$set`s the posted store document with no auth, so a store's `coinsSettings` can be written
      there without the clamps of the coins-settings route. The partner app round-trips the
      field through it on every store save. That route is not orders' and is not gated yet.
    - **Expiry stays unscheduled on purpose.** Expiry is computed on read (`coin-buckets.js`);
      `expireCoins` is the only code that permanently deletes coins and this route is its only
      trigger. Prod had 0 sweep-written `expire` rows on 2026-10-30. The `expire` rows that do
      exist carry an `orderId`: they are `refundCoins` clawing back coins earned on a cancelled
      order, not the sweep.
    - Tests: `test/integration/coins-admin-auth.js` (static gate check on every route plus every
      `/api/admin/*` route in `routes/coins.js`, 401/403 matrix, every dashboard role on seven
      routes, master-only on expire, the audit entry, refused writes write nothing).

20. **`shippingPrice` IS OBSERVED, NEVER ENFORCED: A DELIVERY FEE BELOW THE AREA TARIFF IS LOGGED
    `[shippingPriceCheck]` AND FLAGGED, NOTHING ELSE** (`services/orders/shipping-price-check.js`,
    shoofi-server#407). The app posts `shippingPrice = availableDrivers.area.price || 0`
    (`shoofi-app screens/checkout/index.tsx`), so a quote with no `area` posts ₪0. Scheduled
    orders into a staff-PAUSED area did exactly that: 5 known orders, June to October 2026, where
    the customer paid no fee and the courier was paid ₪0 (fresh-cafe 9637-4325, flora-boutique
    9149-1898 / 5277-5921 / 6732-6168, abuissa-grills 1251-2881). The quote fix belongs to
    delivery (`services/delivery/availability.js`). This check is the net that catches the next
    one.
    - **Where and when:** in `/api/order/create` only, right after `db.orders.insertOne(orderDoc)`
      and `scheduleOrderFact`, as `runShippingPriceCheck({...}).catch(() => {})`, **never
      awaited**. It never rejects and never changes `shippingPrice` or `total`. A lookup that
      throws or never answers leaves the order and its response untouched (invariant 6). Twin
      `/place` / `/digital-place-pending` do not call it.
    - **Comparison:** the posted `Number(shippingPrice) || 0` against the area's `price`, with
      ₪0.01 tolerance. Only a fee BELOW the tariff is flagged. `shippingPrice` is already the
      PRE-discount fee: a coupon rides on `discountAmount`, a store delivery deal on `total`
      (invariants 13, 14). So there is no separate pre-discount field to read, and none is needed.
    - **Area:** the store point comes from the store's own `store {id:1}.location`, never from the
      client's `storeData`. The customer point is `order.geo_positioning`. `findBestAreaForLocation`
      runs on ACTIVE areas first, then again with `{ ignoreAreaActive: true }`. That is the same
      two-step as `checkStoreDeliveryAvailability`, so a PAUSED area still gives its tariff
      (`paused: area.isActive !== true`). It deliberately does NOT use
      `resolveDeliveryTariffCeiling`, which returns a ceiling with store-zone / ₪100 fallbacks and
      skips paused areas. An unmatched area here is `unresolved`, never a mismatch.
    - **Exempt (no lookup, no flag):** receipt method ≠ `DELIVERY`; `isDeliveryOnly`; twin
      (`twinGroup.groupId`, or a booking's `twinGroupId`); an `appliedCoupon.coupon` with
      `type: 'delivery_price'`, `discountType: 'full_discount'`, `isFreeDelivery`, or
      `isDeliveryCoupon` (`discountType: 'delivery'` / `type: 'free_delivery'`); `promotions.delivery`.
      These are belt and braces: current bundles never lower `shippingPrice` for them.
    - **Output:** one `logger.warn` line, `"[shippingPriceCheck] submitted delivery fee is below
      the area tariff"`, with `appName, orderId, orderObjectId, status, paymentMethod,
      paymentProvider, timing (now|future|ramadan-iftar), isFutureOrder, submitted, expected,
      areaId, paused`. On a mismatch ONLY, it also does `$set order.shippingPriceCheck =
      { expected, submitted, areaId, paused, checkedAt }`, so `$exists` means flagged. A failure
      logs `"[shippingPriceCheck] check failed — order unaffected"`. The field is a named `$set`
      after the insert, so like `marketingTouch` (invariant 15) it survives every payment path.
      A `book-delivery.order` snapshot taken before it lands does not carry it. It is not in
      `customers.orders[]`, nothing reads it, and it has no index.
    - **Measured before shipping** (2026-11-03). A read-only dry run of this module over
      `book-delivery` status `"4"`, reading each booking's `order` snapshot:
      - **October 2026, 8,713 bookings.** 1,215 were exempt (twin 545, delivery coupon 488,
        full_discount 78, fixed-price 49, delivery-only 42, isFreeDelivery 10, not DELIVERY 3).
        7,487 were at the tariff. 0 were unresolved and 0 errored. **2 would be flagged live,
        both the ₪0 paused-area orders** (fresh-cafe 9637-4325, flora-boutique 9149-1898).
      - **9 more October bookings mismatched only in the dry run.** Support's
        `update-address-to-current-location` (`routes/customer.js`) rewrites the order's and the
        booking's coordinates AFTER creation, and never the fee. So a later lookup sees a point
        the creation-time check never saw.
      - **September 2026, 8,221 bookings.** 3 would be flagged live: flora-boutique 5277-5921
        (₪0), and two ₪20-for-₪25 orders from one shawerma-alarz customer, quoted on
        coordinates that support had already corrected. Those two are real under-quotes. The
        25 dry-run-only mismatches were 10 relocations and 15 tariffs raised since the order.
      - **June 2026.** abuissa-grills 1251-2881 and flora-boutique 6732-6168 are caught. The
        store copy of 6732-6168 was later patched to ₪20, but the booking snapshot keeps the
        creation-time ₪0. June also has 10 more live flags (₪20 against ₪25–38) that are NOT
        root-caused. They predate the 2026-06-27 change that made relocations rewrite order
        coordinates, so they are not relocation artifacts, and no exemption rule covers them.
      - Of the October exempt rows below the booking-time tariff, 269 were twin and 42
        delivery-only. Only 2 were coupon orders, and both were relocations. Coupons do not
        lower `shippingPrice` in practice.
    - **Turning it into enforcement is a product decision**, not a follow-up. With Apple Pay /
      HYP the money is already taken when the order reaches the route, which is the same reason
      every other creation check corrects and never rejects.
    - Tests: `test/integration/order-shipping-price-check.js`. It covers each exemption, active
      and paused areas, unresolved cases, a throwing lookup, a lookup that never answers (the
      create response is not held), and a failed flag write.

21. **PARTNER ORDER HISTORY IS THE PAYMENTS SCREEN'S DAY, AND ITS SALES TOTAL TIES OUT TO
    `partner/summary`** (`POST /api/order/admin/history`, `routes/order-history.js` +
    `services/orders/order-history.js`, built 2026-11-08 for the partner tablet's v3 history tab;
    definitions decided by the accountant domain and Sari). Read-only.
    - **Gate:** `auth.required` + `requireStoreMembership()` (`utils/store-membership.js`, the
      store-analytics gate). The store is `req.storeMembership.appName`, never the raw header.
      The LIST is for every member of the store. The TOTALS only for the partner `reports` role,
      decided by `storeUserHasRole(me, ["reports"])`, the function `requireStoreRole` itself
      calls (so `isAdmin` first, and a doc with a missing/empty `roles` array passes, as legacy).
      Without the role the answer is `totals: null`, **never a 403** (a 403 is silent in the
      partner app and would blank the screen).
    - **Body** `{ date: "YYYY-MM-DD" }`: one business day. 400 when missing/malformed/not a real
      day, in the future, or more than 31 days back (`MAX_DAYS_BACK`), "today" being the Israel
      calendar day.
    - **The day:** `getBusinessDayBoundariesForDateRange(date, date, openHours)`
      (`utils/store-service.js`) on the store's `store {id:1}.openHours`, matched on `created`
      with the same string-range query as `partner/summary` (without `figures` in the body — what
      installed partner builds send — that is the legacy handler,
      shoofi-server `services/payments/partner-summary-legacy.js`, unchanged; with
      `figures: "report"` it is the store report engine's orders query,
      `services/payments/store-sales.js` `settlementOrdersQuery`, over
      `storeReportBounds(date, date)` — the same snapped bounds except in the store's
      `openHoursEnabledMonth`, where the report starts at 00:00). So
      the window is the SNAPPED one (closed gaps split at their midpoint), and a twin leg's
      `+00:00` `created` compares as a string exactly as it does there. Not fixed here on
      purpose: the two screens must agree. **Never** `routes/order.js`
      `getBusinessDayBoundaries` (reference C3: its overnight branch reads wall-clock now).
    - **The list:** statuses `HISTORY_STATUSES` = `1,2,3,4,5,7,8,9,10,11,12`. `0`, `6`, `13`,
      `14`, `15` are out. No `isViewd` filter (a cancel before acceptance shows), school orders
      in, a superseded Apple Pay placeholder (`supersededBySessionId`) out. Newest first by the
      INSTANT of `created` (a string sort would misplace a `+00:00` twin leg by hours). Capped at
      `MAX_HISTORY_ROWS` = 500 with `truncated: true`; the totals are always over the whole day.
    - **A row:** `{ _id, orderId, status, created, orderDate, receiptMethod, paymentMethod,
      customerName, amount, isSchoolProject, cancelReason, twinGroupId }`, from a projection,
      never the full document. `amount = (orderPrice || 0) + (driveInPrice ||
      driveInPricing?.price || 0)`, the payments screen's drive-in chain. Never `total` (it
      carries the courier's `shippingPrice`).
    - **Totals** `{ sales: {count, amount}, cancelled: {count, amount}, inProgress: {count} }`:
      sales = `COMPLETED_STATUSES`, cancelled = `CANCELLED_STATUSES` (both imported from
      `utils/customer-orders.js`), inProgress = status `1` (no amount). Summed raw, no rounding.
    - **Tie-out (the contract):** for any day, `totals.sales.amount` / `.count` =
      `partner/summary`'s `totalRevenue` / `totalRevenueCount` for `startDate = endDate = date`.
      It holds because both read the same window, the same completed statuses and the same
      amount; the superseded exclusion cannot break it (a superseded row is always status `4`).
      `partner/summary` answers two ways (shoofi-server `fix/partner-summary-figures`, accountant
      invariant 17). Without `figures` (installed builds) it is the legacy answer, unchanged:
      `totalRevenue` = Σ(`orderPrice` + drive-in), the same sum as here by construction. With
      `figures: "report"` it IS the store report: `totalRevenue` = the report's `totalIncomes`
      (סך הכל הכנסות ממכירות), which equals Σ(`orderPrice` + drive-in) whenever every completed
      order is CARD or CASH (prod 10/2026: 13,535 completed, 0 with another method). An order with
      no or another payment method counts in the report only through its coins + Shoofi coupon
      credit, so on such a day the two would differ — the report wins.
      `test/integration/order-history.js` runs both real routers on one fixture day, against BOTH
      answers, and fails if either drifts. **Change the window, the completed set or the amount in either route, and
      change the other.**
    - Response `{ date, window: { start, end }, orders, truncated, totals }`, top level (no
      `{message, data}` envelope; the partner reads `res?.data || res`).

22. **THE SHORT ORDER NUMBER IS NOT UNIQUE. MATCH A DELIVERY ON `originalOrderId` ↔
    `originalBookId`.** `orderId` / `bookDelivery.bookId` ("1096-8335") is the first 4 + last 4
    digits of the 14-digit `originalOrderId` (`generatedOrderId`, `routes/order.js`), about 5×10^7
    values, and it collides **across stores and within one store**. On 2026-11-08, 88 numbers in
    prod `book-delivery` were shared by 2+ stores out of 106,071 rows, and 12 (appName, orderId)
    pairs in `customers.orders[]` belonged to two different orders (GCP "0880-8715", GCP
    "4587-1395", cacao "7660-8910", …). The full `originalOrderId` had 0 collisions across 173,659
    orders. Every booking writes it as `originalBookId` beside `bookId` and `appName`. It is on
    every row created since 2025-12-12 (85,304 of 106,075), and on 2026-11-08 3,989 of the 3,998
    delivered rows from the past 14 days matched their order on it. The other 9 had no store
    order under that number, and none mismatched.
    So: **identify an order's delivery by `originalBookId === order.originalOrderId`** (plus
    `appName` as a guard). Fall back to `appName` + `bookId` only when one side lacks the full
    id, and then only to a row booked after the order. A lookup by `bookId` alone can read or
    write another order's delivery. Incident 2026-11-08: the customer's active-orders list
    (`filterOutDeliveredOrders`, `utils/active-orders.js`) hid GCP's live 1096-8335 behind
    burger-house's delivered 1096-8335. The customer ordered again, and the store cancelled the
    duplicate. An order whose store is unknown is kept, because over-inclusive is the safe side.
    `originalBookId` has **no index**: query on the indexed `bookId` and compare the full id in
    code (the order's own row always has `bookId === order.orderId`). Paths that still key on
    `bookId` alone are listed in reference §5 (`delivery-company.bookDelivery`).
23. **A DELIVERY ROW IS LOCATED BY `originalOrderId` ↔ `originalBookId`. `bookId` ALONE IS NEVER
    A KEY.** The short order number (`order.orderId` = `bookDelivery.bookId`, `"1096-8335"`) is
    the first and last four digits of `originalOrderId` (`"1096-217289-8335"`,
    `generateUniqueOrderId` in `routes/order.js`, `generateOrderId` in `routes/twin-order.js`),
    so it repeats, and `delivery-company.book-delivery` is one collection for every store.
    Prod, 2026-11-08: **88** bookIds shared by two or more stores, and **12** (appName, short
    number) pairs in `customers.orders[]` used by two different orders of the SAME store. The
    full id: 0 collisions in 173,659 orders. A path that finds and writes "this order's row" by
    `bookId` cancels another store's courier (and leaves its own driving), tells the wrong
    driver an order is ready, or overwrites another order's snapshot.
    - **The one helper:** `deliveryRowFilterForOrder(order, appName)` in `utils/delivery-row.js`
      (shoofi-server#514). Order has `originalOrderId` →
      `{ originalBookId, bookId }` (the `bookId` only rides the `{bookId:1}` index; there is no
      `originalBookId` index, and it can only narrow the match). Legacy order without it →
      `{ bookId, appName }`. Neither → `null`, and the caller leaves the delivery side alone.
      **No branch returns `bookId` on its own.** No `appName` on the first branch on purpose:
      ~100 rows written before mid-2026 carry `appName: "shoofi-app"` instead of the store.
    - **Data it rests on (prod, 2026-11-08):** 85,305 of 106,076 rows carry `originalBookId`,
      every row created since 2025-12-12 (older rows lack it); on every
      one of them `bookId === order.orderId` and `originalBookId === order.originalOrderId`;
      every twin row (2,750) has it. A legacy ROW of an order that HAS `originalOrderId` is
      deliberately not matched — widening to it re-admits the same-store collision.
    - **Find, then write by `_id`.** Where a path reads the row and then writes it, the write is
      `{ _id: row._id }`, so the row whose driver is notified is the row that changed:
      `/api/order/update` cancel (`4`/`7`/`8` → delivery `-3`) and ready-for-pickup (`3` →
      `isReadyForPickup`), `/api/order/update-delay`, and order-amend `syncDeliverySnapshot`.
    - **Twin legs** are two orders with their own `originalOrderId` and their own row, so the
      same filter works per leg. The group document stores only each leg's SHORT number, so
      `services/twin-order/twin-group-service.js` resolves a leg through `legDeliveryFilter`
      (loads the leg's order by `orderObjectId` for `originalOrderId`; falls back to
      `{bookId, appName: leg.appName}`) in `cascadeCancel`, `degradeToSingle` and `undoDegrade`.
      The twin admin group read (`GET /api/twin-order/admin/group/:groupId/full`) and
      `POST /api/twin-order/admin/assign-driver` use the helper too (the latter keeps its
      last-ditch `{twinGroupId, appName}` lookup).
    - **Also on the helper (reads):** support's `update-address-to-current-location`
      (`routes/customer.js`, `$or` of the helper filter and `order._id`, then written by `_id`),
      admin order-monitoring `computeOrderDelays`, support-agent `find_order`.
    - **One row per order is still assumed.** A re-booked order can hold two rows with the same
      `originalBookId` (prod: one, vapego, statuses `-3` and `4`). These paths touch the first
      one found, exactly as before; they do not choose between them.
    - **The delivery-side WRITES no longer key on `bookId` alone (2026-11-08).** These are
      `POST /api/delivery/admin/cancel` and `POST /api/delivery/update` → `updateDelivery`. They
      go through `locateDeliveryRow` (`services/delivery/delivery-row-locator.js`), which tries,
      in order: the row's `deliveryId`, then `originalBookId` + `bookId`, then legacy `bookId`
      (+ `appName`). A shared legacy number writes its single live row or is refused with a 409.
      delivery-web's cancel sends `deliveryId`. Delivery CORE invariant 20.
    - **Still keyed on `bookId` alone, all READS:** `GET /api/delivery/book/:bookId`
      (customer-scoped for mobile callers, sorted newest), `GET /api/delivery/order/:id`,
      `POST /api/delivery/orders/batch` (dashboard-only, no client calls it), the impersonation
      driver lookup in `routes/shoofi-admin-users.js`, and the analytics `bookId: {$in}` joins
      (live-ops, churn-360, support-analytics, `utils/active-orders.js`).
    - Tests: `test/integration/delivery-row-by-original-order-id.js` (helper; cancel/ready with
      a cross-store and a same-store decoy inserted first; legacy fallback; twin cascade,
      degrade and undo; a source pin that the order-side files never regrow a
      `bookDelivery.x({ bookId … })` key) and the amend case in `test/integration/order-amend.js`.
24. **`order.isFirstOrderAtStore` IS DECIDED ONCE, AT INSERT, AND ABSENT MEANS "UNKNOWN", NEVER
    "FIRST"** (`services/orders/first-order-at-store.js`, shoofi-server#508, the partner tablet's "new customer"
    badge, partner redesign item 15, approved by Sari 2026-11-08).
    - **Meaning:** `true` = no earlier order of this `customerId` in THIS store's db counts;
      `false` = one does; **absent** = unknown (the lookup threw or hit `maxTimeMS` 2000, no
      customer id, or the order predates the field: no backfill). A reader shows the badge only
      on `=== true`.
    - **What counts:** every status except cancelled/rejected (`4 5 7 8 9`) and the uncharged
      `"0"` attempt, plus the charged-never-finalised orphan (`"0"` with
      `ccPaymentRefData.status === "success"`, the create route's idempotency `chargeLanded` rule).
      A superseded Apple Pay placeholder (`supersededBySessionId`) never counts. So pending,
      fraud review (`13`), future/ramadan (`14`/`15`) and school orders all count.
    - **Identity = `customerId`, not the phone.** Customers are found by phone at login, deleting
      an account is a soft `isDeleted` that the next login reverses on the SAME document, and
      there is no phone-change or merge flow, so one phone keeps one `_id`. `orders.customerId`
      is a string in prod (checked 2026-11-08), and the ObjectId form is matched as well.
      `customerDetails.phone` is an unindexed snapshot.
    - **Every inserter sets it, right before its `insertOne`:** `/api/order/create` (decided
      before the `orderDoc` build, `applyFirstOrderFlag` after it, because the build spreads
      `...parsedBodey` and a client-sent value must be overwritten or removed), and twin `/place`
      + `/digital-place-pending` (both legs decided before either insert, each **in its own
      store's db**, so the legs never count each other). Card, cash, Apple Pay, HYP, school,
      the For-you chat (which goes through the normal create) and idempotent retries all use those
      three routes. Nothing writes the field later: amend, accept, `update-delay`, the Apple Pay
      finalize and session repoint all `$set` named fields, and `/api/order/update` is
      whitelisted. So a reprint or a history view shows what was decided at insert, even after a
      later cancel. `test/integration/first-order-at-store.js` fails when a new
      `orders.insertOne` in production code has no `applyFirstOrderFlag` before it.
    - **Cost:** one `findOne`, `_id` projection, stopping at the first match, on
      `{ customerId: 1 }` (`customerId_idx`). `DatabaseInitializationService` creates it on every
      store db at boot, fire-and-forget and never awaited before an insert. Before this change
      only the one-off `utils/create-orders-indexes.js` made it, and prod had it on 1 of 262 store
      dbs (2026-11-08). The largest `orders` collection is ~9.6k docs, so the index build is small
      (Mongo 8.0, non-blocking builds).
    - **Who reads it:** the partner's `admin/orders`, `admin/not-viewd` and `admin/all/not-viewd`
      return whole documents, so the field is there with no projection change. The websocket
      frames (`unviewed_orders_updated`, `order_status_updated`, `new_order_alert`) carry no
      order body: they only trigger a refetch. `POST /api/order/admin/history` (invariant 21,
      shoofi-server#497) projects its rows and does NOT carry it. Add it to `HISTORY_PROJECTION`
      and `toHistoryRow` if the history tab wants the badge. It is not in `customers.orders[]`.
    - **Secondary feature (invariant 6):** the lookup never throws into the create path. A
      failure is a `logger.warn` (`[first-order-at-store] lookup failed`) and the order is
      inserted without the field.

25. **`order.commentToStore` IS THE CUSTOMER'S NOTE TO THE STORE: CLEANED AT THE DOOR, ANY
    RECEIPT METHOD, ABSENT WHEN EMPTY, AND ONE PER STORE ON A TWIN** (`utils/comment-to-store.js`,
    shoofi-server branch `fix/HIGH-RISK-comment-to-store`, 2026-11-10). shoofi-app sends it from the
    cart page's note box. On app `main` that is ONE string (`cartStore.storeNote` → `getCartData`)
    and twin checkout sends none. App branch `feat/store-note-per-twin-store` (built, not merged
    as of 2026-11-10) keeps one note per store, details in reference C1.
    - **Three different notes, never mixed up:**
      `orders.order.commentToStore` = the CUSTOMER → the store (this invariant, any receipt method,
      not editable after insert); `orders.order.commentToCourier` = the CUSTOMER → the courier
      (`utils/comment-to-courier.js`, DELIVERY only, editable by support through
      `POST /api/order/comment-to-courier`, mirrored onto `bookDelivery`); top-level `orders.note` =
      the STORE STAFF's own note, written through `/api/order/update` (`ALLOWED_ORDER_UPDATE_FIELDS`),
      never by the customer.
    - **The cleaner, `sanitizeCommentToStore`:** plain strings only (an object, array, number or
      null is dropped, never stringified); `\r\n`/`\r` → `\n`; a run of spaces/tabs → one
      space; a run of line breaks (blank lines included) → ONE `\n`, so a single line break is
      kept; trimmed, clamped to `COMMENT_TO_STORE_MAX_LENGTH` = 200 (the app's
      `COMMENT_TO_STORE_MAX_LENGTH`), trimmed again. Empty → **no key at all**, never `""`, so
      `$exists` means the customer wrote something. Unlike the courier cleaner (clamp + trim only,
      nothing collapsed) it collapses whitespace, because the note prints on a kitchen ticket.
    - **Single store:** `/api/order/create` cleans it, **`delete`s the raw
      `parsedBodey.order.commentToStore`** before `const orderDoc = {`, and re-adds only the
      cleaned value (`...(commentToStore ? { commentToStore } : {})`) inside `order`. This is the
      `commentToCourier` pattern. Drop that delete and the `...parsedBodey.order` spread puts any
      client JSON on the order verbatim. No receipt-method gate: pickup, drive-in and table keep it.
    - **Twin, one note PER STORE:** the request carries `primary.commentToStore` and
      `secondary.commentToStore`, each the note for THAT store. `buildSkeletonOrder` takes
      `commentToStore`, cleans it itself and writes it on that leg's `order`. All four call sites
      (primary + secondary × `/place` + `/digital-place-pending`) pass their OWN side's value. A
      leg never carries the peer's note, and a side with no note has no key.
    - **Written only at insert; nothing rewrites it.** Amend, accept, `update-delay`, the Apple
      Pay finalize/repoint and twin `/pay` all `$set` named fields, and `/api/order/update` is
      whitelisted. The one whole-`order` writer, the legacy `POST /api/order/update/all`, still
      throws `ReferenceError: offsetHours is not defined` before it writes (re-verified
      2026-11-10 against the real router). Whoever revives it must keep the stored note (it would
      also lose `commentToCourier`). It is not in the `customers.orders[]` snapshot (recipe step 2).
      The `bookDelivery.order` snapshot taken at store accept copies the whole order, so the note
      is there too, but the driver's `POST /api/delivery/list` projection is a whitelist without
      it: drivers never receive it, and nothing mirrors it there.
    - **Readers (being built in parallel, not on `main` as of 2026-11-10):** shoofi-partner branch
      `feat/customer-note-to-store` shows it as «ملاحظة الزبون» on the order screens and on both
      printed tickets (the regular printer and the Urovo native printer). shoofi-delivery-web
      branch `feat/admin-customer-note-to-store` shows it read-only in `CardOrder` (reference C4).
      There is no edit path anywhere.
    - Server tests: `test/integration/comment-to-store.js` (the cleaner; create on DELIVERY and
      TAKEAWAY through the real router; junk, empty and over-long input; twin `/place` and
      `/digital-place-pending` each leg with its own note; a pin that every `buildSkeletonOrder`
      call site passes its own side's value).

26. **THE CUSTOMER APP NEVER SAYS "NO ORDERS" WHILE IT HOLDS ONE, OR WHEN THE LOAD FAILED.**
    (shoofi-app, after GCP 1096-8335 on 2026-11-08, when "no orders" right after checkout cost a
    duplicate order. The details are in reference C1 "Tracking".)
    - **One list.** `ordersStore.activeOrders` (`stores/orders/index.tsx`) feeds the ActiveOrders
      tab, the tab-bar bubble and the For-you chips. Never give a screen a private copy.
    - **"No orders" only after the server returned `[]`.** A failed refresh keeps the list on
      screen and sets `activeOrdersError`. With nothing to show, the tab draws an error with a
      retry button. Order history does the same. A slower, older response never overwrites a newer
      one: `refreshActiveOrders` applies only a sequence number newer than
      `activeOrdersAppliedSeq`.
    - **The just-placed order is shown at once.** `helpers/placed-order.ts`: checkout stages it at
      create and shows it at confirmation (`showStagedPlacedOrder` in `postChargeOrderActions`).
      It is never shown at create, because Apple Pay creates at `"0"` before payment, and never
      for a recorded payment failure. It is matched to the server copy on `_id` / `originalOrderId`,
      **never on the short number** (invariant 22). It is dropped for good once the server lists
      it, so a delivered or cancelled order is not brought back. If the server never lists it, it
      is dropped after `PLACED_ORDER_TTL_MS` (10 min). A twin checkout gets no local copy.
    - The create response is only `{ message, orderId: <_id> }`. Returning `originalOrderId` too
      would be a server change. The app already reads it when present.
    - The translations come from the DB, and prod's `retry` key reads "حسنا" / "אישור" (OK).
      The retry button uses its own key, `orders-load-retry`.
    - Tests (shoofi-app): `__tests__/stores/active-orders-placed-and-stale.test.ts`,
      `__tests__/components/active-orders-error-and-placed.test.tsx`,
      `__tests__/components/order-history-error.test.tsx`.

27. **A CANCEL SETTLES MONEY ONCE AND SAYS WHAT WAS DECIDED; A TWIN UNDO IS REFUSED ONCE MONEY
    MOVED** (shoofi-server `fix/twin-cancel-safety`, 2026-11-06). Prod cases: twin group
    `tg_1793989742338_dmfnny` (pier-19 9765-0521 + asaiel 7643-8302, ZCredit ₪177: degraded, undo
    clicked 3× as silent no-ops, then both legs cancelled with "keep" and no coupon) and snooshy
    1802-2011 (cancel "keep" → COMP ₪140 → un-cancel → cancel again → also a ₪140 refund flag).
    - **`cancelMoneyDecision` is `keep` | `refund` | `undecided`** (`CANCEL_MONEY_DECISION`,
      `services/orders/cancel-money.js`, re-exported by `routes/order.js`). The admin web sends
      `keep`/`refund` only when money is at stake. A cancel status (4,5,7,8,9) with NO decision
      (partner reject, status dropdown, driver, crons) is stamped **`undecided`** when
      `hasCancelMoneyAtStake(order)` (not cash — `payment_method` or `payment_provider` `CASH` —
      `total > 0`, and `paymentAuth.status` or a non-`failed` `ccPaymentRefData`), and NOT
      stamped at all otherwise (cash / zero / never paid). Until 2026-11-06 every one of these
      was stamped `refund`. A value other than keep/refund in the request is dropped.
      `settleCancelledOrderMoney` still RUNS an unattended cancel as REFUND: a live J5 hold is
      released exactly as before (`autoRefund: false`), a captured J5 is flagged by the release
      (`captured_before_cancel`), and — new — a settled charge with no `paymentAuth` on a SINGLE
      order is flagged `paymentAuth.refundRequired` with **`refundRequiredReason:
      "cancel_no_decision"`**, `refundRequiredAmount = order.total` (same fields
      `refundOrderPayment` writes; nothing is sent back). A twin leg gets the stamp and no
      per-order flag and no per-order settle: one charge covers two orders, so the GROUP decides
      (invariant 28, `settleTwinAfterLegCancel`).
    - **`cancelledAt`** is now written on every live → cancelled `/api/order/update`. It is the
      only marker a cash cancel carries, and the HQ money audit's `uncancel-leftovers` check
      finds un-cancelled orders by `cancelMoneyDecision || cancelledAt || cancelCompensation`.
    - **Settle once, on live → cancelled only** (`cancelSettlementSkipReason`, computed on the
      PRE-update order, before `settleCancelledOrderMoney`): `already_cancelled` (status already
      4/5/7/8/9), or an un-cancelled order carrying `prior_cancel_compensation`
      (`cancelCompensation`), `prior_refund_flag` (`paymentAuth.refundRequired`) or
      `prior_refund_issued` (`paymentAuth.refundedAmount > 0`). Then no settle runs, the
      client-sent decision is dropped (the first cancel's `cancelMoneyDecision*` stands), and
      `cancelSettlementSkipped { reason, at, by, requestedDecision, previousStatus }` is written.
      The other cancel side effects (coins, coupon usage, delivery) still run, but coins are now
      refunded once per order (invariant 28).
    - **Twin degrade** (`degradeToSingle`): `degrade.refundOwed` = `computeDegradeRefund` = the
      dropped leg's `total − shippingPrice`, read BEFORE any shipping transfer, +
      `combinationFee.customerPays`; **0 (and no auto-refund attempt) unless that leg was
      card-captured** (`isCardCapturedLeg`: not cash, non-failed `ccPaymentRefData`). There is no
      automatic ZCredit reversal any more — `degradeAutoRefund` is not read, so `refundAttempted`
      stays false; the amount is owed on the group ledger (invariant 28). It used
      `orderPrice` (pre-coupon) and was > 0 on every cash degrade. `refundBreakdown.basis` is
      `card_captured` | `not_card_captured`. **The group's `paymentStatus` is no longer touched**
      (it was overwritten to `pending`/`partial_refunded`); refund state lives only in
      `degrade.refund*`.
    - **Undo-degrade refusal** (`undoDegradeBlockReason(group, keptOrder, droppedOrder)`, pure,
      mirrored by the admin web — shoofi-delivery-web#346): `money_already_handled` when
      `degrade.refundAttempted || degrade.refundCompleted`, or either order has
      `cancelCompensation`, or either order has a `cancelMoneyDecision` whose
      `cancelMoneyDecisionAt` is after `degrade.triggeredAt` (a missing timestamp on either side
      counts as after), or the group's `moneyLedger` has any entry at/after `degrade.triggeredAt`
      other than `capture`/`release` and the degrade's own undecided `decide`/`owe`
      (`ledgerMovedSince`); else `kept_side_cancelled` when the kept order's status is 4/5/7/8/9.
      A successful undo closes the degrade's undecided owe (`cancel_owed`); the dropped leg's
      coins / coupon / deal uses returned at the degrade are NOT taken back
      (`undoDegrade.returnedOnDegradeNotReclaimed`).
      The route answers **409 `{ message, reason }`** (Hebrew message) and nothing is written.
    - **`db.twinOrderGroups` is the real `twinOrderGroups` collection**
      (`DatabaseInitializationService`); it pointed at an empty `twin-order-groups`, so undo's
      group restore (step 6) wrote nowhere and all 7 prod undos (3 groups) left a half-undone
      group. Every twin writer uses `db.collection('twinOrderGroups')`.
    - **`cascadeCancel`** stamps `moneyDecision` (keep/refund from `/api/money/cancel` or the
      triggering order route) or else `undecided` on each leg it cancels when money is at stake and
      no decision exists; no refund flag. **The dropped leg's status:** a SUPPORT degrade (source
      `admin` — `POST /api/money/cancel` one side, `/api/twin-order/admin/degrade`) cancels it as
      `7` CANCELLED_BY_ADMIN with support's reason in `cancelReason` and `twinDegradeSource`; `5`
      REJECTED only for the store side (timeout sweeper / store reject) — partner reports, HQ and
      store metrics read 5 as "the store rejected". The customer app's twin header checks
      "degraded" before "cancelled" (shoofi-app#96). **`degradeToSingle`** returns the dropped leg's coins,
      coupon uses and store-deal uses (`returnLegExtras`, recorded on `degrade.returnedOnDegrade`).
    - **Flow events** (`shoofi.orderFlowEvents`, the `trackOrderFlowEvent` writer, swallowed on
      failure): `twin_degrade`, `twin_undo_degrade`, `twin_cascade_cancel` on BOTH legs
      (metadata `groupId`, `side`, `role`, actor = the admin), `cancel_money_undecided`
      (`refundFlagged`, `liveHold`, `isTwinLeg`) and `cancel_settlement_skipped` (`reason`).
    - **Who may call** (guardrails §3a; only the admin web calls these): every
      `/api/twin-order/admin/*` action (`cancel`, `degrade`, `undo-degrade`, `assign-driver`) is
      `auth.required` + `checkAdminRole(TWIN_ADMIN_ROLES)` = master, admin, manager, senior,
      operator, viewer, editor (support works on `viewer`; `accountant` excluded);
      `GET /admin/group/:groupId/full` and `GET /api/admin/twin-order-config` take
      `DASHBOARD_ROLES`; `POST /api/admin/twin-order-config` takes `["admin"]` (+ master). Until
      2026-11-06 the twin routes were `auth.required` only and the config had no auth.
    - **The second-dispatch store sees its order** by ONE rule (`utils/twin-order-visibility.js`,
      reference §4 Dispatch) on both new-orders lists and the badge count: hidden only while the
      first-dispatch order is live and not accepted. A dropped first store releases it WITH the
      persistent alert (`twin_second_store_released`); `secondStoreWaiting` tells the admin while
      it is still hidden. Prod before: 17 groups' kept store opened 8-45 min after the degrade;
      the 3 failed-undo groups' kept orders were never seen.
    - Tests (shoofi-server): `twin-cancel-safety.js`, `twin-admin-auth.js`,
      `order-cancel-undecided.js`, `order-cancel-settle-money.js`,
      `order-cancel-money-before-status.js`, `hq-money-audit.js`, `money-cancel.js`.

28. **THE CHARGE IS THE UNIT OF MONEY: ONE APPEND-ONLY LEDGER PER CHARGE, ONE SUMMARY, ONE
    DECISION** (shoofi-server `fix/twin-cancel-safety`, 2026-11-07; contract
    `worktrees/twin-cancel-money-contract.md`, approved by Sari 2026-11-06).
    - **Charge keys:** `order:<appName>:<orderObjectId>` (single) and `twin:<groupId>` (one
      combined capture for both legs + the combination fee). The ledger is `moneyLedger` on the
      order / on the `twinOrderGroups` doc; `moneySummary` (`services/money/ledger.js`
      `summarize`, the ONLY place these numbers are computed) is stored beside it and copied onto
      both twin legs. Orders without one are legacy — the admin falls back to `charge-state.ts`.
    - **Entry types:** capture, release, decide, compensate, owe, refund, record_refund,
      refund_unknown, resolve_unknown, change_decision, cancel_owed. `captured = Σcapture`;
      `compensated = Σcompensate − Σchange_decision`; `refunded = Σrefund + Σrecord_refund +
      Σresolve_unknown(refunded)`; `owed = Σowe − refunded − Σcancel_owed`. **Invariant, checked
      before every write: `refunded + compensated + owed ≤ captured`** (a would-be violation is
      refused and logged CRITICAL — this is what makes snooshy's coupon-AND-refund impossible).
    - **Writes** (`services/money/money-store.js` `appendEntries`): versioned `updateOne` on
      `moneyLedgerVersion` (lost race → re-read, retry), entry `key` = idempotency key (a
      duplicate key is skipped), then the summary, the central owed index
      `shoofi.moneyOwed` (one row per charge: status open/closed, owedAmount, refundUnknown,
      unknownEntryId, customer, orders, decision/decidedBy/At) and a `money_<type>` flow event per
      entry on every order of the charge. **Charge claim:** `moneyClaim {token, at, by}` on the
      same doc, stale after 2 min; a second money action while one runs → 409
      `{reason: "charge_busy"}`. `/api/order/update` claims a single order's charge before it
      settles (twins: the group, in `settleTwinAfterLegCancel`).
    - **Capture:** twins record `group.capturedAmount` + a `capture` entry in
      `applyCaptureSuccess` = `computeCombinedTotal` (legs' totals + fee). Singles (and older
      twins) derive it at first ledger write (`ensureCaptureEntry`): `paymentAuth.capturedAmount`
      else `order.total` (the server charges `orderDoc.total`); older twins via
      `twinCapturedAtCapture` (a keep-secondary degrade's shipping transfer taken back off).
      Creation paths were NOT touched.
    - **Singles settle through the existing primitives**: `POST /api/money/cancel` runs the whole
      `/api/order/update` pipeline in-process (`handleOrderUpdate`, exported) with status 7 + the
      decision, and every single-order cancel (partner, cron, admin) records its outcome with
      `recordSingleCancel`, read off what `settleCancelledOrderMoney` wrote (release, compensate,
      refund, or owe from the `refundRequired` flag).
    - **Twins settle once per decision** (`services/money/money-cancel.js`
      `settleCancelledMoney`): keep → ONE coupon via `createCancelCompensation({ scope: "twin",
      amount, decisionKey, groupId })` = `COMP-<primary originalOrderId>[-n]`, the existing
      Shoofi-funded shape, NOT written on `order.cancelCompensation` (ledger +
      `moneySummary.couponCodes`); refund → owe (+ HYP auto refund below); undecided → owe. Per-side
      calls of `createCancelCompensation` / `refundOrderPayment` still refuse twins. Scopes: one
      side (`this`/`other` → `degradeToSingle({settleMoney:false})`, amount = that leg's total −
      shipping + fee), `both` (→ `cascadeCancel`), `remaining` (the live leg through the order
      route). For `both`/`remaining` the amount is what is left (`captured − refunded −
      compensated − owed`) **plus any open undecided owe, which the decision replaces**
      (`cancel_owed {decision: undecided}`). Cash / never charged: 0, only a `decide` entry.
      **`decision: "none"`** is accepted only when the preview has nothing to settle for that scope
      (refundMode none or amount 0): no `cancelMoneyDecision` stamp, nothing owed, `cancelledAt` +
      a `cancel_no_money` flow event; with money at stake it is 400 `bad_decision`. It exists so the
      dialog never has to send "refund" for a cash order (the stamp invariant 27 removed).
    - **A degrade with no decision** (old admin route, timeout sweeper) records `decide` + `owe`
      `undecided` for `refundOwed` on the group; a twin leg cancelled through the order route with
      no decision owes the remainder `undecided`. Both land in the owed queue.
    - **HYP twin partial refund** (`attemptHypTwinRefund`), behind `twinOrderConfig.hypAutoRefund`
      (default false): slot claimed first as a `refund_unknown` entry with a unique key, amount
      capped by `min(owed, captured − refunded − in-doubt)`, one attempt per decision, never
      retried while any refund is in doubt; a definite answer appends `resolve_unknown`
      (refunded / not_refunded), a throw (timeout / HTTP error) leaves it unknown → owed queue →
      `POST /api/money/resolve-unknown`. HYP's sandbox approved an over-refund and every duplicate,
      so these guards are the only ones. **ZCredit is always manual** (record-refund).
    - **Endpoints** (`routes/money.js`; only the admin web calls them, #346):
      `POST /api/money/cancel-preview` and `POST /api/money/cancel` (`{appName, orderId: Mongo _id,
      scope, decision, reason}`) take the twin-action roles (all but accountant);
      `POST /api/money/change-decision` (keep→refund: unused coupon balance → owed, coupon
      `isActive:false`; undecided→refund; undecided→keep), `POST /api/money/record-refund`
      (capped by owed, idempotent on provider+providerRef; on a single it clears
      `paymentAuth.refundRequired` once nothing is owed and adds `paymentAuth.refundedAmount`),
      `POST /api/money/resolve-unknown`, `GET /api/money/owed?status=open|closed|all` take
      `["accountant"]` (+ master). Errors: `{reason, message, code}`.
    - **Coins are refunded once per order** (`refundCoins`: `customerCoins.cancelRefundedOrderIds`
      in the same atomic update; legacy rows recognised by their notes) — the twin path refunded
      the trigger leg twice (order route + cascade).
    - **Backfill**: `scripts/money-backfill.js`, DRY-RUN by default; `--apply` only with Sari's OK.
      Coupons already issued against a twin group count as ONE `compensate` entry each
      (`collectTwinCompensations`): compensation rows naming a leg / the group, and a manual twin
      coupon stamped on the legs as `cancelCompensation { couponCode, amount, compensationId,
      twinGroupId }` (support's shape for dmfnny ₪177 and tg_1794337558463_qo9a4q ₪174, stamped on
      BOTH legs) — deduped by coupon code / compensation id, so a group so covered owes 0.
    - Tests (shoofi-server): `money-cancel.js` (ledger, every endpoint, roles, concurrency,
      re-cancel, cash twin, keep→refund on a partly used coupon, HYP success/refused/timeout/cap,
      singles through the order pipeline, coins once), plus the invariant-27 tests.

29. **KOPA'S ORDER READS USE THE STORE REPORT'S DAY ON `created`, SUM `orderPrice`, AND COUNT
    ONLY COMPLETED ORDERS AS SALES** (shoofi-server `routes/kopa/orders.js` +
    `services/kopa/orders.js`, branch `feat/kopa-phase1`, 2026-11-11; endpoints and shapes in
    reference C5). All three routes are read-only and gated by `KOPA_REPORTS`. The store is
    `req.storeMembership.appName`.
    - **Window:** `storeReportBounds(from, to, storeDoc)` (`services/compensations/report-window.js`).
      This is the store report's snapped openHours business days, including its
      `openHoursEnabledMonth` rule. It is matched on **`created`**, never `orderDate`: accept and
      every delay rewrite `orderDate` (invariant 10). `created` is what the store report,
      `partner/summary` and the partner history bucket on. It is compared as a string, with the
      same `+00:00` twin-leg quirk as those readers. ≤ 93 days per request.
    - **Set:** `HISTORY_STATUSES` (1-5, 7-12). Out: `0`, `6`, `13`, `14`, `15`, a superseded
      Apple Pay placeholder, and **school-project orders** (`isSchoolProject: {$ne: true}`, as
      the partner live list does). The school exclusion is the one difference from the partner
      history (invariant 21), which includes them.
    - **Amount = `orderPrice`** (`chargedOrderPrice` in `services/payments/store-sales.js`). It is
      never `total`, has no drive-in added and no coins subtracted. **Sales** (`summary.byPayment`
      / `summary.total`) are `COMPLETED_STATUSES` only. Cancelled orders go in
      `summary.cancelled`, and accepted-unfinished ones are counted in `summary.inProgress`.
      The summary is over the whole filtered range, never one page. So with no other filter,
      `summary.total` equals the store report's `totalRevenue` minus any completed school
      order's `orderPrice`.
    - **Cancel log "who":** only the admin web sends `updatedByName` / `updatedBySource` /
      `cancelReason` to `/api/order/update`. The partner app sends only a status, so a store
      reject's `status_change` event says `actor: "System"`. And `order.updatedByName` is the
      LAST admin-web updater, not necessarily the canceller. So the order is:
      1. the latest `shoofi.orderFlowEvents` `status_change` INTO the order's current status
         (looked up by `orderId: {$in: _ids}`, indexed, never by the short number);
      2. for a twin-service cancel (`cancelReason` `twin_*` / `twinDegradeSource`), the latest
         `twin_cascade_cancel` / `twin_degrade` event's named admin;
      3. with no event, `order.updatedByName` + `order.cancelledAt`.

      `by` is null for "System"/"Store Admin". `byRole` is derived from the source, else from
      the status (5 store, 7 support, 8 customer, 9 driver). The flow-event read is enrichment:
      if it fails, the rows fall back to step 3 and the log still answers.
    - **Removed-item price is not recorded.** An amendment keeps `{previousTotal, newTotal}` and
      a diff `{index, itemId, name, change, from, to?}`, and the removed line is gone from
      `order.items`. So an item row is priced `previousTotal − newTotal` (`priceBasis:
      "amendment_delta"`, net of coupon/deal re-pricing) only when that amendment's diff is that
      single removal. Otherwise `price: null`. Recording the line price would be a change to
      `routes/order-amend.js` `buildDiff` (amend is high-risk).
    - **Never returned:** `ccPaymentRefData`, `paymentAuth`, card data, `customerId`, customer
      tokens, fraud data, `moneyLedger`, the coupon snapshot, `order.address`, an amendment's
      `byUserId`, a story's `approval` / `marketingItemId`. Every row is built by an allowlist
      mapper over an inclusion projection.
    - Tests: `test/integration/kopa/orders.js` (41: the gate matrix on all three routes,
      overnight window on `created`, the 93-day limit, the status set + school + superseded
      exclusion, summary across pages, instant sort with a `+00:00` leg, the filters, no leak
      with the projection ignored, cancel-log rows from events/order fields/amendments,
      flow-event failure, stories scope + states).

30. **A TILL SALE LIVES IN `kopaTillOrders`, NEVER IN `orders`** (shoofi-server
    `services/kopa/till-orders.js`, branch `feat/kopa-phase1`, 2026-11-11; the rule is also the
    header of `services/kopa/store-data.js`). The partner app, the customer app, settlement,
    invoices, analytics, stock (`utils/order-stock.js`) and every order cron read the store's
    `orders` collection; none of them may see an in-store sale. So no Kopa till code names
    `orders`, a till order has its own status vocabulary (`open | paid | cancelled`, strings,
    not `ORDER_STATUS`), and nothing a till does decrements or restores stock. Each test file
    pins this with an `orders` spy that fails on ANY call. Extending a reader of `orders` to
    "also include till sales" is a product decision across settlement, invoicing and
    analytics. It is not a refactor. Endpoint shapes: reference C5.
    **One exception, and only for QR table orders** (invariant 31): a diner's order from a table's
    QR IS an `orders` document (`source: "kopa-qr"`), because the partner app must accept and
    print it. Till sales are unchanged.

    **Kopa phase 3 (cancellation reasons).** `kopaCancelReasons` `{ nameAR, nameHE, appliesTo:
    order|item|both, returnToStock, order, active }`. `returnToStock` is stored only: nothing
    reads it, because till sales never take stock. Delete is a soft `active: false`, so a
    cancelled till order's `reasonId` still resolves. A cancel accepts only an active reason
    whose `appliesTo` is its kind or `both`. Customer-order cancels (`/api/order/update`) are
    unchanged and use no reasons list.

    **Kopa phase 4 (tables, till orders, kitchen screen).**
    - **Server pricing.** A catalog line's `unitPrice` = `calculateItemUnitPrice` over
      `loadPricedProducts` (`utils/order-pricing.js`), the same pair amend uses: the current
      menu price with the category discount, plus extras by `calculateExtrasPrice`. A client
      `price` / `unitPrice` on a catalog line is ignored. A missing product or a combo with
      `comboIssues` is 400. An open item (`productId: null`) takes `{ nameAR, price > 0 }`.
      Changing the extras formula (invariant 11) changes till prices too.
    - **Totals.** Rounded to the agora per line (`lineTotal`). `subtotal` = Σ non-cancelled
      lines. `total` = subtotal − discount.amount, or 0 for `isStaffMeal`. **The tip is not in
      `total`.** `amountDue` = total + tip.amount, and `balance` = amountDue − paidAmount.
      Discount, tip and refunds were added in phase 4d (2026-11-12) and are documented in
      payments CORE "Kopa till money (phase 4d)" and payments reference §6b.
    - **Payments are bookkeeping** (`CASH | EXTERNAL_CARD | TRANSFER | CHEQUE | OTHER | UNPAID`).
      No card is charged and nothing is printed. `amount ≤ balance` for every method. Cash over
      the balance goes in `tendered`, and `change = tendered − amount`. The order becomes `paid`
      when Σ non-UNPAID ≥ amountDue. An optional `clientPaymentId` (uuid) makes a repeat answer
      the original payment with 200 `replay: true`. A money method (all but UNPAID) needs an
      open till session, else 409 `NO_OPEN_SESSION` (accountant CORE "Kopa till sessions &
      reports"). **UNPAID** keeps the order `open` with
      `unpaid: true` and a trail entry worth the balance. It is never money, so the balance
      stays owed and a table order keeps its table. Cancelling an order is 409 once any payment
      (UNPAID included) is recorded. A line change that would take amountDue below what was
      paid is 409 (`BELOW_PAID`): an open order is never refunded. Refunds are for paid orders
      only (phase 4d).
    - **Concurrency.** Every write is `findOneAndUpdate({ _id, status, rev })` + `$inc: { rev: 1 }`.
      Payments and cancels never retry, so of two tablets paying at once one gets 409
      `CONFLICT`. Line edits, moves and KDS taps re-read and retry twice, so a KDS tap never
      overwrites a waiter's new line. One open order per table is checked in code. It is backed
      by a partial unique index (`status: "open"`, `tableId` a string), which is built in the
      background and never awaited.
    - **KDS** reads open till orders only. Line status moves forward only (`new → preparing →
      ready → served`). A line with no `kitchenIds` shows only in the unfiltered view.
      `kitchenIds` are read from `kopaItemMeta` (menu-catalog owns the writer).

    **Kopa phase 6 (store settings).** One `kopaStoreSettings` doc (`_id: "settings"`). PUT may
    never change `receipts.enabled`: a different value is 400 `RECEIPTS_LOCKED`, and the flag is
    written only by `$setOnInsert` as `false`. Turning receipts on is reserved for a later
    reviewed phase. The doc is owner-only because it holds the Wi-Fi passwords.
    - Tests (shoofi-server `test/integration/kopa/`): `reasons.js` (30), `tables.js` (63),
      `till-orders.js` (81), `kds.js` (21), `settings.js` (17), 212 in all. Each covers the full gate matrix
      on every route, a failing and a never-settling `createIndex`, and the `orders` spy. In
      2026-11-11 fault-injection runs, 23 injected faults were each caught.

31. **A KOPA QR TABLE ORDER IS AN `orders` DOCUMENT WITH `source: "kopa-qr"`, CREATED ONLY BY
    `POST /api/kopa/public/table-orders/:store`, AND EVERY SPECIAL CASE KEYS ON `source`, NEVER ON
    `receipt_method`** (shoofi-server `services/kopa/table-orders.js` + `routes/kopa/table-orders.js`,
    branch `feat/HIGH-RISK-kopa-table-orders`, stacked on #580/#581, 2026-11-13; `docs/kopa.md`
    "Phase 8b"). Rules (Sari, 2026-11-13): no login, a per-table code, within 150 m of
    `shoofi.stores.location`, cash at the table, no coupon / coins / delivery / commission, and
    the partner app accepts / prepares / prints it.
    - **Shape:** `source: "kopa-qr"`, top-level `table: { id, label }` (the partner badge reads
      `order.table.label`, shoofi-partner#68), `customerId: null`,
      `customerDetails: { name, phone: "" }`, `order.receipt_method: "TABLE"`,
      `payment_method`/`payment_provider: "CASH"`, status `"6"`, `isViewd`/`isPrinted` false,
      `total` = `orderPrice`, `shippingPrice: 0`, `appliedCoupon: null`, `usedCoins: null`,
      `earnedCoins: 0`, `storeData` (an allowlist of the store doc), and `kopaQr: { idempotencyKey,
      location }`. The diner's note is `order.commentToStore` (invariant 25), never top-level
      `note`. `isFirstOrderAtStore` is ABSENT on purpose (invariant 24). The lines have the app
      shape `{ item_id, name, nameAR, nameHE, qty, price (unit), selectedExtras, img }`.
    - **The price is the server's only, from the QR menu build** (`buildQrMenu`: `qrPrice` or
      `price`, then the category discount), plus the chosen `single` options' prices, which are
      not discounted. This deliberately differs from `calculateItemUnitPrice` (invariant 11), which
      discounts extras. So **amend refuses these orders** (409 `KOPA_QR_ORDER_NOT_AMENDABLE` in
      `evaluateEligibility`), because it would reprice at app prices.
    - **What's orderable in v1** (`tableChoicesOf`, menu-catalog's `services/kopa/qr-menu.js`):
      every `single` group is required. `multi`, `counter` and `pizza-topping` are not offered.
      Combo, weight, by-weight, unknown types and option prices that are not numbers are not
      orderable.
    - **After the insert**, as a cash app order: `decrementOrderStock` (invariant 3 gates),
      `fireStoreOwnerNotifications` (not awaited, invariant 6), and an `orderFlowEvents` row with
      `actorType: "table"`. Nothing customer-side runs.
    - **The existing paths** were changed additively, each keyed on `isKopaQrOrder`
      (`services/orders/order-source.js`):
      - `/api/order/create` deletes a posted `source` / `table` / `kopaQr` before the
        `...parsedBodey` spread (`SERVER_ONLY_ORDER_FIELDS`). No app sends them.
      - `/api/order/admin/not-viewd` (the store tablet's new-orders list) used to `continue` on
        any order whose customer is not found. It now keeps a `kopa-qr` order.
      - The overdue cron labels it `طاولة <n>`.
      - `generateUniqueOrderId` / `fireStoreOwnerNotifications` are now exported from
        `routes/order.js`, unchanged.
      - Untouched and safe with `customerId: null`: accept (`update/viewd`: a non-DELIVERY order
        books no courier, the customer notification finds no customer and returns), the cancel
        side-effects (no coins / coupon), the feedback scheduler (`order?.customerId` guard),
        `fix-stuck-orders` (non-DELIVERY → `"2"`), and Kopa's customer reads (skip a null
        `customerId`).
    - **A legacy app order with `receipt_method: "TABLE"` and no `source` behaves exactly as
      before**, everywhere: the create path, amend, the not-viewd list and settlement.
    - **Settlement** excludes a table order from commission on `source === "kopa-qr"` ONLY
      (shoofi-server#583 `utils/table-orders.js` `TABLE_ORDER_SOURCE`; accountant CORE invariant
      20, claude-plugins#369). **Deploy order: #583 must be live before the first `kopa-qr` order
      is written.** Nothing is written while a store's `tableOrdering` is off (the default).
    - Tests: shoofi-server `test/integration/kopa/table-orders.js` (20).

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
   `payment_method_invalid` is mostly friction, not loss — checkout starts with NO payment
   method (the cash default is commented out) and forgets the choice on remount, so ~94% of
   those customers pick one and order within 30 min.
2. **Submitted and never paid** — status `"0"` order rows, per store DB. See the
   `FAILED_PAYMENT_STATUS` note; that is the only layer carrying an issuer reason.
3. **Never reached checkout** — `page_viewed` with `properties.page_name` ∈
   {`ProductAddToCart`, `Cart`} and no `order_submit_success`. Add-to-cart uses
   `trackPageView`, not `trackEvent`, so it is a `page_viewed` row and easy to miss.
   A For-you chat add logs the same `ProductAddToCart` page view (its `storeDBName` is the
   dish's store, plus `source: "for_you_chat"` and the reply's `suggestionId`) and also
   `button_clicked` `button_id: "for_you_quick_add"` (fallbacks `for_you_quick_add_fallback` +
   `reason`). An order that holds For-you dishes says so on its `order_submit_success` event:
   `for_you_lines` + `for_you_suggestion_ids` (`shoofi-app helpers/for-you-attribution.ts` —
   noted on the phone for 24 h when a dish is added from the chat or from a store a card opened,
   cleared once counted). Analytics only: the order payload, cart lines and `getCartData` are
   untouched; a failure there adds nothing to the event and never blocks the submit.
   The cart's continue button logs `cart_checkout_pressed`, and `cart_checkout_blocked`
   with `reason` ∈ {`store_closed`, `store_busy`, `store_custom_message`,
   `school_order_time_invalid`, `store_status_error`} (from `screens/cart/cart.tsx`). Before
   those events, a cart stopped by a closed/busy store left no trace at all.
   The For-you funnel copies all of these checkout events (and `checkout_left`) into
   `shoofi.forYouEvents` to explain a picked dish that was not ordered (menu-catalog CORE
   invariant 22) — renaming one, or a `reason` / `step` / `error_code` value, changes its
   "why" columns too.

Checkout-screen events that explain the "reached checkout, didn't send" layer:
- **`checkout_left`** — checkout lost focus (`reason`: `blur`|`unmount`) without a completed
  order: `seconds_on_screen`, `attempted`, and the payment method / shipping / timing / price
  the customer had at that moment. Payment method and order timing live in screen state
  and **reset on every mount**, so a customer who goes back to the cart and returns loses
  both; this event is the only record of the dropped choice.
- **`page_viewed` `Checkout`** carries `cart_store` and `browsed_store`. The future-order
  picker is gated on the **browsed** store's flags (`storeDataStore.storeData`), not the
  cart's — a mismatch explains a picker that is missing.
- **`order_timing_changed`** is what the customer chose, but it also fires `now→now` on
  every picker mount — noise, not a choice. Changes the SCREEN makes (auto-flip to future
  delivery, twin mode forcing `now`) log `order_timing_auto_changed` with a `reason`.
- **`future_order_picker_opened` / `_closed`**, and **`future_order_no_slots`** when future
  ordering is enabled but no day has a slot left.
- A future slot picked then silently lost is real: in Sep 2026, 13 of 47 orders whose last
  timing pick was `future` were sent as ASAP after the customer left and re-entered
  checkout.

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
- **DEFERRED (Sari, 2026-10-16) — do NOT build without a new decision:** the in-chat
  **checkout** card in the For-you chat. Adding to the cart from the chat IS built (Sari,
  2026-10-17 — invariant 13), but the chat still places no order: the read-only cart dock and
  the "complete the order" chip open the existing `cart` screen → normal checkout (no order or
  payment API changed). Reasons for keeping the checkout card out: the charged total
  is client-computed in `shoofi-app/screens/checkout/index.tsx` (`totalPrice` from
  `TotalPriceCMP`, which the server charges — invariant 11); the post-charge reset and
  navigation is `postChargeOrderActions` in the same file; and customer consent. Reference C1.

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
