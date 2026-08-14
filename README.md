# Shoofi Claude Code plugins

A Claude Code **plugin marketplace** that distributes shared skills and
domain-owner subagents across the 5 Shoofi repos — so they work in **local**
sessions *and* **cloud** runs (scheduled routines, the Slack agent), without
copy-pasting into each repo.

## Plugins

| Plugin | Provides | What it does |
|--------|----------|--------------|
| `shoofi-testing` | `/shoofi-testing:cover-changes`, `/shoofi-testing:local-app-e2e` | **cover-changes**: after finishing a feature/bug, generates the tests covering the changed flow across the repo(s) it touched; bootstraps each repo's test infra (best-fit runner) on first use. **local-app-e2e**: stands up the local stack (Mongo + server on :1111) and drives the customer/partner/driver app through its real UI on an iOS simulator with Maestro. |
| `shoofi-domains` | `menu-catalog`, `orders`, `payments`, `accountant`, `delivery`, `customers` subagents | **Class A — code owners.** Domain "employees" — one per territory, **full-stack across all 5 repos** by default. Each loads the shared constitution + its human-reviewed context doc and ships work as PRs you review. Ships `docs-check`, a drift checker.|
| `shoofi-operators` | `competitive-intel` subagent | **Class B — operators ("department heads").** Own a *business function* rather than a slice of code: they feed on data and the outside world and ship decisions, alerts, briefs and drafts — **never product code**. Gate is **human approval**, not tests. |

### `shoofi-domains` — the domain-owner model

Each territory of the platform gets a **subagent** that owns it across every repo
it touches, paired with a **context document** (its human-reviewed ground truth).
The main agent delegates a feature/bug to whichever domain owns the area; that agent
loads the shared constitution, reads its context doc, respects the money/identity
guardrails, and works full-stack (one PR per repo it touches).

Every domain agent inherits **`context/_shared-guardrails.md`** — the platform
constitution (PR-only/never-merge, high-risk zones, multi-tenant scoping, full-stack
rules, legacy-hands-off, definition of done).

| Domain agent | Owns | Scope |
|--------------|------|-------|
| `menu-catalog` | products, categories, menu assembly, extras, availability/stock, catalog i18n | server-first |
| `orders` | order creation, status lifecycle, twin orders, tracking | full-stack |
| `payments` | **money IN** — card charges, tokenization, Apple/Google Pay, refunds | server + customer app |
| `accountant` | **money OUT** — settlement, commission, tax invoices, driver payouts, MASAV | server + admin web |
| `delivery` | driver assignment, area/coverage model, bookDelivery, shifts, location | full-stack |
| `customers` | phone+OTP auth, tokens/sessions, profiles, addresses, referrals | full-stack |

Each domain has `context/<domain>/CORE.md` (**always read** — scope, invariants, human
verdicts, recipes) and `reference.md` (depth, loaded on demand). See
`plugins/shoofi-domains/README.md` for the full model and the `docs-check` drift checker.

### `shoofi-operators` — the department-head model (Class B)

Where a Class A agent owns a slice of the **codebase**, a Class B operator owns a **business
function**. It feeds on data and the outside world, its brain is a mission + playbook rather
than a code map, and it ships **decisions, alerts, briefs and drafts — never product code**.
Its gate is a **human's approval**, not lint and tests. When an operator needs code written, it
writes the spec and hands it to the owning Class A agent.

| Operator | Owns |
|---|---|
| `competitive-intel` | Haat + Tira Eat — the coverage gap ("who's open on them and closed on us"), price gaps, menu coverage, promos, ratings, and the competitor↔our-store matching everything else depends on |

Planned: `social-media`, `marketing-growth`, `merchant-success`, `retention-crm`,
`bizops-brief`, `support-cx`. See `plugins/shoofi-operators/README.md`.

## Layout

