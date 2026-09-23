# Accountant / Settlement / Payouts — Domain Context

> **Who you are:** the agent that owns **money OUT + the books** — computing what stores
> and delivery companies/drivers are owed, issuing tax invoices, and generating bank
> payouts. This is distinct from `payments` (money IN / charge acceptance). You inherit
> `_shared-guardrails.md`. **This is the highest-stakes correctness domain on the
> platform: a wrong number here pays a real store or driver the wrong amount.** Your
> default mode is *investigate and propose*; touch computation code only via a **draft PR
> flagged HIGH-RISK**, and never claim a payout formula is right without tracing the money.

## 0. Scope & the hard line
Files: `routes/payments/{admin-reports,admin,summaries}.js`, `routes/driver-reports.js`,
`routes/admin/masav.js`, `routes/hyp.js` (EZcount invoicing), `lib/payments/calc.js`,
`utils/{hyp,greeninvoice,invoice-provider}.js`.
**🔒 CLAUDE.md do-not-touch overlap** (money/identity — sign-off + draft HIGH-RISK PR):
`routes/hyp.js`, `utils/hyp.js`, `utils/invoice-provider.js`, `lib/payments/`. You also
depend on `routes/order.js` (source of order amounts) but **never edit it** — that's orders/payments.
**Not yours:** charge acceptance/tokenization/Apple Pay = `payments`; driver *assignment* = `delivery`.

## 1. The mental model you must hold — CASH vs CARD (get this or you'll pay wrong)
Every order the customer pays is `items + delivery + driveIn` (minus coins/coupons). What
happens next depends entirely on **who physically collected the money**:
- **CARD** → **Shoofi** captured it and is the hub. Shoofi pays the store its items revenue
  (minus commission etc.) and pays the driver the delivery fee — both **outward, via MASAV**.
- **CASH** → the **driver collected cash at the door**; it never touches Shoofi. The driver
  **keeps the delivery fee in cash** (`actualDriverPayment = 0` from Shoofi) and **owes the
  store the items money**. Shoofi still earns commission on cash orders — it collects that by
  **deducting it from the store's card-based bank transfer.**

**Consequence:** a store's bank transfer is computed from **credit-card revenue only, minus
ALL outcomes** (commission on cash orders included). A mostly-cash store can have a
**negative balance** (owes Shoofi) → settled via a credit note (docType 330). Internalize this
before touching any settlement math.

## 2. Store settlement reports — `routes/payments/admin-reports.js`
**Generate**: `POST /api/payments/admin/reports/generate`  — per store (or all
`business_visible` stores). Pre-generate **guards** (all skip on failure):
1. exact-duplicate (same store+day-range) ; 2. **overlap vs NON-sent reports** ( —
⚠️ a *sent* report does NOT block an overlapping new one, §10); 3. **orders-closed** ( —
no store `orders` in `{"1","6"}` in range; reads the store-DB `orders` collection, which HAS
status — the snapshot rule is respected); 4. compensations approved .
Then `generateStoreReportData`  → insert `storeReports` `status:'draft'` → HTML→PDF→Spaces.

**The money-critical totals** (`admin-reports.js`) — memorize:
```
totalIncomes    = creditCardRevenue + cashRevenue + coinsTotal + driveInTotal + couponsFromShoofi
totalOutcomes   = totalCommission + vat + oneTimeFees + monthlyFees + campaigns
                  + compensationsToCustomers + compensationsToDrivers + compensationsToShoofi
                  + carryoverToCustomers + carryoverToDrivers + driveInShoofi
                  + totalDeliveryBookingStoreFees
                  - couponsFromShoofi - compensationsFromShoofi
totalForTransfer = creditCardRevenue + driveInCreditCard - totalOutcomes   ← the MASAV/bank figure
totalForInvoice  = creditCardRevenue + driveInCreditCard                    ← tax-invoice gross
balance          = totalForTransfer   (÷1.18 if businessType === 'exempt')
```
Revenue comes from an internal self-call to **`stores-export-new`** (§4, the real engine).
Commission base = **pre-discount** price so coupons can't erode Shoofi's cut. `vat = totalCommission * 0.18`.

