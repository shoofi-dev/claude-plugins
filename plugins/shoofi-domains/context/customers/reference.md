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
  `schoolProject{…}`. **No `tokenExpiry` field** — expiry lives only inside the JWT.
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

## 6. Referrals (`routes/customer-referrals.js`)
8-char code (ambiguity-free alphabet) + TinyURL short link with `/r/:code` fallback. Config on
`shoofi.store {id:1}.referralConfig` (reward amounts, `minFriendOrderAmount`, validity,
`maxInvitesPerCustomer`). `attributeCustomerToReferrer` on signup-click match (rejects
self-referral) → friend coupon + `customerReferrals` audit row (`rewardStatus:'pending_first_order'`).
`recordFirstOrderForReferrer` fires at payment-confirm (idempotent via `firstOrderId:null`,
cap-checked) → inviter coupon + notify. `revertFirstOrderForReferrer` on cancel. Coupons are
`isCustomerSpecific:true` in `shoofi.coupons` — the growth/accountant domains see them as Shoofi-funded.

## C — Client repos (full-stack)
All three RN apps share a **copied base** (same interceptor, stores, login/verify screens) —
they differ only in `app-type`, default `app-name`, and post-login navigation.

### C1. shoofi-app (customer) — `app-type: shoofi-shopping`
`screens/login` → `customer/create`; `screens/verify-code` (4 cells) → `customer/validateAuthCode`
→ `authStore.updateUserToken`; new user → `screens/insert-customer-name` → `customer/update-name`.
Token in AsyncStorage `@storage_userToken`, sent as `Authorization: Token`. Also sends a
generated **`device-id`** (fraud). Stores: `stores/auth` (login/logout/deleteAccount),
`stores/user-details` (`customer/details`), `stores/address`.

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

## 8. Definition of done
Inherit `_shared-guardrails.md` §7. For identity specifically: **never log OTPs/tokens/secrets**;
state which app-types a change affects (all four branch off the same endpoints); confirm you
did not weaken stored-token equality, the impersonation master-gate, or `getCustomerAppName`'s
central-DB behavior; and for anything touching the JWT secret or token lifetime, treat it as a
**planned migration with a logout blast-radius**, not a code fix.
