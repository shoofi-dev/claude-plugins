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

## 3b. Coupons between quote and charge (map)
Where a coupon's discount is computed, re-computed or trusted on the way to a charge. Fixed
delivery price (`type: 'delivery_price'`) rules are in CORE; this is the call-site map.
| Point | Where | What happens |
|---|---|---|
| Formula | `utils/coupon-discount.js` `computeCouponDiscount` → `computeDeliveryPriceDiscount` | the only implementation; type dispatch first; `isCashValuedCoupon` false for this type |
| Split | `utils/coupon-discount.js` `resolveCouponSplit` (moved from `routes/coupon.js`) | percent split of the discount actually given — quote, creation guard and amend all use it |
| Quote | `POST /api/coupons/apply` | feature gate → `APP_UPDATE_REQUIRED`; ₪0 → `COUPON_NO_DISCOUNT`; response coupon carries `deliveryPrice` |
| Auto-apply | `GET /api/coupons/auto-apply/:customerId` `scoreCoupon` | this type scored by `computeCouponDiscount`; ₪0 results filtered before ranking; `belowMinimum` carries `deliveryPrice` |
| Lists | active / available / customer-available / wallet | `visibleToClient` hides the type from bundles without `delivery-price-coupon` (admin exempt) |
| Creation | `/api/order/create` → `enforceDeliveryPriceCoupon` | doc-based recompute, fee ≤ area tariff, minus kept delivery deal, `min(posted, server)`; raises `total` by `removed`; `deliveryPriceCouponEntitlement` |
| Twin | `/api/twin-order/place` + `digital-place-pending` → `enforceTwinSideDeliveryPrice` | primary fee only; secondary's claim removed |
| Shadow | `utils/order-pricing-shadow.js` | observation only; the total uses the client's coupon |
| Charge | `processCreditCardPayment` / `processHypTokenPayment` / `processHypWalletPayment` / `finalizeApplePayOrder` / `captureCombined` | charge `order.total` (or the combined persisted totals); nothing recomputes a coupon |
| J5 | `services/payments/order-authorization.js` | hold = `computeAuthAmount(total)`; capture reads `order.total` |
| Amend | `routes/order-amend.js` → `calculateOrderPricing` | re-prices from the order's coupon SNAPSHOT, never the document; this type may shrink, never grow (`amendedDeliveryPriceDiscount`); split re-written with it; non-numeric total → 409 `AMEND_UNPRICEABLE` (orders owns amend) |
| Refund / recharge | `refundOrderPayment`, `services/payments/order-recharge.js` | `capturedAmount` / `order.total` — no coupon math |

Fee source at each point: the app's `availableDrivers.area.price` (takeaway → 0) at quote; the
client-posted `shippingPrice` at creation (bounded by `resolveDeliveryTariffCeiling` for this
type and for store delivery deals only); the frozen `order.shippingPrice` at amend. A delivery
deal and a delivery coupon never both stay on one order (`resolveDeliveryConflict`: the larger
wins, a tie goes to the deal). Settlement readers of the snapshot are the `accountant` domain.

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

**The queue is in memory.** `pendingInvoices` is a `Map` in the process. A restart or deploy
drops it, and the order keeps `invoiceStatus: "pending"` with nothing left to retry it.
Prod on 2026-10-30, across 188 store DBs: 41,351 `completed`, 4,122 `none`,
**2,916 `pending`** (newest 2026-09-22) and 12 `failed`. `docId` is a number on most orders.
Flagged with no verdict: whether those pending orders should be re-queued.

**Admin routes** (`routes/admin.js`, CORE invariant 11). Every one is `auth.required` plus a
role check, and no client calls any of them.
| Route | Roles | What it does |
|---|---|---|
| `GET /api/admin/invoices/pending` | `DASHBOARD_ROLES` | the size of this process's in-memory queue (one instance; prod runs two) |
| `POST /api/admin/invoices/retry` `{docId}` | master, admin | queues one `docId` |
| `POST /api/admin/invoices/process-all` | master, admin | queues every `invoiceStatus:"pending"` order in the **`app-name` header's** DB (one store, `shoofi` when absent) |
| `POST /api/admin/invoices/webhook` `{docId, secret}` | master, admin | fetches now, falls back to the queue. Also needs `secret === INVOICE_WEBHOOK_SECRET`, which is not in `.env.production` (the DO app spec was not checked). No provider calls it. |

