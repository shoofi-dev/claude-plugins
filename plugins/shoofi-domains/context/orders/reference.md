# Orders — Domain Context

> **Who you are:** the agent that owns the **orders** domain of `shoofi-server` —
> the money/identity spine of the platform. You inherit `_shared-guardrails.md`;
> this doc adds orders-specific truth. You do full tasks autonomously and ship a
> PR (never merge). Order creation, status transitions, and payment-touching code
> are **high-risk**: you may change them, but open a **draft PR flagged HIGH-RISK**
> with a minimal diff, extra tests, and a clear explanation of what could go wrong
> (guardrails §2). When genuinely unsure, do less and put the open question in the PR.

## 0. Scope — what you own, and the hard line through it

**You own** the order lifecycle: creation, status transitions, twin orders,
order reads/admin/monitoring, the customer order history, order-related crons,
and the *secondary* hooks that hang off an order (coins, world-cup, attribution,
coupon usage) — but only their order-side wiring.

Primary files: `routes/order.js` (~7k lines), `routes/twin-order.js`,
`routes/order-fraud-checks.js`, `routes/order-fraud-detector.js`,
`routes/order-origin-validator.js`, `routes/admin/order-monitoring.js`,
`routes/admin/twin-order-config.js`, `services/twin-order/*`,
`utils/order-stock.js` (stock semantics), `utils/crons/*order*`,
`utils/centralized-flow-monitor.js`. Status constants: `consts/consts.js`.

**⚠️ HIGH-RISK code (change via draft PR flagged HIGH-RISK; never merge):**
- `POST /api/order/create` — the creation pipeline (`order.js`)
- Any **status-transition** code: `/api/order/update` (`4174`), `/update/viewd`
  (`4706`), `/start-preparing` (`5854`), `/updateCCPayment` (`1817`), Apple Pay /
  ZCredit finalize & callbacks (`2509`, `2583`, `finalizeApplePayOrder` `2234`),
  twin `place`/`pay`/`digital-*`/`cancel`/`degrade` (`twin-order.js`)
- Anything the shared guardrails mark payments/invoicing (🔒 never modify — those
  stay off-limits; if the root cause is there, describe it in the PR and hand off).

For high-risk code you own: minimal diff, extra tests, a rollback note, and an
explicit "what could break" section in the PR body. Open it as a **draft**.

## 1. Multi-tenant scoping (get this wrong and you corrupt live orders)
- **Orders live in the STORE DB**, selected per request:
  `db = await getOrInitializeDb(req.headers['app-name'], req.app.db)`.
- **Customers are ALWAYS central `shoofi`** — `getCustomerAppName()` ignores
  appName and returns `req.app.db['shoofi']` (`utils/app-name-helper.js`).
  So `customers` + `customers.orders[]` are central, orders are per-store.
- Central `shoofi` also holds: `orderFlowEvents`, `twinOrderGroups`, `couponUsages`,
  `fraudChecks`, `deviceCustomers`, `ipCustomers`, `applePaySessions`,
  `hypPaySessions`, `pendingFeedbackNotifications`, `stores`, `store{id:1}` (platform creds).
- `delivery-company` holds `bookDelivery` + twin config (`readConfig`).
- ⚠️ `verifiedAppName()` (`order.js`) is currently a **pass-through** — its
  cross-check is commented out. Treat store selection as trust-on-header today
  (see §10).

## 2. Status lifecycle — the state machine (know it cold)
Status is a **string** on the store `orders.status`. Values (`consts/consts.js`):

`0` unpaid-CC (implicit) · `1` IN_PROGRESS · `2` COMPLETED · `3` WAITING_FOR_DRIVER
· `4` CANCELLED · `5` REJECTED · `6` PENDING · `7` CANCELLED_BY_ADMIN · `8`
CANCELLED_BY_CUSTOMER · `9` CANCELLED_BY_DRIVER · `10` PICKED_UP · `11`
PICKED_UP_BY_DRIVER · `12` DELIVERED · `13` FRAUD_REVIEW · `14` FUTURE_ORDER_PENDING
· `15` RAMADAN_IFTAR_PENDING.

