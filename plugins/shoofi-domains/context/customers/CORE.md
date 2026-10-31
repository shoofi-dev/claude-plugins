---
domain: customers
last-verified: shoofi-server@feat/marketing-active + shoofi-delivery-web@feat/marketing-active / 2026-10-30 (invariant 11 active list); shoofi-server@feat/coupon-detail-link + shoofi-app@feat/coupon-detail-link / 2026-10-30 (invariant 11 coupon page); shoofi-server@fix/customer-search-auth / 2026-10-30 (invariant 15 OTP code check, search and by-id gates); shoofi-server@fix/schools-auth / 2026-10-30 (invariant 14 school, teacher and admin-create gates); shoofi-server@feat/campaign-impact / 2026-10-29 (invariant 11 campaign impact); shoofi-server@feat/marketing-attribution + shoofi-app@feat/marketing-attribution / 2026-10-28 (invariant 11); shoofi-server@7185913e (feat/marketing-links) + shoofi-app@b31028da (feat/marketing-links) / 2026-10-28; shoofi-server@c1e495a8 (feat/push-cap-optout) / 2026-10-28; shoofi-server@30f1ce81 (feat/campaign-holdout) / 2026-10-28
scope: full-stack (shoofi-server + all four apps)
reference: ./reference.md   # endpoint tables, data model, referrals, per-repo client detail
---

# Customers / Identity / Auth — CORE (always read)

Accounts, phone+OTP login, tokens & sessions, profiles, addresses, referrals.

> **Identity guardrail area.** `routes/auth.js`, `routes/customer.js` and
> `utils/admin-auth-service.js` are CLAUDE.md do-not-touch: work via **draft PRs flagged
> HIGH-RISK**, minimal diffs. **Never print or log an OTP code, token, or secret.**
> A mistake here logs every user out — or lets the wrong person in.

## Scope
Server: `routes/{auth,customer,customer-referrals,customer-campaigns,customer-feedback,
shoofi-admin-users}.js`, `utils/{auth-service,admin-auth-service,app-name-helper}.js`,
`controllers/customerAddressController.js`. Clients: login/OTP/profile in all four apps.
Also yours: **who a push campaign may reach**: the customer's marketing-push opt-out
(`routes/customer-marketing-preferences.js`), the frequency cap
(`services/customer-campaigns/marketing-push-policy.js`), and the campaign send and schedule
path (`controllers/customerCampaignController.js`, `utils/crons/scheduled-campaigns-cron.js`).
See invariant 12 and reference §5b. Also the campaign **holdout** and the per-customer
**audience record** `shoofi.marketingPushAudience` (`services/customer-campaigns/{holdout,
push-audience}.js`, invariant 13). Measuring lift FROM that record is `orders`' (per-checkout
order facts); the record itself, and its exactness, is yours.
**Not yours:** order history content (`orders`), coins/rewards (growth), driver coverage
fields (`delivery`) — you own the identity record they hang off.
Also yours: the school-project enrollment (`services/customer/school-project-enrollment.js`)
and the Google-Form registration sync (`services/school-registrations/`) — reference §4.
**School registrations never auto-create schools or classes, never guess a class section, and
the sheet id (a public link to students' names and phones) never goes on a publicly readable
doc** (`store{id:1}` / `/api/admin/school-settings`).
Also yours: **who owns an AI-helper taste profile** (`shoofi.tasteProfiles`) and how it moves
across login, logout and deletion — the owner/merge helpers in
`services/ordering-intelligence/taste-profile.js`, `routes/ai-helper.js`, and the app hooks in
`screens/verify-code` + `stores/auth` (invariant 9, reference §5a). What a profile *does* to
suggestions is menu-catalog's (shoofi-server `docs/ai-helper.md`).

## The model — ONE auth, FOUR audiences, routed by `app-type`
Everyone logs in with **phone + 4-digit OTP** (admins use a password). **The `app-type` header
— not `app-name` — decides which DB+collection the identity lives in:**

| `app-type` | app | DB | collection |
|---|---|---|---|
| `shoofi-shopping` (or absent) | customer | `shoofi` | `customers` |
| `shoofi-partner` | partner | `shoofi` | **`storeUsers`** |
| `shoofi-shoofir` | driver | **`delivery-company`** | `customers` |
| `shoofi-admin` | admin web | `shoofi` | **`shoofiAdminUsers`** (password) |

⚠️ A missing/wrong `app-type` silently falls through to `shoofi.customers` — a common
"user not found" cause. **Identity routing is by `app-type` throughout this domain**; an
`app-name` on an identity call is usually inert (and sometimes misleading — see Known status).

## Invariants — never weaken
1. **Customers are CENTRAL.** `getCustomerAppName` (`utils/app-name-helper.js`) **always**
   returns the `shoofi` DB, ignoring `appName`. **Intentional — do NOT "fix" it** to use the
   store DB; that would fragment identity per store. Per-store DBs matter only for orders.
2. **Stored-token equality:** customer/partner/driver auth requires the request token to equal
   the token stored on the user doc (`routes/auth.js`), which is what makes **logout actually
   invalidate a session**. Keep it.

   **The scheme prefix is load-bearing on that branch, and only there.** Once the
   stored-token check passes, `getTokenFromHeaders` only *returns* the token when the
   `Authorization` header starts with the literal **`Token `**
   (`authorization.split(" ")[0] === "Token"`, `routes/auth.js`) — or when `req.body.token`
   is set, which a GET never has. A `Bearer ` header falls off the end of that `if / else if`
   and the function returns `undefined`, so `auth.required` answers a bare **401 with no
   error body** even though the JWT is valid, the user exists and the stored token matches.
   All three RN apps send `Token ` (`shoofi-app/utils/http-interceptor/index.ts` and its
   partner/driver twins); only `shoofi-delivery-web` sends `Bearer`. The
   `app-type: shoofi-admin` branch returns *before* that block, so `Bearer` works for admin
   routes and nowhere else — which is why an admin-token integration test copied as a
   template 401s the moment it is pointed at a customer route. **Do not "fix" this by
   accepting both from an unrelated ticket** — every real client already sends the right one.

   **So the stored `token` IS the credential, and it never leaves in a reply about someone
   else.** Whoever reads a user doc's `token` is that user until their next login (partner
   tokens live 1500 days). `authCode` is the pending OTP and `notificationToken` addresses the
   device. Only the login (`validateAuthCode`) and `switch-store` replies carry a token, and
   only to its owner. Every admin reply about other people goes through
   `services/customer/identity-response.js`, and that holds for admin callers too.
   **The partner-account routes are dashboard-only** (shoofi-server `fix/store-users-auth`,
   2026-10-30). `/api/customer/store-users/:appName[/:userId]` (GET, GET one, POST, PUT,
   DELETE), `POST new-customers` and `POST get-customers` carry `...identityListAdmin` =
   `[auth.required, checkAdminRole(DASHBOARD_ROLES)]`. Before that all seven were open: the
   GETs returned every store owner's live `token`, and the POST let anyone add their own phone
   to any store with `isAdmin: true, roles: ["all"]`. The admin web is the only caller, and
   the partner app has no staff screen, so a partner token gets 403 on its own store as well.
   Every dashboard role is accepted, because viewer-only staff create and delete store users
   in prod. A future partner self-management screen needs a per-audience rule (own `appName`
   from the token, no granting roles the caller lacks), never a role-only gate. Pinned by
   `test/integration/store-users-admin-auth.js`.
