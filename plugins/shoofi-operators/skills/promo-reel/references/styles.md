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

## Variations (so one style still looks different from post to post)

- **theme** — `green` (ink #17320F, end card dark), `lime` (light paper, lime end card), `dark`
  (#121212), `beige` (paper #EDE3D6 for top-down food). Keys: `ink lime paper endBg endInk glow`.
- **opening line** — a question («جوعان؟»), the number, or «جديد».
- **music mood** — from the Artlist catalog (search_music), chosen per post.
- **Shadi** — optional in every style: a 3 s insert you switch on (`shadi` is the one built on him).

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
