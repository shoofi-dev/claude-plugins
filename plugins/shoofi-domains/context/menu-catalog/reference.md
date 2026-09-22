# Menu / Catalog — Domain Context

> **Who you are:** You are the agent that owns the **menu / catalog** domain of
> `shoofi-server` (the Shoofi multi-tenant food-delivery backend). This document
> is your ground truth. Read it fully before touching catalog code. If reality
> contradicts this doc, trust the code and flag the drift — do not silently
> proceed on a stale assumption.

## 0. Scope — what you own, what you must not touch

**You own:** product/category/menu assembly and CRUD, catalog i18n, product
options/extras, availability & stock representation, and menu caching.

Primary files:
- `routes/menu.js` — customer menu assembly + cross-store search
- `routes/product.js` — admin/partner product CRUD, images, ordering, stock toggles
- `routes/category.js` — general (top-level) categories
- `routes/store.js` — regular (sub)category CRUD + stock-enable backfill (catalog slice only)
- `routes/translations.js` — catalog i18n labels
- `routes/global-search.js` — central store search
- `utils/menu-cache.js`, `utils/order-stock.js`, `utils/image-variants.js`
- Docs: `docs/stock-management.md`, `docs/menu-search.md`, `docs/explore-cache-invalidation.md`

**You must NOT touch without explicit human review** (per `CLAUDE.md` guardrails):
- Order creation / status transitions (`routes/order.js`), payments, auth.
- ⚠️ `utils/order-stock.js` is **shared with the order flow** — it's called from
  order confirm/cancel/reject. It lives in your domain for *stock semantics*, but
  edits here ripple into orders. Treat as a review boundary, not free territory.

**Collections you write are per-store and tenant-isolated — see §1. A wrong DB
selection leaks one store's catalog into another. This is the #1 way to cause harm here.**

## 1. Multi-tenant scoping (read this first, every time)

One MongoDB cluster, **one database per store**, plus central `shoofi` and
`delivery-company` DBs. The store is chosen by the `app-name` request header.

Canonical pattern (use this — do not hand-index `req.app.db[...]` in new code):
```js
const appName  = req.headers['app-name'];                      // store selector
const db       = await getOrInitializeDb(appName, req.app.db); // lib/db.js — lazy-loads store DB
const shoofiDb = req.app.db['shoofi'];                         // central registry
```
- `app-type` header = client identity: `shoofi-app`/`shoofi-shopping` (customer),
  `shoofi-partner` (partner), `shoofi-admin` (admin web). It gates hidden-product
  visibility and cache bypass (`menu.js`).
