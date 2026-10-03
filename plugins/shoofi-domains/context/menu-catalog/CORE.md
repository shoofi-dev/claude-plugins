---
domain: menu-catalog
last-verified: shoofi-server@6a87cf44 / 2026-10-03
scope: server-first (shoofi-server; clients mostly render what the server assembles)
reference: ./reference.md   # data model, endpoint tables, flows, options/extras detail
---

# Menu / Catalog — CORE (always read)

Products, categories, menu assembly, options/extras, availability & stock, catalog i18n.

## Scope
Server: `routes/menu.js`, `routes/product.js`, `routes/category.js`, the catalog slice of
`routes/store.js`, `routes/translations.js`, `routes/global-search.js`, `utils/menu-cache.js`,
`utils/order-stock.js` (stock semantics only), `utils/weight-extra-invariant.js`,
`utils/catalog-lint.js` (the extras lint rules), `services/catalog/catalog-lint.js` (the
worklist writer + nightly run), `routes/admin/catalog-lint.js`, `utils/crons/catalog-lint-cron.js`,
the combo-deals trio `utils/combo-validation.js`, `services/menu/combo-snapshots.js`,
`utils/client-features.js`, and the "For you" suggestions — `services/ordering-intelligence/`
(the catalog-facing parts are `index-builder.js`, `dish-types.js` and the live re-check in
`suggest-service.js`; ranking/taste/open-stores ride along), `routes/for-you.js`,
`utils/crons/suggest-index-cron.js`, `bin/build-suggest-index.js`, and the dish labelling behind
it — `services/ordering-intelligence/{taxonomy,product-labeler,craving}.js`,
`utils/crons/product-labels-cron.js`, `routes/admin/dish-taxonomy.js`, `bin/label-products.js`
(admin web: `src/views/admin/dish-types/DishTypes.tsx`, `src/apis/admin/dish-taxonomy.ts`), and the
monthly menu spellcheck — `utils/menu-spellcheck-text.js`, `services/catalog/menu-spellcheck.js`,
`utils/crons/menu-spellcheck-cron.js`, `routes/admin/menu-spellcheck.js` (admin web:
`src/views/admin/stores/MenuSpellcheck.tsx`, `src/apis/admin/menu-spellcheck.ts`).
Docs: `docs/stock-management.md`, `docs/menu-search.md`, `docs/sold-by-weight.md`,
`docs/menu-import-issues.md` (the worklist — now also documents the `lint` phase),
`docs/combo-deals.md`, `docs/for-you.md`, `docs/menu-spellcheck.md`.
Mostly **server-first**: catalog data is server-owned and clients render it — but if a task
needs a client change (partner product screens, customer menu display), do it full-stack,
one PR per repo.
**Not yours:** order creation/status, payments, delivery, auth. ⚠️ `utils/order-stock.js` is
**shared with the order flow** (called on confirm/cancel) — treat edits there as a review
boundary and say so in the PR.

## Invariants — never weaken
1. **Multi-tenant scoping:** every query goes through
   `const db = await getOrInitializeDb(req.headers['app-name'], req.app.db)`.
   Central = `req.app.db['shoofi']`. A wrong DB leaks one store's catalog into another —
   the worst failure in this domain.
2. **CACHE RULE — any write that changes menu output MUST clear BOTH keys:**
   `menuCache.clearStore(appName)` **and** `menuCache.clearStore(\`${appName}_schoolProject\`)`.
   Missing one serves a stale menu for up to the 5-minute TTL. Menu cache is **customer-only** —
   admin/partner bypass it, so never add caching there (hidden products would leak).
3. **Displayed price is derived at READ time** from the category's `discountPercent` (max across
   the product's categories). The stored `product.price` is **not** what the customer sees.
4. **Stock invariant** (stock-managed stores, `store.isStockManagment`): `quantity <= 0` ⟺
   `{ isInStore:false, outOfStockByQuantity:true }`. **Human-confirmed: applies to ALL products,
   no exceptions.** Decrement only on order confirmation; restore only re-enables products that
   were `outOfStockByQuantity` (never un-hides a manual disable).
5. **`supportedCategoryIds` are STRINGS**, compared via `{$toString:'$_id'}`. Don't switch to
   ObjectId comparison without a data migration.
