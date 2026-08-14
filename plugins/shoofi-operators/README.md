# shoofi-operators — Class B: the department heads

`shoofi-domains` gives the platform **code owners**. This plugin gives it **operators**.

|  | Class A — `shoofi-domains` | Class B — `shoofi-operators` |
|---|---|---|
| Owns | a slice of the **codebase** | a **business function** |
| Feeds on | the repos | data + the outside world |
| Ships | pull requests | decisions, alerts, briefs, drafts — **never product code** |
| Brain | a code map (CORE + reference) | a mission + a playbook |
| Gate | lint + tests | **a human's approval** |

## The fleet

| Operator | Owns |
|---|---|
| `competitive-intel` | Haat + Tira Eat — the coverage gap, price gaps, menu coverage, promos, ratings, and competitor↔our-store matching |

Planned: `social-media`, `marketing-growth`, `merchant-success`, `retention-crm`,
`bizops-brief`, `support-cx`.

Invoke namespaced: **`shoofi-operators:competitive-intel`**.

## The house pattern — approval before trust

Nothing an operator produces is treated as true until a person says so. It is the same rule the
Slack bridge uses for skills: a skill is written, run, and shown to a human, and only their
"yes" puts it on the fast path; a rejected one is demoted instantly.

For `competitive-intel` that rule has teeth, and it is the single most important line in its
context doc:

> **Only a human-confirmed competitor↔store link may ever be used by a brief.**

A confidently wrong comparison — "we were closed and they were open" — is worse than no
comparison at all, because it gets repeated in a meeting and then acted on. So: propose
automatically, let a person confirm, and make the unconfirmed state visible in every output.

## Two constraints that shape everything here

- **The bridge's DB credential is read-only by design.** Anything that *writes* — the mapping
  collection, the propose/confirm/reject endpoints — belongs in `shoofi-server`. The bridge,
  and the operator, only ever read.
- **Operators do not ship product code.** When a task needs a route, a collection or a cron,
  the operator writes the spec and hands it to the owning `shoofi-domains` Class A agent.

## Layout

```
.claude-plugin/plugin.json
agents/competitive-intel.md              # mission, hard limits, hand-offs, definition of done
context/competitive-intel/CORE.md        # ALWAYS read: competitor endpoints + field lists,
                                         #   the two asymmetries, the matching design,
                                         #   the mapping collection, open questions
```

## Adding an operator

1. `agents/<name>.md` — front matter (`name`, a `description` that says when to use it **and
   when not to**, `tools:`), then a Step 0 that loads
   `${CLAUDE_PLUGIN_ROOT}/context/<name>/CORE.md` before anything else.
2. `context/<name>/CORE.md` — the mission in one line, the few things that matter most, the
   ground truth it should never have to rediscover, the hard limits, and the open questions a
   human still owns.
3. Register the plugin in `.claude-plugin/marketplace.json` and bump `metadata.version`.

Write it as a **department head, not an engineer**: its product is something a human reads,
and its gate is that human's "yes".