- **Intentional cross-store reads** (verify carefully, they touch other tenants'
  DBs on purpose): `/api/menu/search` (all stores), `/api/menu/mock` &
  create-from-mock (a mock store's DB), `store/copy-arabic-products` (source→dest).
- **Existing non-lazy access to be aware of:** `category.js`
  (`req.app.db[appName || 'shoofi']`) skips `getOrInitializeDb` and can 500 for a
  store DB not yet in memory. Prefer the canonical pattern for anything new.

## 2. Data model (per-store DB unless noted)

Accessors are defined in `services/database/DatabaseInitializationService.js`.

### `products`
- **i18n:** `nameAR`, `nameHE`, `descriptionAR`, `descriptionHE`,
  `notInStoreDescriptionAR`, `notInStoreDescriptionHE`
- **Pricing (DB):** `price`, `hasDiscount`, `discountQuantity`, `discountPrice`.
  ⚠️ The *displayed* `price`/`originalPrice`/`discountPercent` are **derived at
  read time** in `menu.js` from the category's `discountPercent` (max across the
  product's categories). The stored `price` is NOT the displayed price.
- **Categorization/order:** `supportedCategoryIds` (**array of strings** — many-to-many
  to categories), legacy `categoryId`/`subCategoryId`/`order`, and
  `categoryOrders` (map `{ [categoryId]: index }`, the current ordering source).
- **Availability/stock:** `isInStore`, `quantity`, `outOfStockByQuantity`,
  `outOfStoreUntil` (timed reopen), `isHidden` (catalog visibility).
- **Options:** `extras` (embedded, see §4), `others` (JSON blob).
- **Images:** `img` (array of `{ uri }`; size variants generated on upload).
- **Barcode/mock:** `barcode`, `barcodeId` (store-prefixed unique), `mockStoreAppName`,
  `mockProductId`, `mockType`.

### `categories` (regular subcategories)
`nameAR`, `nameHE`, `order`, `img[]`, `supportedGeneralCategoryIds` (array of
strings), `discountPercent` (**drives menu discounting**), `isSchoolProject`,
`isCampaign`, `isHidden`, `descriptionAR/HE`.

### `general-categories` (`db.generalCategories`, top-level groups)
`nameAR`, `nameHE`, `img`, `order`, `isSchoolProject`, `isHidden`. Enriched at
read with `subCategories` (the matching `categories`) — only when
`store.hasGeneralCategories` is true.

### `extras` — store-level reusable options catalog (distinct from a product's embedded `extras`).
### `store` (singleton `{id:1}`) — per-store config
Catalog-relevant flags: `isStockManagment` (the stock gate — **source of truth is
this per-store doc, NOT central `shoofi.stores`**), `hasGeneralCategories`,
`mockStoreAppName`, `outOfStockExtras` (surfaced in the menu response),
plus open/visibility flags.

⚠️ **`hasGeneralCategories` lives in TWO documents and they drift.** `GET /api/menu`
reads it from this per-store `store {id:1}` doc (`routes/menu.js`), but the admin
store form writes it to central `shoofi.stores`
(`POST /api/shoofiAdmin/store/update/:id`), and the propagation block in that
route copies `storeLogo`, `cover_sliders`, `externalOrderProvider`,
`isCityToCity` and `isDeliveryOnlySupport` — **not this flag**. So ticking the
checkbox makes the admin importer create general categories (it reads the
registry) while `/api/menu` keeps returning none. The copy-from-mock-store flow
escapes this by setting both documents explicitly. Same shape as the
`isDeliveryOnlySupport` bug fixed in shoofi-server PR #185.

### `menu-import-issues` — the operator worklist: what an import could not bring in, and what the catalog lint found
`runId`, `fileName`, `phase`, `code`, `row`, `detail`, `reason`, `resolved`, `resolvedAt`;
lint rows add `severity` (`critical` | `warning`), `productId`, `productName`, `extraId`,
`optionIndex` (null when the issue is on the extra), `resolvedBy` (`"lint"` | null),
`lastSeenAt`, `seenCount`, and for `BLOCKED_ADD_TO_CART` `users` / `events`.
Written by `routes/admin/menu-import-issues.js` (phases `parse` / `import`, one call per import
run) and by `services/catalog/catalog-lint.js` (phase `lint`); read by the admin screen
"בעיות ייבוא תפריט". **`phase` is load-bearing:**
`parse` = the file could not express the row, nothing written; `import` = the write failed
after the rest of the run went in; `lint` = the product IS in the catalog and is defective —
a re-import fixes nothing, the product needs editing (or the repair script). Lint rows are
**deduped on `(phase, code, productId, extraId, optionIndex)`** (index in
`DatabaseInitializationService.js`) and **never deleted by code**: a row that stops reproducing
is set `resolved: true, resolvedBy: "lint"`; one the lint closed re-opens if the defect
returns; one a HUMAN ticked stays ticked (the tick means "acknowledged" — otherwise a
BLOCKED row would re-open every night for the 7-day window after the fix). `reason` is
stored text, not derived from `code` at read time — the operator can edit it; for lint rows
it starts as the Hebrew from `LINT_REASON` in `utils/catalog-lint.js`. `detail` is
`<productId>/<extraId>[/<optionIndex>] <product nameAR>`. No TTL: it is a worklist, not a
diagnostic log. See `docs/menu-import-issues.md`.

**Names on a lint row (shoofi-server #219).** The admin extras editor shows **group** and **option**
names, never extra ids, and a grouped member's own `nameAR`/`nameHE` is usually `""` (the name is on
its header) — so every `phase: "lint"` row also carries, re-written on every run that sees it:

| Field | Meaning |
|---|---|
| `categoryName` | `supportedCategoryIds[0]` (else first `categoryOrders` key) resolved against the store's `categories` (`nameHE` else `nameAR`), one read per store per run (`readCategoryNames`); `""` when none |
| `extraName` | the extra's own `nameHE`/`nameAR`, else its `groupName`, else `""` — never an id |
| `groupName` | the header's name for the extra's `groupId`; `""` when ungrouped/headerless |
| `optionName` | option-level rows only; `""` otherwise |

The Hebrew `reason` quotes these (`בתוספת "…"` / `בקבוצה "…"` / `אפשרות "…"`, `אפשרות מס' N` when
unnamed) and prints no ids — except `ORPHAN_GROUP_MEMBER`, which keeps `(groupId …)` because there is
no header to name. `extraId`, `detail` and the dedupe key are unchanged. `BLOCKED_ADD_TO_CART` rows
take `extraName`/`productName` from the app event (Arabic), `groupName`/`optionName` are `""`.
Resolution: `utils/catalog-lint.js` (`displayName`), copied by `toLintRow`; the write boundary passes
the product's category ids so its rows get `categoryName` too.

### `translations` — i18n labels: `{ key, ar, he }`.
### `images` — auxiliary image library: `{ data:{uri}, type, subType }`.
### central `shoofi.stores` — store registry (used by cross-store search & `initDb`).

## 3. Category → product hierarchy & ordering
Two levels: `general-categories` → `categories` (linked by
`category.supportedGeneralCategoryIds`) → `products` (linked by
`product.supportedCategoryIds`, many-to-many). **Ordering:** categories by
`order`; products by `categoryOrders[categoryId]`, falling back to legacy `order`.
Reorder endpoints: `product.js` (`update/order`, `order-per-category`,
`bulk-reorder`, `reset-order`, `migrate-orders`) and `store.js`
(`store-category/update-order`, `category/general/update-order`).

## 4. Product options / extras / pricing
A product's `extras` is an **array** of extras (stored verbatim from `JSON.parse(req.body.extras)`;
shape not enforced on write). Every extra has `{ id, type, nameAR, nameHE, order?, groupId?,
isGroupHeader?, freeCount? }`; group headers (`isGroupHeader:true`) are pseudo-extras that only
title a group and carry `freeCount`. Real types:
- `single` — `options[{id,nameAR,nameHE,price}]`, `defaultOptionId`
- `multi` — `options[]`, `maxCount`, `defaultOptionIds[]`
- `counter` — `min,max,step,defaultValue,price` (price × value)
- `weight` — `min,max,step,defaultValue,price,unit?:"g"|"kg"`; `price` is the price of ONE
  `step`; `defaultValue` is the weight the product price already buys. The customer's choice
  travels as `selectedExtras[extra.id] = <number in the extra's unit>`.
