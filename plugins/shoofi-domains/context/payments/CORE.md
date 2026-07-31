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
