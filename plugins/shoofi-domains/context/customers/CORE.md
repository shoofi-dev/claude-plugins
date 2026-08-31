---
domain: customers
last-verified: shoofi-server@561e3ca / 2026-07-28
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
**Not yours:** order history content (`orders`), coins/rewards (growth), driver coverage
fields (`delivery`) — you own the identity record they hang off.

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
8. **Account deletion writes TWO fields, and only one of them means anything afterwards.**
   `POST /api/customer/delete` (`routes/customer.js`) soft-deletes with
   `$set: { isDeleted: true, deletedAt: new Date() }` — routed by `app-type` like everything
   else here, so it lands on `shoofi.customers`, `shoofi.storeUsers` or
   `delivery-company.customers`. The two fields then diverge:
   - **`deletedAt` is write-once.** It is set at exactly one place in the whole server and is
     **never read and never unset**, so it is the only durable "this account asked to be
     deleted" marker. It is a BSON `Date` — so comparing it against an order's `created`
     (an offset string, see invariant 5) needs **both sides parsed to instants**, not a Mongo
     range predicate and not a string compare.
   - **`isDeleted` is reset to `false` on the next OTP REQUEST**, inside the create/login
     handler's `$set: { ...customer, … isDeleted: false … }` (`routes/customer.js`) — *before*
     any code is verified. Because that write is a whole-doc spread of a stale read,
     `deletedAt` survives it untouched. So **`isDeleted: false` on a doc that has `deletedAt`
     means "someone typed this phone into a login screen"**, not "the account is back". Do not
     build a recovery or reactivation metric on it; join the store `orders` collections and
     compare against `deletedAt` instead.

   That same whole-doc-spread is why **per-customer admin state must never live on the customer
   document**: six routes rewrite it wholesale from a stale in-memory read (`validateAuthCode`
   via `toAuthJSON`, create/OTP, `update-name`, `update`, `update-plan`, `update-plan-branch`),
   and `POST /api/customer/update` is `$set: { ...customer, ...body }` — a stale rewrite *and*
   mass assignment. An admin write parked there is reverted by the next verification code the
   customer asks for, silently and with no error anywhere. Use a sidecar collection keyed on
   `customerId`; `shoofi.customer-deletion-cases` is the reference implementation.

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
- **KNOWN — to handle later:** several identity-adjacent endpoints (address CRUD,
  `search-customer`, storeUsers CRUD, `cash-restrict`) take IDs from the URL/body with no auth.
  **Never widen this surface further.**
- **NOT a bug (verified):** the driver app sends `app-name: 'shoofi'` on push-token
  registration, but the server routes on **`app-type`**, so the token lands correctly on
  `delivery-company.customers`. (Leftovers: an unused `db` variable in that handler, and a
  misleading header that *would* become a bug if the handler ever routed on `app-name`.)

## Recipe — touching an auth or identity path
1. State **which of the four app-types** your change affects — they all share these endpoints.
2. Confirm you haven't weakened stored-token equality, the impersonation master-gate, or
   `getCustomerAppName`'s central-DB behavior.
3. Anything touching the JWT secret or token lifetime is a **planned migration with a
   logout blast-radius**, not a code fix — stop and ask.
4. Re-read the output you're adding: no OTP/token/secret may appear in logs or responses.

## Definition of done
Inherit `_shared-guardrails.md` §7, plus the four recipe points above.
