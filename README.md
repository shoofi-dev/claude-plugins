# Shoofi Claude Code plugins

A Claude Code **plugin marketplace** that distributes shared skills across the 5
Shoofi repos — so they work in **local** sessions *and* **cloud** runs (scheduled
routines, the Slack agent), without copy-pasting skills into each repo.

## Plugins

| Plugin | Provides | What it does |
|--------|----------|--------------|
| `shoofi-testing` | `/shoofi-testing:cover-changes` | After finishing a feature/bug, generates the tests covering the changed flow across the repo(s) it touched; bootstraps each repo's test infra (best-fit runner) on first use. |

## Layout

```
.claude-plugin/marketplace.json          # this marketplace
plugins/
  shoofi-testing/
    .claude-plugin/plugin.json           # plugin manifest
    skills/cover-changes/
      SKILL.md                           # the skill
      references/bootstrap-recipes.md    # per-repo test-infra recipes
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
  "enabledPlugins": { "shoofi-testing@shoofi": true }
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
