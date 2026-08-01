# Shoofi Claude Code plugins

A Claude Code **plugin marketplace** that distributes shared skills and
domain-owner subagents across the 5 Shoofi repos — so they work in **local**
sessions *and* **cloud** runs (scheduled routines, the Slack agent), without
copy-pasting into each repo.

## Plugins

| Plugin | Provides | What it does |
|--------|----------|--------------|
| `shoofi-testing` | `/shoofi-testing:cover-changes`, `/shoofi-testing:local-app-e2e` | **cover-changes**: after finishing a feature/bug, generates the tests covering the changed flow across the repo(s) it touched; bootstraps each repo's test infra (best-fit runner) on first use. **local-app-e2e**: stands up the local stack (Mongo + server on :1111) and drives the customer/partner/driver app through its real UI on an iOS simulator with Maestro. |
| `shoofi-domains` | `menu-catalog`, `orders`, `payments`, `accountant`, `delivery`, `customers` subagents | Domain-owner "employees" — one per territory, **full-stack across all 5 repos** by default. Each loads the shared constitution + its human-reviewed context doc and ships work as PRs you review. Ships `docs-check`, a drift checker.|

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
```

## One-time setup

**1. Publish this marketplace** — create the GitHub repo and push:

```bash
cd /Users/Saridev/Documents/project/shoofi/claude-plugins
git init && git add -A && git commit -m "shoofi-testing plugin: cover-changes skill"
gh repo create shoofi-dev/claude-plugins --private --source=. --remote=origin --push
```
(If you prefer a public repo, cloud routines authenticate more simply — see Notes.)

**2. Enable it in each repo** — each of the 5 repos now carries a committed
`.claude/settings.json` that points here and enables the plugin:

```json
{
  "extraKnownMarketplaces": {
    "shoofi": { "source": { "source": "github", "repo": "shoofi-dev/claude-plugins" } }
  },
  "enabledPlugins": { "shoofi-testing@shoofi": true, "shoofi-domains@shoofi": true }
}
```

Because that file is committed, both local sessions **and** cloud routines load
the plugin automatically when they work on the repo — no manual install.

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
