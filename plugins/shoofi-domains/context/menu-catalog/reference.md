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

### `menu-import-issues` — what a menu import could not bring in
`runId`, `fileName`, `phase`, `code`, `row`, `detail`, `reason`, `resolved`.
Written by `routes/admin/menu-import-issues.js`, read by the admin screen
"בעיות ייבוא תפריט". **`phase` is load-bearing:** `parse` means the file could
not express the row and nothing was written (fix the sheet, re-import), while
`import` means the write failed *after* the rest of the run went in — so
re-importing the whole file is the wrong remedy. `reason` is stored as text, not
derived from `code` at read time, and is editable by the operator. No TTL: it is
a worklist, not a diagnostic log. See `docs/menu-import-issues.md`.

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

**Pricing has three copies that must stay in lockstep** — `shoofi-app/stores/extras/index.ts`,
`shoofi-partner/stores/extras/index.ts`, and the server reference `utils/order-pricing.js`
(`calculateExtrasPrice(extras, selections, { soldByWeight })`, orders domain). The weight
extra prices as the **delta from `defaultValue`** (branch B) when the product is flagged or the
weight is the only non-header extra; otherwise as an **add-on with the first step bundled**
(branch A). Order creation charges the client total and shadow-compares it
(`utils/order-pricing-shadow.js` → `order.serverPricing`); the amend flow reprices server-side.
`store.outOfStockExtras` (in the menu response) lets clients grey out unavailable extras.

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
- `GET  /api/getTranslations`, `POST /api/translations/{update,add,delete}`
- `POST /api/global-search` — central store name search

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
