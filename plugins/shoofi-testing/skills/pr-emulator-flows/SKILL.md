---
name: pr-emulator-flows
description: >-
  Write the CI flows that put a pull request on the Emulator workflow: Maestro
  flows for the three React-Native apps (shoofi-app customer, shoofi-partner
  store owner, shoofi-shoofir driver) on an Android emulator, Playwright specs
  for the shoofi-delivery-web admin in a browser. Reads the PR's diff, decides
  which screens the change touches, and writes one flow per behaviour under the
  repo's PR flow folder (.maestro/ci/pr/ or tests/ci/pr/), in the file contract
  the workflow and the AI Tasks bridge read. Use when the AI Tasks board presses
  "Prepare tests", when a user asks to "prepare emulator tests for this PR",
  "write CI flows for the change", or "add a flow the emulator run can pick up".
  Do NOT use for a hand-run simulator session on a Mac — that is
  /shoofi-testing:local-app-e2e — nor for unit tests, /shoofi-testing:cover-changes.
---

# pr-emulator-flows

A pull request on one of the four client repos can be run on GitHub Actions
against a sandboxed shoofi-server with a copy of the dev database: the three
apps on an Android emulator, the admin web in Chromium. The run takes every
screenshot the flows ask for and hands them back to the AI Tasks board. This
skill writes those flows for **the change a specific PR makes** — not a fixed
catalogue. The only fixed flow is each repo's `smoke`; everything else is
written for the PR, lives in the PR, and is reviewed with it.

**What this gives you:** the file contract the workflow runs and the bridge
lists, what each repo's job seeds and logs in as, the ids and screens the apps
already expose, and the traps a CI emulator adds on top of a simulator.

**What it does NOT give you:** the domain knowledge behind the data. If the
flow depends on a product's shape, an order's status, or a driver's company,
ask the owning domain agent (`shoofi-domains:menu-catalog`, `:orders`,
`:delivery`, `:customers`) before assuming.

## Step 1 — what the PR changes on screen

```bash
git fetch origin main
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- '*.tsx' '*.ts' '*.js' | head -n 600
```

List the screens and interactions the diff touches: a component that renders
differently, a button that did not exist, a price that is computed another way,
a screen that is reached by a new path. For each, write one sentence of the
form *"after X, the screen shows Y"* — that sentence is the flow, and it is the
flow's first line.

Rules:

- **One flow per behaviour**, one to three flows per PR. A flow that tries to
  prove five things fails on the first and hides the other four.
- **No UI surface → no flow.** A PR that only touches the server, a config, a
  type, or a test has nothing an emulator can photograph. Say so in one line
  and write nothing; do not invent a flow to have one.
- **A regression is a flow that fails on `main` and passes on the PR.** For a
  bug fix, assert the fixed value, not just that the screen renders.
- The flows must **hold on the seeded data** the job restores (Step 3) —
  never on data only your machine has.

## Step 2 — the file contract

The workflow runs whatever files it is given; the bridge lists a PR's flows by
reading the PR folder. Both rely on this shape.

| Repo | Folder | File | Runner |
|---|---|---|---|
| `shoofi-app`, `shoofi-partner`, `shoofi-shoofir` | `.maestro/ci/pr/` | `<kebab-name>.yaml` | Maestro on an Android emulator |
| `shoofi-delivery-web` | `tests/ci/pr/` | `<kebab-name>.spec.ts` | Playwright, Chromium, against the production build |

- **Name** the file after the behaviour, kebab-case, 3 to 5 words:
  `cart-weight-back-to-base.yaml`, `orders-filter-by-status.spec.ts`. Never
  `smoke` — that name is the repo's baseline flow one level up.
- **First line is the label**: a comment (`# …` in YAML, `// …` in TypeScript)
  of one sentence saying what the flow proves. The board shows it next to the
  file name; a person picks flows by it.
- **Seed hooks** (optional, apps and web): a comment line
  `# seed: e2e/<script>.js` (or `// seed: …`) names a script in
  **shoofi-server's `e2e/`** that the workflow runs against the restored
  database, before the server starts, with `TARGET_STORE` set to the store the
  run was given. Only scripts that exist on the server's `main` run; anything
  else is a warning. What is there today:
  - `e2e/ensure-app-users.js` — a store owner (`1234567886`), a driver
    (`1234567887`) and a dashboard admin (`0500000099`, password
    `e2e-admin-1234`) exist whatever dump was restored. The partner, driver
    and admin-web jobs run it always.
  - `e2e/ensure-weight-product.js` — the store under test has a by-weight
    product (لحم, ₪30/kg, 100 g steps, id `68a1c0de0000000000000f01`).
  - `e2e/seed-device-world.js` — the whole built-in world; the jobs run it
    when no dump is configured.
  A flow that needs data none of these give is a flow that needs a new seed
  script in shoofi-server first — say so in your answer instead of hard-coding
  an id from your own database.
