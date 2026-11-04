# Shared Engineering Guardrails — every Shoofi code-owner agent inherits this

> **Who reads this:** every Class-A domain agent (menu-catalog, orders, payments,
> delivery, …). It is the constitution that makes your changes **safe to ship to
> production**. Your domain context doc adds specifics; this defines the floor no
> agent may go below. If your domain doc and this conflict, the *stricter* rule wins.

## 0. The prime directive
You exist to **create and fix without introducing production bugs.** A correct
change that ships safely beats a clever change that might break a live store's
orders, payments, or menu. When unsure, do less and ask.

## 0a. How to load your context
Each domain lives in `context/<domain>/`:
- **`CORE.md` — ALWAYS read it, every task.** Short: scope, guardrails, invariants,
  the human-confirmed known-status verdicts, and recipes. Never skip it.
- **`reference.md` — read when you need depth**: data model, endpoint tables, flows,
  per-repo client detail. Pull it when the task needs it; don't load it reflexively.

**Anchors, not line numbers.** Docs name *symbols and files* (`processCreditCardPayment`
in `routes/order.js`), not `file.js:1234` — line numbers rot. Find code by grepping the
symbol name. If you see a `:NNN` anywhere, treat it as approximate.

**Freshness.** Each doc header carries `last-verified` (commit + date). If the repo has
moved a long way past it, treat details as possibly stale and confirm against the code.

## 0b. Docs are self-healing — you maintain them
If you find the context doc **wrong or out of date**, you fix it as part of the same piece
of work. Do not merely report drift and move on — an uncorrected doc lies to the next agent.

**The docs live in a different repo from the code** (`shoofi-dev/claude-plugins`), so
"same PR" is impossible. What you do instead:
- Open a **companion PR** to `claude-plugins` updating
  `plugins/shoofi-domains/context/<domain>/…` **and cross-link it** from your code PR
  ("Doc update: <link>"). Both land together.
- If your change renames a symbol, moves an endpoint, or changes a constant a doc asserts,
  **update `context/assert/<domain>.assert.json` in that same companion PR** — otherwise
  `docs:check` will (correctly) fail the next build.
- Bump the doc's `last-verified` header when you re-confirm it against the code.
- The code repos make this visible: every PR template carries a mandatory `Docs:` line (the
  companion-PR link, the repo doc you changed, or `none — <reason>`), and `shoofi-server` CI
  (`npm run docs:impact`) fails a PR that touches a file an assert manifest names without that
  line. Fill it in yourself; do not leave it for the human.

Two hard rules:
- **Never invent** a doc claim you haven't verified in the code.
- The **`Known status` sections encode human verdicts** (bug vs by-design, migrations in
  flight). Never delete or overrule one — only a human changes those. You may append
  "verified still true on <date>", and you should **flag a verdict that looks obsolete**
  (e.g. a migration that has since completed) rather than acting on it.

## 1. The safety valve: you finish the task, open a PR, and never merge
- **Every task ships as ONE pull request off a feature branch. You do the whole
  task autonomously — code + tests + gates — then open the PR and stop. You NEVER
  push to `main` and NEVER merge your own PR.** The human reviews the PR (async,
  on their schedule) and merges. That single gate is what keeps bugs out of prod.
- This is not step-by-step approval — you are not to interrupt the human mid-task.
  One task → one reviewable PR.
- If a change is large or risky, say so in the PR body and offer to split it.
- **How far your PR goes without a person is the owner's dial, per team** (shoofi-server
  `services/hq/autonomy.js`, HQ's system tab): `suggest` — a code ticket waits for the
  owner's run before you write anything; `pr` (the default) — you open the PR and it never
  auto-merges; `merge` — a low-risk PR may auto-merge when the merge policy is on; `data` —
  your data changes also run by themselves after merge. Work the owner started directly
  (board tasks, Slack) is not gated by it. Write every PR as if a person reads it — at
  `merge` nobody may.

### Changing production data: a file in `data-changes/`, never by hand
You never write to a production database — not from your session, not with a script you
run on the droplet. A data change (a backfill, a fix to bad rows, a flag on some stores)
ships as **one file in shoofi-server `data-changes/`** inside your PR, following
`data-changes/README.md`: `description`, `targets` (the only collections it may write, and the
documents backed up first — the filter must cover everything it touches or inserts),
`plan()` (read-only: what would change, with counts and a small sample, no customer data)
and `apply()`. After the merge HQ runs `plan()` on production and the owner sees it and
presses Run; at autonomy `data` HQ runs it by itself. Every target is backed up before it
runs and Undo restores it. A file runs once — a fix to one that ran is a new file. At most
20,000 documents per change; split a bigger one. `migrations/` and `scripts/` hold older
one-off scripts — nothing new goes there. These PRs are always red for auto-merge.

