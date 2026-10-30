---
domain: payments
last-verified: shoofi-server@fed9fee3 (feat/coupon-fixed-delivery-price) / 2026-10-26
scope: shoofi-server + shoofi-app (customer checkout)
reference: ./reference.md   # provider details, flows, data model, client payment UI
---

# Payments — CORE (always read)

**Money IN:** taking money from the customer at checkout — ZCredit/HYP charges, card
tokenization, Apple/Google Pay, customer refunds, the per-order receipt, payment-method config.

> Most of this domain is CLAUDE.md **do-not-touch**. Default mode: *investigate and propose*.
> Edit freely only in the safe zone below; everything else is a **draft PR flagged HIGH-RISK**.
> **Never print, log, or commit a secret, token, or card value.**

## ⚠️ ACTIVE MIGRATION: ZCredit → HYP
Card processing is being moved from ZCredit to HYP. In any card work: **prefer the HYP path**,
do **not** invest in expanding ZCredit-specific flows, and **never add new CVV storage** — the
plaintext CVV on stored cards goes away as ZCredit is retired (see Known status).

## Scope
**Yours:** `routes/payments.js`, `routes/payments/validate-card.js`, `routes/creditCard.js`,
`routes/hyp-pay.js` (HYP charge/tokenize), `routes/payment-methods.js`, `utils/hyp-pay.js`,
`utils/invoice-mail.js` (per-order receipt), and the payment functions inside `routes/order.js`
(`processCreditCardPayment`, `processHypTokenPayment`, `finalizeApplePayOrder`,
`updateCCPayment`). Client: the payment UI in `shoofi-app`.
**Not yours:** settlement/reports/store invoices/MASAV = **`accountant`**; order lifecycle =
`orders`. `lib/payments/calc.js` lives with accountant.

## Where you may act
- **Safe zone (normal PR):** `routes/payment-methods.js` (method resolution) and
  investigation/diagnosis anywhere.
- **Draft-PR HIGH-RISK:** any charge / token / session / customer-refund code.
- **Off-limits without sign-off:** `routes/payments.js`, `routes/creditCard.js`,
  `lib/payments/`, `routes/order.js`, `routes/hyp*.js`, `utils/hyp.js`, `utils/invoice-provider.js`.

## Invariants — never weaken
1. **Credentials are CENTRAL, not per-store.** ZCredit + HYP-Pay creds all come from
   `shoofi.store {id:1}.credentials` — one platform terminal charges for every store.
   Per-store creds exist only for **invoicing identity** (`store.hyp.*`). Never log values.
2. **Single-capture:** Apple Pay finalize is an atomic `findOneAndUpdate({status:"0"})`, so the
   verify endpoint and the ZCredit callback can't double-charge. Twin = one combined capture.
3. **Amount-mismatch backstop:** charged total vs `order.total` drift ≥ 0.01 → FRAUD_REVIEW
   (twin exempt). **Keep it.**
4. **Session terms-guard:** repointing a pending order onto a session with a different total is
   refused (the stale order is cancelled).
5. **Client-trusts-totals:** the server charges `orderDoc.total` from the client body — it does
   **NOT** recompute the cart in the charge path. The only checks are the mismatch backstop and
   the zero-total→CASH downgrade. **Never weaken this without explicit sign-off.**
   ONE coupon type is the exception at order CREATION (not in the charge path): a
   `delivery_price` coupon's discount is recomputed server-side before the charge, because it
   grows with the client-posted fee. See "Coupons between quote and charge" below.
6. **Coins/coupons settle only AFTER payment success**; failures log CRITICAL for manual
   reconciliation — never roll back an irreversible capture.
