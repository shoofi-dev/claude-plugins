---
domain: accountant
last-verified: shoofi-server@cba297cd (fix/compensations-auth) / 2026-10-29
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
report a compensation belongs to + the post-report lock, invariant 10), `services/compensations/access.js`
(who may call the compensation API, invariant 16), `services/financial-overview/` (the live overview —
it RUNS the two report engines over any range; never re-derive money there), and the accountant's
Hashavshevet export `services/accountant-export/` + `utils/hashavshevet-movein.js` (reference §7b —
its amounts are EZcount's per-line rounding, never `round2(totalOutcomes)`). Coupon **funding** set by the
support team's coupon drafts (`services/coupons/coupon-drafts.js`, `routes/admin/coupon-drafts.js`,
invariant 13) — the coupon itself is still written by `routes/coupon.js` (not yours). Client: the
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
   decides it is **blind to `discountType`** (`routes/payments/admin.js:1188-1194`,
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
     which is the exact parallel of `:1191` using `orderPrice` for an items coupon. NOT
     off the waiver (that halves a partial discount's store share) and NOT off
     `effectiveDeliveryFee` (a coupon can never touch the twin combination fee). It
     **deliberately diverges from `:1190-1191` for these coupons**;
     `isPercentageStoreDeliveryCoupon` counts them so the divergence is measurable
     (`percentageShareCoupons` on the exec-dashboard month detail) rather than
     invisible. Fixing the report's base to match is a **live billing change** — it
     moves what stores are charged, and belongs to its own ticket.
   - **`storeDiscount` carries two different units and no field says which.**
     Shekels normally; percentage points when `type === 'percentage'`. There is no
     validation bounding it to 0-100 in that case — `lib/schemas/newCoupon.json` sets
     only `minimum: 0`, and `routes/coupon.js:1549` (create) / `:1797` (update) bound the
     split only for `fixed_amount`. **`splitType: 'percentage'` is the exception:** those coupons
     resolve the share into shekels before the order is written
     (`resolveCouponSplit`, now in `utils/coupon-discount.js`, called at `routes/coupon.js:411`
     typed and `:1314` auto-apply, and re-run at order creation for `delivery_price` coupons —
     invariant 15), so `storeDiscount` on
     the applied snapshot is already an amount (prod check 2026-10-26: P147T5LK on a ₪118
     brixta order carries `shoofiDiscount: 71.5, storeDiscount: 0`). Any reader dividing by
     100 must exclude them. **`stores-export-new` itself does not** (`:1190-1191` checks only
     `type`; nothing under `routes/payments/` or `lib/payments/` reads `splitType`): a
     `type: 'percentage'` + `splitType: 'percentage'` coupon with a store share bills
     `storeDiscount × orderPrice / 100`: a ₪30 share on a ₪200 order bills ₪60, and the bill is
     right only when `orderPrice` is exactly ₪100. **OPEN, awaiting an owner ruling** (Known
     status). Exposure today is nil: prod has 2 such coupons (P147T5LK, OTWX1AR6, both
     `storePercent: 0`), so the gate never fires. Coupon drafts exclude `store_percentage_off`
     for this reason (invariant 13). `splitType: 'percentage'` is also the built-for-purpose
     way to express a varying-fee split — prefer it over `type: 'percentage'` when
     configuring delivery campaigns. **`type: 'fixed_amount'` + `splitType: 'percentage'` is
     the safe way to give a store a share of a coupon** (verified 2026-10-26). Every reader
     treats `storeDiscount` as percent points only when `type === 'percentage'`:
     `stores-export-new` `:1190-1194`, the legacy export `:979-984`, `couponDeliverySplit`
     (`lib/payments/calc.js:156-161`), `routes/payments/summaries.js:131-135` and
     `services/exec-dashboard/coupon-funding.js:207`. Prod has 12 such coupons, all auto-applied
     delivery coupons (ICF86DOX joker 20/80, YNM83RFF 50/50, the vapego coupons 0/100). All
     333 orders checked carry `storeDiscount = discountAmount × storePercent`, and the sent
     reports bill exactly that (vapego ₪20/₪28 = the actual fee; joker ₪16; snooshy ₪6.80 on a
     ₪17 fee). A **shekel** split is billed nominally instead: ₪4/₪16 on a ₪15 fee bills ₪16
     (Shoofi −₪1), and a store-funded ₪40 ceiling bills ₪40 on a ₪20 fee. Two limits:
     never combine it with `type: 'percentage'` (the OPEN item above), and never use it on a
     `full_discount` partial-use coupon, whose breakdown treats the snapshot split as a running
     budget (`services/coupons/coupon-usage.js:424-425`).
   - **The row pushed at `:1206` carries no items/delivery split** (unlike the
     `full_discount` rows at `:1296`), so `campaignsList` is not splittable for
     `delivery`/`order_items` coupons. `full_discount` is the **only** coupon type with a
     stored 2×2 split (`getFullDiscountMatrix`); everything else must be re-derived from
     the order at read time — see `couponDeliverySplit` in `lib/payments/calc.js`.
   `campaigns` is an **outcome** feeding `totalOutcomes` → `totalForTransfer`, so this is
   live money. Do not "fix" the percentage base as a side effect of another change — it
   moves what stores are charged. **Ask.**
   *(Do not mirror `admin.js:953-986` either — that is the legacy `/stores-export`
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
      That route is admin-only (invariant 16), so the two self-calls forward the generating
      admin's own `authorization` + `app-type` (`compensationSelfCallHeaders`), and a 401/403
      **fails** the report (`throwIfCompensationFetchRefused`). Every other fetch error is still
      swallowed as before.
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

11. **A store promotion is store-funded and needs no coupon branch** (`order.promotions`,
    shoofi-server `docs/promotions.md`). Never look for it in `appliedCoupon`.
    - **Items deal** — already netted into `orderPrice` with `originalOrderPrice` at list price,
      i.e. it IS the store product discount: revenue uses the charged price, **commission the
      list price**, the gap is reported as `productDiscounts`. Putting it in `appliedCoupon`
      too would bill the store twice (lower revenue AND `campaigns`). Two **combined** items
      deals (`promotions.items.combined`, both `combinable`) are still ONE netted amount in
      `orderPrice` — settlement needs no per-deal branch.
    - **Delivery deal** — `shippingPrice` stays the full fee (courier pay, delivery tax
      invoice). The store is billed it as a campaign (`totalAppliedCouponsSum`, row code
      `מבצע`, `routes/payments/admin.js`). On a **CASH** order the courier collected that much
      less at the door, so it is paid to them like a delivery coupon: `promotionDeliveryPortion`
      in `lib/payments/calc.js` (inside `couponDeliveryPortion` / `couponDeliverySplit`, store
      share = all of it) and the cash branches of `routes/payments/summaries.js` and
      `routes/driver-reports.js` (`promotionDeliveryPayment`, added in a SEPARATE `$addFields`
      stage). A delivery deal and a delivery coupon never both apply to one order.
    - Shoofi funds nothing: no Shoofi share exists and the admin form has no field for one.

12. **A compensation does NOT store the 8-digit order number — derive it.** An order keeps
    two forms of the same id: `originalOrderId` (`1872-733742-4868`, 14 digits in three
    segments) and `orderId` (`1872-4868`, the 8 digits every app, receipt, push notification
    and order card shows). `shoofi-delivery-web`'s `CompensationModal` deliberately stores
    the LONG one on `order.orderNumber`, because the `COMP-<orderNumber>` coupon code it
    mints has to be unique across the ~250 store DBs and the short form is only store-local —
    and `normalizeCompensationOrder` (`routes/shoofi-admin.js`) then overwrites
    `order.orderId` with the Mongo `_id` (2,381 of 2,431 production rows). So no field holds
    the number a person recognises: **`utils/order-number.js` → `shortOrderNumber()`**
    derives it, and the store report PDF (`routes/payments/admin-reports.js`), the driver
    report PDF (`routes/driver-reports.js`) and every admin screen call it. Prod, 2026-10:
    262 of 2,431 compensations stored the long form and 2,169 the short one, which is why one
    column showed two shapes for the same order while the modal that FILES a compensation
    showed the short one. Three riders:
    - **Never shorten an `_id`.** Eight hex characters read exactly like a real order number
      and are not one, so `shortOrderNumber` returns `""` there. That is why
      `${c.orderNumber || c.orderId}` is not a fallback on a driver-report row.
    - **The search has to expand.** `compensationOrderNumberQuery` (same file) keeps the
      unanchored substring match AND adds `^NNNN-\d+-NNNN$` for a typed two-segment term, so
      the number now on screen still finds a row that stored the long form.
    - **It is display only, never a key or a join.** The long form is what gets stored
      precisely because the short one is not unique platform-wide. Settlement keys on
      `createdAt` plus store/company identity; the order number appears in no invoice, credit
      note or MASAV row.

13. **Coupon drafts decide who funds a coupon — they ask, never guess** (support builds a coupon
    from one #320 template with Claude; shoofi-server `docs/coupon-drafts.md` — read it first;
    pure rules in `services/coupons/coupon-drafts.js`, endpoints in `routes/admin/coupon-drafts.js`).
    `shoofiDiscount`/`storeDiscount` don't change what the customer pays; they ARE the
    settlement (invariant 7), so the draft owns them:
    - **Funding is a question, and the answer is always a PERCENT split.** `computeDraftView`
      blocks until `funding.mode ∈ shoofi | store | split` is answered. Then the prefill
      becomes `splitType: 'percentage'` with Shoofi 100/0 (`FUNDING_SHOOFI_PERCENT.shoofi`),
      0/100 (`.store`) or `split` `{shoofiPercent: X}` → X / 100−X. `shoofiDiscount` and
      `storeDiscount` are null, and `assertTemplateInvariants` is re-run on the overridden
      prefill. This applies to `delivery_free_over_min`, `delivery_reduced_price`,
      `delivery_happy_hour`, `store_fixed_off_items` and `delivery_fixed_price` (`needsFunding`
      — a template carrying `shoofiDiscount` OR `shoofiPercent` fields). `delivery_fixed_price`
      maps its funding value to `maxDiscount` (`VALUE_FIELD`) and is built percent-split from
      the start; it never has a shekel split to fall back to (invariant 15). Why percent and not
      shekels: apply time resolves the percents against the discount actually given
      (`resolveCouponSplit` in `utils/coupon-discount.js`; `routes/coupon.js:411` typed, `:1314`
      auto-apply), so the store pays its share
      of the real fee under the ceiling. A shekel split is billed NOMINALLY
      (`routes/payments/admin.js:1192-1194`), which over-bills whenever the fee is below the
      ceiling, and that is the usual case (fees seen: 17, 18, 20, 28, 32, 35). It is safe end
      to end; see the prod evidence at invariant 7. 100/0 is settled the same as the old
      `shoofiDiscount = value` shape (the store is billed 0 and Shoofi's delivery cost is
      `total − store`). It is stored as percentage only so there is one shape, and so the order
      shows Shoofi's real cost. If the model leaves funding open without asking, the route adds
      the question itself (`FUNDING_QUESTION`, `routes/admin/coupon-drafts.js`). The template's
      fixed defaults (₪10 + ₪10 …) are never used. Templates with no split fields (`delivery_free_personal`,
      `delivery_free_new_user`, `compensation_full_order`, `referral_reward`) keep the split
      they derive from their own amount.
    - **`SHOOFI_FUNDED_TEMPLATES` = `compensation_items_only`, `gift_voucher`**: always
      `shoofiDiscount = amount, storeDiscount = 0`, no question. Why: a customer-specific coupon's
      store share is never billed (`routes/payments/admin.js:1188` `!isSpecificToCustomers`), and
      an empty/0 `shoofiDiscount` there is credited to the store at `coupon.value`
      (`:1180-1181`). A "store-funded" customer coupon is therefore fiction that Shoofi pays —
      **a store-paid compensation is a compensations row** (`payingParty: business` →
      `compensationsToCustomers`, invariant 8), never a coupon split.
    - **`DRAFT_EXCLUDED_TEMPLATES.store_percentage_off`** — invariant 7's OPEN
      percentage-split question. Lift it only with the owner's ruling AND a matching change at
      `routes/payments/admin.js:1190-1191`, never by deleting the entry alone. The ordinary
      coupon form still creates such coupons.
    - **Approval never writes a coupon.** `approve` writes the label translations, reserves a
      code, and returns `buildCreateFields(...)` — the exact multipart fields CouponForm posts
      (targeting **top-level** JSON strings; numbers as strings so `"0"` survives the route's
      truthiness checks; `createdBy` = the approver). The admin web posts them to the
      **unchanged** `POST /api/admin/coupon/create`; `routes/coupon.js` is untouched and every
      create check applies. That route is gated (2026-10-28): create / update / delete /
      generate-code take `COUPON_WRITE_ROLES` = master | admin | manager — the same tier as
      `APPROVE_ROLES`, so an approver can always post it — and the admin reads (list, by-code,
      a customer's active coupons) take any dashboard role. Before that the whole
      `/api/admin/coupon*` surface had **no auth at all**. `settleApproval` (on every read and on `confirm`) marks an
      `approving` draft `created` once its reserved code exists in `shoofi.coupons`, so one
      draft can't create two coupons. Any edit reopens the draft.
    - **Central `shoofi` DB only** (`shoofiDbOf = req.app.db.shoofi`): drafts, code reservation,
      translations, settle. The create route itself still picks its DB from the `app-name`
      header with no fallback (`routes/coupon.js:1480-1481`); the admin web's interceptor
      defaults it to `shoofi`. A coupon written anywhere else is invisible to apply
      (`routes/coupon.js:178`) and to settlement (`routes/payments/admin.js:1049`).
    - **The #320 default-split trap is handled in drafts but STILL LIVE in the plain picker**
      (`POST /api/admin/coupon-templates/:id/resolve` → prefill → CouponForm). Lowering an
      amount under the fixed default split now returns **422** with the invariant
      (`err.code = 'COUPON_TEMPLATE_INVARIANT'`; it used to be a 500). **Raising** the amount
      is silent: `compensation_items_only` at ₪100 keeps `shoofiDiscount: 50`, so
      `shoofiCouponCredit` reimburses the store `min(50, applied)` and the store bears the rest
      of a "Shoofi" compensation. The fix (derive the split from the amount) belongs in
      `coupon-templates.js`, as its own change.

14. **Who funds a GLOBAL coupon is decided by the store's share alone** — the admin coupons
    list's `funder=shoofi|store|split` filter (`GET /api/admin/coupons`, plus `isActive=now` =
    on AND within its dates) and each row's `funder`. Rule: `services/coupons/coupon-funder.js`
    (`funderOf` for one coupon, `funderFilter` for the same rule as Mongo buckets,
    `activeNowFilter`). **It is a display/filter rule, NOT a billing path.** Settlement never
    calls it. It restates what `stores-export-new` already does, so if settlement changes,
    this file follows; never the other way round.
    - **Share:** `storePercent` out of 100 for `splitType: 'percentage'` (resolved per order by
      `resolveCouponSplit`, `utils/coupon-discount.js`); otherwise `storeDiscount` out of `value`. The bucket is
      `shoofi` when the share is null or 0, `store` when it covers the whole value (or 100%),
      and `split` for anything between. That is because the store is billed its share
      (`routes/payments/admin.js:1140`, `:1146-1160` fallback, truthy gate `:1188`), and
      whatever it isn't billed is Shoofi's (`lib/payments/calc.js:161`).
    - **`shoofiDiscount` is never read for a public coupon** (only for customer-specific
      `order_items`, `admin.js:1209`). So both shares null/0 means Shoofi pays, and
      shoofi + store < value with store > 0 is a split.
    - **The bucket doesn't say how much the store is billed.** A fixed store share is billed
      at its nominal amount (`admin.js:1192-1194`): a ₪20 share on a ₪17 fee bills ₪20 and
      still counts as `store`. A `type: 'percentage'` fixed share is percent points of the
      items subtotal (`:1190-1191`), compared against `value` in the same units.
    - **Out of scope (`null`):** customer-specific coupons (never billed to a store, `:1188`)
      and value-0 tag coupons. An **`onlyForOneCustomer`** voucher is global only until its
      first use, which claims it and sets `isCustomerSpecific: true`
      (`services/coupons/coupon-usage.js:171`). From then on its store share is not billed,
      and it leaves the filter.
    - **Fixed delivery price (`type: 'delivery_price'`, invariant 15) needs no change here.**
      It is always `splitType: 'percentage'`, so `storePercent` decides, and its `value` is the
      cap (`=== maxDiscount`, > 0), so it passes the `value > 0` gate and is never mistaken for
      a value-0 tag coupon. A storePercent of 20 lands in `split`, 0 in `shoofi`, 100 in `store`
      — whatever the area fee turns out to be on each order.
    - **Dates:** `start`/`end` are strings with mixed +02:00/+03:00 offsets, so
      `activeNowFilter` converts them with `$convert … onError: null` and never compares them
      as text. Prod 2026-10-26, active now and global: 29 Shoofi, 5 store, 0 split.

15. **A FIXED DELIVERY PRICE coupon needs no settlement change, and must stay a percent split**
    (`type: 'delivery_price'`, `discountType: 'delivery'`, "משלוח ב-₪10"; shoofi-server
    `feat/coupon-fixed-delivery-price`). The customer pays `deliveryPrice` (X) for delivery in
    every area. The discount D is the gap: `min(cap, max(0, fee − X))`
    (`computeDeliveryPriceDiscount`, `utils/coupon-discount.js:82-94`). A fee at or below X
    gets ₪0, and a missing price, cap or fee also gives ₪0, never a guess (`:86`).
    - **Why settlement is untouched.** Every money-out reader branches only on
      `type === 'percentage'` and on `discountType`, never on `fixed_amount`. It reads the
      ORDER's `appliedCoupon.discountAmount` plus the shekel shares already resolved on the order:
      - store `campaigns`: `routes/payments/admin.js:1188-1195`
      - `couponDeliveryPortion` / `couponDeliverySplit`: `lib/payments/calc.js:92-164`
      - the CASH courier repayment `actualDriverPayment` and `earningsByCoupons`:
        `routes/driver-reports.js:171-284`, `admin.js:566-600`, `summaries.js:950-965`
      - the exec `orderCouponFunding`, delivery-metrics, financial overview and unit economics

      `isPercentageStoreDeliveryCoupon` is false for this type. The delivery tax invoice and
      the courier commission base are the full `shippingPrice` (`totalFees`), which a coupon
      never reduces.
    - **Worked example** (X = 10, store 20 / Shoofi 80, no cap hit; store share =
      `round2(D × storePercent/100)`, Shoofi = D − store):

      | area fee | D | customer pays delivery | store billed (`campaigns`) | Shoofi bears | CARD: courier paid by Shoofi | CASH: courier collects / Shoofi pays him |
      |---|---|---|---|---|---|---|
      | 38 | 28 | 10 | 5.60 | 22.40 | 38 | 10 / 28 |
      | 20 | 10 | 10 | 2.00 | 8.00 | 20 | 10 / 10 |
      | 10 or 8 | 0, coupon dropped at creation | fee | 0 | 0 | fee | fee / 0 |
      | 38, cap 15 | 15 | 23 | 3.00 | 12.00 | 38 | 23 / 15 |

      On CASH the store's 5.60 comes off its card-based transfer like any outcome. It is never
      collected from the courier.
    - **`value` = the cap (`=== maxDiscount`, > 0), never X and never 0.** `value` is what every
      `value`-only reader sees, so it must be a bounded, non-zero "most this coupon takes off
      one order":
      - the funder filter's `value > 0` gate (invariant 14)
      - the drafts' value-0 tag-coupon meaning
      - the create route's truthiness check
      - the admin list

      X in `value` would read as "₪10 off". The create route mirrors `value` into
      `maxDiscount` (`deliveryPriceCouponFields`, `routes/coupon.js:58-62`), and the template
      invariant enforces it. `isCashValuedCoupon` is false for this type, because the cap is
      not a balance. The coupon has its own `type` so that it FAILS CLOSED: a reader that
      doesn't know it computes ₪0, never `min(value, fee)`, which would read the cap as
      "₪cap off".
    - **Always `splitType: 'percentage'`** (`deliveryPriceCouponError`, `routes/coupon.js:51`,
      on create `:1528` and update `:1778`; same rule in `assertTemplateInvariants`). Why: a
      fixed store share is billed NOMINALLY (`admin.js:1192-1194`), while D swings from ₪0 to
      the cap with the area fee. Example: a ₪5 fixed share on a ₪8 fee bills the store ₪5
      for an order that got ₪0 off. A percent share is resolved against the D actually given.
      This happens three times: at the quote, at creation by `resolveCouponSplit`
      (`services/coupons/delivery-price-enforcement.js:136-138`), and again on amend
      (`routes/order-amend.js:583`). So it is always ≤ D and moves with it. Also refused:
      `allowPartialUse` (meaningless for a cap) and `isFreeDelivery` (the auto-apply scorer
      would give the full fee).
    - **Creation recomputes D server-side** (`enforceDeliveryPriceCoupon`, called at
      `routes/order.js:3994`; twin: `services/twin-order/twin-delivery-price.js`, secondary fee
      = 0). The steps:
      - The fee is `min(posted shippingPrice, area tariff)`, minus any store delivery deal
        kept on the order (`delivery-price-enforcement.js:99-115`).
      - D is `min(posted D, server D)` (`:120-121`).
      - A D of ₪0 drops the coupon, so no `couponUsages` row burns a redemption (`:124-131`).
      - The money fields come from the coupon document, never the posted copy (`:134-135`).

      Why: this is the one coupon whose discount grows with the fee. An inflated posted fee
      would otherwise turn straight into Shoofi's repayment to a CASH courier and a larger
      store bill. Before the guard, `/apply` took the fee from the client and creation
      trusted the posted coupon. Unlike other secondary checks, a failure here REMOVES the
      coupon (`check-failed`) rather than keeping the client's number.
    - **A store delivery deal on the same order.** `resolveDeliveryConflict`
      (`routes/order.js:3957`) still keeps only the larger. Fee 38, X 10 against a ₪15 deal:
      the coupon (28) wins. Fee 20 against ₪15: the deal wins.

      If both survive (the promotions block fails open), the guard computes D on the fee
      AFTER the deal. Example: fee 38, deal 15 → D = min(cap, 23 − 10) = 13, so the customer
      still pays 10. A CASH courier is repaid 13 + 15 = 28, exactly what he did not collect,
      never more than the fee. The store is billed 15 (`מבצע` row) + 2.60. Without that clamp
      it would have been D 28 + deal 15 = 43 on a 38 fee: the courier over-repaid by 5 and the
      items eaten by 5.
    - **Fallback caveat — under-bills, not over-bills.** If an order's copy of the coupon
      lacks the split, `stores-export-new` reads the coupon DOCUMENT (`admin.js:1147-1160`).
      For a percent split that document has `storeDiscount: null`, so the store is billed
      **₪0** and its share silently becomes Shoofi's cost. The same happens in
      `couponDeliverySplit`, which has no document lookup. Since the creation guard and
      the amend re-split, every `delivery_price` order carries resolved shares, so only an
      order that bypassed both can hit this. Resolving the share from the document there would
      be a live billing change for every percent-split coupon. **Ask.**

16. **The compensation API is gated per audience, in the route — never by role alone** (2026-10-29;
    before that all eleven `/api/shoofiAdmin/compensations*` routes had no auth at all, and `add`
    took `approvedAmount` from the body). Rules and role lists: `services/compensations/access.js`.
    Every route is `auth.required` first, so no token gets 401 and a customer token gets 403.
    - **Admin-only, `COMPENSATION_ADMIN_ROLES` = master/admin/manager**: the list, `GET :id`,
      `approve-item`, `PUT :id`, `DELETE :id`. Callers: ניהול פיצויים, יצירת סיכומי חנויות, and the
      store report's own self-call (invariant 10). Every store report in prod was generated by an
      admin or master account.
      **This list, not the report route, decides who can generate a store report.**
      `POST /api/payments/admin/reports/generate` is `auth.required` only
      (`routes/payments/admin-reports.js:1539`) and is not on `utils/restricted-admin-routes.js`,
      so a `senior`/`operator`/`viewer`/`editor`/**`accountant`** admin reaches the handler — and
      is then 403'd on the compensation self-call, which `throwIfCompensationFetchRefused` turns
      into a failed generation (`generation_error`), never a ₪0-compensation report. The report
      fails whole, not partially; the accountant role is the one this bites in practice. Widening
      the report route without widening `COMPENSATION_ADMIN_ROLES` changes nothing.
    - **The order card, `ORDER_CARD_ROLES` = every dashboard role except accountant-only**:
      `POST edit/:id`, and the admin side of `order/:orderId` and `add`. Its "פיצוי הזמנה" action
      and badge have no role check, and support runs on `viewer`: 280 adds and 34 modal edits
      came from viewer-only accounts, 2026-03-22 to 2026-10-29. `PUT :id` shares the edit handler
      but has no caller, so it stays admin-only.
    - **Shared with the apps: an admin role OR the caller's own scope.** Partner and driver JWTs
      carry no `roles`, so a role-only gate 403s every user of those apps, silently.
      `auth.required` checks the token against the collection its `app-type` names, which is
      what makes `req.auth.id` trustworthy.
      - Partner (`shoofi-partner`): `storeUsers` doc → `appName` (one token = one store). Its
        own `business/:storeId` (`storeId` = that store's `store._id`; the `app-name` header
        is replaced by the token's store), and `order/:orderId` / `add` for an order in its own
        store DB.
      - Driver (`shoofi-shoofir`): `delivery-company.customers` doc = `bookDelivery.driver._id`.
        Its own `driver/:driverId`. For `order/:orderId` / `add`, the id must be a
        `bookDelivery` `_id` or `order._id` whose `driver._id` is this driver. A
        delivery-company admin login (`role: 'admin'`) may also use its company's
        deliveries (`company._id`). The 8-digit `bookId` is never an ownership key
        (invariant 12).
    - **A partner/driver `add` is a pending request for itself** (`stampMobileCompensation`):
      `status 0`, `approvedAmount 0`, no `approvedBy/approvedAt/declineReason/couponCode`,
      `createdBy` = the store's or driver's name, and the settlement identity stamped:
      `order.appName`/`storeData.appName` = the token's store (store report), and
      `deliveryCompany._id` = the driver's company (driver report). An item for anyone else is
      403. `payingParty` is still the caller's choice, and the approving admin reviews it.
    - Pinned in `test/integration/compensations-auth.js`.

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
- **OPEN — needs an owner ruling (2026-10-26):** `stores-export-new` reads a percentage-split
  (`splitType: 'percentage'`) `type: 'percentage'` coupon's already-in-shekels `storeDiscount`
  as percentage points (`routes/payments/admin.js:1190-1191`) and bills
  `storeDiscount × orderPrice / 100`. Today it bills ₪0 in prod (the only 2 such coupons are
  100% Shoofi). Until there is a ruling, coupon drafts refuse `store_percentage_off`
  (invariant 13); the ordinary form does not. Any fix is a live billing change → HIGH-RISK PR.
- **OPEN — flagged, needs a decision:** `reset-invoice` only clears the *local* invoice fields;
  it does **not** cancel the document at GreenInvoice/HYP, so a following `create-invoice`
  issues a **second** invoice. Do not silently change behavior — ask.
- **Awareness:** MASAV is **decoupled** from the reports — payout amounts are re-keyed into an
  Excel by a human; there is no automated report→MASAV link. Hardcoded GreenInvoice
  `businessId`/`itemId` constants exist.
- **Awareness — a report PDF on Spaces is published, not protected.** All **8**
  `PutObjectCommand` call sites in this repo pass `ACL: "public-read"`, with no exception:
  `routes/payments/admin-reports.js:239` (store settlement), `routes/driver-reports.js:687`
  (courier settlement), `utils/invoice-mail.js:155` (the customer invoice PDF),
  `backfill-invoices.js:205` (the bulk variant — one run republishes every historical
  invoice), `utils/images-service.js:36`, `utils/image-variants.js:127`,
  `routes/product.js:113` and `services/social-posts/render-service.js:204`. Counting by
  grep overshoots: `routes/payments.js:14`, `routes/payments/admin.js:14` and
  `routes/payments/summaries.js:14` **import** `PutObjectCommand` and never call it — dead
  imports from the `payments.js` split. The URL handed back to the admin —
  `https://shoofi-spaces.fra1.digitaloceanspaces.com/reports/<appName>/<reportId>.pdf`
  (`admin-reports.js:233`, `:247`) and `driver-reports/<companyId>/<reportId>.pdf`
  (`driver-reports.js:679`, `:691`) — carries no token, so anyone holding it reads a
  store's or a courier's whole period. Note this is the **origin** host; the invoice URLs
  in `routes/order.js` use the `.cdn.` host instead, the one place the two differ. Read
  "on Spaces" as "the code publishes it", never as "behind the admin login" — whether a
  given object is actually reachable also depends on bucket settings that code can't tell
  you, but `routes/order.js` handing these URLs to customers is the behavioural proof.
- **Awareness — report ids are enumerable *within a monthly run*.** `<appName>` is the
  public `app-name` slug (returned by unauthenticated `routes/shoofi-admin.js:766` and
  `routes/store.js:193`); `<companyId>` is a `delivery-company.store` ObjectId, not a slug.
  `<reportId>` is a Mongo ObjectId minted client-side by the driver — neither report doc
  sets `_id`, it is read off the insert (`admin-reports.js:1604`, `driver-reports.js:1158`).
  Under the pinned `mongodb@^3.3.3`/`bson@1.x` that is timestamp + **5 random per-process
  bytes** + counter, so cold guessing is infeasible. But every report in one monthly run is
  inserted in a single loop in a single process, so they share those bytes and differ only
  by a consecutive counter: **one leaked report id exposes that whole batch's ids by
  arithmetic** — i.e. every store's settlement for that month. Worst case in the repo is not
  the report key at all but `utils/invoice-mail.js:153`, `invoices/doc-<providerDocId>.pdf`,
  where the id is a short sequential provider number.
- **Awareness — you cannot un-send those links, so design around them.** This is a
  **property, not a bug to fix opportunistically**: `pdfUrl` is stored on the report doc
  (`admin-reports.js:1630`, `driver-reports.js:1168`) and has already gone out as parameter
  `{{2}}` of the WhatsApp `monthly_report` template (`admin-reports.js:2491`,
  `driver-reports.js:1575`) — not by email; that block is commented out at
  `admin-reports.js:2423-2433` and `sendEmail` is required and never called. A URL sitting
  in a third party's WhatsApp thread is less revocable than one you mailed, and WhatsApp's
  own link-preview fetch is an unauthenticated reader. Flipping the ACL breaks reports that
  have gone out. When a NEW artefact must stay internal, keep the bytes in Mongo and serve
  them from an admin-gated route — `routes/ai-tasks.js:718` (`...adminOnly`, `sendFile()` at
  `:706` with `Cache-Control: private`) and `routes/team-tasks.js:752` both do this — and cap
  one file per document well under the 16MB BSON limit, the way
  `services/ai-tasks/constants.js:180` pins `MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024`.

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
