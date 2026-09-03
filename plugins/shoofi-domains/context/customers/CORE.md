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
   `createdBy`/`approvedBy`, `routes/delivery/admin.js` writes `'Admin'` for `actor`,
   `routes/store.js` and `routes/delivery/company.js` skip their `if (req.user)` history-
   attribution blocks entirely, and `routes/notifications.js` falls back to a **client-supplied
   `user-id` header**. Those sites are pre-existing and out of scope unless the task names them
   — but **do not copy them**. `req.auth.id` is the 24-char hex **string** (`jwt.sign`
   serialises the ObjectId), so compare with `String(...)` or cast via `getId`
   (`lib/common.js`). Any new `createdBy`-style provenance must be read from `req.auth` and
   never from the request body; `routes/team-tasks.js` is the reference implementation.
8. **Customer notes are an EMBEDDED `notes[]` array on the `shoofi.customers` document —
   there is no notes collection.** A grep for "notes" lands first on `routes/notes.js` /
   `db.notes` / the admin `/admin/notes` screen, which is an **unrelated** announcement-banner
   feature keyed on `cityAreas`. The customer notes CRUD is four `auth.required` routes in
   `routes/customer.js` (`GET/POST /api/customer/:customerId/notes`,
   `PUT/DELETE .../notes/:noteId`). Two shapes to keep: `notes[]._id` is a **uuid string**, not
   an ObjectId — the DELETE handler `$pull`s on it — and `notes[].createdAt` is a real BSON
   `Date` (invariant 5's string/Date split applies here too).

   **⚠️ A NOTE CAN BE DESTROYED SILENTLY, AND `notes[]` MUST NOT BE BUILT ON.** Because it is
   embedded, it is caught by every whole-document rewrite of the customer — and there are
   seven. The worst is **order creation**: `routes/order.js` reads the customer, does ~25
   awaits of real work (coins, stock, coupon issuance *with an SMS send*, the order insert,
   fraud checks), then writes back `$set: { ...customerWithoutAddresses, orders: [...] }`.
   **Only `addresses` is destructured out — `notes` rides along**, so the array is replaced
   with a snapshot read seconds earlier and anything added in that window is gone. The six in
   `routes/customer.js` (OTP-request, OTP-verify, update-name, `/api/customer/update`, …) do
   the same with a shorter window; note that OTP-verify's runs through
   `utils/auth-service.js` `toAuthJSON`, which re-spreads the user, so the window there spans
   a JWT mint and its own DB round-trip.

   The loss is conditional in the way that hides it: `$set` only touches `notes` when the read
   document **had** the key, so **a customer's FIRST note always survives and every note after
   it is at risk**. The feature reads as working. It also silently clobbers the `isSystem`
   block/cash-restriction audit notes below.

   Consequences for any new work: **do not park a note-like history on the customer document**
   — put it in its own collection, one document per entry, as
   `services/customer-case-notes/case-notes.js` does for the churn-360 and deletion-request
   work queues. And note the notes API has **no bulk read**, so a "latest note + count" column
   on any list screen is one request per row unless you build one. Fixing `notes[]` properly
   means converting those seven whole-document rewrites into targeted `$set`s, which crosses
   into `routes/order.js` (do-not-touch, and the `orders` domain's) — a bigger change than
   whatever feature surfaced it, so scope it deliberately rather than as a side effect.

   **A note with `isSystem: true` is an audit record and must stay immutable.** The block and
   cash-restriction routes write one on every change, via
   `services/customer/customer-restriction-service.js`; the note PUT and DELETE handlers refuse
   them with 403 and the `$pull` filter carries `isSystem: { $ne: true }` so the check and the
   write are one operation. Do not add an override, and do not let the manual note form offer
   the `restriction` category — a hand-written note there would look like an audit record
   without being one.

   **Restriction changes go through the service, never a bare `$set`.** `isBlocked` and
   `cashRestricted` each have a dedicated route (`PUT /api/customer/:customerId/block`,
   `PUT /api/customer/:customerId/cash-restrict`, both `auth.required`) that **requires a
   `reason`** and writes the flag and its note in a **single `updateOne`** — `$set` + `$push`
   cannot half-apply, so a flag can never end up without the reason for it. Enforcement is in
   the service rather than the handlers because the admin web has two cash-toggle call sites.
   Blocking also nulls `token` (immediate forced logout, per invariant 2); unblocking
   deliberately does **not** restore it — the customer re-runs OTP. Blocking used to ride on
   the mass-assigning `POST /api/customer/update`, which the customer app also uses for its own
   profile edits; do not move it back there.

   **All six of these routes — block, cash-restrict and the four note routes — carry
   `checkAdminRole(CUSTOMER_ADMIN_ROLES)` on top of `auth.required`, and must keep it.**
   Per invariant 7's sibling rule in `utils/admin-role.js`, `auth.required` proves only that
   *some* valid token was presented; admin and customer tokens share a signing secret, so a
   customer's own token passes it. And a blocked customer can still obtain one — OTP login
   never checks `isBlocked` (`routes/customer.js` `validateAuthCode`; `POST /api/customer/create`
   returns `isBlocked` as a *payload field* and the apps self-enforce), so without the role gate
   a blocked customer could call the block route and unblock themselves, with the audit note
   naming them as the actor. `CUSTOMER_ADMIN_ROLES` lists **every** admin role deliberately: it
   proves "this is an admin token", it is not a privilege level. **`viewer` is what the support
   team carries** — narrowing the list is a product decision that locks real users out, not a
   tightening you can make in passing.

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