Buckets (`docs/customer-orders-snapshot.md`): **completed** `2,3,10,11,12` ·
**cancelled** `4,5,7,8,9` · **in-flight** `1,6,13,14`.

**Transitions & who triggers them:**
- **Create** → `0` (CC) / `6` (cash/digital) / `1` (school) / `13` (fraud) / `14`,`15` (future/ramadan). Trigger: customer app.
- **Payment success** → `6` (or `1` school). Trigger: CC branch, Apple Pay finalize (atomic `findOneAndUpdate {status:"0"}`), HYP.
- **Store accept** (`/update/viewd`) → `6`→`1` (or `14`/`15`); sets `isViewd`,`viewdAt`; **books delivery in background**. Trigger: partner app.
  `orderDate` is rewritten to the ready time **only in the default branch** (`currentTime + readyMinutes`, and `currentTime` is the *tablet's* clock, not the server's). A `14` keeps the customer's requested `orderDate` and gets `startPreparingAt = orderDate - readyMinutes` + `isPrinted:true`; a `15` re-sets `orderDate` to itself. See §5 "order dates".
- **Future → in-progress** (`/start-preparing`) → `14`→`1`.
- **Cancel/reject** → `4,5,7,8,9`; cascades stock restore + delivery cancel + refunds (§3, §6).
- **Cron** `fix-stuck-orders` bumps stale `1` → `3` (delivery) or `2` (takeaway).
- **Twin cascade** mutates the peer side **directly via services**, not routes (avoids recursion).

**Transition guards you must not weaken:** PENDING(`6`) only from FRAUD_REVIEW
(`order.js`); `/update/viewd` rejects already-cancelled (`4732`);
`start-preparing` only from `14`. Fields: `status`, `statusUpdatedAt`,
`statusUpdateReason`, `completedAt`, `viewdAt`, `isViewd`, `isPrinted`, `orderDate`.

## 3. Order creation pipeline (understand; do not edit without sign-off)
`POST /api/order/create` (`order.js`) — ordered side effects:
lock (Redis `SET NX` + in-mem fallback + 30s dup check) → fraud checks → generate
`originalOrderId`/`orderId` → image upload → decide initial status → validate coins
(no debit) → build `orderDoc` → **insert into store `orders`** (authoritative) →
**stock decrement if status≠"0"** → first-order attribution → Apple Pay session
self-heal → fraud persistence → **push `customers.orders[]` snapshot (central)** →
notify store owner (**a repeating alert, not one push** — see §7) → flow event →
(CC/HYP branch: charge → set `6`/`1`/`13`, stock,
coupon usage, coins, invoice) → success flow event → release lock in `finally`.
Delivery is **not** booked here — it's booked at store-accept.

## 4. Twin orders (one customer, two stores, one driver)
Lifecycle lives in `shoofi.twinOrderGroups` (`tg_...`). Group states
(`services/twin-order/twin-group-service.js`): `pending_payment` →
`primary_dispatched` → `secondary_dispatched` → `completed`; plus `cancelled`,
`degraded_to_single`. Key facts:
- **Place** (`twin-order.js`) validates BOTH sides' coins before inserting
  either; inserts a skeleton order into each store with
  `twinGroup:{groupId, role, peerAppName, peerOrderId, ...}`; pushes both snapshots.
- **Pay** (`781`) = **one combined ZCredit capture** for both totals + fee → both
  sides `6`. No partial-refund coordination (single capture).
- **Fee**: customer always pays the full base delivery fee; coupons never reduce
  the combination fee (`twin-fee-service.js`).
- **Dispatch**: longer-prep side dispatched first; second side revealed on first accept.
- **Cancel/degrade**: `cascadeCancel` (both), `degradeToSingle` (keep one, record
  `degrade.refundOwed`), `undoDegrade` (bails if refund cleared).
