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
- **Backlog (confirmed, safe to act on when asked):**
  1. `GET /api/menu` and `POST /api/menu/refresh` build the menu **differently** — `refresh` is a
     real admin-triggered action that re-caches under the same key, so clicking it degrades the
     live menu. Fix by extracting **one shared menu-builder** both call.
  2. Remove the dead lunr index (`lib/indexing.js` + its `indexProducts` call sites) — it indexes
     fields the schema doesn't have and runs on every product write. Touches product-write paths;
     test after.
- **Recorded risk, not yours to fix:** the server trusts client-sent extras prices (no server-side
  recompute). Any fix lives in the order-create path — hand off.

## Bulk product import (Excel) — runs in the browser, leaves no record
There is **no bulk-import endpoint and no import job**. The admin screen
`shoofi-delivery-web/src/views/admin/stores/ImportCategoriesProducts.tsx` parses the XLSX
client-side and then loops `await`-ing **one `POST /api/admin/product/insert` per row**
(`handleImport`, ~tsx:1132; `routes/product.js` insert handler). ~0.6 s/product, so a
5,000-row supermarket file takes ~50 minutes — measured end-to-end on
`all-new-supermarket-barcodes`, 2026-09-08: 4,793 products in 47 min at ~95–100/min.
Consequences you must state rather than guess at:
- **The run lives in a browser tab.** Closing/refreshing it stops the import mid-file with no
  server-side trace, and no way to reconstruct which rows failed (per-row errors are a toast).
- **"Is the import done?" is only answerable from the data.** There is no status document, no
  `importId` on the product, nothing in `apps-logs`. Poll `<appName>.products.countDocuments({})`
  until it stops rising for ~3 minutes; `products.createdAt` is a real BSON Date.
- **Categories are created just-in-time**, in file order, immediately before their first product
  (`POST /api/store-category/add`) — so the newest category names tell you how far through the
  file the run is. `POST /api/category/general/add` stamps no `createdAt`; sort by `_id` there.
- **The server blind-inserts** — no upsert, no unique index on `barcode`. The only dedupe is
  client-side, from the `GET /api/admin/product/import-index` snapshot taken when the file was
  picked (barcode first, exact name as fallback). A re-run after a crash is only ~idempotent if
  the operator re-selects the file and the rows carry barcodes.
- **Images are fetched by the server inside the insert call** from the sheet's `Image URL`, and a
  download failure is swallowed as `img: []` with HTTP 200. Audit with `{img: {$size: 0}}`.
- Not the same machinery as cloning a template: `POST /api/product/create-from-mock`
  (`routes/product.js`) *does* reject duplicate barcodes; the Excel path does not.

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