3. **Impersonation** (`imp:true`) bypasses that check by design — it is **`master`-role only and
   audited**. Never loosen the gate or drop the audit.
4. **The partner `switch-store` flow** re-mints a **per-store token** and sets
   `@storage_storeDB`; that's how later requests get scoped to the right store. Don't bypass it.
5. **`customers.orders[]` is a snapshot with NO status** — join the store `orders` collection;
   reuse `getSuccessfulOrdersByCustomerIds`. **Two "how many orders has this customer placed"
   definitions coexist and legitimately disagree.** Customer-facing surfaces — the app's own
   profile count (`GET /api/customer/details`) and the admin profile badge
   (`POST /api/customer/orders`) — count everything **except** status `"0"` and `4/5/7/8/9`, so
   **in-flight orders (1/6/13/14/15) count**. Every revenue/report path instead uses
   `COMPLETED_STATUSES = ["2","3","10","11","12"]` (`utils/customer-orders.js`). The same
   customer therefore shows a *higher* number on their profile than in the reports — that gap is
   intended, **do not "fix" it**. Bucket with `summarizeOrderStatuses`
   (`utils/customer-orders.js`), which returns the disjoint valid / failed-payment / cancelled
   split. Status `"0"` is the one to watch: an order document is inserted at `"0"` *before* its
   card is charged and is written straight back to `"0"` and **kept** when the charge fails, so
   a customer who retried a declined card leaves a permanent order document per attempt.

   **The two `created` fields on a customer doc are different TYPES, and mixing them
   matches nothing.** `customers.created` is a real BSON `Date` (`new Date()`,
   `routes/customer.js`), while `customers.orders[].created` — and the store
   `orders.created` it snapshots — is an **ISO string carrying Israel's local offset**,
   `"2026-08-05T14:23:11+03:00"` (`moment(new Date()).utcOffset(offsetHours).format()`,
   `routes/order.js`). A Mongo range predicate compares a Date to a Date and a string to a
   string; cross them and you get **zero rows and no error**. Build each bound to match the
   field: `new Date(x)` for `customers.created`, `momentTZ.tz(x, 'Asia/Jerusalem').format()`
   for anything inside `orders[]`. (`lib/churn-360/compute.js` carries the same warning
   in-line, and `utils/business-day.js` returns both representations under separate names for
   exactly this reason — neither is asserted here, so treat them as pointers, not proof.) **Never build a string bound with `.toISOString()`** — a `Z` string
   and a `+03:00` string share a `YYYY-MM-DDTHH:` prefix, so the range silently drops the
   evening hours instead of failing loudly.
