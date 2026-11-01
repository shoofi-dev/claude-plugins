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
- The AI helper's effect on suggestions (§2 `tasteProfiles`, §7, §7f) — `avoid.js` (the `avoid`
  filter), the profile hooks in `suggest.js` (`applyProfile`, `profileBias`, `rejectedFacts`, the
  `drink` / `sweet` / `cross_sell` modes) and `suggest-service.js` (`loadProfile`, `modeClauses`,
  `filterByAvoid`), `utils/extras-required.js` (`hasRequiredOptions`), and
  `GET /api/ai-helper/cuisines` (`routes/ai-helper.js` → `ai-helper-service.js`); in the app, the
  chat's quick add `hooks/useChatAddToCart.ts` + `helpers/chat-cart-line.ts` (§7f) and the
  minimized-chat bubble `components/for-you/{bubble-math.ts,ChatBubbleOverlay.tsx}` (§7g). The profile's
  owner and login merge (`taste-profile.js`, the other `/api/ai-helper/*` routes) are the
  customers domain's; the history facts are `facts.js` — all in `docs/ai-helper.md`.
- Docs: `docs/stock-management.md`, `docs/menu-search.md`, `docs/explore-cache-invalidation.md`,
  `docs/combo-deals.md`, `docs/for-you.md`, `docs/ai-helper.md`

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
Served sorted by `order` via `sortGeneralCategories` (`utils/general-category-order.js`) — missing
`order` last, ties by string `_id`; never in natural order (CORE invariant 6). `POST
/api/category/general/add` sets no `order`, so a new tile appears last until someone drags it.

### `extras` — declared in `DatabaseInitializationService.js`, **unused**: nothing in the server reads or writes it. Every option lives embedded in its product's `extras` array (§4); delivery-web's `ExtraGroup` is editor-side only.
### `store` (singleton `{id:1}`) — per-store config
Catalog-relevant flags: `isStockManagment` (the stock gate — **source of truth is
this per-store doc, NOT central `shoofi.stores`**), `hasGeneralCategories`,
`mockStoreAppName`, `outOfStockExtras` (surfaced in the menu response),
plus open/visibility flags.

