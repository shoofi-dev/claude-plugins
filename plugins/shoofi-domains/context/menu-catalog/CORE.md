---
domain: menu-catalog
last-verified: shoofi-server@514d1a4b (feat/store-card-deal-badge — store-card promotions) / 2026-10-26; shoofi-server@9cf91e62 + uncommitted feat/coupon-drafts worktree (translations, invariant 24) / 2026-10-26; rest shoofi-server@1870b2ff / 2026-10-19
scope: server-first (shoofi-server; clients mostly render what the server assembles)
reference: ./reference.md   # data model, endpoint tables, flows, options/extras detail
---

# Menu / Catalog — CORE (always read)

Products, categories, menu assembly, options/extras, availability & stock, catalog i18n.

## Scope
Server: `routes/menu.js`, `routes/product.js`, `routes/category.js`, the catalog slice of
`routes/store.js`, `routes/translations.js`, `services/translations/owned-translations.js` (rows
written by code — invariant 24), `routes/global-search.js`, `utils/menu-cache.js`,
`utils/order-stock.js` (stock semantics only), `utils/weight-extra-invariant.js`,
`utils/general-category-order.js` (tile order),
`utils/catalog-lint.js` (the extras lint rules), `services/catalog/catalog-lint.js` (the
worklist writer + nightly run), `routes/admin/catalog-lint.js`, `utils/crons/catalog-lint-cron.js`,
the combo-deals trio `utils/combo-validation.js`, `services/menu/combo-snapshots.js`,
`utils/client-features.js`, and the "For you" suggestions — `services/ordering-intelligence/`
(incl. the server gate `access.js`, the Claude cap `chat-limits.js` and the served log `served-log.js`)
(the catalog-facing parts are `index-builder.js`, `dish-types.js` and the live re-check in
`suggest-service.js`; ranking/taste/open-stores ride along), `routes/for-you.js`,
`utils/crons/suggest-index-cron.js`, `bin/build-suggest-index.js`, and the dish labelling behind
it — `services/ordering-intelligence/{taxonomy,product-labeler,craving}.js`,
`utils/crons/product-labels-cron.js`, `routes/admin/dish-taxonomy.js`, `bin/label-products.js`
(admin web: `src/views/admin/dish-types/DishTypes.tsx`, `src/apis/admin/dish-taxonomy.ts`), and the
monthly menu spellcheck — `utils/menu-spellcheck-text.js`, `services/catalog/menu-spellcheck.js`,
`utils/crons/menu-spellcheck-cron.js`, `routes/admin/menu-spellcheck.js` (admin web:
`src/views/admin/stores/MenuSpellcheck.tsx`, `src/apis/admin/menu-spellcheck.ts`), and what the
AI helper's taste profile does to suggestions — `services/ordering-intelligence/avoid.js`, the
profile hooks and chat-ordering modes in `suggest.js` / `suggest-service.js`,
`utils/extras-required.js`, and `GET /api/ai-helper/cuisines` (`routes/ai-helper.js` →
`ai-helper-service.js`) (app: `components/ai-helper/`, `screens/ai-helper/`, `stores/ai-helper/`,
`components/for-you/` — incl. the minimized-chat bubble — and the chat's quick add
`hooks/useChatAddToCart.ts` + `helpers/chat-cart-line.ts`). Who owns a profile and the login
merge are the customers domain's; the cart the quick add writes into and the deferred in-chat
checkout are the orders domain's.
Docs: `docs/stock-management.md`, `docs/menu-search.md`, `docs/sold-by-weight.md`,
`docs/menu-import-issues.md` (the worklist — now also documents the `lint` phase),
`docs/combo-deals.md`, `docs/for-you.md`, `docs/menu-spellcheck.md`, `docs/ai-helper.md`.
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
   **General-category tiles** (`<appName>.general-categories`, `hasGeneralCategories` stores) are
   served by `order` through ONE comparator, `sortGeneralCategories` (`utils/general-category-order.js`):
   numeric `order` ascending, a missing/invalid `order` **last**, ties by string `_id`. `GET /api/menu`,
   `POST /api/menu/refresh`, `GET /api/menu/mock` and the admin list
   (`GET /api/category/general/all/by-store`) all use it, so admin and app agree. Never return
   this collection unsorted: natural (insertion) order is what the app renders, which is how
   super-abu-shaqra's "ملحمه" was saved first (order 0) and served 27th of 28 (2026-10-22).
   Both reorder routes (`POST /api/store-category/update-order`,
   `POST /api/category/general/update-order`) clear both cache keys (invariant 2).
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
     It also projects `extras` + `soldByWeight`, only to set `product.hasRequiredOptions`
     (invariant 19). Any new `/api/menu` visibility rule must be mirrored here, or a suggestion
     opens a store whose menu does not contain the product.
   - Nothing writes the menu cache; no cache key to clear. Catalog writes do not need to touch
     the index — the next build and the live re-check cover them.
   - **The customer's taste is cached 10 min and SHARED across instances** (`taste.js`
     `getCustomerTaste`): Redis key `fy:taste:v<CACHE_VERSION>:<customerId>`, `PX` 10 min, via the
     shared `utils/redis-lock` client, when `REDIS_URL || REDIS_HOST` and not `E2E_SANDBOX`. Redis is
     only a shortcut — unconfigured, an error, a 150 ms timeout or an unreadable value falls back
     to the per-process capped map (2000) for that call, and a failure skips Redis for 30 s; the
     write is fire-and-forget. While Redis works it is the truth: a Redis miss recomputes, it never
     falls through to a memory copy. The taste holds Maps, so it crosses Redis via
     `serializeTaste`/`deserializeTaste` (exact round trip); **bump `CACHE_VERSION` when
     `computeTaste`'s shape changes**. `invalidateCustomerTaste` drops both copies but is NOT wired
     to any order transition — a completed order reaches For you within 10 min. The dry run
     (`opts.dishTypes`) and the no-customer `EMPTY_TASTE` are never cached. Pinned by
     `test/integration/for-you-taste-cache.js`.
   - **Three platform flags gate the client:** `isChatSuggestEnabled` (home entry + chat),
     `isChatVoiceEnabled` (mic) and `isChatSuggestForAll` (staged rollout) on the
     central platform config document (app-name `shoofi`), exposed only because they are in
     `SHOOFI_CONFIG_PUBLIC_FIELDS` (`routes/store.js`). All default off. The app shows the home
     entry only when `isChatSuggestEnabled && (isChatSuggestForAll || customer.isShoofiEmployee)`
     and the AI helper persona is not showing (invariant 18 — home keeps one way into the chat)
     (`screens/explore.tsx`, the same staged-rollout shape as `isTwinEnabledForAll` at checkout;
     `isShoofiEmployee` comes from `GET /api/customer/details`). The server endpoint itself does not
     read any of them — the gate is client-side.
   - **Voice is on-device speech-to-text, then the typed path.** The mic shows only when
     `isChatVoiceEnabled` AND the binary has the `ExpoSpeechRecognition` native module
     (`isVoiceAvailable()` in `hooks/useVoiceInput.ts`, `expo-speech-recognition`); an older
     binary that gets the JS by OTA hides the mic instead of crashing, so the package is only
     ever `require`d lazily. Apple Speech / Android SpeechRecognizer in `ar-SA` / `he-IL`, with
     the dish and store names on screen as recognizer hints (`contextualStrings`). The final
     transcript is sent as ordinary `text` — the server cannot tell voice from typing, and no
     audio reaches our servers. Flag on + old binary = no mic; it needs a store build.
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
   **"NOT X" IS AN EXCLUSION, NEVER A FILTER FOR X.** A negator ("مش", "بدون", "بلا", "من غير",
   "ما بدي", "בלי", "ללא", "לא", "without", "not", "no"; two-word ones read as one) turns what
   follows — up to an ender ("مع", "بس", "من", "עם", "אבל", "with", "but", "from") — into
   `craving.exclude`: attributes and proteins by label, a dish word's dish type, an allergen-group
   word through the avoid word lists (`ALLERGEN_WORDS` → `conflictsWithAvoid`, so "بدون مكسرات"
   drops "كنافة بالفستق"), and any other word by the product NAME. `satisfies` rejects
   `isExcluded` products, and `textMode` passes the same `skip` to the popular/fill fallbacks:
   what they said no to is in no card. A name-based exclusion replies `without_results` with
   `replyParams.without` ("ideas without X in their names — with an allergy, ask the store").
   Found when "مش حار" / "בלי חריף" returned a SPICY filter and "بدون مكسرات" searched FOR nuts.

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
   Only typed messages, only from a LOGGED-IN customer, and only while `isChatAiEnabled` is true on
   the platform config doc (server-read; not in `SHOOFI_CONFIG_PUBLIC_FIELDS`). Off, a visitor
   (`not_eligible`), over `chatAiDailyBudgetUsd` (default 5, Israel day, summed from `aiUsage` rows
   with feature `for-you-chat`, cached 1 min), over the customer's own cap (`chat-limits.js`: 20 an
   hour, 60 a day; Redis when configured, else per-instance memory — `rate_limited`), a 6 s timeout,
   an API error, an unreadable reply or a reply `safeReply` rejects → `aiChatTurn` returns null, the
   rules answer unchanged, and `trace.reason` says why (invariant 21). The call uses `MODELS.chat`
   with `apiTimeoutMs: 6000` and `apiMaxRetries: 0`: the SDK ABORTS the request (a `Promise.race`
   only stops waiting — the request went on, was billed and logged as a success). Claude sees a
   shortlist (≤ 40: `scoreText` matches, then the customer's own dishes, then popular — open stores
   only, and never an `isExcluded` product), what the rules understood (craving attributes,
   exclusions, named store, dish types, and whether anything matched), a taste summary and history
   turns capped at 600 characters in all (newest kept); it returns `{reply, pick:["p<n>"]}` and ids
   outside the list are dropped. The prompt forbids any "free of X / safe for an allergy" claim and
   asks for Palestinian colloquial Arabic / gender-neutral Hebrew; `safeReply` drops a reply with a
   link, ₪/%, a coupon or discount word, a free-of claim, digits not in a listed dish's own name, or
   the wrong script — it is shown verbatim, so this is the prompt-injection guard. Cards keep our
   reasons and pass `applyLiveMenu`. Reply `replyCode: "ai_reply"` with `replyParams.text`,
   `ai: true`. Chips never call it.