7. **Order dedup lock** (Redis `SET NX` + fallback + recent-order window) prevents double charges.
8. **There are TWO charge implementations, and a fix to one does not reach the other.**
   `routes/order.js` charges single orders; `services/twin-order/twin-payment-service.js`
   (`captureCombined`) charges twin orders. `POST /api/twin-order/pay` never enters
   `routes/order.js` — twin child orders are inserted straight into each store DB — so every
   guard in the single-order charge path is *structurally unreachable* from the twin path.
   Not theoretical: the saved-HYP-card provider routing added at `routes/order.js:2758` on
   2026-07-29 left the twin path untouched, and every twin order paid with a saved HYP card
   failed with `"תאריך תוקף לא במבנה תקין ,expirationDate"` until the same lookup was ported
   into `twin-payment-service.js`. **When you change charge routing, provider selection or a
   charge guard, apply it in both places — or say in the PR why the twin path doesn't need it.**
9. **The per-order customer document follows the STORE's VAT status.** A store that is
   עוסק פטור (`accounting.bankAccount.businessType === 'exempt'`) charges no VAT, so its
   sale may not be documented with any. The flag is read with `isVatExempt`
   (`utils/vat.js`), which checks **both** the per-tenant `store {id:1}` doc and the
   `shoofi.stores` registry entry because production stores are inconsistent about which
   one carries it. **Never make an exempt lookup able to fail a charge** — it swallows its
   errors and falls back to "not exempt", which errs toward a visible, correctable VAT
   document rather than an under-declared one.
   Consequence: **a twin group may not mix an exempt store with a regular one** — enforced
   in `twin-eligibility.js` at discovery and `rejectMixedVatPair` in `routes/twin-order.js`
   at place time, which is the one that protects the charge since eligibility is never
   re-run.
10. **Invoicing is MANUAL and split per revenue owner — behind a flag.**
   Historically each gateway issued the document itself during the charge (HYP
   `SendHesh`/`EZ.*`, ZCredit `ZCreditInvoiceReceipt`), giving one document per charge for
   the whole amount. With `invoiceConfig.manualInvoicesEnabled` on
   (`services/payments/invoice-config.js`: env kill → global → per-store, all three must
   allow it), the charge carries **no** invoice parameters and
   `services/payments/order-invoices.js` issues the documents afterwards through EZcount
   `createDoc` (`utils/hyp.createCustomerInvoice`), one per revenue owner:
   | | delivery | no delivery |
   |---|---|---|
   | regular order | 2 (store + delivery) | 1 (store) |
   | twin order | 3 (store + store + delivery) | 2 (store + store) |
   Split is `total − shippingPrice` per store, `shippingPrice` for delivery, and the twin
   combination fee rides on the delivery document. **Shoofi issues every one of them** —
   `createInvoiceOnBehalf` needs a store connected to HYP and none are — so the real seller
   is named as free text. Store documents follow invariant 9; the DELIVERY document is
   Shoofi's own revenue and always carries VAT.
   ⚠️ **The documents MUST sum to the amount charged** (`reconcileToCharge`). A customer
   adding up their documents and getting a different number than their card statement is
   the failure this whole module is shaped around; the planners are total-driven for that
   reason, never item-driven.
   ⚠️ Under the OLD path both gateways read line prices as **VAT-INCLUSIVE**, so zeroing
   VAT drops the VAT line without changing the total. Do not "correct" that into adding VAT
   on top.
   ⚠️ The document is issued at **capture**, never at authorization — a J5 hold is not a
   sale — and never fails the order: failures land on `order.invoices[]` and are retried by
   `utils/crons/invoice-retry-cron.js`, which is deliberately **not** gated on the flag so
   a rollback cannot strand a customer who paid while it was on.
   ⚠️ The customer document carries **`ua_uuid`** — Shoofi's EZcount user holds several
   businesses and this says which one issues it. `CUSTOMER_DOC_UA_UUID` in `amazonconfigs
   {app:"hyp"}` overrides the constant in `utils/hyp.js`; an **empty string there stops the
   field being sent**, which is the only rollback (there is no cancel path for per-order
   customer documents). **The settlement builders must never inherit it** — `createInvoice`
   shares the same `DISTRIBUTOR_API_KEY`, and `createInvoiceOnBehalf` issues with the
   store's own key where Shoofi's sub-account has no meaning. The three builders hand-list
   their keys and never spread `params`; keep it that way rather than adding a generic
   pass-through. Note `createInvoice` accepts a `storeUaUuid` that four call sites pass and
   it has **never sent** — a dead parameter, not evidence the field already flows.
   Reach: wallet orders always (unconditionally manual), card orders only where the flag is
   on — a gateway-issued document cannot take a `ua_uuid`, and `EZ.*` is an undocumented
   pass-through that can reject the whole charge, so do not try `EZ.ua_uuid`.