6. **Product ordering** comes from `categoryOrders[categoryId]`, falling back to legacy `order`.
7. **By-weight price invariant:** a by-weight product stores its weight as an extra of
   `type:"weight"` (`{min,max,step,defaultValue,price,unit?}`, `price` = price of ONE step) and
   must satisfy `product.price === extra.price * (defaultValue / step)` to the agora. Which
   products it binds to: a product with `soldByWeight === true` (the weight extra whatever
   sits beside it) or, unflagged, a product whose ONLY non-header extra is the weight
   (`selectWeightExtra` / `getWeightExtra` in `utils/weight-extra-invariant.js`). Every
   writer of `product.price` or `extras` re-derives `extra.price` from the product price in
   the same write: product create/update/create-from-mock (`normalizeWeightExtraPrice`) and
   `services/catalog/bulk-price-update.js`. Never add a product-price writer that skips it.
   See `docs/sold-by-weight.md` for the flag, the unit, and the rollout scripts.
8. **A BULK TOOL MAY NOT WRITE A PRICE IT CANNOT INTERPRET.** Invariant 7 is about keeping
   the two prices consistent; this one is about the two prices a *file* cannot express:
   - **`price: 0` means "not for sale"** — `utils/crons/hide-zero-price-products.js` hides
     every product carrying it. So a **blank** cell in an import/price file is NOT 0. Parse it
     to `null` and omit the field; only an explicit 0 is posted. `POST
     /api/admin/product/update` writes only the keys it receives
     (`if (req.body.price !== undefined)`), so **omitting is the whole mechanism**.
   - **A by-weight product's price cannot be taken from a sheet at all.** By invariant 7 it is
     the price of `defaultValue` and the per-step rate is re-derived from it — so a bare
     number with no unit rewrites the per-kilo rate too, invisibly, with no audit trail on
     product updates. Bulk tools **skip these and report them by name** for a human to edit;
     they do not guess. (`bulk-price-update` is the exception and may write, because its file
     is a round-trip of our own export and the units are ours.)

   `GET /api/admin/product/import-index` computes `isByWeight` in the aggregation so the extras
   never travel to the browser. It answers **both** halves of invariant 7's test: flagged
   (`soldByWeight === true` plus exactly one non-header `weight` extra, however many other
   extras sit beside it) and legacy-unflagged (the sole non-header extra is the weight one).
   It deliberately does **not** also require `step > 0 && defaultValue > 0` the way
   `isSoldByWeightProduct` does — that pair decides how to *price*, while this flag decides
   whether a bulk tool may *overwrite* a price, and a flagged product with a malformed weight
   extra is the last one to hand to an importer. Consumers must treat a **missing**
   `isByWeight` key as "this server is too old to tell me" and say so out loud: the aggregation
   sets it on every row, so absence never means "this store has no by-weight products".
9. **Extras are linted on every product write** (`routes/product.js` insert / update /
   create-from-mock → `catalogLint.lintForWrite`, rules in `utils/catalog-lint.js`). The lint
   runs AFTER `normalizeWeightExtraPrice`, on the extras about to be saved. Three outcomes, by
   code, not by severity:
   - **auto-repaired and saved** (`autoRepaired: true` on the issue): `EMPTY_OPTION_ID`
     (the #205 planner — fresh admin-editor-shaped id, blank `defaultOptionId` /
     `defaultOptionIds` entry follows it when exactly one option was empty, cleared otherwise),
     `DUPLICATE_OPTION_ID` (the LATER duplicate is re-id'd; the first keeps its id — past
     orders, reorder and amend resolve against it), `DEFAULT_NOT_IN_OPTIONS` (dropped);
   - **refused with `400 { code: "CATALOG_INVALID", issues }`** — `REJECT_CODES` =
     `PIZZA_AREA_VOCAB`, `SINGLE_WITHOUT_OPTIONS`. Nothing is written and no cache key is
     cleared. Both admin editors (delivery-web + partner `ExtraEditModal`) always write all
     three pizza areas, so a product they produce never trips this;
   - **saved anyway, recorded, returned as `lintIssues`** — everything else (warnings and
     `REQUIRED_GROUP_ALL_OUT_OF_STOCK`, which is critical but is a stock state, not a data
     defect). Recorded on the store's `menu-import-issues` (phase `lint`) via
     `recordProductLintIssues`, scoped to that product, BLOCKED rows excluded.
   A product with no issues takes exactly the path it took before — same response body, no
   `lintIssues` key. `POST /api/admin/product/update` lints only when the request sends
   `extras`; an image-only or price-only save is never refused for defects it did not touch.
   Rule table, codes and the nightly run: reference §4 and §7b.