- `pizza-topping` — `options[{ price?, areaOptions[{id,name,price}] }]`. Two traps, both
  verified against `utils/order-pricing.js` and the three order viewers:
  - **`areaOptions[].id` must be exactly `full` / `half1` / `half2`, and all three must be
    present on every option.** The selection travels as
    `selectedExtras[extra.id] = { [toppingId]: { areaId, isFree } }`, and every viewer looks
    the area up by the id the *customer* chose and then does an unguarded `switch (area.id)`
    to pick an icon — the customer's order card, the partner's order card, and
    `InvoiceOrderExtrasDisplay` (the **printed kitchen ticket**). A missing or invented area
    throws while rendering an order that has already been paid for.
  - **`areaOptions[].price` of 0 falls through to the option-level `price`.** The pricer tests
    `if (area && area.price)`, so a zero-priced area drops to the `else if (topping.price)`
    branch — an area meant to be free charges the option price instead. The admin editor
    writes `price: 0` at option level for this type, which is what keeps it harmless.

**Lint rules** (`utils/catalog-lint.js` `lintProduct(product, { outOfStockExtras })`), one
row per hit, in the customer's terms — `critical` = cannot buy / a viewer throws, `warning` =
works but not as configured. What each outcome means at the write boundary is CORE invariant 9;
the nightly run is §7b:

| code | severity | fires when | at the write boundary |
|---|---|---|---|
| `EMPTY_OPTION_ID` | critical | `options[].id` missing / null / `""`, any type | repaired (the #205 planner) |
| `DUPLICATE_OPTION_ID` | critical | same id twice in one extra | repaired: later duplicate re-id'd |
| `SINGLE_WITHOUT_OPTIONS` | critical | non-header `single` with no options | **refused** |
| `ORPHAN_GROUP_MEMBER` | warning | `groupId` with no `isGroupHeader` extra carrying it | saved + recorded |
| `DEFAULT_NOT_IN_OPTIONS` | warning | `defaultOptionId` / a `defaultOptionIds` entry matching no option (after the id repairs) | repaired: dropped |
| `PIZZA_AREA_VOCAB` | critical | a `pizza-topping` option whose `areaOptions[].id` list is not exactly `full`,`half1`,`half2` (missing, invented, duplicated, or no array) | **refused** |
| `MAX_COUNT_INVALID` | warning | `multi` with `maxCount` present and not `>= 1` | saved + recorded |
| `WEIGHT_PRICE_INVARIANT` | warning | `normalizeWeightExtraPrice` would correct the weight extra | never fires there (normalized first); cron reports |
| `REQUIRED_GROUP_ALL_OUT_OF_STOCK` | critical | non-header `single` with ≥1 option and every option's `nameAR` in `store.outOfStockExtras` | saved + recorded |
| `BLOCKED_ADD_TO_CART` | critical | cron only: ≥ `CATALOG_LINT_BLOCKED_MIN_USERS` (default 3) distinct customers hit `add_to_cart_blocked` on the same store/product/extra in 7 days | — |

`planProduct` (the empty-id planner) lives in `utils/catalog-lint.js`;
`scripts/fix-empty-extra-option-ids.js` re-exports it, so the script, the write boundary and
the cron cannot disagree about what "empty" means or what to write.

**Data quality — empty option ids.** Until 2025-06-13 (delivery-web 241fee0) the admin
`ExtraEditModal` seeded a new extra's first option with `id: ""`, and marking it default wrote
`defaultOptionId: ""` / `defaultOptionIds: [""]`. Product duplication (`views/admin/product.tsx
handleDuplicate`) and `POST /api/product/create-from-mock` copy extras verbatim, so the defect
outlives the fix, and the inherited editor in `shoofi-app/components/admin/ExtraEditModal.tsx`
still seeds `id: ""`. A `""` selection reads as "not answered" in the customer app (add-to-cart
blocked on a required group) and is dropped by the partner's `OrderExtrasDisplay` (kitchen ticket
omits the choice). Since shoofi-server #206 the write boundary repairs it in place
(`EMPTY_OPTION_ID`, the same planner — table above) and the nightly lint reports what is still
in the catalog; for that backlog, `scripts/fix-empty-extra-option-ids.js` (dry-run by default;
`--apply` writes with a compare-and-set on the extras array and clears both menu-cache keys when
Redis is reachable); the customer app also assigns `<extraId>-opt-<index>` inside its own product
copy as a guard (`shoofi-app/helpers/extras-normalize.ts`). Any bulk tool writing extras must emit
a non-empty `options[].id`; `areaOptions[].id` is a fixed vocabulary and is out of that script's
scope.

⚠️ **`freeCount` is honoured twice — `freeCount: N` gives away up to 2N toppings.** The
client stamps `isFree: true` on the first N toppings it sees selected and sends that on the
selection; `calculateExtrasPrice` then skips the charge for an `isFree` topping **without
decrementing its own `remainingFreeCount`** (the decrement sits inside `if (!isFree)`), so the
counter gives away N more. The three pricers agree with each other, so the shadow-pricing
drift alarm stays silent and the customer is charged exactly what they were shown — this is a
store-revenue leak, not a client/server disagreement. Not yet fixed: it is a shared change
across `shoofi-server`, `shoofi-app` and `shoofi-partner` and needs its own PR. **Any bulk
tool writing extras should emit `freeCount: 0`** until it is.

