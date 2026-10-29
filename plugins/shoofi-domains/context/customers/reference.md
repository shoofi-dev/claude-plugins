# Customers / Identity / Auth — Domain Context

> **Who you are:** the agent that owns **identity** — customer/partner/driver/admin
> accounts, phone+OTP login, tokens & sessions, profiles, addresses, and referrals.
> You inherit `_shared-guardrails.md`. **This is an identity guardrail area**
> (`routes/auth.js`, `routes/customer.js`, `utils/admin-auth-service.js` are CLAUDE.md
> do-not-touch): work here via **draft PRs flagged HIGH-RISK**, keep diffs minimal, and
> **never print or log an OTP code, token, or secret.** A mistake here logs every user
> out — or lets the wrong person in.

## 0. Scope
Server: `routes/{auth,customer,user,customer-referrals,customer-campaigns,customer-feedback,
shoofi-admin-users}.js`, `utils/{auth-service,admin-auth-service,app-name-helper}.js`,
`controllers/customerAddressController.js`. Clients: login/OTP/profile in all 4 apps (§C).
Also the **identity slice of the AI-helper taste profile** (§5a): owner resolution and merge in
`services/ordering-intelligence/taste-profile.js` (`ownerFromRequest`, `deviceIdFromRequest`,
`mergeDeviceIntoCustomer`) and `routes/ai-helper.js`. The rest of `ordering-intelligence/` —
facts, avoid filtering, how a profile ranks suggestions — is menu-catalog's.
Also **who a push campaign reaches** (§5b): `controllers/customerCampaignController.js`,
`services/customer-campaigns/marketing-push-policy.js`, `routes/customer-marketing-preferences.js`,
`utils/crons/scheduled-campaigns-cron.js`.
**Not yours:** order history *content* (orders), coins/growth rewards (growth), driver
coverage fields (delivery) — you own the identity record they hang off.

## 1. The identity model — ONE auth, FOUR audiences
Everyone logs in with **phone + 4-digit OTP** (except admins, who use a password). The
`app-type` header decides which DB+collection the identity lives in:

| `app-type` | app | DB | collection |
|---|---|---|---|
| `shoofi-shopping` (or absent) | customer app | `shoofi` | `customers` |
| `shoofi-partner` | partner app | `shoofi` | **`storeUsers`** |
| `shoofi-shoofir` | driver app | **`delivery-company`** | `customers` |
| `shoofi-admin` | admin web | `shoofi` | **`shoofiAdminUsers`** (password) |

⚠️ **A missing/wrong `app-type` silently routes to `shoofi.customers`** — a common source of
"user not found" bugs. Every customer endpoint branches on it (`customer.js` create/validate/
details/update-notification-token/delete, `auth.js`).

**Customers are CENTRAL:** `utils/app-name-helper.js getCustomerAppName` **always** returns
`req.app.db['shoofi']`, ignoring `appName`. This is **intentional — do NOT "fix" it** to use
the store DB; that would fragment a customer's identity per store. Per-store DBs matter only
for **orders** (joined via `order.appName`).

## 2. Customer auth flow (phone + OTP)
1. **Request** — `POST /api/customer/create` (`customer.js`): generates a 4-digit
   `authCode`, upserts the identity, sends SMS + WhatsApp (`user_verification` template).
   Test phones (`config/test-phones.js`) skip SMS and accept a fixed code.
2. **Verify** — `POST /api/customer/validateAuthCode` (`customer.js`): compares `authCode`,
   clears it on success, mints a JWT via `authService.toAuthJSON`.
3. **Token** — `utils/auth-service.js generateJWT`: HS256 `jwt.sign({phone, id, exp})`,
   expiry ≈ **4 years**; the token is **persisted onto the user doc** (`token` field).
4. **Verification** — `routes/auth.js getTokenFromHeaders`: scheme `Authorization: Token <jwt>`;
   verifies signature, loads the user by app-type, and **enforces stored-token equality**
   (`customer.token !== token` → reject, `auth.js`). So `logout` (which nulls `token`)
   genuinely invalidates a session. Impersonation tokens (`imp:true`) bypass this check.
5. `auth.required` / `auth.optional` = `expressjwt`, `userProperty:"auth"` → handlers read `req.auth.id`.

Nothing else rides on verification. The AI-helper taste-profile merge is a **separate client
call after `updateUserToken`** (§5a) — `validateAuthCode` does not know it exists.

## 3. Admin auth (separate system)
`utils/admin-auth-service.js` + `routes/shoofi-admin-users.js`: `shoofiAdminUsers` with
**bcrypt password** (cost 10), `roles[]` (`master|admin|manager|operator|viewer|editor`),
access token **180m**, refresh **365d**, temp-reset **10m**. Endpoints: `login`,
`change-password`, `forgot-password` (6-digit code, 15-min expiry), `verify-reset-code`,
`reset-password`, `refresh-token`, `logout`. `checkAdminRole(roles)` reads `req.auth.roles`.
Unlike customers, admin verification **skips stored-token equality** (signature + user exists).

**Impersonation** — `POST /api/admin/impersonation/order-token` : **`master`-only**,
audited, mints a 15-min `imp:true` JWT to open the partner/driver/customer app as that user.
It does **not** overwrite the subject's stored token. **Keep the master gate + audit intact.**

