# Accountant / Settlement / Payouts — Domain Context

> last-verified §5/§8/§9/§10: shoofi-server@feat/invoice-allocation-guard + shoofi-delivery-web@feat/invoice-allocation-guard / 2026-11-05

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
`business_visible` stores). Every `/api/payments/admin/reports*` route, the `accountant-file-number` PUTs, the two
`greeninvoice` reads and every `/api/driver-reports` route take `settlementDashboard` (any
dashboard role; aliased `reportsDashboard`), not `auth.required` alone (CORE invariant 17). Pre-generate **guards** (all skip on failure):
1. exact-duplicate (same store+day-range) ; 2. **overlap vs reports of ANY status**
(`checkOverlappingReports` — a sent report blocks too; CORE invariant 5); 3. **orders-closed** ( —
no store `orders` in `{"1","6"}` in range; reads the store-DB `orders` collection, which HAS
status — the snapshot rule is respected); 4. **compensations approved**
(`validateCompensationsApproved`): no item still pending (status not 1/2) that moves the
store's money (`payingParty` or `compensationFor` = `business`), over the report's own
compensation window with BSON `Date` bounds. Before 2026-10 it compared Date fields to strings
and never fired (CORE invariant 5).
It also returns `pendingCompensations` (`[{compensationId, orderNumber, items}]`): the
failure is pushed to the generate response, stored on the `store-report-failures` row and
returned by `GET /reports/failed-stores`, and the admin (GenerateReports / ReportsList
failed-stores view) links each one to `/admin/compensations?orderNumber=…`.
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
balance          = totalForTransfer   (no VAT adjustment for any businessType — CORE invariant 1)
```
Revenue comes from an internal self-call to **`stores-export-new`** (§4, the real engine). The
POST forwards the generating admin's `authorization` + `app-type` (`selfCallHeaders`,
`services/payments/settlement-access.js`), and a 401/403 from it throws (`throwIfSelfCallRefused`)
instead of saving the report on ₪0 card revenue (CORE invariant 17).
Commission base = the FINAL items price charged (CORE invariant 3). `vat = calculateVAT(totalCommission)` (`utils/vat.js`).

**Windows** (`services/compensations/report-window.js`, CORE invariant 10): orders, coins,
coupons and delivery-only fees use `storeReportBounds` → `[start, end]` business-day bounds
(offset strings). Compensations use `storeCompensationWindow` → `[start, endExclusive)` Dates,
where `endExclusive` is the next day's business-day start — passed to the two
`GET /api/shoofiAdmin/compensations` self-calls (`payers=['business']`,
`recipients=['business']`) with `endExclusive=true`, and stored on the report as
`reportData.compensationWindow`. Those self-calls go out over HTTP to an **admin-only** route
(CORE invariant 16). They forward the caller's `authorization` + `app-type`
(`compensationSelfCallHeaders`), and a 401/403 throws (`throwIfCompensationFetchRefused`). That
turns into a recorded `generation_error` on `POST /reports/generate`, or a flagged store on the
financial overview, never a report with ₪0 compensations. Carry-over compensations
(`appNameBackfill.pendingReportCarryover`) are deliberately NOT date-filtered.

**Compensation lock** (`checkCompensationLock`, called from `rejectIfCompensationPeriodClosed`
in `routes/shoofi-admin.js` on add / `edit/:id` + `PUT :id` / `approve-item` / `DELETE :id`):
409 `compensation_period_closed` when a money-moving change (`affectedParties`) hits a
compensation whose `createdAt` is inside an existing store report's window (by `appName`) or
driver report's window (by `deliveryCompanyId` = `item.deliveryCompany._id`). Delete +
regenerate the report to reopen. The admin web (`CompensationManagement.tsx`,
`CompensationModal.tsx`) shows generic error toasts and does not yet surface the 409 message.

**Who may call the compensation API** (`services/compensations/access.js`, CORE invariant 16;
every route is `auth.required` first):

| Route | Admin roles | Partner (own) | Driver (own) | Client callers |
|---|---|---|---|---|
| `GET compensations` (list) | master/admin/manager | — | — | web ניהול פיצויים, יצירת סיכומי חנויות; the store report self-call |
| `GET compensations/:id` | master/admin/manager | — | — | none found |
| `POST approve-item` | master/admin/manager | — | — | web ניהול פיצויים |
| `PUT compensations/:id` | master/admin/manager | — | — | none found |
| `DELETE compensations/:id` | master/admin/manager | — | — | web ניהול פיצויים |
| `POST edit/:id` | all except accountant-only | — | — | web ניהול פיצויים + order card `CompensationModal` |
| `GET order/:orderId` | all except accountant-only | order in its store DB | its (or its company's) `bookDelivery`, by `_id` or `order._id` | web `CardOrder`, `CompensationModal`; shoofir `payments.tsx` |
| `GET driver/:driverId` | master/admin/manager | — | its own id | web `DriverPayments` (master); shoofir `compensations.tsx` |
| `GET business/:storeId` | master/admin/manager | its `store._id`; query uses the token's `appName`, not the header | — | partner `screens/admin/compensations` |
| `POST add` | all except accountant-only | order in its store DB, recipient `business` | its delivery, recipient itself | web `CompensationModal`; partner `BusinessCompensationRequestModal`; shoofir `CompensationRequestModal` |

A partner/driver `add` is stamped server-side (`stampMobileCompensation`): pending, ₪0 approved,
no approval fields, and `createdBy`, `order.appName`/`storeData.appName` (partner) and
`deliveryCompany._id` (driver) taken from the token. Admin `add`/`edit` keep taking status and
`approvedAmount` from the body. The order card files approved compensations directly; 662 of the
683 items filed in the 120 days to 2026-10-29 are status 1.

**Lifecycle**: `draft →(approve)→ approved →(send: WhatsApp monthly_report to the store's active
billingContacts)→ sent`; `send-invoice`; `create-invoice` (§5); status toggles `reportSent/invoiceSent/
invoiceReceived/transferPerformed`. Carry-over comps marked collected only on **send** (idempotency).
This recipient rule is the STORE path only. Driver reports pick their recipients differently (§6).

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
- **Fixed delivery price coupons** (`type: 'delivery_price'`) flow through `couponDeliveryPortion` /
  `couponDeliverySplit` unchanged: `discountType: 'delivery'`, a non-`percentage` type, and shares
  already resolved in shekels on the order. The discount math is `computeDeliveryPriceDiscount`
  (`utils/coupon-discount.js`). The split is `resolveCouponSplit`, which moved from `routes/coupon.js`
  to the same file. The creation guard is `services/coupons/delivery-price-enforcement.js`.
  Worked numbers and the rules are in CORE invariant 15.
- **`shoofiCouponCredit({shoofiDiscount, couponType, orderPrice, appliedAmount})`** (`calc.js`)
  = the per-order `couponsFromShoofi` credit for a customer-specific `order_items` coupon:
  `min(nominal, applied)`, nominal = `shoofiDiscount` (percentage → `/100 * orderPrice`),
  applied = **`appliedCouponAmount(appliedCoupon)`** (`discountAmount ?? coupon.discountAmount`);
  applied missing → nominal (legacy). `stores-export-new` pushes the row as
  `{amount, itemsAmount: amount, deliveryAmount: 0}`. An empty `shoofiDiscount` on a
  customer-specific coupon falls back to `coupon.value` — deliberately, so a store-paid
  `COMP-*` compensation coupon is credited back against its one-time
  `compensationsToCustomers` charge (CORE invariant 7).
- **`getDateRange`**  — business-day boundaries via `store.openHours` (March-2026 transition fix).
- **Cost-bearers:** store bears commission+VAT+fees+its coupon share+store-paid comps; Shoofi
  bears customer coupons (reimburses store), Shoofi comps, driver min-guarantee, drive-in cut;
  driver/company earns delivery+combo fees+bonuses+comps.
- **Who funds a global coupon (display only)** — `services/coupons/coupon-funder.js`
  (`funderOf`, `funderFilter`, `activeNowFilter`) backs the admin coupons list's
  `GET /api/admin/coupons?funder=shoofi|store|split&isActive=now` (any other `funder` → 400).
  The store's share alone decides: `storePercent` for a percent split, otherwise
  `storeDiscount` vs `value`. It is a restatement of settlement, never an input to it
  (CORE invariant 14).

## 4. Financial dashboards + the revenue engine — `routes/payments/{admin,summaries}.js`
Read-only aggregations: `admin.js` `/overview`, `/partners` (flat 15%), `/drivers`, `/analytics`.
**`POST /stores-export-new` (`admin.js`) is the real revenue source** feeding store reports:
per store, over `orders` with `status ∈ {"2","3","10","11","12"}` (completed) in range —
commission base = the charged `orderPrice` (CORE invariant 3 — not pre-discount since 2026-08-04), revenue by method **minus coins**
(`orderPrice - coinsValue`), coupon split from per-source `couponUsages` docs. `summaries.js`
serves partner/driver self-service views via `calc.js`.

**Who may call them** (CORE invariant 17). `overview`, `partners`, `analytics`, `stores-export`,
`drivers` and `delivery-company-drivers` are MASTER_ONLY on `utils/restricted-admin-routes.js`.
`stores-export-new` and `school-students` are gated on their own lines: `settlementDashboard`, any
dashboard role. They are not on that list on purpose. `stores-export-new` is also the store
report's self-call, and reports are generated by `admin` accounts too. `school-students` serves the
schools screens (sidebar `admin/manager/viewer`). `admin/drivers/summary` (`summaries.js`) is
`companyAdminSelf`: a shoofir delivery-company admin's own company, with the admin taken from the
token. `partner/{summary,daily-orders,details}` are `partnerEarningsAccess` (a dashboard role, or
the partner token whose own `storeUsers.appName` is the `app-name` header) and
`driver/{summary,details}` are `driverEarningsAccess` (a dashboard role, the driver's own token id
as `driverId`, or his delivery-company admin), both `services/payments/earnings-access.js`.
`GET /api/payments/delivery-companies` is `settlementDashboard` (admin web only).

**Live financial overview (2026-09)** — `services/financial-overview/{compute,metrics,contract-charges}.js`
+ `routes/financial-overview.js` (`GET /api/financial-overview?startDate&endDate`, role `master` only — `ROLES = ["master"]`, owner-only since 2026-10-05),
the admin screen "תמונת מצב כספית". It **runs `generateStoreReportData` and `generateDriverReportData`
over any range without persisting**, so it cannot disagree with a report; the 26 owner metrics are a
pure reshaping (`storeMetrics`/`driverMetrics`). Beside the engines it reads raw `compensations` by
PAYER×recipient (the report fields are recipient-filtered), F1–F3 per company/store via
`effectiveDeliveryFee`/`couponDeliverySplit` on `book-delivery` `status:'4'`, and equipment/setup from
the contract dropdown label. Each figure carries the stored report's value for the SAME range with a
delta (`compareWithStoredReport`; no report = null, never 0). Cached 5 min per range, Redis-locked,
202 while another process computes. See shoofi-server `docs/financial-overview.md`.
*Courier cash/card rows.* D1 "מזומן נטו" = `feesByCash − earningsByCash` (company level: gross cash
fees minus what Shoofi pays on cash orders = what the courier kept at the door); D2's gross is
`feesByCreditCard`. Per driver the gross is `earningsByCash` and the payment `actualEarningsByCash` —
see §6 for why the names flip. D1 has no stored-report field, so its trust column is "—" by design.

*Store population (2026-09) — by DATA, not by today's visibility.* Candidates are every non-mock
store (`getAllNonMockStores` in `services/exec-dashboard/store-registry.js`; `isMockStore` is the
only test-store convention, there is no deletion flag). Live stores (visible, not coming-soon) are
always run through the engine; a non-live store is run only if `probeNonLiveStores` (compute.js)
finds an order of ANY status, a compensation by `order.storeData.appName`, a pending carry-over, a
delivery-only booking, or an overlapping stored report in a window **2 days wider** than the range
each side (the engine snaps to business-day boundaries, so the probe must over-select). A store is
kept when `metrics.storeHasData` says its live report is not all zeros: any non-zero ACTIVITY field
(`STORE_ACTIVITY_FIELDS`: orders, revenue by method, drive-in, coins, product discounts, Shoofi
coupons, campaigns, compensations both ways + carry-over, delivery-only fees, commission) keeps any
store; CONTRACT charges (`monthlyCharges`/`oneTimeCharges`) keep only a live store — the monthly
generator bills them to live stores and never to hidden ones (08/2026: ~16 closed hidden stores
still carry an open ₪118 monthly row). Derived totals (`totalOutcomes`, `totalForTransfer`, …) are
never consulted. A store with an EXACT-range stored report is always kept; a store whose engine
throws is always kept (flagged). Why: filtering on `business_visible` dropped el-patron, qashtuta,
royal-asado and crunchy-toost (₪4,111.92 owed, sent August reports) once they were hidden.
`missingReports` lists kept stores with no stored report OVERLAPPING the range
(`metrics.storedReportCoverage`: `exact` | `wider` (multi-month, e.g. abuissa-grills / the-x
01.07–31.08) | `partial` | `none` — any overlap counts as present; only `exact` is diffed).

## 5. Store ↔ Shoofi tax invoices — `routes/hyp.js` / `utils/{hyp,greeninvoice,invoice-provider}.js`
Provider = `amazonconfigs {app:"invoiceProvider"}.active` (`greeninvoice` default | `hyp`).
**Who may call `/api/hyp/admin/*`** (CORE invariant 17): every route not on
`utils/restricted-admin-routes.js` takes `settlementDashboard` (any dashboard role) on its own
line — invoices, `config/switch`, the per-store/per-company HYP account routes; the 16 bulk /
`send-oauth-link` / `update-email` routes are MASTER_ONLY via that list. The switch writes no
actor (`amazonconfigs` keeps only `switchedAt`). Until 2026-11 the audit log did not map `hyp` routes;
since then every `/api/hyp/admin` write is in `services/audit/admin-audit-routes.js` (category
`invoicing`, a test walks the router), so who switches, disconnects, issues or sends is recorded. `/api/hyp/oauth/callback` (HYP's OAuth redirect) stays open.
- **Shoofi → store commission invoice**: amount = `totalOutcomes`. GreenInvoice type **320**
  (tax invoice+receipt, when `totalForTransfer>0`) else **305**; HYP always docType **305**, itemized.
- **Store → Shoofi invoice (on behalf of store)** (`create-store-invoice`, `hyp.js`): amount =
  CC revenue + driveIn-CC (coins-CC is a line inside it, netted back out); **no ÷1.18 for any business type**
  since 2026-08-03 (CORE invariant 1); docType **300 (receipt) if exempt else 305**;
  uses the **store's own** HYP `api_key` (`createInvoiceOnBehalf`), customer = Shoofi.
- **Credit notes** = docType **330** (reversals / negative balance).
- **`ua_uuid` is for CUSTOMER documents only.** The per-order customer document
  (`utils/hyp.createCustomerInvoice`, payments' territory) is issued on behalf of a
  sub-account via `ua_uuid`. None of the settlement documents above send it, deliberately:
  routing a store invoice or credit note to a different business changes whose books it
  lands in. If you touch `utils/hyp.js`, keep the field inside `createCustomerInvoice`'s
  own object literal.
- **Israel allocation-number rule** (`utils/invoice-allocation.js`, threshold **₪4,999 before VAT** =
  ₪5,898.82 gross): a non-exempt tax invoice above it needs a Tax Authority allocation number (מספר
  הקצאה). Since 2026-11 `create-store-invoice` runs the full pre-check (CORE invariant 19,
  `services/invoicing/store-invoice-precheck.js`) and **fails closed** — it was fail-open until then.
- **HYP / EZcount lifecycle (verified 2026-11-05 against prod and EZcount's API collection,
  documenter.getpostman.com/view/16363118/TzkyNLWB):**
  1. *Connect* the store's EZcount account to Shoofi: `create-account` (distributor sub-account,
     `POST /api/user/create` → `u_uuid` stored as `hyp.ua_uuid`, `u_api_key` as `hyp.api_key`;
     153 stores) or `oauth-url` → `/general/oauth2/authorize` scope `CREATE_DOCS SSO` → callback
     stores the access token as `hyp.api_key` (18 stores; `refresh_token` stored, never used). The
     `ua_uuid` is NOT sent on settlement documents (see the bullet above).
  2. *Tax Authority approval* by the OWNER: `taxMinistryURL` (…/front/auth/igniteTaxAuthorityOauth2/<u_uuid>,
     from the distributor list or `getBusinessData.taxAuthorityURL`), sent by `send-tax-url` /
     `bulk/send-tax-urls` with WhatsApp template `tax_authority_approval`. It **expires**:
     `maxConsentDate`, ≈ 3 months after approval (91–95 days after `taxUrlSentAt` on prod). Renewal =
     the owner opens the same URL again.
  3. *Validity* — `GET /v2/api/distributors/users` (distributor key: `isHaveAccessTokenAndValid`,
     `maxConsentDate`, `taxMinistryURL`, all stores incl. OAuth) and `GET /api/users/getBusinessData`
     (store key: same + `isTaxAuthorityUserLocked`, `u_comp_type`; 401 `insufficient_scope` for OAuth
     tokens). Cached per store as `hyp.taxAuthority` (`services/invoicing/tax-authority-state.js`).
  4. *Per document* — `POST /api/documents/getTaxMinistryAllocationNumber/{doc_uuid}` (issuer's key)
     returns the number or the Authority's refusal (`Refresh token has expired`, `The user is locked…`,
     errNum 460 = refused, text must be shown to the issuer). The public `pdf_link` answers 302 when
     ready, **429 while not ready ("מסמך לא מוכן")**, 417 while awaiting allocation.
  5. *Stuck document options at EZcount* (none exposed in the admin; human decisions):
     `ignoreApproval`, `addApprovalNumber`, `furtherObjection`, `cancel`, `reverseTax` (our
     `cancelInvoice` uses this one — it also issues a zero-VAT document). Our recovery is
     `recheck-allocation` after the owner renews / unlocks.
- **Per-step tracking** of the store run (`services/invoicing/report-steps.js`, CORE invariant 19):
  `recordStep` from `reports/generate` (generate), `create-store-invoice` (storeInvoice + allocation),
  `create-invoice` (shoofiInvoice), `send-invoice` (allocation + send), `recheck-allocation`
  (allocation), `cancel-store-invoice` (storeInvoice → pending). The GreenInvoice path
  (`/api/payments/admin/reports/:id/create-invoice|send-invoice`) records no steps (HYP is the active
  provider in prod).
- Invoice fields land on `storeReports` (`greenInvoice*`, `hyp*Invoice*`, `invoiceProvider`).

## 6. Driver / delivery-company settlement — `routes/driver-reports.js`
`POST /api/driver-reports/admin/generate` , same guard pattern. Pay from
`delivery-company.bookDelivery` status `'4'` (delivered) per company.
**`actualDriverPayment`**  — what Shoofi owes the driver (the cash-vs-card crux):
- CREDITCARD → full `effectiveShippingPrice` (Shoofi captured the card).
- CASH + `delivery`/`full_discount` coupon → the coupon-covered delivery amount (Shoofi pays).
- **CASH, no coupon → 0** (driver already kept the cash). **A bug here double-pays a driver.**
Plus: **bonuses** (`drivers-bonuses`, read straight from Mongo by `deliveryCompanyId` + `date`; written
only by the dashboard-only `/api/shoofiAdmin/driver-bonuses*` routes, CORE invariant 17), **compensations** (`shoofi.compensations`, `compensationFor:'driver'`;
`payingParty` decides direction), **min-hourly guarantee top-up** (`max(0, hours*minPerHour - earned)`,
hours from `driverDailyHours` nightly cron w/ live fallback), exempt `÷1.18`.
`netTotal = totalDriverPayment + bonuses + compensations + minGuaranteeTopUp - driverCharges`.
Cash fees are reported as receipts but are **NOT** in the transfer (already in the driver's pocket).

**Who a driver report and its invoices are sent to** (`delivery-company.store`, verified 2026-11-05):
- **Report** `POST /api/driver-reports/admin/reports/:id/send` (approved or sent only): a WhatsApp
  `monthly_report` (month, `pdfUrl`) to **`company.phone`**. Only a company with no `phone` falls back to its
  active `accounting.billingContacts`. It sets `status: 'sent'`.
- **Company invoices** `POST /api/hyp/admin/driver-reports/:id/send-invoice` (`routes/hyp.js`): a WhatsApp
  `shoofir_monthly_invoice` (month, credit link, additions link) to **`company.contactPhone || company.phone`**,
  with billing contacts only when both are empty. So when `contactPhone` is set, the report and the invoices go
  to different numbers. A missing link is sent as the text `לא הופקה`. 400 when neither link exists.
- Both routes then mark the report (`status: 'sent'` / `hypCompanyInvoiceSent: true` +
  `hypCompanyInvoiceSentAt`) **unconditionally** and answer 200 with per-contact results
  (`whatsappResults` / `results: [{contact, success, error?}]`), **even when every WhatsApp failed**.
  `success: true` is weaker still: `utils/whatsapp.js` `sendWhatsAppTemplate` returns without throwing when
  WhatsApp is inactive or misconfigured, or when respond.io contact creation fails, and the route records
  those as success. Only a rejected message POST becomes `success: false`. Delivery is checked
  asynchronously afterwards (`checkMessageStatus`), never by the route. **A 200 is not a delivery.**
- The legacy `POST /api/driver-reports/admin/reports/:id/send-invoice` (GreenInvoice `greenInvoiceUrl`,
  `monthly_invoice` to billing contacts, sets `invoiceSent`) is not called by the admin web.

**Bulk "שלח חשבונית"** (admin web `DriverReportsList.tsx` → `BulkInvoiceSendModal.tsx`, pure rules in
`views/admin/driver-reports/bulkInvoiceSend.ts`, 2026-11). It calls the per-report `send-invoice` above,
**sequentially** (one awaited call at a time, never `Promise.all`). Before sending, it resolves the selection
to full documents in this order: current page → one list refetch with the same filters (rows carry
`invoiceStatus`) → the single-report GET (which has no `invoiceStatus`). Classification, first match wins:
1. **no invoice**: both links empty. Always skipped, because the server would 400.
2. **partial**: `invoiceStatus.missingAny` (the server's `utils/driver-invoice-status.js`; the client never
   re-derives it), or, on a row without `invoiceStatus`, only one link present. Skipped unless the admin opts in.
   It warns rather than blocks because that status is known to be slightly off (CORE invariant 18 "Flagged":
   booking fees left out, negative additions folded into invoice 1).
3. **already sent**: `hypCompanyInvoiceSent`. Skipped unless the admin opts in to resends.
4. otherwise **sent**.

A send counts as success only if the HTTP call resolved AND `results[]` has at least one `success: true`.
Anything else is listed as failed, with the company and the reason. Because the server has already marked a
failed one sent, the summary offers "retry the failed ones" by id. A plain re-run with "only not-yet-sent"
would skip them. Even a counted success is only "the server reported a send" (see above), never proof of
delivery. Pinned by `__tests__/bulkInvoiceSend.test.ts` and `tests/e2e/reports/driver-invoice-bulk-send.spec.ts`.
The list shows `hypCompanyInvoiceSent(At)` per row ("נשלחה <date>" / "לא נשלחה"). It has **no**
"invoice sent" filter, because the list endpoint has no such query param and a client-side filter on a
20-row page would misstate the page counts and select-all. Adding one needs a server param.
The bulk report **"שלח"** on the same screen counts only HTTP failures. A 200 whose WhatsApps all failed
still counts as sent there. Known, not fixed.
**⚠️ Field names change meaning by level (trap, 2026-11).** In `generateDriverReportData`, **per
driver** (`driverPayments[]`) `earningsByCash` / `earningsByCreditCard` are the **GROSS** fees
(`effectiveShippingPrice`) on CASH / CREDITCARD orders. At **company level** the SAME names are
`totalEarningsByCash` / `totalEarningsByCreditCard` = Σ `actualEarningsByCash` /
`actualEarningsByCreditCard` — what Shoofi **PAYS** on those orders. On cash that is only the
coupon-covered part + a store delivery deal (`promotionDeliveryPayment`), so a company's
`earningsByCash` equals `earningsByCoupons` whenever no deal applied (all 60 most recent stored
reports, 2026-11-02). The company **gross** fees are **`feesByCash` / `feesByCreditCard`** (the PDF's
"מזומן" line reads `feesByCash`). Card is the same number either way (Shoofi pays the full card fee);
cash is not. Never read the company `earningsByCash` as "cash collected": the financial overview did,
and showed "מזומן נטו" = ₪0 for 10/2026 (real ₪97,716).

## 7. MASAV bank payouts — `routes/admin/masav.js`
`POST /api/admin/masav/generate`  — **decoupled from the reports**: consumes a
**manually-built Excel** (payee `Name, ID(9), Bank, Branch, Account, Amount`), not the report docs
directly. Emits the Israeli MASAV `.201` fixed-width (128-char) file: header(K)/transaction(1)/
summary(5)/closing(9); amounts → agorot (`Math.round(amount*100)`); Hebrew names visual-reversed;
**CP862 (DOS-Hebrew) encoding** for Bank Leumi. Bank/branch/account originate from store/company
`accounting.bankAccount` (via the Excel). **There is no automated report→MASAV linkage in code** —
a human bridges it. Payout amount = store `balance` / driver `netTotal`.

## 7b. Hashavshevet export (movein.dat) — `services/accountant-export/`, `utils/hashavshevet-movein.js`
`GET /api/payments/admin/accountant/movein?month=YYYY-MM&tab=stores|drivers[&docs=k1,k2]` (route in
`routes/payments/admin-reports.js`; button "הורד DAT" on the admin "חשבוניות שופי לרואה חשבון"
screen, `views/admin/invoices/AccountantInvoices.tsx`). The accountant's journal-import file for the
documents **we issued** through HYP/EZcount, answered as JSON (`contentBase64` + what was left out).
- **Byte format** (`utils/hashavshevet-movein.js`), reverse-engineered from the accountant's own
  export and byte-tested against an excerpt of it (`test/fixtures/movein-example-excerpt.dat`):
  Windows-1255, Hebrew in **logical** order, CRLF; line 1 = 180 × `0`; one 178-char record per
  document, records separated by an **empty line**; all fields right-aligned. Offsets: ref [0,8),
  date DDMMYY [8,14), value date [14,25), `"  $"` [25,28), name (first 22 chars) [28,50), debit
  accts [50,58)+[58,66), credit accts [66,74)+[74,82), debit amts [82,94)+[94,106), credit amts
  [106,118)+[118,130) (2 decimals; zero = bare `0`), spaces to 178.
- **Month = the DOCUMENT date** (end of the report end date's month, as `create-invoice` dates it),
  not the reports list's date-range overlap — a multi-month report is exported once.
- **Amounts are EZcount's, not ours** (`ezcountInclusiveTotals`): per item line net =
  round(price/1.18, 4), VAT = round(net×0.18, 4); document net and VAT = those sums rounded to 2;
  gross = net + VAT. `storeInvoiceTotals` rebuilds the line prices `create-invoice` sends
  (`settlementInvoiceLinePrices` — a mirror; keep it in step) and, when they don't add up to
  `totalOutcomes`, uses the one-line rule on the total. Reproduced **259/259** system-issued
  May–June 2026 invoices exactly. `round2(totalOutcomes)` is wrong by an agora on ~1 in 6.
- **Stores tab** (`STORE_INVOICE_ACCOUNTS`, proven by the example): invoice = debit the store's
  `accounting.accountantFileNumber` gross / credit **50001** net + **40002** VAT; ref `"9"+docNumber`
  (`hypInvoiceDocNumber`). Credit note mirrored, ref `"12"+docNumber` (prefix seen only on manual
  credit notes). History entries reversed by a credit note export both documents; cancelled
  without one, or GreenInvoice (no doc number) → listed as `excluded`.
- **No מספר תיק = skipped, not fatal** (owner decision 2026-09-29): a document whose store/company
  has no usable file number (1–8 chars, no whitespace) is left out of the file and listed in
  `skipped` with its document keys; the UI shows it as a note. Because a movein import is not
  idempotent, the note warns not to re-import the whole month and offers "הורד רק את המסמכים שחסרו",
  which re-requests with `docs=<those keys>` (keys: `type:docNumber` for stores — one HYP sequence;
  `type:companyId:docNumber` for companies — per-company numbering; max 500).
  Every document skipped → **422 `nothing-exportable`** (no header-only file). A document that can't
  be written exactly whatever the accountant does (bad document number, non-positive amount) still
  → **422 `blocked`**, whole file refused.
- **Drivers tab**: "חשבונית חברה" / "חשבונית פיצויים" are issued BY each company from its own HYP
  account (`create-company-invoice` → `createInvoiceOnBehalf`, customer = Shoofi), for money Shoofi
  pays out (`earningsByCreditCard`; compensations/bonuses/top-up); numbered per company. They are the
  counterpart of the stores tab's "חשבונית חנות", not of Shoofi's invoices, and the accountant's
  file contains neither kind (verified 2026-09-28). They are Shoofi's **purchase** side; the expense /
  input-VAT accounts and ref prefix are unknown → `DRIVER_INVOICE_ACCOUNTS` all `null` →
  **422 `missing-config`** until the accountant supplies them. The purchase layout (debit expense
  net + input VAT, credit company gross) is the credit-note layout and is unverified.
  The "חשבונית חברה" (invoice 1) amounts come from `companyCreditInvoiceLinePrices`. When the
  report's deductions exceeded its additions, the document carried two lines, the credit row
  plus a negative `פיצויים מהשליח` row (CORE invariant 18), and the route stored them as
  `hypCompanyInvoiceItems`. The export reads those lines exactly as sent. Otherwise it uses the one
  credit line (`withoutVATIfExempt(earningsByCreditCard)`). Invoice 2 comes from
  `companyAdditionsLinePrices`, a mirror of the route's builder. The merged document is booked
  whole to `expenseAccount`.
- **It is not the full HYP ledger.** Documents issued by hand in HYP (receipts, manual invoices,
  manual credit notes) and any HYP document whose number never reached our DB are absent — the
  accountant's May–June file had 26 such records out of 285.

## 8. Data model
- **`shoofi.storeReports`** (collection `store-reports`) — `{storeId, appName, dateRange, reportType, status(draft|approved|sent),
  reportData{creditCardRevenue, cashRevenue, coins*, driveIn*, couponsFromShoofi,
  compensationsFromShoofi, totalIncomes, commission, coinsCommission, vatOnCommission, oneTime/
  monthlyCharges, campaigns, compensationsTo*, carryover*, driveInShoofi, totalOutcomes,
  totalForTransfer, totalForInvoice, balance, commissionPercent, businessType,
  compensationWindow{start, endExclusive} (2026-10+; absent on older reports)}, reportSent,
  invoiceSent, invoiceReceived, transferPerformed, pdfUrl, greenInvoice*, hyp*Invoice*,
  hypStoreInvoiceAllocationNumber, hypStoreInvoiceAllocationCheckedAt, hypStoreInvoiceCreateResponse (the
  whole createDoc answer), hypStoreInvoiceCreatingAt (idempotency claim while createDoc runs),
  invoiceSteps{generate,storeInvoice,shoofiInvoice,allocation,send: {step, status ok|failed|blocked|pending,
  code, reasonHe, raw, details, at, by{id,name}}}, invoiceStepHistory[] (same entries, last 200),
  invoicePrecheck{ok, blockingCount, warningCount, requiresAllocation, amount, businessType,
  problems[{code, severity block|warn, messageHe, nextActionHe, action, field?}], taxAuthority, at, by}}`
  (CORE invariant 19; shoofi-server `docs/invoice-step-tracking.md`). The list route adds a computed
  `taxAuthority{approvalState, maxConsentDate, isLocked, taxMinistryURL, taxUrlSentAt, lastTaxUrlSend}`
  per row (plus `ezcountBusinessType`), the row's filter chip `stepCategory` (problem | ready | done | open,
  `reportCategoryOf`), filters `stepFilter=problem|ready|done` (`stepProblems=true` = problem) and, with
  `includeStepCounts=true`, returns `stepCounts{all, problem, ready, done}` over the other filters
  (`REPORT_CATEGORY_FILTERS`, `services/invoicing/report-steps.js`).
- **`shoofi.driverReports`** (collection `driver-reports`) — `{deliveryCompanyId (string), dateRange, reportData{totalDeliveries,
  totalDriverPayment, earningsBy*, totalBonuses, totalCompensations, totalDriverCharges,
  totalDeliveryBookingDriverFees, totalMinGuaranteeTopUp, netTotal, driverPayments[]}, status,
  transferPerformed, pdfUrl, hypCompanyInvoice{PdfLink,DocId,DocNumber,DocUuid,CreatedAt,Items},
  hypCompanyAdditionsInvoice{PdfLink,DocId,DocNumber,DocUuid,CreatedAt},
  hypCompanyInvoiceSent, hypCompanyInvoiceSentAt (set by `/api/hyp/admin/driver-reports/:id/send-invoice` even
  when every WhatsApp failed, §6), hypCompanyInvoiceHistory[]}`. Company → Shoofi documents (CORE invariant 18):
  `hypCompanyInvoiceItems` is written only when invoice 1 carried the negative deductions row. Both the
  admin web (`DriverReportDetail.tsx`, `DriverReportsList.tsx`) and `send-invoice` show whichever
  link exists, so a report with only invoice 1 displays correctly.
- **`delivery-company.driverDailyHours`** — `{driverId, date, activeMinutes, inShiftMinutes,
  inWorkingHoursMinutes, …}` (nightly cron; live fallback from `driverStatusHistory`+`driverShifts`).
- **`shoofi.compensations`** — `{order, items:[{status(0|1|2), compensationFor('business'|'customer'|
  'driver'|'shoofi'), payingParty('shoofi'|'business'|'driver'), approvedAmount, driver, deliveryCompany}],
  appNameBackfill{pendingReportCarryover}, createdAt (BSON Date — the settlement clock)}`. Attributed to the
  report whose window contains `createdAt` (CORE invariant 10), locked once that report exists.
  `payingParty !== compensationFor` is enforced on add/edit
  (`services/compensations/validate-parties.js`). `order._id` is the store order `_id` (admin web,
  partner) or the `bookDelivery._id` (driver-filed). `createdBy` is an admin `_id` or, on mobile rows,
  the store's or driver's name. `requestedByBusiness` / `requestedByDriver` flag mobile rows: 49 and
  279 in prod, the newest driver row dated 2026-05-27. `compensationFor:'shoofi'` = the store (or driver) owes
  Shoofi — store report outcome `compensationsToShoofi`, driver report `totalDriverCharges`; no coupon.
- **Store `accounting`** (store's own DB): `accountantFileNumber` (the accountant's מספר תיק = the
  Hashavshevet customer account the movein export debits; also on `delivery-company.store`),
  `bankAccount{bank,branch,accountNumber,companyId,
  businessType('exempt'|'licensed')}`, `billingContacts[]`, `contract{commissionTiers[],
  coinsCommissionPercent, monthlyPayments[], onetimePayments[]}`, `store.hyp{ua_uuid,api_key,access_token,status,
  connectionMethod, taxUrlSentAt (only on a real send since 2026-11), taxUrlSendLog[] (last 20: at, by,
  phone, method, ok, error), taxAuthority{checkedAt, source business_data|distributor, matched,
  isHaveAccessTokenAndValid, maxConsentDate, isLocked, ezcountBusinessType, ezcountCrn, taxMinistryURL,
  businessDataUnavailable oauth_scope|error, lookupError, approvalState, raw}}`. `businessType` values in prod:
  `authorized_dealer` | `company` | `exempt` (and legacy `licensed`); 46 stores had none on 2026-11-05.
  Who may write it: `POST /api/store/update` takes `accounting` (and `hyp`, `coinsSettings`) only from a
  dashboard token. A partner token's write is cut to its store-management toggles (menu-catalog CORE
  invariant 28). The billing-contacts screen saves through that route with the admin's own token.
- **`shoofi.amazonconfigs`** — `{app:"greeninvoice"|"hyp"|"invoiceProvider"|"amazon"}` (provider creds/switch; never print).
  `{app:"hyp"}` also carries `CUSTOMER_DOC_UA_UUID` (customer-document sub-account; empty = don't send)
  and `USE_DEMO`/`API_ENDPOINT`/`DEMO_ENDPOINT`. **No admin UI edits this document** — prod changes are a manual Mongo write.
- **`shoofi.couponUsages`** — per-source discount rows (store/shoofi × items/delivery).
- **`shoofi.coupon-drafts`** (`db.couponDrafts`) — support's coupon drafts, central DB only:
  `status draft → approving → created | discarded`, `templateId`, `params`, `funding{mode, shoofiPercent?}`
  (always stored on the coupon as `splitType: 'percentage'`, CORE invariant 13), `approval{code, fields, at, by, translationKeys}`, `coupon{_id, code, at}`. Holds NO money
  of its own — the coupon it produces is an ordinary `shoofi.coupons` doc written by
  `POST /api/admin/coupon/create`, and settlement never reads the draft. Schema and lifecycle:
  shoofi-server `docs/coupon-drafts.md`; money rules: CORE invariant 13.

## 9. Client — shoofi-delivery-web (admin) is the accountant's cockpit
The reports/settlement/payout UI lives in the **admin** app: `views/admin/DriverPayments.tsx`,
`DriverBonuses.tsx`, `CompensationManagement.tsx`, `driver-reports/` (list bulk bar: report אשר/שלח/Excel/מחק
and company צור חשבונית / שלח חשבונית — the bulk invoice send's rules are in §6), `financial-overview/` (the live
26-metric screen, tabs: summary / Shoofi expenses / stores / companies / delivery fees; the summary
opens with "חנויות עם נתונים בלי דוח" (`MissingReports.tsx`, fed by `missingReports`), and hidden /
coming-soon stores carry a red `VisibilityBadge`), plus store-report screens
and `generate-stores-summaries.tsx`; `app-type: shoofi-admin`. The store reports list
(`views/admin/reports/ReportsList.tsx` + `invoice-steps/`, redesigned 2026-11-06) is a 7-column grid
(`ReportRowFrame.tsx`, 842px, sized for the content area at a 1280px viewport): ☐ · חנות (period, first
problem + "+N") · סכומים · דוח · תשלום (the two toggles) · שלבי חשבונית (`StepTracker`, five dots
דוח → חנות → שופי → הקצאה → שליחה; the approval state is the הקצאה dot) · פעולה הבאה (`RowActions`: one
next action, a ⋯ menu with EVERY other action, a chevron to `RowDetail` — מה צריך לטפל / היסטוריית פעולות
with EZcount's raw answers / רשות המסים ומסמכים). Filter chips הכל / עם בעיה / מוכן לשליחה / הושלם use
`stepFilter` + `stepCounts`. The row is a translation of the server's records (`storeRowModel.ts`); it
decides no status. "בדיקה מקדימה לחשבוניות" creates nothing; bulk create / send run 3 at a time with a
per-store result.
`ReportDetail.tsx` adds the full step history with EZcount's raw answers. `hyp/HypManagement.tsx` shows each
store's approval expiry and expired / expiring / locked counts. This is where a human generates,
approves, sends reports, and exports the MASAV Excel. (Full-stack: server computes, admin drives.)

## 10. ⚠️ Known risks / flagged for verdict (money-critical — do NOT silently "fix")
1. ~~**Overlap guard ignores `sent` reports**~~ — FIXED: `checkOverlappingReports` checks every
   status (CORE Known status). Kept for history.
2. **`DELETE report` accepts any status** — decided INTENTIONAL 2026-08-03 (CORE Known status):
   a wrong sent report must be regenerable; an issued tax invoice is only warned about. Deleting
   a report also reopens its compensations to edits (CORE invariant 10).
3. **`reset-invoice`**  unsets invoice fields, re-enabling `create-invoice` → **double-invoice
   risk** if misused. Intended re-issue path? Guard it?
4. **Hardcoded IDs** — GreenInvoice `businessId = '9058c694-…'`  and `itemId`/`catalogNum`
   (`greeninvoice.js`). Intended constants, or should they be config?
5. **Two VAT handling paths** — report `vat = *0.18` vs exempt `÷1.18` applied in several
   independent places (store balance, store→Shoofi invoice, driver CC, min-guarantee); any rounding
   divergence is a payout risk. Worth a single source of truth?
6. **No automated report→MASAV linkage** — payout amounts are re-keyed into an Excel by hand
   (`masav.js`), an error-prone gap. Leave manual, or is closing it desired later?

7. **`create-invoice` does not itemize `carryoverToCustomers` / `carryoverToDrivers`** (`routes/hyp.js`)
   although both are inside `totalOutcomes`, the invoiced amount — so on such invoices the item lines
   do not add up to the document total and EZcount's `auto_balance` covers the gap. Seen on 31 of the
   259 May–June 2026 invoices (e.g. 10473: lines 2181.48, invoiced 2214.48, carryoverToDrivers 33).
   Found 2026-09-27; `routes/hyp.js` is do-not-touch — needs a decision.
8. **Duplicate HYP settlement invoices never recorded in our DB.** The accountant's May–June 2026
   export holds 19 invoices (10562–10582, dated 30/06/26, batch of 2026-07-07) with the same store
   and amount as the invoice our DB records for that store's June report (e.g. brixta 10576 and
   10580, both ₪545.04). Our DB knows only the later one. Unless cancelled at HYP, those stores were
   invoiced twice for June. Found 2026-09-27 — needs a human to check HYP and decide.

9. **Percentage-split percentage coupons are billed as percent points** (`routes/payments/admin.js:1190-1191`,
   CORE invariant 7 + Known status). Found 2026-10-26 while designing coupon drafts; ₪0 exposure in prod
   today (2 coupons, both `storePercent: 0`). Drafts exclude `store_percentage_off`; the ordinary form
   does not. Needs an owner ruling before either path makes one with a store share.
10. **The #320 template picker's fixed default split** (`services/coupons/coupon-templates.js`
    `SPLIT_FIELDS`) does not follow the amount. Too low → 422 (`COUPON_TEMPLATE_INVARIANT`); too high →
    silently leaves part of the value unassigned (CORE invariant 13). Drafts replace it with a percent
    split; the plain picker → CouponForm path still has this.

11. **Store invoices that never got an allocation number** (CORE invariant 19 + Known status): GCP 10059,
    burger-house 10044, qamha 10030 + 10027, aldo 10002 — sent, stuck. Owner action + "בדוק הקצאה".
    On 2026-11-05 (read-only snapshot of 177 stores): 9 approvals expired (abu-saleh-kitchen, b-fresh,
    beit-toest, cafe-365-qalansuwa, el-patron, flora-boutique, greg, pasta-de-amor, shawerma-alarz),
    4 expire within 21 days (abu-aldeeb, farnosh, shnetzel-5-taamim, tortilla), 3 users locked
    (abomoayed-bakerya, aldo, qamha), 95 never approved, 4 connected stores not in the distributor list.
12. **Business-type data**: 46 stores have no `businessType` (now blocks their store invoice);
    smoky-city and chorizous-taybe disagree with EZcount on exempt status (blocks; a human decides which
    side is right — it also changes customer-receipt VAT); 11 more differ only מורשה vs חברה (warns).

## 11. Definition of done
Inherit `_shared-guardrails.md` §7. For accountant specifically: for ANY change to a payout or
invoice amount, **trace the full money path** (who collected cash/card → who is owed what) and
state it in the PR; preserve the `totalForTransfer`/`balance` formula, the `actualDriverPayment`
cash-vs-CC branch, the pre-discount commission base, and the invoice idempotency guards; never
introduce a new rounding/VAT point without reconciling the existing ones; and never claim an
invoice or MASAV change is correct without a dry-run / sandbox. When in doubt on real money, stop and ask.