6. **Never log OTPs, tokens, or secrets** — including in debug output added "temporarily".
7. **The authenticated user is `req.auth`, NEVER `req.user`.** `auth.required` is
   **express-jwt v8** (`package.json`) configured with `userProperty: "auth"`
   (`routes/auth.js`), so the verified payload lands on `req.auth` —
   `{ id, fullName, phoneNumber, roles, type }` for admins, minted by `generateAccessToken`
   (`utils/admin-auth-service.js`). **Nothing in the codebase ever assigns `req.user`** (v8
   dropped the v5 default), so every `req.user?.…` read is permanently `undefined` and silently
   falls through to its default: `routes/shoofi-admin.js` writes the literal `'admin'` for
   `createdBy`/`approvedBy`, `routes/customer.js` writes `'Admin'` for `createdByName`,
   `routes/store.js` and `routes/delivery/company.js` skip their `if (req.user)` history-
   attribution blocks entirely, and `routes/notifications.js` falls back to a **client-supplied
   `user-id` header**. Those sites are pre-existing and out of scope unless the task names them
   — but **do not copy them**. `req.auth.id` is the 24-char hex **string** (`jwt.sign`
   serialises the ObjectId), so compare with `String(...)` or cast via `getId`
   (`lib/common.js`). Any new `createdBy`-style provenance must be read from `req.auth` and
   never from the request body; `routes/team-tasks.js` is the reference implementation.
8. **`deletedAt` is the deletion marker, NOT `isDeleted`.** Account deletion is soft:
   `POST /api/customer/delete` writes `{isDeleted: true, deletedAt: new Date()}`
   (`routes/customer.js`) and nothing ever purges the document. But the **OTP-*request***
   handler rewrites the whole customer doc with
   `$set: {...customer, authCode, token: null, isDeleted: false, language}` — **before any
   code is verified** — so merely typing a phone into a login screen clears `isDeleted`
   while `deletedAt` is left in place (it is never unset). Consequences:
   - `isDeleted: false` does **not** mean "never asked to be deleted". Reading it alone
     reports a deleted customer who touched a login screen as a clean active account.
   - The deletion states are a **pair**, not a ternary: `(isBlocked, deletedAt, isDeleted)`
     gives active / blocked / deleted / blocked+deleted / **active-after-deletion** /
     blocked-after-deletion. A `isDeleted ? … : isBlocked ? … : 'active'` chain cannot
     express a combination — blocking and deletion are independent flags. Both admin
     surfaces derive from the pair: `deriveCustomerAccountStatus`
     (`shoofi-delivery-web src/utils/customer-account-status.ts`) and `triedToLoginAgain`
     (`services/customer-deletion/deletion-cases.js`).
   - Records predating `deletedAt` carry only the flag, so `isDeleted: true` must still be
     enough to read as deleted. Don't require `deletedAt` to reach that branch.
   - The login checks that would reject a deleted account are **commented out**
     (`routes/customer.js`) — deletion is a *request* a human works, not an enforced state.
   Anything that reports deletion must carry **both** fields end to end.
   (`GET /api/customer/:customerId` gained `deletedAt` in shoofi-server
   `fix/HIGH-RISK-churn-360-account-status`; add the matching assert once that merges.)
9. **An AI-helper taste profile (`shoofi.tasteProfiles`) has ONE owner — a customer OR a
   device — and only a customer-app token is a customer.** `ownerFromRequest`
   (`services/ordering-intelligence/taste-profile.js`) takes `req.auth.id` only when `app-type`
   is absent or `shoofi-shopping` — the same guard as `routes/for-you.js`, because
   `auth.optional` also resolves partner and driver tokens and their ids are not customers'.
   Anything else falls to the **`device-id` header**: the one the fraud checks, stories and
   app-logs already read, now also the identity key of a *visitor* profile. It is a
   client-generated string, so whoever sends it reads and writes that profile — **accepted
   risk**: a visitor profile holds food preferences only, and nothing account-derived is ever
   returned for a device owner. Never let a device id unlock anything account-shaped, and never
   take the device id, `owner` or `inferred` from a request body (`PUT` whitelists `stated`,
   `confirmed`, `onboardedAt`, `skippedAt`, `people`, `family` — `routes/ai-helper.js` copies
   exactly these into the update; a field missing there is silently never saved, and the
   reply's default then wipes the app's copy: found 2026-10-25 for `people`, pinned by a route
   test in `test/integration/ai-helper.js`). One profile per owner: unique partial indexes on
   `owner.customerId` and `owner.deviceId` — **partial on `$type: "string"`, so every owner query
   states `$type: "string"` too** (`ownerFilter`); plain equality cannot use a partial index and
   scanned the whole collection on every suggestion (IXSCAN pinned in `test/integration/ai-helper.js`).
   - **The routes are gated on the server** (`services/ordering-intelligence/access.js`): For you
     on for the caller (`isChatSuggestEnabled`, employees only until `isChatSuggestForAll`) and
     `isAiHelperEnabled` (employees only until `isAiHelperForAll`). Off: reads answer empty,
     `PUT /profile` and `POST /merge` answer 403 — no profile is created or merged. "Employee" is
     `!!customer.isShoofiEmployee`, exactly as `GET /api/customer/details` hands it to the app.
   - **Merge is an explicit client call after login, NOT part of OTP verification.**
     `POST /api/ai-helper/merge` is `auth.required` (customer token only) and reads the device id
     from the header; `validateAuthCode` knows nothing about it — keep it that way. The account's
     non-empty `stated` wins field by field, `confirmed` is unioned, the earliest `onboardedAt`
     is kept, the account's `people` (the family members it orders for) win when it has any,
     else the device's, and its `family` answer when answered, else the device's — and the
     **device profile is DELETED**, so the next person to log in on a shared
     phone does not inherit it. Idempotent: no device profile → no-op.
   - The customer app drops its cached copy — and the For-you conversation, minimized bubble and
     home picks (`forYouStore.resetForAccountChange()`) — on `logOut`, `deleteAccount` and a
     forced sign-out (`resetAppState`). `POST /api/customer/delete` (customer-app branch only)
     deletes the account's profile and its For-you served-audit rows AFTER the reply
     (`deleteCustomerProfile`, `deleteCustomerServed`); a failure there is logged and never fails
     the delete. The customer document itself stays soft-deleted (invariant 8), so a customer who
     logs in again starts with no taste profile. The For-you quality collections need nothing
     there: the event copy (`forYouEvents`) carries no customer id, the reviews (`forYouReviews`)
     only a one-way hash, and golden cases none (menu-catalog CORE invariant 22).
