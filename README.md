# Shoofi Claude Code plugins

A Claude Code **plugin marketplace** that distributes shared skills and
domain-owner subagents across the 5 Shoofi repos — so they work in **local**
sessions *and* **cloud** runs (scheduled routines, the Slack agent), without
copy-pasting into each repo.

## Plugins

| Plugin | Provides | What it does |
|--------|----------|--------------|
| `shoofi-testing` | `/shoofi-testing:cover-changes` | After finishing a feature/bug, generates the tests covering the changed flow across the repo(s) it touched; bootstraps each repo's test infra (best-fit runner) on first use. |
| `shoofi-domains` | `menu-catalog` subagent | Domain-owner "employees" — one per territory. Delegate a task to the domain agent that owns the area; it loads a human-reviewed context doc and works inside its guardrails. Menu/Catalog first; payments, delivery, orders to follow. |

### `shoofi-domains` — the domain-owner model

Each territory of the platform gets a **subagent** that owns it, paired with a
**context document** (its human-reviewed ground truth). The main agent delegates
a feature/bug to whichever domain owns the area; that agent reads its context
doc, respects the money/identity guardrails, and stays inside its domain.

| Domain agent | Owns | Context doc |
|--------------|------|-------------|
| `menu-catalog` | products, categories, menu assembly, options/extras, availability & stock, catalog i18n (shoofi-server) | `context/menu-catalog.md` |

Adding a domain: drop `agents/<domain>.md` (routing description + guardrails) and
`context/<domain>.md` (the reviewed ground truth) into `plugins/shoofi-domains/`.

## Layout

```
.claude-plugin/marketplace.json          # this marketplace
plugins/
  shoofi-testing/
    .claude-plugin/plugin.json           # plugin manifest
    skills/cover-changes/
      SKILL.md                           # the skill
      references/bootstrap-recipes.md    # per-repo test-infra recipes
  shoofi-domains/
    .claude-plugin/plugin.json           # plugin manifest
    agents/menu-catalog.md               # the domain-owner subagent
    context/menu-catalog.md              # its human-reviewed context doc
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

## Notes

- **Versioning**: `plugin.json` intentionally omits `version`, so every commit to
  this repo is picked up as the latest — cloud routines auto-update. Pin a
  `version` if you want manual, controlled rollouts.
- **Private marketplace + cloud**: a routine cloning a **private** marketplace repo
  needs credentials. Prefer a public repo, or ensure the routine has an SSH key in
  `ssh-agent` / a token with read access. A public repo is simplest.
- **Editing the skill**: change files under `plugins/shoofi-testing/skills/…` and
  push. Local sessions pick it up on refresh; cloud runs on next clone.