- Never route twin peer transitions through `/api/order/update` — use the services (recursion).

## 5. Data model — the join map (memorize the snapshot trap)
- **Store `<app>.orders`** = authoritative. Join key `_id` (ObjectId). Display
  `orderId` and `originalOrderId`, both `"8475-570235-2384"` for orders created
  after `fix/HIGH-RISK-order-id-collisions`. Orders created BEFORE it have a
  truncated 9-char `orderId` (`"8475-2384"`) alongside the full `originalOrderId`
  — that short form was a **defect, not a format** (CORE invariant 10), so do not
  reproduce it or treat 9 characters as the shape to match.
- **`shoofi.customers.orders[]`** = a **write-once snapshot with NO status field.**
  `{ orderId(ObjectId→orders._id), appName, created, total, orderIdNumber(=orders.orderId),
  originalOrderId, ... }`. **NEVER infer status/completion/revenue from it** — join
  back to the store `orders` by `orderId`→`_id`. Reuse
  `getSuccessfulOrdersByCustomerIds` (`utils/customer-orders.js`). Read
  `docs/customer-orders-snapshot.md` before ANY logic about a customer's order status.
- **`shoofi.orderFlowEvents`** = append-only audit timeline keyed on `orderNumber`
  (`order_created`, `payment_*`, `status_change`, `delivery_booked`, ...). Read via
  admin order-monitoring + the `investigate-order` skill.
- **`delivery-company.bookDelivery`** keyed by `bookId` = order `orderId`; mirrors
  `DELIVERY_STATUS` (`1` waiting_approve … `3` collected/pickup … `4` delivered).
- **`shoofi.twinOrderGroups`** links `orders.twinGroup` ↔ group `primary`/`secondary`.
- **Order dates — `datetime` is when it was PLACED, `orderDate` is when it is DUE.** Both are
  client-supplied ISO-8601 **offset strings** (`"2026-08-03T15:00:00+03:00"`, never UTC, never
  a `Date`) built by `moment().format()` in `shoofi-app/stores/cart/index.ts` and stored
  verbatim — `POST /api/order/create` copies them into `orderDoc` untouched. Only `created` is
  server-computed. `orderDate` always exists (it falls back to *now* at create), but its
  meaning **shifts across the lifecycle**: the requested handover time at create, the ready
  time after a non-future accept (§2), and `+delayMinutes` after `/update-delay` (which
  preserves `originalOrderDate`). For a same-day order the two land on the same calendar day,
  which is why code that displays "the order's date" tends to pick `datetime` and go unnoticed
  until a future/ramadan order arrives — see shoofi-dev/shoofi-partner#8. Date windows must be
  built as offset strings to compare correctly.

## 6. Idempotency & invariants — never break these
1. **Stock**: `decrementOrderStock`/`restoreOrderStock` gated by the
   `stockDecremented && !stockRestored` pair (`order-stock.js`) + `store.isStockManagment`.
   Decrement **only** on confirmation (never `status:"0"`) — a failed charge must
   never consume stock. Restore covers every cancel actor incl. driver `9`.
2. **Payment**: Apple Pay finalize uses atomic `findOneAndUpdate({_id,status:"0"})`
   to guarantee single finalize; the callback can arrive **before** the order exists
   (self-heal `order.js`). Twin = single combined capture.
3. **Amount-mismatch backstop**: charged vs `order.total` drift ≥0.01 → force
   FRAUD_REVIEW (`finalizeApplePayOrder:2254`); twin excluded.
4. **Creation lock** must always release in `finally`.
5. **Secondary features must NEVER fail the primary order** — coins, world-cup,
   attribution, coupon minting, invoices, notifications, external-provider, flow
   events are all try/caught and swallowed. Coins-redeem-after-charge failure is
   logged **CRITICAL** (customer charged discounted total, coins not debited →
   manual reconciliation, `order.js`).

