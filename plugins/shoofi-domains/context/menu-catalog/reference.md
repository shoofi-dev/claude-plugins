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
- `utils/combo-validation.js`, `services/menu/combo-snapshots.js`, `utils/client-features.js`
  — combo deals: the product kind at the write boundary, the menu snapshot + old-client
  strip, and the capability header (§2, §4, §6, §6b)
- `services/ordering-intelligence/` (+ `routes/for-you.js`, `utils/crons/suggest-index-cron.js`,
  `bin/build-suggest-index.js`) — the "For you" suggestion index, dish types and the live
  re-check (§2 `suggestProductIndex`, §7, §7c); plus the dish labelling —
  `taxonomy.js`, `product-labeler.js`, `craving.js`, `routes/admin/dish-taxonomy.js`,
  `utils/crons/product-labels-cron.js`, `bin/label-products.js` (§2 `dishTaxonomy` /
  `productLabels` / `productLabelRuns`, §7, §7d)
- Docs: `docs/stock-management.md`, `docs/menu-search.md`, `docs/explore-cache-invalidation.md`,
  `docs/combo-deals.md`, `docs/for-you.md`

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
- **Kind / combo (`docs/combo-deals.md`):** `productType` (`"combo"`; absent / `""` /
  `"regular"` are regular) and `combo: { sections[{ id, nameAR, nameHE, order, count,
  options[{ productId, surcharge }] }] }` — string `_id`s of products in the SAME store,
  normalised to exactly these fields on every write (CORE invariant 10). `price` is the fixed
  bundle price (category `discountPercent` applies like any product); `extras` are optional
  combo-level extras priced like today's. Never stores a component snapshot — `option.product`
  is added at read time (§6). Phase 1: never `soldByWeight`, no nested combos, `price > 0`.
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

### `extras` — declared in `DatabaseInitializationService.js`, **unused**: nothing in the server reads or writes it. Every option lives embedded in its product's `extras` array (§4); delivery-web's `ExtraGroup` is editor-side only.
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

### central `shoofi.suggestProductIndex` — the "For you" candidate index (derived, disposable)
One document per suggestible product of every food-service store (CORE invariant 11):
`{ appName, productId (string), nameAR, nameHE, nameNorm, categoryNames[], dishType|null,
dishTypeSource (claude|admin|rules|null), course, sweet, spicy, vegetarian, light, protein,
searchTermsNorm[], price, img|null, qty30d, orders30d, storeOrders30d, builtAt }`. Indexes
(created by the builder, not by `DatabaseInitializationService`): `{ appName:1, productId:1 }`
unique, `{ appName:1, dishType:1 }`, `{ appName:1, searchTermsNorm:1 }`. Written ONLY by `buildSuggestIndex`
(`services/ordering-intelligence/index-builder.js`): per store, `bulkWrite` of `replaceOne`
upserts, then `deleteMany({ appName, builtAt: { $ne: builtAt } })`; at the end,
`deleteMany({ appName: { $nin: kept } })`.

How each field is derived — read this before trusting one:
- **Store selection:** `shoofi.stores` `{ appName exists, business_visible != false }`, kept when
  one of `store.categoryIds` is a central `shoofi.categories` doc (non-school-project) whose
  normalised `nameHE`/`nameAR` is in `FOOD_SERVICE_CATEGORY_NAMES`. Per store DB via the
  injected `dbFor` = `getOrInitializeDb(appName, appDb)`.