11. **Only admin-dashboard users may call the per-order invoice queue routes.**
   `/api/admin/invoices/{pending,retry,process-all,webhook}` (`routes/admin.js`) drive the
   `utils/invoice-mail.js` Gmail-fetch queue. Each route is `auth.required` +
   `checkAdminRole(DASHBOARD_ROLES)` (`invoiceQueueAdmins`), and no client, cron, bridge or
   server self-call reaches them, so customer, partner and driver tokens get 403. The
   webhook also keeps its body `INVOICE_WEBHOOK_SECRET` check. No provider calls it.
   ⚠️ **Never put lib/auth `restrict` on a JSON route.** Sessions are off in `app.js`, so it
   throws inside an async middleware and the request **hangs with no response**. Until
   2026-10-30 that is what `pending`, `retry` and `process-all` did.

## Method resolution — what the picker offers (UI-only)
`GET /api/payment-methods` (`routes/payment-methods.js`) decides the list; the app only adds
icons. Filters run in this order, and each one can only remove methods:
1. Platform flags on `shoofi.store{id:1}`. Credit card, Apple Pay and Google Pay are platform-only:
   the per-store `creditcard_support` is **never read**. Cash needs both
   `<store>.store.cash_support` and the platform `cash_support`.
2. OS, and Google Pay withheld below app 1.0.23.
3. Cash restrictions: `customers.cashRestricted`, plus the area's `cashRestricted` /
   `cashRestrictedFirstOrder`.
