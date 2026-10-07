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
`utils/{vat,greeninvoice,invoice-provider}.js`, `services/compensations/report-window.js` (which
report a compensation belongs to + the post-report lock, invariant 10), `services/financial-overview/` (the live overview —
it RUNS the two report engines over any range; never re-derive money there), and the accountant's
Hashavshevet export `services/accountant-export/` + `utils/hashavshevet-movein.js` (reference §7b —
its amounts are EZcount's per-line rounding, never `round2(totalOutcomes)`). Client: the
reports/payout screens and `views/admin/financial-overview/` in `shoofi-delivery-web`.
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
   **Combo deals (2026-09, `docs/combo-deals.md`) change nothing here, on purpose.** A combo
   line's share of `orderPrice` is its fixed price + catalog surcharges + nested extras — what
   was charged — and its `originalPrice` keeps the same discounted-extras asymmetry as any
   product (`originalPrice: baseOriginal ? baseOriginal + extrasPrice : undefined`,
   `utils/order-pricing.js`). The "you save ₪N" the customer sees (Σ component card prices −
   bundle price) is client display only and, by the parity-tested contract, never enters
   `originalOrderPrice` — so it is never a `productDiscount`
   (`Math.max(0, originalOrderPrice − chargedOrderPrice)`, `routes/payments/admin.js`) and
   never moves money between Shoofi and the store.
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
   **The compensations-approved guard (`validateCompensationsApproved`) must query with BSON
   `Date` bounds** — `compensations.createdAt` is a Date, and until 2026-10 the guard passed
   `moment().format()` strings, which never match a Date, so it found 0 compensations and
   **never blocked a single report** (Sep 2026: 0 by string vs 156 by Date). It now uses the
   report's own compensation window (invariant 10), the same store key as the report fetch
   (`order.storeData.appName`), and counts only pending items that move the store's money
   (`payingParty` or `compensationFor` is `business`). The driver report's guard
   (`validateDriverCompensationsApproved`) already used Dates; it counts only
   `compensationFor: 'driver'` items, not driver-PAID ones.
6. **Settlement reads the store `orders` collection** (which has status), never the
   `customers.orders[]` snapshot. Keep it that way.
7. **A store's coupon cost (`reportData.campaigns`) is the coupon's NOMINAL
   `storeDiscount`, never the waiver the customer actually got**, and the gate that
   decides it is **blind to `discountType`** (`routes/payments/admin.js:1135-1142`,
   feeding `totalAppliedCouponsSum` → `campaignsTotal` → `campaigns`):
   `if (storeDiscount && !isSpecificToCustomers && discountType !== 'full_discount')`.
   Three consequences that keep getting rediscovered:
   - **No cap against the thing discounted.** `storeDiscount: 20` on a ₪10 shipping fee
     bills the store ₪20, even though `appliedCoupon.discountAmount` was capped at ₪10
     when the coupon was applied. Any read-time "who paid for this" derivation therefore
     produces a small **negative** Shoofi share on such orders. That is real over-billing
     surfacing — **do not clamp it at zero**, which only hides it.
   - **A `percentage`-type coupon is billed as `(storeDiscount / 100) * orderPrice`**,
     where `orderPrice` is the **items subtotal** (`originalOrderPrice` — no shipping, no
     drive-in) — *even when the coupon's `discountType` is `delivery`*. So what the
     store report charges for a percentage delivery coupon is not a delivery amount.
     **A percentage `storeDiscount` means a SHARE, not an amount** (owner ruling,
     2026-08-12): the delivery fee differs from city to city, so the same coupon must
     cost the store more where the fee is higher, which a fixed shekel value cannot
     express. `couponDeliverySplit` (`lib/payments/calc.js`) therefore takes that
     percentage off **`order.shippingPrice`** — the same base `computeDiscountCap`
     strikes a delivery coupon's own `value` against (`utils/coupon-discount.js:34-42`),
     which is the exact parallel of `:1138` using `orderPrice` for an items coupon. NOT
     off the waiver (that halves a partial discount's store share) and NOT off
     `effectiveDeliveryFee` (a coupon can never touch the twin combination fee). It
     **deliberately diverges from `:1137-1138` for these coupons**;
     `isPercentageStoreDeliveryCoupon` counts them so the divergence is measurable
     (`percentageShareCoupons` on the exec-dashboard month detail) rather than
     invisible. Fixing the report's base to match is a **live billing change** — it
     moves what stores are charged, and belongs to its own ticket.
   - **`storeDiscount` carries two different units and no field says which.**
     Shekels normally; percentage points when `type === 'percentage'`. There is no
     validation bounding it to 0-100 in that case — `lib/schemas/newCoupon.json` sets
     only `minimum: 0`, and `routes/coupon.js:1462` (create) / `:1702` (update) bound the
     split only for `fixed_amount`. **`splitType: 'percentage'` is the exception:** those coupons
     resolve the share into shekels before the order is written
     (`routes/coupon.js:48-74`, `:345`), so `storeDiscount` on the applied snapshot is
     already an amount. Any reader dividing by 100 must exclude them or it bills ₪0.14
     where the store owes ₪14. `splitType: 'percentage'` is also the built-for-purpose
     way to express a varying-fee split — prefer it over `type: 'percentage'` when
     configuring delivery campaigns.
   - **The row pushed at `:1145` carries no items/delivery split** (unlike the
     `full_discount` rows at `:1236`), so `campaignsList` is not splittable for
     `delivery`/`order_items` coupons. `full_discount` is the **only** coupon type with a
     stored 2×2 split (`getFullDiscountMatrix`); everything else must be re-derived from
     the order at read time — see `couponDeliverySplit` in `lib/payments/calc.js`.
   `campaigns` is an **outcome** feeding `totalOutcomes` → `totalForTransfer`, so this is
   live money. Do not "fix" the percentage base as a side effect of another change — it
   moves what stores are charged. **Ask.**
   *(Do not mirror `admin.js:907-944` either — that is the legacy `/stores-export`
   endpoint, which bills `storeDiscount` for every coupon including customer-specific and
   `full_discount`. Settlement uses `/stores-export-new`.)*

   **The other direction — `couponsFromShoofi` (Shoofi credits the store) — is the APPLIED
   amount, capped by Shoofi's share** (owner decision 2026-10). For a customer-specific
   `order_items` coupon, `stores-export-new` credits
   `min(nominal, applied)` via `shoofiCouponCredit` (`lib/payments/calc.js`), where
   `nominal = shoofiDiscount` (or `(shoofiDiscount/100) * orderPrice` for `type:
   'percentage'`) and `applied = appliedCoupon.discountAmount ?? appliedCoupon.coupon.discountAmount`
   (`appliedCouponAmount`). `applied` missing (legacy orders) → the nominal, unchanged.
   Before this, every redemption was credited the nominal value, so a **partial-use**
   coupon paid out its full value at every store it touched (IMGOJRNG: ₪200 credited for a
   ₪49 use AND ₪200 for a ₪151 use; 27 rows / ₪1,775.5 Mar-Oct 2026). The pushed
   `shoofiCouponsData` row carries `itemsAmount = credited, deliveryAmount = 0` so the PDF
   columns reconcile with `amount`. Note the asymmetry with `campaigns` above, which is
   still the nominal — that is a separate, undecided question; do not "align" them.
   **The `coupon.value` fallback is CORRECT, do not remove it:** a customer-specific coupon
   with an empty `shoofiDiscount` is treated as Shoofi-credited at `coupon.value`, even when
   it has `storeDiscount` set. That is how a **store-paid compensation** balances: the store
   is charged ONCE as `compensationsToCustomers` in the month the compensation is approved,
   and each redemption of the resulting `COMP-*` coupon is credited back via
   `couponsFromShoofi`, offsetting the food it handed over — net, the store bears the
   compensation exactly once. (With the old nominal credit, a ₪200 COMP coupon spent ₪90
   at the store refunded it ₪200: its real cost fell to ₪90.) Guarded in
   `test/integration/settlement-guards.js`.

8. **Compensation parties.** `compensationFor ∈ {customer, business, driver, shoofi}`,
   `payingParty ∈ {shoofi, business, driver}`, and **payer ≠ recipient** — enforced server-side
   on add and edit by `services/compensations/validate-parties.js`. `business → business` would
   be credited by `compensationsFromShoofi` (a recipient filter) and billed by nothing;
   `driver → driver` has one `item.driver` field for two people. The `shoofi` recipient
   (2026-09) is "the store owes Shoofi": an OUTCOME `compensationsToShoofi` inside
   `totalOutcomes`, itemised on the Shoofi→store invoice, **never a coupon and never credited
   to anyone** — the money stays with Shoofi. It replaces the old habit of filing a store's
   refund to Shoofi as a "customer" compensation with no payout path. The exec dashboard's
   `BILLING_COMPONENTS` carries it and `totalDeliveryBookingStoreFees` as terms 13 and 14;
   a term added to `totalOutcomes` and not to that list shows up as a non-zero
   `billingReconciliationDelta`, which is the point of the list.

9. **The live overview's store population is by DATA, never by today's `business_visible`.**
   `services/financial-overview/compute.js` enumerates every non-mock store
   (`getAllNonMockStores`) and keeps those whose live report is not all zeros
   (`storeHasData` in `services/financial-overview/metrics.js`). The range is usually in the
   past, and a store hidden after it traded is still owed for that period — filtering on
   visibility silently shrank the liability total (08/2026: four hidden stores, ₪4,111.92 on
   sent reports, gone from the screen). Contract charges alone keep only a LIVE store (the
   generator never bills a hidden one); derived totals never decide inclusion. Do not
   "optimise" back to `getLiveStores` — narrow the non-live PROBE instead, and only towards
   over-selection. Details: reference §4.

10. **A compensation belongs to the report whose period contains its `createdAt` — never the
    month it was approved in — and the windows tile with no overlap and no gap.**
    `services/compensations/report-window.js` is the one place this is decided; the store
    report fetch, the generate guard (invariant 5) and the post-report lock all call it.
    - **Store:** `storeCompensationWindow` = `[report start, next day's start)` — the start is
      the report's business-day start (`storeReportBounds`, extracted verbatim from
      `generateStoreReportData`: snapped openHours + the openHours transition-month rule); the
      **exclusive** end is that same function's start for the day after `endDate`, so
      September ends at the exact instant October begins. The report passes these as exact
      instants with `endExclusive=true` to `GET /api/shoofiAdmin/compensations`; without that
      flag (the admin screen's date filter) a plain `endDate` is still stretched to 23:59:59.999.
      Before 2026-10 the report's end was stretched too, so everything created on the 1st of
      the next month after the store opened was billed in BOTH months (snooshy, ₪17, Oct 1
      22:36 IL). Orders keep their own `[start, end]` window — unchanged.
    - **Driver:** Israel calendar days, inclusive (`routes/driver-reports.js`) — already tiled;
      mirrored by `driverCompensationWindow` for the lock only. A compensation touching both a
      store and a driver can therefore land in different months on the two reports in the
      first hours of the 1st; each report is still exactly-once.
    - **The lock:** once a store or driver report (any status) covers a compensation's
      `createdAt`, a change that moves money on it is refused **409**
      (`code: 'compensation_period_closed'`, Hebrew message) by add / edit / approve-item /
      delete in `routes/shoofi-admin.js` (`checkCompensationLock`). "Moves money" =
      `affectedParties`: an item whose report footprint (status 1 + approvedAmount +
      parties + company/driver) changes, a NEW item (even pending — it could never be
      approved into any report), or deleting an approved item. Text edits and declining a
      never-approved item stay open. Without the lock the change reached no report at all
      (vapego-taibe, ₪2000 driver→business, edited 2026-09-19 after the August report — the
      store was never credited). **The way out is delete + regenerate** (a deleted report no
      longer locks) or a new compensation, which lands in the current period.
      New reports store their exact window in `reportData.compensationWindow`; for older
      reports the lock recomputes it from the store's CURRENT openHours.
    Not covered: `services/payments/cancel-compensation.js` inserts compensations
    automatically (createdAt = now) without the lock — it can only collide with a report
    generated for a period that has not ended.

## Known status (human-confirmed — do NOT "fix")
- **FIXED, keep it that way:** the overlap guard now covers sent reports; VAT is centralized
  in `utils/vat.js`.
- **FIXED 2026-10, keep it that way:** `couponsFromShoofi` credits the discount APPLIED on
  the order (capped by Shoofi's share), not the coupon's nominal value per redemption — see
  invariant 7. **INTENTIONAL, do NOT "fix":** the customer-specific `coupon.value` fallback
  that credits a store-paid `COMP-*` compensation coupon (it offsets the one-time
  `compensationsToCustomers` charge).
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
- **A MASAV file is built from a SECOND parse of the uploaded Excel.** The admin screen posts
  the **raw workbook**, never its parsed rows (`MasavGenerator.tsx` `handleGenerate`), so the
  preview a person approves and the `.201` the bank executes come from two independent parses
  of the same bytes. They agree only because both sides share one recogniser —
  `shoofi-server/utils/masav-columns.js` ↔ `shoofi-delivery-web/src/utils/masav-columns.ts`,
  **change them together** — and because the client posts the mapping it used as `columnMap`.
  When they diverged (2026-10-07) the screen showed 109 valid rows totalling ₪357,053.19 and
  the server answered `Account must be 1-13 digits (got "")` 109 times: the client fell back to
  the column's POSITION, the server to the literal key `'Account'`. There is now **no positional
  fallback on either side** — a column that cannot be NAMED is refused (`COLUMNS_NOT_RECOGNISED`
  with the detected headers), because guessing by position on a hand-built sheet with one extra
  leading column pays a real bank account the wrong number behind a green preview. See
  shoofi-server `docs/masav.md`.
- **`padLeft()` in `routes/admin/masav.js` TRUNCATES, keeping the leading characters.** Every
  value reaching a fixed-width MASAV slot must be bounded first or it is silently corrupted in
  a file a bank executes: a 9-digit `institutionCode` becomes a different institution, an
  over-large amount becomes a smaller one. `validateSettings()` / `validateRow()` refuse both.

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