The queue keeps the whole `req` and reads only `req.app.db` and the `app-name` header from
it. It makes no HTTP call that carries request headers. `retry` puts `docId` into the Gmail
query (`subject:<docId>`) and the public Spaces key (`invoices/doc-<docId>.pdf`) unvalidated.
Until 2026-10-30, `pending`, `retry` and `process-all` carried lib/auth `restrict`, which
hangs the request (CORE invariant 11), so none of them answered.

## 6. Refunds (customer-side — you own these)
- **`POST /api/order/addRefund` is GONE** — removed in shoofi-server 29ed5252 (HQ #7e2d32,
  2026-11-03). It was bookkeeping only (pushed `refundData[]`, no provider reversal, no auth);
  its only callers were the client refund dialogs removed under HQ #1a2f9e, and no store DB
  held a `refundData` row. Do not look for it or restore it. A cancel's money is decided by
  `settleCancelledOrderMoney` in `routes/order.js` (`cancelMoneyDecision`: `refund` →
  `orderAuthorization.refundOrderPayment` releases a hold or flags a settled charge for a
  person; `keep` → the charge is captured/kept and `services/payments/cancel-compensation.js`
  issues a Shoofi-paid `COMP-*` coupon). A twin leg's refund is always flagged for a person
  (`refund_twin_order_manual`). Note: the comment above `CANCEL_MONEY_DECISION` still says
  KEEP's coupon is created by hand — stale since cancel-compensation.js; the code issues it.
- **Twin combined capture** (`services/twin-order/twin-payment-service.js`): one ZCredit
  charge for primary+secondary+combination fee (`captureCombined`, money IN); retryable.
  `refundPartial` (negative `TransactionSum`) is gated behind `twinOrderConfig.degradeAutoRefund`,
  ZCredit field shape **unverified across terminals — sandbox first**.
→ **Store/driver payouts (MASAV) and settlement refunds are the `accountant` domain, not yours.**

## 6b. Kopa till money (phase 4d) — bookkeeping, separate from HYP charges
shoofi-server `services/kopa/till-money.js`, `routes/kopa/till-money.js`, and the totals and
payment idempotency in `services/kopa/till-orders.js` (`feat/kopa-phase1`, 2026-11-12).
Tests: `test/integration/kopa/till-money.js`. The till order is orders CORE invariant 30 /
reference C5.
- **What it is NOT.** It processes no card and calls no gateway. It writes only
  `kopaTillOrders` (store DB), plus the PIN try counter in central `kopaSessions` /
  `kopaStaffPins`. The test spies fail on ANY call to `orders`, `paymentAuth` or
  `creditCards`, and on any write outside `kopa*`. A till refund records that the store gave
  money back from its drawer, its own terminal or by transfer. It never reverses a provider
  charge, and it is unrelated to §6, the cancel money decision and the money ledger.
- **Every route is `KOPA_TILL`** (cashier or all). The store comes from
  `req.storeMembership.appName`.
  - `POST /api/kopa/till/orders/:id/discount`
    - Body: `{ type: percent|fixed, value, reason, managerPin }`. Returns 200 `{ order }`.
    - percent is > 0 and ≤ 100. fixed is > 0 and ≤ subtotal (else 400 `DISCOUNT_TOO_LARGE`).
    - 409 `STAFF_MEAL`, `EMPTY_ORDER`, `ORDER_NOT_OPEN` or `BELOW_PAID`.
    - Applying again replaces the discount, and the old one goes into `discountLog` (last 20).
  - `DELETE …/:id/discount` with `{ managerPin }`.
    - Sets `discount: null` and logs the removed discount with `removalApprovedBy`.
    - 409 `NO_DISCOUNT` when there is none.
  - `GET …/:id/discount/suggest` is read only. It returns `{ suggestion: null | { source:
    "standing", profileId, type, value, amount, needsManagerPin, applicable, code } }`.
  - `POST …/:id/tip` with `{ type, value }`. `value: 0` removes the tip. No PIN.
    - 409 `STAFF_MEAL`, `EMPTY_ORDER` or `BELOW_PAID`.
  - `POST …/:id/refunds`
    - Body: `{ lines?: [{ lineId, qty }], amount?, method: CASH|EXTERNAL_CARD|TRANSFER|OTHER,
      reason, managerPin, clientRefundId? }`.
    - Returns 201 `{ order, refund, replay: false }`, or 200 with `replay: true` for a repeated
      `clientRefundId`.
