# reel.json and the builder

`scripts/reel.py` turns a project folder into `reel-<lang>.mp4` (1080x1920, 30 fps, AAC at
-14 LUFS). Needs: Python 3, ffmpeg/ffprobe (no libass/freetype needed — text is rendered by
Chrome), Google Chrome, and the shoofi-app checkout for the font and logo
(`SHOOFI_APP=/path/to/shoofi-app` if it isn't at `~/Documents/project/shoofi/shoofi-app`).

## Format (see `../examples/invite-friend/reel.json`)

```jsonc
{
  "name": "invite-friend",
  "feature": "one paragraph: what's true about the feature, with the numbers",
  "shotSize": [1206, 2622],                 // screenshot size (iPhone 17 Pro)
  "regions": {                              // named callout boxes [x, y, w, h] in screenshot px
    "SHARE_BTN": [108, 1896, 990, 165],
    "STEP2": { "ar": [60, 1040, 1110, 200], "he": [60, 980, 1110, 200] }   // per language
  },
  "text": {
    "ar": { "title": "pill at the top of intro/outro",
            "endCard": { "big": "reward line, <b>keyword</b> allowed", "fine": "conditions" } },
    "he": { … }
  },
  "langs": {
    "ar": {
      "voice": "voice-ar.mp3",              // relative to the project folder
      "segments": [                         // Shadi clips, consecutive from 0
        { "until": 6.60, "pose": "stand", "clip": "clips/ar-1.mp4" },
        { "until": 14.64, "pose": "point", "clip": "clips/ar-2.mp4" },
        { "until": null, "pose": "stand", "clip": "clips/ar-5.mp4" }   // null = end of voice
      ],
      "rows": [                             // captions/screens, consecutive from 0
        { "t": [0.00, 3.07], "kind": "intro", "caption": "… <b>keyword</b>" },
        { "t": [9.88, 12.60], "kind": "phone", "screen": "02-invite-top", "callout": "SHARE_BTN", "caption": "…" },
        { "t": [20.94, 23.70], "kind": "card", "screen": "05-checkout-discount", "crop": [1110, 2420],
          "callout": "DISCOUNT", "caption": "…" },
        { "t": [33.33, null], "kind": "outro", "caption": "…" }
      ]
    }
  }
}
```

Row kinds:
- `intro` / `outro` — Shadi full frame, title pill, caption low. After the voice ends the
  builder adds 2.6 s of end card (`endCard`).
- `phone` — Shadi small on the left pointing; the screenshot in a phone frame on the right,
  the `callout` region ringed in lime on the phone and flown out as a zoomed cut-out to where
  his finger points. Consecutive phone rows crossfade the screen inside one phone.
- `card` — a vertical slice of the screenshot (`crop: [y0, y1]`) as a floating card instead of
  a phone, for screens where the rest would show test data.

`callout` is optional (a row with none just shows the phone). A clip that's missing makes the
builder use the still pose for that segment and print DRAFT.

## Commands

| | |
|---|---|
| `reel.py check <dir>` | spec + files + timing sanity (rows contiguous, last row ends with the voice, every full↔pointing switch on a segment edge, segments ≤ 15 s) |
| `reel.py pauses <dir> <lang>` | silences ≥ 0.18 s in the voice with their midpoints — cut rows and segments there |
| `reel.py segments <dir> <lang>` | `build/seg-<lang>-N.mp3` per segment, short ones padded to 4 s for Wan |
| `reel.py track <dir> <lang>` | `build/track-<lang>.mp4`, the blue-screen Shadi track |
| `reel.py reel <dir> <lang>` | track + `reel-<lang>.mp4` |
| `reel.py qa <dir> <lang>` | 6 biggest frame-to-frame jumps (YDIF) + `build/strip-<lang>.jpg` (12 frames) |

Layout constants (phone position, callout target, Shadi's small size) are at the top of
`reel.py`; they were tuned so the callout lands at his fingertip and never covers his helmet.
Change them only together with a look at the strip.

## Flicker — what caused it and what the builder does about it
Measured with YDIF; the first draft peaked at 41, the shipped reels at ~9.
- Overlapping enable windows (`between(t,a,b)` is inclusive) showed two Shadis for one frame
  → windows are half-open `gte(t,a)*lt(t,b)`.
- Hard cuts between poses and backgrounds → 0.25 s crossfades; the outgoing Shadi freezes on
  his last frame (`tpad=stop_mode=clone`) so the fade never reveals the next clip's first pose.
- Captions fading in from nothing → the old caption stays until the new one is fully in.
- A slow continuous zoom on the phone shimmered on screen text → the phone pops in once and
  then holds still.
- A blank last frame → the end card row runs 0.5 s past the output length.

If `qa` shows a jump over ~15 outside the intro→steps hand-over, look at the frames around that
time before blaming the clip.