- **Product selection:** `products.find({ isHidden: {$ne:true}, productType: {$ne:"combo"} })`;
  categories = `supportedCategoryIds` only (no `categoryId` fallback — `/api/menu` never reads
  it), resolved against the store's `categories` (projected `nameAR, nameHE, isSchoolProject,
  isHidden, discountPercent`) with hidden categories dropped; skipped when none remain or all
  that remain are `isSchoolProject === true`.
- `categoryNames` = both-language names of those categories; `nameNorm` =
  `normalizeSearchText(nameAR + " " + nameHE)`.
- **Labels:** per store, `shoofi.productLabels.find({ appName, status: { $in: ["applied",
  "admin"] } })`. With a trusted label: `dishType` = the label's (may be null),
  `dishTypeSource` = `admin` for an admin label else `claude`, the six attribute fields and
  `searchTermsNorm` copied from it. Without one: rules below, `dishTypeSource: "rules"` (or null
  when the rules find nothing), attributes `null`, `searchTermsNorm: []`. The build first
  force-reloads the active taxonomy (`loadActiveDishTypes`), so approved types' words classify.
- rules `dishType` = `classifyProduct` (`dish-types.js`): earliest keyword hit in `nameAR`, then
  `nameHE`, then category names. Single-word keywords match as word PREFIXES (plurals), also
  after stripping `ال`/`אל` and one glued Hebrew prefix letter (`הובלמשכ`); keywords shorter
  than 3 chars after normalisation are dropped (so `דג` alone never matches). Keys: burger,
  shawarma, tortilla, mexican, pizza, falafel, schnitzel, sushi, grill, fried_chicken, pasta,
  asian, fish, hummus, breakfast, sandwich, salad, and `meal:false` dessert, drink, side — the
  SEED list; the live list is `shoofi.dishTaxonomy` `status: "active"` (below), swapped in with
  `setDishTypes`. A keyword written `=word` matches a whole word only (`=קרפ` so carpaccio is not
  a crêpe).
- `price` = `product.price` coerced to a number, then `applyProductDiscount` with a map built
  from the store's non-hidden, non-school-project categories (the same set `/api/menu` prices
  against) — the displayed price at build time, a ranking hint only; `img` = `img[0].uri`.
- `qty30d` / `orders30d` / `storeOrders30d`: the store's `orders` with `COMPLETED_STATUSES`,
  `created >=` an Israel-offset STRING 30 days back, `isSchoolProject != true`, grouped on
  `order.items.item_id` (a string) — the same rules as `services/menu/best-sellers.js`,
  including `$toInt` on `qty`.

**Reading it:** `suggestForCustomer` (`suggest-service.js`) runs ONE `find` on it, scoped to the
open stores' `appName`s and an `$or` of what the mode can use, ranks in memory, then
`applyLiveMenu` re-reads the winners from each store's `products` (projection `nameAR, nameHE,
price, img[0], isHidden, isInStore, productType, supportedCategoryIds`) and, in parallel, the
store's `categories` with `{ isHidden: {$ne:true}, isSchoolProject: {$ne:true} }` (projection
`discountPercent`). A row survives only if it exists, is not hidden, is not a combo, has at least
one of its `supportedCategoryIds` among those visible categories, has `isInStore === true`, and a
discounted `price > 0`. The card takes that discounted `price` (plus `originalPrice` /
`discountPercent` when a discount applies) — CORE invariant 3 — and the live names and image.

### central `shoofi.dishTaxonomy` — the dish-type list as data (CORE invariant 12)
`{ _id: key, key, label_ar, label_he, meal, words[], status: "active"|"proposed"|"rejected",
source: "seed"|"claude"|"admin", productCount, storeCount, examples[{appName, productId, nameAR,
nameHE}], firstSeenAt, updatedAt, reviewedAt, reviewedBy }`. `ensureSeeded` upserts every seed
type with **`$setOnInsert` only** (runs inside `loadActiveDishTypes`, so on first read and every
10-min refresh — cheap, never overwrites). Proposed rows are written by `refreshProposals` in
`product-labeler.js` (only when `≥ PROPOSAL_MIN_PRODUCTS` labels carry the same
`proposedType.key`, and never over an existing non-proposed row); the same function deletes
`status: "proposed", source: "claude"` rows whose key fewer than 3 current labels still carry.
Before counting it merges duplicates: `proposalAliases(labelDocs)` (pure) unions proposal keys
whose normalised `label_he` or `label_ar` match and maps each alias to the key carried by the most
products (ties: alphabetical); the aliased labels' `proposedType` is rewritten to the canonical one.
Production 2026-09-28 merged samboosek/sambousek, burekas/boureka, kubbeh/kibbeh.
`parseLabels(text, activeKeys, proposedTypes)` maps a pending proposal's key — found in either
`dishType` or `proposedType` of a reply row — onto the stored proposal, so labels keep one key. Approve / reject / patch via the
admin endpoints (§7); approve and patch force-reload the classifier on that instance, other
instances pick it up within 10 min.

### central `shoofi.productLabels` — Claude's per-product labels (CORE invariant 12)
`{ appName, productId, nameAR, nameHE, contentHash, dishType, proposedType?, course, sweet, spicy,
vegetarian, light, protein, searchTerms[], searchTermsNorm[], confidence, rulesDishType,
fromApprovedProposal,
status: "applied"|"review"|"admin", model, runId, labeledAt, reviewedBy?, reviewedAt? }`. Indexes:
`{appName, productId}` unique, `{status}`, `{"proposedType.key"}`. Product source is
`storeProducts`: non-hidden, non-combo products in at least one non-hidden, non-school category
(the same set the index uses). `course` ∈ main/side/drink/dessert/snack/sauce/other; `protein` ∈
chicken/beef/lamb/fish/seafood/cheese/egg/none/mixed. `decideStatus(label, rulesDishType)` and
the `contentHash` relabel rule: CORE invariant 12. Readers: `index-builder.js` (trusted only),
`GET /api/admin/product-labels/review` (`status: "review"`).

### central `shoofi.productLabelRuns` — one document per labelling run
`{ startedAt, finishedAt, status: "running"|"done"|"failed", model, error?, stores, products,
pending, labeled, applied, review, calls, errors, inputTokens, outputTokens, proposals }`. Dry runs
write none. Read by `GET /api/admin/product-labels/runs` (the admin page's cost history).

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

**Combo lines price as ONE item** — `calculateComboExtrasPrice(comboProduct, item, components)`
(`utils/order-pricing.js`, orders domain; client copies `shoofi-app/helpers/combo-pricing.ts`
and its `shoofi-partner` twin) sums, per pick in `item.comboSelections`, the **catalog**
`option.surcharge` (never the `surcharge` the client wrote on the selection) plus
`calculateExtrasPrice` over the **component's** own `extras` definition against
`sel.selectedExtras`, plus any combo-level extras. That sum X takes the place of a plain
product's extras and rounds the same way:
`price = discounted(combo.price) + (d > 0 ? Math.round(X × (1 − d/100)) : X)`. The pricer
loads every `item_id` ∪ every `comboSelections[].productId` in one find. The "you save ₪N"
a customer sees (Σ component card prices − bundle price) is client display only and never
reaches the server. Orders CORE invariant 12 has the issue codes and the amend rule.

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

**Combo snapshots and the capability header sit on opposite sides of the cache.**
`resolveComboSnapshots` (`services/menu/combo-snapshots.js`) runs BEFORE `menuCache.set` in
both `GET /api/menu` and `POST /api/menu/refresh`, so a cached menu is always complete — one
`products.find` over every component of every combo, `isHidden` ignored, each snapshot
through `applyProductDiscount`, a deleted component → `product: null` + warning. `stripCombos`
runs AFTER the cache read (`stripCombos(cachedMenu)`) for a customer without
`x-client-features: combo` (§6b), never mutates the cached object, and drops a category /
general-category subcategory that held ONLY combos. The cache is keyed by store (+
`_schoolProject`), never by capability. A component hitting 0 stock disables the component
only: `notifyMenuRefresh` clears both keys, the snapshot carries `isInStore`, the app hides
that option (`docs/stock-management.md`).

*Pre-existing divergence, harmless — do not "fix" it in a combo PR:* the menu's
`categoryDiscountMap` is built from `menuAggregation`, the **filtered** category list (hidden /
school-project matches already applied), while `loadPricedProducts` (`utils/order-pricing.js`)
builds its map from **all** `categories`. A component's snapshot `price` can therefore differ
from what the pricer would derive for the same product, but nothing depends on it: pricing
never reads a component's price — only `option.surcharge` and the component's `extras`.

## 6b. Client capability header — `x-client-features`
`utils/client-features.js`: `HEADER = "x-client-features"`, `parseClientFeatures` (a
comma-separated list, trimmed and lower-cased), `hasClientFeature(req, 'combo')`. The customer
app sends it from the **same JS bundle** that renders the feature — that is the whole reason
it exists: `app-version` is the native binary version and does not move with an OTA
(`eas update`), so it cannot say whether the running JS understands a new menu shape; this
header can. Used ONLY to shape customer responses for old bundles: `GET /api/menu` and
`POST /api/menu/refresh` (`canSeeCombos = isAdminApp || hasClientFeature(req, 'combo')`, decided
per request AFTER the cache read) and `POST /api/menu/search` (`productType: { $ne: 'combo' }`
without it, and `productType` projected). It never gates admin/partner surfaces, never keys
the cache, and needs no CORS change (`cors()` reflects `Access-Control-Request-Headers`).
Adding the next feature: append its token to the list, add its strip, keep the strip after
the cache read.

## 7. Key endpoints (quick reference)
- `GET  /api/menu` — **the** customer menu fetch (assembly + discount + optional general-categories + combo snapshots). **Source of truth.** Combos reach a customer only with `x-client-features: combo` (§6b).
- `POST /api/menu/search` — cross-store product/store search (regex on `nameAR/nameHE`, geo via `delivery-company.cities`). See `docs/menu-search.md`.
- `GET  /api/menu/mock` — template/mock store menu (dedup vs current store); never offers a combo.
- `POST /api/menu/clear-cache[/:storeId]`, `GET /api/menu/cache-stats`
- `POST /api/admin/product/insert | update | delete` — product CRUD (partial update). Insert/update run the combo validation chain (`400 COMBO_INVALID`); delete is `409 PRODUCT_REFERENCED_BY_COMBO` when a combo still points at a requested product (CORE invariant 10).
- `POST /api/admin/product/update/{isInStore,quantity,isHidden,isInStore/byCategory,activeTastes}` — availability/stock/visibility
- `POST /api/admin/product/{update/order,order-per-category,bulk-reorder,reset-order/:cat,migrate-orders}` — ordering
- `GET  /api/admin/product/extras`, `GET /api/admin/product/:id`, `POST /api/admin/images/upload`
- `POST /api/product/create-from-mock` (`400 COMBO_NOT_CLONEABLE` for a combo template), `GET /api/product/mock-store/:appName`, `POST /api/product/update-barcode`
- `GET/POST/DELETE /api/store-category/*` — regular subcategory CRUD (in `store.js`)
- `GET/POST/DELETE /api/category/general/*` — general category CRUD
- `POST /api/admin/menu-import-issues` — record one import run's issues (whole run, one call)
- `GET  /api/admin/menu-import-issues?status=open|resolved|all[&runId=]` — the store's worklist
- `POST /api/admin/menu-import-issues/:id` — edit `reason` / tick `resolved` (writes only the keys it receives)
- `DELETE /api/admin/menu-import-issues/:id`
- `GET  /api/admin/catalog-lint/summary` — open lint rows per store by severity (`{ totals, stores[] }`), admin token
- `POST /api/admin/catalog-lint/run` — `{ appName }` for one store, else every store; admin token; returns the run stats
- Menu spellcheck (`routes/admin/menu-spellcheck.js`; `auth.required` + `checkAdminRole(["master","admin","manager"])`, POSTs in the audit route map): `GET /api/admin/menu-spellcheck/issues?status=open|accepted|dismissed|resolved|stale&appName=&lang=ar|he` → `{ issues (≤2000), truncated, counts, lastRun }`; `POST /api/admin/menu-spellcheck/run [{ appName }]` → `202 { started, runId }` / `409 locked` / `503 no-api-key`; `POST /api/admin/menu-spellcheck/accept { ids, fixes? }` → `{ accepted, stale, failed, outOfStockKept, rows[] }`; `POST /api/admin/menu-spellcheck/dismiss { ids }` → `{ dismissed }` (§7e)
- `GET  /api/getTranslations`, `POST /api/translations/{update,add,delete}`
- `POST /api/global-search` — central store name search
- `POST /api/for-you/suggest` — `{ mode?, text?, location:{lat,lng} }` → `{ replyCode, replyParams, cards[{ id: "<appName>:<productId>", appName, store, product:{ _id, nameAR, nameHE, img, price }, dishType, reason, confidence }], personalized }` (`routes/for-you.js`, `auth.optional`). Only a customer `app-type` (`shoofi-shopping` or none) personalises. Any failure is `200 { replyCode: "unavailable", cards: [] }`. Text mode may answer `craving_unavailable` with `replyParams.craving` (CORE invariant 13). Reads `shoofi.suggestProductIndex` (§2), never the menu cache.
- Dish taxonomy / labels admin (`routes/admin/dish-taxonomy.js`; every route `auth.required` + `checkAdminRole(["master","admin","manager"])`):
  `GET /api/admin/dish-taxonomy` (seeds on first use), `POST /api/admin/dish-taxonomy/:key/approve` (→ active; its proposing labels get the type + `fromApprovedProposal`, `applied` at confidence ≥ 0.5 else `review`; admin labels untouched), `POST /api/admin/dish-taxonomy/:key/reject` (proposed only), `PATCH /api/admin/dish-taxonomy/:key`, `GET /api/admin/product-labels/review[?appName=]`, `POST /api/admin/product-labels/resolve { appName, productId, dishType }` (→ `status: "admin"`; `dishType` active or null), `GET /api/admin/product-labels/runs`, `POST /api/admin/product-labels/run [{ maxProducts, stores[] }]` — `startProductLabelsJob` (same `cron:product-labels` lock and locked index rebuild as the cron) answers as soon as it knows: `202 { started: true }` (running in the background), `409` a run already holds the lock, `503` no `ANTHROPIC_API_KEY`.

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

## 7c. "For you" index build — the cron and the dry run
`utils/crons/suggest-index-cron.js` — `SCHEDULE = "20 */3 * * *"` Asia/Jerusalem, registered in
`app.js` with the other crons (`NODE_ENV=production && ENABLE_CRONS=true`), Redis lock
`cron:suggest-index` (45-min TTL), plus a one-shot ~2 min after boot when the collection is
empty. `node bin/build-suggest-index.js <envfile> [--customers=N]` is a read-only dry run that
prints coverage (stores, products, % with a dish type, stores with popularity evidence);
`--write` rebuilds for real. One store failing is logged and the run continues; its old rows
survive. Design, evidence rules and flags: `docs/for-you.md` (shoofi-server).