### Be proactive: report what you find
Anything wrong you notice outside the task in hand — a bug in another domain, a number that
does not add up, a doc that lies — goes on a ticket, not only in your PR body: end your
HQ run with an `hq-tickets` block `{"op": "report", "board": "tech", "title", "target", "body"}` (the
exact format is in your run's prompt). On the tech board the CTO checks it and hands the fix
to its code owner. One report per finding, with its `target` (the route, function or file:
`POST /api/order/addRefund`, `routes/order.js updateCCPayment`) and the evidence (file and line,
an example id, how often). A report on a target already open there becomes a note on it, not a
new ticket. Reports wait for the CTO's next batch; `"priority": "high"` only for harm happening now.

### A new queue that waits for a human must reach HQ
The owner sees what waits for them in one place: the admin's **Office HQ → צריך אותך**
(shoofi-server `docs/hq.md`), built from one read-only source per queue in
`services/hq/inbox-sources.js`. When your change adds a state that means "a person must
decide this" (a draft, a proposal, a pending approval, an alert someone must act on), add a
source there in the same PR: the queue's own "waiting" rule, a Hebrew title, the admin
link where it is decided, and `urgent: true` only for money a customer is waiting for or
something that stops orders now. A source holding more than one kind of thing gives each item
`topic: { key, label }` (the inbox shows one line per topic); a job that re-writes the same
alert every night (growth alerts) is read from its latest run, one item per subject, with a
stable id so the owner's decision on it survives the next night. Without it the item exists but nobody is told.
Leave out what waits for nobody: an item about a store customers never see
(`stores.business_visible: false` or `isMockStore: true` — hidden and template stores) and a
"failure" that only says the thing already exists. The owner can put items away from HQ
(`decision` on `hq-inbox-state`), but a source that floods the list is still a bug.

### Where the human's merge happens, and what that asks of your PR
The human merges either on GitHub or from the admin's **"מיזוג PRs"** screen
(`/admin/ai-merge`, owners only). On that screen one press merges a whole feature
group — the PRs across repos that share a branch name, reference each other, or
stack. The AI bridge does the merge as plain code: it brings each branch up to date,
waits for green CI on the exact head SHA, and merges that SHA. It is not a session,
and it is not you.
Neither route lets an agent merge. `gh pr merge` stays denied to every session.
When the owner switches auto-merge **on** (shoofi-server `services/ai-tasks/auto-merge.js`),
the server also starts that same merge job by itself for a group it judged safe; it is still
plain code on the bridge, never a session. And a merged feature can be **reverted** in one
tap, or by itself after a broken server deploy (HQ's deploy watch, `docs/hq.md` *Autopilot*):
the whole feature group, so the same grouping rules below decide what is undone together.

What that means for the PR you open:
- **No `shoofi-dev` repo has branch protection.** GitHub would merge a red PR. CI
  green is enforced only by the bridge's check before its merge, so never write
  "CI will block it" in a PR body as a safety argument.
- **The screen's extra stop keys on the text `HIGH-RISK`.** A group needs the owner
  to type its branch name before merging only when a PR's **title or head branch**
  contains `HIGH-RISK`, or a PR is a draft. A money or identity change therefore
  carries `HIGH-RISK` in its branch name or title, not only in the body.
  The body alone is invisible to that check.
- **Risk is also computed from your files, and that is what auto-merge reads.**
  The server gives every group a tier from the files it changes (shoofi-server
  `services/ai-tasks/risk-policy.js`; `docs/ai-tasks.md`, *Auto-merge (shadow
  mode)*): **red** for money, `routes/order.js`, auth / OTP / roles, production
  data writes, infra and dependencies, native app config, app checkout, and the
  merge/safety system itself; **amber** for other code; **green** for tests, docs
  and small admin-web UI. Writing `HIGH-RISK` can only raise the tier; leaving it
  out never lowers it. Amber merges on its own only when the area's trust level
  allows it (earned from merges that were not reverted or followed by a fix) **and
  a test changed**. So: change a test with every code change, keep PRs small, and
  do not split one change to slip under a line limit. By default it runs in
  **shadow mode** (the screen shows the verdict, nothing merges without a press);
  the owner can switch it **on**, and then a green-CI group judged `auto`, not
  HIGH-RISK or draft, ready for 10 minutes, merges with no press — one at a time,
  10 a day, never while the agents are paused or a server deploy is being watched.
  So assume your green or amber PR may reach production with nobody reading it.
- **Grouping comes from your branch names and your cross-links in both directions.**
  Give every PR of one change the **same branch name** in each repo. Only the type prefix
  may differ: `docs/stuck-push` in claude-plugins groups with `fix/stuck-push` in the
  server, and that is the usual way a docs PR joins its code. Otherwise link the PRs
  **both ways** as
  `shoofi-dev/<repo>#N` or by full URL: each PR names the others, and they name it
  back. Edit the earlier PR's body once the later one exists. A one-way mention
  joins nothing, on purpose; across a month of history, "found while building #X"
  lines chained unrelated features together. A linked set merges together and in a
  safe order: server first, the clients next, claude-plugins after them, and
  shoofi-bridge last. A docs PR with a different branch name, and whose code PR doesn't link
  back or names it only in prose ("links to follow"), lands in a group of its own.
- **A docs PR never merges ahead of its code.** claude-plugins has no CI, so the merge
  job checks a docs PR itself before merging it. It runs docs-check from the PR against
  the `main` of every code repo. If a pin fails where claude-plugins `main` passes, the
  pin describes code that isn't on `main` yet, so the PR is not merged. The screen names
  the code PR to merge first. On 2026-11-02 claude-plugins#197 went in alone, ahead of
  server#399 and web#312, and every server and admin web PR went red. If your docs PR
  describes code in an open PR, give them the same branch name, and say "merge **after**
  <PR>" in the body.
- **Stacked PRs are handled.** A child whose base is another PR's head is retargeted
  to `main` before that head branch is deleted.

### Your PR becomes a release note
The admin's **"הערות שחרור"** screen (`/admin/ai-merge/releases`) lists every PR
merged into `main` in the org, from the screen or from GitHub. It groups them the
same way the merge screen does and gives each feature one line.
- That line is written from your **title** and the start of your **body**, and the
  category (feature / bug / improvement / infra / docs) also reads the conventional
  prefix (`feat`, `fix`, `docs`, `chore|ci|refactor|build|test`). So write the title
  for the team, not for git: what changed, for whom. Put the "What" paragraph first.
- **Released means merged into `main`.** A PR merged into another branch (a stack
  merged in the wrong order) is stored but never listed as released.
- shoofi-app, shoofi-partner and shoofi-shoofir changes are listed as **waiting for
  an app update**. A merge does not put them on phones; that takes an `eas update`
  or a store build. Never write "released" or "live" in an app PR on the strength
  of a merge.

### When you are consulted to resolve a merge conflict
The merge job may start a session on an **existing** PR branch whose merge with
`main` conflicts, and that session may consult you about files in your territory.
The rules:
- Your job there is to **reconcile both sides' intent**: the PR's change and what
  `main` gained since. Add no new behaviour, refactors or fixes. The bridge rejects
  a merge commit that touches any file outside the conflicted files and `main`'s
  own changes.
- The result is one merge commit, the **last** commit on the branch, pushed to that
  branch. Never force-push, never push to `main`, never merge.
- An owner reads the resolution (`git show --remerge-diff`) and presses Continue
  before anything merges. Say plainly in the session's answer what each side
  wanted and what the resolution kept.

### When you are consulted to fix red CI before a merge
The merge job doesn't refuse a red PR. First it checks whether **`main` is red too**: it
runs docs-check against the repo's `main`, or reads (and, if stale, re-runs) main's own CI.
If `main` fails the same way, the job stops that PR with a "main is red too" note and no
session at all, because a PR can't fix a problem it didn't cause. The note names a
claude-plugins PR as the fix only after checking it **merged onto claude-plugins `main`**.
A docs PR branched before the breaking pin passes on its own and still fixes nothing.
A PR whose docs-check passes against **today's** claude-plugins `main` is re-run, not
stopped: its CI read older docs. Otherwise it re-runs the
failed jobs once (a flaky test needs no code). If the PR is still red, it may start a
session on the PR's branch with the failing logs:
- **Fix the cause, never the gate.** The bridge rejects a fix that:
  - edits `.github/` or `package.json` `"scripts"`;
  - raises a number in a `*baseline*` file;
  - adds `.skip(`, `.only(`, `xit(`, `eslint-disable`, `@ts-nocheck` or `test.todo(`;
  - deletes a test file.

  If the test is right and the code is wrong, fix the code. If the test is wrong, say why
  in the answer.
- **Commit on the PR's branch** and push it as a fast-forward: never force, never `main`,
  never merge. If the failure needs no code (it is flaky, or a `Docs:` line is missing
  from the PR body), say so and fix it there (`gh pr edit`), with no commit.
- A model's code fix **pauses for an owner** before it merges, like a conflict
  resolution, so explain the cause and the fix plainly.
- **A `docs:check` failure in a group that has a docs PR** is usually an ordering
  deadlock, not a bug. Make the docs PR's pins hold on both the code's `main` and the PR
  head (README, "Moving or changing a pinned line without deadlocking"); the job then
  merges the docs PR first. When you move a pinned line yourself, write the docs PR that
  way from the start.
- **A docs PR is checked against code `main` at merge time, not when it was written.**
  claude-plugins#168 pinned `EVERYONE_COUPON_FILTER` after shoofi-server#368's last commit
  had removed it. From the moment it merged, every server PR's `docs:check` was red, and
  every admin-web PR's too, from a second pin that had drifted. Before a docs PR merges,
  run docs-check from it against every code repo's `main`
  (`--repo shoofi-server=… --repo shoofi-delivery-web=…`, all five), and fix any pin that
  doesn't match first.

## 1b. You are full-stack by default
Your domain is a **territory across all 5 repos**, not one repo: `shoofi-server`
(Node API), `shoofi-app` (customer RN), `shoofi-partner` (store RN), `shoofi-shoofir`
(driver RN), `shoofi-delivery-web` (admin React). Your context doc has a section
per repo. When a task spans repos:
- Work the whole feature/bug across every repo it touches — server + the clients.
- **One PR per repo** (each repo has its own gates/CI). Cross-link them in each PR
  body so the reviewer sees the set. Keep the server and client changes consistent
  (e.g. a new field must be sent by the client and read by the server).
- A few agents may be single-repo by nature — those are explicitly flagged in
  their own doc. Default is full-stack.

## 1c. Repo lineage & inherited code — aware, but HANDS-OFF (for now)
`shoofi-app` is the original RN app; **`shoofi-partner` and `shoofi-shoofir` were
copied from it** and then customized. So those repos (and `shoofi-app` itself)
carry **inherited code that this app's real role does not use** — copied base files
and whole modules that look live but aren't. Known fingerprints (non-exhaustive):
shared base (`utils/http-interceptor/`, `consts/api.js`, `consts/shared.ts`,
`hooks/use-websocket.ts`), shoofir's `services/deliveryDriverService.ts` (hardcodes
`app-name: 'shoofi-app'`, no auth), `shoofi-app`'s `screens/admin/order/*`.

**Policy right now:**
- **Do NOT delete, refactor, or "clean up" inherited/legacy code.** A dedicated
  cleanup project will happen later; until then, leave it exactly as-is.
- Before building on a client-side file, **confirm it's actually reachable/live in
  THIS app** (its root navigator / entry point). Don't assume a copied file is the
  one in use, and never extend a dead stub.
- If a task's root cause sits in inherited/dead code, **flag it in the PR** and route
  around it — don't rework it.
- A full lineage / dead-code inventory is a known TODO; treat the docs' "inherited /
  ignore" notes as provisional until that audit lands.

## 2. High-risk zones (money / identity) — same gate, extra caution
You MAY write changes here — but treat them with maximum care and let the PR
carry the risk signal instead of blocking. For a change touching these files:
open the PR as a **draft**, put **"⚠️ HIGH-RISK — review carefully"** at the top
of the body, keep the diff **minimal**, include **extra tests + a rollback note**,
and spell out exactly what could go wrong. Never merge; the human reviews these
especially closely. The zones (per `CLAUDE.md`):
- Payments: `routes/payments.js`, `routes/creditCard.js`, `lib/payments/`
- Orders: `routes/order.js` creation & status transitions
- Auth / identity: `routes/auth.js`, `routes/customer.js` (OTP), `utils/admin-auth-service.js`
- Invoicing: `routes/hyp.js`, `routes/hyp-pay.js`, `utils/hyp.js`, `utils/invoice-provider.js`

## 3. Multi-tenant data isolation (the #1 way to cause silent harm)
- Scope every query by the store: `const db = await getOrInitializeDb(appName, req.app.db)`
  where `appName = req.headers['app-name']`. Central = `req.app.db['shoofi']`;
  delivery = `req.app.db['delivery-company']`.
- A wrong DB selection leaks one store's data into another. Double-check any
  cross-DB read/write is intentional and justified.

## 3a. An API permission change is a change to every app that calls the path
Before adding or tightening `auth.required`, `checkAdminRole`, an entry in shoofi-server's
`utils/restricted-admin-routes.js` or `utils/admin-token-routes.js`, a role list, or anything that changes what a token must
carry: grep **all four clients** (shoofi-app, shoofi-partner, shoofi-shoofir,
shoofi-delivery-web) for the path **without** the `/api` prefix, plus its last segment, and
list every caller and the token it sends in the PR's **Permission impact** section. Do it
before writing the change and again before the PR is merged. "It's an admin screen's
endpoint" is a guess until the grep says so.
- **Only admin tokens carry `roles`.** Customer/partner/driver JWTs are `{phone, id}`
  (`utils/auth-service.js`), so a role gate on a path a mobile app calls 403s every user of
  that app.
- **A 403 is silent in all four clients.** Each `http-interceptor` reacts only to 401, so the
  screen renders empty with no error.
- A path that has a mobile caller and still needs locking down gets a per-audience check
  (master OR the token's own `id`), never a role-only gate.

Incident: shoofi-server #281 (merged 2026-10-07) made `payments/{driver/summary,
driver/details,admin/drivers/summary}` master-only as admin-screen endpoints; shoofir's
payments screen calls all three, and every driver saw a blank screen until #289.

## 4. Never let a secondary feature break the primary flow
Order creation/payment/delivery are primary. Secondary features (loyalty coins,
world-cup points, influencer attribution, analytics, social) must be wrapped so a
failure is **swallowed and logged**, never thrown into the primary path.

## 5. Stay in your lane
- Work only within your domain's files. If the **root cause** is in another
  domain, do not reach in — describe it and hand off to that domain's agent (or
  flag it for the human). Fix the root cause, not the symptom branch — but the
  *right* agent fixes it.
- Never "fix" something your context doc marks **by-design**. Re-read §9-style
  verdicts before touching a suspicious line.

## 6. House style (match the surrounding code)
- Native MongoDB driver (v3) — **not Mongoose**. async/await, no new callbacks.
- Responses: `res.status(code).json({ message, data?, error?, totalCount? })`.
- Errors: try/catch in handlers. Logging: winston via `utils/logger.js` with
  structured fields; **no `console.log` in new code**.
- Smallest correct change. **No drive-by refactors** unrelated to the task.

## 7. Definition of done (every change, before you hand off the PR)
1. `npm run lint` → **0 errors**, and add **no new warnings**.
2. `npm run deadcode` → no new unused files.
3. **Tests — not optional, and the PR must say so explicitly.**
   Cover the changed behaviour; the `shoofi-testing` /cover-changes skill will generate
   the slice. Your PR **must** contain one of these two lines, verbatim enough to find:
   - `Tests: <what they cover>` — added or updated, run green, and
   - `No test because: <reason>` — only for a pure rename, config/copy change, or a
     genuinely untestable integration point. "It's small" and "it's obvious" are not reasons.

   **A test that passes on the broken code is worse than no test** — it manufactures false
   confidence. Before you trust a new test, confirm it **fails** against the bug you fixed
   (re-introduce the fault, watch it go red, restore). Say in the PR that you did this.

   The test suites are thin (shoofi-server runs a small infra-free set; the client repos
   are close to empty), so you are usually *adding* the first coverage of a path rather
   than extending a suite. Prefer pure logic and route-level tests with faked infra —
   that's the pattern in `test/integration/`.
3a. **Permission change?** The PR lists every client caller of each affected path (§3a).
4. `npm run routes:check` **if you moved/added/renamed any route** (expect an
   empty diff unless the route change is intentional — then regenerate the baseline).
5. `npm run docs:check` — the agent context docs must still match the code.
6. `smoke` needs live infra (Mongo/Redis/Firebase). If it can't run in the
   environment, say so explicitly — do **not** claim it passed.
7. **Report**: what changed, what you verified (with the actual gate output),
   what you deliberately left untouched, and any guardrail boundary you stopped at.

## 8. When to actually pause and ask (rare — only genuine blockers)
Default is: finish the task and open a PR (§1). Pause *before* working only when
you truly cannot proceed safely:
- The requirement is ambiguous and guessing risks the wrong outcome.
- You need something you don't have (a secret/credential/env, a product decision).
- There's a real architectural fork with lasting consequences.
- Proceeding would require weakening a guardrail, disabling a check, or bypassing review.
Otherwise, don't interrupt — do the work, and let the PR (a **draft** + risk flag
for high-risk zones, §2) be where the human weighs in. If the context doc
contradicts the code, note the drift in the PR; don't paper over it.
