# The local stack

Mongo + `shoofi-server` on `:1111`, seeded well enough that an app can boot,
log in and place an order.

## Run the server

```bash
pgrep -l mongod || ~/mongodb/bin/mongod --config <your mongod.conf>   # Mongo first
cd shoofi-server
node -v            # must be 22.x — Node 20 dies on kdbush/turf ESM
npm run dev        # NODE_ENV=development node app.js, port 1111
```

`.env.development` points at `mongodb://127.0.0.1:27017`. `mongosh` ships with the
nvm Node 22 install; the server's own `mongod` binaries live in `~/mongodb/bin`.

Wait for it properly rather than sleeping:

```bash
until curl -s -o /dev/null -m 2 http://localhost:1111/api/... ; do sleep 1; done
```

**Benign at boot:** `Failed to subscribe to Redis channel: Stream isn't writeable`.
Redis connects a moment later. Ignore it.

### Three things not to do

- **Do not set `E2E_SANDBOX`, and do not start via `e2e/harness.js`** — the harness
  sets `E2E_SANDBOX=1`, which short-circuits every notification, i.e. exactly the
  thing you are usually trying to observe.
- **Do not flip `NODE_ENV=production` to get crons.** Crons need
  `NODE_ENV=production` **and** `ENABLE_CRONS=true`; turning them on starts ~15
  jobs including one that rewrites order statuses across every store database.
  In dev they are off, which also means **one-shot reminder crons never repeat** —
  don't wait for a second alert that will not come.
- **Do not curl-login while an app is logged in.** `validateAuthCode` rewrites the
  stored token on the identity document, and the app 401s on its next poll.

## Seed before you start the server

Several read paths index `req.app.db[appName]` **without lazy init** — notably
`POST /api/order/create`. If the store database was not known at boot you get a
generic `400 "Your order declined. Please try again"` with nothing pointing at the
real cause.

So: **write `shoofi.stores` first, then start (or restart) the server.** If the
server is already up, one `GET /api/menu` with that `app-name` warms it via
`getOrInitializeDb`, which mutates the same `req.app.db` object.

## Central prerequisites

`shoofi.store {id:1}` — one document, shared by everything:

| Field | Why |
|---|---|
| `credentials` | absent → order create 500s |
| `minVersionUpdate["<app-type>"]` e.g. `"1.0.0"` | absent → `/store/is-should-update` hangs the app on splash |
| `fraudConfig.enabled: false` | **default `maxOrdersPerHour` is 1**, so your *second* order silently becomes status `13` (FRAUD_REVIEW) and fires no alert. The env var `FRAUD_CHECKS_ENABLED` does **not** override a value present on the document. |

This is a **shared local document**. If you change `fraudConfig`, say so in your
report — it persists for whoever runs next on that machine.

`shoofi.stores` — one per store, and note the naming split:

- **central** `shoofi.stores` uses **snake_case** `name_ar` / `name_he`;
- **per-store** `<appName>.categories` / `.products` use **camelCase**
  `nameAR` / `nameHE`.

`routes/store.js` reads `nameHE`/`nameAR` off the central docs, which do not have
them — a known dead read; do not copy it.

`<appName>.store {id:1}` — one per store, and it **must carry `appName`**. If it is
undefined the cross-store banner claims the store you are already in has orders
waiting. If you set `openHours`, set **all seven days completely**: a partial or
`{}` value throws inside an uncaught async handler and the app hangs on the splash
screen. Omitting it entirely is fine.

`shoofi.translations` — 344 rows exist locally. Missing keys render as the **raw
key** (`select-store`, `code-sent-to`), which is ugly but stable, and actually
convenient for Maestro since raw keys are ASCII.

## Order status constants

From `consts/consts.js` — `PENDING` is **`"6"`**, not `"1"`:

```
IN_PROGRESS 1   COMPLETED 2   WAITING_FOR_DRIVER 3   CANCELLED 4   REJECTED 5
PENDING 6       CANCELLED_BY_ADMIN 7   ...   FRAUD_REVIEW 13   FUTURE_ORDER_PENDING 14
```

## Placing an order from the command line

`POST /api/order/create`, and the shape is unusual:

- headers `app-name: <store>`, `app-type: shoofi-shopping`,
  `Authorization: Token <jwt>`;
- the JWT is `jwt.sign({ id: "<customerId>", imp: true }, "secret")` — `imp: true`
  skips the stored-token equality check, so you don't have to keep a real session;
- the body is `{ body: JSON.stringify(order) }` — the route `JSON.parse`s
  `req.body.body`;
- `receipt_method: "TAKEAWAY"` needs no address and skips the distance fraud check;
- **never send `isSchoolProject`, `paymentData` or `applePayIntentId`** — each one
  silently skips the store-owner alert;
- there is a **10s creation lock** and a **30s duplicate window** per customer.

Working scripts live in `shoofi-server/scripts/`: `local-new-order.js`,
`local-accept-order.js`, `seed-cross-store-test.js`.

## Catalog seeding

Delegate the real shapes to `shoofi-domains:menu-catalog`. Two findings worth
carrying regardless:

- `products.supportedCategoryIds` is an array of **strings**. An ObjectId matches
  nothing, the category is then dropped by a `$size > 0` filter, and `GET /api/menu`
  returns `{menu: []}` with a **200 and no error**.
- `products.extras` must be an **array**. `{}` slips past the
  `!extrasDef || extrasDef.length === 0` guard in
  `shoofi-partner/components/shared/OrderExtrasDisplay.tsx` and red-boxes the whole
  partner new-orders screen with `extrasDef.reduce is not a function`.

Seeding straight into Mongo bypasses every cache-clear call, so flush the menu
cache afterwards (both keys — the route only clears the one you name):

```bash
curl -X POST http://localhost:1111/api/menu/clear-cache/<appName>
curl -X POST http://localhost:1111/api/menu/clear-cache/<appName>_schoolProject
```

## Verifying server-side before you touch the UI

Always do this first — it separates "the feature is broken" from "my flow is
broken", and it is seconds instead of minutes.

```bash
# does the identity authenticate?
curl -s -X POST http://localhost:1111/api/customer/validateAuthCode \
  -H 'Content-Type: application/json' -H 'app-name: shoofi' -H 'app-type: <type>' \
  -d '{"phone":"1234567890","authCode":"<code>"}'

# did the write actually land?
mongosh --quiet "mongodb://127.0.0.1:27017/shoofi" --eval '…'

# is the app even calling the endpoint, and what did it get?
grep '<route>' /tmp/shoofi-server.log | tail
```

That last one is the highest-value debugging move in this stack: the log records
every request with its `userAgent`, so you can tell an app poll (`ShoofiPartners/…`)
from your own curl and see the status it received.
