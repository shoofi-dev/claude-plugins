---
name: local-app-e2e
description: >-
  Stand up the full local Shoofi stack and drive one of the three React-Native
  apps (shoofi-app customer, shoofi-partner store owner, shoofi-shoofir driver)
  through its real UI on an iOS simulator with Maestro. Covers the parts that are
  the same for every test — local server + Mongo, pointing the app at localhost,
  creating a login identity, booting/building the simulator, installing Maestro,
  logging in, taking screenshots — so a session only has to work out the DATA its
  own feature needs. Use when the user asks to test a feature end to end, drive
  or run the app, log in on a simulator, write a Maestro/UI flow, take app
  screenshots, or reproduce something "in the real app". Do NOT use for unit or
  integration tests with no UI — that is /shoofi-testing:cover-changes.
---

# local-app-e2e

Everything below the feature. This skill exists so you never again spend an hour
rediscovering that macOS ships a fake `java`, or that the login screen's text
input has no accessibility label.

**What this gives you:** a running stack, an app on a simulator pointed at it, a
working login, and a Maestro flow that can assert and screenshot.

**What it does NOT give you:** the fixture data your feature needs. That part is
domain knowledge — delegate it (`shoofi-domains:menu-catalog` for products and
categories, `orders` for order shapes, `customers` for identity/roles, and so on)
before you write it. Assume nothing about document shapes.

## Order of work

Do these in order; each step's traps are the reason the next one works.

1. **Stack** — Mongo + `shoofi-server` on :1111. See `references/local-stack.md`.
2. **Seed** — central prerequisites, then your feature's data. Same reference.
3. **Point the app at localhost** — one-line edit, **never commit it**.
4. **Identity** — a login the app will accept. See `references/app-matrix.md`.
5. **Simulator** — build/install/run the app.
6. **Maestro** — install, write the flow, run it. See `references/maestro-cookbook.md`.
7. **Revert** the `api.js` edits and report what you left running.

## Step 3 — point the app at localhost

Every app hardcodes the production URL at the top of `consts/api.js`, with dev
lines commented out below. Replace the two exports:

```js
export const BASE_URL = "http://localhost:1111/api";
export const WS_URL = "ws://localhost:1111";
```

`localhost` works because the simulator shares the host network — you do **not**
need the machine's LAN IP (a physical device does).

**This edit must not be committed.** It is the single most likely thing to leak
into a PR. Revert it in step 7 and say so in your report.

## Step 4 — identity

Read `references/app-matrix.md` for the per-app collection and required fields.
The rules that hold for all three apps:

- The phone must be **exactly 10 digits** and listed in
  `shoofi-server/config/test-phones.js`, so no real SMS is sent. `1234567890` is
  already listed.
- The verification code is a fixed 4-digit constant in that same file. **Derive it
  at runtime, never hardcode or print it:**
  ```js
  const tp = require("./config/test-phones.js");
  for (let i = 0; i < 10000; i++) {
    const c = String(i).padStart(4, "0");
    if (tp.isTestAuth(phone, c)) { code = c; break; }
  }
  ```
- `fullName` is required, or login diverts to the "insert customer name" screen.

Sanity-check the login with curl before you spend time on a build:

```bash
curl -s -X POST http://localhost:1111/api/customer/validateAuthCode \
  -H 'Content-Type: application/json' \
  -H 'app-name: shoofi' -H 'app-type: <APP_TYPE>' \
  -d '{"phone":"1234567890","authCode":"<code>"}'
```

A `token` in the response means the app will get in. Note that **this rewrites the
stored token** on the identity document — do not curl-login again while an app is
logged in on the simulator, or the app starts 401-ing on its next poll.

## Step 5 — simulator

```bash
xcrun simctl list devices available | grep -i ipad   # pick a udid
xcrun simctl boot <udid>                             # if not already Booted
cd <app-repo>
npx expo run:ios --device <udid>                     # builds, installs, launches, starts Metro
```

Two caveats, both covered in `app-matrix.md`: `expo run:ios` has been seen opening
on a *different* booted simulator than the one it installed to, and on
`shoofi-shoofir` it **fails at the launch step** (build and install still succeed).
Screenshot to confirm what is actually on screen rather than trusting its output.

A first native build takes a while; subsequent runs reuse DerivedData. If the app
is already installed and you only changed JS, skip the build entirely — start
Metro (`npx expo start --dev-client`) and `xcrun simctl launch <udid> <bundleId>`;
Debug builds load their JS from Metro at runtime, so an `api.js` edit needs no
rebuild.

**Metro binds :8081 and only one app can hold it.** Drive one app at a time; kill
the previous Metro (`pkill -f "expo start"; lsof -ti:8081 | xargs kill -9`) before
starting the next.

## Step 6 — Maestro

`references/maestro-cookbook.md` has the install (including the `java` trap), a
working flow to copy, and the selector rules for a forced-RTL Arabic UI. The one
thing to internalise here: **screenshot at every assertion** and collect them into
a folder the user can open.

## What cannot work on a simulator — don't chase it

- **Push notifications**, and anything built on them (tap-to-open, tap-to-switch-
  store). `registerForPushNotificationsAsync` is gated on `Device.isDevice`, so no
  APNs token is ever issued and the server silently skips the push. Cover that
  logic with unit tests and demo the tap on a physical device.
- **Realtime.** In practice the visible surfaces are **30-second polls**. The
  websocket leg of the notification service passes `appName` where `sendToUser`
  expects `appType`, so messages fall into the Redis offline queue. Budget **~75s**
  in waits, not 30 — the poll that fires just before your write costs you a whole
  extra cycle. Slow is expected; do not report it as a bug.

## Step 7 — leave the place tidy

Report explicitly:

- that you reverted `consts/api.js` (`git checkout -- consts/api.js`), and confirm
  with `git status`;
- anything still running (server, Metro, simulator) and how to stop it;
- any **shared local Mongo document you mutated** — e.g. flipping
  `shoofi.store{id:1}.fraudConfig.enabled` — since that persists for the next
  session on this machine;
- which surfaces you actually proved, and which you could not (see above).
