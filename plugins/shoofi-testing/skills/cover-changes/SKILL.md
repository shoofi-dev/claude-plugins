---
name: cover-changes
description: >-
  Generate the tests that cover the current change (feature or bug fix) across
  whichever Shoofi repo(s) it touched. Run AFTER finishing development. It reads
  the diff, determines each touched repo, bootstraps that repo's test infra the
  first time (best-fit runner per repo), writes a per-feature test slice
  exercising the changed code paths, runs it green, and reports coverage + gaps.
  Use when the user says "cover this with tests", "add tests for my change",
  "write tests for what I just did", or invokes /cover-changes. Shoofi is 5
  independent repos (shoofi-app, shoofi-partner, shoofi-shoofir customer/partner/
  driver React-Native apps; shoofi-delivery-web CRA admin; shoofi-server Node
  API). Do NOT pre-scaffold repos the change didn't touch.
---

# cover-changes

Turn "I finished the feature/bug" into "the changed flow is covered by a test
that runs green in CI." Works per repo, best-fit runner, infra created on first
touch. Read `references/bootstrap-recipes.md` for exact per-repo setup steps.

Platform strategy this implements: `shoofi-server/docs/testing-strategy.md`.

## The rule

> A change → a **test slice in each repo it touched**, exercising the code paths
> the diff changed, run green. Nothing more. Never pre-scaffold a repo the change
> didn't touch.

## Step 1 — Establish the change

- Get the diff for the current repo. Try in order: `git diff origin/main...`
  (branch vs base), else `git diff main...`, else `git diff HEAD` (uncommitted).
  Redirect large diffs to a file and read it.
- List the **source files** that changed (ignore `*.test.*`, `*.spec.*`, docs,
  lockfiles, pure config). If only those changed → **there is nothing with a
  runtime surface to cover; say so and stop** (don't invent tests).
- Identify the repo from its path / `package.json` name and map it to a type:
  | package.json name / signal | Repo | Type |
  |---|---|---|
  | `express-cart`, has `routes/` + `app.js` | shoofi-server | **node-api** |
  | `notus-react`, `react-scripts` | shoofi-delivery-web | **cra-web** |
  | `buffalo` / has `expo` + `react-native` | shoofi-app/partner/shoofir | **rn-expo** |
- **Multi-repo features:** in a **local** multi-repo workspace the other Shoofi
  repos may be checked out as adjacent directories (siblings of this repo, or
  listed as additional working dirs). If they are, and the same feature branch
  changed them (`git -C <sibling> diff` shows source changes), tell the user and
  offer to cover each — handle one repo fully, then the next. In a **cloud run**
  only the current repo is cloned, so there are no siblings — just cover the
  current repo.

## Step 2 — Detect existing test infra

For the repo type, check whether infra already exists:
- **node-api**: `ava` in devDeps + a `test/integration/` dir + ava `files` globs it.
- **cra-web**: `@playwright/test` in devDeps + `playwright.config.*` + `tests/e2e/fixtures/`.
- **rn-expo**: `jest-expo` preset configured + `@testing-library/react-native` + a `test` script that runs jest.

Present → go to Step 4. Missing/partial → Step 3.

**Templates.** `references/bootstrap-recipes.md` contains the full inline recipe
for every repo type — it is the self-contained source of truth and works even
when only one repo is checked out (e.g. a cloud run). If the sibling repos happen
to be present locally, these already-built examples are the richest copy sources:
- node-api → `shoofi-server/test/integration/hyp-store-invoice-guard.js`
- cra-web → `shoofi-delivery-web/tests/e2e/` (fixtures, factories, README) + `playwright.config.ts`
Don't depend on them being present — fall back to the inline recipe.

## Step 3 — Bootstrap infra (first run in this repo)

Follow `references/bootstrap-recipes.md` for the repo type. In short:
- **Match the repo's Node version** before installing (native deps built under the
  wrong Node break at runtime). Read it from `package.json` `engines.node` or a
  `.nvmrc`. Check `node -v`; if it doesn't match, select the right one with
  whatever the environment provides (`nvm use` / `.nvmrc`, `asdf`, `fnm`, or a
  preinstalled binary). In a cloud run the correct Node is usually already on
  `PATH` — **do not hardcode an nvm path**; verify with `node -v` and only switch
  if it's wrong.
- Add config + npm scripts + one **smoke test** that proves the harness, then run
  it green.
- Wire a CI job into `.github/workflows/ci.yml` (don't remove existing gates).
- Add a `TESTING.md` (copy the shared "platform model" section from an existing
  repo's `TESTING.md`; fill in the repo-specific part).
- Add native/tool artifacts to `.gitignore` (Playwright: `test-results/`,
  `playwright-report/`, `playwright/.cache/`).

## Step 4 — Map the change to what to test

Pick the layer that carries the risk of the diff:
- **node-api**: a route handler changed → a **router integration test** (real
  router mounted in bare Express + `supertest`, fake `req.app.db`, stub outbound
  services). A pure lib/util changed → a direct ava unit test.
- **cra-web**: a multi-step flow / cross-component behavior → a **Playwright e2e**
  (real app, network mocked in-browser). A pure function / single component → a
  **jest** unit.
- **rn-expo**: a MobX store / service / `utils/` function changed → a **jest
  unit** (highest ROI, no simulator). A presentational component → testing-library
  render. Do NOT attempt device/e2e (Detox/Maestro) — out of scope.

Enumerate the **behaviors the diff introduced or changed** — each new branch,
boundary, and error path becomes a test case. The worked server example covers
this well: every guard condition true/false, both threshold boundaries, the
fail-open path.

## Step 5 — Write the tests

- Copy the repo's canonical example as a scaffold; adapt fixtures to the diff.
- Cover: happy path + each changed branch + boundaries + the failure/error path.
- **Never touch real infra** — fake the DB, stub outbound HTTP, mock the network.
  A test that needs Mongo/Redis/a live API to pass is the wrong test here.
- **Drive the real surface**: HTTP for routes, the rendered UI for flows. Don't
  `require()` a handler's inner helper and call it — that's not what a client hits.
- Web: select by `data-testid`, not Hebrew/RTL text. Add a `data-testid` to the
  component if one is missing (and note the convention in the e2e README).

## Step 6 — Run to green

- node-api: `npm test`  ·  cra-web: `npm run e2e` and/or `npm run test:unit`  ·
  rn-expo: `npm test` (with the right Node on PATH).
- Iterate until green. If a case can't be made deterministic without real infra,
  either mock that boundary or drop the case and **say why** — don't leave a flaky
  or infra-dependent test.

## Step 7 — Report

State plainly:
- Which repo(s) got which tests, and which changed branches/flows are now covered.
- **What you could not cover and why** (e.g. device-level RN e2e, a path needing
  live infra). Honesty here is the point — a false "fully covered" is worse than a
  named gap.
- That CI will run it (affected-on-PR, full on `main`).

## Guardrails

- One runner per repo — don't introduce a second (no jest in the ava server, etc.).
- New tests for the **changed** flow — don't just re-run existing ones and call it done.
- Deterministic only — no real DB/Redis/network/time-of-day dependence.
- Don't pre-scaffold repos the change didn't touch.
