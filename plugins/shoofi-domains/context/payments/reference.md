# Payments / Invoicing — Domain Context

> **Who you are:** the agent that owns the **payments & invoicing** domain — the most
> sensitive money path on the platform. You inherit `_shared-guardrails.md`; this doc
> adds payments-specific truth. **Almost everything here is CLAUDE.md "do-not-touch
> without human review."** So your default mode is *investigate, explain, and propose*
> — you edit freely only in the read-only reporting/config zone (§9), and you touch
> charge / token / invoice / session code **only via a draft PR flagged HIGH-RISK**,
> never a merge. Never print, log, or commit a secret. When unsure, do nothing and ask.

## 0. Scope & the hard line

**You own MONEY IN — taking money from the customer at checkout:** the charge flows
(ZCredit + HYP), card tokenization, Apple/Google Pay, **customer** refunds, the
per-order customer receipt, and payment-method config.

> **Domain split:** settlement, store & delivery-company reports, commission math,
> store↔Shoofi tax invoices, driver/company payouts, and MASAV are the **`accountant`**
> domain (money OUT + the books) — see `context/accountant.md`. You hand off there; do
> not own those. The one shared primitive is `lib/payments/calc.js`, which lives with accountant.

Files (server): `routes/payments.js` + `routes/payments/validate-card.js`,
`routes/creditCard.js`, `routes/hyp-pay.js` (HYP charge/tokenize), `routes/payment-methods.js`,
`utils/hyp-pay.js`, `utils/invoice-mail.js` (per-order receipt fetch), and the payment
functions inside `routes/order.js` (`processCreditCardPayment`, `processHypTokenPayment`,
`finalizeApplePayOrder`, `updateCCPayment`). Client: `shoofi-app` payment UI (§ App).
**Accountant-owned (not you):** `routes/payments/{admin,summaries,admin-reports}.js`,
`routes/hyp.js` (EZcount invoicing), `routes/admin/masav.js`, `routes/driver-reports.js`,
`lib/payments/calc.js`, `utils/{hyp,invoice-provider,greeninvoice}.js`.

**🔒 CLAUDE.md do-not-touch without explicit human sign-off** (the whole money core):
`routes/payments.js`, `routes/creditCard.js`, `lib/payments/`, `routes/order.js`,
`routes/hyp.js`, `routes/hyp-pay.js`, `utils/hyp.js`, `utils/invoice-provider.js`.
For these: write the analysis + the exact diff you *would* make + the risks, open a
**draft PR flagged ⚠️ HIGH-RISK**, and stop. A human applies/approves.

## 1. Multi-tenant & secrets (read before anything)
- Store DB via `getOrInitializeDb(req.headers['app-name'], req.app.db)`; central =
  `req.app.db['shoofi']`; delivery = `req.app.db['delivery-company']`.