**By-weight products** carry `product.soldByWeight: true` (whitelisted on create/update/
create-from-mock, projected by every menu `$project`). The flag chooses the client UI (per-kg
label, weight stepper instead of an extras row) and the pricing branch; storage does not change.
Invariant 7 in CORE.md binds `product.price` to the weight extra. Existing products are
opted in by `scripts/flag-sold-by-weight.js`; see `docs/sold-by-weight.md`.

**Which extras are mandatory (customer app).** `required` is a **dead field**: neither the admin
nor the partner `ExtraEditModal` writes it, the server stores extras verbatim, and 0 of ~3.7k
prod extras carried it on 2026-09-21. The only rule in effect is `extrasStore.validateWith`
(`shoofi-app/stores/extras/index.ts`): **every non-header `single` is mandatory, nothing else
is** — `multi`/`counter`/`pizza-topping`/`weight` never block add-to-cart, and a `single` with
`defaultOptionId` is pre-seeded on mount so only default-less singles ever do. The product
screen mirrors the same predicate in `shoofi-app/helpers/extras-groups.ts` (`isMandatoryExtra`,
unit-tested) to label groups "required / optional" and to list **mandatory groups first**,
each set in header `order`; keep it in lockstep with `validateWith` — and with the lint, whose
`SINGLE_WITHOUT_OPTIONS` / `REQUIRED_GROUP_ALL_OUT_OF_STOCK` are `critical` precisely because
this predicate leaves the add-to-cart button disabled forever. The partner app enforces
nothing (`isValidForm={true}`), and order creation does not re-validate extras (see the recorded
risk below). Making `required` real is a full-stack change: both editors → server passthrough →
both validators → this doc.

**Pricing has three copies that must stay in lockstep** — `shoofi-app/stores/extras/index.ts`,
`shoofi-partner/stores/extras/index.ts`, and the server reference `utils/order-pricing.js`
(`calculateExtrasPrice(extras, selections, { soldByWeight })`, orders domain). The weight
extra prices as the **delta from `defaultValue`** (branch B) when the product is flagged or the
weight is the only non-header extra; otherwise as an **add-on with the first step bundled**
(branch A). Order creation charges the client total and shadow-compares it
(`utils/order-pricing-shadow.js` → `order.serverPricing`); the amend flow reprices server-side.
`store.outOfStockExtras` (in the menu response) lets clients grey out unavailable extras —
matched by option `nameAR`, exactly, no trim (`menuStore.outOfStockExtras.includes(opt.nameAR)`
in RadioGroup / CheckboxGroup / PizzaToppingGroup); a renamed option silently comes back in stock.

> ⚠️ **Recorded risk (confirmed, out of your scope to fix):** creation still trusts the
> client-sent total; a modified client could submit a fake price and it would only be
> *recorded* as drift. Making creation server-authoritative belongs in the order-create path
> (`routes/order.js`), a human-review boundary — NOT menu-agent territory.

## 5. Availability & stock
Three interacting product fields — keep them consistent:
- `isInStore` — availability (manual toggle or auto)
- `quantity` — stock count
- `outOfStockByQuantity` — distinguishes quantity-driven auto-disable from a manual `isInStore:false`
- plus `outOfStoreUntil` (timed reopen) and `isHidden` (visibility)

**Invariant for stock-managed stores** (`store.isStockManagment === true`) —
**human-confirmed, applies to ALL products, no exceptions:**
`quantity <= 0  ⟺  { isInStore:false, outOfStockByQuantity:true }`.
Enforced at: product edit (`product.js`), set-quantity
(`product.js`), enable-stock backfill (`store.js`), and the
order lifecycle via `utils/order-stock.js` (`decrementOrderStock` /
`restoreOrderStock` — idempotent via `stockDecremented`/`stockRestored`; restore
only re-enables products that were `outOfStockByQuantity`, never un-hides manual
disables). Enabling stock management takes the whole catalog out of stock until
real quantities are entered. Details: `docs/stock-management.md`.

