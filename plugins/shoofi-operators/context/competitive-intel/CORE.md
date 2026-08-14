---
operator: competitive-intel
class: B (operator / department head — ships decisions, not code)
last-verified: shoofi-delivery-web@main + shoofi-server@main / 2026-08-14
scope: reads Haat + Tira Eat public/internal endpoints; reads shoofi-server data; writes briefs
---

# Competitive Intelligence — CORE (always read)

Two competitors operate in our towns: **Haat** and **Tira Eat**.

**The flagship question, and the reason this function exists:**

> **Which restaurants are open on Haat/Tira Eat right now, and closed on us?**

Every one of those is an order we lose without ever seeing it. After that: price gaps on the
same dishes, menu coverage, promos they run and we don't, ratings, and which stores they have
that we don't carry at all.

**None of it is possible until we can say "their store X is our store Y."** That mapping is
the foundation; everything else waits behind it. Sections 3–5 below are the design for it.

---

## 1. What exists today (do not re-derive this)

All competitor code lives in **`shoofi-delivery-web`**. **Nothing exists in `shoofi-server`.**

```
src/views/admin/competitors/HaatMenu.tsx          (~1149 lines)
src/views/admin/competitors/HaatStoreMenu.tsx     (~949)
src/views/admin/competitors/TiraEatMenu.tsx       (~227)
src/views/admin/competitors/TiraEatStoreMenu.tsx  (~442)
src/apis/admin/competitors/tiraeat.ts             (~239)
src/setupProxy.js                                 (dev-only CORS proxy for Haat)
```

It is a **manual, browser-side, one-shot menu importer**: a human opens the "מתחרים" section,
picks an area, clicks a store, and exports the menu to Excel so it can be used to build that
store's menu on our app. **Nothing is persisted. No snapshots, no history, no link to our
stores.**

### 1a. Tira Eat — public Firestore, no authentication at all
Project `tiraeatprod`, plain REST against
`https://firestore.googleapis.com/v1/projects/tiraeatprod/databases/(default)/documents`.
Client: `src/apis/admin/competitors/tiraeat.ts` (`fetchStores`, `fetchStore`, `fetchStoreMenu`,
`resolveMealOptions`).

- **Store list:** `GET {FIRESTORE_BASE}/rests?pageSize=300` — every store in the country in
  one call. `fetchStores` drops `nameUnique` falsy or `"0"`, and sorts by `positionInGrid`.
- **Per store:** `_id` (the Firestore doc id), `nameUnique`, `nameHebInner`, `nameHebOuter`,
  `restDesc`, **`restPhoneNumber`**, `logoPath`, `repPicPath`, **`isAvailable`**,
  **`isClosedManually`**, `isDelivery`, `isPickUp`, **`latitude`**, **`longitude`**,
  **`openHours[]`**, `categories[]`, `restCityId`, `searchTags[]`, `positionInGrid`.
- **Menu:** `menus/{storeId}{1..500}` plus `{storeId}Common`, fetched via `:batchGet` in chunks
  of 300. Meals carry `mealName`, `mealDesc`, `mealCat`, `price`, **`isMissing`**,
  `mealOptions[]`; option groups resolve against the Common doc by `opNameEn`.
  ⚠️ **~500 document reads per store.** Fine on request for one store. Do **not** put this on a
  schedule without an explicit decision — see the hard limits in the agent file.

### 1b. Haat — internal API, hardcoded bearer token
Host `https://user-new-app.internal.haat.delivery`. Requires ~20 headers including a **bearer
token hardcoded in `HaatMenu.tsx`** (expires 2030) and a generated `anonymousUserId` (cached
in `localStorage` under `haat_anonymousUserId`).

> 🔒 **Never print, copy, log or commit that token.** It is already committed in
> `shoofi-delivery-web`; that is a known problem, not permission to spread it. Read it from
> that source at call time if you must call the API — never into another repo, a config
> example, a brief, or a message.

- **Store list:** `GET /api/user/main-page/by-location?latitude=&longitude=&type=Restaurant|Market`
  → `categories[].stores[]`.