10. **Push campaigns are owner-tier admin only.** Every `routes/customer-campaigns.js` route
   carries `...adminOnly` = `[auth.required, checkAdminRole(CAMPAIGN_ROLES)]`, with
   `CAMPAIGN_ROLES = ["master", "admin", "manager"]` (2026-10-28). Before that they were
   `auth.required` only, and a plain customer token passes `auth.required` (invariant 7's
   shared secret): it could search customers, preview audiences and push to all of them. The
   only caller is the admin's קמפייני פוש screen. `master` is named because `checkAdminRole` has
   no hierarchy. The frequency-cap config (`GET/PUT /push-cap-config`) and
   `POST /:id/unschedule` sit behind the same `...adminOnly` (2026-10-28). They are declared
   **before** `/:id`, which would otherwise read `push-cap-config` as a campaign id. Pinned by `test/integration/marketing-routes-auth.js`, which also covers the
   other marketing write paths (ads, stories, notes, `notifications/send*`, coupon campaigns,
   admin coupons) — those files have no domain owner yet.
11. **Every marketing surface opens ONE `link` shape, and it points at something real.** The
   home banner (ads), stories and launch popups, the home note banner and push campaigns carry
   `link` = `none | store{appName} | product{appName,productId} | deal{appName,promotionId} |
   coupon{couponId, appName?} | page{page ∈ LINK_PAGES}` (`utils/marketing-link.js`, 2026-10-28).
   - Writes go through `linkFromRequest` → `resolveLink`, which 400s a coupon / deal / product /
     store that doesn't exist. Marketing promotes existing offers only (Sari, 2026-10-28); never
     add a "create the coupon from here" path. A coupon scoped to exactly one store gets that
     `appName` filled in. Builds before feat/coupon-detail-link open that store with it (any other
     coupon: "my coupons", which lists only personal coupons, so a public multi-store coupon was a
     dead end).
   - **Every `coupon` link opens the coupon page** (shoofi-app `coupon-detail`,
     `screens/coupon-detail`, 2026-10-30), single-store coupons included. The page reads
     `GET /api/coupons/:id/public` (payments CORE, "What a marketing coupon link shows") and says
     what the coupon gives, its dates, the code with a copy button or "applied automatically at
     checkout", and where it works: "all stores", or the eligible stores, each opening through
     `openStoreAtProduct`. It never touches the cart and never claims or applies the coupon. The
     tap event is unchanged: every caller still calls `trackMarketingTap` / `trackPushOpen` before
     `openMarketingLink`, and only the router's `coupon` case changed. A phone sees this after
     `eas update`.
   - Older app builds never read `link`: writers keep an ad's `appName`/`pageName`
     (`legacyAdFields`) and a story's `target` (`targetForLink`) in step, and reads fill `link` in
     for items saved before it (`withLink`). An admin form that sends no `link` must not flatten a
     saved one (`unchangedOrLegacyLink`). An announcement (`storeAppName: "shoofi-stories"`) has
     no menu, so its legacy default is `none`, never `store`.
   - A push campaign's `link` rides in the push `data` next to `campaignId`; the customer app's
     push-tap router (`hooks/use-notifications.ts` → `utils/marketing-link.ts`) opens it, store
     opens via `openStoreAtProduct` (twin-order guard).
   - Views / taps / push opens go to `POST /api/marketing/events` (`routes/marketing-events.js`):
     `auth.optional`, the customer comes from the token (never the body, and never an admin
     token), guests by `device-id`; `sanitizeEvent` drops junk, future (>5 min) and >7-day-old
     events; batches cap at 50; it always answers 200. `marketingEvents` has a 180-day TTL and its
     indexes are requested in the background, never awaited on the write. Results:
     `GET /api/admin/marketing/results` (every dashboard role).
   - **The handle must be registered.** `db.marketingEvents = db.collection('marketingEvents')`
     in `DatabaseInitializationService`. The route catches everything and answers
     `accepted: 0`, so a missing registration drops EVERY event silently. It shipped that way
     in #333; the tests' Proxy handle hid it.
   - **Events → facts → rollups** (shoofi-server `docs/marketing-attribution.md`).
     - Which orders a tap led to is the SERVER's join. After each checkout,
       `services/marketing/order-facts.js` reads this customer's AND this device's
       `tap`/`push_open` events from the 7 days before it into one fact per checkout
       (orders CORE invariant 16). `order.marketingTouch` is only the fallback for an event
       that never arrived.
     - The device key is `deviceViewerKey(header)` (`services/marketing/viewer-key.js`). The
       events route writes `viewerKey` with it and the facts look guests up with it, both
       truncated to 64 characters: the app's `@storage_deviceId` runs longer than that. It is
       the `device-id` HEADER, never `orders.deviceId`. So a guest's taps
       (`viewerKey: "device:<id>"`) are credited after they log in.
     - **Impersonation.** An event posted with an `imp: true` token (master-minted "open as
       customer") is still stored, with `impersonated: true` and the customer's `viewerKey`.
       The touch lookup never uses it (`impersonated: { $ne: true }`) and the daily funnel
       skips it. A checkout placed under such a token is recorded with `isImpersonated` +
       `excludeFromReports`. `GET /api/admin/marketing/results` still counts impersonated
       events, so it doesn't match the rollup there.
     - A touch counts for an order only if it happened before the order (orders CORE
       invariant 16, the touch-precedence rule).
     - `shoofi.marketingDailyStats` (per Israel date × placement × itemId, kept forever)
       holds funnel + orders under last/first/any. Reports:
       `GET /api/admin/marketing/{performance, order-facts, daily}` (the same roles as
       results; a fact never holds a phone or a name).
     - **`/performance` lists push campaigns even with no events.** With `placement=push` or
       no placement, it includes every customer-app push campaign (`customer-campaigns`,
       `appType` absent or `shoofi-app`, `channels.push` not false) whose
       `execution.startedAt` is in `[from, to]`, plus every requested itemId that is one.
       Each gets funnel zeros, attributed orders and the holdout lift (`pushCampaignsFor`,
       `services/marketing/performance.js`). A push nobody opened still has a lift, and for
       a push the lift is THE number. Partner/driver campaigns are not customer pushes.
     - Push items carry `funnel.pushSent` (`execution.totalUsers`, the treated group once a
       holdout runs, else the treated audience count), `funnel.openRate`
       (= `pushOpens / pushSent`) and a `campaign` block. Every item carries a
       server-resolved `name`: ad / note `titleHE` (else `titleAR`), story/popup
       "<store> · <caption>" ("שופי" for an announcement), or the campaign name.
     - `funnel.tapperDays` (and the rollup's `tappers`) = distinct people per day who tapped
       OR opened. A push item only ever has `push_open` (the route enforces
       `push_open ⇔ push`), so for a push it means openers. This matches `tappers` in
       `/results`. `viewerDays` is a sum of daily distinct viewers, not distinct people.
     - **Every push gets a before/after impact, once** (`services/marketing/campaign-impact.js`,
       `shoofi.marketingCampaignImpact`, `_id` = campaignId). The marketing cron (hourly at
       :20) computes it when the 24h window has closed plus 2h, up to 4 per run, newest first,
       back 180 days. It counts the recipients' placed/completed checkouts (twin = one, any
       store) in the 24h after `execution.startedAt`, against the same 24h one to four weeks
       earlier. `noiseBand = max(2·sd, 2·√mean)`. `verdict` is up/down only past it, and
       `too_small` under 200 recipients or a usual of < 5 orders.
       - Recipients are the audience's `treated` rows, else `shoofi.notifications` by
         `data.campaignId`. That collection has no index on `data.campaignId` in prod (5.3M rows), so the query
         MUST be bounded by an `_id` time range around the run.
       - It cannot tell the push from the day or an overlapping push (`overlaps` names them).
         With a holdout, the holdout lift is the causal number.
       - A run with any unreadable store DB writes nothing and retries.
       - Served as `impact` on `/performance` push items and by
         `GET /api/admin/marketing/campaign-impact` (same roles; the admin's
         "השפעת קמפייני פוש" card). Not on `/api/analytics/growth/*`, which
         carries a narrower master/admin gate (reference C4).
   - **The app's queue survives a kill and is flushed before every order.**
     - `shoofi-app/services/marketing-events.ts` mirrors the queue to AsyncStorage
       (`@marketing_event_queue`, ≤200 events, 7-day age-out, taps first, one retry).
     - All three submits (`stores/cart` `submitOrder`, `stores/twin-order` place,
       `screens/checkout` digital-place-pending) call `prepareMarketingForOrder()`. It gives
       the queue ≤1.5s, never throws, then returns the touch for the body.
     - Never send anything beyond `marketingTouch` on `/api/order/create`: the route spreads
       `...parsedBodey` onto the order, so an extra field lands unsanitized.
   - **The active list is read-only and keeps each channel's OWN rule** (2026-10-30).
     `GET /api/admin/marketing/active` (`services/marketing/active.js`, in
     `routes/marketing-performance.js`) lists every banner, story, launch popup, note,
     customer-app push, coupon campaign (`couponCampaigns`), social publication and automatic
     card badge (deal, "new") that is live, scheduled or ended in the last 7 days, as
     `{channel, id, title{he,ar}, name, subject{kind,id,appName?,label,key}|null, status:
     live|scheduled|ended_recently, startsAt, endsAt, targeting{everyone,areas,store,segment,
     summary}, createdBy, createdAt, updatedAt, editPath, automatic, results{views,taps,orders}|null,
     warnings[]}`, plus `collisions` (pushes within 24h to overlapping `cityAreaId`s; >1 live
     banner per subject), `warningLabels`, `platform` and `sourceErrors`. Shape and rules:
     shoofi-server `docs/marketing-attribution.md` "The active list".
     - **Gate: `ACTIVE_ROLES` = master/admin/manager** (`auth.required` + `checkAdminRole` on the
       route), narrower than `RESULTS_ROLES`: it names creators and links to edit forms only the
       owner tier opens. The admin's מרכז שיווק (`/admin/marketing`) has the same sidebar roles.
     - **It writes nothing** (no collection, no index build) and never reads
       `shoofi.notifications`; push campaigns never project `execution.results`. Results come from
       `performance.getPerformance` in batches of ≤200 item ids (a story sums its story + popup
       placements; a push's views are `pushSent`).
     - **Status = what the customer app experiences; a disagreement is a `warnings` code, never a
       different status.** Banners use `/ads/valid`'s STRING compare (prod stores `YYYY-MM-DD`, so
       a banner disappears at 00:00 UTC of its end date: `banner_end_day_excluded`); stories need
       `business_visible: true` on the store (`story_store_hidden`) and a 50-year expiry reads as
       none (`story_never_expires`); notes are live on `isActive` alone because `/notes/valid`
       ignores their dates, and only the newest is shown; a push `in_progress` over an hour is
       `push_stuck_in_progress`. Badges are computed, never written (menu-catalog invariant 18):
       the card shows the newest running deal and a public coupon beats it. Never "fix" a status
       here to match the stored dates; fix the channel, then this follows.
   Pinned by `test/integration/marketing-links.js`, `test/integration/marketing-attribution.js` and
   `test/integration/marketing-active.js` (server), `__tests__/services/marketing-events-queue.test.ts` (app).

12. **Marketing pushes: opt-out and frequency cap apply inside `executeCampaign` ONLY, to
    customer-app audiences ONLY.** Every other push (order status, `feedback_request`,
    delivery, partner and driver alerts) calls `notificationService.sendNotification`
    directly. That function knows neither rule, so a customer who turned offers off still hears
    about their order. Keep it that way: never move either rule into `sendNotification`.
    - **Opt-out** = `shoofi.customers.marketingPushOptOut: true`. Unset means opted in, which is
      every customer before 2026-10-28. The customer sets it through
      `GET/PUT /api/customer/marketing-preferences` (`auth.required`, customer app-type only).
      The route writes **`req.auth.id`'s own doc, never an id from a header, body or URL**.
      `routes/notifications.js` reads a client `user-id` header, which is a known IDOR and must
      not be copied (invariant 7). The router is mounted above `routes/customer.js`, whose
      catch-all `GET /api/customer/:customerId` would otherwise answer it.
    - **Cap** = `shoofi.store {id:1}.marketingPushCap {enabled, maxPushes, windowDays}`. It means
      "at most N campaign pushes per customer per D days". **Off until an admin turns it on**
      (`DEFAULTS.enabled: false`), and edited from the קמפייני פוש screen. It counts the
      customer's existing `shoofi.notifications` records **that carry `data.campaignId`** since
      the cutoff. `sendNotification` writes one record per recipient and only a campaign send
      sets `data.campaignId`, so transactional records never count. There is no separate send log.
    - Both are filtered **before** the per-user send loop (`userIds = policy.userIds`), and the
      result records `execution.skippedOptOut` / `skippedCapped` / `pushCap`.
    - **A campaign is claimed atomically**: `claimCampaign` is one `findOneAndUpdate` to
      `in_progress`. It used to read the status and then write. The cron claims only a due
      `scheduled` campaign. A lost claim throws `code: 'CAMPAIGN_NOT_CLAIMABLE'`, and the cron
      skips it without marking it failed, because that would overwrite a run that is sending.
      The admin's `PUT /:id` refuses an `in_progress` campaign (409) for the same reason.
    - **`scheduling.scheduledDate` is a Date.** A wall-clock string without an offset is read in
      the campaign's timezone (`Asia/Jerusalem`). The cron queries `$lte: <Date>`, and a stored
      string never matches it. That is why no scheduled campaign ever sent before 2026-10-28,
      along with the cron never being started.

13. **A held-out customer gets NOTHING from that campaign, and the audience record says exactly
    who got what.** `campaign.holdout = { pct }`, 0–50, **default 0 = off** (a campaign saved
    before 2026-10-28 has no `holdout` and reads as 0). Customer-app audiences only.
    - **Order:** opt-out, then cap (invariant 12), THEN holdout. `assignHoldout`
      (`services/customer-campaigns/holdout.js`) draws only from `policy.userIds` (who would
      really have been sent) and the send loop gets `holdout.treatedIds`. A held-out customer
      gets no `sendNotification` call at all: no push, no websocket, no `shoofi.notifications`
      record, so **no cap count**. Never move the holdout ahead of the opt-out or the cap, and
      never move it into `sendNotification`.
    - **Deterministic:** `holdoutBucket` = sha256(`campaignId:customerId`), first 8 hex, mod
      10000; held out when `< pct × 100`. No randomness, no stored state: a retried execution
      puts everyone in the same group, and another campaign draws a different slice.
    - **Too small to measure:** fewer than `MIN_AUDIENCE` (200) eligible customers (after
      opt-out and cap) → no holdout, `execution.holdoutSkippedReason: "audience_below_minimum"`.
      A partner/driver campaign with a pct records `"not_customer_audience"` and writes no rows.
    - **The record is a contract the orders domain's lift reporting reads. Keep it exact:**
      `shoofi.marketingPushAudience` (that exact Mongo name, via `shoofiDb.collection(...)`),
      one row per (campaign, customer):
      `{ campaignId: string, customerId: string, group: "treated"|"holdout"|"capped"|"opted_out", at: Date }`.
      It is an **assignment** record (intention to treat): `treated` = sent to, even if that
      push then failed for a missing device token; `at` = the run's assignment instant, the same
      for every row of the run (not each push's send time). Indexes: unique
      `{campaignId, customerId}`, `{campaignId, group}`, `{customerId, at: -1}`, TTL 400 days on
      `{at}` (`RETENTION_DAYS`).
    - **Never in the send's way:** `recordAudience` runs alongside the send loop, in unordered
      1000-row `bulkWrite` chunks, and **never throws**. A failure is logged and counted
      (`execution.audienceRecordErrors` / `audienceRecorded` / `audienceRecordError`); the send
      goes on, once. The indexes are built once per db in the background and **never awaited by
      a write** (`ensureIndexesOnce`; shoofi-server#306: a write gated on a failing build on a
      NEW collection was lost).
    - **A retried execution never doubles a row:** rows are **upserts** on (campaignId,
      customerId), which is correct even before the unique index finishes building on first
      deploy. Non-treated groups are `$setOnInsert` (the first run stands); **`treated` wins**
      (a pipeline update; an existing treated row keeps its first `at`), so no `holdout` row ever
      belongs to a customer the campaign pushed, even if the pct was edited between runs. Don't
      "simplify" this to insertMany-and-ignore-duplicates.
    - **On `execution`:** `holdoutCount`, `holdoutPct` (what was APPLIED, 0 when skipped; the
      stored `holdout.pct` can be edited afterwards, so analysis reads this one),
      `holdoutSkippedReason`. `totalUsers` = the treated count (who was sent to).
    - Edited with the campaign (`POST /`, `PUT /:id`, the same `...adminOnly` roles; 400 outside
      0–50, never clamped), from the admin form's "קבוצת ביקורת %" field (`HoldoutField.tsx`).

14. **The school-project routes, the teacher routes and `admin-create` are gated on each route**
    (2026-10-30, `services/customer/admin-access.js`). Before that none had auth: anyone could
    create a customer by phone, upload a class list that creates customers, delete every student
    of a school, or create teachers.
    - **`SCHOOL_ADMIN`** = `auth.required` + `SCHOOL_SECTION_ROLES` (master/admin/manager/viewer,
      the admin web's schools sidebar) on `/api/admin/schools*`, `POST /api/admin/school-settings`
      and the `/api/customer/` school and student routes (reference §4). Only the admin web calls
      them. The list copies `routes/admin/school-registrations.js`, which can't be required there
      because it opens Redis. A test fails if the two lists drift.
    - **`ADMIN_CREATE`** on `POST /api/customer/admin-create` takes a dashboard role, OR a mobile
      token whose own record (looked up by `app-type`, as in `routes/auth.js`) has `isAdmin`. The
      three RN login screens call it in place of `customer/create` when `userDetailsStore.isAdmin()`
      is true. Their tokens carry no roles, so **never make this gate role-only.** In prod, 1
      customer, every storeUser (394) and 0 drivers carry `isAdmin`. The handler stores only
      `{phone, created}`. Never let it copy more of the body: the body must not be able to give
      an account a role or a flag.
      It also refuses a non-string `phone` (400) and looks the existing customer up by the
      sanitized value: an object such as `{"$ne": null}` used to answer with an arbitrary
      customer's phone, name and id, and every partner token passes this gate.
    - `DASHBOARD_ADMIN` on `/api/admin/teacher/*` (no caller, no `teachers` data in prod).
    - **Open on purpose:** `GET /api/admin/school-settings` (the customer cart; the values are
      already public on `GET /api/store/get/shoofi`) and `GET /api/admin/check-order-time-valid`.
      **Still unscoped:** `POST /api/customer/get-students-by-ids`.
    Pinned by shoofi-server `test/integration/school-admin-auth.js`.
15. **The OTP login needs a real code, and the pending code is shown to staff only**
    (shoofi-server `fix/customer-search-auth`, 2026-10-30).
    - **`validateAuthCode` compares only when BOTH the stored and the sent code are present**
      (`isCode`: not null, undefined or ""). A successful login stores `authCode: null`
      (the v3 driver writes `undefined` as null), and `null == undefined` is true. Until this
      fix, a request carrying only a phone logged into any customer, partner or driver account
      and overwrote the owner's session. Never compare a possibly-empty code with bare `==`.
      This is not the planned hardening (expiry, attempts, lockout). That is still open.
    - **`POST /create` never echoes the code it just sent.** It used to, for a new phone, so
      anyone could register a number they don't own.
    - **`search-customer` is dashboard-only**, and `status.authCode` (the pending OTP, shown to
      support on purpose) is included only for a dashboard role (`mayReadPendingCode`). Never
      `token`. OTPs never expire, so a readable code is a login. The RN apps' legacy screens
      are refused: they have mapped an object as an array since 2025-06 and never worked. Fix
      that screen and give it a code-free answer before opening the route to a mobile token.
    - **`GET /:customerId`, `/status`, `/whatsapp-summary` and
      `POST /:customerId/update-address-to-current-location` are dashboard-only.** Their only
      caller is the admin web, so a customer token is refused even for its own id.
    - Flagged for a human: the Known-status `search-customer` line and its place in the
      "to handle later" list describe the state before this change.
    Pinned by shoofi-server `test/integration/customer-search-admin-auth.js` and
    `test/integration/otp-verify-requires-code.js`.

## Known status (human-confirmed — do NOT act without an explicit task)
All of these are **known and accepted for now**. They are scheduled work, not discoveries:
- **KNOWN — planned rotation:** the JWT secret is a hardcoded literal shared by customer, admin
  and impersonation tokens. **Changing it logs out every user on every app**, so it needs a
  planned migration. An SMS credential is likewise baked into `utils/sms.js`. Leave both alone.
- **KNOWN — hardening planned:** the OTP is a plaintext 4-digit code with no expiry, no attempt
  counter and no lockout; a rate limiter exists but is not wired up. **Planned direction (design
  toward it, don't implement unasked):** (a) a **max-retry limit on requesting a code**, and
  (b) letting the user **choose WhatsApp vs SMS** for delivery.
- **KNOWN:** `search-customer` projects `token` + `authCode` and has no auth.
  Verified still true on 2026-10-30. The reply carries the pending OTP itself as
  `status.authCode`, and `isLoggedIn` is derived from the token. The token itself is not in
  the reply. All three RN apps and the admin web call it.
- **KNOWN — to handle later:** several identity-adjacent endpoints (address CRUD,
  `search-customer`, storeUsers CRUD, `cash-restrict`) take IDs from the URL/body with no auth.
  **Never widen this surface further.**
  Flagged for a human (2026-10-30): storeUsers CRUD is gated as of shoofi-server
  `fix/store-users-auth` (invariant 2), and `cash-restrict` already carries
  `auth.required` + `checkAdminRole` on main. This list may want trimming.
- **NOT a bug (verified):** the driver app sends `app-name: 'shoofi'` on push-token
  registration, but the server routes on **`app-type`**, so the token lands correctly on
  `delivery-company.customers`. (Leftovers: an unused `db` variable in that handler, and a
  misleading header that *would* become a bug if the handler ever routed on `app-name`.)

## Recipe — touching an auth or identity path
1. State **which of the four app-types** your change affects — they all share these endpoints.
   A taste-profile change also names whether it touches the visitor (`device-id`) owner
   (invariant 9).
2. Confirm you haven't weakened stored-token equality, the impersonation master-gate, or
   `getCustomerAppName`'s central-DB behavior.
3. Anything touching the JWT secret or token lifetime is a **planned migration with a
   logout blast-radius**, not a code fix — stop and ask.
4. Re-read the output you're adding: no OTP/token/secret may appear in logs or responses.

## Definition of done
Inherit `_shared-guardrails.md` §7, plus the four recipe points above.