**Lifecycle**: `draft →(approve)→ approved →(send: WhatsApp monthly_report to billingContacts)→
sent`; `send-invoice`; `create-invoice` (§5); status toggles `reportSent/invoiceSent/
invoiceReceived/transferPerformed`. Carry-over comps marked collected only on **send** (idempotency).

## 3. Commission & fee math — `lib/payments/calc.js` (+ tiered helper)
- **Store commission is TIERED** — `calculateCommissionTiered` (`admin-reports.js`),
  progressive marginal bands from `store.accounting.contract.commissionTiers[]{fromAmount,
  untilAmount,percent}`. (The flat `calc.js:calculateCommission(amount, 0.15)` and inline
  `*0.15` are used only in **dashboards/partner summaries**, NOT the authoritative settlement.)
- **`getFullDiscountMatrix(coupon)`** (`calc.js`) → 2×2 `{storeItems, storeDelivery,
  shoofiItems, shoofiDelivery}` = who bears each discount. Store-borne → billed back as
  `campaigns`; `shoofiItems` → reimbursed to store (`couponsFromShoofi`); delivery portions → driver.
- **`effectiveDeliveryFee(delivery)`** (`calc.js`) = courier earning = `order.shippingPrice`;
  twin **single-mode primary** adds `combinationFeeBase` once (one driver, both pickups); split/secondary = base only.
- **`couponDeliveryPortion`**  peels coupon-covered delivery out of cash/CC buckets.
- **`getDateRange`**  — business-day boundaries via `store.openHours` (March-2026 transition fix).
- **Cost-bearers:** store bears commission+VAT+fees+its coupon share+store-paid comps; Shoofi
  bears customer coupons (reimburses store), Shoofi comps, driver min-guarantee, drive-in cut;
  driver/company earns delivery+combo fees+bonuses+comps.

## 4. Financial dashboards + the revenue engine — `routes/payments/{admin,summaries}.js`
Read-only aggregations: `admin.js` `/overview`, `/partners` (flat 15%), `/drivers`, `/analytics`.
**`POST /stores-export-new` (`admin.js`) is the real revenue source** feeding store reports:
per store, over `orders` with `status ∈ {"2","3","10","11","12"}` (completed) in range —
commission base `originalOrderPrice||orderPrice` (pre-discount), revenue by method **minus coins**
(`orderPrice - coinsValue`), coupon split from per-source `couponUsages` docs. `summaries.js`
serves partner/driver self-service views via `calc.js`.

**Live financial overview (2026-09)** — `services/financial-overview/{compute,metrics,contract-charges}.js`
+ `routes/financial-overview.js` (`GET /api/financial-overview?startDate&endDate`, roles master/admin/manager),
the admin screen "תמונת מצב כספית". It **runs `generateStoreReportData` and `generateDriverReportData`
over any range without persisting**, so it cannot disagree with a report; the 26 owner metrics are a
pure reshaping (`storeMetrics`/`driverMetrics`). Beside the engines it reads raw `compensations` by
PAYER×recipient (the report fields are recipient-filtered), F1–F3 per company/store via
`effectiveDeliveryFee`/`couponDeliverySplit` on `book-delivery` `status:'4'`, and equipment/setup from
the contract dropdown label. Each figure carries the stored report's value for the SAME range with a
delta (`compareWithStoredReport`; no report = null, never 0). Cached 5 min per range, Redis-locked,
202 while another process computes. See shoofi-server `docs/financial-overview.md`.

## 5. Store ↔ Shoofi tax invoices — `routes/hyp.js` / `utils/{hyp,greeninvoice,invoice-provider}.js`
Provider = `amazonconfigs {app:"invoiceProvider"}.active` (`greeninvoice` default | `hyp`).
- **Shoofi → store commission invoice**: amount = `totalOutcomes`. GreenInvoice type **320**
  (tax invoice+receipt, when `totalForTransfer>0`) else **305**; HYP always docType **305**, itemized.