## 7d. Weekly dish labelling — the cron and the script
`utils/crons/product-labels-cron.js` — `SCHEDULE = "10 4 * * 0"` (Sunday 04:10 Asia/Jerusalem),
registered in `app.js` with the other crons (`ENABLE_CRONS`), Redis lock `cron:product-labels`
(4-h TTL). `startProductLabelsJob(appDb, opts)` → `{ started: true, done }` or
`{ started: false, reason: "no-api-key" | "locked" }`; `runProductLabelsJob` (the cron) waits on
it. A started job runs `runProductLabeling`, then `runSuggestIndex` from
`suggest-index-cron.js` — the index rebuild takes the `cron:suggest-index` lock like the 3-hourly
build. Metered API only (`services/ai/complete.js` `backend: "api"`, `effort: "low"` →
`output_config.effort`; `complete` returns `usage` token counts, absent on the bridge).
`node bin/label-products.js <envfile> [--dry-run] [--max=N] [--store=appName ...] [--force]
[--index] [--reapply] [--review]` — **writes labels and proposed dish types by default**; only `--dry-run` is
read-only (it counts what would be sent and does not even seed `dishTaxonomy`). `--reapply` calls no
model and needs no key: `reapplyStatusRules` re-decides the status of every `applied`/`review`
label from its stored fields with the current `decideStatus` (admin labels untouched), after
first promoting labels whose `proposedType.key` is now an active type (returns
`promotedToApprovedType`), then refreshes proposals; it writes. `--review` (`opts.reviewOnly`)
relabels only products whose label is `status: "review"` — it calls the model and costs tokens. `--force` relabels unchanged
products (a full pass; admin rows with an unchanged hash are still skipped — CORE invariant 12).
The script does **not** rebuild the "For you" index by default — the next server build (3-hourly,
under `cron:suggest-index`) picks the labels up. `--index` opts in to a `buildSuggestIndex` run
from the script, OUTSIDE that lock (off-server the Redis lock falls back to in-memory, so it
could not protect a script anyway): use it only when no server can be building at the same time,
since two concurrent builds delete each other's fresh rows. Tests: `test/integration/product-labels.js`.