- **Per store:** `storeId` (**number**), `name`, `address` (free text), `icon`,
  **`rating { value, numberOfRatings }`**, `labels[] { text, labelType }` (promo badges),
  **`status`** — **`status === 2` means CLOSED** (rendered as a סגור chip in `HaatMenu.tsx`) —
  and `distance` from the query point.
- **Menu:** `/api/venue/{storeId}/menu` → meals with `namesDictionary` (ar/he/en), `price`,
  **`availability.isAvailable`**, `addonGroups[]` with `min`/`max` and `mealContents[]`.
  Market stores use `/api/venue/{storeId}/menu/categories/{categoryId}`.
- **Areas** are hardcoded in `HaatMenu.tsx` (`PREDEFINED_AREAS`: Kfar Qasem id 8 @
  32.1202395/34.9707303; Taybeh–Tira–Qalansawe id 12 @ 32.2393891/34.9503802). The response
  also carries `areasContainer.allAreas` / `areasInCountry[]` / `areasOutOfCountry[]` with
  `areaId`, `name`, `areaNameInEnglish`, `latitude`, `longitude` — **so the full area list is
  discoverable and should not be hardcoded again.**

### 1c. The two asymmetries that decide the whole matching design
1. **Tira Eat gives real coordinates and a phone number. Haat gives neither** — only free-text
   `address` and a `distance` relative to whatever point you queried from. So geo and phone
   matching work for Tira and are **simply unavailable for Haat**.
2. **Names are multilingual and inconsistent** — Hebrew, Arabic and English, with
   transliteration variants ("مطعم الشام" / "מסעדת שאם" / "Sham Restaurant"). Name matching
   alone will be wrong often enough to matter.

---

## 2. Our side — the store registry (verified, and it differs from the obvious assumption)

The central registry is **`shoofi.stores`** — the `shoofi` database, **not** a per-store one.
Written by `routes/shoofi-admin.js` (store create/update); read via `shoofiDb.stores`.

Fields relevant to matching:

| Field | Notes |
|---|---|
| `appName` | **The primary key everything joins on** — it is literally the tenant's Mongo database name (`lib/db.js`). ⚠️ **Uniqueness is NOT enforced**: there is no index on `appName` at all, and the main `store/add` path has no duplicate check (only `create-from-mock` does). De-facto unique; do not model a foreign key on a constraint the database isn't holding. |
| `name_ar`, `name_he` | ⚠️ **There is NO `name` field** — none of the three write paths in `routes/shoofi-admin.js` ever writes one. But **`storeName` DOES exist on legacy docs**, and those legacy docs carry *no* `name_ar`/`name_he` at all — so a matcher that reads only the snake_case pair silently drops them. **Always resolve names through `getStoreDisplayNames(shoofiDb, appName)`** (`utils/store-display-name.js`) — it is the only place handling all three shapes (`name_ar`/`name_he` → `nameAR`/`nameHE` → `storeName` → `appName`). Never read `store.name`; several call sites do and always log `undefined`. |
| `phone` | ⚠️ **On the registry this is effectively dead** — written as `phone: phone \|\| ''` and observed non-empty in *zero* sampled docs. The **authoritative** phone is on the per-tenant `<appName>.store { id: 1 }` doc; the resolution order the platform uses is `storeData.phone \|\| store.phone \|\| ''` (`/api/shoofiAdmin/store/status`). **Do not source phone from the registry** — see §3.2A, this makes the strongest matching signal a per-store fan-out. (Unrelated, easy to confuse: `storePhone`/`waSupportPhone`/`shoofiSupportPhone` are on the *platform config* doc `shoofi.store`, not a store's phone.) |
| `address` | Free text, defaults to `''` — observed non-empty in zero sampled docs. Useless for matching. |
| `location` | GeoJSON `{ type: 'Point', coordinates: [lng, lat] }`, but written **conditionally** (`...(location ? { location } : {})`) — observed on roughly **1 in 5** stores. ⚠️ **There is no 2dsphere index on it**, and no code anywhere runs `$near`/`$geoWithin` against the registry — it is only ever used as the *input point* for geo queries on other collections. A geo block therefore needs that index created first (§3.1). A store with no `location` cannot be geo-matched; that is a data gap, not a mismatch. There is also an `ipadLocation` Point, and the *operational* geo point is duplicated on the per-tenant doc and can drift. |
| `supportedCities` | `ObjectId[]` into **`delivery-company.cities`** (not `shoofi.cities`, which is empty). ⚠️ Three traps: (a) in the delivery model a **`cities` doc is a pickup *zone*, not a town** — `parent-cities` is the town; (b) the array is **mixed BSON types** — a couple of legacy docs hold strings, which an `$in` of ObjectIds silently misses; (c) it is a **many-valued serving list, not a home town** — the "exactly one supportedCity per store" cleanup is still in flight (`/api/delivery/admin/stores/sync-supported-cities/preview`). Do not build a 1:1 store→town mapping on it yet. Delegate to `shoofi-domains:delivery`. |
| `business_visible`, `isMockStore`, `isCoomingSoon` | The live-store filter. Reuse `LIVE_STORE_FILTER` / `getLiveStores` from `services/exec-dashboard/store-registry.js` verbatim (`isCoomingSoon` — the double "o" is the real field name). Note `business_visible` is **absent** on some docs — absent must read as not-visible, which is what that filter already does. |
| `_id` | Stable ObjectId; `storeReports.storeId` and `routes/hyp.js` join on it. Carry it alongside `appName` on a mapping row, mirroring what `getLiveStores` returns. |
| — | **No slug, no business/tax id, no external URL on the registry.** The tax id is `accounting.bankAccount.companyId` on the **per-tenant** doc — the closest thing to a real-world business identifier, and HYP already uses it to group sibling stores under one legal entity. Not available for matching without a fan-out. |

### 2a. ⚠️ Our open/closed state is NOT on the registry, and NOT stored at all
`openHours` and `isStoreClose` live on the **per-tenant `<appName>.store { id: 1 }`** document,
not on `shoofi.stores`. And `isOpen` is **computed per request** —
`storeService.isStoreOpenNow(openHours)` in `utils/store-service.js`, combined as
`storeStatus.isOpen && !store.isStoreClose` (see `routes/store.js` `/api/store/get-by-name`).

Two consequences the flagship question runs straight into:
- Answering "are we closed right now" for every store is a **fan-out across per-store
  databases**, not one registry query. Mirror `services/exec-dashboard/store-registry.js` —
  it exists precisely to do that correctly (lazy-init every store, and report
  `unavailableStores` instead of silently returning a smaller number).
- **There is effectively no history of when we were open — on either side.** So "they were
  open and we were closed" can only ever be answered *for right now*, at the moment you ask.
  Any historical claim requires snapshots, which do not exist yet and are out of scope. **Say
  this in every brief that touches open/closed.**

  Two near-misses that look like history and are not:
  - `store-update-history` (per-tenant, written by `POST /api/store/update`) logs
    `isStoreClose` / `openHours` / `business_visible` changes with old and new values. It is an
    **edit log, not a state timeline** — it only fires when a human or API edits the doc, so it
    never records "closed because we fell outside `openHours`", which is most closures.
  - A persisted `isOpen` exists on the per-tenant doc (written by
    `utils/crons/store-auto-close.js`), but **no read path uses it** — `routes/store.js`
    recomputes and overwrites it in the response. Treat it as vestigial; never read it.

---

## 3. The matching design

### 3.0 The rule that outranks everything else
> **Only a human-confirmed link may ever be used by a brief.**

A confidently wrong comparison — "we were closed and they were open" — is worse than no
comparison, because it gets repeated in a meeting and then acted on. Propose automatically,
let a person confirm, and **make the unconfirmed state visible** in every output.

This is the same pattern the Slack bridge uses for skills: written, run, shown to a human, and
only their "yes" puts it on the fast path. A rejected one is demoted instantly.

### 3.1 Block before you compare
Do **not** compare every competitor store against every store of ours. The largest lever on
name-matching accuracy is not a cleverer algorithm — it is a **smaller candidate pool**.

- **The primary block is `supportedCities`, not geo** — because only about one store in five
  has a `location`, and there is no 2dsphere index on the registry to `$near` against (§2).
  Map the competitor's town to the `delivery-company.cities` zone ids that cover it and take
  our live stores serving them. Handle the mixed ObjectId/string trap when you do.
- **Tira Eat** → *additionally* narrow to our stores within **2 km** of `latitude`/`longitude`,
  **for the subset that has a `location`**. Doing this as a `$near` requires creating a
  2dsphere index on `shoofi.stores.location` first; until then, compute Haversine in memory
  over the town-blocked candidate set, which is small enough. Stores with no `location` stay in
  the candidate set on the town block alone — a missing coordinate must never *exclude* one of
  our stores.
- **Haat** → we know which **area** we queried the store list from, so candidates are our live
  stores in that town. Haat gives no coordinates, so there is nothing better.
- Never propose a link to a store that fails `LIVE_STORE_FILTER` (mock / invisible /
  coming-soon).

### 3.2 The signals

**A. Phone — Tira only. The strongest single signal, with two traps.**
Normalise both sides to E.164 digits: strip everything non-digit, drop a leading `+`, map a
leading `0` to `972`, and collapse `00972`/`972` to `972`. Compare the canonical strings.

⚠️ **Trap one — our phone is not where you'd expect it.** `shoofi.stores.phone` is written as
`phone || ''` and is empty in practice; the real number is on the **per-tenant
`<appName>.store { id: 1 }`** doc (§2). So the strongest signal we have costs a **fan-out
across per-store databases**, the same as open/closed. Build the phone index once per proposal
run using the `services/exec-dashboard/store-registry.js` fan-out pattern (lazy-init every
store, report `unavailableStores` rather than silently matching fewer) — do not re-read it per
candidate. **A store whose DB was unreachable is "phone unknown", never "phone mismatch".**

⚠️ **Trap two — a phone number is not unique.** A chain shares one number across branches, and
a small business may list the owner's mobile. So:
- exact match, and the normalised number matches **exactly one** of our stores **and exactly
  one** competitor store → **strong**;
- exact match but the number is **shared** by more than one store on either side → **weak**,
  and flag it `phoneAmbiguous: true`. Never let an ambiguous phone carry a link on its own.
- our phone is `''` / missing / the store DB was unreachable → **absent**, contributes nothing.
  It is not evidence against a link.

**B. Geo — Tira only. Never a primary signal.**
Haversine between `shoofi.stores.location.coordinates` `[lng, lat]` and Tira's
`latitude`/`longitude`.
- `< 150 m` → **strong corroboration**
- `150–500 m` → **weak corroboration**
- `> 500 m` → contributes nothing (and above ~2 km, actively argues against)

*Why never primary:* a commercial street or food court puts five unrelated restaurants inside
50 m. Geo can raise the confidence of a name or phone candidate; it must never create one.

*Why phone + geo together is genuinely strong:* the **phone identifies the business** and the
**geo disambiguates the branch** — each covers exactly the other's failure mode. That pairing
is the only combination worth considering for auto-confirmation (§3.4).

**C. Name — the only signal available for Haat, and the hard one.**

Normalise before comparing:
1. Unicode NFKC; lowercase Latin.
2. Strip Hebrew niqqud (U+0591–U+05C7) and Arabic diacritics (U+064B–U+0652, U+0670) and
   tatweel (U+0640).
3. Unify Arabic letter forms: `أإآٱ → ا`, `ة → ه`, `ى → ي`, `ؤ → و`, `ئ → ي`.
4. Unify Hebrew finals: `ך ם ן ף ץ → כ מ נ פ צ`.
5. Drop punctuation, quotes and the Arabic/Hebrew definite article as a bound prefix
   (`ال`, `ה` before a generic word); collapse whitespace.
6. **Drop generic tokens** — `מסעדת`/`מסעדה`, `مطعم`, `restaurant`, `קפה`/`كافيه`/`cafe`,
   `פיצריה`/`pizzeria`, `בורגר`/`برجر`, `grill`/`גריל`… **and drop the town name**
   (`טירה`/`الطيرة`, `טייבה`/`الطيبة`, `כפר קאסם`/`كفر قاسم`, `קלנסווה`/`قلنسوة`…) — competitor
   names often append the branch town and ours often don't.
   **Rule: strip a generic token only if at least one token survives.** "פיצה" can be the
   entire distinguishing name.

Then compare, and take the **maximum** over every pairing:
- **every name `getStoreDisplayNames` can produce for us** — `name_he`, `name_ar`, and on
  legacy docs `storeName` (there is no `name` — §2) — plus the `appName` slug itself, which is
  often a latinised store name and is worth trying;
- against Tira's `nameHebInner`, `nameHebOuter`, `nameUnique`, and `searchTags[]`;
- against Haat's `name` (and `namesDictionary` ar/he/en once you're inside a menu).

