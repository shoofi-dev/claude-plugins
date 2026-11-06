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

## 2. Style — rotate

Pick a style the owner approved (`marketingTemplates`, `channel: "reel"`, `status: "approved"`)
whose `fits` includes the subject: never the same style twice in a row for a store, never the
style of the last two reels. Then a theme and an opening line (styles.md "Variations"). Shadi is
optional (a 3 s insert) unless the style is `shadi`.

## 3. Draft (free)

```bash
SK=<this skill>; W=~/Documents/project/shoofi/marketing/<subject>-reel
python3 -I $SK/scripts/prep.py $W                         # fonts, icon, Shadi with alpha
# put the photos in $W/img, write $W/specs/<style>-<lang>.json (see examples/)
PLAYWRIGHT=<…/node_modules/playwright> node $SK/engine/render.mjs $W/specs/x.json $W/out/x.png --still=3   # one frame
PLAYWRIGHT=<…> node $SK/engine/render.mjs $W/specs/x.json $W/out/x.mp4    # the draft
```

Look at stills at the key moments before the full render (text in the safe zone, nothing cut,
the highlight not wrapping). **GATE 1**: the draft video(s), the words, the facts each depends on.

## 4. Clips and voice (paid)

- One Kling clip per dish shown (motion.md), from the uploaded real photo, in one batch; Shadi
  lip-sync only if switched on (guided-reel's pipeline). Add `clip` to each dish in the spec.
- Voice: Artlist Explore on Eleven v4, the guided-reel voice rules (numbers in words, عشره with
  ه). Music: a catalog track (search_music, instrumental, upbeat), ducked under the voice; one
  food sound on the first cut (search_sfx). Mix to `audio` in the spec.
- **GATE 2**: the total credits from the batch quote.

## 5. Final and QA

Render each language; check the stills again and watch it. **GATE 3**: the final MP4s. Posting
goes through פרסום ידני (social) or a story in the app — a person does it.

## A video template's example

When the owner asks for examples of the styles, make drafts on real subjects (one per style) and
hand them over. The owner uploads the ones they approve in מרכז שיווק → תבניות → "תבנית וידאו"
(shoofi-server `POST /api/admin/marketing/templates/video`); that is the approval, and the CMO uses
only approved styles. The six examples in `examples/` were made this way on 2026-11-06 (Burger
Cave's 10% deal, Pastito's 7% deal, Master Burgers' Sweet Diablo, the public ₪20 coupon).

## Engine

`engine/stage.html` is a 1080x1920 page whose layers are pure functions of time; `styles.js`
turns a spec into layers per style; `render.mjs` (Playwright) calls `renderAt(t)` per frame and
pipes screenshots to ffmpeg (H.264, 30 fps, `audio` muxed). A new style is a new function in
`styles.js` plus a row in styles.md and in shoofi-server `REEL_STYLES`.
