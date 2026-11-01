# Capturing the real screens

The reel shows the actual app. Never mock a screen in HTML, never use a real customer's
account, and never show test data that reads as fake (a "Test Store", a 0.00 total) — crop it
away with a `card` row or seed nicer data.

## Setup
Use `/shoofi-testing:local-app-e2e`: local server + Mongo, the customer app on an iOS simulator,
a seeded login. Use **a dedicated simulator and Metro on its own port** (e.g. 8087) so a Metro
someone is already running on 8081 is untouched.

Seed exactly the state each screen needs (for referrals: an inviter, two invited friends, their
REF coupons) with a small script, and **delete what you seeded** afterwards. Values in the seed
must match the live config you read in Step 1 — the screens are evidence for the script's claims.

## One PNG per screen, per language
`xcrun simctl io <udid> screenshot <work>/screens/<lang>/<NN-name>.png` — iPhone 17 Pro gives
1206x2622, the `shotSize` the builder assumes (set `shotSize` in reel.json for another device).
Switch the app language and take the whole set again: the Arabic and Hebrew screens differ in
layout, so a region measured on one is wrong on the other (use a per-language region).

Name screens by step: `01-profile`, `02-invite-top`, `03-invite-how`, … The same screen can
be used by several rows with different callouts.

## Traps (iOS 26.5 simulator, 2026-10-31)
- **Push banners do work on a simulator.** `simctl privacy` can't grant notifications; instead
  shut the sim down, add a `sectionInfo["com.shoofi.shopping"]` entry to
  `data/Library/BulletinBoard/VersionedSectionInfo.plist` (clone the `com.apple.MobileSMS`
  entry with plistlib, set the bundle id/name, clear custom-settings refs), boot, then
  `xcrun simctl push <udid> com.shoofi.shopping payload.json` shows a real banner.
- **`simctl io recordVideo` is variable-frame-rate**: no frames while the screen is idle, so
  `-ss` trims come out nearly empty. Re-encode with `fps=30,tpad=stop_mode=clone` first. Prefer
  still screenshots — the reel animates them anyway.
- **Maestro point taps need integer %** (`"50%,80%"`); OTP cells on iPhone ≈ `50%,27%`.
- After login the app may keep a cached city-area at (0,0) until a saved address is picked from
  the home header — explore returns 400. Pick the address once.
- The checkout coupon card shows `STACKED_FULL_DISCOUNT` instead of the coupon code when one
  full-discount coupon is auto-applied. Crop the checkout to the totals (a `card` row with
  `crop`) rather than showing that label.

## Measuring callout regions
A region is `[x, y, w, h]` in screenshot pixels around the item to zoom (a row, a button, a
coupon card). Leave ~10 px of margin. Verify every one before rendering:

```bash
ffmpeg -loglevel error -y -i screens/ar/02-invite-top.png -vf "crop=990:165:108:1896" /tmp/check.png
```

and look at it. The callout is scaled to 840 px wide, so a region much wider than tall
(e.g. 1100x120) makes a thin strip — include a little context above and below.
