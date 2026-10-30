---
domain: orders
last-verified: shoofi-server@fix/orders-admin-auth / 2026-10-30 (invariant 18); shoofi-partner@fix/print-loop-timeout / 2026-10-29 (invariant 17); shoofi-server@feat/marketing-attribution / 2026-10-28 (invariants 15-16); shoofi-server@964d45ac (feat/order-marketing-touch) / 2026-10-28 (invariant 15); shoofi-server@3ede94f5 (feat/coupon-fixed-delivery-price) / 2026-10-26 (invariant 14); rest shoofi-server@a62db9f7 (fix/for-you-pilot-readiness) / 2026-10-18
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
`services/coupons/delivery-price-enforcement.js` + `services/twin-order/twin-delivery-price.js`
(the order-side guard for fixed-delivery-price coupons, invariant 14), `utils/marketing-touch.js`
(order-side marketing attribution, invariant 15), `services/marketing/order-facts.js` +
`services/marketing/reconcile.js` (one marketing fact per checkout, kept true by a cron —
invariant 16), order crons. Docs: `docs/combo-deals.md` (the order-line half). Clients: checkout+tracking (app), accept/prepare (partner), pickup/deliver
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
      (`resolveDeliveryConflict`; the app picks first, creation re-checks).
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
      balance). `shippingPrice` is still validated nowhere (the tariff ceiling only BOUNDS a
      derived discount). Twin side coupons are still stored as posted.
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
    - **Every `/api/order/admin/*` route carries one of the two.** The one exception is
      `GET admin/my-stores/new-orders-count` (`auth.required`): it takes the store set from the
      token's phone (`storeUsers`), ignores `app-name` and returns counts only. The customer's
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
      is high-risk. Ungated money paths `addRefund` and `updateCCPayment` belong to payments.

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