## 4. Data model
- **`shoofi.customers`** — identity (`fullName`, `phone`, `email`, `language`), auth
  (`authCode`, `token`, `notificationToken`), `addresses[]`
  (`{name,street,city,cityId,location{Point},isDefault,…}`), **`orders[]` snapshot**,
  referral (`referralCode`, `referral{clickId,inviterCustomerId,…}`), flags
  (`isBlocked`, `isDeleted`+`deletedAt`, `cashRestricted`), location (`cityId`, `cityAreaId`),
  `schoolProject{…}`, marketing (`marketingPushOptOut` + `marketingPushOptOutUpdatedAt`; unset
  = opted in, §5b). **No `tokenExpiry` field** — expiry lives only inside the JWT.
- **`schoolProject{schoolId, classId, isActive, studentIds[]}`** (school-project / "مدارس"
  customers; all ids are strings). `isActive` alone puts the customer app into school mode
  (schools category, pickup-only cart, student card at checkout); the card / student picker
  (2+ students) is filled only from `studentIds` → `POST /api/customer/get-students-by-ids`,
  which joins `shoofi.students` (`isActive: true` only) → `schools` / `school-classes`
  (accessor `db.schoolClasses`) **per student**.
  - **`studentIds` is the sole source of enrollment.** Siblings in different classes or
    schools accumulate there: `create-school-project-batch` sends every existing customer
    through `enrollStudentOnCustomer` (`$addToSet` + `$set isActive: true`) whatever school /
    class they are in now; `add-student` also `$addToSet`s. Batch `action`: `added` (no
    `schoolProject` before) / `updated` / `unchanged`. Until shoofi-server#270 the batch
    *replaced* `schoolProject` when the uploaded class differed, unlinking the earlier sibling
    (10 prod customers; repair: `scripts/link-missing-sibling-students.js`, dry-run default).
  - **Customer-level `schoolId` / `classId` are vestigial**: set once (filled only when
    missing, never overwritten) and read by no app; the only server reads are dead maps in the
    `routes/order.js` school-orders report. Do not build on them.
  - **Invariant: `isActive` is false whenever no student is linked; re-adding a student
    re-activates.** The admin deletes (`delete-school-project-customer`,
    `delete-all-school-project-students`) pull the id and then call
    `deactivateCustomersWithoutStudentsSafely` (`services/customer/school-project-enrollment.js`;
    filter `studentIds.0 $exists:false`, so a concurrent re-add wins). **Being on an uploaded
    class list means active:** a re-upload deliberately overrides a manual toggle-off (decided
    2026-10-03), even when the id is already linked. Before this invariant, deletes left
    `isActive: true` with `studentIds: []` — an empty checkout student card;
    `scripts/deactivate-school-customers-without-students.js` (dry-run default) sweeps those.
  - **`toggle-school-project-active` is account-wide** (`toggleSchoolProjectActive`): the admin
    student list sends the *student* `_id` as `customerId`, so it resolves by customer `_id`
    first, then by `schoolProject.studentIds`; no school/class equality check. Toggling one
    child's row turns school mode off/on for the whole customer (every linked sibling).
  - **One enrollment path: `enrollStudentByPhone`** (`services/customer/school-project-enrollment.js`)
    — student by phone + school + class (found → reused; the batch upload refreshes its name
    and `isActive`, the registration sync does not), customer by phone (found →
    `enrollStudentOnCustomer`, else created with `schoolProject`). Both
    `create-school-project-batch` and the Google-Form sync call it.