- **Env with defaults** at the top of a Maestro flow (`env:`), or
  `process.env.X || '…'` in a spec, for anything the run may want to vary:
  the store (`STORE`), the phone, a product id. The board's "flow env" box
  overrides them; the defaults must work on the seed.
- **Subflows are one level up.** A PR flow sits in `pr/`, so the shared
  subflows are `../connect-metro.yaml`, `../wait-for-app.yaml`,
  `../dismiss-dev-overlays.yaml`. Use them; do not copy their contents.
- **Screenshots are numbered**: `takeScreenshot: "01-home"`,
  `"02-product"`, … (`await shot(page, '01-login')` on the web). The gallery
  sorts by that number. Take one at every screen the flow reaches and one
  right after the assertion that matters, so a failure still returns pictures.
- **Only ids or text you can see in the code.** A `testID` in the app is the
  resource-id on Android; the text on screen is a translation key's value, so
  prefer ids for anything the flow taps or reads. When the element you need has
  no id, **add a `testID` in the PR** (`store-card-<appName>` style) rather
  than tapping by coordinates.
- Keep steps that depend on optional data `optional: true` (Maestro) or
  wrapped in a `try` (Playwright), so the run hands back the pictures it did
  reach. The assertion the PR exists for is **not** optional.

## Step 3 — what each job gives the flow

All four jobs: Mongo restored from the dev dump (or the built-in world),
shoofi-server sandboxed (`E2E_SANDBOX=1`: SMS, HYP and push are stubbed, the
fixed code `1234` logs any test phone in), the `store` input as the store under
test (default `nnn`), and `flow_env` lines exported to the flow.

| Repo | App id | Reaching the app | Logs in as | First screens |
|---|---|---|---|---|
| `shoofi-app` | `com.shoofi.shopping` | `../connect-metro.yaml` then `../wait-for-app.yaml` | nobody by default; a customer only when the flow needs one (test phone `1234567891`, code `1234`, login is behind the person tab) | language picker → city picker (`select_city_area`, city `.*كفر قاسم.*`) → home (`filters.open_now`) |
| `shoofi-partner` | `com.shoofi.partners` | `../connect-metro.yaml` then `../wait-for-app.yaml` | the store owner `1234567886` (`ادخل رقم هاتفك` → `تم` → `ادخل الكود`; submits on the 4th digit); a multi-store owner picks `STORE` with `store-switcher-chip` / `store-row-<appName>` | login → dashboard (`.*طلبيات.*`) |
| `shoofi-shoofir` | `com.shoofi.shoofir` | `launchApp` then `../wait-for-app.yaml` (no dev client) | the driver `1234567887` (same screens, tap `تم` after the code) | login → location disclosure (`إذن تتبع الموقع`, accept with `موافق - ابدأ العمل`) → driver home (`شغال`) |
| `shoofi-delivery-web` | — | `page.goto('/admin/…')` | the admin `0500000099` / `e2e-admin-1234` via `login(page)` from `../helpers` | `/admin/login` → `/admin/dashboard` |

Each repo's `smoke` flow (`.maestro/ci/smoke.yaml`, `tests/ci/smoke.spec.ts`)
is the worked example of the connect-and-login part for that repo; start a PR
flow by reading it, then add only what the PR needs after it. Ids the apps
already carry are listed in each repo's `.maestro/ci/README.md`
(`store-card-<appName>`, `product-card-<id>`, `add-to-cart`,
`cart-line-<id>-price`, `cart-weight-plus`/`-minus` in the customer app).

What the CI emulator adds on top of a simulator, and what the subflows handle:
Android's "isn't responding" dialog while the dev bundle evaluates
(`wait-for-app.yaml` taps Wait), the dev launcher coming back after the app's
own RTL restart (it reconnects), LogBox toasts over the footer
(`dismiss-dev-overlays.yaml`, run it before any tap near the bottom), and the
emulator's GPS parked in Kafr Qasim so the city area resolves. Anything native
— push notifications, payment sheets, the camera — cannot be driven here.

## Step 4 — check, commit, push, report

- YAML must parse (`npx --yes js-yaml .maestro/ci/pr/<name>.yaml > /dev/null`)
  and every `runFlow:` path must exist relative to the file. Then read the
  flow once more against the cookbook
  (`local-app-e2e/references/maestro-cookbook.md`: selectors, regex escaping
  in `visible:`, `extendedWaitUntil` timeouts).
- Playwright: `npx playwright test --config tests/ci/playwright.config.ts --list`
  must list the new spec.
- **Commit the flows on the PR's branch and push it**, with any `testID` the
  flow needed added in the same commit. Nothing merges; nothing runs from
  here — the bridge reads the folder after you finish and the board offers
  the flows for a run.
- End with the list: one line per flow, `file — label`, plus any data the
  flow needs that the seed does not have.