10. **COMBO PRODUCTS REFERENCE, NEVER COPY** (`docs/combo-deals.md`). A combo is a product
   *kind* — `productType: "combo"` (absent / `""` / `"regular"` are all regular) carrying
   `combo.sections[{ id, nameAR, nameHE, order, count, options[{ productId, surcharge }] }]`,
   whose options point at real products of the SAME store. Nothing about a component is ever
   stored on the combo: the menu embeds a live snapshot at read time and the order pricer
   re-reads the component's extras from the catalogue. What keeps that sound:
   - **Every write runs `utils/combo-validation.js`, in order:** `parseComboBody`
     (`PRODUCT_TYPE_INVALID`, `COMBO_NOT_JSON`; a `combo` body on a regular product is
     **dropped**), `validateComboShape` (non-empty sections, unique section ids, a name,
     numeric `order`, integer `count ≥ 1`, non-empty options, `productId` unique per section,
     `surcharge ≥ 0` defaulting to 0 — and the definition is **normalised to exactly those
     fields**, so a `product` snapshot a client echoes back from the menu is never persisted),
     `validateComboProductFields` (`COMBO_SOLD_BY_WEIGHT`; `COMBO_PRICE_REQUIRED` — `price`
     must be > 0 because 0 means "not for sale", invariant 8), then `validateComboReferences`
     with **ONE** `products.find` projected `{ productType, soldByWeight }`:
     `COMBO_COMPONENT_NOT_FOUND`, `COMBO_SELF_REFERENCE`, `COMBO_NESTED` (no combo inside a
     combo), `COMBO_COMPONENT_SOLD_BY_WEIGHT`. Every refusal is
     `400 { message: "Invalid combo", code: "COMBO_INVALID", errors: [{ code, sectionId?, productId?, … }] }`.
   - **Demotion is a `$unset`.** Update keeps omit-to-skip: with neither `productType` nor
     `combo` in the request the stored kind is untouched (an image-only save from the partner
     app). The web form always sends `productType`, so `productType=regular` on a stored combo
     is a demotion and the route `$unset`s `productType` + `combo` — the write is `$set` of the
     whole spread document, so deleting the keys from it alone would write nothing. Reference
     checks run only when `combo` or `productType` was actually sent.
   - **A referenced product cannot be deleted on its own.** `POST /api/admin/product/delete`
     answers `409 { code: "PRODUCT_REFERENCED_BY_COMBO", data: { combos: [{ _id, nameHE, nameAR,
     blockedProductIds }] } }` (query on `combo.sections.options.productId`). Deleting the
     combo together with its parts in one request is allowed — the combo is excluded from the
     lookup.
   - **The menu snapshot is resolved with ONE find, ignoring `isHidden`.**
     `services/menu/combo-snapshots.js` `resolveComboSnapshots` attaches `option.product`
     (`SNAPSHOT_PROJECTION`, run through `applyProductDiscount` so its `price` is the number on
     the component's own card) for every option of every combo in one `products.find`. A hidden
     component is still a valid pick inside a deal; a deleted one resolves to `product: null`
     plus a warning, never a thrown menu. Zero cost for a store without combos. It runs in
     `GET /api/menu` AND `POST /api/menu/refresh` **before the cache is written**, so the cache
     always holds the complete menu.
   - **`x-client-features: combo` is applied AFTER the cache read and never keys the cache.**
     A customer request without the header gets `stripCombos(menu)` — combo products removed,
     and any category or general-category subcategory that held ONLY combos removed with them
     — on a cache hit exactly as on a fresh build (`stripCombos(cachedMenu)`). The cache stays
     keyed by store (+ school-project), never by capability; admin/partner `app-type`s are never
     stripped; `POST /api/menu/search` applies the same gate. There is no feature flag: a store
     having a combo product is the flag. (`utils/client-features.js`; reference §6b.)
   - **Mock stores refuse combos.** `POST /api/product/create-from-mock` on a combo template is
     `400 COMBO_NOT_CLONEABLE`, and `GET /api/menu/mock` never offers one — its option ids
     belong to the template store.
   Phase-1 limits: no combo inside a combo; never `soldByWeight` on either side; `price > 0`;
   no Haat/xlsx import of combos. The order side — `calculateComboExtrasPrice`,
   `expandStockLines`, amend scope — is orders CORE invariants 11–12; `utils/order-stock.js`
   is the shared review boundary named in Scope.
11. **THE SUGGESTION INDEX IS A DISPOSABLE PROJECTION; WHAT A CUSTOMER SEES IS RE-READ LIVE.**
   `shoofi.suggestProductIndex` (central DB, one doc per product, `{ appName, productId }` unique)
   feeds the "For you" home-screen cards (`POST /api/for-you/suggest`, `docs/for-you.md`). It is
   rebuilt from the store DBs by `buildSuggestIndex` (`services/ordering-intelligence/index-builder.js`)
   every 3 h at :20 (`utils/crons/suggest-index-cron.js`, `ENABLE_CRONS`, Redis lock
   `cron:suggest-index`; plus once ~2 min after boot if empty). **Never edit it by hand and never
   read it as the truth about a product** — rows no longer produced are deleted per store
   (`builtAt` sweep), and stores that left the set are deleted wholesale (a store that merely
   *failed* a run keeps its rows).
   - **Which stores:** `shoofi.stores` with `business_visible !== false` AND in a food-service
     general category (`FOOD_SERVICE_CATEGORY_NAMES`, exact normalised name match — restaurant
     "דגים" counts, "חנות דגים" does not). Groceries, butchers, flowers, pharmacy never appear.
   - **Which products:** not `isHidden`, not `productType: "combo"` (v1), in at least one existing
     **non-hidden** store category by `supportedCategoryIds` (the legacy single `categoryId` is not
     read — `/api/menu` never matches on it), and not school-project-only. Out-of-stock products
     ARE indexed — stock is live state.
   - **Price and image in the index are hints for ranking, not display.** `price` is the
     category-discounted price (`applyProductDiscount`, invariant 3) as of the build; `img` is
     `img[0].uri`. The card's price always comes from the live re-check.
   - **`dishType`** comes from a TRUSTED Claude label when one exists (`shoofi.productLabels`
     with `status` `applied` or `admin` — invariant 12), else from the keyword rules
     (`dish-types.js` `classifyProduct`: product names first, category names only when the names
     say nothing; keywords go through `normalizeSearchText` from `services/search/text-search.js`,
     so the search's spelling folds apply). `dishTypeSource` records `claude` / `admin` / `rules`.
     A trusted label also fills `course, sweet, spicy, vegetarian, light, protein` and
     `searchTermsNorm`; without one they are `null` / `[]` (unknown, not false). `meal: false`
     types (drink/side/dessert) are never offered on their own.
   - **The live re-check is the invariant.** Before cards leave the server, `applyLiveMenu`
     (`suggest-service.js`) re-reads, per store that made the cut (≤ 6), the chosen `products`
     AND the store's visible `categories` (`isHidden != true`, `isSchoolProject != true` — the
     same filter `/api/menu` applies). It drops a product that is deleted, `isHidden: true`, a
     combo, in no visible category (by `supportedCategoryIds`), `isInStore !== true` (a MISSING
     `isInStore` is unavailable — the app greys out any falsy value and search requires `true`),
     or priced `<= 0` ("not for sale", invariant 8). The card's `price` is
     `applyProductDiscount(row, buildCategoryDiscountMap(visibleCategories))` — the menu's number —
     with `originalPrice`/`discountPercent` when discounted; names and image are the live row's.
     Any new `/api/menu` visibility rule must be mirrored here, or a suggestion opens a store
     whose menu does not contain the product.
   - Nothing writes the menu cache; no cache key to clear. Catalog writes do not need to touch
     the index — the next build and the live re-check cover them.
   - **Three platform flags gate the client:** `isChatSuggestEnabled` (home entry + chat),
     `isChatVoiceEnabled` (mic, UI only) and `isChatSuggestForAll` (staged rollout) on the
     central platform config document (app-name `shoofi`), exposed only because they are in
     `SHOOFI_CONFIG_PUBLIC_FIELDS` (`routes/store.js`). All default off. The app shows the home
     entry only when `isChatSuggestEnabled && (isChatSuggestForAll || customer.isShoofiEmployee)`
     (`screens/explore.tsx`, the same staged-rollout shape as `isTwinEnabledForAll` at checkout;
     `isShoofiEmployee` comes from `GET /api/customer/details`). The server endpoint itself does not
     read any of them — the gate is client-side.
12. **DISH LABELS: A MACHINE PROPOSES, ONLY TRUSTED LABELS REACH CUSTOMERS.** Three central
   collections, all derived and all owned by `services/ordering-intelligence/`:
   - **`shoofi.dishTaxonomy`** — the dish-type list as data (`taxonomy.js`, `_id` = key,
     `status: active | proposed | rejected`, `source: seed | claude | admin`). Seeded from the
     hand-written `DISH_TYPES` in `dish-types.js` **with `$setOnInsert` only**, so an admin's edit
     to a seed type is never undone by a deploy. `loadActiveDishTypes` feeds ONLY `status: "active"`
     types to the classifier (`setDishTypes`, cached 10 min per process; forced after an admin
     approve/edit and at the start of each index build and label run). **A `proposed` type never
     reaches a customer**: it is created by the labeller once `PROPOSAL_MIN_PRODUCTS` (3) products
     carry it (the system prompt lists the pending proposals and Claude must reuse their keys, so
     one dish does not split into several proposals; before counting, `refreshProposals` folds
     duplicates — `proposalAliases` unions proposal keys sharing a normalised `label_he` or
     `label_ar` and rewrites the aliases' `proposedType` to the key carried by the most products,
     e.g. samboosek→sambousek; it then deletes a `proposed` + `source: "claude"` row once fewer
     than 3 current labels carry its key), and
     becomes active only through `POST /api/admin/dish-taxonomy/:key/approve`
     (admin web "סוגי מנות"), which also sets `dishType` + `fromApprovedProposal: true`
     on the labels that proposed it (never on an `admin` label; labels with `confidence ≥ AGREE_CONFIDENCE` (0.5, exported from `product-labeler.js`) become
     `applied`, the rest `review` — the same answer `decideStatus` gives). A
     proposal approved while a run is going is caught twice: `runProductLabeling` re-reads the
     active types before writing (`activeNow`, `loadActiveDishTypes` with `force: true`, so an
     approval on any instance is seen) and turns a proposal of an active key into `dishType`, and
     `reapplyStatusRules` promotes any label whose `proposedType.key` is now active
     (`promotedToApprovedType`; 108 on production 2026-09-28). The index picks those products up at its next build.
   - **`shoofi.productLabels`** — one per `(appName, productId)`, written only by
     `runProductLabeling` (`product-labeler.js`) and the admin resolve endpoint. **Relabel rule:**
     each label stores `contentHash` (sha1 of nameAR, nameHE, the first 200 chars of each
     description, sorted category names); a product is re-sent to Claude only when that hash
     changes — renaming a product, editing its description, or renaming/moving its category all
     count. **`decideStatus(label, rulesDishType)`, first match wins:** (1) a `proposedType` →
     `review`; (2) `fromApprovedProposal` with a `dishType` (an admin approved the type, Claude
     put the product in it) → `applied` if `confidence ≥ AGREE_CONFIDENCE (0.5)`, else `review`;
     (3) Claude's `dishType` equals the rules' → the same 0.5 test; (4) neither Claude nor the rules
     claim a type → `applied` (the product stays untyped, its attributes are still used); (5)
     `confidence < APPLY_CONFIDENCE (0.7)` → `review`; (6) disagreeing with a rules type and
     `confidence < OVERRULE_CONFIDENCE (0.85)` → `review`; otherwise `applied`. A normal relabel
     writes `fromApprovedProposal: false` unless the reply proposes a now-active key. `review` means the rules' answer
     stays in force. **Changing these rules needs no model call:** `reapplyStatusRules`
     (`bin/label-products.js --reapply`, no API key) first promotes labels proposing a now-active
     type, then re-decides every non-admin label from its stored fields — including the `rulesDishType` stored at labelling time, not today's rules —
     and refreshes proposals. Run it after any `decideStatus` change or production drifts from
     the code (2026-09-28: 1,022 labels review → applied; review 2,346 → 1,324). **An admin decision (`status: "admin"`, `POST /api/admin/product-labels/resolve`,
     `dishType` must be an active type or null) stands until the product's content hash changes** —
     then the product is relabelled like any other. The pending filter never re-sends an admin row
     whose hash is unchanged — **not even under `force`** (`bin/label-products.js --force`,
     "after a prompt change — costs a full pass"), which re-sends every other unchanged product.
     **Only `applied` and `admin` are trusted**
     (`index-builder.js` reads `status: { $in: ["applied", "admin"] }`; `effectiveLabel`); `review`
     labels are invisible to customers.
   - **`shoofi.productLabelRuns`** — one per run: `startedAt, finishedAt, status (running | done |
     failed), model`, the counters (`stores, products, pending, labeled, applied, review, calls,
     errors, proposals`) and **`inputTokens` / `outputTokens`** — the cost record.
   - **Metered API rule.** The labeller calls `services/ai/complete.js` with `backend: "api"`
     (`MODELS.best`, `ANTHROPIC_API_KEY`, token counts from the returned `usage`) — bulk and cron
     work never goes through the bridge, which is for a person waiting on a screen — with
     `effort: "low"` (`complete.js` passes it as `output_config.effort`, API backend only).
     Products go as a JSON array; the reply may be a JSON array or one object per line
     (`replyRows`). Batches of 40, 3 in parallel, `MAX_TOKENS` 12000, a cut-off
     (`stopReason: "max_tokens"`) or unreadable batch is halved and retried (depth ≤ 3), and products the model silently left
     out of an otherwise readable reply are re-sent as their own batch (depth < 3) — otherwise they
     would keep their old label; a run
     stops queuing at `PRODUCT_LABELS_MAX` (default 15000) products. `searchTerms`: at most 4,
     never sizes/quantities, store names or words already in the product's name. First full
     production pass, 2026-09-28 (effort low): 9,210 products, 311 calls, 1.43M input / 0.87M
     output tokens, 61 min, ≈ $11.5, 25 proposed types. Weekly runs after that cost only the
     week's new and edited products. `reviewOnly` (`--review`) re-sends ONLY labels in `review`
     (after a prompt fix aimed at them): 1,076 products, 130 calls, 429k / 123k tokens. After the
     prompt fixes and the approval of all 23 proposals (43 active types), production stood at 8,873
     applied / 535 review (9 proposal singletons, 389 low confidence, 137 disagreements).
     **Prompt rules that matter:** store category names are STRONG evidence (a product under a
     drinks category is a drink even when its name is only a brand, "XL"/"BLU"), a brand name is no
     reason to lower confidence, and prompt examples must not include real product names as
     counter-examples — the `searchTerms` example once listed "xl" as a size and Claude read the
     product "XL" as one.
     Cost must follow CHANGE: the only path that re-sends unchanged products is the explicit
     `force` option — never make it a default or wire it to a cron without a human decision on
     spend. Weekly cron Sunday 04:10 Asia/Jerusalem (`utils/crons/product-labels-cron.js`,
     `ENABLE_CRONS`, lock `cron:product-labels`), then the index is rebuilt through
     `runSuggestIndex` — i.e. under the `cron:suggest-index` lock, because two concurrent builds
     delete each other's fresh rows (each sweeps `builtAt != mine`). On demand:
     `POST /api/admin/product-labels/run` (`202` started, `409` a run holds the lock, `503` no
     key) or `node bin/label-products.js`. Every admin endpoint is `auth.required` +
     `checkAdminRole`.
13. **A CRAVING'S DESCRIPTIVE WORDS ARE FILTERS, NEVER SPELLINGS** (`craving.js`). In text mode,
   `parseCraving` removes attribute words (sweet, spicy, vegetarian, light/healthy — Arabic, Hebrew,
   Latin) and one protein word (chicken, beef, fish) from the text and turns them into filters on
   the index labels (`satisfies`, and `cravingQuery` as the Mongo prefilter); **only what remains is
   matched against names**, so "حلو" can never find "بطاطا حلوة". Fallbacks for unlabelled products
   (label field `null`): `sweet` ← `dishType === "dessert"`, `light` ← `dishType === "salad"`, a
   protein filter ← the protein word as a token of the product's name; `spicy` and `vegetarian`
   have no fallback (only `true` passes). Claude's `searchTermsNorm` also match remaining typed
   words. When nothing open passes the filters the reply is `replyCode: "craving_unavailable"`
   with `replyParams.craving` (the label pair) and popular/fill cards — never the closest spelling
   of a different food. The app renders it as `for_you_reply_craving_unavailable`
   (`shoofi-app/helpers/for-you-copy.ts`).

14. **A STORE NAMED IN A CRAVING NARROWS; A NEAR-SPELLING IS A LAST RESORT** (`store-mention.js`,
   `suggest.js` text mode). `detectStoreMentions(craving.rest, openStores)` finds open stores the
   text names — whole 3- then 2-word phrases first ("burger house"), then single words as typed,
   without Arabic "ال" and without a glued Hebrew מ/ב/ש/ל — using only close matches
   (`TIER.WORD_START`+ on name_ar / name_he / appName slug). Those words, with the connector before
   them ("من", "מ", "from", "at", "של"), leave the dish search and the pool is limited to those
   stores (`candidateQuery` also fetches all of their products). Guards: a dish-type word is never a
   store even when a store is named after it ("טורטיה"), a phrase of only dish words is not a store,
   and a word matching more than 3 stores is too generic. Only a store and nothing else ("من gcp")
   → that store's dishes. Separately, when any product scores `TIER.WORD_START`+ on the typed
   words, products below `TIER.CONTAINS` (fuzzy-only, e.g. "بيتا" for "جبيتا") are dropped,
   however popular or familiar — found when "جبيتا من gcp" ranked another store's pita first.
   **Names are matched against every store in the area, open or closed** (`getAreaStores` →
   `{open, closed}`; closed = not open, busy or coming soon), but only open stores are suggested or
   fetched. When the only store named is closed, text mode answers `replyCode: "store_closed"` with
   `replyParams.stores` and the same dish from open stores (popular fill when nothing matches), and
   the Claude chat is told "named X, which is CLOSED now" — found when GCP was closed at 09:48 and
   its name fell into the dish search.
15. **CLAUDE IN THE CHAT IS OPT-IN, CAPPED, AND PICKS ONLY FROM OUR SHORTLIST** (`ai-chat.js`).
   Only typed messages, and only while `isChatAiEnabled` is true on the platform config doc
   (server-read; not in `SHOOFI_CONFIG_PUBLIC_FIELDS`). Off, over `chatAiDailyBudgetUsd` (default 5,
   Israel day, summed from `aiUsage` rows with feature `for-you-chat`, cached 1 min), a 12 s timeout,
   an API error or an unreadable reply → `aiChatTurn` returns null and the rules answer unchanged.
   Claude sees a shortlist (≤ 40: `scoreText` matches, then the customer's own dishes, then popular —
   open stores only), what the rules understood (craving attributes, named store, dish types, and
   whether anything matched), a taste summary and ≤ 6 history turns; it returns
   `{reply, pick:["p<n>"]}` and ids outside the list are dropped. Cards keep our reasons and pass
   `applyLiveMenu`. Reply `replyCode: "ai_reply"` with `replyParams.text`, `ai: true`. Chips never call it.
16. **EVERY CLAUDE CALL IS LOGGED AND PRICED** (`services/ai/usage-log.js`, `pricing.js`).
   `complete.js` writes one `shoofi.aiUsage` row per call — `feature` (the caller's `label`), model,
   backend, tokens, `costUsd` at list prices when it ran (bridge = 0), ms, ok/error, `meta` — for
   every AI feature, not only For you. Fire-and-forget (a failed write never fails the call); TTL 180
   days; the sink is registered at boot (`app.js`) and by `bin/label-products.js`. Admin
   "שימוש ב-Claude" (`GET /api/admin/ai-usage`, admin roles) reads it. When a price changes, change
   `PRICES` in `pricing.js`.
17. **SPELLCHECK PROPOSES; A NAME CHANGES ONLY ON A PERSON'S ACCEPT, AND ONLY IF UNCHANGED**
   (`services/catalog/menu-spellcheck.js`, `docs/menu-spellcheck.md`). A monthly cron
   (`15 3 1 * *`, lock `cron:menu-spellcheck`, shared with the admin "run now") asks Claude
   **Haiku** (`MODELS.fast`, never `effort` — Haiku rejects it) about category / product / extra /
   option / combo-section `nameAR`+`nameHE`. Verdicts are cached per `(lang|text, PROMPT_VERSION)` in
   `shoofi.menuSpellChecks`, so each text is asked once across all stores; a deterministic guard
   (`isPlausibleFix`: no added/removed word, ≤ 2 letters per word, not niqqud-only) and a second
   Haiku "verify" call filter the proposals; an unanswered text gets no verdict, never "correct".
   Rows live in the **central** `shoofi.menuSpellIssues` (one per slot) — a deliberate exception to
   the per-store worklist of invariant 1, because the screen spans every store and accept needs
   auth + audit. `acceptFixes` is the only catalog write: a compare-and-set on that ONE field
   against the stored `rawText` (extras/options/combo sections by `arrayFilters` on id + old name,
   never index; duplicate or empty ids refused; a category straight on `categories`, never via the
   store-category update route), a changed name → row `stale`, both cache keys cleared
   (invariant 2), and a renamed out-of-stock option's NEW `nameAR` **added** to
   `store.outOfStockExtras` (old name kept). Never route it through `POST /api/admin/product/update`
   (whole-document `$set`, last writer wins). A dismissed or accepted text is not re-raised.

## Catalog text — what you are actually searching
Before writing anything that matches on a name, know what the corpus looks like. Verified
against production (`shoofi.stores`, 255 docs; ~59k products across ~165 store DBs):
- **There is NO text index and NO Atlas Search.** `shoofi.stores` and every store's
  `products` carry only `_id`. Nothing in `services/database/DatabaseInitializationService.js`
  or `utils/create-indexes.js` creates one on a name or description field. Every name search
  is a collection scan — so `$text` is not available to you, and neither is `$search`.
- **The catalog disagrees with itself about spelling.** Production holds `شوارما` *and*
  `شاورما`, `بيتسا` *and* `بيتزا`, `שווארמה` *and* `שוארמה`, `שניצל` *and* `שנצל`. These are
  store owners typing, not user typos, so **exact or anchored matching on catalog text is
  wrong by construction** — a customer who types one spelling perfectly still misses every
  store written the other way.
- **`name_he` is usually a TRANSLITERATION of `name_ar`, not a translation**
  ("شوارما السلطان" / "שווארמה אלסולטאן"). Searching only the UI language's field throws
  away half the corpus for nothing; search both, always.
- **There is no English anywhere.** Stores have `name_ar`/`name_he` only; `appName` (the slug,
  `shawarma-alsultan`) is the sole Latin text a store carries, and products have none at all.
  A Latin query reaches products only if you transliterate it into the two scripts.
- The definite article is glued on (`السلطان`, `אלסולטאנ`) — users type the bare noun.
- Matching + ranking live in `services/search/text-search.js` (pure, unit-tested); the
  endpoint is `POST /api/menu/search` in `routes/menu.js`. See `docs/menu-search.md`.
- `routes/global-search.js` is **dead and broken**: it filters `shoofi.stores` on
  `nameAR`/`nameHE`/`name`, none of which exist (the fields are `name_ar`/`name_he`), so it
  returns `[]` for every input, and it has no caller in any app. Don't cite it as prior art.

## Known status (human-confirmed — do NOT "fix")
- **BY DESIGN:** translations resolve to the **central** DB — UI labels are global/platform-wide,
  not per-store. Do **not** re-route them to `app-name`.
- **FACT (not a bug):** `supportedCategoryIds` are strings (invariant 5).
- **FACT:** the customer app treats EVERY non-header `single` as mandatory
  (`shoofi-app/stores/extras validateWith`: `if (extra.type === "single" && !val) return false`;
  `helpers/extras-groups.ts isMandatoryExtra`). That is why `SINGLE_WITHOUT_OPTIONS` and
  `REQUIRED_GROUP_ALL_OUT_OF_STOCK` are critical: the add-to-cart button never enables.
- **FACT:** out-of-stock extras are matched by option `nameAR`, exactly, no trim
  (`menuStore.outOfStockExtras.includes(opt.nameAR)`, RadioGroup/CheckboxGroup/PizzaToppingGroup).
  So renaming an option's `nameAR` silently puts it back on sale unless the list is updated too
  (the spellcheck accept does — invariant 17).
- **FACT:** `POST /api/store-category/update/:id` overwrites `order`, `discountPercent`,
  `isSchoolProject` and `isCampaign` from the body and clears **no** menu cache — a names-only
  call zeroes the discount. Write category names with a targeted `$set`.
- **FACT:** `maxCount: 0` on a `multi` means "no limit" to the app (`max && …`), but both admin
  editors default it to 1 and refuse `<= 0`, so the lint reports `< 1` as `MAX_COUNT_INVALID`
  (warning, not repaired).
- **Backlog (confirmed, safe to act on when asked):**
  1. `GET /api/menu` and `POST /api/menu/refresh` build the menu **differently** — `refresh` is a
     real admin-triggered action that re-caches under the same key, so clicking it degrades the
     live menu. Fix by extracting **one shared menu-builder** both call.
  2. Remove the dead lunr index (`lib/indexing.js` + its `indexProducts` call sites) — it indexes
     fields the schema doesn't have and runs on every product write. Touches product-write paths;
     test after.
- **Recorded risk, not yours to fix:** order **creation** still charges the client-sent total;
  `utils/order-pricing.js` (orders domain) recomputes it in **shadow mode** and records
  `serverPricing.driftDetected` on the order, and the **amend** flow reprices authoritatively.
  Flipping creation to server-authoritative lives in the order-create path — hand off.

## Recipe — add/modify a product field
1. Server: accept + persist it in the product insert/update handlers (`routes/product.js`).
2. **Expose it** in the `$project` blocks of the menu aggregation (`routes/menu.js`) or the client
   will never see it.
3. **Clear both cache keys** on every write path you touched (invariant 2).
4. Client (if needed): partner edit UI, customer display. Worked example across all four
   repos: the `soldByWeight` flag (`docs/sold-by-weight.md`).
5. Verify: `npm run lint` (0 errors), `npm run routes:check` if routes moved, tests via the
   `shoofi-testing` cover-changes skill.

## Recipe — "why can't customers add product X?"
`GET /api/admin/menu-import-issues` with `app-name: <store>` and look at `phase: "lint"` rows
(or the dashboard badge from `GET /api/admin/catalog-lint/summary`).
`POST /api/admin/catalog-lint/run { appName }` runs the lint now. `BLOCKED_ADD_TO_CART` rows
are the customers' side of the same story (7-day window on `shoofi.apps-logs`
`add_to_cart_blocked`). A `lint` row means the product IS in the catalog and is defective —
re-importing fixes nothing; edit the product (or run the repair script, reference §4).

## Definition of done
Inherit `_shared-guardrails.md` §7. Here specifically: name every write path you touched and
confirm each clears both cache keys; never claim `smoke` passed without infra; fix the doc +
`context/assert/menu-catalog.assert.json` in the same PR if you find drift.