## 7e. Monthly menu spellcheck — the cron, the cache and the accept write
`utils/crons/menu-spellcheck-cron.js` — `SCHEDULE = "15 3 1 * *"` (1st of the month, 03:15
Asia/Jerusalem), registered in `app.js` with the other crons; Redis lock `cron:menu-spellcheck`
(3-h TTL). `startMenuSpellcheckJob(appDb, opts)` → `{ started: true, runId, done }` or
`{ started: false, reason: "no-api-key" | "locked" }` (the admin route answers 202 with `runId`);
`runMenuSpellcheck` (the cron) waits on `done`.
`runSpellcheck` walks every `shoofi.stores` entry (mock templates included — their names are copied
by `create-from-mock`), `collectNames` per product (product, `extras[i]` with a non-empty `id`, its
`options[j]`; both languages; skipped: empty, < 2 letters of the field's script, descriptions,
categories, combo `sections[]`, `areaOptions`). Unique `lang|text` keys are looked up in
`shoofi.menuSpellChecks` (`PROMPT_VERSION` — bump it when a prompt changes meaning); the rest go
to Haiku in batches of 80, 3 in parallel, `temperature: 0`, label `menu-spellcheck` (aiUsage).
Reply parsing (`parseReply`) takes the first parseable JSON array and drops no-op and implausible
fixes; `checkBatch` splits a cut-off/unreadable batch; `verifyFlagged` re-asks about the flagged
pairs only. Rows: `shoofi.menuSpellIssues`, unique `slotKey = appName|productId|kind|extraId|optionIndex|field`,
`status: open | accepted | dismissed | resolved | stale`, carrying `rawText` (the stored value, for
the compare-and-set), `suggestion`, `reason` (Hebrew), display names and `categoryId` for the admin
deep link `/admin/product/:appName/:categoryId/:productId`. Runs: `shoofi.menuSpellRuns`
(progress written after every store). Dismiss and accept both cache the decided text as correct.
Measured 2026-10-03 on 6 prod stores (~1.6k unique names): 19 calls, ≈ $0.03. Tests:
`test/integration/menu-spellcheck.js`.