Score = `max(` token-set Jaccard, character-bigram Dice on the joined string `)`.

**Same-script comparisons are trustworthy. Cross-script comparisons are not.** Try
Hebrew↔Hebrew and Arabic↔Arabic first; only fall back to cross-script.

*Cross-script fallback — a consonant skeleton, not a transliteration.* Map both strings into a
small phonetic alphabet where cognate letters collapse and vowels are dropped entirely
(`ש ش → S`, `ס ص س ث → S`, `ק ق k כ ك → K`, `ב ب → B`, `ח ح → H`, `ט ت ת ط → T`…) — effectively
Soundex for abjads. Compare skeletons with bigram Dice. **This will produce false positives.**
A cross-script name match alone may never rise above **weak**.

*Worth doing, as a tiebreaker only:* for the shortlist, an LLM adjudication pass — the agent
reads "مطعم الشام" vs "מסעדת שאם" and says *same business, yes/no, why*. This is exactly where
a model beats a string algorithm, and `@anthropic-ai/sdk` is already in `shoofi-server`. It is
still a **proposal**, never a confirmation.

**D. Address — Haat only, and only as human-readable evidence.** Do not parse Haat's free-text
`address` into a match score. Carry it verbatim on the proposal so the human confirming has
something concrete to check.

### 3.3 Tiers, not one opaque number
Keep the **raw evidence** and derive a tier from **explicit, readable rules**, so a human can
audit *why* something was proposed. Keep a numeric `score` too, but only for ordering the
review queue.

