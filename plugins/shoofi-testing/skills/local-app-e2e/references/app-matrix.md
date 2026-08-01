# Per-app matrix

Everything that differs between the three React-Native apps. All of it was
confirmed against the code and against a live run on an iPad simulator
(iOS 26.5) on 2026-08-01.

## Identity

The `app-type` header decides which collection `POST /api/customer/validateAuthCode`
authenticates against — the app-name header does **not**.

| App | bundle id | `app-type` | Login identity lives in |
|---|---|---|---|
| `shoofi-app` (customer) | `com.shoofi.shopping` | `shoofi-shopping` | `shoofi.customers` |
| `shoofi-partner` (store owner) | `com.shoofi.partners` | `shoofi-partner` | `shoofi.store-users` |
| `shoofi-shoofir` (driver) | `com.shoofi.shoofir` | `shoofi-shoofir` | `delivery-company.customers` |

All three default `APP_NAME` to `'shoofi'` (`consts/shared.ts`), so on a fresh
install the `app-name` header is `shoofi` until the app stores a real one.

### Minimum documents

```js
// customer — shoofi.customers
{ phone: "1234567890", fullName: "زبون اختبار", created: new Date() }

// store owner — shoofi.store-users  (HYPHENATED, see the accessor trap below)
{ phone: "1234567890", fullName: "…", isAdmin: true, roles: ["admin"],
  appName: "<store>", created: new Date(), orders: [] }

// driver — delivery-company.customers
{ phone: "1234567890", fullName: "سائق اختبار", role: "driver",
  isActive: true, isAvailable: true, companyId: "<id>",
  createdAt: new Date(), updatedAt: new Date() }
```

The same phone can hold all three at once — handy, since one seeded phone then
logs into every app.

### Collection-accessor trap (partner)

`db.storeUsers` is an **accessor for the collection literally named
`store-users`**; likewise `db.persistentAlerts` → `persistent-alerts`. Insert into
the **hyphenated** names or the server never sees your document and login fails
with `error_code -7` and no useful message. Do not trust
`shoofi-server/find-test-users.js` to verify — it has this exact bug.

Prefer the API over hand-inserting a store user (unauthenticated, local only):

```bash
curl -X POST http://localhost:1111/api/customer/store-users/<appName> \
  -H 'Content-Type: application/json' \
  -d '{"phone":"1234567890","fullName":"…","isAdmin":true,"roles":["admin"]}'
```

It stamps `created: new Date()`, so if the order of `created` matters (below),
patch it afterwards.

### Partner specifics

- `isAdmin: true` is required, or the dashboard renders blank **and** admin-gated
  polls never start.
- A phone can be a store user in several stores. Which one you land in:
  `validateAuthCode` prefers the doc whose `appName` equals the incoming
  `app-name` header, **else the most recently `created`**. Since a fresh install
  sends `app-name: shoofi`, nothing matches and **newest `created` wins** — set it
  explicitly when you care which store you land in.
- `GET /api/customer/details` and `switch-store` both return a `stores[]`
  membership array derived **by phone**; multi-store UI is gated on
  `stores.length > 1`.

## First-run gates before you reach a login screen

This is the part that differs most, and the part that wastes the most time.

| App | Gates, in order |
|---|---|
| `shoofi-partner` | none — the login screen is the first screen |
| `shoofi-shoofir` | none — the login screen is the first screen |
| `shoofi-app` | 1. language picker (`العربية` / `עברית`) → 2. iOS **location** permission → 3. `select_city_area` screen → home. Login is **not** on the path: it sits behind the **person icon in the bottom tab bar** (leftmost, ≈`22%,95%` on iPad), and after logging in the app returns you to home rather than anywhere new |

`shoofi-app`'s city-area screen is **data-gated**: it lists
`delivery-company.city-areas`, and with an empty collection there is nothing to
tap and you cannot proceed. Seed at least one before you start.

Grant location up front rather than tapping the dialog:

```bash
xcrun simctl privacy <udid> grant location com.shoofi.shopping
```

…or in the flow, `launchApp: { permissions: { location: allow } }`.

## Dev-client

| App | `expo-dev-client` |
|---|---|
| `shoofi-app` | `~5.2.4` — yes |
| `shoofi-partner` | `~5.2.4` — yes |
| `shoofi-shoofir` | **not installed** |

Where it *is* installed, a `clearState: true` launch drops you on the dev-client
launcher instead of the app — see `maestro-cookbook.md` for the three taps that
get you past it.

Where it is **not** (`shoofi-shoofir`), `expo run:ios` **builds and installs fine
and then fails at the launch step**:

```
CommandError: No development build (com.shoofi.shoofir) for this project is
installed. Install a development build on the target device and try again.
```

That message is misleading — the app *is* installed. `expo run:ios` is just trying
to hand off via the dev-client URL scheme, which this app does not implement. Metro
also dies with it. Do this instead, and the plain Debug build connects to Metro on
its own with no launcher and no developer-menu sheet:

```bash
npx expo start &                        # plain, not --dev-client
xcrun simctl launch <udid> com.shoofi.shoofir
```

## The login screen itself

All three apps share it — same Arabic strings, same layout, so one Maestro block
logs into any of them:

- phone label `ادخل رقم هاتفك`, with the text input **directly below it** and no
  accessibility label of its own → select it with `tapOn: { below: "ادخل رقم هاتفك" }`;
- submit button `تم`;
- code screen title `ادخل الكود`, four cells with no labels → point-tap
  `50%,14%` then `inputText`.

**One difference, and it will cost you a run if you miss it:**

| App | After the 4th digit |
|---|---|
| `shoofi-app`, `shoofi-partner` | **auto-submits** — do not tap `تم` again |
| `shoofi-shoofir` | does **not** auto-submit — you must tap `تم` |

The driver app also shows a stale red `الكود غير صحيح` ("wrong code") under the
filled cells *before* you submit. It is left over from an earlier empty submit —
ignore it and tap `تم`. Verify the login by the server log
(`validateAuthCode -> 200`) and a `token` on the identity document, not by the
absence of that message.

A safe block for all three: enter the code, then tap `تم` **only if it is still
visible**.

```yaml
- inputText: "${TEST_CODE}"
- runFlow:
    when: { visible: "ادخل الكود" }
    commands:
      - tapOn: "تم"
```

## Ports and one-app-at-a-time

Metro binds `:8081` and only one app can hold it. Kill the previous one before
starting the next:

```bash
pkill -f "expo start"; pkill -f "expo run:ios"; lsof -ti:8081 | xargs kill -9
```

`expo run:ios --device <udid>` builds, installs **and** launches — but it has been
observed opening the dev-client URL on a *different* booted simulator than the one
it installed to. Verify with a screenshot and, if needed, launch explicitly:

```bash
xcrun simctl launch <udid> <bundleId>
```
