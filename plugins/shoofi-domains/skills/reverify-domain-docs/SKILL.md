---
name: reverify-domain-docs
description: >-
  Re-derive one domain's context doc from the actual code and open a PR with any
  corrections. Use when asked to re-verify, refresh, or re-ground the agent context docs,
  when a doc is suspected stale, or when invoked on a schedule by the doc re-verification
  routine. Picks the domain with the oldest last-verified stamp unless one is named.
  This is the defence against semantic drift — behaviour changing while names stay the
  same — which docs-check cannot catch.
---

# Re-verify a domain context doc

`docs-check` proves the things a doc *names* still exist. It cannot prove the doc still
describes what the code *does*. A function keeps its name and changes its behaviour; every
assertion passes; the doc is now confidently wrong, and the next agent acts on it.

This skill closes that gap by re-deriving the truth from the code and proposing corrections
as a PR a human approves. **One domain per run** — depth beats breadth here.

## Step 1 — Pick the domain

If the user named one, use it. Otherwise read the `last-verified:` header of each
`plugins/shoofi-domains/context/<domain>/CORE.md` in `shoofi-dev/claude-plugins` and pick
the **oldest**. Ties: prefer the higher-risk domain (`accountant` > `payments` > `orders` >
`customers` > `delivery` > `menu-catalog`).

State which domain you picked and why.

## Step 2 — Re-derive from the code, not from the doc

**Read the code first, before re-reading the doc.** Otherwise you'll confirm what the doc
says instead of checking it — the single most important rule in this skill.

Use `context/ownership.json` to find the files this domain owns, across every repo listed
there. Clone or use existing checkouts of the repos you need. Then establish, from the code:

- the **endpoints** that exist, and what each does
- the **data shapes** written and read (fields, collections, enums and their values)
- the **flows**: what calls what, in what order, with what side effects
- the **invariants** the code actually enforces (guards, idempotency keys, atomic updates)
- anything that looks like it **contradicts** the doc

For a large domain, spawn parallel read-only explorer agents per area and merge findings.

## Step 3 — Diff against the doc

Now read `CORE.md` and `reference.md`. Classify every difference:

| Class | Meaning | Action |
|---|---|---|
| **STALE** | doc says something the code no longer does | fix the doc |
| **MISSING** | code has meaningful surface the doc never mentions | add it |
| **WRONG** | doc actively contradicts the code | fix, and call it out loudly |
| **OBSOLETE VERDICT** | a `Known status` entry whose premise has passed (e.g. a migration that completed) | **flag for a human — do not edit** |
| **CODE BUG** | the doc describes correct intent; the code looks broken | **do not fix the code here** — report it |

## Step 4 — Update the doc

- Fix STALE / MISSING / WRONG in `CORE.md` / `reference.md`.
- Keep the CORE/reference split: invariants, verdicts and recipes belong in CORE; detail in reference.
- Use **symbols, not line numbers**.
- Add or tighten assertions in `context/assert/<domain>.assert.json` for anything that
  surprised you — every surprise should become a check so it can't recur silently.
- Bump `last-verified:` to the commit you verified against, with today's date.

**Never** delete or overrule a `Known status` entry. You may append
`verified still true on <date>`. If one looks obsolete, say so in the PR and leave it.

## Step 5 — Verify and open the PR

Run the checker before proposing anything:

```bash
node plugins/shoofi-domains/scripts/docs-check.js --repo shoofi-server=<path> [--repo …]
```

Open **one PR to `claude-plugins`** titled `Re-verify <domain> context doc`, containing:

1. **Verdict** — one line: *"accurate, only the stamp moved"* or *"3 stale claims, 1 wrong"*.
2. **What changed and why**, grouped by the classes above, each with the code evidence
   (file + symbol) that justified it.
3. **⚠️ Needs a human decision** — obsolete verdicts, suspected code bugs, anything
   ambiguous. This section is the point of the exercise; never omit it when it applies.
4. **Assertions added.**
5. What you checked and found **already correct** — that's the reassurance the doc is trustworthy.

If nothing changed, still open the PR bumping `last-verified` and say so plainly. A
confirmed-accurate doc is a real result, and the stamp is what tells the next agent how
much to trust it.

## Rules

- **Never change application code.** This skill only touches docs and manifests.
- **Never invent** a claim you didn't verify.
- **One domain per run.** A shallow pass over six is worse than a real pass over one.
- Report honestly when you couldn't verify something (infra unavailable, unclear flow)
  rather than asserting it.
