# The six styles

A promo reel has two separate choices (owner, 2026-11-06):
- **the subject** — `store` (new store), `dish` (new dish), `deal`, `coupon` — decides the facts and
  the words;
- **the style** — how it looks. Posts about the same kind of subject must not look alike.

All styles: 1080x1920, 30 fps, 10–12.5 s, Arabic and Hebrew (one render per language), every word
inside the safe zone (y 260–1440, x 80–860: clear of Instagram's top bar, caption area and right
rail), the Shoofi pill in the first seconds, the end card last (CTA + Shoofi + the store's logo).
Brand on screen ≤ 25% of the video.

| id | Name | What you see | Fits | Needs |
|---|---|---|---|---|
| `closeup` | תקריב | One dish, slow macro push-in, very few words: «جديد», the dish name, the store, ingredient chips, the price if set | dish · store · deal | 1 dish photo (or clip) |
| `rush` | קצב | Six dishes, 0.9 s each, punch-in cuts on the beat; a one-word hook; then the offer on a dark plate | store · deal | 6 dish photos |
| `number` | המספר | The offer slams in first on the brand colour; two dishes behind a corner badge; an honest terms card | deal · coupon | 2 dish photos, the offer |
| `table` | שולחן | Top-down: four photo cards drop onto a paper "table", the store logo lands in the middle, then the offer row | store · deal | 4 top-down photos, the logo |
| `inapp` | באפליקציה | A phone rises with a real app screen; the line that matters is ringed and zoomed; a coupon ticket slides in | coupon · store · deal | a real screenshot (local-app-e2e) |
| `shadi` | שאדי מציג | Shadi greets, then points at the offer ticket | all | — (lip-sync clips optional, 800 credits per 4 s) |

## No two posts alike: the picker

`scripts/pick.py <history.json> --store <appName> --subject … [--dish-type …] [--styles …] --write`
chooses every dimension of the next reel — **style, theme, opening motion, end card, music,
food sound, opening line** — as the option this store used longest ago, never one of the last
two reels overall (ties: a stable hash of store + date). Four Burger Cave deals in a row came out
shadi/dark/stamp/ai-steam, closeup/beige/drop/free-split, rush/green/spin/ai-split,
number/lime/stamp/still. The history lives in `~/Documents/project/shoofi/marketing/promo-history.json`
(one row per reel); merge the printed choice into the spec (`style`, `theme`, `endCard`, …).

**End cards** (`spec.endCard`): `drop` (the icon drops, squashes, wiggles), `spin` (spins in),
`stamp` (slams in from big with a shake). All three: 380 px Shoofi icon, lime rings pulsing out,
a shine across the icon, the CTA on one line, the store's logo at 300 px with a lime ring (a
coupon gets a pulsing «اطلب الآن» button instead).

**Opening motion** (`motion`): per dish type (motion.md). In the spec: `subject.hookClip` (an AI
clip, e.g. the Kling split) or `subject.split` (y cuts between the layers of a stacked dish, in
the 1080x1920 frame — the free split: the real photo cut into bands that fly apart and snap back,
a blurred copy of the photo behind the gaps), else the slow push-in.

**Menu photos smaller than the frame** (most are landscape, 1000–1700 px tall — full-bleed on a
1920 frame they stretch 1.3–1.9×): `panel(d, {y, h})` in styles.js shows the dish full-width at a
size it fills sharply (h 1080 square, 1350 for 4:5) over a blurred copy of itself (`data-bg`, which
the resolution check skips). Rush and Number use it; an AI clip for a panel comes from the photo
cropped to the panel's shape (Kling v3 Pro from a 4:5 crop → 1288x1608).

## Variations (so one style still looks different from post to post)

- **theme** — `green` (ink #17320F, end card dark), `lime` (light paper, lime end card), `dark`
  (#121212), `beige` (paper #EDE3D6 for top-down food). Keys: `ink lime paper endBg endInk glow`.
- **opening line** — a question («جوعان؟»), the number, or «جديد».
- **music mood** — from the Artlist catalog (search_music), chosen per post.
- **Shadi** — optional in every style: a 3 s insert you switch on (`shadi` is the one built on him).

## Banner versions (1920x1080 stills, one per language)

Every style has a banner: `bannerCloseup`, `bannerRush`, `bannerNumber`, `bannerTable`,
`bannerInapp`, `bannerShadi` (`spec.size: [1920, 1080]`, render one still with `--still=0.5`).
The words are in the picture (the app shows no overlay on a home banner) and exact — rendered,
not drawn by an image model, which can misspell Arabic or invent a number. Arabic and Hebrew
each get their own spec (`examples/banners/`); a Hebrew in-app banner needs the Hebrew screenshot.
`subject.offer.headline` is the banner's big line (`\n` breaks it); `text.ctaButton` the button.
Bidi: a highlighted number, price or Latin word (`**10%**`, `**₪20**`) is isolated left-to-right,
or it prints "%10".

## Rotation

Pick among the styles the owner approved (`shoofi.marketingTemplates`, `channel: "reel"`,
`status: "approved"`, `reelStyle`, `fits`) that fit the subject. Never the same style twice in a row
for one store, never the style of the last two reels published. The owner can always choose.

## The spec (see ../examples)

```jsonc
{
  "style": "number",
  "theme": { "ink": "#17320F", "lime": "#8AEA5F", "paper": "#F9F8F5", "endBg": "#17320F", "endInk": "#fff", "glow": "#DFF5D0" },
  "subject": {
    "kind": "deal",
    "store": { "name": "Burger Cave", "logo": "../img/burger-cave-logo.png" },
    "offer": { "big": "10%", "label": "خصم", "line": "على كل وجبة عند **Burger Cave**", "terms": "للطلبات فوق ₪30 · لغاية 30/11" },
    "dishes": [{ "name": "…", "img": "../img/….jpg", "clip": "../clips/….mp4" }]
  },
  "text": { "pill": "شوفي", "hook": "جوعان؟", "cta": "اطلب من **شوفي**" },
  "assets": { "font": "../assets/me.ttf", "icon": "../assets/shoofi-icon.png", "shadiStand": "../assets/shadi-stand.png", "shadiPoint": "../assets/shadi-point.png" },
  "audio": "../out/mix-ar.m4a"
}
```
`**word**` gets the lime highlight. A dish with `clip` plays the clip (seeked frame by frame);
without it, the photo with a slow zoom. `audio` is muxed and the video trimmed to it.
`inapp` also takes `assets.screen {src, width, from, view, hl {x, y, w, h}}` in screenshot pixels.