- **Document fields** (on `kopaTillOrders`):
  - `discount = { type, value, amount, reason, source: manual|standing, profileId?,
    approvedBy: { staffId, name } | null, by: { staffId, staffName }, at }`.
  - `tip = { type, value, amount, by, at }`.
  - `refunds[] = { refundId, amount, method, lines, reason, approvedBy, by, at,
    clientRefundId? }`, plus `refundedAmount`.
  - On a refunded line: `refundedQty` and `refunded`.
  - On a payment: `clientPaymentId?`.
  - On the order: `amountDue`.
- **Money math** (`computeTotals` in till-orders.js, agorot integers).
  - discount = percent of the subtotal (`round(subtotalC × value×100 / 10000)`, half-up) or
    fixed, then capped at the subtotal.
  - total = subtotal − discount, or 0 for a staff meal.
  - tip = percent of total, or fixed.
  - amountDue = total + tip. balance = amountDue − paidAmount.
  - Every line change re-computes the discount and the tip. A fixed discount cannot push
    the total below 0 after a line is cancelled.
  - A discount, tip or line change that would make amountDue < paidAmount is 409
    `BELOW_PAID`. An open order is never refunded.
- **Paid.** An order is paid when the non-UNPAID payments reach `amountDue`, not `total`.
  UNPAID records the whole `balance`, tip included.
- **Manager PIN.** `verifyManagerPin` (customers reference 5g) is called with
  `session: req.kopaSession` when the caller has a Kopa session. Otherwise it is called with
  `callerStaffId: req.storeMembership.me._id`.
  - No PIN → 403 `MANAGER_PIN_REQUIRED`, and no try is spent.
  - Wrong PIN or a non-manager's PIN → 403 `MANAGER_PIN_INVALID`.
  - Locked → 429 `PIN_LOCKED` with `Retry-After`.
  - The PIN is checked after the cheap validation and after a pre-read of the order. The
    write then re-validates everything.
- **Standing discount without a PIN (a decision).** All of these must hold:
  - the order's `customer.profileId` is a `kopaCustomerProfiles` doc;
  - its `standingDiscount` has the same type and value as the request (compared in agorot);
  - the profile phone equals the order's customer phone (`normalizePhone`).

  The owner set that discount on the profile, so applying it unchanged is not a new
  decision. Anything else needs the PIN. A PIN sent anyway is verified and recorded.
  Residual risk: the cashier chooses which profile is on the order. That is why
  `source: "standing"` and `profileId` are stored, so that reports can surface it.
- **Refund amount.**
  - `amount` wins when it is sent.
  - Otherwise the amount is the lines' value at the order's discount ratio:
    `round(Σ unitPriceC×qty × totalC / subtotalC)`.
  - Σ refunds ≤ paidAmount (409 `REFUND_TOO_LARGE` or `NOTHING_REFUNDABLE`, with
    `refundable`).
  - A line qty above `qty − refundedQty` is 409 `REFUND_QTY_TOO_LARGE`. A cancelled line is
    409 `LINE_CANCELLED`. A non-paid order is 409 `ORDER_NOT_PAID`.
  - `status` stays `paid`. Lines are never removed or cancelled, so subtotal and total do
    not move.
