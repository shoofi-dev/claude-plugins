---
domain: accountant
last-verified: shoofi-server@561e3ca / 2026-07-28
scope: shoofi-server (computation) + shoofi-delivery-web (the admin cockpit)
reference: ./reference.md   # report internals, invoice types, MASAV format, data model
---

# Accountant — CORE (always read)

**Money OUT + the books:** what stores and delivery companies/drivers are owed, tax
invoices, and bank payouts. Distinct from `payments` (money IN).

> **This is the highest-stakes correctness domain on the platform.** A wrong number here
> pays a real store or driver the wrong amount. Default to *investigate and propose*;
> touch computation via a **draft PR flagged HIGH-RISK**; never claim a payout formula is
> right without tracing the money end to end.

## Scope
Server: `routes/payments/{admin-reports,admin,summaries}.js`, `routes/driver-reports.js`,
`routes/admin/masav.js`, `routes/hyp.js` (EZcount invoicing), `lib/payments/calc.js`,
`utils/{vat,greeninvoice,invoice-provider}.js`. Client: the reports/payout screens in
`shoofi-delivery-web`.
**🔒 CLAUDE.md do-not-touch overlap:** `routes/hyp.js`, `utils/hyp.js`,
`utils/invoice-provider.js`, `lib/payments/`. You depend on `routes/order.js` for order
amounts but **never edit it**.
**Not yours:** charge acceptance/tokenization = `payments`; driver assignment = `delivery`.

## The mental model — CASH vs CARD (hold this before touching anything)
A customer pays `items + delivery + driveIn`. What happens next depends on **who physically
collected the money**:
- **CARD** → **Shoofi** captured it and is the hub: it pays the store its revenue (minus
  commission etc.) and pays the driver the delivery fee — outward, via MASAV.
- **CASH** → the **driver collected at the door**; it never touches Shoofi. The driver
  **keeps the delivery fee in cash** (`actualDriverPayment = 0` from Shoofi) and **owes the
  store the items money**. Shoofi still earns commission on cash orders — it recovers that by
  **deducting it from the store's card-based bank transfer**.

**Consequence:** a store's transfer is computed from **credit-card revenue only, minus ALL
outcomes** (including commission on cash orders). A mostly-cash store can have a **negative
balance** (owes Shoofi) → settled via a credit note (docType 330).

## Invariants — never weaken
1. **The transfer formula** (`generateStoreReportData` in `routes/payments/admin-reports.js`):
   `totalForTransfer = creditCardRevenue + driveInCreditCard − totalOutcomes`;
   `balance = totalForTransfer` — **no VAT adjustment, for any `businessType`**.
   `totalForInvoice = creditCardRevenue + driveInCreditCard`.
   **`exempt` (עוסק פטור) does NOT mean ÷1.18.** Such a store charges no VAT, so the
   collected price has no VAT component to strip — ₪100 taken on the card is ₪100 owed.
   The store invoices Shoofi for that same undivided amount (`vatType: 'NON'`, docType
   300 receipt, `routes/hyp.js` create-store-invoice), so payment and tax document
   reconcile. **They move together or not at all** — dividing one and not the other
   leaves the store paid ~15% off what its own document says.
   (Changed 2026-08-03; both were previously ÷1.18. `routes/driver-reports.js` still
   applies the old ÷1.18 rule to exempt **delivery companies** — deliberately left
   pending a separate decision, so the two payout paths currently disagree.)
2. **`actualDriverPayment` cash-vs-card branch** (`routes/driver-reports.js`): CARD → full
   `effectiveDeliveryFee`; CASH + coupon → the coupon-covered amount; **CASH, no coupon → 0**.
   A bug here **double-pays a driver who already pocketed the cash**.
