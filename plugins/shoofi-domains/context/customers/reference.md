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
- **`shoofi.storeUsers`** (partners) — `phone`, `appName`, `roles[]`, `token`, `authCode`.
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
**one** identity doc `req.auth.id` names, so for a partner it lands on the currently-active
`storeUsers` doc, not on every store that phone owns.

⚠️ **`POST /api/customer/logout` clears nothing for partners and drivers.** It does **not**
branch on `app-type` — it hardcodes `customerDB.customers` (`routes/customer.js:2002`), and
`getCustomerAppName` always returns the `shoofi` DB. A partner's id belongs to
`shoofi.storeUsers` and a driver's to `delivery-company.customers`, so the update matches no
document and `token` / `notificationToken` survive logout — only the client drops its local
copy. Contrast `POST /api/customer/delete` directly below it, which *does* branch on
`app-type`. Consequence: the stored-token equality check in `routes/auth.js` is **not** a
working revocation path for partner or driver sessions, and stale push tokens accumulate on
those docs indefinitely. Fixing it is an auth change with a logout blast radius — its own
draft, HIGH-RISK, minimal-diff PR, never a rider on a feature.

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