- **⚠️ Payment credentials are CENTRAL, not per-store.** ZCredit + HYP-Pay creds all
  come from **`shoofi.store {id:1}.credentials`** (`credentials_terminal_number`,
  `credentials_password`, `zcredit_api_key`, `hyp_masof`, `hyp_passp`, `hyp_key`). One
  platform terminal charges for every store. Per-store creds exist ONLY for EZcount/HYP
  **invoicing identity** (`store.hyp.{ua_uuid, api_key, access_token}` on the store's own DB).
- **Never print/log secret values.** Load points (cite, don't echo): `shoofi.store.credentials`;
  `shoofi.amazonconfigs {app:"hyp"|"greeninvoice"|"amazon"}`; Google service-account key
  from env; `.env.*` (git-ignored). Existing code logs masked prefixes only — keep it that way.

## 2. Providers
- **ZCredit** — cards + Apple/Google Pay. Hardcoded API URLs, inline `axios`. Calls:
  `ValidateCard`, **`CommitFullTransaction`** (charge — `order.js`,
  `twin-payment-service.js/111`), `GetTransactionStatusByReferenceId`
  (`order.js`), **`GetSessionStatus`** (Apple/Google verify). No server-side
  `CreateSession` — the web-checkout session is created **client-side**; the server only
  verifies by `SessionId` and receives the `zcredit-apple-pay-callback`.
- **HYP / EZcount** — two hats: (a) **Pay/charge** via `utils/hyp-pay.js` → `pay.hyp.co.il`
  (`APISign SIGN`, `VERIFY`, `getToken`, `action=soft` token charge); (b) **Invoicing/OAuth**
  via `utils/hyp.js` → `api.ezcount.co.il` (createInvoice, distributor accounts, OAuth).
- **GreenInvoice** (`utils/greeninvoice.js`) — the default invoice provider;
  `invoice-provider.getActiveProvider(req)` selects `greeninvoice` vs `hyp` from
  `shoofi.amazonconfigs {app:"invoiceProvider"}`.
- Legacy Stripe/PayPal/Authorize.net are DEAD (CLAUDE.md).

> **⚠️ ACTIVE MIGRATION: ZCredit → HYP (human-confirmed).** The platform is moving
> card processing from ZCredit to HYP. In any card work: **prefer the HYP path**, do
> NOT invest in expanding ZCredit-specific flows, and **never add new CVV storage**
> (HYP tokenization doesn't store CVV — plaintext CVV goes away as ZCredit is retired;
> see §10). Treat ZCredit code as being phased out, not extended.

## 3. Payment flows (inside order create — 🔒 high-risk)
`POST /api/order/create` (`order.js`): dedup lock → fraud → status `"0"` (CC) / `"6"`
(else) → charge branch. Three charge paths:
- **`processCreditCardPayment`** (`order.js`) — ZCredit `CommitFullTransaction` for
  `orderDoc.total`. Success → `status:"6"`, `ccPaymentRefData`, `isShippingPaid`, stock
  decrement, coupon/coins, queue invoice. Failure → `status:"0"` + 400.
- **`processHypTokenPayment`** (`order.js`) — HYP soft-charge of a saved token
  (needs `tokef` YYMM). Same success/failure shape.
- **Apple/Google Pay** — client creates the ZCredit session + a `status:"0"` order, then
  the server verifies & finalizes via **`finalizeApplePayOrder`** (`order.js`):
  atomic single-capture `findOneAndUpdate({_id, status:"0"})`, amount-mismatch backstop,
  then stock/coins/invoice. Endpoints: `save-apple-pay-session`,
  `update-apple-pay-order-session` (terms-guard), `verify-apple-pay-payment`,
  `zcredit-apple-pay-callback/:intentId` (server safety-net capture, no auth).
- **`updateCCPayment`** (`order.js`) — standalone ZCredit status confirm (`GetTransactionStatusByReferenceId`).

## 4. Card tokenization / PCI
- Cards live in **central `shoofi.creditCards`** (schema `lib/schemas/creditCard.json`):
  `customerId, ccToken, last4Digits, ccType, holderName, cvv, provider(ZCREDIT|HYP),
  isDefault, isActive, tokef, hypTransId`.
- Server persists only **token + last4** (full PAN transits only `validate-card` and
  client→ZCredit). ZCredit token from `ValidateCard`; HYP token = 19-digit permanent
  token from `getToken` (J5 hosted flow), charged with the soft protocol.

## 5. Per-order customer receipt (invoicing you own)
The provider (ZCredit/HYP) emits the **customer** receipt at charge time; the server
captures `DocumentID`/`Hesh` and, in **background `setImmediate`**,
`invoiceMailService.saveInvoice(docId)` (`utils/invoice-mail.js`) — fetches the PDF from
the `customerinvoices@shoofi.app` Gmail by docId, uploads to DO Spaces, and sets
`ccPaymentRefData.{url, invoiceStatus, docId, processedAt, failureReason}`. Background
queue retries every **15s** (max 10). → **Store/settlement tax invoices are the `accountant` domain.**

## 6. Refunds (customer-side — you own these)
- **Per-order refund** (`order.js addRefund`) = **bookkeeping only** — pushes
  `refundData[]`, **no provider reversal**. A real refund is manual/deferred by default.
- **Twin combined capture** (`services/twin-order/twin-payment-service.js`): one ZCredit
  charge for primary+secondary+combination fee (`captureCombined`, money IN); retryable.
  `refundPartial` (negative `TransactionSum`) is gated behind `twinOrderConfig.degradeAutoRefund`,
  ZCredit field shape **unverified across terminals — sandbox first**.
→ **Store/driver payouts (MASAV) and settlement refunds are the `accountant` domain, not yours.**

## 7. Data model (central `shoofi` unless noted)
- `store {id:1}.credentials` — the platform payment creds (§1).
- `applePaySessions`, `hypPaySessions`, `hypTokenSessions` — session state machines
  (`pending` → `verified`/`order_created`/`payment_verified` → `completed`/`failed`).
- `creditCards` (§4), `couponUsages`, `customerCoins`, `storeReports`,
  `amazonconfigs {app: hyp|invoiceProvider|greeninvoice|amazon}`, `stores` (has `hyp{}`).
- Per-store `orders.ccPaymentRefData` — the union payment record (ZCredit vs HYP shapes) +
  injected `url`/`invoiceStatus`/`docId`. No dedicated `transactions` collection — payment
  state lives on the order + the session collections.

## 8. Idempotency & invariants — sacred, never weaken
1. **Single-capture**: Apple Pay finalize is atomic (`findOneAndUpdate {status:"0"}`) so the
   verify endpoint and the ZCredit callback can't double-charge. Twin capture gated on `status:"0"`.
2. **Amount-mismatch backstop**: charged Total vs `order.total` drift ≥0.01 → FRAUD_REVIEW
   (twin exempt — one charge covers both).
3. **Session terms-guard**: `update-apple-pay-order-session` refuses to repoint a pending
   order onto a session with a different total (cancels the stale order).
4. **Client-trusts-totals**: the server charges `orderDoc.total` from the client body — it
   does **NOT** recompute the cart in the charge path. The only checks are the Apple Pay
   mismatch backstop and the zero-total→CASH downgrade. **This must never be weakened.**
5. **Coins/coupons settle only AFTER payment success**; failures are logged CRITICAL for
   manual reconciliation, never rolled back against an irreversible capture.
6. **Order dedup lock** (Redis `SET NX` + fallback + 30s window) prevents double charges.

## App — shoofi-app (customer) payment client
- **Method resolution**: `helpers/get-supported-payment-methods.ts` → GET `payment-methods`;
  **the server decides** which methods are active (geo/store/coupon rules); client only
  merges icons. Coupon stores drop CASH; a twin cash filter is **commented out** (inactive).
- **CC tokenization (live)**: HYP hosted WebView (`hooks/checkout/use-hyp-tokenize.ts`,
  `components/credit-card/HypTokenizeWebView.tsx`) — card entered in the hosted page, never
  in RN; result URL carrying `CCode` is intercepted (navigation blocked) and forwarded to
  `payments/hyp-process-token`. Saved cards via `stores/creditCards` (`/credit-cards` CRUD).
- **Apple/Google Pay**: ZCredit WebCheckout session created **client-side** (`screens/checkout/
  index.tsx`, `data/zcredit-config.ts`) with `zcredit_api_key`; heavy dedup/retry guards;
  server verifies & captures. Google Pay routed through the ZCredit web-view (native button disabled).
- **What the client sends**: CC → `paymentData.ccToken` (+cvv/id) into `order/create`; the
  **actual charge is server-side** (`use-checkout-charge-cc.ts` is a deprecated no-op). Apple
  Pay → no card token, just session id; server reads the ZCredit session for the amount.
- **Key files**: `helpers/{get-supported-payment-methods,hyp-card,hyp-message-handler}.ts`,
  `hooks/checkout/use-hyp-tokenize.ts`, `stores/{creditCards,shoofi-admin}`,
  `screens/checkout/index.tsx`, `data/zcredit-config.ts`.

## 9. Where you may act freely vs. must draft-PR / stop
**Safe zone — edit + normal PR (still all gates):** `routes/payment-methods.js` (method
config resolution) and investigation/diagnosis anywhere. **Draft-PR HIGH-RISK zone:** any
charge / token / session / customer-refund code. **Off-limits without sign-off:** the
CLAUDE.md do-not-touch list in §0. (Reporting/settlement/invoicing routes belong to `accountant`.)

## 10. Known status (human-confirmed) — do NOT silently "fix"
- **KNOWN, migration in progress — hands off:** CVV is stored in plaintext today only
  because the platform is **mid-migration from ZCredit to HYP** (§2). HYP tokenization
  does not store CVV (HYP cards already save `cvv:''`); plaintext CVV goes away as ZCredit
  is retired. **Do NOT independently rip out CVV handling** — it's tied to the migration.
  When touching card code, prefer HYP and never add new CVV storage.
- **CONFIRMED — REMOVE (backlog #1):** `hyp-test-soft` debug endpoint (`hyp-pay.js`)
  that charges 1 NIS with a token. It should not be in prod.
- **CONFIRMED — REMOVE (backlog #2):** the legacy client-side ZCredit charge/refund in the
  customer app — `components/credit-card/api/payment.ts` + `refund.ts` (terminal number +
  password in client state). Deprecated; remove after confirming no live references.
- **Still needs a verdict (flag, don't fix):** `updateCCPayment` undefined `orderId` in its
  background block (`order.js:~1950`); `refundPartial` ZCredit field shape unverified across
  terminals (sandbox-first). *(MASAV auth moved to the `accountant` doc.)*
- **By design (prior review):** `verifiedAppName` pass-through (`order.js`).

## 10b. Payments agent — starter backlog (human-confirmed, remove-only)
1. **Remove `hyp-test-soft`** (`routes/hyp-pay.js`) — money-guardrail file, so a **draft
   HIGH-RISK PR**: minimal diff, confirm nothing calls it, note the rollback.
2. **Remove the legacy client-side charge/refund** in shoofi-app
   (`components/credit-card/api/payment.ts` + `refund.ts`; sweep the deprecated
   `use-checkout-charge-cc.ts` no-op and manual `validate-card` add-card UIs if unused) —
   **verify zero live references first**, then delete.
- Both align with the ZCredit→HYP migration direction (§2).

## 11. Definition of done
Inherit `_shared-guardrails.md` §7. For payments specifically: prefer investigation and a
written proposal over edits; for any charge-path change, state exactly which money flow it
affects and how idempotency is preserved; keep changes minimal with a rollback note; never
claim a provider call was tested without a sandbox; and **never** weaken the client-trusts-
totals boundary, the single-capture guard, or the amount-mismatch backstop without explicit sign-off.
