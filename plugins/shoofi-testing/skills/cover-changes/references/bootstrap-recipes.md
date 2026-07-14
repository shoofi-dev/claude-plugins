# Bootstrap recipes — first-run test infra per repo type

Use the matching section only when Step 2 found infra missing.

**Node version first.** Match the repo's required Node before installing (native
deps built under the wrong Node break at runtime). Get it from `package.json`
`engines.node` or `.nvmrc`; check `node -v`. If it's wrong, switch with whatever
the environment offers (`nvm use`/`.nvmrc`, `asdf`, `fnm`, or a preinstalled
binary). In cloud runs the right Node is usually already on `PATH` — verify, don't
assume a path. (Reference at time of writing: server targets Node 20; web + RN
apps target Node 22 — but always confirm against the repo rather than trusting
this note.)

---

## node-api (shoofi-server) — ava + supertest

Usually already set up. If a fresh Node repo needs it:

1. `npm install -D ava supertest` (server currently uses Node 20).
2. `package.json` → add ava config + scripts:
   ```json
   "ava": { "serial": true, "files": ["./test/integration/**/*.js"], "timeout": "10s", "verbose": true, "environmentVariables": { "NODE_ENV": "test" } },
   "scripts": { "test": "ava", "test:watch": "ava --watch" }
   ```
   Keep any legacy Mongo-dependent specs OUT of the `files` glob (park them).
3. Smoke test `test/integration/_smoke.js`:
   ```js
   const test = require('ava');
   test('harness runs', t => t.pass());
   ```
   Run `npm test` → green, then delete the smoke test once a real one exists.
4. CI: add to `.github/workflows/ci.yml` a step in the existing job:
   ```yaml
   - name: Tests (infra-free integration — real routers, faked db)
     run: npm test
   ```

**Router integration pattern** (copy
`shoofi-server/test/integration/hyp-store-invoice-guard.js`): mount the real
router in a bare Express app, set `app.db` to fakes, `app.use('/', require('../../routes/<x>'))`,
sign a JWT with the same secret as `utils/admin-auth-service` (`'secret'`) +
`app-type: shoofi-admin`, stub the module's outbound service calls, drive with
`supertest`, assert status+body across branches.

---

## cra-web (shoofi-delivery-web) — Playwright (e2e) + jest (units)

Copy the whole harness from `shoofi-delivery-web` — it's the canonical build:
`playwright.config.ts`, `tests/e2e/fixtures/{api-mock.ts,index.ts}`,
`tests/e2e/factories/`, `tests/e2e/README.md`.

1. `npm install -D @playwright/test@latest` then `npx playwright install chromium`
   (use Node 22). fsevents note: if a stale top-level `fsevents@1` breaks UI mode,
   add `"fsevents": "2.3.3"` to `optionalDependencies` and reinstall.
2. Scripts:
   ```json
   "e2e": "playwright test", "e2e:headed": "playwright test --headed",
   "e2e:ui": "playwright test --ui", "e2e:report": "playwright show-report",
   "test:unit": "CI=true react-scripts test --watchAll=false",
   "test:unit:changed": "CI=true react-scripts test --watchAll=false --changedSince=origin/main"
   ```
3. `.gitignore`: `test-results/ playwright-report/ blob-report/ playwright/.cache/`.
4. CI: add an `e2e` job that `npm ci`, `npx playwright install --with-deps chromium`,
   `npm run e2e`, and uploads `playwright-report/` on failure.

**Key harness facts** (see `tests/e2e/README.md`): auth is seeded into
`localStorage` (`adminUser` + `@storage_userToken`) so the app boots logged-in
with no backend; every `**/api/**` call is mocked in-browser by `ApiMock`; the
admin-shell endpoints are auto-mocked. Drive by `data-testid`. The e2e verifies
the **frontend contract** ("server returns X → UI does Y"); the server's own
logic is covered by the server slice.

**jest units** exist via `react-scripts test` — use for pure logic/components.

---

## rn-expo (shoofi-app / shoofi-partner / shoofi-shoofir) — jest + testing-library

No canonical example yet — this is the recipe. All three are **Expo 53 / RN 0.79**.
Node 22. shoofi-app has no jest; partner/shoofir have `jest@29` but no preset.

1. Install (Node 22):
   ```
   npm install -D jest-expo @testing-library/react-native @testing-library/jest-native
   ```
   (jest itself: partner/shoofir already have jest@29; for shoofi-app add `jest`.)
2. `package.json`:
   ```json
   "scripts": { "test": "jest", "test:changed": "jest --changedSince=origin/main" },
   "jest": {
     "preset": "jest-expo",
     "setupFilesAfterEnv": ["@testing-library/jest-native/extend-expect"],
     "transformIgnorePatterns": [
       "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|mobx|mobx-react))"
     ]
   }
   ```
   The `mobx` entry matters — stores are the main test target.
3. **First real target = business logic, not screens.** Highest ROI:
   - MobX stores in `stores/` — construct the store, call actions, assert state.
   - Services in `services/` and `utils/` — pure functions, easy to unit test.
   - `utils/http-interceptor` — mock axios, assert headers/token/refresh behavior.
   Component render (testing-library `render()`) is fine for a presentational
   component, but avoid full-screen renders that drag in navigation/MobX context
   unless the diff is specifically about that screen.
4. Smoke test to prove the preset, e.g. `__tests__/smoke.test.ts`:
   ```ts
   test('jest-expo harness runs', () => { expect(1 + 1).toBe(2); });
   ```
   Run with Node 22: `PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm test`.
   Green → replace with a real test for the changed store/service/util.
5. CI: the RN repos have `ci.yml`. Add a `unit` job: `npm ci` then
   `CI=true npm test` (Node 22). Keep existing gates.
6. Add a `TESTING.md` (shared platform-model section + this rn-expo section).

**Gotchas**: `transformIgnorePatterns` must list every RN/Expo/native ESM package
the test imports transitively, or jest throws "Unexpected token" on `import`. Add
packages to the negative-lookahead as needed. Mock native modules the code pulls
in (`expo-*`, `react-native-*`) with `jest.mock(...)` when they touch the unit.
