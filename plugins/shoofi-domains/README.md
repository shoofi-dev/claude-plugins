# shoofi-domains — domain-owner subagents

One agent per territory of the Shoofi platform. Each is **full-stack by default** (its
domain spans all 5 repos) and ships work as **pull requests you review** — never a merge.

## The fleet

| Agent | Owns | Scope |
|---|---|---|
| `menu-catalog` | products, categories, menu assembly, extras, availability/stock, catalog i18n | server-first |
| `orders` | order creation, status lifecycle, twin orders, tracking/monitoring | full-stack |
| `payments` | **money IN** — card charges, tokenization, Apple/Google Pay, customer refunds | server + customer app |
| `accountant` | **money OUT** — settlement reports, commission, tax invoices, driver payouts, MASAV | server + admin web |
| `delivery` | driver assignment, area/coverage model, bookDelivery, shifts, location | full-stack |
| `customers` | phone+OTP auth, tokens/sessions, profiles, addresses, referrals | full-stack |

## Layout

```
agents/<domain>.md            # routing description + the few non-negotiables
context/
  _shared-guardrails.md       # the constitution every agent inherits
  <domain>/CORE.md            # ALWAYS read: scope, invariants, known-status, recipes
  <domain>/reference.md       # read on demand: data model, endpoints, flows, clients
  assert/<domain>.assert.json # machine-checkable claims (see docs:check)
scripts/docs-check.js         # drift checker
```

**Progressive disclosure:** agents always load `CORE.md` (short) and pull `reference.md`
only when the task needs depth. That keeps the common case cheap without losing the detail.

**Anchors, not line numbers.** Docs name symbols and files, never `file.js:1234` — line
numbers rot on the next edit. Find code by grepping the symbol.

## Keeping the docs honest — `docs-check`

Context docs go stale silently, and a confidently wrong doc is worse than none: the agent
acts on a lie. Each domain declares what it claims exists in
`context/assert/<domain>.assert.json` — files, symbols, and patterns (status enums, key
formulas). The checker verifies them against real checkouts:

```bash
node scripts/docs-check.js \
  --repo shoofi-server=../shoofi-server \
  --repo shoofi-app=../shoofi-app \
  --repo shoofi-partner=../shoofi-partner \
  --repo shoofi-shoofir=../shoofi-shoofir \
  --repo shoofi-delivery-web=../shoofi-delivery-web
```

Repos you don't supply are skipped and reported, so it's useful from inside any single
repo's CI. Zero dependencies — it runs without an install. A rename now **breaks the build**
instead of misleading the next agent.

In `shoofi-server` it's wired as `npm run docs:check` and runs in CI alongside lint/deadcode.

## Adding a domain

1. `agents/<domain>.md` — routing `description` (this is how the main agent picks it) +
   pointer to CORE + the handful of things that matter most.
2. `context/<domain>/CORE.md` — scope, invariants, human-confirmed known-status, recipes.
3. `context/<domain>/reference.md` — the depth.
4. `context/assert/<domain>.assert.json` — what must remain true.
5. Run `docs-check` before committing.

**Never delete a `Known status` entry** — those encode human verdicts (bug vs by-design,
migrations in flight) that exist nowhere in the code. Only a human changes them.