| Tier | Rule |
|---|---|
| `strong` | unambiguous phone match **and** geo < 150 m (Tira only) |
| `probable` | unambiguous phone match alone; **or** same-script name ≥ 0.85 **and** geo < 500 m |
| `weak` | same-script name ≥ 0.85 alone; or cross-script name ≥ 0.85; or ambiguous phone; or name ≥ 0.7 with geo < 150 m |
| — | anything below → no proposal; the row stays unmatched |

**Haat can only ever reach `weak` or `probable`-by-name.** A Haat link therefore
**never auto-confirms** — it rests on name plus a free-text address, and that is not enough to
put a number in front of a person unchallenged.

### 3.4 Auto-confirmation — narrow, auditable, and off until someone says otherwise
If auto-confirmation is allowed at all, it requires **two independent strong signals**:
unambiguous phone **and** geo < 150 m — i.e. tier `strong`, Tira only — **plus** a name score
above a floor (≥ 0.4) so that a shared phone at a shared address (two kiosks in one food
court) still can't slip through.

It is recorded as **`confirmedBy: 'auto:v1'`**, never as a person, so every machine decision is
auditable and reversible in bulk when the rule changes. **Recommendation: ship it behind a
flag, default OFF for the first run**, so a human first eyeballs the list of links it *would*
have confirmed. See §6 Q1 — this is a human's decision, not the agent's.

### 3.5 The write rules that make §3.0 true
1. **An automated run may never set or change `appName` or `status` on a row that is
   `confirmed`, `rejected` or `no-match`.** Those fields are human-owned. A refresh run updates
   `externalName*`, `externalPhone`, `externalLocation`, `lastSeenAt` freely.
2. A **`rejected` pairing is blacklisted for that pair only** — record it in
   `rejectedAppNames[]` and let the competitor store return to the pool for a *different*
   proposal. Never re-propose a pair a human already rejected.
3. **Never delete a row.** A competitor store that stops appearing is itself signal; keep it
   and let `lastSeenAt` go stale.
4. Store `externalId` as a **string, always** — Haat's `storeId` is a number and Tira's `_id` a
   string, and a mixed-type unique index is a bug waiting to happen.

---

## 4. The mapping collection — `shoofi.competitorStores`

