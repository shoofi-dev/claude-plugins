---
domain: menu-catalog
last-verified: shoofi-server@561e3ca / 2026-07-28
scope: server-first (shoofi-server; clients mostly render what the server assembles)
reference: ./reference.md   # data model, endpoint tables, flows, options/extras detail
---

# Menu / Catalog — CORE (always read)

Products, categories, menu assembly, options/extras, availability & stock, catalog i18n.

## Scope
Server: `routes/menu.js`, `routes/product.js`, `routes/category.js`, the catalog slice of
`routes/store.js`, `routes/translations.js`, `routes/global-search.js`, `utils/menu-cache.js`,
`utils/order-stock.js` (stock semantics only). Docs: `docs/stock-management.md`,
`docs/menu-search.md`.
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
- **Backlog (confirmed, safe to act on when asked):**
  1. `GET /api/menu` and `POST /api/menu/refresh` build the menu **differently** — `refresh` is a
     real admin-triggered action that re-caches under the same key, so clicking it degrades the
     live menu. Fix by extracting **one shared menu-builder** both call.
  2. Remove the dead lunr index (`lib/indexing.js` + its `indexProducts` call sites) — it indexes
     fields the schema doesn't have and runs on every product write. Touches product-write paths;
     test after.
- **Recorded risk, not yours to fix:** the server trusts client-sent extras prices (no server-side
  recompute). Any fix lives in the order-create path — hand off.

## Recipe — add/modify a product field
1. Server: accept + persist it in the product insert/update handlers (`routes/product.js`).
2. **Expose it** in the `$project` blocks of the menu aggregation (`routes/menu.js`) or the client
   will never see it.
3. **Clear both cache keys** on every write path you touched (invariant 2).
4. Client (if needed): partner edit UI, customer display.
5. Verify: `npm run lint` (0 errors), `npm run routes:check` if routes moved, tests via the
   `shoofi-testing` cover-changes skill.

## Definition of done
Inherit `_shared-guardrails.md` §7. Here specifically: name every write path you touched and
confirm each clears both cache keys; never claim `smoke` passed without infra; fix the doc +
`context/assert/menu-catalog.assert.json` in the same PR if you find drift.
