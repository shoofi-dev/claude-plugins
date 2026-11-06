---
name: promo-reel
description: >-
  Make a short promo video (10–12 s, 9:16, Arabic and Hebrew) for a Shoofi subject — a new store,
  a new dish, a deal or a coupon — in one of six styles (תקריב close-up, קצב fast cuts, המספר big
  number, שולחן table spread, באפליקציה in the app, שאדי מציג Shadi presents), rotated so posts
  about the same kind of subject don't look alike. Every word comes from the database facts and
  every dish from the store's real photo. A free draft first (stills with motion); the final reel
  animates the dishes (Kling, from the real photo) and adds voice and music, which spends Artlist
  credits, so every paid step stops for a person's yes. Use for "make a video/reel/story for
  <store/dish/deal/coupon>", "promo video", "a story ad for the deal", or to make the example of a
  video template. Never publishes. Do NOT use for explaining an app feature step by step (that is
  guided-reel), for still banners/stories (the admin's marketing wizard), or for text posts
  (social-marketing).
---

# Promo reel — a subject in a style

```
facts ──▶ style ──▶ draft ──▶ GATE 1 ──▶ clips + voice ──▶ GATE 2 ──▶ final + QA ──▶ GATE 3
(DB)     (rotate)  (free)    (look)     (Artlist)          (credits)   (render.mjs)    (watch)
```

**The gates are hard stops.** Show the person what they decide and wait. Never confirm an Artlist
cost the person has not approved in this conversation.

Read first: `references/styles.md` (the six styles, variations, rotation, the spec),
`references/research.md` (why they look like this), `references/motion.md` (dish clips: model,
price, prompt).

## 1. Facts — only what is true today

The subject's facts from the database (read-only), never from memory: the store's name and logo
(`shoofi.stores`), dishes with photos (`<store>.products`: sellable, `isInStore`, a photo), the
deal (`<store>.promotions`: `config.percent`, `minOrderAmount`, `endDate`, its scope) or the coupon
(`shoofi.coupons`: public — no `customerId`; active; `value`, `minOrderAmount`). The marketing
manager's rules hold: only existing offers, only coupons any customer can use, no competitor, no
customer. "New" only when it is (a store in its `launchDate` window; a dish created in the last
weeks). Ask the owning domain agent when a rule is unclear (orders: deals and coupons;
menu-catalog: dishes).

## 2. The look — rotate everything

Run `scripts/pick.py` with the styles the owner approved (`marketingTemplates`, `channel: "reel"`,
`status: "approved"`) and the store: it picks style, theme, opening motion, end card, music, food
sound and opening line, each the option this store used longest ago and never one of the last two
reels (styles.md "No two posts alike"). Shadi is optional (a 3 s insert) unless the style is
`shadi`.

## 3. Draft (free)

```bash
SK=<this skill>; W=~/Documents/project/shoofi/marketing/<subject>-reel
python3 -I $SK/scripts/prep.py $W                         # fonts, icon, Shadi with alpha
# put the photos in $W/img, write $W/specs/<style>-<lang>.json (see examples/)
PLAYWRIGHT=<…/node_modules/playwright> node $SK/engine/render.mjs $W/specs/x.json $W/out/x.png --still=3   # one frame
PLAYWRIGHT=<…> node $SK/engine/render.mjs $W/specs/x.json $W/out/x.mp4    # the draft
```

Pick dishes with **distinct photos** (menus reuse one photo for several sizes — group them by
hash) and photos large enough for where they show. Then the review, before any person sees it:
`render.mjs <spec> /dev/null --review` (stretched photos, repeated photos, text outside the safe
zone or overlapping — exit 3 on a finding), and the **creative director** (`shoofi-operators:
creative-director`) looks at the full-size frames against its rubric. Only a PASS goes on.
**GATE 1**: the draft video(s), the words, the facts each depends on, the director's scorecard.

## 4. Clips and voice (paid)

- One Kling clip per dish shown (motion.md), from the uploaded real photo, in one batch; Shadi
  lip-sync only if switched on (guided-reel's pipeline). Add `clip` to each dish in the spec.
- Voice: Artlist Explore (≈ 17 credits for a 10 s line; Artlist may route it to Eleven v3 — check
  it with whisper-cli), the guided-reel voice rules (numbers in words, عشره with ه). Cut it at its
  pauses and place each phrase on its scene.
- Music: the picker's catalog track (download_track; its hook start in pick.py), ducked under the
  voice (`sidechaincompress`). Sounds: a food sound at the open, an impact where the dish lands
  and where the Shoofi logo lands (search_sfx; the download link of a sound effect can 403 — its
  preview link serves the whole clip). Mix to -14 LUFS into `audio` in the spec.
- The final Sweet Diablo reel (`examples/closeup-masterburger-final.json`) was made this way.
- **GATE 2**: the total credits from the batch quote.

## 5. Final and QA

Render each language; `--review` again and the creative director again (full size, never a
contact sheet). **GATE 3**: the final MP4s. Posting
goes through פרסום ידני (social) or a story in the app — a person does it.

## Banners

Every style has a 16:9 banner version (styles.md "Banner versions"): one still per language,
exact words, the real photos. Make it with the reel, or alone for a home banner; it goes into the
ad form as `imageAR` / `imageHE`.

## A video template's example

When the owner asks for examples of the styles, make drafts on real subjects (one per style) and
hand them over. The owner uploads the ones they approve in מרכז שיווק → תבניות → "תבנית וידאו"
(shoofi-server `POST /api/admin/marketing/templates/video`, with the style's banner version as
`banner`); that is the approval, and the CMO uses
only approved styles. The six examples in `examples/` were made this way on 2026-11-06 (Burger
Cave's 10% deal, Pastito's 7% deal, Master Burgers' Sweet Diablo, the public ₪20 coupon).

## Engine

`engine/stage.html` is a 1080x1920 page whose layers are pure functions of time; `styles.js`
turns a spec into layers per style; `render.mjs` (Playwright) calls `renderAt(t)` per frame and
pipes screenshots to ffmpeg (H.264, 30 fps, `audio` muxed). A new style is a new function in
`styles.js` plus a row in styles.md and in shoofi-server `REEL_STYLES`.