## 6. Caching — the easiest thing to get wrong
`utils/menu-cache.js` = `MenuCache` singleton (Redis or in-memory Map, 5-min TTL,
keys `menu:${storeId}`). Menu cache is **customer-only** — `shoofi-partner` /
`shoofi-admin` bypass it (so hidden products never leak to customers; don't add
caching to admin paths).

**RULE: any write that changes menu output MUST clear BOTH cache keys:**
```js
menuCache.clearStore(appName);
menuCache.clearStore(`${appName}_schoolProject`);   // school-project menus are a separate filtered view
```
Missing this serves a stale menu for up to 5 minutes. Most product write
endpoints also emit a websocket `menu_refresh` (`shoofi-shopping`) /
`product_updated` (`shoofi-partner`) and re-run indexing.

## 7. Key endpoints (quick reference)
- `GET  /api/menu` — **the** customer menu fetch (assembly + discount + optional general-categories). **Source of truth.**
- `POST /api/menu/search` — cross-store product/store search (regex on `nameAR/nameHE`, geo via `delivery-company.cities`). See `docs/menu-search.md`.
- `GET  /api/menu/mock` — template/mock store menu (dedup vs current store).
- `POST /api/menu/clear-cache[/:storeId]`, `GET /api/menu/cache-stats`
- `POST /api/admin/product/insert | update | delete` — product CRUD (partial update)
- `POST /api/admin/product/update/{isInStore,quantity,isHidden,isInStore/byCategory,activeTastes}` — availability/stock/visibility
- `POST /api/admin/product/{update/order,order-per-category,bulk-reorder,reset-order/:cat,migrate-orders}` — ordering
- `GET  /api/admin/product/extras`, `GET /api/admin/product/:id`, `POST /api/admin/images/upload`
- `POST /api/product/create-from-mock`, `GET /api/product/mock-store/:appName`, `POST /api/product/update-barcode`
- `GET/POST/DELETE /api/store-category/*` — regular subcategory CRUD (in `store.js`)
- `GET/POST/DELETE /api/category/general/*` — general category CRUD
- `POST /api/admin/menu-import-issues` — record one import run's issues (whole run, one call)
- `GET  /api/admin/menu-import-issues?status=open|resolved|all[&runId=]` — the store's worklist
- `POST /api/admin/menu-import-issues/:id` — edit `reason` / tick `resolved` (writes only the keys it receives)
- `DELETE /api/admin/menu-import-issues/:id`
- `GET  /api/admin/catalog-lint/summary` — open lint rows per store by severity (`{ totals, stores[] }`), admin token
- `POST /api/admin/catalog-lint/run` — `{ appName }` for one store, else every store; admin token; returns the run stats
- `GET  /api/getTranslations`, `POST /api/translations/{update,add,delete}`
- `POST /api/global-search` — central store name search

## 7b. Nightly catalog lint — the cron and the app event contract
`utils/crons/catalog-lint-cron.js` — `30 4 * * *` Asia/Jerusalem, registered in `app.js` inside
the `shouldRunCrons` block (`NODE_ENV=production && ENABLE_CRONS=true`), under the Redis lock
`cron:catalog-lint` (60-min TTL). `services/catalog/catalog-lint.js lintAllStores(app.db)`:
one `apps-logs` aggregate for the BLOCKED rule, then per store `lintStore` → every product
through `lintProduct` (+ `store.outOfStockExtras`) → `syncLintRows` (upsert on the dedupe key,
auto-resolve what no longer reproduces). **Reports only — never writes a product.** If the
`apps-logs` aggregate fails, the catalog rules still run and existing BLOCKED rows are left
open rather than resolved on no evidence. One store failing is logged and the run continues.
`POST /api/admin/catalog-lint/run` is the same code path on demand (§7).