## 8. Cross-repo consumers (inferred from endpoint surface — not verified against client repos)
- **Customer app** (`shoofi-app`/`shoofi-shopping`): `GET /api/menu`, `/api/menu/mock`, `/api/menu/search`, `/api/category/general/all`, `/api/getTranslations`, `/api/global-search`; listens for `menu_refresh`; sends `x-client-features: combo` from the bundle that renders combos (§6b). "For you":
  `POST /api/for-you/suggest` from `components/for-you/` + `screens/for-you/`, gated on the
  platform flags `isChatSuggestEnabled` / `isChatVoiceEnabled` / `isChatSuggestForAll` (entry shown to
  Shoofi employees only until the last is on); a card tap navigates to
  `menuScreen` with `productId` (`hooks/useOpenStoreAtProduct.ts`), and the menu list opens the
  sheet by matching `products[]._id`: `AllCategoriesList` searches `categoryList[].products`;
  for tile-grid stores (`store.hasGeneralCategories`) `GeneralCategoriesList` receives the
  general categories, which carry NO `products` of their own, so it searches
  `generalCategories[].subCategories[].products` (and any direct `products`). Covered by
  `__tests__/components/general-categories-open-product.test.tsx`. Never navigate to the
  `meal` route for this — it is broken.
- **Partner app** (`shoofi-partner`): product write + ordering endpoints; sends `app-type: shoofi-partner` to see hidden products; listens for `product_updated`.
- **Admin web** (`shoofi-delivery-web`/`shoofi-admin`): category CRUD, product ordering/migration, translations CRUD, stock screen (`update/quantity`), store config toggles (`isStockManagment`, `hasGeneralCategories`). "סוגי מנות (בשבילך)" at `/admin/dish-types` (`src/views/admin/dish-types/DishTypes.tsx`, API wrappers `src/apis/admin/dish-taxonomy.ts`): approve/reject/edit dish types, the "מוצרים לבדיקה" review list, run history with token counts, and a manual run. Platform flags `isChatSuggestEnabled` / `isChatVoiceEnabled` / `isChatSuggestForAll` ("For You — Open To All Customers"; off = Shoofi employees only) under Settings → Shoofi.

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