- **Idempotency.**
  - Every money write is CAS `{ _id, status, rev }` + `$inc: { rev: 1 }`, with 0 retries.
    Of two concurrent writes, one wins and the other gets 409 `CONFLICT`.
  - `clientPaymentId` / `clientRefundId` (uuid, compared lower-cased) are checked inside the
    CAS read, so a replay writes nothing. A replay also works on a paid order.
  - On a lost CAS, the order is re-read. If the twin request's entry is there, the loser
    answers it with 200 `replay: true`.
  - The same id with another method, amount or set of lines is 409
    `CLIENT_PAYMENT_ID_REUSED` / `CLIENT_REFUND_ID_REUSED`.
  - A replay needs no PIN. It writes nothing and returns only what a `KOPA_TILL` GET returns.
  - `POST /:id/payments` now answers 201 for a new payment and 200 for a replay.
- **Not built:** receipts or tax documents for till refunds and discounts (till receipts are off:
  orders CORE invariant 30, phase 6), and any link from a till refund to a provider.

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
   Order CREATION corrects one coupon type before the charge (`delivery_price`, §3b) —
   it only ever raises `total`, never rejects.
5. **Coins/coupons settle only AFTER payment success**; failures are logged CRITICAL for
   manual reconciliation, never rolled back against an irreversible capture.
6. **Order dedup lock** (Redis `SET NX` + fallback + 30s window) prevents double charges.
7. **Cancel money is settled once, and "nobody decided" is recorded as such** (CORE invariant
   12, orders CORE invariant 27): `cancelMoneyDecision` ∈ keep/refund/undecided;
   `paymentAuth.refundRequiredReason` reasons written on cancel are `captured_before_cancel`,
   `release_refused_ccode_*`, `release_error` (release), `refund_*` (explicit refund) and
   `cancel_no_decision` (an undecided settled single charge, written by `routes/order.js`).

## App — shoofi-app (customer) payment client
- **Method resolution**: `helpers/get-supported-payment-methods.ts` → GET `payment-methods`;
  **the server decides** which methods are active (geo/store/coupon rules); client only
  merges icons. Coupon stores drop CASH; a twin cash filter is **commented out** (inactive).
  The cart's school mode (`cartStore.getIsSchoolProject()`, AsyncStorage
  `@storage_isSchoolProject`) is sent as the `school-project` header. The server then applies
  the school deny-list described below.
- **School payment methods** (server): `utils/school-payment-methods.js`.
  - `filterSchoolPaymentMethods(methods, schoolSettings)` runs **last** in
    `routes/payment-methods.js`, after the platform/store/OS/cash-restriction filters, and only
    when `school-project` is true. It hides a method only when
    `schoolSettings.supportedPaymentMethods[supportKey] === false`; a missing key, or no object
    at all, keeps the method.
    - Until 2026-10 this was an **allow-list** (`=== true`), so a partial object such as
      `{cash_support:false}` hid every method. Prod never had the field, so the switch changed
      nothing live.
  - The admin screen is shoofi-delivery-web `views/admin/schools/SchoolSettings.tsx`. It always
    sends all four keys, and defaults to on when the GET returns `supportedPaymentMethods: null`.
  - `GET/POST /api/admin/school-settings` (`routes/shoofi-admin.js`) use `{id:1}`. The POST
    writes `schoolSettings.orderStartTime`, `schoolSettings.orderEndTime` and
    `schoolSettings.supportedPaymentMethods.<key>` as **separate dotted `$set`s**, and only for
    the fields the body carries.
    - The old handler replaced the whole `schoolSettings` object. Never go back to that: it
      silently erased the methods every time someone saved the school hours.
    - `validateSupportedPaymentMethods` rejects unknown keys and non-boolean values with a 400.
  - **Not enforced at order creation.** This control is UI-only (see CORE "Method resolution").