16. **EVERY CLAUDE CALL IS LOGGED AND PRICED** (`services/ai/usage-log.js`, `pricing.js`).
   `complete.js` writes one `shoofi.aiUsage` row per call — `feature` (the caller's `label`), model,
   backend, tokens, `costUsd` at list prices when it ran (bridge = 0), ms, ok/error, `meta` — for
   every AI feature, not only For you. Fire-and-forget (a failed write never fails the call); TTL 180
   days; the sink is registered at boot (`app.js`) and by `bin/label-products.js`. Admin
   "שימוש ב-Claude" (`GET /api/admin/ai-usage`, admin roles) reads it. When a price changes, change
   `PRICES` in `pricing.js`. **Every model named in `MODELS` needs a price row** (a test in
   `test/integration/for-you-ai-chat.js` fails otherwise): an unpriced call logs `costUsd: null`, and
   the chat's budget counts such a row at `UNPRICED_BUDGET_PRICE` (twice the dearest known price) —
   never as $0, or a model upgrade would switch the cap off. Features with their own budget or
   quality gate have their own `MODELS` key (`chat`, `labels`); moving `best` must not move them.
   The chat's message is stored with digits masked.
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
18. **A TASTE PROFILE FILTERS ONLY THROUGH `avoid`; EVERYTHING ELSE IN IT ONLY WEIGHTS — AND
   WITHOUT ONE NOTHING CHANGES** (`avoid.js`, `suggest.js` `applyProfile`, `docs/ai-helper.md`;
   detail reference §7f). `POST /api/for-you/suggest` reads the caller's `shoofi.tasteProfiles`
   doc (customer token, else the `device-id` header) in `loadProfile`; a failed read is "no
   profile", never a failed reply.
   - **`avoid` runs on the candidates BEFORE both the rules and Claude**
     (`filterByAvoid(found, …)` in `suggest-service.js`; `aiChatTurn` only picks from that list).
     Only `GUARANTEED_AVOID = ["vegetarian", "no_seafood"]` are promises the data can keep:
     `vegetarian` keeps a product only when its TRUSTED label says `vegetarian === true`
     (unlabelled is dropped); `no_seafood` keeps a product only when its trusted label names a
     protein that is not fish/seafood (unlabelled — `protein` null — is dropped too), and also drops
     the sushi/fish dish types (and any type key naming fish or seafood) and seafood words in the
     name. `vegan`, `lactose_free`, `gluten_free`,
     `nut_allergy` are BEST EFFORT: there is no allergen or dairy data anywhere, so they drop only
     what labels, dish types and names reveal, and the app stars them with a "we can't guarantee"
     note (its own `GUARANTEED_AVOID` in `stores/ai-helper/index.ts` must equal the server's).
     Never present a best-effort key as safe; promoting one needs new label fields and a forced
     relabel (cost: invariant 12). When `avoid` removed candidates and the rules path is left
     with no card, the reply is `avoid_no_match` (`replyAfterAvoid`), never an opener over an
     empty row; a named closed store keeps `store_closed`. Nothing the app SAYS about avoid is
     absolute ("we'll try to avoid it"); the chat shows the active filter line and, after
     `avoid_no_match`, an "edit my taste" step (app `components/for-you/context-chips.ts`).
   - **The last check, at serve time** (`dropAtServe` in `suggest-service.js`): every card that
     survived `applyLiveMenu`, on both paths, is checked again against `avoid` and the message's
     exclusions using the index labels with the dish's LIVE name — a dish renamed "… shrimp" since
     the index was built never reaches a no-seafood customer. A catch is logged (`card dropped at
     serve time`): it means an earlier filter missed it.
   - **Everything else is a ranking signal, never a filter.** `applyProfile` puts `_bias`
     (`profileBias`: stated cuisine, spice, budget against the dish type's median price) on every
     candidate, and every popularity sort uses `qty30d × _bias`. Stated cuisines also widen the
     index query and add `you_like` cards (`params.dishType`; what the customer said needs no
     order evidence) — with no orders the opener then answers `opener_stated`. `onboarded: true`
     (the first opener after the onboarding) answers `opener_onboarded`.
   - **A fact the customer rejected is never claimed again** (`rejectedFacts`):
     `usual:<appName>: false` → that store's products say `ordered_before`, never `usual`;
     `liked_type:<key>: false` → that type is never offered as a liked type. Both paths: the
     Claude chat gets the PROFILE-APPLIED taste (`applyProfile` before `aiChatTurn` in
     `suggest-service.js`), so `cardForDoc` never tags `usual` at a rejected store and
     `tasteSummary` leaves rejected types out of "Likes" (and adds "Told us they like").
   - **No profile = exactly the old ranking and reply codes.** `applyProfile` returns docs and
     taste untouched (`_bias ?? 1`, no `stated`, no `rejected`) — pinned by the test "with no
     profile the reply is exactly as before" (`test/integration/ai-helper.js`). Keep it green.
   - Four more platform flags in `SHOOFI_CONFIG_PUBLIC_FIELDS`, all default off:
     `isAiHelperEnabled`, `isAiHelperForAll` (off = Shoofi employees only),
     `isAiHelperOnboardingEnabled`, `isChatOrderingEnabled`. All sit UNDER the For-you master
     switch (invariant 21). The persona shows on home when For you is on for the customer AND
     `isAiHelperEnabled && (isAiHelperForAll || isShoofiEmployee)` (`screens/explore.tsx`), and
     while it shows the For-you home entry is hidden. The server enforces the same rule on
     `routes/ai-helper.js` (`access.js`): switched off, reads answer empty and `PUT /profile` /
     `POST /merge` answer 403 — no profile is created or merged.
   - **The onboarding saves only what the customer answered.** The budget (a sub-question on the
     meal-times step) is never pre-selected and is saved only once tapped
     (`AiHelperOnboardingScreen.tsx` `budgetChosen`); before 2026-10-19 the pre-selected «₪₪» was
     saved whenever a meal time was picked and weighted the ranking. A first local profile starts
     from `UNKNOWN_STATED`, never the screens' `EMPTY_STATED` defaults, so a skip stores no spice,
     meal time or budget the customer never gave. `budget: null` is neutral, like `budget: 2`.
   - **Ordering for a family member: `forPerson` swaps WHOSE taste, never the rules.**
     `POST /api/for-you/suggest` with `forPerson: <id from people[]>` (`suggest-service.js`,
     `suggest.js` `personMode`, `docs/ai-helper.md` › Ordering for a family member): that person's
     `avoid` REPLACES the customer's — the same keys, the same guaranteed/best-effort split, the
     same last check at serve time — and the customer's own taste is dropped (`EMPTY_TASTE`), so
     "for Mom" never shows the customer's usual. Their tagged dishes come first (most ordered,
     then most recent; fetched by id in `candidateQuery` even when not popular), then popular;
     `for_person` / `for_person_new`. Typed text stays text mode (with their avoid list). An
     unknown id is the customer's own reply, never an error. Tags count only after an order goes
     through (app `takePersonDishes` on `order_submit_success`); the onboarding's family step and
     the chat's once-a-week offer feed `people` (app `helpers/family.ts`). Pinned in
     `test/integration/for-you-family.js` and `for-you-seen.js`.
   - **The persona's peek is seen, or not shown at all.** On a cold start the home mounts UNDER the
     launch splash; the peek (once per session: no profile yet, or a meal window) and the persona's
     `ai_helper_fab` / `ai_helper_peek` impressions wait for `helpers/splash-state.ts` (App.tsx marks
     it when the splash's fade ends), then for home in front and the persona visible. Fired earlier,
     the peek played unseen, used up the session's one peek and inflated the funnel's "seen"
     (invariant 22).
19. **THE CHAT ADDS TO THE EXISTING CART EXACTLY AS THE MENU WOULD — OR IT OPENS THE STORE**
   (`suggest.js`, `suggest-service.js`, `utils/extras-required.js`; app `hooks/useChatAddToCart.ts`,
   `helpers/chat-cart-line.ts`; reference §7f).
   - Modes `drink`, `sweet`, `cross_sell` take `cart: { appName, productIds }` and never suggest a
     product already in it; within one chat they prefer one not shown yet, never at the cost of an
     empty reply (invariant 23). With a cart, all three offer the cart's store ONLY (no per-store cap
     there) — a drink "that goes with your order" from another store would ask to empty the cart on
     "+". Nothing there → `drink_unavailable_store` / `sweet_unavailable_store` with
     `replyParams.stores` (the reply names the store); without a cart, every open store at ≤ 2 each
     and `drink_unavailable` / `sweet_unavailable`. `cross_sell`: drinks, sides and sauces, and
     nothing when that store is not open. Their index clauses (`modeClauses`) are
     served by `{ appName: 1, course: 1 }`, created by `ensureIndexes` in `index-builder.js`. The
     app (`isChatOrderingEnabled`) sends `drink` / `sweet` from its cart chips and `cross_sell`
     once per store per chat right after a chat add (an empty reply is dropped, `dropIfEmpty`);
     its cards render as compact pills. The chat places no order — "complete the order" opens the
     normal cart.
   - **`product.hasRequiredOptions` is on every card**, rules and Claude paths alike
     (`applyLiveMenu`, which projects `extras` + `soldByWeight` for it): `true` for
     `soldByWeight === true` or any non-header `single` or `weight` extra. `required` is ignored
     (a dead field, reference §4) and a `defaultOptionId` does not exempt a `single` — the flag
     means "the product sheet has a choice to show", a superset of what blocks add-to-cart (Known
     status). It is only a HINT: the app opens its options sheet at once when it is `true`; what
     happens is decided on the full menu product (next bullet).
   - **The quick add (the "+" on a card or a cross-sell pill) builds the line the menu would.**
     `useChatAddToCart` loads the dish's store with the FETCH-ONLY `getStoreDataFromServer(appName)`
     and `getMenuFromServer(appName, false)` (explicit `app-name`) — never `getMenu`, `getStoreData`
     or `setStoreDBName`, which overwrite the browsed store other screens read — and finds the
     product in `menu.menu[].products`. The chat's sheet has chips for `single` and `multi` ONLY
     (`chatSheetSupport`): a combo, `soldByWeight`, a `weight` (or legacy `categoryId: "weight"`)
     extra, `pizza-topping`, `counter`, a group header with `freeCount > 0`, any other type — and
     twin orders, a school cart, an age-checked store, a failed load — open the store at the dish
     instead. `priceLine` is `screens/meal/index2.tsx`'s formula and the server's
     (`utils/order-pricing.js`): `price = base + (d > 0 ? Math.round(extras × (1 − d/100)) :
     extras)` — change one, change all three. Straight into the cart only with no defaults and
     nothing to choose; otherwise the sheet, defaults pre-selected, never added silently. The line
     goes in through `cartStore.addProductToCartForStore` (orders domain), and a cart of another
     store is never mixed or silently emptied — the chat asks.
   - **`GET /api/ai-helper/cuisines?lat=&lng=`** — the onboarding's tiles, from the central index
     only: ACTIVE `meal` dish types, most stores first, ≤ 9. Rows come from the area's OPEN
     stores; with fewer than 4 types it widens to the area's closed stores too, then to the whole
     catalog (one aggregation, best seller per type × store). Image = the type's `img` on its
     `shoofi.dishTaxonomy` doc, else the best seller's in the tier used; no image = left out.
     Nothing in the API writes `dishTaxonomy.img` yet. Bad location → 400; any other failure →
     `200 { cuisines: [] }`.
20. **THE CHAT CAN MINIMIZE INTO A FLOATING BUBBLE — FLAG OFF IS EXACTLY THE OLD CHAT, AND CLOSING
   NEVER TOUCHES THE CART** (app only: `components/for-you/bubble-math.ts`, `ChatBubbleOverlay.tsx`,
   `stores/for-you`, `screens/for-you/ForYouScreen.tsx`; reference §7g).
   - **Gate:** For you on for the customer (invariant 21) AND
     `isChatMinimizeEnabled && (isChatMinimizeForAll || isShoofiEmployee)` (`isChatMinimizeOn`). Both
     flags are in `SHOOFI_CONFIG_PUBLIC_FIELDS` (`routes/store.js`, right after the four AI-helper
     flags; pinned by `test/integration/config-home-layout-flags.js`), default off, and no server
     endpoint reads them.
   - **Another person on the phone gets nothing of it:** logout, account delete and a forced
     sign-out call `forYouStore.resetForAccountChange()` (`stores/auth`) — conversation, bubble and
     home picks all go ("your usual" cards are personal).
   - **Flag OFF = the old lifecycle, unchanged:** no chevron, no header swipe, no bubble, and the chat
     `reset()`s on mount and on unmount — a fresh conversation every time. Flag ON: the conversation
     (messages, draft, scroll) lives in `forYouStore` and continues across minimize, close and reopen
     until the app restarts (memory only, nothing persisted); a new onboarding starts fresh.
   - **Never over money, order or identity screens.** `overlayVisible` hides the bubble while the
     keyboard is open and on every route in `BUBBLE_HIDDEN_ROUTES`: `for-you`, `checkout-screen`,
     `pick-time-screen`, `credit-cards`, `add-credit-card`, `order-submitted`, `login`,
     `verify-code`, `insert-customer-name`, `ai-helper-onboarding`, `product-preview`. It matches
     ROUTE NAMES, so a new screen in those flows must be added to the list.
   - **Back minimizes only what is worth coming back to, and never blocks the app's own
     navigation.** Back and the edge swipe minimize a chat with a turn of the customer's own or
     items in the cart, and close an unused one (`leaveAction`). The `beforeRemove` listener acts
     ONLY on `GO_BACK` / `POP` (`isUserBack`): a reset after an order, a replace or a navigate must
     always go through — catching those would strand the customer after checkout.
   - **Closing closes the window only.** Dropping the bubble on the × calls `forYouStore.close()`,
     which changes `chatUi` and nothing else: the conversation stays and the cart is never touched
     (the bubble only reads the cart count); a "رجّع" toast undoes it. Expanding pops back to a chat
     still in the stack (`StackActions.popTo("for-you")`) — never a second copy — else navigates with
     `{ restore: true }`.
21. **FOR YOU IS GATED ON THE SERVER, AND EVERY REPLY IS LOGGED** (`services/ordering-intelligence/
   access.js`, `served-log.js`, `routes/for-you.js`; app `helpers/for-you-access.ts`,
   `helpers/for-you-attribution.ts`; `docs/for-you.md`).
   - **One rule, both sides:** `chat = isChatSuggestEnabled && (isChatSuggestForAll || employee)` is
     the MASTER switch; the AI helper, its onboarding, ordering in the chat and the bubble all need
     it. "Employee" is `!!customer.isShoofiEmployee`, read the way `routes/customer.js` gives it to the
     app, so the two never disagree on who is in the pilot. `POST /api/for-you/suggest` checks it
     before any work and answers the usual `200 unavailable` when it says no — no index read, no
     Claude call. A gate that cannot read its switches stays shut.
   - **Every reply is served with a `suggestionId`** and leaves, without delaying the reply, one
     `[for-you] served` log line (path rules · ai · ai_fallback · off · error with the fallback
     reason, reply code, counts before/after avoid, cards dropped by the live and the last check,
     the `seen` ids applied and the `seenTopUp` cards (invariant 23), `ms` per stage, Claude's
     model/tokens/cost) and one `shoofi.forYouServed` audit row (TTL 30
     days on `createdAt`; masked text, avoid keys, Claude's masked reply, and per card the labels that
     let it through). `deleteCustomerServed` removes a customer's rows (wiring it into account
     delete is customers-domain HIGH-RISK work — customers CORE Known status). Never log the raw
     device id or unmasked text.
   - **Attribution stays on the phone:** the app notes dishes added from the chat or from a store a
     card opened (24 h) and adds `for_you_lines` / `for_you_suggestion_ids` to the
     `order_submit_success` analytics event. The order API, cart lines and `getCartData` are untouched.

22. **FOR YOU QUALITY: THE REVIEWER PROPOSES, PEOPLE DECIDE** (`services/for-you-quality/`,
   `routes/admin/for-you-quality.js`, `utils/crons/for-you-review-cron.js`; delivery-web
   `views/admin/for-you-quality/`; `docs/for-you-quality.md`; reference §7h).
   - **The funnel reads its own copy of the events.** `POST /api/app-logs/insert` copies the For-you /
     AI-helper events and the checkout events into `shoofi.forYouEvents` — customer app only, 90-day
     TTL, **no customer id** (the funnel counts phones by `device-id`), fire-and-forget. `apps-logs`
     is indexed only by `{userId, created}`: never query it by date for this. **An insert never
     waits for its indexes** (one shared build per db, retried on failure) — awaiting them dropped
     the first burst of events after the collection was created; the served audit row follows the
     same rule. The event names, `for_you_lines` and the onboarding question order
     (`ONBOARDING_FLOWS` ↔ app `onboarding-logic.ts`) are a contract: rename one and a funnel step
     silently reads zero — change `funnel.js` in the same PR.
   - **The nightly reviewer only proposes.** 05:30 Israel, Redis-locked, reviews yesterday's
     conversations (the app's `conversationId`; home-box loads, `surface: "home"`, are not
     conversations). Free exact checks first — an avoid conflict and an ignored "not X" are
     `critical`. Then a judge: Claude on the **paid API** (`MODELS.review`, `backend: "api"`, feature
     `for-you-review`) under its own daily budget (`forYouReviewDailyBudgetUsd`, default $3; with
     `forYouReviewMaxPerDay` and `forYouReviewSampleRate` — server-only fields on the platform config,
     Settings → Shoofi). Without a key the checks still run (`judgeSkipped: "no-api-key"`).
   - **A person's decision is never overwritten.** A re-run `$set`s only the machine's part (turns,
     outcome, checks, severity, priority) — `status` is `$setOnInsert`, `human` is written only by a
     decision — and the judge is not called (or paid) again for a conversation the same
     `PROMPT_VERSION` judged with the same turns. Decisions (agree · disagree
     with a verdict · fixed · dismiss · add_to_tests → `in_tests` + a `forYouGoldenCases` row) carry
     the actor from the token. Calibration = how often the judge's verdict matched a person's.
   - **No customer id in what outlives the audit:** `forYouReviews` (90 days) keeps the owner only as
     a one-way hash, golden cases keep none — so account deletion does not need them.
   - **"Not right?" — an employee's flag is believed, and goes first.** Employees see «مش مزبوط؟»
     under every chat reply (app `components/for-you/ReplyFeedback.tsx`); it is an analytics event
     (`button_clicked` `for_you_feedback`, the reply's `suggestionId`, reasons, a note) — no new
     endpoint. When the event copy sees one, `recordFeedback` queues that whole conversation at once
     with `flags` and `priority: -1` (above every critical; no judge call). A flag counts only on a
     conversation whose audit row belongs to a customer with `isShoofiEmployee` — `app-logs/insert`
     takes anyone's events. `flags` are always derived from the events, and one newer than a
     person's decision reopens the review.
   - **Targets are code** (`targets.js`): changed in a reviewed PR; the funnel ones are first guesses
     (2026-10-18), to be reset from pilot data. The API and the screen are `master|admin` only.

23. **A QUICK REPLY PREFERS WHAT THE CHAT HAS NOT SHOWN — AND NEVER GOES EMPTY BECAUSE OF IT**
   (`routes/for-you.js` `sanitizeSeen`, `suggest.js` `SEEN_MODES` / `modeCaps` / `topUpWithSeen`,
   `suggest-service.js` `topUpSeen`; `docs/for-you.md`; reference §7). Found while recording the
   marketing video: «فاجئني» re-served a dish the opener had just shown, and «الأكثر طلباً» repeated
   both of the opener's dishes.
   - **The contract:** `POST /api/for-you/suggest` takes `seen`, the card ids
     (`"<appName>:<productId>"`, newest first) the conversation already showed. `sanitizeSeen` keeps
     strings of ≤ 120 chars, deduplicated, the newest 40; anything else is ignored, never a 400.
   - **Who uses it:** `popular`, `surprise`, `new`, `drink`, `sweet`, `cross_sell` — never `usual`
     (repeats are its point), the opener (the first turn) or typed text (a dish matching what they
     typed is relevant again; the Claude path is text-only, so it never sees `seen`).
   - **How:** the same mode, every rule of it, runs on the unseen candidates — after `avoid`, with the
     profile weights computed once over all of them — so evidence tags, caps and the cart's-store rule
     hold by construction. That can change the answer, not only the order: `popular` with every
     popular dish already shown answers its own fallback, `opener_ideas`, over the rest. The normal
     reply rides along as `seenTopUp`.
   - **The top-up is decided AFTER `applyLiveMenu` and `dropAtServe`:** when fewer than
     `RULES.MIN_UNSEEN_CARDS` (2) unseen cards survive, the normal reply's other cards fill the reply
     in their normal order, through the same two checks, within the mode's caps (2 per store; surprise
     1 per store and 4 cards; with a cart the cart's store, uncapped). With nothing unseen left the
     reply code is the normal one (`drink_ideas`, not `drink_unavailable_store`). Deciding before the
     checks lets a sold-out unseen dish leave a one-card reply (test "top-up is decided AFTER the live
     re-check", `test/integration/for-you-seen.js`). The `[for-you] served` line carries `seen` (ids
     applied, 0 when the mode ignores them) and `seenTopUp` (cards the top-up added).
   - **The app** (`stores/for-you` `SEEN_MODES`, `seenCardIds`) sends the ids of every card the
     conversation showed, newest first, at most 40, for exactly these six modes; the list is the
     chat's own messages, so `reset()` (closing the chat, logout) starts it empty. The two
     `SEEN_MODES` lists — app and server — change together.

18. **PROMOTIONS ANNOTATE THE MENU; THEY NEVER CHANGE A PRICE** (`services/menu/promotions.js`).
    `applyMenuPromotions` stamps `menuData.promotions[]` and `product.promotions[]` (the
    "הנחה" badge) BEFORE the cache write, in both `GET /api/menu` and `POST /api/menu/refresh`
    — omitting it from refresh wipes every running deal until the TTL lapses. A deal's value
    depends on the whole cart, so `price`/`originalPrice` are untouched. Promotion writes
    (`routes/promotion.js`) clear BOTH cache keys (invariant 2). Nothing fires at `endDate`: a
    stale badge can sit up to 5 min, but every quote and order creation re-checks. Promotions
    live in the STORE db (they reference that store's product/category ids).
    **The store CARD outside the store** learns of a deal only through `storeCardPromotion`
    (same file): the home's `GET /api/shoofiAdmin/explore/categories-with-stores-v2` (in
    `storesMap`), v1 of it, `POST /api/shoofiAdmin/available-stores` and `POST /api/menu/search`
    put the newest running deal on each store as `store.activePromotion`
    `{_id,type,kind,titleHE,titleAR}` (null when none). The app card
    (`screens/stores/components/item.tsx`) shows a GENERIC "offer" badge for it — "عروض" /
    "מבצעים" (`promotion-store-tag`), never the title, because a store can run several deals at
    once — after a coupon, before the category-discount badge. **The home "حملات"/"מבצעים" row** is a different thing:
    a platform category (`shoofi.categories {isCampaign:true}`) whose membership
    `lib/campaign-category-sync.js` writes into `shoofi.stores.categoryIds` — an active coupon
    for the store, OR (`storeHasCampaignTrigger`) a per-store category with `discountPercent>0`
    / `isCampaign`, OR a promotion matching `buildActiveQuery()` right now. Promotion writes call
    `syncCampaignCategoryForStore`; a deal's start/end edge is picked up by the 10-minute
    reconcile cron (`utils/crons/coupon-campaign-category-cron.js`), and the explore cache is
    busted only on a real membership change. Before 2026-10-26 neither path knew about deals,
    so a deal-only store's offers showed only inside the store (support report, master-burger).

24. **CODE THAT WRITES A TRANSLATION ROW GOES THROUGH `writeOwnedTranslation` — NEVER THE PANEL
    ROUTES, NEVER A SHARED KEY** (`services/translations/owned-translations.js`; reference §2
    `translations`). `shoofi.translations` is one flat key space read by all three apps, so an
    overwrite of `free-delivery` changes that label everywhere at once.
    - **Never call or copy `POST /api/translations/{add,update}` from code.** They pick the DB from
      the `app-name` header (a store's app-name writes where nobody reads), `add` inserts a second
      row for an existing key without checking, `update` has no upsert and touches one row of a
      duplicated key, and none of the four routes has auth.
    - **`writeOwnedTranslation(shoofiDb, { key, ar, he, owner: { type, id } })`** writes the central
      `shoofi` DB only. It creates with `$setOnInsert` (upsert on `key`), and a later write
      `$set`s only rows whose `owner.type`/`owner.id` match. A key someone else holds throws
      `TRANSLATION_KEY_COLLISION` (the coupon-drafts approval answers 409). It never overwrites.
      Rows carry `seededBy: 'owned-translations'` and `owner`.
    - **Generated keys get their own namespace, built from an id and checked by a regex before
      any write.** Coupon labels: `coupon.<draftId>.<surface>`, with surface
      `checkout|store|store-sub|store-tag`, enforced by `LABEL_KEY_RE` in
      `services/coupons/coupon-drafts.js`. Use the id, not a coupon code: codes are typed, editable
      and reused. Dots are safe; `:` is not, because i18next reads it as a namespace. Keep
      `{{` and `$t(` out of generated values.
    - **Write the rows BEFORE the thing that shows them goes live.** A missing key renders as its
      raw slug in every app. There is no server cache to clear, but the apps fetch translations at
      boot only, so a session that is already open shows the slug until the app restarts.
    - There is **no unique index on `key`** (8 duplicate keys locally), so the `$setOnInsert`
      upsert is not race-proof against a concurrent insert of the same key. Generated keys are
      per-entity, which keeps that window theoretical. Don't add a unique index without
      de-duplicating first.

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