4. **School orders** (header `school-project: true`, sent by the app's cart in school mode):
   `filterSchoolPaymentMethods` (`utils/school-payment-methods.js`) drops a method only when
   `shoofi.store{id:1}.schoolSettings.supportedPaymentMethods[supportKey] === false`.
   - **This is a deny-list.** A missing key keeps the method, so a partial object can never hide
     everything. It is one platform-wide object, applied to every school order at every school
     store.
   - Edited on the admin "School settings" screen. `POST /api/admin/school-settings` writes
     each key with a dotted `$set`, so saving the hours and saving the methods never wipe each
     other. Keys are limited to `SCHOOL_PAYMENT_METHOD_KEYS`, with boolean values; anything
     else is a 400.

⚠️ **Hiding a method is UI-only.** `/api/order/create` does not check the payment method
against any of these rules, for any order, school or not. A stale or tampered client can still
send CASH. Enforcing the rules at order creation is a `routes/order.js` change and needs sign-off.

## Coupons between quote and charge (money-in view)
The server computes every coupon discount; the app only displays `discountAmount` and posts it
back in `appliedCoupon` with a client-computed `total` (`components/total-price`). There is ONE
formula module, `utils/coupon-discount.js` (`computeCouponDiscount`), used by
`/api/coupons/apply`, the auto-apply scorer (`routes/coupon.js`), amend and shadow pricing
(`utils/order-pricing.js`). Creation re-checks ownership and partial-use balances only
(`enforceCouponEntitlement`) — **except** for the fixed-delivery-price type.
Creation does NOT notice a total lower than items + fee − coupon − deals − coins with nothing to
explain it (shadow pricing records the drift and the order is kept), so the app must send the
coupon its total took off: TotalPrice is its only writer (reference.md, "Coupons").

**What is advertised** — `GET /api/coupons/active` feeds the store-page carousel AND the home
store-card tag (shoofi-app `couponsStore.activeCoupons`, label `t(storeTagName)`). It lists public,
auto-apply coupons **running at this hour** (`isWithinActiveHours`, same check as apply and
auto-apply) and **includes public `isFreeDelivery` campaigns** — only `isForNewUser`,
customer-specific and purchased coupons are left out. Both were wrong until 2026-10-27: a
12:00–18:00 coupon was shown all morning while checkout applied the 08:00–12:00 free-delivery one,
which was never shown at all. The home screen reloads the list on focus. A public coupon needs a
`storeTagName` or its card tag is an icon with no text; coupon drafts fill it from `nameForStore`.

**Fixed delivery price** — `type: 'delivery_price'`, `discountType: 'delivery'`,
`deliveryPrice: X` (what the customer pays for delivery), `value` = `maxDiscount` = the cap
(required, > 0), always `splitType: 'percentage'`, never `allowPartialUse` / `isFreeDelivery`
(admin create/update refuse those shapes).
- Discount = `min(cap, max(0, fee − X))`, rounded to 2dp — `computeDeliveryPriceDiscount`.
  `computeCouponDiscount` dispatches on the TYPE first, before partial use or the generic cap;
  anything malformed (missing price/cap, fee ≤ 0) is ₪0.
- **It is its own type so it FAILS CLOSED:** any reader that does not know it falls to
  `default: return 0`, and `isCashValuedCoupon` is false (never a wallet cash balance).
  Do not re-model it as `fixed_amount` — every un-updated reader would then compute
  `min(cap, fee)` or show ₪cap as money.
- Auto-apply calls the shared formula for this type (the scorer's own branches are for the
  other types) and **drops a ₪0 result**, so a fee ≤ X never wins as a ₪0 "coupon applied".
- **Client-feature gate:** it is shown only to bundles sending
  `x-client-features: delivery-price-coupon` (`utils/client-features.js`; OTA-safe, unlike
  `app-version`, which is the binary). Without it the coupon is filtered from active,
  available, customer-available, wallet and auto-apply; app-type `shoofi-admin` is exempt.
  Older bundles would be CHARGED correctly (the server computes the discount) — the gate is
  about what they would show.
- `/api/coupons/apply` errors: **400 `APP_UPDATE_REQUIRED`** (bundle lacks the feature) and
  **400 `COUPON_NO_DISCOUNT`** (₪0 on this order — fee ≤ X, or takeaway). The response carries
  `deliveryPrice` on the coupon; that snapshot is what lands on `order.appliedCoupon.coupon`
  and what amend re-prices from, so never drop it from the hand-listed response.
- **Why creation recomputes it, and only it:** every other delivery coupon is bounded by its
  own value, but this discount grows with `shippingPrice`, which the client posts and nothing
  else validates. An inflated fee costs the customer nothing (they pay X either way) and the
  difference lands on Shoofi/store funding and, on cash, the courier reimbursement.
  `enforceDeliveryPriceCoupon` (`services/coupons/delivery-price-enforcement.js`, called in
  `/api/order/create` after promotions) re-reads the coupon DOCUMENT, bounds the fee by
  `resolveDeliveryTariffCeiling`, subtracts a kept store delivery deal, and keeps
  `min(posted, server)`; ₪0 drops the coupon (no `couponUsages` row). A failed check drops it
  too. Twin: `enforceTwinSideDeliveryPrice` — one ₪X on the primary's fee, none on the
  secondary.
- **Correct, never reject — the charge consequence.** The guard only ever lowers the discount,
  so it RAISES `total` by `removed` and records `deliveryPriceCouponEntitlement`.
  - Card / HYP token / HYP native wallet: charged after the guard, so the corrected total is
    what is charged. Twin card capture sums the persisted side totals (`computeCombinedTotal`),
    so it charges the corrected amount too.
  - ZCredit Apple/Google Pay (sheet amount fixed before create): `finalizeApplePayOrder`'s
    mismatch backstop sees charged < total → **FRAUD_REVIEW**. That is invariant 3 working;
    do not "fix" it by skipping the guard for wallets.
  - ⚠️ Flagged, no verdict: the HYP hosted page (`paymentProvider: 'HYP'`, paid before create)
    and twin digital placement have **no** amount backstop (twin is exempt), so a correction
    there leaves charged < `order.total` silently — only `deliveryPriceCouponEntitlement`
    records it. A legitimate current client posts the server's number, so this fires on a
    tampered or stale fee, or where the tariff ceiling disagrees with the app's area price.

## Known status (human-confirmed — do NOT "fix")
- **KNOWN, tied to the migration:** CVV is stored in plaintext on `shoofi.creditCards` today.
  HYP tokenization does not store CVV; this resolves as ZCredit is retired. **Do not
  independently rip out CVV handling.**
- **CONFIRMED — remove (backlog):** `hyp-test-soft` debug endpoint in `routes/hyp-pay.js`
  (charges 1 NIS with a saved token) should not exist in prod. Money file → draft HIGH-RISK PR,
  confirm nothing calls it.
- **CONFIRMED — remove (backlog):** legacy client-side ZCredit charge/refund in `shoofi-app`
  (`components/credit-card/api/payment.ts`, `refund.ts`) — terminal number + password in client
  state. Verify zero live references first, then delete.
- **Flagged, needs verdict:** `updateCCPayment` references an undefined `orderId` in its
  background block; `refundPartial`'s ZCredit field shape is unverified across terminals
  (sandbox first).
- **RESOLVED by manual invoicing:** the exempt document's TITLE used to be unfixable —
  neither gateway publishes a per-transaction document-type parameter, so `EZ.type` and
  ZCredit's `Type` were guesses that could reject a live charge. Issuing the document
  ourselves makes it a documented `createDoc` field: 320 (חשבונית מס/קבלה) normally, 400
  (קבלה) when exempt — `customerDocType` in `order-invoices.js`. The old gateway path still
  cannot set it, which is one more reason the flag is the direction of travel.
- **UNVERIFIED against a real document:** the local HYP test masof (`0010332520`) has the
  EZcount **invoicing module disabled** — charges return no `Hesh` field and every
  `PrintHesh` link answers "קובץ PDF חתום עדיין לא הופק במערכת". Live local runs therefore
  prove the request payloads and nothing about the rendered document. Before trusting
  either path in production, confirm on a masof with invoicing enabled that: the exempt
  document is titled קבלה with no VAT line, and the document total equals the amount
  charged.
- **`hyp_enabled` is a PLATFORM tokenization switch, NOT a chargeability gate.** It lives on the
  `app-name: "shoofi"` config document and is served through `SHOOFI_CONFIG_PUBLIC_FIELDS`
  (`routes/store.js`), alongside rollout flags like `isTwinEnabledForAll`. It has **zero**
  server-side readers — no charge path consults it. Its only live consumer is
  `openNewCreditCardDialog` in `shoofi-app/components/payment-method/index.tsx`, which uses it
  to pick the HYP hosted tokenization flow over the legacy ZCredit add-card form. Because
  credentials are central (invariant 1), **a saved HYP card is chargeable for any store**, and
  `routes/order.js:2758` correctly routes such cards without checking this flag.
  ⚠️ A per-store `storeData` never carries `hyp_enabled`, so any per-store check against it
  evaluates falsy for every store. `shoofi-app/helpers/hyp-card.ts` `isCardUsable(card,
  storeData)` is written that way and has **zero call sites** — wiring it up as typed would
  block every HYP card at every store. It was reconstructed from a deployed OTA bundle, so its
  semantics are a reconstruction, not recovered intent. **Do not wire it up; deletion or a
  corrected signature is a human decision.**

## Recipe — touching a charge path
1. Identify which of the three paths you're in (CC / HYP token / digital-wallet) and say so in
   the PR. Prefer HYP (migration direction).
2. Keep the diff minimal; preserve the idempotency guard for that path (invariants 2–4).
3. Add a "what could break" section + rollback note. Never test against live provider
   credentials — sandbox only.

## Definition of done
Inherit `_shared-guardrails.md` §7, plus: state exactly which money flow the change affects and
how idempotency is preserved; never claim a provider call was tested without a sandbox; never
weaken client-trusts-totals, single-capture, or the mismatch backstop without sign-off.