- **School registrations (Google Form → students)** — `services/school-registrations/`
  (`normalize.js`, `sheet.js`, `registrations.js`), cron
  `utils/crons/school-registrations-sync-cron.js` (every 15 min, Asia/Jerusalem, Redis lock
  `cron:school-registrations-sync` shared with the admin's write buttons), admin API
  `routes/admin/school-registrations.js` (`/api/admin/school-registrations…`, `auth.required` +
  `checkAdminRole`, audited with `fullName`/`phone` omitted), admin screen "רישומי תלמידים"
  (delivery-web `src/views/admin/schools/SchoolRegistrations.tsx`).
  - **Source: the sheet's PUBLIC CSV export** (`/gviz/tq?tqx=out:csv&sheet=…`), no Google
    credentials — the product owner's choice. ⚠️ **Anyone with the link can read every
    student's name and phone.** The sheet id is therefore kept off the publicly readable
    `shoofi.store{id:1}` (returned whole by unauthenticated `GET /api/store/get/shoofi`) and
    off `/api/admin/school-settings` (no auth): it lives in
    **`shoofi.school-registration-settings{_id:"sync", enabled, sheetId, sheetName}`**, read and
    written only via `/api/admin/school-registrations/settings`. Never log names or phones.
  - **Kill switch:** nothing runs until a `sheetId` is saved; `enabled: false` stops the cron and
    "sync now". The cron is registered with the others (`ENABLE_CRONS`) but is inert in prod
    until configured.
  - **`shoofi.school-registrations`**, one doc per sheet row: `rowKey` (sha256 of canonical
    timestamp + raw phone + raw name; unique), `sheetRow` (display only), `raw{timestamp, name,
    school, class, phone, owner, classCode}` exactly as in the sheet (columns mapped **by header
    text**, a missing required column fails the run), `normalized{school, class, phone, name}`,
    `match{schoolId, classId, candidates{schools[], classes[]}}`, `status`, `issues[]`,
    `studentId`, `customerId`, `enrolledElsewhere`, `resolvedBy`, `history[]`,
    `createdAt/updatedAt/lastSeenAt`. Runs: **`school-registration-sync-runs`**
    (`startedAt/finishedAt/ok/error/counts`).
  - **Statuses:** `added` (new student) · `already_enrolled` (student existed for phone + school
    + class; linked if it was not) · `needs_review` · `invalid` (`invalid_phone`,
    `missing_name`) · `ignored` · `error` (enroll threw; retried every sync). Issue codes:
    `school_not_found`, `school_ambiguous`, `class_not_found`, `class_ambiguous`,
    `invalid_phone`, `missing_name`, `duplicate_row` (same phone + name on an earlier row: same
    class → auto-`ignored`, else review), `enrolled_other_class` (the same child — phone + name —
    already a student in another class: review, never a second student), `enroll_failed`.
  - **Re-sync rule:** `added` / `already_enrolled` / `ignored` and any `resolvedBy` row are
    final — only `lastSeenAt` moves. Unresolved rows are re-matched every sync (a new alias or
    class can resolve them; changed raw values are re-read). Writes are compare-and-set on
    `updatedAt`. A fetch / parse failure (HTTP ≠ 200, HTML instead of CSV — the sheet stopped
    being public —, missing columns) records a failed run and **changes no row**.
  - **Matching:** fold only safe differences (NFKC — prod class names are stored with a
    *decomposed* hamza, ا + U+0654 —, Arabic-Indic digits, أ/إ/آ→ا, ة→ه, ى→ي, quotes /
    parentheses / harakat, a leading "مدرسة" and trailing "الابتدائيه…", a leading "الصف", the
    leading "ال" of each word; built-in alias אלמנאר → المنار). **Auto-match only when exactly
    one school and exactly one class of it match.** A section-less grade ("الرابع") or a digit vs
    letter section ("الرابع 2" vs أ/ب) is **never guessed** → `class_ambiguous` with candidates.
    The class-code column is appended when the class text has no section.
  - **Aliases** (`shoofi.school-registration-aliases`, unique `(type, schoolId, key)`):
    `{type:"school", schoolId:null, key, targetId}` / `{type:"class", schoolId, key, targetId}`,
    written only when an admin resolves a row with "remember this spelling"; checked before the
    fold match.
  - **Never auto-create schools or classes.** The admin creates them in the schools screens,
    then resolves the row or presses retry.
  - **Roles on the schools section (decided 2026-10-04): `viewer` works it, and stays read-only
    everywhere else.**
    - Server: the registration routes take `SCHOOL_SECTION_ROLES` = master/admin/manager/viewer;
      the sync-settings **write** takes master/admin/manager only (`SYNC_SETTINGS_WRITE_ROLES`).
    - The older school routes have **no auth at all** today (known, parked — do not "fix" in
      passing): `GET/POST /api/admin/schools`, `PUT/DELETE /api/admin/schools/:id`,
      `GET/POST /api/admin/schools/:schoolId/classes`, `PUT/DELETE …/classes/:classId`,
      `GET/POST /api/admin/school-settings` (hours **and** the #271 payment-methods deny-list),
      `POST /api/customer/{school-students, add-student, create-school-project-batch,
      delete-school-project-customer, delete-all-school-project-students,
      toggle-school-project-active}`, `POST /api/payments/admin/school-students`; plus the
      customer-app reads `GET /api/customer/schools`, `POST /api/customer/{school-classes,
      get-students-by-ids}` and `GET /api/admin/check-order-time-valid`.
      A viewer therefore already reaches them; nothing gates them by role.
    - Client (delivery-web): the sidebar is the only role gate (`components/Sidebar/menu-access.ts`:
      `SCHOOLS_MENU_ITEMS` carry admin/manager/viewer); routes are not role-guarded except the
      accountant redirect. School settings are read-only for a viewer in the UI
      (`canEditSchoolSettings`) — client-side only for the hours / payment methods.
    - Audit: school writes are in the admin-audit map (`category: "schools"`), including the
      student routes in `routes/customer.js` (names, phones and the uploaded list omitted). The
      actor is the admin token's claims as **decoded, not verified** by the audit middleware —
      on the unauthenticated routes it is only as trustworthy as the caller.
    - Roles are a free-form array on `shoofi.shoofiAdminUsers.roles`; the UI's list is
      admin/manager/senior/operator/viewer/editor/accountant (+ `master`, DB-only). There is no
      server-side canonical list. `checkAdminRole` is an OR with no hierarchy.
  - Prod read-only dry run: `scripts/school-registrations-dry-run.js --env <abs path>` (runs the
    real sync against an in-memory copy). 2026-10-04: 60 rows → 4 added, 29 already enrolled,
    21 review (17 `class_ambiguous`), 3 invalid phones, 3 duplicates ignored.
- **`shoofi.storeUsers`** (partners) — `phone`, `appName`, `roles[]`, `token`, `authCode`.
  ⚠️ **`storeUsers` is the accessor, not the collection.** `db.storeUsers` is bound to the
  collection literally named **`store-users`**
  (`services/database/DatabaseInitializationService.js:49`); same trick for
  `db.persistentAlerts` → `persistent-alerts`, `db.shoofiAdminUsers` → `shoofi-admin-users`,
  `db.customerCampaigns` → `customer-campaigns`, `db.deliveryConfig` → `delivery-config`.
  A mongosh query or a hand-written seed against `shoofi.storeUsers` therefore hits an empty
  collection and **fails silently** — zero memberships, `error_code: -7` on login, and no
  error anywhere saying why. The repo's own `find-test-users.js:37` has this bug and always
  reports "no store users found"; don't use it to check your work.
  One phone can map to **multiple** store docs → OTP is propagated with `updateMany`.
- **`delivery-company.customers`** (drivers) — `role`, `isActive`, `companyId`,
  `personalSupportedAreas` (delivery-owned field).
- **`shoofi.shoofiAdminUsers`** — `phoneNumber`, `password`(bcrypt), `roles[]`, `refreshToken`,
  `resetCode`+`resetCodeExpiry`, `isFirstLogin`.
- **`shoofi.tasteProfiles`** (AI helper) — one doc per owner, `owner: {customerId}` **or**
  `owner: {deviceId}`; `stated`, `confirmed`, server-only `inferred`, `people` (≤ 8 family
  members the customer orders for: name, relation, what they don't eat, tagged dishes) and
  `family` (the onboarding's answer + the chat offer's dates and switch),
  `onboardedAt`/`skippedAt`/`createdAt`/`updatedAt`, `version: 1`. Not on the customer doc.
  Owner rules, merge and lifecycle: §5a.
- ⚠️ **`customers.orders[]` is a create-time snapshot with NO status** — never infer
  completion/revenue from it; join the store `orders` collection. Reuse
  `getSuccessfulOrdersByCustomerIds` (`utils/customer-orders.js`). See `docs/customer-orders-snapshot.md`.

## 5. Profile, addresses, notifications
Profile: `GET /api/customer/details` (joins store orders for a valid-order count),
`update`, `update-name`, `update-language`, `update-city-area` (resolves city from lat/lng
via `delivery-company.cities`). Addresses: `controllers/customerAddressController.js` —
add/get/update/delete/setDefault on the `addresses[]` subdoc (default toggling clears all
then sets one). Push tokens: `update-notification-token` — writes `notificationToken` on the
identity doc `req.auth.id` names, and **for a partner then mirrors it onto every sibling
`storeUsers` doc sharing that phone** (`updateMany`, self excluded). The mirror exists
because a new-order push is addressed to the token on the doc of *the store that got the
order*, while the app only ever registers the doc it is logged into — without it, a store
the owner hasn't opened on this device never pushes at all. Only `notificationToken` is
shared; each doc keeps its own `_id`, `token` and `roles`, so the per-store `recipientId`
addressing is unchanged. Guarded on a truthy token (an empty registration can't wipe the
siblings) and on the phone read off the *authenticated* doc, never the request body; a
failure there is logged, never fails the registration.

⚠️ **`getCustomerAppName(req, appName)` ignores both arguments and always returns the
`shoofi` DB** (`utils/app-name-helper.js`) — it is a customer-only helper, so
`getCustomerAppName(...).customers` resolves the identity doc **only** for
`app-type: shoofi-shopping`. A partner's id belongs to `shoofi.storeUsers` and a driver's to
`delivery-company.customers`, so the same expression silently matches **no document** for
those two apps — a write no-ops and a read returns null, neither of them erroring. Resolve
identity by `app-type` the way `validateAuthCode`, `delete` and `update-notification-token`
do. `POST /api/customer/logout` was the live instance of this: it nulled `token` /
`notificationToken` on `shoofi.customers` unconditionally, so partner and driver sessions
were never revoked server-side (only the client dropped its local copy) and their push
tokens accumulated indefinitely — fixed in shoofi-server#47.

**Logout is phone-wide for partners.** One partner identity is one `storeUsers` doc *per
store*, and `switch-store` mints a token onto the target store's doc without clearing the
previous one — so clearing only `req.auth.id` leaves a valid ~4-year token on every store
the session visited. `logout` therefore also `updateMany`s `token` / `notificationToken` to
null across every `storeUsers` doc sharing the phone (guarded: a failure there is logged,
never fails the logout). Consequence for reasoning about sessions: a partner logging out on
one device ends that identity's sessions on **all** its stores and devices, and the push
token mirrored across the sibling docs above dies with it — the sweep is what keeps the
mirror from outliving the logout.

## 5b. Push campaigns — who a send reaches, scheduling, the cap (`shoofi.customer-campaigns`)
The admin's קמפייני פוש screen (shoofi-delivery-web `views/admin/customer-campaigns/`) creates
campaigns, and `executeCampaign` sends them, one `sendNotification` per recipient. CORE
invariants 10 and 11 hold the rules. This section has the depth.

| Route | Auth | What |
|---|---|---|
| `POST /api/customer-campaigns/:id/execute` | `...adminOnly` | claim → audience → opt-out + cap filter → holdout → audience record (alongside) + send loop → `completed` |
| `POST /api/customer-campaigns`, `PUT /:id` | `...adminOnly` | `holdout: { pct }` validated 0–50 (`normalizeHoldoutInput`), 400 outside, never clamped |
| `POST /api/customer-campaigns/:id/schedule` | `...adminOnly` | future-date check, then `status: 'scheduled'` + Date `scheduledDate` (never from `in_progress`/`completed`) |
| `POST /api/customer-campaigns/:id/unschedule` | `...adminOnly` | `scheduled` → `draft`, atomically; 400 once the cron has claimed it |
| `PUT /api/customer-campaigns/:id` | `...adminOnly` | 409 while `in_progress` (the form saves its whole state, status included) |
| `GET/PUT /api/customer-campaigns/push-cap-config` | `...adminOnly` | the cap; PUT validates (`LIMITS` maxPushes 1–50, windowDays 1–60, integers), no upsert, `updatedBy` from `req.auth.id` |
| `GET/PUT /api/customer/marketing-preferences` | `auth.required`, customer app-type only | the customer's own `marketingPushOptOut` (boolean only) |

**Scheduling, end to end.** In the admin form, status "פעיל" plus scheduling "מתוזמן" saves
the campaign and then calls `/:id/schedule`. Only that call sets `status: 'scheduled'`, and
before 2026-10-28 the admin never called it. The datetime-local value is sent as typed
(`"2026-10-28T21:30"`, Israel wall clock) and `toScheduledDate` reads it with
`moment.tz(value, 'Asia/Jerusalem')`. An ISO instant (what older clients sent, and what prod
stores: 4 `scheduled`-type campaigns, all strings like `"2026-10-27T20:01:00.000Z"`) is kept as
that instant. The cron (`*/5`, started in `app.js`'s `shouldRunCrons` block) takes the Redis
lock `cron:scheduled-campaigns` for 4 minutes, finds `status: 'scheduled'` with
`scheduledDate <= now`, and calls `executeCampaign` with that same filter as its claim. The
lock only stops two instances scanning at once. The claim is what prevents a double send, and
it still holds after the lock expires mid-run.

**Run length.** An all-customers campaign runs about 50 minutes (sequential sends to ~18.9k
customers, prod 2026-10-27), so it routinely outlives the lock. A deploy or crash mid-run
leaves the campaign `in_progress` for good, partly sent. Prod had 11 such campaigns on
2026-10-28, May–August 2026 plus one from 2025-10. Nothing resets them, and they can't be
re-executed. That is an observation, not a reviewed verdict, so ask before acting on it.

**The cap's count.** `countRecentMarketingPushes` makes ONE streamed scan:
`{createdAt >= cutoff, "data.campaignId": {$exists: true}}` with projection `recipientId`,
counted in memory against the audience set. It is served by a **partial index**,
`campaign_createdAt_partial` = `{createdAt: 1}` over `{"data.campaignId": {$exists: true}}`
(`CAMPAIGN_CREATED_AT_INDEX`), built in the background once per process by
`ensureNotificationIndexOnce` and never awaited, so the first run after a deploy may still scan.
Keep the `$exists` predicate in the query, or the planner can't use a partial index. Before
2026-10-29 `shoofi.notifications` had **only the `_id` index in prod** (5.3M rows), and every
campaign run read all of it. The other indexes in shoofi-server
`utils/migrations/create-notifications-collection.js` were never applied, so a per-customer
query (`recipientId`, e.g. `/api/notifications/stats`) is still a collection scan per call.
Prod volume: ~2.65M campaign records all-time, ~67k in a week. A failed count fails the campaign (`status: 'failed'`), so it never sends
uncapped.

**What counts as marketing.** Only `customer-campaigns` sends. The admin's raw
`/api/notifications/send*` and the coupon-campaign sends do not set `data.campaignId`: they
neither count toward the cap nor get capped or opt-out filtered. Partner and driver campaigns
(`appType` `shoofi-partner` / `shoofi-shoofir`) skip both rules (`isCustomerAudience`).

**Preview ≠ reach.** `audience/preview` and `audience/users` still count the raw audience. The
skips appear only in the execution result (`execution.skippedOptOut`, `skippedCapped`,
`pushCap`, `holdoutCount`) and in the list's results column.

**Holdout and the audience record (CORE invariant 13).** Why: prod sent ~66.7k campaign pushes
to ~18.9k customers in the week to 2026-10-28, and last-touch attribution credits a push with
orders that would have happened anyway. A holdout gives the baseline.
- *Sizing (prod, read-only, 2026-10-28):* 216 executed campaigns, all `shoofi-app`; audience
  median 14.9k, p10 4.3k, max 18.9k; 176 `all`, 40 `all` + city area, 7 `selected`, 4 `rules`.
  The only campaigns under 2000 were 7 manual sends of < 50, hence `MIN_AUDIENCE = 200`: a 5%
  holdout of the smallest real campaign (4.3k) is still ~215 customers.
- *Assignment* is `assignHoldout(campaignId, policy.userIds, campaign, isCustomerAudience)` →
  `{treatedIds, holdoutIds, pct, requestedPct, skippedReason}`. `applyMarketingPushPolicy` also
  returns `optedOutIds` / `cappedIds` (the counts are their lengths), which become the
  `opted_out` / `capped` rows.
- *The write* is `recordAudience(shoofiDb, campaignId, {treated, holdout, capped, optedOut}, at)`
  → `{rows, errors, error}`; started before the send loop, awaited after it (and in the
  failure path), so it neither delays nor can fail the send. A duplicate-key write error is not
  counted as lost (`lostWrites`); any other row error is, and a chunk-level error (network)
  counts the whole chunk.
- *Retries:* the only re-execution path is a `failed` campaign (claimable again; an
  `in_progress` one stuck by a crash is not, see Run length). The second run re-sends to
  everyone eligible. That is #335's behaviour, not changed here, and the cap counts the first
  run's pushes. Row outcome: unchanged groups stay; capped/holdout → treated if this run pushed
  them; treated stays treated with its first `at`.
- *Storage:* ~67k rows a week, ~3.8M at the 400-day TTL steady state. No row is deleted with a
  customer account (it holds two ids, a group and a date; the soft-deleted customer doc and the
  campaign's `shoofi.notifications` records stay too). The TTL is what removes rows.
- *Admin:* "קבוצת ביקורת %" on the campaign form (shoofi-delivery-web
  `views/admin/customer-campaigns/HoldoutField.tsx`, `parseHoldoutPct` mirrors the 0–50 rule),
  and `קבוצת ביקורת: N` / `ללא קבוצת ביקורת (קהל קטן)` / audience-record errors in the list's
  results column.

## 5a. AI-helper taste profile — owner, merge, lifecycle (`shoofi.tasteProfiles`)
The customer app's floating persona **شوفي / שופי** runs a short taste onboarding and keeps
the answers server-side (design: shoofi-server `docs/ai-helper.md`). This domain owns **whose**
profile it is and how it moves across login, logout and deletion; what a profile does to
suggestions is menu-catalog's.

| Route (`routes/ai-helper.js`) | Auth | Owner / caller |
|---|---|---|
| `GET /api/ai-helper/profile` | `auth.optional` | customer token, else `device-id`; neither → `200 {profile: null, deliveredOrders: 0}` |
| `PUT /api/ai-helper/profile` | `auth.optional` | same; neither → `400` |
| `POST /api/ai-helper/merge` | `auth.required` | customer token only — no token `401`, partner/driver token `403` |
| `GET /api/ai-helper/facts` | `auth.required` | customer token only (`403` otherwise) |
| `GET /api/ai-helper/cuisines` | `auth.optional` | no owner — location only |

**Owner resolution** (`ownerFromRequest`, `services/ordering-intelligence/taste-profile.js`):
- **Customer** — `req.auth.id`, only when `app-type` is absent or `shoofi-shopping`, stored as
  `String(req.auth.id)`. Same guard as `routes/for-you.js`: `auth.optional` resolves partner
  (`storeUsers`) and driver (`delivery-company.customers`) tokens too, and their ids are not
  customers', so such a token counts as no login — it falls to the device id, and `merge` /
  `facts` answer `403`.
- **Visitor** — `deviceIdFromRequest`: the `device-id` **header only**, trimmed, 8–200 chars,
  else no owner. The customer app generates it once (`utils/http-interceptor`, AsyncStorage
  `@storage_deviceId`, `device_<id>_<ts>_<rand>` — not a UUID) and sends it on every request;
  nothing in the app clears it, logout included. The same header is already read by
  `routes/order-fraud-checks.js` (after the body's `deviceId` / `unique_hash`), `routes/stories.js`
  (the signed-out viewer key) and `routes/app-logs.js` (`user_visit_id`, orders CORE).
- **Accepted risk** (shoofi-server `docs/ai-helper.md`): the device id is a client string, so
  whoever sends it reads and writes that visitor profile. It is bounded by what a device owner
  can get: food preferences only, nothing account-derived — `GET /profile` returns
  `deliveredOrders: 0`, `facts` and `merge` need a customer token, and `publicProfile` returns
  `owner: {kind: "customer" | "device"}` (never the customer id or the device id) and never
  `inferred`.

**Storage.** Unique partial indexes on `owner.customerId` and `owner.deviceId`
(`partialFilterExpression: {$type: "string"}`), plus `updatedAt`; created lazily on first use
per process (`ensureIndexes`). ⚠️ `owner.customerId` is the 24-hex **string** of
`customers._id`, and every timestamp (`createdAt`, `updatedAt`, `onboardedAt`, `skippedAt`,
`inferred.computedAt`) is a UTC ISO **string** (`toISOString()`), not a BSON Date — join with
`String(_id)` and compare with ISO strings (cf. CORE invariant 5).

**Writes** (`saveProfile`). `PUT` builds its update from `stated`, `confirmed`, `onboardedAt`,
`skippedAt`, `people`, `family` only. `saveProfile` sanitises (`sanitizeStated`,
`sanitizeConfirmed`, `sanitizePeople`, `sanitizeFamily`), replaces `stated`, `people` and
`family` whole when sent, sets `confirmed.<key>` per key, and writes `owner` only through
`$setOnInsert` from the server-derived owner — `owner` and `inferred` are never read from the
body (test: "a client cannot set owner or inferred"). `inferred` is written only by
`refreshInferredIfStale`, for customer owners, lazily on `GET /profile` (details: the design doc).

**Merge** (`mergeDeviceIntoCustomer`, behind `POST /api/ai-helper/merge`):
- The device profile is found by the **header's** device id (`profiles.deviceIdFromRequest(req)`,
  never the body). No device profile, or no header → `{merged: false, profile: <the account's>}`,
  so a repeat call is a no-op (idempotent).
- `stated`: the account's wins field by field when non-empty (`mergeStated`; `null` and `[]`
  count as empty); no account profile yet → the device's.
- `confirmed`: the union; on a shared key the account's answer wins.
- `onboardedAt`: the earlier of the two; `skippedAt`: the account's if set, else the device's.
- `people`: the account's when it has any, else the device's; `family`: the account's when its
  `answer` is set, else the device's (never a union — two lists of "Mom" would duplicate her).
- Upserts the customer's doc, **then deletes the device doc** — the shared-phone guarantee: the
  next person to log in on that phone does not inherit it. The delete belongs to a successful
  merge only; if the call fails, the device profile stays on the server under that device id.
- **Not** inside `validateAuthCode`, and not on impersonation (below).

**App** (shoofi-app `stores/ai-helper`, `aiHelperStore`). Keeps a copy in AsyncStorage
`@storage_tasteProfile` for instant / offline routing.
- **Login:** `screens/verify-code` calls `aiHelperStore.mergeAfterLogin()` straight after
  `authStore.updateUserToken(...)` — **not awaited**, errors swallowed, so login never waits on
  it or fails because of it. It posts only when the cached profile's `owner.kind` is `"device"`,
  then refreshes from `GET /profile`. A failed merge is re-attempted only at a later login made
  while the cached copy is a device profile.
- **Impersonation:** `stores/auth/impersonation.ts` `consumeMasterLink` also calls
  `updateUserToken` but does **not** merge (verify-code is the only `mergeAfterLogin` caller), so
  a master operator's own visitor answers never land on the customer they open. Keep it so.
- **Logout / delete:** `stores/auth` `logOut` and `deleteAccount` call `aiHelperStore.clear()`
  (the in-memory profile and the cache key). `resetAppState` — the forced sign-out the
  general-server-error dialog runs on a 401 — does **not**; there the account's copy stays cached
  until the next `refresh()` replaces it with the device's profile (or null). The server keeps
  the account's profile across logout: it belongs to the account.
- **Deletion:** `POST /api/customer/delete` leaves the `tasteProfiles` doc in place — §7 item 10.

## 6. Referrals (`routes/customer-referrals.js`)
8-char code (ambiguity-free alphabet) + TinyURL short link with `/r/:code` fallback. Config on
`shoofi.store {id:1}.referralConfig` (reward amounts, `minFriendOrderAmount`, validity,
`maxInvitesPerCustomer`). `attributeCustomerToReferrer` on signup-click match (rejects
self-referral) → friend coupon + `customerReferrals` audit row (`rewardStatus:'pending_first_order'`).
`recordFirstOrderForReferrer` fires at payment-confirm (idempotent via `firstOrderId:null`,
cap-checked) → inviter coupon + notify. `revertFirstOrderForReferrer` on cancel. Coupons are
`isCustomerSpecific:true` in `shoofi.coupons` — the growth/accountant domains see them as Shoofi-funded.

**Readers of attribution.** The unit-economics dashboard (shoofi-server
`services/unit-economics/collect.js`, `docs/unit-economics.md`) derives a customer's
**acquisition channel** from these fields and nothing else: `referral.influencerCode` →
influencer, `referral.inviterCustomerId` → referral, otherwise unattributed. Its **town** is
`cityId` (else the default address's `cityId`) resolved through `parent-cities.cityIds`.
Renaming either `referral` key, or writing attribution somewhere else, silently moves every
attributed customer into "unattributed" on that screen's CAC table.

## C — Client repos (full-stack)
All three RN apps share a **copied base** (same interceptor, stores, login/verify screens) —
they differ only in `app-type`, default `app-name`, and post-login navigation.

### C1. shoofi-app (customer) — `app-type: shoofi-shopping`
`screens/login` → `customer/create`; `screens/verify-code` (4 cells) → `customer/validateAuthCode`
→ `authStore.updateUserToken` → fire-and-forget `aiHelperStore.mergeAfterLogin()` (§5a); new
user → `screens/insert-customer-name` → `customer/update-name`.
Token in AsyncStorage `@storage_userToken`, sent as `Authorization: Token`. Also sends a
generated **`device-id`** (`@storage_deviceId`, never cleared) — read by the fraud checks,
stories and app-logs, and the owner key of a visitor's taste profile (§5a). Stores:
`stores/auth` (login/logout/deleteAccount; `logOut` and `deleteAccount` also call
`aiHelperStore.clear()`), `stores/user-details` (`customer/details`), `stores/address`,
`stores/ai-helper` (the taste-profile copy, §5a).
Profile → **"إشعارات العروض / התראות על מבצעים"** switch (`components/profile/MarketingPushToggle.tsx`,
logged-in only): `GET/PUT customer/marketing-preferences` with `silent: true`. Hidden until the
server answers, and reverts on a failed save. ON = receives campaigns. Its copy carries ar/he
`defaultValue`s, because translations come from the DB.

### C2. shoofi-partner (store owner) — `app-type: shoofi-partner`
**Same phone+OTP flow** (not admin creds). The partner-specific mechanism is
**`customer/switch-store`**: `stores/auth/index.ts switchStore(appName)` sends
`app-name: <store>`, receives a **new per-store token**, writes `@storage_storeDB`
(`shoofiAdminStore.setStoreDBName`) and resets menu/orders/cart. That's how every later
request gets scoped to the right store. Supports multi-store membership (`stores[]`,
`hasMultipleStores`) and an `isDriver` dual-mode.

### C3. shoofi-shoofir (driver) — `app-type: shoofi-shoofir`
Same OTP flow; `app-name` defaults to **`delivery-company`**, and `customer/details` is
fetched with that app-name, so the identity resolves to `delivery-company.customers`.
Driver profile via `delivery/company/employee/{driverId}`.

### C4. shoofi-delivery-web (admin) — `app-type: shoofi-admin`
**Password login** `admin/users/login` → `{user, token}`; `isFirstLogin` forces a password
change. Token in `localStorage['@storage_userToken']` + `adminUser`, sent as
**`Authorization: Bearer`** (note: Bearer here, `Token` in the RN apps). A 401 triggers the
**refresh-token flow** in the interceptor (guarded against loops) → retry, else logout+redirect.
Roles/permissions: `contexts/AdminAuthContext`, `ProtectedRoute`, `RoleBasedAccess`,
`RestrictedRoleGuard` (e.g. `accountant` limited to invoice screens).
**`/api/analytics/*` is admin-token only** (shoofi-server `utils/analytics-access.js`,
2026-10-29). Before that, all 43 routes in `routes/analytics.js`, `growth-analytics.js` and
`weekly-status.js` answered with no token. That included revenue, coupons, customer
locations, order details, a snapshot backfill and the paid AI weekly brief.
- Every route carries `...adminAnalytics` = `["master", "admin"]`, matching the sidebar's
  `["admin"]` on those screens.
- `GET /api/analytics/order/:orderId` and `POST /api/analytics/deliveries` carry
  `...dashboardAnalytics`, i.e. every dashboard role, viewer included. Live-ops, the ops
  dashboard and the order modal read them, and prod has viewer-only staff.
- No mobile app calls any of them. A new analytics route needs one of the two gates;
  `test/integration/analytics-routes-auth.js` fails on a route without one.
- `weekly-status/marketing-spend` was deleted. It read an unregistered
  `weeklyKpiManualInputs` handle and 400'd on every call. CAC is the `acquisition-spend`
  ledger (unit economics).
Push campaigns (§5b): `views/admin/customer-campaigns/` has the list with the
`PushCapSettings` panel, skip counts, the scheduled time and cancel-schedule. The form sends
the schedule as an Israel wall-clock string and shows stored instants through
`utils/jerusalem-time.ts`. It used to show them back in UTC, 2–3 hours off.

## 7. Known status (human-confirmed) — do NOT act without an explicit task
All four items below were reviewed with the owner and are **KNOWN / accepted for now**.
Do not "fix" them opportunistically; they are scheduled work, not bugs to discover.
1. **KNOWN — planned rotation:** hardcoded JWT secret `'secret'`
   (`utils/auth-service.js`, `admin-auth-service.js`), shared by customer, admin and
   impersonation tokens. **Changing the literal logs out every user on every app**, so it must
   be a planned migration. Also a Basic-auth credential baked into `utils/sms.js`. Leave alone.
2. **KNOWN — hardening planned.** `authCode` is a plaintext 4-digit code with no expiry, no
   attempt counter, no lockout; the `apiLimiter` (5/5min) is defined but **not wired**.
   **Planned work (do not implement unasked):** (a) add a **max-retry limit on requesting a
   code**, and (b) let the user **choose WhatsApp vs SMS** as the delivery channel. Design
   changes here should keep both in mind.
3. **KNOWN:** `search-customer` (`customer.js`) projects `token` + `authCode` and has no
   `auth.required`. Accepted for now.
4. **KNOWN — to handle later:** unauthenticated identity-adjacent endpoints — address CRUD
   , `search-customer`, storeUsers CRUD, `cash-restrict`, most `/api/shoofiAdmin/*`
   take IDs from the URL/body with no auth. **Never widen this surface further**; adding auth
   is planned work.
5. **Mass-assignment** — `POST /api/customer/update`  spreads `req.body` into `$set`,
   so `token`/`roles`/`isBlocked` could be overwritten by a caller.
6. **`jwt.decode` without verification** — `admin/users/refresh-token`  and
   `customer-feedback`  read unverified payloads. Never trust those for authorization.
7. **~4-year customer token expiry** (`auth-service.js`) — mitigated by stored-token equality
   (logout works), but very long-lived.
8. **NOT a bug (verified) — push-token registration routes on `app-type`, not `app-name`.**
   The driver app overrides `app-name: 'shoofi'` when calling `update-notification-token`
   (`shoofi-shoofir/hooks/use-notifications.ts`), which *looks* wrong — but the server
   handler (`customer.js`) selects the collection from **`app-type`**
   (`shoofi-shoofir` → `delivery-company.customers`), so the token lands on the correct record.
   Two cosmetic leftovers, not worth a drive-by fix: `const db = await getOrInitializeDb(appName…)`
   in that handler is **assigned and never used** (a wasted DB-init per call), and the
   misleading `app-name` override would *become* a real bug if the handler were ever changed
   to route on `app-name`. **Remember: identity routing is by `app-type` throughout this domain.**
9. **Dead/inherited (hands-off per §1c)** — the `AUTH_API`/`Authenticator` const block is
   imported in all three RN apps but **referenced 0 times** (legacy pre-`customer` surface);
   admin web has an unused `AdminTokens` interface; `routes/user.js` is legacy expressCart admin.
10. **KNOWN — not yet handled (AI helper; recorded in shoofi-server `docs/ai-helper.md`,
    2026-10-16):** `POST /api/customer/delete` soft-deletes the identity doc but leaves
    `shoofi.tasteProfiles {"owner.customerId": <id>}` in place; only the app's cached copy goes
    (`deleteAccount` → `aiHelperStore.clear()`). Since the customer `_id` survives deletion
    (CORE invariant 8), a login after deletion finds the old profile again. Handling it touches
    `routes/customer.js` — its own HIGH-RISK draft PR, not a drive-by.

## 8. Definition of done
Inherit `_shared-guardrails.md` §7. For identity specifically: **never log OTPs/tokens/secrets**;
state which app-types a change affects (all four branch off the same endpoints) — and, for the
taste profile, whether it touches the visitor (`device-id`) owner (§5a); confirm you
did not weaken stored-token equality, the impersonation master-gate, or `getCustomerAppName`'s
central-DB behavior; and for anything touching the JWT secret or token lifetime, treat it as a
**planned migration with a logout blast-radius**, not a code fix.