3. **Commission base is the FINAL items price actually charged** — `order.orderPrice`,
   after the store's own product discounts. Store commission is **tiered**
   (`calculateCommissionTiered`, from `store.accounting.contract.commissionTiers`); the flat
   15% in dashboards is **not** the authoritative settlement number.
   `stores-export-new` carries both `totalRevenueCreditCard/Cash` (= what Shoofi captured)
   and `totalProductDiscount*` (= `originalPrice − orderPrice`). **The product discount is
   reported for visibility only** — it enters neither `revenueForCommission` nor
   `totalIncomes` / `totalForTransfer` / `totalForInvoice`. A store discounting its own
   items therefore reduces Shoofi's cut proportionally, and that is intended.
   Still **inside** the commission base: coupon money Shoofi reimburses to the store
   (`totalCustomerSpecificCoupons`), Shoofi compensations, and drive-in — the latter read
   as `order.driveInPrice || order.driveInPricing?.price` (`routes/payments/admin.js`
   `stores-export-new`), the fallback chain older documents need. Coins are commissioned
   separately at `coinsCommissionPercent`.
   **Outside it: `shippingPrice`.** The delivery fee is the courier's money — it is
   `effectiveDeliveryFee` in `lib/payments/calc.js`, settled in `routes/driver-reports.js`,
   and carries its own commission computed from the delivery documents, not from the order.
   It appears nowhere in `stores-export-new` or `revenueForCommission`. The corollary is
   the one that keeps getting got wrong: **`order.total` is never a commission base.**
   `calculateTotal` (`utils/order-pricing.js`) builds it as
   `orderPrice + shippingPrice + driveInPrice − coupon − coins + twin combination fee`,
   so summing it is wrong in four directions at once, not just by the delivery fee. Any
   report answering "what is Shoofi's commission calculated on" sums
   `orderPrice + driveIn`; `total` answers a different question (what the customer paid).
   Measured over 2026-07 across the 160 live stores the two differ by ~9%
   (₪1,555,939 vs ₪1,416,511). The exec dashboard shipped summing `total` and was
   corrected in `services/exec-dashboard/orders-metrics.js` (`commissionBaseOf`).
   *History — do not "restore" either half:* until 2026-08-03 revenue itself used the
   pre-discount price, which overstated a discounting store's transfer and tax invoice;
   that was fixed. The pre-discount **commission** base survived that fix and was then
   dropped by owner decision on **2026-08-04** ("commission only from the final order
   items price after discount").
4. **VAT has ONE source of truth: `utils/vat.js`** (`VAT_RATE`, `VAT_MULTIPLIER`,
   `calculateVAT`, `withoutVAT`, `withoutVATIfExempt`, `isVatExempt`). **Never re-introduce
   a `0.18`/`1.18` literal** — divergent rounding points silently skew payouts.
   `isVatExempt(...storeDocs)` is the one way to ask whether a business is עוסק פטור: it
   reads `accounting.bankAccount.businessType` off **either** the per-tenant `store {id:1}`
   doc or the `shoofi.stores` registry entry, because production stores are inconsistent
   about which one carries it. Do not re-inline the `businessType === 'exempt'` comparison.
   **Exempt is no longer a settlement-only concern:** since 2026-08-09 the per-order
   CUSTOMER document follows it too (zero VAT on both gateways) — that half belongs to the
   `payments` domain, invariant 9. A change to what `exempt` means now moves two systems.
5. **Report guards must stay on:** duplicate + **overlap across ALL statuses** (a sent report
   blocks a new overlapping one), orders-closed, and compensations-approved.
   **Delete is deliberately NOT status-gated** — a report can be sent and only then found
   wrong, and the fix is delete + regenerate. But delete **must release the carry-over
   compensations** that `/send` consumed (`appNameBackfill.pendingReportCarryover` back to
   `true`), or the regenerated report silently drops those amounts.
6. **Settlement reads the store `orders` collection** (which has status), never the
   `customers.orders[]` snapshot. Keep it that way.

## Known status (human-confirmed — do NOT "fix")
- **FIXED, keep it that way:** the overlap guard now covers sent reports; VAT is centralized
  in `utils/vat.js`.
- **INTENTIONAL, do NOT "restore":** delete accepts **any** report status (2026-08-03). The
  old "only draft reports can be deleted" guard was removed on purpose so a wrong report that
  already went out to a store/driver can be regenerated. Deleting a report that carries an
  issued tax invoice only **warns** (logging `hypInvoiceDocUuid`, needed by
  `/api/hyp/admin/reports/:id/cancel-invoice` once the row is gone) — cancelling or
  credit-noting at the provider stays a separate, manual step.
- **OPEN — flagged, needs a decision:** `reset-invoice` only clears the *local* invoice fields;
  it does **not** cancel the document at GreenInvoice/HYP, so a following `create-invoice`
  issues a **second** invoice. Do not silently change behavior — ask.
- **Awareness:** MASAV is **decoupled** from the reports — payout amounts are re-keyed into an
  Excel by a human; there is no automated report→MASAV link. Hardcoded GreenInvoice
  `businessId`/`itemId` constants exist.

## Recipe — change a payout or invoice amount
1. **Trace the money first**: who collected (cash/card) → who is owed → which formula line.
   Write that trace in the PR body. If you can't trace it, don't change it.
2. Change the **one** formula line; never introduce a new rounding or VAT point.
3. Show a **before/after worked example** for one real report period.
4. Verify: `npm run lint` (0 errors), `docs:check`, and a dry run of report generation if infra
   allows. Never claim an invoice/MASAV change is correct without a sandbox.

## Definition of done
Inherit `_shared-guardrails.md` §7, plus: preserve the transfer formula, the cash-vs-card
branch, the pre-discount commission base, and invoice idempotency guards. When in doubt on
real money, **stop and ask**.