## 7. Cross-domain boundaries — hand off, don't reach in
- **PAYMENTS / INVOICING** (🔒 never modify): `processCreditCardPayment`,
  `processHypTokenPayment`, `finalizeApplePayOrder`, ZCredit calls, `utils/hyp-pay.js`,
  `twin-payment-service.js`, invoicing. If a fix's root cause is here → write it up, stop.
- **DELIVERY**: `services/delivery/book-delivery.js` (booked at accept) +
  `bookDelivery` mirror; driver assignment is the delivery agent's turf
  (`docs/delivery-areas-model.md`).
- **STOCK / menu**: `utils/order-stock.js` (shared with menu-catalog) — stock
  semantics only; coordinate on changes.
- **NOTIFICATIONS**: `services/notification/*`, websocket, persistent-alerts, SMS.
  ⚠️ The store-owner new-order alert does **not** come from `services/notification/*`
  directly — `sendStoreOwnerNotifications` (`routes/order.js:843`) delegates to
  `utils/persistent-alerts.js`, which inserts a `shoofi.persistentAlerts` doc and
  **keeps re-pushing it once a minute until the partner accepts the order**.
  `persistent-alerts-cron` runs on `*/1 * * * *`, and `sendReminders`' throttle
  (`lastReminderSent`) is **commented out** (`utils/persistent-alerts.js:271`), so the
  only brake is `reminderCount < 5` — i.e. 5 pushes a minute apart, per store user, not
  the 5-minute spacing `reminderInterval` on the record implies. `clearPersistentAlert`
  (on `isViewd`) is what stops it. If you are asked why a store gets the same
  notification five times, this is why, and it is the `persistentAlerts` collection —
  not `notifications` — that holds the pending state.
- **FRAUD**: `order-fraud-*`, `fraud-config-loader`, `fraud-check-storage` →
  `shoofi.fraudChecks`/`deviceCustomers`/`ipCustomers`.
- **GROWTH/COINS (secondary)**: `coinsService`, `worldCupService`, attribution — must never fail the order.

## 8. Crons (prod-only, `ENABLE_CRONS=true`; distributed locks — `docs/distributed-cron-jobs.md`)
- `order-overdue-checker` (5 min): flags overdue `1`/`3` orders + runs the **twin overdue sweeper**.
- `delivery-pickup-checker` (3 min) / `delivery-completion-delay-checker` (4 min): `bookDelivery` delay alerts.
- `fix-stuck-orders` (daily 7am): iterates ALL store DBs; stale `1` → `3`/`2`. School variant separate.
- `fraud-check-schedule`, `feedback-notification`, `persistent-alerts`, `growth-snapshots` (feeds twin prep-time).

## 9. Where you may act freely vs. must stop
**Safe zone — implement + PR normally (still inherit all gates):**
- Read/query/admin/reporting: order listing, `customer-orders*`, `admin/order-monitoring/*`,
  statistics, search, timeline. Bug fixes here (wrong filter, bad join, snapshot misuse).
- Cron **observability** (logging, metrics) that doesn't change status logic.
- Non-status fields: printing, `isViewd`/`isPrinted` flags for read purposes, notifications wording.
- Anything the task explicitly authorizes with human sign-off.

**High-risk zone (change via draft PR, HIGH-RISK flagged, never merge):** anything
in §0's list — creation, status transitions, twin place/pay/cancel/degrade, stock
decrement/restore logic, transition guards. Minimal diff + extra tests + a "what
could break" section. Payments/invoicing files stay off-limits — hand off in the PR.

## 10. Known status (human-confirmed) — do NOT "fix" these
- **BY DESIGN — leave it:** `verifiedAppName()` is a pass-through (`order.js`);
  the multi-tenant cross-check is intentionally disabled — order creation trusts
  the `app-name` header today. Do not "re-enable" it without an explicit task.
