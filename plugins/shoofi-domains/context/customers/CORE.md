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
6. **Never log OTPs, tokens, or secrets** — including in debug output added "temporarily".

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
