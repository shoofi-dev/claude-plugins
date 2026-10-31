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
| `marketing-manager` | **Leads marketing.** Every marketing ask enters here; it knows the fleet, the skills and the admin marketing hub, and routes the work — running a specialist's playbook itself, handing back to the session for agents only the session can call, and stopping at every human gate. |
| `competitive-intel` | Haat + Tira Eat — the coverage gap, price gaps, menu coverage, promos, ratings, and competitor↔our-store matching |
| `social-marketing` | Shoofi's own Facebook/Instagram content — Arabic only, one account. Drafts posts, stories and ad copy against live platform data. **Never publishes.** |

Planned: `merchant-success`, `retention-crm`, `bizops-brief`, `support-cx`.

Invoke namespaced: **`shoofi-operators:marketing-manager`**, **`shoofi-operators:competitive-intel`**,
**`shoofi-operators:social-marketing`**.

`competitive-intel` and `social-marketing` do not overlap: what *competitors* post is `competitive-intel`'s social phase; what
*we* post is `social-marketing`. Neither reaches into the other.

## Skills

| Skill | Makes |
|---|---|
| `/shoofi-operators:guided-reel` | A guided explainer reel: Shadi (the 3D courier mascot) explains a feature in Arabic and Hebrew, lip-synced, beside a phone showing real app screens with the key item zoomed out. Four human gates (script, voice, clip credits, final). Builder: `skills/guided-reel/scripts/reel.py` driven by a `reel.json`. |

## The marketing manager and delegation

A subagent cannot start another subagent, so `marketing-manager` "delegates" three ways:
it runs a specialist's playbook itself after loading that specialist's doc (social posts,
reels), it ends its turn with a `HAND-OFF →` block the session passes to an agent only the
session can call (a Class A owner, `competitive-intel`), or it stops at a gate for a person
(script approval, Artlist credits). It has **no `tools:` line on purpose**: it needs the Artlist
connector's tools, whose names depend on how the connector is installed.

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

For `social-marketing` the same rule is sharper still, because the output is **public**:

> **It drafts. A human approves. Something that is not the operator talks to Meta.**

It never holds the Meta token — not to preview, not to test. And its voice is not a matter of
taste: it was measured from 3,166 real customer messages, so "that doesn't sound like us" is
answered with evidence rather than argument.

## Two constraints that shape everything here

- **The bridge's DB credential is read-only by design.** Anything that *writes* — the mapping
  collection, the propose/confirm/reject endpoints — belongs in `shoofi-server`. The bridge,
  and the operator, only ever read.
- **Operators do not ship product code.** When a task needs a route, a collection or a cron,
  the operator writes the spec and hands it to the owning `shoofi-domains` Class A agent.

## Layout

```
.claude-plugin/plugin.json
agents/marketing-manager.md              # the lead: routing, delegation, hard limits
agents/competitive-intel.md              # mission, hard limits, hand-offs, definition of done
agents/social-marketing.md
context/marketing-manager/CORE.md        # ALWAYS read: owner decisions, the fleet, routing,
                                         #   the admin marketing hub + endpoints, results
context/competitive-intel/CORE.md        # ALWAYS read: competitor endpoints + field lists,
                                         #   the two asymmetries, the matching design,
                                         #   the mapping collection, open questions
context/social-marketing/CORE.md         # ALWAYS read: the measured voice spec and its
                                         #   evidence, the account model, the approval
                                         #   chain, the coupon rule, what exists today
skills/guided-reel/SKILL.md              # Shadi explainer reel: steps + gates
skills/guided-reel/scripts/reel.py       #   the builder (Chrome renders, ffmpeg composites)
skills/guided-reel/assets/shadi/         #   blue-screen poses: stand.png, point.png
skills/guided-reel/references/           #   shadi.md (look, voice, lip-sync), screens.md,
                                         #   reel-json.md (spec format, QA, flicker)
skills/guided-reel/examples/invite-friend/reel.json
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