**The app event contract** (customer app `trackEvent("add_to_cart_blocked", {...})`):
`POST /api/app-logs/insert` stores the body verbatim as
`{ event_type, app_type, created: Date, userId, user_visit_id, properties }`, so the cron reads
`properties.storeDBName`, `properties.productId`, `properties.extraId`, `properties.productName`,
`properties.extraName`; a customer is `userId`, falling back to `user_visit_id` (device) when
logged out. Rename a property in the app and the BLOCKED rule silently finds nothing.

## 8. Cross-repo consumers (inferred from endpoint surface — not verified against client repos)
- **Customer app** (`shoofi-app`/`shoofi-shopping`): `GET /api/menu`, `/api/menu/mock`, `/api/menu/search`, `/api/category/general/all`, `/api/getTranslations`, `/api/global-search`; listens for `menu_refresh`.
- **Partner app** (`shoofi-partner`): product write + ordering endpoints; sends `app-type: shoofi-partner` to see hidden products; listens for `product_updated`.
- **Admin web** (`shoofi-delivery-web`/`shoofi-admin`): category CRUD, product ordering/migration, translations CRUD, stock screen (`update/quantity`), store config toggles (`isStockManagment`, `hasGeneralCategories`).

## 9. Known status (human-confirmed) — what's a bug vs. by-design
Each item below was reviewed with the product owner. Respect these verdicts.

- **CONFIRMED BUG — `update/isInStore/byCategory` cache-clear is commented out**
  (`product.js`) → stale menus after a bulk category toggle. Fix: restore
  both `clearStore(appName)` and `clearStore(\`${appName}_schoolProject\`)`. (Backlog #1.)
- **CONFIRMED BUG — `GET /api/menu` vs `POST /api/menu/refresh` diverge.**
  `refresh` is a *real, admin-triggered* action ("Refresh Menu Cache", audited)
  that re-caches under the same key `GET /api/menu` reads — but builds a
  different payload (`id.$oid` general-category matcher `menu.js`; omits
  `outOfStockExtras`/`supportedGeneralCategoryIds`), so clicking Refresh degrades
  the live menu for up to the 5-min TTL. Fix: **extract one shared menu-builder
  function** both endpoints call so they can't drift. (Backlog #2.)
- **CONFIRMED DEAD — remove `lib/indexing.js`.** The lunr index targets
  non-existent fields (`productTitle/productTags/productDescription`, expressCart
  legacy) → indexes nothing, yet runs on every product write. Real search is the
  regex in `/api/menu/search`. Fix: remove `lib/indexing.js` and its `indexProducts`
  call sites in `product.js`. (Backlog #3 — touches product-write paths, test after.)
- **BY DESIGN — do NOT change:** `translations.js` reads a header literally
  named `shoofi` because **translations are global/platform-wide by design**, not
  per-store. This is intentional; leave it. (Do not "fix" it to `app-name`.)
- **FACT (not a bug) — `supportedCategoryIds` are strings**, compared via
  `{$toString:'$_id'}` (`menu.js`). Don't switch to ObjectId comparison
  without a data migration.

## 9b. Menu agent — initial backlog (human-confirmed, safe to act on)
In priority order. #1–#2 are pure menu-domain. #3 touches product-write paths, so
run `npm run lint` + relevant tests after. Confirm the cross-repo/order-flow
risk item stays untouched.
1. Restore the commented-out cache-clear in `update/isInStore/byCategory`.
2. Extract a single shared menu-builder used by both `GET /api/menu` and
   `POST /api/menu/refresh`; delete the divergent `refresh` logic.
3. Remove the dead `lib/indexing.js` and its call sites.
- **Recorded risk, do NOT act (human-review boundary):** server trusts
  client-sent extras prices (§4). Any fix lives in the order-create path, not here.

## 10. Legacy — ignore (per `CLAUDE.md`)
`views/`, server-rendered admin pages, `lib/cart.js` (session cart; live orders go
through `/api/order/create`), Stripe/PayPal flows, and the `db.menu`/`db.variants`
collections (declared but unused). The active catalog uses
`products` / `categories` / `general-categories`.
