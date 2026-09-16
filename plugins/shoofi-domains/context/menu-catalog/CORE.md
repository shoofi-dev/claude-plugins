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

## Known status (human-confirmed — do NOT "fix")
- **BY DESIGN:** translations resolve to the **central** DB — UI labels are global/platform-wide,
  not per-store. Do **not** re-route them to `app-name`.
- **FACT (not a bug):** `supportedCategoryIds` are strings (invariant 5).
- **FACT — a general category with no linked store category does not exist to the customer.**
  `routes/menu.js` filters the tree down to general categories that have at least one
  subcategory (`generalCategories.filter(gc => gc.subCategories.length > 0)`, customer apps only
  — `shouldShowHiddenProducts` skips it), and the join it filters on is
  `category.supportedGeneralCategoryIds.some(id => id === generalCategory._id.toString())`. So a
  store can hold a dozen `general-categories` documents, show all dozen on the admin screen, and
  ship `generalCategories: []` to the app. **Before calling a store's general categories
  "missing", count the LINKS, not the documents:**
  `db.categories.countDocuments({'supportedGeneralCategoryIds.0': {$exists: true}})`. Measured
  2026-09-16: 39 of 247 store DBs have any link at all, and `mini-market-jiousi` had 12 general
  categories, 351 categories and **zero** links — which is why a human deleted the twelve as
  useless. Three more things a grep gets wrong here:
  (a) `supportedGeneralCategoryIds` is **strings**, like invariant 5 — 2,062 values across those
  39 stores, 100% strings, written by `routes/store.js` `/api/store-category/add|update` through
  `JSON.parse`. An ObjectId query never matches one — which is why
  `GET /api/category/by-general/:id` (`routes/category.js`, `$in: [getId(id)]`) returns `[]` for
  every store on the platform. Fix proposed on shoofi-server
  `fix/create-from-mock-silent-empty-store`; unmerged as of 2026-09-16.
  (b) The gate is the **per-store** `<appName>.store.hasGeneralCategories`, read by
  `routes/menu.js` off `db.collection('store').findOne({id:1})` — *not*
  `shoofi.stores.hasGeneralCategories`, which the admin store form writes and the menu never
  reads. They disagree on several live stores.
  (c) `general-categories` exists as a collection in **both** the central `shoofi` DB (platform
  verticals) and **every store** DB, behind the one `db.generalCategories` handle. The add/update/
  delete routes in `routes/category.js` pick between them on the `app-name` header alone, so the
  same admin button edits the platform list or one store's list depending on which store is
  selected. `shoofi.stores.supportedGeneralCategoryIds` is a third, **dead** field — `[]` on every
  store, no writer in any admin UI, and stored as ObjectIds by the server where everything else is
  strings.
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