- **CC tokenization (live)**: HYP hosted WebView (`hooks/checkout/use-hyp-tokenize.ts`,
  `components/credit-card/HypTokenizeWebView.tsx`) — card entered in the hosted page, never
  in RN; result URL carrying `CCode` is intercepted (navigation blocked) and forwarded to
  `payments/hyp-process-token`. Saved cards via `stores/creditCards` (`/credit-cards` CRUD).
  - **Managing saved cards** (shoofi-app PR #99): `screens/credit-cards` (route `credit-cards`) opens
    from the profile row «بطاقات الدفع» (logged-in only) and is also rendered inside checkout's
    card sheet (`components/CreditCardModal`, with `onClose`). Expiry is shown from `tokef`
    (YYMM) via `helpers/credit-card-display.ts`; expired cards cannot be made default (UI-only:
    an expired default that is already set is still preselected at checkout). Delete confirms
    in an in-app sheet (`components/credit-card/DeleteCardSheet.tsx`). Adding a card from the
    profile uses the same HYP hosted page (platform `hyp_enabled`, no store needed).
- **Apple/Google Pay**: ZCredit WebCheckout session created **client-side** (`screens/checkout/
  index.tsx`, `data/zcredit-config.ts`) with `zcredit_api_key`; heavy dedup/retry guards;
  server verifies & captures. Google Pay routed through the ZCredit web-view (native button disabled).
- **What the client sends**: CC → `paymentData.ccToken` (+cvv/id) into `order/create`; the
  **actual charge is server-side** (`use-checkout-charge-cc.ts` is a deprecated no-op). Apple
  Pay → no card token, just session id; server reads the ZCredit session for the amount.
- **Coupons**: the app never computes a coupon discount — it shows the server's
  `discountAmount` (auto-apply and manual re-validate in `components/total-price/index.tsx`)
  and posts it in `appliedCoupon` (`hooks/checkout/use-checkout-submit.ts`, read from
  `couponsStore.appliedCoupon`). **The coupon submit sends is the one the total was priced with**:
  `couponsStore.getAndApplyAutoCoupons` / `applyCoupon` only quote, and TotalPrice's
  `commitCoupon` writes its own state and `couponsStore.setAppliedCoupon` together, only from a
  response its effect has not superseded. Before this, a late, superseded auto-apply answer
  wrote the store directly, so an order went out at the discounted total with
  `appliedCoupon: null` (no couponUsages row; 8265-1164, GCP 5194-1334 on 2026-10-27).
  **A coupon the total did not use is not sent either.** TotalPrice puts one flag on
  `promotionsStore.setCheckoutSelection({ couponSuppressed })`; `use-checkout-submit.ts` sends
  `appliedCoupon` only when it is false, and the twin split (`splitCouponForTwin`) gets `null`.
  It is true in two cases: (1) a delivery coupon that lost to the store's delivery deal (orders
  CORE invariant 13); (2) since shoofi-app#87, a delivery coupon (`helpers/delivery-price-coupon.ts`
  `isDeliveryCoupon`: `type` `free_delivery` / `delivery_price` or `discountType: 'delivery'`) on a
  pickup or drive-in order (`isDeliveryCouponOffForMethod`). Either way the card shows it as "not
  used on this order" (`notUsedReason`; case 2 says «التوصيل غير مشمول في الاستلام»), the total takes
  nothing off, and a one-time coupon is not spent on ₪0. In case 2 the app does not ask
  `/api/coupons/apply` (a fixed-price coupon would come back `COUPON_NO_DISCOUNT` and be dropped);
  it keeps the coupon with `discountAmount: 0`, and switching back to delivery re-quotes it with
  the real fee. **Server gap, not closed:** creation does not drop a ₪0 `free_delivery` /
  `discountType: 'delivery'` coupon on a non-delivery order (only the `delivery_price` type is
  re-priced and dropped, orders CORE invariant 14), so an older bundle that still sends one gets a
  ₪0 `couponUsages` row from `buildCouponUsageDocs` (`services/coupons/coupon-usage.js`).
  Checkout also clears a store coupon left from an earlier visit on mount. It declares what
  its bundle can render in `x-client-features` (`consts/shared.ts` `CLIENT_FEATURES`, sent by
  `utils/http-interceptor`); `delivery-price-coupon` unlocks fixed-delivery-price coupons.
  A merged change to that list reaches phones only with `eas update`.
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
  `refund.ts` + the `refund-confirm` dialog removed from all three apps (HQ #1a2f9e);
  `payment.ts` (all 3) and `validate-card.ts` (partner, shoofir) remain.
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