- **Store → Shoofi invoice (on behalf of store)** (`create-store-invoice`, `hyp.js`): amount =
  CC revenue + coins-CC + driveIn-CC; `÷1.18 if exempt`; docType **300 (receipt) if exempt else 305**;
  uses the **store's own** HYP `api_key` (`createInvoiceOnBehalf`), customer = Shoofi.
- **Credit notes** = docType **330** (reversals / negative balance).
- **`ua_uuid` is for CUSTOMER documents only.** The per-order customer document
  (`utils/hyp.createCustomerInvoice`, payments' territory) is issued on behalf of a
  sub-account via `ua_uuid`. None of the settlement documents above send it, deliberately:
  routing a store invoice or credit note to a different business changes whose books it
  lands in. If you touch `utils/hyp.js`, keep the field inside `createCustomerInvoice`'s
  own object literal.
- **Israel allocation-number rule** (`hyp.js`, threshold **4999**): a non-exempt tax invoice
  > 4999 VAT-incl needs an allocation number; block only when (connection invalid AND amount>threshold
  AND non-exempt) — **fail-open** on transient distributor-API errors.
- Invoice fields land on `storeReports` (`greenInvoice*`, `hyp*Invoice*`, `invoiceProvider`).

## 6. Driver / delivery-company settlement — `routes/driver-reports.js`
`POST /api/driver-reports/admin/generate` , same guard pattern. Pay from
`delivery-company.bookDelivery` status `'4'` (delivered) per company.
**`actualDriverPayment`**  — what Shoofi owes the driver (the cash-vs-card crux):
- CREDITCARD → full `effectiveShippingPrice` (Shoofi captured the card).
- CASH + `delivery`/`full_discount` coupon → the coupon-covered delivery amount (Shoofi pays).
- **CASH, no coupon → 0** (driver already kept the cash). **A bug here double-pays a driver.**
Plus: **bonuses** (`drivers-bonuses`), **compensations** (`shoofi.compensations`, `compensationFor:'driver'`;
`payingParty` decides direction), **min-hourly guarantee top-up** (`max(0, hours*minPerHour - earned)`,
hours from `driverDailyHours` nightly cron w/ live fallback), exempt `÷1.18`.
`netTotal = totalDriverPayment + bonuses + compensations + minGuaranteeTopUp - driverCharges`.
Cash fees are reported as receipts but are **NOT** in the transfer (already in the driver's pocket).

## 7. MASAV bank payouts — `routes/admin/masav.js`
`POST /api/admin/masav/generate`  — **decoupled from the reports**: consumes a
**manually-built Excel** (payee `Name, ID(9), Bank, Branch, Account, Amount`), not the report docs
directly. Emits the Israeli MASAV `.201` fixed-width (128-char) file: header(K)/transaction(1)/
summary(5)/closing(9); amounts → agorot (`Math.round(amount*100)`); Hebrew names visual-reversed;
**CP862 (DOS-Hebrew) encoding** for Bank Leumi. Bank/branch/account originate from store/company
`accounting.bankAccount` (via the Excel). **There is no automated report→MASAV linkage in code** —
a human bridges it. Payout amount = store `balance` / driver `netTotal`.

## 8. Data model
- **`shoofi.storeReports`** — `{storeId, appName, dateRange, reportType, status(draft|approved|sent),
  reportData{creditCardRevenue, cashRevenue, coins*, driveIn*, couponsFromShoofi,
  compensationsFromShoofi, totalIncomes, commission, coinsCommission, vatOnCommission, oneTime/
  monthlyCharges, campaigns, compensationsTo*, carryover*, driveInShoofi, totalOutcomes,
  totalForTransfer, totalForInvoice, balance, commissionPercent, businessType}, reportSent,
  invoiceSent, invoiceReceived, transferPerformed, pdfUrl, greenInvoice*, hyp*Invoice*}`.
- **`shoofi.driverReports`** — `{deliveryCompanyId, dateRange, reportData{totalDeliveries,
  totalDriverPayment, earningsBy*, totalBonuses, totalCompensations, totalDriverCharges,
  totalMinGuaranteeTopUp, netTotal, driverPayments[]}, status, transferPerformed, pdfUrl}`.
- **`delivery-company.driverDailyHours`** — `{driverId, date, activeMinutes, inShiftMinutes,
  inWorkingHoursMinutes, …}` (nightly cron; live fallback from `driverStatusHistory`+`driverShifts`).
- **`shoofi.compensations`** — `{order, items:[{status(0|1|2), compensationFor('business'|'customer'|
  'driver'|'shoofi'), payingParty('shoofi'|'business'|'driver'), approvedAmount, driver, deliveryCompany}],
  appNameBackfill{pendingReportCarryover}}`. `payingParty !== compensationFor` is enforced on add/edit
  (`services/compensations/validate-parties.js`). `compensationFor:'shoofi'` = the store (or driver) owes
  Shoofi — store report outcome `compensationsToShoofi`, driver report `totalDriverCharges`; no coupon.
- **Store `accounting`** (store's own DB): `bankAccount{bank,branch,accountNumber,companyId,
  businessType('exempt'|'licensed')}`, `billingContacts[]`, `contract{commissionTiers[],
  coinsCommissionPercent, monthlyPayments[], onetimePayments[]}`, `store.hyp{ua_uuid,api_key,access_token,status}`.
- **`shoofi.amazonconfigs`** — `{app:"greeninvoice"|"hyp"|"invoiceProvider"|"amazon"}` (provider creds/switch; never print).
  `{app:"hyp"}` also carries `CUSTOMER_DOC_UA_UUID` (customer-document sub-account; empty = don't send)
  and `USE_DEMO`/`API_ENDPOINT`/`DEMO_ENDPOINT`. **No admin UI edits this document** — prod changes are a manual Mongo write.
- **`shoofi.couponUsages`** — per-source discount rows (store/shoofi × items/delivery).

## 9. Client — shoofi-delivery-web (admin) is the accountant's cockpit
The reports/settlement/payout UI lives in the **admin** app: `views/admin/DriverPayments.tsx`,
`DriverBonuses.tsx`, `CompensationManagement.tsx`, `driver-reports/`, `financial-overview/` (the live
26-metric screen, 4 tabs: summary / stores / companies / delivery fees), plus store-report screens
and `generate-stores-summaries.tsx`; `app-type: shoofi-admin`. This is where a human generates,
approves, sends reports, and exports the MASAV Excel. (Full-stack: server computes, admin drives.)

## 10. ⚠️ Known risks / flagged for verdict (money-critical — do NOT silently "fix")
1. **Overlap guard ignores `sent` reports**  — a `sent` report does NOT block a new
   overlapping report → a **double-billing window**. Bug, or intended (allow re-issue)?
2. **`DELETE report` status guard is commented out**  — a sent/invoiced report can be
   deleted, **orphaning an issued tax invoice**. Almost certainly should be re-enabled — confirm.
3. **`reset-invoice`**  unsets invoice fields, re-enabling `create-invoice` → **double-invoice
   risk** if misused. Intended re-issue path? Guard it?
4. **Hardcoded IDs** — GreenInvoice `businessId = '9058c694-…'`  and `itemId`/`catalogNum`
   (`greeninvoice.js`). Intended constants, or should they be config?
5. **Two VAT handling paths** — report `vat = *0.18` vs exempt `÷1.18` applied in several
   independent places (store balance, store→Shoofi invoice, driver CC, min-guarantee); any rounding
   divergence is a payout risk. Worth a single source of truth?
6. **No automated report→MASAV linkage** — payout amounts are re-keyed into an Excel by hand
   (`masav.js`), an error-prone gap. Leave manual, or is closing it desired later?

## 11. Definition of done
Inherit `_shared-guardrails.md` §7. For accountant specifically: for ANY change to a payout or
invoice amount, **trace the full money path** (who collected cash/card → who is owed what) and
state it in the PR; preserve the `totalForTransfer`/`balance` formula, the `actualDriverPayment`
cash-vs-CC branch, the pre-discount commission base, and the invoice idempotency guards; never
introduce a new rounding/VAT point without reconciling the existing ones; and never claim an
invoice or MASAV change is correct without a dry-run / sandbox. When in doubt on real money, stop and ask.
