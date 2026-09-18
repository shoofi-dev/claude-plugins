---
domain: payments
last-verified: shoofi-server@561e3ca / 2026-07-28
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

## Known status (human-confirmed — do NOT "fix")
- **KNOWN, tied to the migration:** CVV is stored in plaintext on `shoofi.creditCards` today.
  HYP tokenization does not store CVV; this resolves as ZCredit is retired. **Do not
  independently rip out CVV handling.**
- **⚠️ The stored card is not the only copy — the ORDER carries one too, with the terminal
  password beside it.** `processCreditCardPayment` (`routes/order.js`) builds `paymentPayload`
  with `Password: zdCreditCredentials.credentials_password` and `CVV: paymentData.cvv`, then
  persists it verbatim as `paymentData.payload` on the **success return, the failure return
  and the exception return** alike. It lands on the order as `ccPaymentRefData.payload`.
  Measured 2026-08-18: **27,960 orders across 152 live stores** carry it, 27,767 of them with
  both a `CVV` and a `Password` key. `redactPaymentSecrets` (`routes/order.js`) sanitises only
  `order.paymentData` and **does not reach `ccPaymentRefData`**, and no read path projects it
  away — `POST /api/order/admin/all-orders` returns whole order documents in both its
  cross-store and single-store branches, so it is served to the admin dashboard today.
  Not a migration artefact that ages out: the ZCredit charge path still writes it on every
  charge. Fixing it is a money-file change and a human decision (draft HIGH-RISK PR, and a
  backfill is a separate question) — **but any NEW reader of `orders` must project
  `ccPaymentRefData` leaf by leaf and never select the parent object.**
  `services/exec-dashboard/orders-metrics.js` `ORDER_PROJECTION` is the worked example.
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
