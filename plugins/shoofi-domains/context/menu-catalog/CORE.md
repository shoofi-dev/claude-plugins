---
domain: menu-catalog
last-verified: shoofi-server@a12977e3 / 2026-09-21
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
worklist writer + nightly run), `routes/admin/catalog-lint.js`, `utils/crons/catalog-lint-cron.js`.
Docs: `docs/stock-management.md`, `docs/menu-search.md`, `docs/sold-by-weight.md`,
`docs/menu-import-issues.md` (the worklist — now also documents the `lint` phase).
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