**Central `shoofi` database, not a per-store one — deliberately.** A competitor store is a
platform-level fact: it is not owned by any tenant, it must be matched against *all* our
stores at once, and the coverage-gap question is answered across the whole platform. Putting it
in a per-store DB would fragment the one list that has to be whole, and would make
cross-tenant reads necessary to answer any question worth asking. This is exactly the kind of
"is this cross-DB access intentional?" decision `_shared-guardrails.md` §3 asks to be
deliberate about: it is, and it is one-way — we read `shoofi.stores`, we never read into a
tenant DB from here.

```
{
  source:        'haat' | 'tiraeat',
  externalId:    string,               // Tira `_id`; Haat `storeId` — ALWAYS stringified
  externalNames: { primary, he, ar, en },
  externalAddress: string | null,      // Haat free text; null for Tira
  externalPhone:   string | null,      // Tira only; stored normalised (E.164 digits)
  externalLocation: { type: 'Point', coordinates: [lng, lat] } | null,   // Tira only
  externalArea:  string | null,        // Haat areaId/name the store was listed under

  appName:       string | null,        // our store, once linked — the natural key
  storeId:       ObjectId | null,      // the registry `_id`, carried alongside: `appName` has
                                       //   no unique index (§2), so keep the stable id too
  status:        'unmatched' | 'proposed' | 'confirmed' | 'rejected' | 'no-match',
  tier:          'strong' | 'probable' | 'weak' | null,
  signals:       ['phone' | 'geo' | 'name' | 'manual'],   // ALL that supported it, not one
  score:         number,               // review-queue ordering only
  evidence: {
    distanceMeters, nameSimilarity, nameScript, phoneMatch, phoneAmbiguous, addressText,
    candidates: [{ appName, score, signals }]   // the near-misses, for the review screen
  },
  rejectedAppNames: [string],          // pairs a human has already said no to

  confirmedBy, confirmedAt,            // 'auto:v1' or a human id — never blank on `confirmed`
  firstSeenAt, lastSeenAt, updatedAt
}
```

**Indexes:** unique on `(source, externalId)`; plus `appName`, `status`,
`(status, score)` for the review queue, and a 2dsphere on `externalLocation`.

**Two changes from the first sketch, and why:**
- `method: 'phone'` → **`signals: []`**. A link is usually supported by several signals at
  once; recording only the strongest throws away exactly the evidence a reviewer needs.
- `status` gains **`unmatched`** — a competitor store we have seen but for which nothing scored
  above the floor. It is a different thing from `proposed` (we have a guess) and from
  `no-match` (a human looked and decided). Without it, "not yet processed" and "processed,
  nothing found" are indistinguishable.

### 4a. `no-match` is the valuable one — keep it distinct from `rejected`
- **`rejected`** — *this specific proposed pairing was wrong.* A statement about one guess. The
  competitor store goes back in the pool.
- **`no-match`** — *a human reviewed the candidates and we do not carry this store at all.*
  That is not a failure; it is **the acquisition list**, and arguably the most valuable output
  of the whole exercise.

Collapsing them makes the opportunity list indistinguishable from the reject bin. Keep both.
One caveat: `no-match` is **terminal but revisitable** — when we onboard a new store, every
`no-match` row should be re-scored against it, because the answer may have just changed.

### 4b. How to build it in `shoofi-server` (the repo's conventions, verified)
- **Register the collection and its indexes in
  `services/database/DatabaseInitializationService.js`**, with the `createIndex` calls **inside
  the `if (databaseName === 'shoofi')` guard**. That guard is load-bearing: without it the
  collection is created — empty — in *every tenant database*. Handle is camelCase
  (`db.competitorStores`), collection name kebab-case (`competitor-stores`).
- **Mirror `routes/team-tasks.js` + `services/team-tasks/`.** It is the newest purpose-built
  central-only collection and the right template: `const db = req.app.db["shoofi"]` (bracket
  form) in thin handlers, logic in `services/`, an admin-role guard, a `unique, sparse` index
  used to make seeding idempotent, and real coverage in `test/integration/`. Its header states
  the rule outright: *all data lives in the central `shoofi` DB, never a per-store DB.*
- **Reuse, don't re-derive:** `LIVE_STORE_FILTER` and `getLiveStores` from
  `services/exec-dashboard/store-registry.js`, and its fan-out rule — never write
  `if (!req.app.db[appName]) continue;` before `getOrInitializeDb`, because that guard defeats
  the lazy loader and silently drops stores created after the container booted.
