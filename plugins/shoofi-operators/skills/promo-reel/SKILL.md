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

**Check the offer is live, on the day you render — never from a spec or memory.** A deal:
`isActive: true` and today inside `startDate`–`endDate`. A coupon: `isActive`, no `customerId`,
today inside `start`–`end`, and read its scope — `discountType` (`delivery` takes the money off the
delivery fee, not the order) and `applicableTo.stores` (one store = say that store). 2026-11-07:
the ₪20 coupon in four examples had ended a year earlier, was one store's, and was a delivery
discount; Burger Cave's 10% deal was switched off while its dates still ran. A reel on a dead offer
is a false ad — stop and ask for a live one.

## 2. The look — rotate everything

Run `scripts/pick.py` with the styles the owner approved (`marketingTemplates`, `channel: "reel"`,
`status: "approved"`) and the store: it picks style, theme, opening motion, end card, music, food
sound and opening line, each the option this store used longest ago and never one of the last two
reels (styles.md "No two posts alike").

**Options (the owner's defaults, 2026-11-07): plain is the default.** No voice and no Shadi unless
the request asks for them (`pick.py --voice`, `--shadi`; without `--shadi` the `shadi` style is never
picked); the soundtrack is ON unless switched off (`--no-music`). Text, real photos, motion and
music always; voice and Shadi cost credits and are opt-in per reel.

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
- Voice: the house voice — Artlist **Explore on Eleven v4** (pin the v4 model; left to routing it
  goes to Eleven v3), Arabic, stability 50%, no effect, **plain lines, no `[tone]` tags**, a blank
  line between phrases (≈ 11 credits for a 8 s line). **Palestinian colloquial**, never Lebanese/
  Syrian or standard Arabic: «هسّا» (not «هلأ» / «الآن»), «جْديد» with the sukun (jdīd, not jadīd),
  «أُطلُبو» (not «اطلبه»); the full rules are guided-reel `references/shadi.md` §Voice (numbers
  in words, «عشره» with ه). Transcribe the take with whisper-cli and diff it against the script.
  One take per language, cut at its pauses, each phrase placed on its scene. (2026-11-07: the
  Sweet Diablo line said «هلأ» on Eleven v3 — the owner caught it.)
- Music: the picker's catalog track (download_track; its hook start in pick.py). Sounds: a food
  sound at the open, an impact where the offer and the Shoofi logo land (search_sfx; the download
  link of a sound effect can 403 — its preview link serves the whole clip).
- Mix with `scripts/mix.py` (music on by default, the voice only when asked; the music ducks under
  the voice; -14 LUFS) into `audio` in the spec — its length is the reel's length:
  `python3 -I scripts/mix.py out/mix.m4a --duration 10.6 --music m.mp3 --music-start 123.1
  --voice v.mp3 --cut 0:0.8@0.15 --cut 0.9:6.05@1.9 --cut 6.2:@8.35 --sound impact.aac@5.4:0.7`
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

## A request from the admin ("צור סרטון")

The marketing wizard (story or social post → "תוכן" → סרטון) queues a reel as a bridge task whose
whole prompt the server wrote (shoofi-server docs/marketing-reels.md). The owner's choices in it
are the switches — `--voice` / `--shadi` / `--no-music` for `pick.py`, AI dish motion on or off,
the style or the styles "auto" may pick from, the languages — and the **spend cap**: the credits
the owner approved by switching paid options on (0 with all of them off). Follow them exactly;
the gates in this skill are already answered by those switches, up to the cap. Anything above the
cap: stop, render nothing more, and answer what it needs and the price.

- Facts are checked that day (§1). An offer that is not live → no reel; the answer says why.
- `render.mjs --review` and the creative director's PASS before anything is handed over.
- **Output contract:** in `.reel-out/` in the working directory — `reel-<lang>.mp4` (1080x1920,
  H.264, under 40 MB — the story form takes 50) per language, optionally `banner-<lang>.png` (1920x1080), and
  `manifest.json`: `{"files":[{"name":"reel-ar.mp4","kind":"video","lang":"ar","caption":"…"}],
  "style":"rush","creditsSpent":0,"review":"PASS — …"}`. The bridge uploads exactly these names
  when the run ends; the owner attaches the video to the story or post in the wizard.
- Never publish, never create a draft, never change data — the owner's form does that.

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
