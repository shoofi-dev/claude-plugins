# Maestro cookbook

Maestro is the UI-automation tool for the Shoofi RN apps. It drives the **running
Expo dev build** and needs no native changes — unlike Detox, which would need
`expo prebuild`. Verified with Maestro **2.8.0** on iOS 26.5.

## Install

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$HOME/.maestro/bin:$PATH"
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
maestro --version
```

Two traps, both costly:

1. **macOS ships a `/usr/bin/java` stub.** It satisfies the installer's
   `command -v java` check, so the install *appears* to work, then Maestro cannot
   run. Use the keg-only Homebrew JDK path above (`brew install openjdk@17` if
   missing — it is keg-only, so it is never on `PATH` by default).
2. **Never run the installer twice concurrently.** Both invocations write the same
   `~/.maestro/tmp/maestro.zip` and corrupt it. If you already did:
   `pkill -f maestro-install; rm -rf ~/.maestro/tmp` and start one clean run.
   The download is ~300 MB, so give it a few minutes.

`brew install maestro` is **the wrong package** — a different product.

## Screenshots are sandboxed

In Maestro 2.x `takeScreenshot` rejects any path outside the run's output folder.
Use bare names, pass `--debug-output`, and collect afterwards:

```bash
maestro --device <udid> test --debug-output "$RUN_OUT" flow.yaml
find "$RUN_OUT" -path "*/takeScreenshot/*.png" -exec cp {} .maestro/screenshots/ \;
# on failure, Maestro also drops the failing frame under */screenshots/*.png
find "$RUN_OUT" -path "*/screenshots/*.png"    -exec cp {} .maestro/screenshots/ \;
```

## Selectors: read this before writing any assertion

**Maestro full-matches an element's text as a regex.** Combined with iOS collapsing
a `TouchableOpacity` subtree into a *single* accessibility node, this is the single
biggest time sink in this codebase.

A banner built as `<Touchable><Icon/><Text>1</Text><Text>store</Text><Text>hint</Text><Text>go</Text></Touchable>`
surfaces as **one** node reading `"1 store hint go"`. There is no node for the store
name and none for the count. So:

```yaml
- assertVisible: "متجر باء"        # never matches
- assertVisible: ".*متجر باء.*"     # matches
```

Wrap **every** selector in `.*…*`. Turn it to your advantage — one regex can assert
several facts about the same element at once:

```yaml
# count pill AND store name AND hint are all on the same banner
- assertVisible: ".*1 متجر باء طلبات جديدة في هذا المتجر.*"
```

Two more consequences:

- The same element's text **changes when a badge appears** (`"store"` becomes
  `"1 store"`), so an exact match that passed before the badge fails after it.
- For `tapOn`, Maestro picks the **deepest** matching node, so a `.*…*` regex that
  also matches the root does still tap the right thing. Verified.

Other selector notes:

- The apps are **forced RTL Arabic**. Match seeded Arabic names, or raw i18n keys
  (`select-store`, `code-sent-to`) where no translation row exists — those are
  ASCII and pleasantly stable.
- Text inputs have **no accessibility label**. Use a relative selector against
  their visible label: `tapOn: { below: "ادخل رقم هاتفك" }`. Verified.
- Icon-only controls (the sheet's `×`, the tab bar, the dev-menu close) have no
  labels either — point-tap them: `tapOn: { point: "97%,42%" }`.

## Getting past the expo-dev-client (apps that have it)

`clearState: true` wipes the saved Metro URL, so a Debug build lands on the
launcher, then on a one-time developer-menu explainer, and dismissing *that*
reveals the dev menu itself. Three steps:

```yaml
- launchApp:
    clearState: true
    permissions:
      notifications: allow
- runFlow:
    when: { visible: "Development servers" }
    commands:
      - tapOn: "http://localhost:8081"
- extendedWaitUntil: { visible: "Continue", timeout: 60000, optional: true }
- runFlow:
    when: { visible: "Continue" }
    commands:
      - tapOn: "Continue"
      - tapOn: { point: "97%,42%" }   # close the dev menu; its × has no label
```

`shoofi-shoofir` has no `expo-dev-client`, so it skips all of this.

## Logging in (works for all three apps)

```yaml
- extendedWaitUntil: { visible: "ادخل رقم هاتفك", timeout: 60000 }
- tapOn: { below: "ادخل رقم هاتفك" }
- inputText: "${TEST_PHONE}"
- hideKeyboard
- tapOn: "تم"
- extendedWaitUntil: { visible: "ادخل الكود", timeout: 30000 }
- tapOn: { point: "50%,14%" }     # the 4 code cells have no labels
- inputText: "${TEST_CODE}"
# shoofi-app / shoofi-partner auto-submit on the 4th digit; shoofi-shoofir does
# not. Tapping only while the code screen is still up covers both.
- runFlow:
    when: { visible: "ادخل الكود" }
    commands:
      - tapOn: "تم"
```

Pass `TEST_CODE` in with `-e` from a shell driver that derives it from
`config/test-phones.js` at runtime. **Do not write the code into the YAML** — and
note Maestro echoes `inputText` arguments to stdout, so filter that line out of any
output you show a human.

## Crypto: mint tokens outside Maestro

Maestro's JS sandbox (GraalJS) has **no crypto**, so it cannot sign a JWT. Mint
tokens in the shell driver and pass them with `-e`; the flow's `runScript` then does
a plain `http.post`. Also: use the standard `JSON.stringify` / `JSON.parse` —
Maestro's own `json` helper is parse-only and `json.stringify` throws
`TypeError: (intermediate value).stringify is not a function`.

## Timing

Assume **polls, not push** (see the skill's "what cannot work" section). Budget
**~75 s** on any wait that depends on a server-side change reaching the UI: a
30 s poll that fires a second before your write costs a whole extra cycle, and the
render lags the successful response by a bit more. 35 s fails intermittently; 75 s
has been stable.

## Cosmetics

React Native's LogBox toast parks at the bottom of the screen in a Debug build and
covers the last row of bottom sheets. Dismiss it before screenshots:

```yaml
- runFlow:
    when: { visible: ".*Each child in a list.*" }   # or whatever warning is current
    commands:
      - tapOn: { point: "3%,96%" }
```

## Worked example

`shoofi-partner/.maestro/` is a complete, passing example — flow, shell driver that
mints two JWTs and derives the test code, `runScript` HTTP steps, and per-assertion
screenshots:

```
.maestro/
  cross-store-new-order.yaml     # the flow
  run-cross-store-test.sh        # driver: tokens, env, screenshot collection
  scripts/create-order.js        # runScript + http.post
  scripts/accept-order.js
  screenshots/                   # output
```

Run it with `DEVICE=<udid> ./.maestro/run-cross-store-test.sh`.

## Debugging a failing flow

1. `maestro --device <udid> hierarchy > /tmp/h.json`, then walk it and print every
   node's `bounds` + text. This is how you discover collapsed nodes and missing
   labels — far faster than guessing at selectors.
2. Look at Maestro's own failure screenshot in the debug output.
3. Check `/tmp/shoofi-server.log` to see whether the app actually called the
   endpoint and what it got back. "The UI didn't update" is usually "the poll
   hasn't fired yet" or "the token was invalidated", and the log distinguishes them.