- Services take `appDb` as a parameter and do `appDb["shoofi"]` internally. Never pass `req`
  into a service.

---

## 5. Known status (human-confirmed — do NOT "fix")
- **Corrections to the original brief, verified against `shoofi-server` on 2026-08-14** — these
  are the ground truth, the brief was wrong. Do not "restore" any of them:
  - `shoofi.stores` has **no `name` field** — but legacy docs do carry **`storeName`**, and
    those same docs carry no `name_ar`/`name_he`. Always go through `getStoreDisplayNames`.
  - `openHours` / `isStoreClose` are **not** on `shoofi.stores` — they are on the per-tenant
    `<appName>.store { id: 1 }` doc, so any open/closed comparison is a **per-store DB
    fan-out**.
  - **`phone` is the same story** — the registry's is empty in practice; the real one is
    per-tenant. Our strongest matching signal is a fan-out, not a registry read.
  - `shoofi.stores.location` is written **conditionally**, populated on roughly 1 store in 5,
    and has **no 2dsphere index**. Geo cannot be the primary block.
  - `appName` has **no unique index** and the main create path has no duplicate check.
  - `supportedCities` holds **mixed ObjectId/string** values and is a many-valued serving list,
    not a home town; the one-town-per-store cleanup is still in flight.
- **BY DESIGN, do not "fix":** our own open/closed state is computed per request and never
  persisted as a timeline. There is therefore no usable history on either side of the
  comparison (§2a covers the two near-misses that are not it). That is a known gap; snapshots
  are a **later task**, deliberately not built yet.
- **BY DESIGN:** the Slack bridge's database credential is **read-only**, and that is
  load-bearing. Anything that writes belongs in `shoofi-server`, never in the bridge.
- **KNOWN PROBLEM, not yours to fix here:** the Haat bearer token is committed in
  `shoofi-delivery-web`. Do not spread it; flag it, don't paper over it.
- **Defects found while grounding this doc, deliberately left alone** (other domains' code —
  hand off, do not fix from here): `store.name` is read off registry docs in
  `services/delivery/RestaurantAvailabilityService.js` and `routes/delivery/admin.js` and is
  always `undefined`; and `utils/crons/store-auto-close.js` calls
  `clearExploreCacheForStore(storeData)` where the in-scope variable is `store`, so every
  auto-close throws and the explore cache is never cleared.

## 6. Decisions on record (human-confirmed 2026-08-14 — do NOT re-litigate)
1. **Auto-confirm: allowed, narrowly, and flag-gated.** Tier `strong` only — unambiguous phone
   **and** geo < 150 m **and** name above the 0.4 floor, Tira Eat only. Recorded as
   `confirmedBy: 'auto:v1'`. **Default OFF for the first run**: the run reports what it *would*
   have confirmed, a human eyeballs that list, and only then is the flag turned on.
2. **Scope: collect country-wide, match and brief only over towns we deliver in.** Tira's whole
   country list is one call, so the extra rows are nearly free — and the out-of-town rows are
   the expansion map. ⚠️ *"Towns we deliver in" is not yet cleanly defined* — coverage is keyed
   on delivery **pickup zones**, and the one-town-per-store cleanup is in flight (§2). Get the
   definition from `shoofi-domains:delivery`; do not invent one.
3. **Confirmation surface: a script now, an admin screen next.** A CLI that prints the queue
   ordered by `score` with the near-miss `candidates`, taking confirm / reject / no-match. The
   endpoints are identical either way, so this validates the matching against real data before
   any UI is built.
4. **`no-match` stays distinct from `rejected`** — §4a stands. `no-match` is the acquisition
   list and must be re-scored whenever we onboard a new store.

## 7. Explicitly out of scope right now
No scheduled collectors or crons. No competitor snapshots or history. No menu scraping, no
price comparison. No brief generation, no Slack posting. Those are the **next** tasks and will
be asked for separately — building ahead makes the matching design harder to review, and that
is the one thing that has to be right before any of it is worth having.

## Definition of done
See the agent file. In short: a dated brief a human reads in two minutes, every claim traceable
to a named source, confirmed-vs-unconfirmed counts on the face of it, no secrets anywhere, and
you stopped at the human gate.