**Who writes it: `POST /api/store/update`** (CORE invariant 28, `services/catalog/store-update-access.js`).
`$set` of each top-level key received (`req.body.data || req.body`, `_id` = the target), so a key
left out keeps its stored value; a nested object (`coinsSettings`, `accounting`) is replaced whole.
- **Dashboard** (`DASHBOARD_ROLES`, `Bearer` + `app-type: shoofi-admin`): any store, any key. Admin-web
  callers: `views/admin/stores/StoreData.tsx`, `views/admin/accounting/{BankAccountDetails,ContractDetails}.tsx`
  (both re-post the whole `GET /api/store/get/:appName` document), `apis/delivery/update-store.ts`
  (`{ isStoreClose, _id }`, default `app-name: shoofi`). Server: the billing-contacts self-call
  (`PUT /api/shoofiAdmin/stores/:storeId/billing-contacts`, forwards the admin's token).
- **Partner** (`Token` + `app-type: shoofi-partner`, own store only): `PARTNER_STORE_FIELDS`, i.e.
  `isStoreClose isOpen isBusy openHours creditcard_support cash_support takeaway_support
  delivery_support isOrderLaterSupport drive_in_support invoicePrintCount ramadanSettings`.
  The partner app posts `{ data: <its whole storeData> }` from `screens/admin/store-managment`
  `onSave` and the header open/close/busy toggles. That copy is `POST /api/store`'s answer:
  the stored keys minus `SENSITIVE_STORE_FIELDS`, plus `workingHours`, `isDeliveryOpen`,
  `isTwoPhaseCaptureActive`, `isPartnerOrderAmendActive`, `isDeliveryOnlyActive`,
  `walletPaymentProvider`, `googlePay*`, computed on every read and read from storage by
  nothing. With no `coinsSettings` stored it carries the app's `defaultCoinsSettings`
  (`enabled: false`); the coins toggle has been commented out of the screen since 2026-05-27.
- `invoicePrintCount` missing or invalid in the request is written as `1`, for any caller.
- `isStockManagment === true` in the write runs the stock backfill (§5), so only a dashboard save
  can run it.

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

### central `shoofi.translations` — i18n labels, one flat key space for every app
_Verified 2026-10-26 against shoofi-server `routes/translations.js` and the feat/coupon-drafts worktree,
with local Mongo for the counts. These are not prod counts._
- **Shape:** one document per key, both languages on it:
  `{ _id, key, ar, he, createdAt?, updatedAt?, seededBy?, owner? }`.
  - `createdAt` and `updatedAt` are often missing on old rows (locally 235 and 285 of 1042 docs have them).
  - `seededBy` names a seed script tag (e.g. `checkout-redesign-pr45`) or `'owned-translations'`.
  - `owner: { type, id }` is set only by `writeOwnedTranslation` (e.g. `{ type: 'coupon-draft', id: <draftId> }`).
- **One collection for everyone.** The customer, partner and driver apps all call
  `GET /api/getTranslations`. There is no split by app or `app-type`, and the read ignores the
  `app-name` the apps send. The admin web only edits rows (Translations panel); it does not use
  them for its own UI.
- **No unique index on `key`.** Only `_id_` exists, and nothing in
  `DatabaseInitializationService.js` creates one. Locally 8 keys have duplicate rows (`price`,
  `delete`, `store-is-closed`, `insert-customer-name`, …), so a unique index can't be built until
  they are de-duplicated.
- **Which duplicate wins:** `getTranslations` sorts `{ createdAt: -1, _id: 1 }` and the last row
  written into the map wins. That is the OLDEST `createdAt`; a row with NO `createdAt` sorts last
  and beats every dated row; a tie goes to the highest `_id`. So inserting a fresh row for an old
  key shows nothing. An empty `ar`/`he` falls back to the key itself (`element.ar || element.key`).
- **No cache anywhere on the server** (no Redis, in-memory, ETag or version). Every
  `getTranslations` and every write re-reads the whole collection (~72 KB) and returns it as
  `{ arTranslations, heTranslations }`. Nothing needs clearing after a write; the menu cache is
  unrelated.
- **When apps see a change: at boot.**
  - Customer app (`stores/translations`): fetches in `prepare()` at cold start and on the
    offline-dialog path. It has no AsyncStorage copy and does not refetch on foreground.
  - Partner and driver apps (identical `utils/translations-boot.ts`): apply the AsyncStorage
    `@storage_translations` copy first, then the server payload, retrying on backoff up to 6
    times. They reload at boot and on `PREPARE_APP` / NetInfo.
  - A missing key renders as its raw slug, unless the call site passes `t(key, { defaultValue })`.
- **i18n settings:** all three apps run i18next 25.5.2 with default separators (`keySeparator '.'`,
  `nsSeparator ':'`, `ignoreJSONStructure` true). A dotted flat key resolves through i18next's
  `deepFind` fallback (prod precedent: `city_filter.title`). A `:` in a key is read as a
  namespace and the lookup misses.
- **Naming in the data (local):** mostly kebab-case (832/1033), plus `snake_case` (158), dotted
  (31: `city_filter.*`, `filters.*`), some uppercase (`Bcool-free-delivery`), no `:`. Coupon
  labels created by hand share the flat space: `free-delivery`, `delivery-free-100`,
  `shoofi-will-pay`, `delivery-discount-checkout`.
- **How coupons use it:** `nameForCheckout`, `nameForStore`, `subNameForStore`, `storeTagName`,
  `nameForPartner` and `nameForShoofir` hold translation KEYS, and every app passes them through
  `t()`.
- **Writers:**
  - **The panel routes** (`routes/translations.js`; see §7) are for people only.
  - **`writeOwnedTranslation`** (`services/translations/owned-translations.js`; CORE invariant 24)
    is for code. It uses the central DB, creates only if the key is absent (`$setOnInsert`
    upsert), updates only rows of the same owner, and throws `TRANSLATION_KEY_COLLISION`
    otherwise.
    - First caller: the coupon-drafts approval (`routes/admin/coupon-drafts.js`
      `/coupon-drafts/:id/approve`). It writes each custom label as
      `coupon.<draftId>.<surface>` (surface `checkout|store|store-sub|store-tag`, guarded by
      `LABEL_KEY_RE` in `services/coupons/coupon-drafts.js`), BEFORE the coupon is created, and
      a collision answers 409. Partner and driver labels are never generated: they stay
      `shoofi-will-pay`. Feature doc: shoofi-server `docs/coupon-drafts.md` "Labels and translations".
  - **Seed scripts** `scripts/seed-*-translations.js` write the central DB directly with a
    backup file; `scripts/rollback-translations.js` undoes a run.
### `images` — auxiliary image library: `{ data:{uri}, type, subType }`.
### central `shoofi.stores` — store registry (used by cross-store search & `initDb`).
Also the document every **store list** is built from (`RestaurantAvailabilityService.getAvailableStores`
→ explore v1/v2 and `available-stores`; `POST /api/menu/search`), so a field the store card needs
can live here with no per-store propagation. `launchDate` (Date, Israel midnight; `null`/absent =
not a new store) is one: written by the store form's "تاريخ الافتتاح", read only through the
server-computed `store.isNew` (CORE invariant 25). The window is the platform setting
`shoofi.store {id:1}.newStoreWindowDays` (default 30).
It also holds staff-only data: `accounting` = `{ bankAccount: { bank, branch, accountNumber,
companyId, email, phone, businessType? }, contract: { commissionTiers, monthlyPayments,
onetimePayments } }` (22 visible stores on prod, 2026-10-30). A public store card must go through
`toPublicStore` (`services/catalog/public-store.js`), which drops `accounting`, `hyp`, `credentials`
and `fraudConfig`. Every customer-facing store list does: explore v1/v2, `available-stores` (and its
delivery companies), `menu/search`, twin `eligible-stores`, For-you cards (CORE invariant 27).

### central `shoofi.suggestProductIndex` — the "For you" candidate index (derived, disposable)
One document per suggestible product of every food-service store (CORE invariant 11):
`{ appName, productId (string), nameAR, nameHE, nameNorm, categoryNames[], dishType|null,
dishTypeSource (claude|admin|rules|null), course, sweet, spicy, vegetarian, light, protein,
searchTermsNorm[], price, img|null, qty30d, orders30d, storeOrders30d, builtAt }`. Indexes
(created by the builder, not by `DatabaseInitializationService`): `{ appName:1, productId:1 }`
unique, `{ appName:1, dishType:1 }`, `{ appName:1, course:1 }` (the chat-ordering modes, §7f),
`{ appName:1, searchTermsNorm:1 }`. Written ONLY by `buildSuggestIndex`
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
open stores' `appName`s and an `$or` of what the mode can use (with a taste profile, also the
stated cuisines' dish types; in a chat-ordering mode, its `modeClauses` — §7f), drops what the
profile's `avoid` excludes (`filterByAvoid`), ranks in memory, then
`applyLiveMenu` re-reads the winners from each store's `products` (projection `nameAR, nameHE,
price, img[0], isHidden, isInStore, productType, supportedCategoryIds, extras, soldByWeight` — the
last two only to compute `product.hasRequiredOptions`, §7f) and, in parallel, the
store's `categories` with `{ isHidden: {$ne:true}, isSchoolProject: {$ne:true} }` (projection
`discountPercent`). A row survives only if it exists, is not hidden, is not a combo, has at least
one of its `supportedCategoryIds` among those visible categories, has `isInStore === true`, and a
discounted `price > 0`. The card takes that discounted `price` (plus `originalPrice` /
`discountPercent` when a discount applies) — CORE invariant 3 — the live names and image, and
`hasRequiredOptions`.

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
instances pick it up within 10 min. An optional `img` (a CDN path) is read only by
`GET /api/ai-helper/cuisines` as the type's own tile image (§7f); **no code writes it** — the
`PATCH` takes `label_ar`, `label_he`, `meal` and `words` only — so it is absent unless set by hand.

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

### central `shoofi.tasteProfiles` — the AI helper's taste profile (this domain only READS it)
One document per owner (a customer, or a visitor's `device-id`): `{ owner, stated: { cuisines[],
spice: 0-3|null, avoid[], mealTimes[], budget: 1-3|null }, confirmed: { [factKey]: boolean },
inferred, people[{ id, name, relation, avoid[], dishes[{ appName, productId, name, count, lastAt }] }],
family{ answer, answeredAt, offerSnoozedUntil, lastOfferAt, suggest }, onboardedAt, skippedAt,
updatedAt, createdAt, version }`. Written by
`PUT /api/ai-helper/profile` and the login merge (`taste-profile.js` — ownership and merge are the
customers domain's, `docs/ai-helper.md`); `stated` is sanitised there (`avoid` through
`sanitizeAvoid`, `cuisines` to `[a-z0-9_]` keys, not checked against the taxonomy). The
suggestions read ONLY `stated`, `confirmed` and — with `forPerson` — that one entry of `people`, via `loadProfile` (`suggest-service.js`): by the
customer id, else — only when there is no customer — by the `device-id` header; any error → no
profile. What they do: CORE invariant 18, §7f.

### central `shoofi.extras-catalog` + `extras-catalog-aliases` — the shared extras list (CORE invariant 29)
One list for every store, seeded once from the 2026-10-25 prod build (`scripts/seed-extras-catalog.js`,
`$setOnInsert` only, dry run by default; `docs/extras-icons.md` › Seeding).
- `extras-catalog`: `{ _id: key, key, nameAR, nameHE, category, parent, iconFile, aliasesAR[], aliasesHE[], usage, source: seed|admin }`.
  `key` is stable snake_case and never renamed. `iconFile` is the PNG under `extras-icons/v1/`
  without `.png`, from the designer map, and several keys share one (`cherry_tomato`'s is
  `tomato`). A key with `iconFile: null` shows its `parent`'s. 767 of the 768 seeded entries have
  one (`tofu` does not).
- `extras-catalog-aliases`: `{ _id: extraIconKey, kind, key, modifier, also[], source }` — kind
  `ingredient` (with `key`) or `size quantity nonfood preparation level color doneness unclear`
  (`key: null`, known but no icon); modifier `none without extra on_side` (only `without` shows,
  as `|w` in the map); source `seed` (voted from every prod option) / `seed-name` (an entry's own
  Arabic/Hebrew name) / `rule` / `claude` / `admin`. ~4.7k rows after the seed.
- `extras-catalog-queue`: `{ _id: extraIconKey, name, nameAR, nameHE, status: pending|review|auto|resolved,
  stores[], options, lastSample{appName,productId,extraId,optionId}, suggestion, why, attempts,
  resolution, decidedBy, decidedAt, source: save|nightly }`.
- `extras-catalog-runs`: `type: "sync"` (stats, `preview` on a dry run) and `type: "publish"`
  (`ok, hash, names, icons, url, trigger`). The last `ok` publish is the shrink guard's baseline.

## 3. Category → product hierarchy & ordering
Two levels: `general-categories` → `categories` (linked by
`category.supportedGeneralCategoryIds`) → `products` (linked by
`product.supportedCategoryIds`, many-to-many). **Ordering:** categories by
`order`; products by `categoryOrders[categoryId]`, falling back to legacy `order`.
General-category tiles by `order` too (missing last — `sortGeneralCategories`).
Reorder endpoints: `product.js` (`update/order`, `order-per-category`,
`bulk-reorder`, `reset-order`, `migrate-orders`) and `store.js`
(`store-category/update-order`, `category/general/update-order`). Both `store.js`
reorder routes write `{order}` per item with one `bulkWrite` on the `app-name` DB and then
clear both menu cache keys (`clearMenuCachesAfterReorder`; a failed clear is logged, never
fails the save). Admin callers: delivery-web `StoreCategoriesList.tsx` /
`GeneralCategoriesList.tsx` drag-and-drop, which renumbers every item 0..n-1.

## 4. Product options / extras / pricing
Option icons are NOT stored on the product: the app looks each option's `nameAR`/`nameHE` up in
the published `extras-icons/v1/map.json` (CORE invariant 29, §7i).
A product's `extras` is an **array** of extras (stored verbatim from `JSON.parse(req.body.extras)`;
shape not enforced on write). Every extra has `{ id, type, nameAR, nameHE, order?, groupId?,
isGroupHeader?, freeCount? }`; group headers (`isGroupHeader:true`) are pseudo-extras that only
title a group and carry `freeCount`. In prod the member extras usually have an EMPTY `nameAR`
and the group's name lives on its header (shawarma sample 2026-11-01: 141 of them) — name a group
by its header, else the extra (`option-request.js optionsOf`, `helpers/chat-order.ts`). Option
names carry trailing spaces («حمص  »), and some menus have negated options («بدون سلطة»). Defaults
are seeded WITHOUT a stock check (`helpers/extras-defaults.ts`, the menu's `ExtrasSection`); the chat
clears out-of-stock ones (`withoutOutOfStock`), the menu screen does not. Real types:
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
this predicate leaves the add-to-cart button disabled forever. `validateWith` has a second
caller, the For-you chat's `selectionsValid` (`helpers/chat-cart-line.ts`, which adds the
`maxCount ?? max` cap the menu's checkbox enforces — §7f). The partner app enforces
nothing (`isValidForm={true}`), and order creation does not re-validate extras (see the recorded
risk below). Making `required` real is a full-stack change: both editors → server passthrough →
both validators → this doc — and the For-you quick-add flag `hasRequiredOptions`
(`utils/extras-required.js`, §7f), which also ignores `required` and is a deliberate superset
(defaulted singles, `weight` extras and `soldByWeight` count too).

**Pricing has three copies that must stay in lockstep** — `shoofi-app/stores/extras/index.ts`,
`shoofi-partner/stores/extras/index.ts`, and the server reference `utils/order-pricing.js`
(`calculateExtrasPrice(extras, selections, { soldByWeight })`, orders domain). The LINE formula
on top of it (`base + (d > 0 ? Math.round(extras × (1 − d/100)) : extras)`) has two app copies
besides the server's: the menu's product screen `screens/meal/index2.tsx` and the For-you chat's
`helpers/chat-cart-line.ts` `priceLine` (§7f) — the menu screen was deliberately not refactored to
share it, so the three change together. The weight
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
(`product.js`), enable-stock backfill (`store.js`, dashboard saves only: a partner
write cannot carry `isStockManagment`), and the
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
- **Product route auth** (`services/catalog/product-access.js`, CORE invariant 26). Each route below is tagged with its gate:
  **[admin]** is `PRODUCT_ADMIN`, i.e. `auth.required` + `checkAdminRole(DASHBOARD_ROLES)`, any dashboard role.
  **[admin|own store]** is `PRODUCT_ADMIN_OR_OWN_STORE`: a dashboard role, or a partner token whose `storeUsers.appName` equals `app-name`.
  Without a token the answer is `401`. A customer or driver token gets `403`, and so does a partner on another store or on an **[admin]** route.
- `POST /api/admin/product/insert | update | delete` **[admin|own store]** — product CRUD (partial update). Insert/update run the combo validation chain (`400 COMBO_INVALID`); delete is `409 PRODUCT_REFERENCED_BY_COMBO` when a combo still points at a requested product (CORE invariant 10).
- `POST /api/admin/product/update/{isInStore,quantity,isHidden,isInStore/byCategory,activeTastes}` **[admin|own store]** — availability/stock/visibility
- `POST /api/admin/product/update/order` **[admin|own store]** (the partner's products-order screen); `POST /api/admin/product/{update/order-per-category,bulk-reorder,reset-order/:cat,migrate-orders}` and `GET /api/admin/product/{order/:cat,orders}` **[admin]** — ordering
- `GET  /api/admin/product/extras` **[admin|own store]**, `GET /api/admin/product/:id` **[admin]**, `GET /api/admin/product/import-index` **[admin]**, `POST /api/admin/images/upload` **[admin|own store]** (gated before multer), `POST /api/images` **[admin|own store]** (the image list by `type`)
- `POST /api/product/create-from-mock` (`400 COMBO_NOT_CLONEABLE` for a combo template), `GET /api/product/mock-store/:appName`, `POST /api/product/update-barcode`, all **[admin]**
- **Category and explore route auth** (`services/catalog/category-access.js`, CORE invariant 27). **[admin]** below is `CATALOG_ADMIN`: `auth.required` + `checkAdminRole(DASHBOARD_ROLES)`, any dashboard role, before multer. No token is `401`; a customer, partner or driver token is `403`. **[public]** is called by the customer app before login.
- `/api/store-category/{all, add, update/:id, update-order, :id DELETE}` **[admin]** — regular subcategory CRUD (in `store.js`)
- `/api/category/general/{add, update/:id, :id DELETE, all/by-store}` **[admin]** (`category.js`), `POST /api/category/general/update-order` **[admin]** (`store.js`), `GET /api/category/by-general/:id` **[admin]** — general category CRUD; `GET /api/category/general/all` **[public]** (the central home tiles)
- `/api/shoofiAdmin/category/{GET list, add, GET :id, update/:id, update-order, :id DELETE}` **[admin]** — platform categories (central `shoofi.categories`); `POST /api/shoofiAdmin/category/list` **[public]** (same documents as the GET, the apps' boot read)
- `GET /api/shoofiAdmin/explore/categories-with-stores-v2` and v1 **[public]** — the home, store cards through `toPublicStore` (no `accounting`); `/api/shoofiAdmin/explore/{clear-cache, clear-cache-keys, cache-stats, debug-area}` **[admin]**
- `GET /api/store/get/:appName` **[admin]** — the whole per-store `store` document, payment credentials included (it had no auth). Admin web only; the server reads `db.store` directly instead of calling it.
- `POST /api/store/update` — save the per-store `store` document (`$set` per key). Its own gate, not `CATALOG_ADMIN`: `auth.required` + `storeUpdateGate` — any dashboard role, any key; a partner token for its own `app-name` only, cut to `PARTNER_STORE_FIELDS`; customer/driver 403, no token 401. Answers `200 { message: "Successfully saved" }` either way (§2 `store`, CORE invariant 28).
- Public store lists through `toPublicStore` (no `accounting`/`hyp`/`credentials`/`fraudConfig`): explore v1/v2, `POST /api/shoofiAdmin/available-stores` (store + each `deliveryCompanies[].company`), `POST /api/menu/search`, `POST /api/twin-order/eligible-stores`, `POST /api/for-you/suggest` cards.
- `GET /api/admin/categories/:page?` — **no auth** still (delivery-web `get-categories.ts` sends no token). The legacy expressCart `GET /category/:cat/:pageNum?` is removed (2026-10-30).
- `POST /api/admin/menu-import-issues` — record one import run's issues (whole run, one call)
- `GET  /api/admin/menu-import-issues?status=open|resolved|all[&runId=]` — the store's worklist
- `POST /api/admin/menu-import-issues/:id` — edit `reason` / tick `resolved` (writes only the keys it receives)
- `DELETE /api/admin/menu-import-issues/:id`
- `GET  /api/admin/catalog-lint/summary` — open lint rows per store by severity (`{ totals, stores[] }`), admin token
- `POST /api/admin/catalog-lint/run` — `{ appName }` for one store, else every store; admin token; returns the run stats
- Menu spellcheck (`routes/admin/menu-spellcheck.js`; `auth.required` + `checkAdminRole(["master","admin","manager"])`, POSTs in the audit route map): `GET /api/admin/menu-spellcheck/issues?status=open|accepted|dismissed|resolved|stale&appName=&lang=ar|he` → `{ issues (≤2000), truncated, counts, lastRun }`; `POST /api/admin/menu-spellcheck/run [{ appName }]` → `202 { started, runId }` / `409 locked` / `503 no-api-key`; `POST /api/admin/menu-spellcheck/accept { ids, fixes? }` → `{ accepted, stale, failed, outOfStockKept, rows[] }`; `POST /api/admin/menu-spellcheck/dismiss { ids }` → `{ dismissed }` (§7e)
- `GET  /api/getTranslations` → `{ arTranslations, heTranslations }`. It reads the central DB through a header literally named `shoofi` that no client sends, so it is always `shoofi` (§9).
- `POST /api/translations/{update,add,delete}` — the admin Translations panel (`shoofi-delivery-web` `src/views/admin/translations/TranslationsList.tsx`, body `{ key, ar, he }`, sends `app-name: 'shoofi'`). Every write answers with the whole re-read map.
  - **These pick the DB from the `app-name` header** (default `shoofi`), not the `shoofi` header the read uses.
  - **No auth** on any of the four routes, and they are not in the admin audit route map.
  - `update` is `updateOne({ key }, { $set: { ar, he, updatedAt } })` with no upsert: a missing key is a silent no-op, and only one row of a duplicated key changes.
  - `add` is `insertOne({ ...req.body, createdAt, updatedAt })` with no existence check.
  - `delete` is `deleteOne({ key })`.
  - Code must not call them (CORE invariant 24); use `writeOwnedTranslation`.
- `POST /api/global-search` — central store name search
- `GET  /api/shoofiAdmin/store/all-stores[?search=][&isNew=true]` — the registry, every row with `isNew`. With `isNew=true`: only the stores inside their "new" window now (`business_visible !== false`, not `isMockStore`), newest `launchDate` first, each with `newUntil` (CORE invariant 25). Admin token with any dashboard role, like the rest of `/api/shoofiAdmin/store/*` except `store/z-cr` (shoofi-server `utils/admin-token-routes.js`, 2026-10-29; they had no auth before).
- `store.isNew` (boolean) rides on every store-list response: explore v1/v2 (`storesMap`), `POST /api/shoofiAdmin/available-stores`, `POST /api/menu/search` (CORE invariant 25).
- `POST /api/for-you/suggest` — `{ mode?, text?, location:{lat,lng}, history?, lang?, cart?: { appName, productIds }, onboarded?, conversationId?, surface?, seen?: string[] }` → `{ replyCode, replyParams, cards[{ id: "<appName>:<productId>", appName, store, product:{ _id, nameAR, nameHE, img, price, originalPrice?, discountPercent?, hasRequiredOptions }, dishType, reason:{ code, params }, confidence }], personalized, suggestionId }` (`routes/for-you.js`, `auth.optional`; `suggestionId` on every reply, CORE invariant 21). Modes `opener` (default), `usual`, `new`, `surprise`, `popular`, and the chat-ordering `drink`, `sweet`, `cross_sell` (§7f); reason codes `usual`, `ordered_before`, `liked_type`, `you_like`, `popular`, `match`. Only a customer `app-type` (`shoofi-shopping` or none) personalises; without a customer, a visitor's taste profile is read by the `device-id` header (CORE invariant 18). `cart` goes through `sanitizeCart` (a string `appName` ≤ 100 chars, ≤ 50 `productIds`); `onboarded` counts only when `=== true`. With options in the message («… مع حمص وسلطة», `option-request.js`): the reply carries `optionRequest: { wanted, without }` and each card `optionMatch: { matched, ambiguous, missing, outOfStock, deselect, noteWithout }` (option refs `{ extraId, optionId, index, nameAR, nameHE, price, group }`), cards with fewer unmet words first; «شو الإضافات؟ / מה התוספות» answers `replyCode: "extras_question"` (cards of the dish it names, or none). `store` (an appName, else ignored) limits the reply to that OPEN store, and with one store in play text mode drops the 2-per-store cap (CORE invariant 19). `focusStore` / `otherThan` (appNames, same sanitising): the chat's store, used only when the text points back at it («في عندهم…؟», `store-focus.js` `resolveStoreScope`), and "look in other stores" (that store left out, its name not searched); a reply about one store carries `storeScope: { appName, name_ar, name_he }`, and nothing there is `replyCode: "store_no_match"`, `replyParams: { stores, dish, closed? }`, no cards (CORE invariant 14). The served line has `focusStore` (bool) and `otherThan`. `forPerson` — an id from the profile's `people` (`[A-Za-z0-9_-]{1,40}`, else ignored, never a 400) — answers for that person: their `avoid` replaces the customer's, the customer's taste is not used, their tagged dishes first (`personMode`, reason `for_person` `{ name, count }`), then popular; `replyCode` `for_person` / `for_person_new` (none of theirs open). An id not on the profile → the customer's own reply; the served log carries `forPerson` (CORE invariant 18). `seen` — the card `id`s this chat already showed, newest first — goes through `sanitizeSeen` (strings ≤ 120 chars, deduplicated, the newest 40; anything else ignored, never a 400): `popular`, `surprise`, `new`, `drink`, `sweet`, `cross_sell` then answer from the dishes not shown yet (the same mode on the unseen candidates) and are topped up with the normal reply's other cards only when fewer than 2 unseen cards survive `applyLiveMenu` + `dropAtServe`; `usual`, the opener and typed text ignore it (CORE invariant 23). Any failure is `200 { replyCode: "unavailable", cards: [] }`. Text mode may answer `craving_unavailable` with `replyParams.craving` (CORE invariant 13). Reads `shoofi.suggestProductIndex` (§2), never the menu cache.
- `GET  /api/ai-helper/cuisines?lat=&lng=` — `{ cuisines: [{ key, label_ar, label_he, img, storeCount }] }` (`routes/ai-helper.js` → `ai-helper-service.js` `getCuisines`, `auth.optional`): the onboarding's cuisine tiles (§7f). `400` without a valid location; any other failure `200 { cuisines: [] }`. The other AI-helper routes — `GET`/`PUT /api/ai-helper/profile`, `POST /api/ai-helper/merge`, `GET /api/ai-helper/facts` — are the profile's side (`docs/ai-helper.md`; ownership and merge: customers domain).
- Extras catalog admin (`routes/admin/extras-catalog.js`; every route `auth.required` + `checkAdminRole(["master","admin","manager"])`; writes audited; no admin screen calls them yet):
  `GET /api/admin/extras-catalog/queue[?status=review|pending|auto|resolved]` (most stores first, + counts),
  `POST /api/admin/extras-catalog/queue/resolve { name, action: assign|create|not_ingredient, key?, modifier?, kind?, entry? }`
  (404 `NOT_FOUND`/`UNKNOWN_KEY`, 400 `BAD_*`/`UNKNOWN_PARENT`, 409 `KEY_EXISTS`; schedules a 30-s debounced publish),
  `GET /api/admin/extras-catalog/entries`, `GET /api/admin/extras-catalog/coverage`,
  `POST /api/admin/extras-catalog/entries/:key/icon` (multipart `icon`, PNG ≤ 512KB; 409 `ICON_ALREADY_SET` / `ICON_EXISTS`),
  `POST /api/admin/extras-catalog/run { dryRun?, appName? }` (202 `{ runId }`, 409 locked; ignores the flag),
  `POST /api/admin/extras-catalog/publish { dryRun? }` (`{ published, reason: unchanged|shrunk|dry_run }`).
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

**The customer-taste cache** (`services/ordering-intelligence/taste.js`, CORE invariant 11).
`getCustomerTaste` (90 days, newest 30 completed orders) is cached 10 min (`CACHE_TTL_MS`):
- **Redis first** when `REDIS_URL || REDIS_HOST` and not `E2E_SANDBOX` — `GET`/`SET … PX 600000`/`DEL`
  on `fy:taste:v<CACHE_VERSION>:<customerId>` (`redisKeyOf`), through `utils/redis-lock`
  `getRedisClient()` (one connection, shared with the locks and `chat-limits.js`). Each command
  races `REDIS_TIMEOUT_MS` (150). A hit returns with no DB read; a miss (or an unreadable value —
  `deserializeTaste` returns `null` for another version, bad JSON or a non-taste) recomputes and
  re-writes in the background.
- **Memory fallback** — the old capped per-process `Map` (`CACHE_MAX` 2000, oldest evicted): used
  when Redis is not configured, or for a call where Redis errored / timed out; any Redis failure
  (read, write or delete) also skips Redis for the next 30 s (`REDIS_BACKOFF_MS`). Every compute
  writes memory, so an outage starts warm. Logs: `[for-you] taste cache <read|write|delete>
  failed, using memory` at warn, error message only.
- **Shape:** `serializeTaste` turns `products`, `stores`, `dishTypes` and each dish type's `stores`
  into entry arrays (order kept) plus `v: CACHE_VERSION`; `deserializeTaste` rebuilds the Maps.
  Consumers (`suggest.js`, `facts.js`, `ai-chat.js` `tasteSummary`, `ai-helper-service.js`,
  `bin/build-suggest-index.js`) cannot tell a cached taste from a fresh one. Change the shape →
  bump `CACHE_VERSION` (it is in the key AND the payload).
- **Not cached:** no customer id (`EMPTY_TASTE`), the dry run's `opts.dishTypes`.
- **`invalidateCustomerTaste(customerId)`** deletes the Redis key and this instance's memory entry,
  never throws. Nothing calls it yet (wiring it to order completion would be an orders-domain
  change); other instances' memory copies only answer while their Redis is failing.

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
`options[j]`, `combo.sections[k]` with a non-empty `id` — kind `comboSection`, section id in
`extraId`) and `collectCategoryNames` per store category (kind `category`, `productId: ""`,
slot keyed on the category id; rows carry `categoryName` and the store's `hasGeneralCategories`
for the admin edit link). Both languages; skipped: empty, < 2 letters of the field's script,
descriptions, central general categories, `areaOptions`. Unique `lang|text` keys are looked up in
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

## 7f. AI helper — what the taste profile does to suggestions, the cart modes, quick add, cuisines
Design: `docs/ai-helper.md` (shoofi-server). The invariants are CORE 18–19; this is the detail.
**Order inside `suggestForCustomer`:** open stores → customer taste and `loadProfile` in parallel →
ONE index `find` (`candidateQuery`; non-text modes add `{ dishType: { $in: stated.cuisines } }`
and `modeClauses(mode, cart, appNames)`) → `filterByAvoid` → Claude on
`applyProfile(docs, taste, profile)` (`aiChatTurn`, typed text, when switched on) or
`rankSuggestions` (which runs `applyProfile` itself) → `applyLiveMenu`; the rules path then goes
through `replyAfterAvoid`. Both paths get the whole profile — Claude's shortlist ranks its text
matches with `_bias`, `cardForDoc` sees `taste.rejected`, `tasteSummary` the stated cuisines.

**`avoid`** (`avoid.js`; `sanitizeAvoid` keeps only `AVOID_KEYS`, in canonical order;
`conflictsWithAvoid` / `filterByAvoid` are pure). A candidate is dropped when:

| key | rule (on the index row) | guaranteed |
|---|---|---|
| `vegetarian` | `vegetarian !== true` — only a TRUSTED label sets it, so unlabelled (`null`) is dropped | yes |
| `no_seafood` | `protein` null (unlabelled — no proof), fish or seafood; dish type `sushi` / `fish` or any key matching `fish\|seafood\|shrimp\|sushi\|salmon\|tuna`; a `SEAFOOD_WORDS` word in the name | yes |
| `vegan` | the `vegetarian` rule, or protein cheese / egg, or dish type pizza / dessert, or a `DAIRY_WORDS` word | best effort |
| `lactose_free` | protein cheese, dish type pizza, or a `DAIRY_WORDS` word | best effort |
| `gluten_free` | dish type in `GLUTEN_TYPES` (burger, shawarma, tortilla, pizza, falafel, schnitzel, pasta, sandwich, breakfast) or a `GLUTEN_WORDS` word | best effort |
| `nut_allergy` | a `NUT_WORDS` word | best effort |

Name words (`hasWord`) match at a word START on the row's `nameNorm`, also with one glued prefix
removed (Arabic وال / بال / لل / ال / و / ب / ل, Hebrew ו / ה / ב / ל / מ / ש / כ), so "דג" finds
"דגים" and "فستق" finds "بالفستق"; multi-word entries ("פירות ים") match as a phrase. There is no
allergen or dairy field on a product, a label or the Haat import. The app (`stores/ai-helper/index.ts`
`GUARANTEED_AVOID`) stars the four best-effort chips and, once one is picked, shows
`ai_helper_avoid_best_effort` ("we try, but can't guarantee — ask the store about allergies"),
decided 2026-10-16. Promoting a key = label fields `vegan` / `containsDairy` / `containsGluten` /
`containsNuts`, a forced full relabel (≈ $11, CORE invariant 12), the index build and
`suggest-service.js` `PROJECTION` carrying them (the filter sees only projected index fields), and
the key added to BOTH `GUARANTEED_AVOID` lists.

**`avoid_no_match`** — `replyAfterAvoid(ranked, cardCount, foundCount, keptCount)`: when `avoid`
removed candidates (`kept < found`) and the rules path ends with no card, the reply becomes
`replyCode: "avoid_no_match"` (app copy `for_you_reply_avoid_no_match`) instead of an opener over an
empty row; a `store_closed` reply is kept. The Claude path returns before it.

**Weighting** — `applyProfile(docs, taste, profile)` sets `_bias = profileBias(doc, stated,
medianPriceOf)` on every candidate (1 = neutral, factors multiply):

| stated | factor |
|---|---|
| `cuisines` contains the row's dish type | ×1.4 |
| `spice: 0`, row `spicy === true` | ×0.3 |
| `spice: 2` / `3`, row `spicy === true` | ×1.3 / ×1.45 (`1 + 0.15 × spice`) |
| `budget: 1` | price ≤ the median of its dish type among the candidates ×1.15; > 1.3× the median ×0.8 |
| `budget: 3` | ≥ the median ×1.15; < 0.7× the median ×0.85 |

`spice: 1`, `budget: 2` and `budget: null` (not chosen — the app saves a budget only once it is
tapped, CORE invariant 18) are neutral; medians are per dish type (untyped rows share one bucket)
over the candidates' index `price`. `weighted(d) = qty30d × (_bias ?? 1)` replaces raw `qty30d` in
`bestOfType`, `popularDocs`, `addFill`, `addStatedCuisines` and the cart modes; text mode multiplies
its rank by `_bias`. `hasPopularEvidence` still reads raw `qty30d` — a bias never turns a product
into "popular". `stated.mealTimes` is stored but no rule reads it.

**`you_like` cards** (`addStatedCuisines`, from the opener — and so the `surprise` pool): per stated
cuisine, the best-weighted row of that type with `qty30d > 0` not already shown, skipping a type a
card already covers and any key that is not an active type (`dishTypeLabel` null);
`reason: { code: "you_like", params: { dishType } }`, `confidence: 0`. A customer with < 3 orders gets
up to 2 (after their one personal card) and, with 0 orders and at least one, `replyCode:
"opener_stated"`; an experienced customer gets 1, after the liked types. `onboarded: true` in the
body makes the opener answer `opener_onboarded` (the app fills `{{name}}` with `ai_helper_name`).

**Rejected facts** (`rejectedFacts(profile.confirmed)`) — the keys are `facts.js`'s:
`usual:<appName>`, `liked_type:<dishType>`, `meal_time:<meal>`, `likes_spicy`. Only `false` on the
first two changes anything: `personalReason` answers `ordered_before` instead of `usual` at that
store (the product is still offered), and `likedTypesToOffer` skips the type. A `true` answer
boosts nothing. The Claude path gets the same: `suggest-service.js` runs `applyProfile` before
`aiChatTurn`, so `cardForDoc` sees `taste.rejected`, and `ai-chat.js` `tasteSummary` drops
rejected types from "Likes" and adds the stated cuisines ("Told us they like").

**Without a profile** `applyProfile` returns docs and taste untouched (no `_bias`, `stated` or
`rejected`), so every existing mode ranks and answers exactly as before — test "profile ranking:
with no profile the reply is exactly as before".

**Cart modes** (`cart: { appName, productIds }`; `fromCartStoreFirst` never offers a product of
the cart's store that is in `productIds`; reason = the personal one, else `popular` with evidence,
else `match`):

| mode | index clause (`modeClauses`) | pick (`suggest.js`) | stores | replyCode |
|---|---|---|---|---|
| `drink` | `course: "drink"` or `dishType: "drink"` | `isDrink` | the cart's store first (no cap), then other open stores ≤ 2 each | `drink_ideas` / `drink_unavailable` |
| `sweet` | `sweet: true`, `course: "dessert"` or `dishType: "dessert"` | `isSweet`: `sweet === true`, or `sweet` unknown + dish type dessert, or course dessert | same | `sweet_ideas` / `sweet_unavailable` |
| `cross_sell` | only when the cart's store is open: that store's `course` drink / side / sauce or `dishType` drink / side | `isAddOn` | the cart's store ONLY; nothing when it is not open | `cross_sell`, also when empty |

`course` is a Claude-label attribute (`null` without a trusted label), so sauces exist only as
labels; the `{ appName: 1, course: 1 }` index serves these clauses. The app
(`isChatOrderingEnabled`, `components/for-you/context-chips.ts` `chipsFor`): with items in the cart
the chips are "complete the order" · a drink · something sweet · surprise, and `drink` / `sweet`
are sent with the cart's store and product ids (`cartForServer` in `ForYouScreen.tsx`).
`cross_sell` is asked by the quick add (below), once per store per chat, right after a dish goes
in — with `dropIfEmpty`, so an empty reply shows nothing — and its cards render as compact
`CrossSellPill`s (`isCrossSell` in `ForYouScreen.tsx`). "Complete the order" and the cart dock
(`CartDock.tsx`, reads `cartStore`) open the normal `cart` screen; with an empty cart and an active
order the chips are "where is my order?" and "order again" (`usual`). The chat places no order.

**`hasRequiredOptions`** (`utils/extras-required.js`), set by `applyLiveMenu` on every card of both
paths: `true` when `soldByWeight === true` or any extra that is not `isGroupHeader` has `type`
`single` or `weight`. `required` is never read (§4) and a single with a `defaultOptionId` still
counts — "the product sheet has a choice to show", a superset of the app's add-to-cart block
(`validateWith`, which a defaulted single never trips). A row with no `extras` array answers
`false` unless it is `soldByWeight`. The app reads it as a HINT only: `true` opens the options
sheet at once (loading) while the menu loads; the decision is made on the full menu product.

**Quick add** (app only, no server change; `isChatOrderingEnabled`; built 2026-10-17) — the "+" on a
card (a stepper once the dish is in the cart; "−" removes the dish's last line at zero) or on a
cross-sell pill, through `hooks/useChatAddToCart.ts` `quickAdd`:
- **Open the store instead** (the card tap, `openStoreAtProduct`; logged as
   `for_you_quick_add_fallback` with the reason) for twin orders or a twin cart, a school cart, a
   failed load, an age-checked store not yet approved (`isCheckAge`), extras that are not an
   array, and whatever `chatSheetSupport` refuses: chips exist for `single` and `multi` ONLY, so a
   combo, `soldByWeight`, a `weight` extra or a legacy `categoryId: "weight"` one (priced at menu
   load), `pizza-topping`, `counter`, a group header with `freeCount > 0` (free toppings — the
   pricer applies them to `pizza-topping` only, §4), or any other type goes to the store's own
   product screen.
- **Load** the dish's store and menu with the fetch-only calls —
   `storeDataStore.getStoreDataFromServer(appName)` and `menuStore.getMenuFromServer(appName,
   false)` (`app-name: <the dish's store>`, `isSchoolProject=false`; cached 2 min per store in the
   hook). Never `getMenu` (it overwrites `menuStore.categories` / `generalCategories` /
   `outOfStockExtras` — the BROWSED store's), `getStoreData` or `setStoreDBName`. The product is
   found in `menu.menu[].products`, the full category list `GET /api/menu` returns for every store,
   tile-grid ones included. It is the customer menu (cached, hidden products already excluded).
- **Unavailable** — not found, `isInStore !== true`, `maxQuantity < 1` (stock cap only when
   `isStockManagment`), or a mandatory single with no option left (`mandatoryChoicesAvailable`;
   out-of-stock options matched by `nameAR` against the menu's `outOfStockExtras`, as the menu
   does) — and the chat says `add_unavailable` (an app-side message, not a server reply).
- **Build the line the menu would build** (`helpers/chat-cart-line.ts`): `prepareProduct` (deep
   copy, `ensureOptionIds`, `basePrice` / `baseOriginalPrice` from the menu's already-discounted
   price), `defaultSelections` (`resolveExtraDefaults`), `selectionsValid` (`validateWith` plus the
   `maxCount ?? max` cap the menu's checkbox enforces), and `priceLine` — the formula of
   `screens/meal/index2.tsx` and of the server's `utils/order-pricing.js`:
   `price = basePrice + (d > 0 ? Math.round(extras × (1 − d/100)) : extras)`,
   `originalPrice = baseOriginal + extras`, extras from `extrasStore.calculateExtrasPrice`. The menu
   screen was deliberately not refactored to share it, so the three must change together.
- **Straight in only when nothing is chosen for the customer**: no defaults and valid with no
   selection. Otherwise `ChatProductSheet.tsx` opens with the defaults pre-selected (a priced
   default is shown, never added silently); single replaces, multi toggles within its cap, an
   out-of-stock option cannot be picked. Closing it — an add, a dismiss, a fallback — only HIDES it
   (`hideSheet`); its content is cleared on the modal's `onModalHide` (`clearSheet`). Clearing both
   at once flashed an empty sheet (spinner, no photo, "₪0") for the length of the slide-out.
- **An order from one message** (`startFromReply`, `helpers/chat-order.ts`; CORE invariant 19): the
   chat's own lines `order_which_store` / `order_which_product` / `order_which_option` /
   `order_which_group` (chips, answered chips echoed as the customer's bubble, a new question
   scrolls into view), then `order_added` (+ `order_undo` / `order_edit`), `order_missing`,
   `order_out_of_stock`, `order_over_cap`, `order_note`, `order_complete_choice` (sheet),
   `order_open_store` (fallback). `applyOptionMatch` starts from the defaults minus out-of-stock
   ones, unselects `deselect`, adds `matched` (`addOption`: a `single` replaces, a `multi` adds
   within `maxCount ?? max`), applies an `ambiguous` word when the menu leaves one, else asks.
   «شو الإضافات؟» → `extras_list` from the loaded menu product (`extrasListText`: one line per
   group, prices when set, out-of-stock marked) with «اطلبها» (the normal "+").
- **The chat's store** (`forYouStore.focusStore`, CORE invariant 14): set from a reply's
   `storeScope`, from a TYPED reply whose cards all share one store, from `chooseStore` (the order
   flow's pick) and `afterAdd`; cleared by a new chat's first turn (`ask`, like `forPerson`). `ForYouScreen` `askText` sends it as
   `focusStore` (else the cart's store, when the cart has items). A `store_no_match` line gets the
   chips `store_others` («دوّر بمحلات ثانية» → the same text with `otherThan`) and `store_stay`
   («لا، خليني هون» → `store_stay`); copy `store_no_match` / `_any` (no dish words) / `_closed`.
   Store names are trimmed in the line (prod names carry trailing spaces).
- **Commit**: `cartStore.addProductToCartForStore(line, storeData)` stamps an empty cart with the
   dish's store, never the browsed one (orders domain). A cart of another store is never mixed or
   silently emptied — the chat asks (`store_conflict`: empty the cart and add / keep the cart).

**Arabic copy rule (app):** no punctuation straight after a final «ك» in `helpers/for-you-copy.ts` /
`helpers/ai-helper-copy.ts`. MiddleEast (Nomad Type, the app's only typeface) draws that glyph with
about 0.23 em of empty space on its left, so the mark looks detached («طلبك :»); measured with
CoreText 2026-10-19. `__tests__/helpers/arabic-punctuation-copy.test.ts` guards it until the font
itself is fixed (a licensed font — its designer's change, not ours).

Reported verified on the simulator, 2026-10-17 (`docs/ai-helper.md`): the order placed after a chat
add carried the chosen extras and the server's shadow pricing showed drift 0. Tests:
`__tests__/helpers/chat-cart-line.test.ts`, `__tests__/hooks/use-chat-add-to-cart.test.tsx`.

**Cuisines** — `getCuisines(appDb, lat, lng)` → `rankCuisines(types, rows, typeImages)`: the
ACTIVE `meal` dish types (`loadActiveDishTypes`) that occur in the given index rows, ranked by
distinct stores then summed `qty30d`, at most `MAX_CUISINES` (9), each
`{ key, label_ar, label_he, img, storeCount }`. The rows widen until a tier yields at least
`MIN_CUISINES` (4) types: (1) ALL the area's stores, open + closed (`getAreaStores`; closed = not
open now: closed, busy or coming soon) — there is no open-only tier: the onboarding builds a
standing taste profile, so the hour it is answered must not hide a cuisine; only the chat's cards
are limited to open stores — (2) the whole catalog — one
`aggregate` over `suggestProductIndex` (`$match` meal types, `$sort` by `qty30d` descending,
`$group` per dish type × store with that store's best seller's `img` and summed `qty30d`),
returned whatever its size. So `storeCount` can
count closed or far stores. Image: the type's `img` from `shoofi.dishTaxonomy` (active, non-empty
string — no code writes it, §2), else the `img` of the best-selling row of that type in the tier
used; a type with no image is left out. Central index only — no store DB, no menu cache; the
whole-catalog tier is a deliberate platform-wide read that returns only type labels, image paths and
counts. The app enables "next" on an empty list (`OnboardingSteps.tsx`) and asks for 2 picks
otherwise.

**Flags** — `isAiHelperEnabled`, `isAiHelperForAll` (off = Shoofi employees only),
`isAiHelperOnboardingEnabled`, `isChatOrderingEnabled` on the central platform config document,
public through `SHOOFI_CONFIG_PUBLIC_FIELDS` (`routes/store.js`), toggled under Settings → Shoofi
(delivery-web `ShoofiSettings.tsx`). All default off; no server endpoint reads them. Tests:
`test/integration/ai-helper.js`. The chat-minimize pair comes right after them (§7g).

## 7g. The minimized chat — a floating bubble (app only; CORE invariant 20)
**Flags** `isChatMinimizeEnabled` + `isChatMinimizeForAll` (off = Shoofi employees only), gate
`isChatMinimizeOn` in `components/for-you/bubble-math.ts`; in `SHOOFI_CONFIG_PUBLIC_FIELDS` after the
four AI-helper flags (`test/integration/config-home-layout-flags.js` asserts all six are served),
switches under Settings → Shoofi (`ShoofiSettings.tsx`), default off. No server change otherwise.

**State** (`stores/for-you`, session-only, nothing persisted): `chatUi { mode: "full" | "minimized"
| "closed", bubble: { side, y } | null, unread, peek }`, plus `draft`, `scrollOffset`, `closedToast`.
A bot turn that lands while minimized adds to `unread` and sets `peek` (a 4 s peek from the bubble);
`openFull()` clears both. `reset()` clears the conversation only (messages, busy, draft, scroll).

**Lifecycle** (`ForYouScreen.tsx`). Flag OFF: `reset()` on mount and on unmount, as before. Flag
ON: a chat with messages is RESTORED on open (`restoring`, unless it comes from the onboarding) —
a home chip still asks its mode after what is there — and leaving it closes the window
(`close()`) unless it was minimized; coming back into focus from a store makes it full again.

**Full screen** (every customer, not only the flag): `for-you` is in `hideHHeaderScreens`
(`components/layout/header/header.tsx`), so no app header (address / coins) is drawn above the chat;
its own header sits right under the status bar.

**Minimize** — the header's ONE chevron (`for-you-minimize`, `components/for-you/ChatHeader.tsx`: at
the PHYSICAL left end; on the right the 36 px persona, the name `ai_helper_name` and the subtitle
`for_you_header_sub`, no divider; laid out `direction: "ltr"` so Arabic and Hebrew match; no grab
handle, no ×; flag off: today's back arrow and title), a header swipe down (released past 120 px or at over 600 px/s), back
or the edge swipe, or a card tap (it still opens the store; with the flag the chat minimizes instead
of closing). Back and the edge swipe minimize a USED chat — a turn of the customer's own
(`forYouStore.customerTurns`) or items in the cart — and just close an unused one (`leaveAction`).
They arrive through a `beforeRemove` listener that acts only on the customer's own back
(`isUserBack`: `GO_BACK` / `POP`) — a reset after an order, a replace or a navigate always goes
through. The stack's swipe-back is off app-wide (`gestureEnabled: false`) and has no
gesture-handler root above the navigator, so on iOS the chat draws its own edge swipe: a 14 pt
strip on the PHYSICAL right edge (RTL's back edge), below the header, past 30 % of the width or a
fling. The chat leaves with no stack animation after drawing its own transition into the bubble.

**The "C · Genie" transition** (Sari, 2026-10-19 — replaces PROMPT.md §6 "Shrink" / "Expand"):
keyframes in `components/for-you/genie.ts` (pure, `__tests__/components/genie.test.ts`). One value
`m`, 0 = full screen, 1 = in the bubble: `m` 0 → 0.45 → 1 is scaleX 1 → 0.5 → 64/W, scaleY
1 → 0.92 → 64/H, radius 44 → 90 → 800 clamped to half the box (square at rest), opacity
1 → 1 → 0.2 — it narrows first, then drops in. 520 ms (`GENIE_MS`), `Easing.bezier(0.6, 0, 0.3, 1)`,
UI thread only, the whole chat in one `Animated.View` (absolute fill, clipped), scaled about the
bubble's centre by translation (`genieTranslate`). The open is the same curve backwards. The header
drag drives only the narrowing (`m = clamp(dy / (H · 0.55), 0, 0.45)`) and, released, finishes in
`520 · (1 − m)` ms or springs back. Closing, NO part of the chat stays on screen (Sari): the close
fades it fully out by `m` 0.9 (`GENIE_HANDOFF`; the open keeps the 0.2) and hands over there — the
chat hidden on the UI thread, then the store goes minimized and the screen pops — instead of
waiting out the curve's slow last ~160 ms. The bubble then LANDS (`landingFrame`, in
`ChatBubbleOverlay`): drops from 90 pt above, squash 1.22 × 0.78 at 55 %, stretch 0.9 × 1.12 at
75 %, 620 ms ease-out, a light haptic at 340 ms; "رجّع" still pops it back the old way. While it
moves the chat is a still picture: no scrolling, the persona's and the typing dots' loops paused
(`still` / `paused`), the root rasterized only then. Reduce Motion: a 200 ms crossfade, no drop
or bounce. `GENIE_UNIFORM` (one scale on both axes, Android only) is OFF — the low-end Android
50 fps check that would decide it has not been run (`.maestro/genie/README.md`).
During the bubble transitions (the `restore` expand route, and from the moment a minimize starts) the
chat's card is see-through — `CHAT_SEE_THROUGH_OPTIONS` (`components/for-you/chat-layout.ts`:
`transparentModal`, transparent card, no dim, the screen underneath kept attached and NOT
parallax-shifted) — or it flashes white. The frame the genie scales about is measured on an
UNTRANSFORMED wrapper (`measureInWindow` on the animated root returns the transformed rect), and
measured again ON THE TAP: the mount's measure can land mid-push, with `x` off by up to a screen
width, and the chat then aimed at the mirror of the bubble's spot (recorded; the pre-genie shrink
had the same bug).
With the flag, `chatBottomSpacing` (`components/for-you/chat-layout.ts`) sets the bottom: the input
8 pt above the safe area, chips → input 8, dock → chips 8, no divider above the chips. With the
flag the CHAT owns its bottom inset: `AppContainer` drops its bottom edge for `for-you`
(`chatOwnsInset`) and the chat pads `inset + 8` itself (`parentAppliesInset: false`). An inset
applied there resized home — drawn under the see-through chat — by ~34 pt while the chat was up,
so home's floating footer rose on open and dropped on close (Sari, 2026-10-19). Flag off: the
parent still applies it, today's values.

**The bubble** (`ChatBubbleOverlay.tsx`, mounted once in `components/layout/app-container/index.tsx`
with the focused leaf route name): 64 px, drags 1:1, snaps to a side (fling projected 0.18 s),
clamped under the safe area and above the tab pills on `TAB_BAR_ROUTES`, remembers its spot, shows
the cart count, laid out `direction: "ltr"` so positions stay physical under forced RTL. Hidden
(`overlayVisible`) while the keyboard is open and on `BUBBLE_HIDDEN_ROUTES` — the chat, checkout,
pick-time, credit cards, order-submitted, login, verify-code, insert-customer-name, the onboarding
and the admin's product preview.

**Expand** (tap): `openFull()`, then `StackActions.popTo("for-you", { restore: true })` when a chat
is still in the root stack (e.g. under the store a card opened), else
`navigate("for-you", { mode: "opener", restore: true })`; `MainStackNavigator` gives `for-you`
`animation: "none"` plus `CHAT_SEE_THROUGH_OPTIONS` when `params.restore`, and the chat genies out of
the bubble (520 ms) once its frame is measured — hidden until then — with scroll offset and draft
restored. The bubble is gone from the tap's first frame (`openFull()` unmounts it).

**Close** — drop the bubble on the × (60 px target, 80 px magnet, haptic): `close()` changes
`chatUi` only, a chat left under a store's menu is removed from the stack (so back does not land in
it), and the `for_you_closed_toast` toast offers "رجّع" for 3.5 s (`undoClose()` → minimized again).
**The cart is never touched**: the bubble reads `getProductsCount` and calls no cart mutator.
`AiHelperFab` stays hidden while the chat is open (`chatUi.mode` "full" — the genie lands on its
spot, which must be empty), while the bubble is out or the toast is up, then springs back.
Tests: `__tests__/components/bubble-math.test.ts`, `__tests__/stores/for-you-chat-ui.test.ts`;
`__tests__/components/genie.test.ts`; Maestro `.maestro/chat-minimize/`, `.maestro/genie/`.

## 7h. For you quality — the funnel, the health numbers, the nightly reviewer (CORE invariant 22)
Server `services/for-you-quality/` (`events.js`, `funnel.js`, `health.js`, `reviewer.js`,
`targets.js`), `routes/admin/for-you-quality.js`, `utils/crons/for-you-review-cron.js`; tests
`test/integration/for-you-quality.js`; full write-up `docs/for-you-quality.md`. Admin screen
**איכות For you** (delivery-web `views/admin/for-you-quality/`, `master|admin`).

**What the app sends.** `/api/for-you/suggest` takes `conversationId` (`[A-Za-z0-9_-]{6,64}`, born
with a chat's first turn — `ask()` on an empty chat, which is how every chat starts and what
`reset()` and logout leave behind; `reset()` itself is pinned in §7g and unchanged) and `surface`
(`home` | `chat`); both land in the `forYouServed` row with the reply time, Claude's shortlist
names, and per card its name, store, `spicy` and `sweet`. An app without them still works: its
home loads are then reviewed as conversations, grouped by owner with a 30-minute gap.

**Central collections** (all `shoofi`):
- `forYouEvents` — the app events the funnel reads, copied by `app-logs/insert` (customer
  app only; 90-day TTL on `created`; no `userId`). Copied: `button_clicked` / `impression`
  whose id starts `for_you_` or `ai_helper_`; `page_viewed` `for_you`, `ai_helper_onboarding`,
  and `ProductAddToCart` with `source: "for_you_chat"`; every `cart_checkout_pressed`,
  `cart_checkout_blocked`, `checkout_validation_failed`, `order_submit_error`,
  `order_submit_success`, `checkout_left`.
- `forYouReviews` — one per conversation per Israel day: masked turns and cards, outcome
  (tapped / added / ordered via `suggestionId` and `for_you_suggestion_ids`), `checks`,
  `severity`, `priority` (queue order: critical 0, judged bad 1, partial 2, flagged unjudged 3,
  flagged judged good 4, rest 5), `judge`, `status` (open · agreed · disagreed · fixed · dismissed
  · in_tests), `human`; `owner: { kind, hash }`. 90-day TTL on `createdAt`.
- `forYouReviewRuns` — one per run: counts, cost, `budgetHit`, `judgeSkipped`, `alreadyJudged`.
- `forYouGoldenCases` — "add to tests": masked turns, dish names, avoid keys, the person's note as
  the expectation; no customer id, no TTL. Nothing runs them automatically yet.

**The funnel** — one phone (`user_visit_id`) per Israel day: seen → opened → chat_opened →
engaged → picked → ordered (`order_submit_success.for_you_lines > 0`), each with its conversion,
target and the reasons of the ones who stopped; plus the home shortcut, personalization
(offered / started / finished / skipped / quit, where they quit, median time) and chat cart →
order. **Health** — from `forYouServed` + `aiUsage`: path mix, fallback reasons, empty /
unavailable / fallback rates, p50/p95 by path, avoid conflicts replayed on the stored labels,
spend for `for-you-chat` and `for-you-review`.

**The reviewer** — `30 5 * * *` Asia/Jerusalem under `ENABLE_CRONS` (lock `cron:for-you-review`),
or `POST /api/admin/for-you-quality/review/run { day? }` (202, or 409 when locked — always 409
without Redis). Checks: `avoid_conflict` and `ignored_negation` (critical); `error_reply`,
`empty_reply`, `slow` (rules 3 s / Claude 6 s), `ai_timeout|ai_api_error|ai_parse|ai_filtered`,
`rephrased_no_pick`, `no_engagement` (warn). The judge reads critical → typed → flagged → a sample,
at most `forYouReviewMaxPerDay` (300), until today's `for-you-review` spend reaches
`forYouReviewDailyBudgetUsd` ($3; ≈ $0.006 per conversation on Sonnet 5). It answers `{ verdict,
score, issues[code], explanation, fix{type} }` in Hebrew; unknown codes are dropped.

**The testing team's flag** — employees only, under each chat reply: «مش مزبوط؟» → reason chips
(`dishes` · `wording` · `missing` · `slow` · `other`) + a note ≤ 500 → `button_clicked`
`for_you_feedback` `{ suggestionId, conversationId, replyCode, cards, reasons, note }`. The event copy
calls `reviewer.recordFeedback`, which writes the conversation's review now (`flags[{ turn,
suggestionId, at, reasons, note }]`, `flagged: true`, `priority: -1`) if the audit row's owner is an
employee (skips: `no_reply`, `unknown_reply`, `visitor`, `home_box`, `not_employee`). The queue API
takes `flagged=1` and returns `flaggedOpen`.

**Admin API** (`auth.required` + `checkAdminRole(["master","admin"])`): `GET
/api/admin/for-you-quality/funnel?from=&to=`, `GET …/health?from=&to=` (Israel days, ≤ 31),
`GET …/reviews?day=&severity=&status=&verdict=&limit=&skip=` (+ `bySeverity`, `byVerdict`,
`calibration`, `lastRun`), `GET …/reviews/:id`, `POST …/reviews/:id/decision { action, verdict?,
note? }`, `POST …/review/run`.

## 7i. Extras icons — the save hook, the nightly sync and map.json (CORE invariant 29)
Full detail: shoofi-server `docs/extras-icons.md`.
- **Slots read** (`collectExtraNames`, `utils/extras-icons/match.js`): every option of a non-header
  extra, and the extra's own name when it has no options (a counter). Group headers are skipped. The
  same slots the app draws icons on.
- **Save hook** (`noteProductExtrasInBackground`, `services/catalog/extras-catalog.js`): one aliases
  `find({_id:{$in}})`, one queue upsert per unknown name (`$setOnInsert` status, `$addToSet` stores).
  Not awaited by the route; any error is logged and swallowed.
- **Nightly** (`runExtrasIconsSync`, `services/catalog/extras-icons-sync.js`; cron
  `utils/crons/extras-icons-sync-cron.js`, `SCHEDULE = "45 4 * * *"`, lock `cron:extras-icons-sync`
  1 h, gated by `readSyncFlags` → `isExtrasIconsSyncEnabled` / `extrasIconsSyncDryRun` on
  `shoofi.store {id:1}`): scan every non-`isMockStore` store → queue unknown → `ruleMatch` → Haiku
  (`MODELS.fast`, `backend: "api"`, `temperature: 0`, no `effort`, 40 names a call, 2 parallel,
  `maxTokens` 6000, halve on cut-off/unreadable, `MAX_CLASSIFY` 600 a run, label `extras-icons`) →
  `classify.decide` → `rebuildAndPublish`. Unanswered names retry; after `MAX_ATTEMPTS` (3) they go to
  `review`. No API key: scan, rules and publish still run (`classifySkipped: "no-api-key"`).
- **map.json** (`buildMap`, `utils/extras-icons/map.js`): `{ v: 1, generatedAt, n: { key: file | "file|w" } }`,
  keys sorted, own `iconFile` else `parent` chain (≤ 4). `putMap` writes only
  `extras-icons/v1/map.json` (`max-age=3600`); `putIcon` HEADs first and never overwrites
  (`immutable`). Checked 2026-10-30: the seed reproduces all 3,191 names it shares with the live
  map, except `xl`. The size "XL" (90 options) now wins over the energy drink "xl" (5 options).
- Tests: `test/integration/extras-icons.js` (app parity, rule, seed vote, map, publish guard, decide,
  sync/dry run, save hook never blocks, admin auth).

## 8. Cross-repo consumers (inferred from endpoint surface — not verified against client repos)
- **Customer app** (`shoofi-app`/`shoofi-shopping`): `GET /api/menu`, `/api/menu/mock`, `/api/menu/search`, `/api/category/general/all`, `/api/getTranslations`, `/api/global-search`; listens for `menu_refresh`; sends `x-client-features: combo` from the bundle that renders combos (§6b). "For you":
  `POST /api/for-you/suggest` from `components/for-you/` + `screens/for-you/`, gated on the
  platform flags `isChatSuggestEnabled` / `isChatVoiceEnabled` / `isChatSuggestForAll` (entry shown to
  Shoofi employees only until the last is on; the mic is on-device speech-to-text in
  `hooks/useVoiceInput.ts`, shown only when the binary has the native module, and its transcript
  is sent as the same `text`); a card tap navigates to
  `menuScreen` with `productId` (`utils/open-store-at-product.ts`, wrapped by the
  `hooks/useOpenStoreAtProduct.ts` hook; marketing links — banner, story, push — use the same
  function), and the menu list opens the
  sheet by matching `products[]._id`: `AllCategoriesList` searches `categoryList[].products`;
  for tile-grid stores (`store.hasGeneralCategories`) `GeneralCategoriesList` receives the
  general categories, which carry NO `products` of their own, so it searches
  `generalCategories[].subCategories[].products` (and any direct `products`). Covered by
  `__tests__/components/general-categories-open-product.test.tsx`. Never navigate to the
  `meal` route for this — it is broken.
  AI helper (§7f): the floating persona `components/ai-helper/AiHelperFab.tsx` on home
  (`screens/explore.tsx`, `isAiHelperEnabled && (isAiHelperForAll || isShoofiEmployee)`, not in map
  mode; it hides the For-you home entry). A tap opens the taste onboarding (`screens/ai-helper/`)
  when `isAiHelperOnboardingEnabled` and `decideFabRoute` (`stores/ai-helper/index.ts`: not onboarded,
  not skipped in the last 7 days) says so, else the chat. The onboarding's cuisine tiles come from
  `GET /api/ai-helper/cuisines`, the avoid chips mirror `GUARANTEED_AVOID`, and the chat's first
  opener after it sends `onboarded: true` (`fromOnboarding` route param). With
  `isChatOrderingEnabled` the chat shows the cart dock and the cart chips (`components/for-you/`
  `CartDock.tsx`, `context-chips.ts`), sends `drink` / `sweet` with `cart`, and adds to the cart
  itself: a "+" (a stepper once in the cart) on every `SuggestionCard` and `CrossSellPill`, the
  options sheet `ChatProductSheet.tsx`, all through `hooks/useChatAddToCart.ts` +
  `helpers/chat-cart-line.ts`, which then asks `cross_sell` (§7f). Copy:
  `helpers/ai-helper-copy.ts` (onboarding, `ai_helper_avoid_*`, `ai_helper_avoid_best_effort`) and
  `helpers/for-you-copy.ts` (`for_you_reason_you_like`, `for_you_reply_opener_onboarded` /
  `opener_stated` / `drink_*` / `sweet_*` / `cross_sell`); `SuggestionCard` counts `you_like` as a
  personal tag. With `isChatMinimizeEnabled` (§7g) the chat minimizes into the floating
  `ChatBubbleOverlay` (mounted in `components/layout/app-container/index.tsx`); a tap brings the same
  conversation back.
  Store cards (`screens/stores/components/item.tsx`, used by home, the store lists and search)
  render the server's `store.isNew` as a "جديد"/"חדש" badge (CORE invariant 25).
  Categories and explore (verified 2026-10-30, all before login, the **[public]** routes of CORE
  invariant 27): `POST shoofiAdmin/category/list` (`App.tsx` boot), `GET category/general/all` and
  `GET shoofiAdmin/explore/categories-with-stores-v2` (`screens/explore.tsx`). `stores/shoofi-admin`
  still defines v1 explore, `explore/clear-cache` and `explore/cache-stats` calls, but nothing calls
  those methods.
- **Partner app** (`shoofi-partner`): product write + ordering endpoints; sends `app-type: shoofi-partner` to see hidden products; listens for `product_updated`. The product calls are all in `stores/menu/index.ts`, made with `Authorization: Token` and `app-name` set to the current store (`@storage_storeDB`, set together with the token by `switchStore`). They are: `insert`/`update` (`screens/admin/product/add`), `delete` (`screens/menu/components/categoryItemsList.tsx`), `update/isInStore` (stock screen, product items, the order list), `update/isInStore/byCategory`, `update/quantity`, `update/activeTastes` (`screens/admin/stock-management`), `update/isHidden` (product items) and `update/order` (`screens/admin/products-order`). These are exactly the **[admin|own store]** routes (§7). `GET extras` is defined there but nothing calls it. Categories (verified 2026-10-30): only the two public reads, `POST shoofiAdmin/category/list` (`App.tsx` boot, `stores/shoofi-admin`) and `GET category/general/all` (`screens/explore.tsx`); it writes no category (CORE invariant 27).
- **Admin web** (`shoofi-delivery-web`/`shoofi-admin`): category CRUD, product ordering/migration, translations CRUD, store config toggles (`isStockManagment`, `hasGeneralCategories`). "סוגי מנות (בשבילך)" at `/admin/dish-types` (`src/views/admin/dish-types/DishTypes.tsx`, API wrappers `src/apis/admin/dish-taxonomy.ts`): approve/reject/edit dish types, the "מוצרים לבדיקה" review list, run history with token counts, and a manual run. Platform flags `isChatSuggestEnabled` / `isChatVoiceEnabled` / `isChatSuggestForAll` ("For You — Open To All Customers"; off = Shoofi employees only) under Settings → Shoofi, and the AI helper's `isAiHelperEnabled` / `isAiHelperForAll` / `isAiHelperOnboardingEnabled` / `isChatOrderingEnabled` beside them (`src/views/admin/settings/ShoofiSettings.tsx`, §7f), then the chat's `isChatMinimizeEnabled` / `isChatMinimizeForAll` (§7g). Product routes it calls, all through `utils/http-interceptor` (`Bearer`, `app-type: shoofi-admin`): `GET admin/product/:id`, `insert`, `update` (`views/admin/product.tsx`), the same three plus `import-index` (`views/admin/stores/ImportCategoriesProducts.tsx`), `delete`, `order/:categoryId`, `update/order-per-category`, `reset-order/:categoryId`, `migrate-orders` (`views/admin/Products.tsx`), and `product/mock-store/:x` + `product/create-from-mock` (`views/admin/stores/CreateProductFromMock.tsx`). It does NOT call `update/quantity` or the other availability toggles; those come from the partner app. `src/apis/admin/product/product-order.ts` (`bulk-reorder`, `update/order`) is imported by nothing. The store form's "تاريخ الافتتاح" (`launchDate`, `src/views/admin/stores/StoreForm.tsx`) and Settings → Shoofi → "New Stores" (`newStoreWindowDays`) drive the store card's "new" badge (CORE invariant 25). Category and explore routes (verified 2026-10-30, all through `axiosInstance`, the **[admin]** routes of CORE invariant 27): `views/admin/categories.tsx` + `AddCategory.tsx` (`shoofiAdmin/category/*`, `category/by-general/:id`), `CouponForm.tsx` / `CouponTemplatePicker.tsx` (`GET shoofiAdmin/category/list`), `general-categories/{GeneralCategoriesList,GeneralCategoryForm}.tsx` (`category/general/*`), `store-categories/{StoreCategoriesList,StoreCategoryForm}.tsx` (`store-category/*`), `stores/ImportCategoriesProducts.tsx` and `StoresList.tsx` (both families), `components/admin/MockProductSelector.tsx` (`all/by-store`), `ApiMonitor.tsx` (`explore/{cache-stats,clear-cache,clear-cache-keys}`). The exception: `apis/admin/category/get-categories.ts` (`GET admin/categories/:page`, `StoreForm.tsx`) uses plain `axios` with no token. `GET /api/store/get/:appName` (all through `axiosInstance`): `components/Navbars/AdminNavbar.js`, `DriverAvailabilityMonitor.tsx`, `settings/ShoofiSettings.tsx` (`shoofi`), `accounting/{AccountantFileNumber,BankAccountDetails,ContractDetails}.tsx`, `generate-stores-summaries.tsx`, `product.tsx`, `stores/StoreData.tsx`.

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
  _Note (2026-10-26, not a verdict change):_ only the READ uses that header. The three panel
  WRITE routes pick the DB from `app-name` (default `shoofi`). The admin panel sends
  `app-name: 'shoofi'`, so it lands correctly, but any other caller can write into a store DB
  where nobody reads. Code writes go through `writeOwnedTranslation`, which is pinned to the
  central DB (CORE invariant 24).
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