```
.claude-plugin/marketplace.json          # this marketplace
plugins/
  shoofi-testing/
    skills/cover-changes/                # test-generation skill
    skills/local-app-e2e/                # local stack + simulator + Maestro
      references/app-matrix.md           #   per-app: identity, first-run gates, dev-client
      references/local-stack.md          #   server, Mongo seeding, order/accept scripts
      references/maestro-cookbook.md     #   install, selectors, worked example
  shoofi-domains/
    agents/<domain>.md                   # 6 domain-owner subagents
    context/_shared-guardrails.md        # the constitution they all inherit
    context/<domain>/CORE.md             #   always read
    context/<domain>/reference.md        #   read on demand
    context/assert/<domain>.assert.json  #   machine-checkable claims
    scripts/docs-check.js                # drift checker (zero deps)
  shoofi-operators/
    agents/competitive-intel.md          # Class B operator: mission, hard limits, hand-offs
    context/competitive-intel/CORE.md    #   always read: competitor endpoints + field lists,
                                         #   the matching design, the mapping collection
```

## Setup — per developer, once

The committed `.claude/settings.json` in each repo declares the marketplace and marks the
plugins **enabled**:

```json
{
  "extraKnownMarketplaces": {
    "shoofi": { "source": { "source": "github", "repo": "shoofi-dev/claude-plugins" } }
  },
  "enabledPlugins": {
    "shoofi-testing@shoofi": true,
    "shoofi-domains@shoofi": true,
    "shoofi-operators@shoofi": true
  }
}
```

> **`enabled` is not `installed`.** That file does **not** install anything on your machine —
> it only says "when this plugin is present, turn it on". Each developer installs once:

```bash
claude plugin marketplace update shoofi       # refresh the marketplace cache first
claude plugin install shoofi-domains@shoofi   --scope project
claude plugin install shoofi-testing@shoofi   --scope project
claude plugin install shoofi-operators@shoofi --scope project
claude plugin list                            # all three should appear, enabled
```

**Restart Claude Code afterwards** — agents and skills are picked up at session start.

### Keeping up to date

Marketplace plugins are **copied into a local cache** (`~/.claude/plugins/cache`), not read
live from GitHub. So after we push changes here, local sessions need:

```bash
claude plugin marketplace update shoofi
claude plugin update shoofi-domains@shoofi
```

Cloud routines re-clone each run, so they pick up changes on their own.

### Verifying the agents are live

```bash
claude plugin list
```
then, in a fresh session, ask **"which subagents can you delegate to?"** — you should see six
`shoofi-domains:…` entries. `/agents` is only a help stub in current versions and lists nothing.

If they still don't appear, the plugin is installed but not loaded — restart the session.

## Usage

After finishing a feature or bug fix, in any repo:

```
/shoofi-testing:cover-changes
```

or just tell the agent "cover my change with tests." It reads the diff, sets up
test infra if this is the repo's first run, writes the test slice for the changed
flow, runs it green, and reports coverage + gaps.

To exercise a change in the **real app** instead — local server, simulator, login,
screenshots:

```
/shoofi-testing:local-app-e2e
```

or just ask to "test this end to end on a simulator." It handles the boilerplate
(stack, `api.js` → localhost, identity, build/install, Maestro, login) so the
session only has to work out the fixture data its own feature needs — delegate
*that* to the `shoofi-domains` agents. Verified end to end on all three RN apps.

## Notes

- **Versioning**: `plugin.json` intentionally omits `version`, so every commit to
  this repo is picked up as the latest — cloud routines auto-update. Pin a
  `version` if you want manual, controlled rollouts.
- **Private marketplace + cloud**: a routine cloning a **private** marketplace repo
  needs credentials. Prefer a public repo, or ensure the routine has an SSH key in
  `ssh-agent` / a token with read access. A public repo is simplest.
- **Editing the skill**: change files under `plugins/shoofi-testing/skills/…` and
  push. Local sessions pick it up on refresh; cloud runs on next clone.