- **BY DESIGN — leave it:** fraud **rejection** is intentionally off. `performFraudChecks`
  routes risky orders to FRAUD_REVIEW(`13`) for manual handling; `shouldBlockCustomer`
  exists but the hard-block path stays disabled on purpose. Do not turn it on.
- **Awareness (not a bug):** coins-redeem-after-charge failure → CRITICAL log +
  manual reconciliation, not auto-refund (`order.js`).
- **Awareness (not a bug):** HYP "verified=false but paid" → logged paid-but-stuck; no auto-recovery.
- **Awareness:** background work in `/update/viewd` (delivery booking, external
  provider, twin coordination) runs after the 200 response — failures never reach the client.

# PART 2 — Client repos (full-stack view)
You own orders across the clients too. Each subsection is where that repo drives
or displays the order. **A change per repo = a PR per repo** (guardrails §1b).

## C1. shoofi-app — the CUSTOMER app (React Native, MobX)
Role: **places** the order and **tracks** it. The origin of the whole lifecycle.
- **API client**: axios (`utils/http-interceptor/index.ts`), token `@storage_userToken`
  as `"Token …"`, `app-type: shoofi-shopping`, `app-name` per-call = target store `appName`,
  plus a **`device-id`** header for fraud detection.
- **Order creation** = **`POST order/create` as multipart/form-data** (`body` = JSON
  cart payload + `img` files), built by `stores/cart/index.ts` (`getCartData` →
  `produtsAdapter`) via `hooks/checkout/use-checkout-submit.ts` from
  `screens/checkout/index.tsx`. **Client computes the totals** (`total`, `orderPrice`,
  `shippingPrice`) and the server trusts them (matches the server doc's pricing note).
  Initial status is `"0"` (CC) or `"6"` (digital success), decided client-side.
- **Payment**: CC is charged **server-side inside `order/create`** (client passes
  `paymentData`; the client-side charge is deprecated). Apple/Google Pay use a ZCredit
  session + `order/save-apple-pay-session` → `update-apple-pay-order-session` →
  `verify-apple-pay-payment` (retried). HYP via `payments/hyp-tokenize-session` + `hyp-process-token`.
- **Twin (customer side)**: `stores/twin-order` + `stores/twin-cart` (second-store cart);
  combined checkout calls `twin-order/{eligible-stores, quote, place, pay,
  digital-place-pending, digital-finalize}`. Secondary side `shippingPrice:0` (combination fee covers it).
- **Tracking = POLLING every 30s** (`screens/order/active/index.tsx`) — **no websocket
  for customer order status** (WS is only used for store/menu refresh elsewhere). Detail:
  `screens/order/item`, timer `order-timer.tsx` keyed on status, ETA via `delivery/book/{bookId}`.
- **Key files**: `stores/cart/index.ts` (payload builder + `order/create`),
  `stores/orders/index.tsx`, `stores/twin-order/index.ts`,
  `hooks/checkout/use-checkout-submit.ts`, `screens/checkout/index.tsx`,
  `screens/order/{active,item,history}/*`, `consts/{api.js,shared.ts}`.
- **Gotchas**: `order/create` is **multipart** (twin / Apple-Pay / HYP calls are JSON);
  the client `ORDER_STATUS` enum **omits `"0"` and `"13"`** (used only as literals) — keep
  in mind when reasoning about pending-payment/fraud states on the customer side.

## C2. shoofi-shoofir — the DRIVER app (React Native, MobX)
Role: executes the **delivery leg**; drives the delivery-side status transitions.
- **API client**: axios in `utils/http-interceptor/index.ts` — token `@storage_userToken`
  as `Authorization: "Token …"`; headers `app-type: shoofi-shoofir`, `app-name`
  default `"delivery-company"` (per-call overridable). Base `consts/api.js`.
- **Lifecycle endpoints** (`stores/delivery-driver/index.ts`, payload `{orderId, driverId, bookId}`):
  `delivery/driver/order/approve` → `waiting-in-store` → `start` (pickup) →
  `complete` (delivered) → `cancel`. Plus `delivery/list`, `delivery/update`,
  `delivery/driver/location|availability|nearby-orders`.
- **Status scheme (important):** the driver UI works on the **bookDelivery
  `DELIVERY_STATUS`** numeric strings (`consts/shared.ts`: 1 waiting-approve, 2
  approved, 3 collected/pickup, 4 delivered, 5 waiting-in-store, -1 cancelled) —
  **NOT** the customer `ORDER_STATUS` 0-15. The **server endpoints bridge** driver
  actions to customer statuses (9/10/11/12). Don't conflate the two schemes.
- **Twin**: two bookDelivery docs sharing `twinGroupId` render as one `TwinOrderCard`;
  `twinAssignmentMode` single|split (split = each driver sees only their side).
- **Realtime**: `hooks/use-websocket.ts` (WS `?appType=shoofi-shoofir`), notifications
  trigger order refetch; `hooks/useDriverLocationTracking.ts` posts GPS (fg 10s / bg).
- **Key files**: `stores/delivery-driver/index.ts` (core state + all calls),
  `screens/delivery-driver/index.tsx`, `components/delivery-driver/OrderCard.tsx`,
  `consts/{api.js,shared.ts}`, `hooks/{use-websocket,use-notifications,useDriverLocationTracking}.ts`.
- **Gotchas**: two HTTP layers exist — `axiosInstance` (live) vs
  `services/deliveryDriverService.ts` (legacy raw `fetch`, `app-name: shoofi-app`,
  no auth); UI hardcodes numeric status strings instead of importing `DELIVERY_STATUS`;
  `DELIVERY_DRIVER_README.md` status section is stale. Verify `ADD_NOTE`/`DELETE_NOTE` server names.

## C3. shoofi-partner — the STORE-OWNER app (React Native, MobX)
Role: receives orders, **accepts**, prepares, prints, and drives status forward.
- **API client**: axios (`utils/http-interceptor/index.ts`), token `@storage_userToken`
  as `"Token …"`, `app-type: shoofi-partner`, `app-name` = `@storage_storeDB` (per-call overridable).
- **Endpoints** (`stores/orders/index.tsx`, controller `order/`): `admin/orders` (list),
  `admin/not-viewd` (incoming feed), **`update/viewd` = ACCEPT** (→ `6→1`, future `14→1`,
  sets `readyMinutes`), `update` (forward/back status + note), `update-item-collected`,
  `start-preparing` / `update-start-preparing`, `update-delay`, `printed`,
  `book-delivery`, `*-custom-delivery`, `addRefund`, `future-orders-ready`, `drive-in-arrival-confirm`.
- **Transition rule**: ACCEPT goes through **`order/update/viewd`** (NOT `order/update`);
  all other forward/back transitions use `order/update` with an explicit `status` the
  client computes (`1→3` delivery / `1→2` takeaway; `3→11`; `2→11|10`; `15→1`).
- **Status constants** match server 0-15 (`consts/shared.ts`).
- **Twin**: read-only from the order payload (`order.twinGroup`, `twinPeerInfo.orderDate`);
  the partner caps the **second store's** prep window (`TWIN_SECONDARY_EARLY_MAX_MIN=10`).
  No twin endpoint is called — twin timing is server-computed.
- **Realtime**: WS `?appType=shoofi-partner`; handles `order_status_updated`,
  `unviewed_orders_updated`, `future_order_*`, `print_*` (NOT `menu_refresh`). Printing =
  a `PRINT_NOT_PRINTED` event → batched invoice-image capture/print loop (`App.tsx`).
- **Key files**: `stores/orders/index.tsx` (core + transition logic),
  `screens/admin/order/new-orders/list/index.tsx` (ACCEPT + twin caps),
  `screens/admin/order/list/index.tsx` (dashboard, transitions), `hooks/{use-websocket,use-notifications}.ts`, `App.tsx`.
- **Gotcha**: no explicit REJECT endpoint — the accept screen is accept-only; rejection/cancel
  is a generic `order/update` to status `4`/`5` from the main list.

## C4. shoofi-delivery-web — the ADMIN dashboard (React web)
Role: oversight — list/monitor, manual intervention, fraud queue, **twin group admin**, config.
- **API client**: axios (`src/utils/http-interceptor/index.ts`), **Bearer** token
  `@storage_userToken`, `app-type: shoofi-admin`, `app-name` per-call (store `appName`);
  401 → auto-refresh via `admin/users/refresh-token`. Base ends in `/api/`, so calls omit the leading `/api`.
- **Endpoints**: `order/admin/all-orders` (list/counts/fraud/pending), `order/update`
  (manual status/cancel/fraud-reject, stamped `updatedBySource:"shoofi_support"`),
  `order/update/viewd` (approve), `admin/order/delete/{id}`, `admin/impersonation/order-token`
  (open-as store/driver/customer, **master-only**), `admin/order-monitoring/summary/{orderNumber}`
  (timeline), `twin-order/admin/{group/:id/full, degrade, undo-degrade, cancel, assign-driver}`,
  `admin/twin-order-config` (GET/POST), `delivery/admin/{cancel,assign,reassign,drivers,orders}`.
- **Refunds**: `order/addRefund` is **NOT** used here — admin refunds surface via twin
  `degrade`/`cancel` (`refundOwed`/`refundBreakdown`) and `shoofiAdmin/compensations/*`.
- **Twin admin**: full lifecycle control (degrade / undo / cancel / assign single|split)
  + the twin-order-config screen (`degradeAutoRefund`, timeouts, enable switch).
- **State**: not centralized — component-local `useState`; MobX only for store open/close.
- **Key files**: `src/apis/admin/order/*`, `src/views/admin/orders.tsx`,
  `src/components/Cards/{CardOrder,CardTwinOrder}.tsx`,
  `src/components/OrderMonitoring/OrderFlowDashboard.tsx`,
  `src/views/admin/settings/DeliverySettings.tsx`, `src/views/admin/fraud/FraudReview.tsx`.
- **⚠️ Cross-repo consistency flags (candidate bugs — human verdict):**
  1. **Status-enum divergence** — admin-web `src/consts/shared.ts` uses
     `FUTURE_ORDER_PENDING:"16"` and `PENDING_START_PREPARING:"14"`, but the server &
     partner use `14`=FUTURE_ORDER_PENDING / `15`=RAMADAN. A wrong constant here mislabels
     or mis-transitions future orders. **Verify before trusting admin-side future-order logic.**
  2. **`admin/order/delete/{id}`** is called with **plain axios (no auth interceptor)** —
     confirm this is intended.

## Cross-repo invariants (the whole-domain view)
- **Status source of truth = server** (store `orders.status`). Clients each keep their
  own `ORDER_STATUS` copy in `consts/shared.ts` — they must stay in sync with
  `shoofi-server/consts/consts.js`. The **admin-web copy has already drifted** (above).
  A change to statuses is a **multi-repo PR** touching every client's constants.
- **Driver app speaks `DELIVERY_STATUS`** (bookDelivery), everyone else speaks
  `ORDER_STATUS`; the server bridges them. Don't cross the wires.
- **ACCEPT is `order/update/viewd`** (partner + admin); generic transitions are `order/update`.
- Every client sends `app-name` (tenant) + its own `app-type`; the server branches on `app-type`.

## 11. Definition of done
Inherit `_shared-guardrails.md` §7 fully. For orders specifically:
- Prefer the `investigate-order` skill for read/diagnosis tasks.
- Any change near a transition: state which statuses can reach/leave the code path,
  and confirm you did not weaken a §2 guard.
- Never claim smoke passed without infra. Report what you verified, and every
  guardrail boundary where you stopped and proposed rather than edited.
