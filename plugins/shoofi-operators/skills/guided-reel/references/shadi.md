# Shadi — شادي / שאדי — the presenter

Shoofi's 3D courier mascot, built 2026-10-31 from the brand's 3D illustrations. Reuse the same
poses and the same voice in every reel so he stays one person. Full design history (rejected
options, test clips): `~/Documents/project/shoofi/marketing/shadi-character/character.md`.

## Look (never changes)
- Soft glossy 3D cartoon, rounded proportions, clay-like shading.
- Green moped helmet with a **lime stripe**, open face; short dark-brown hair, big dark eyes.
- **Cream long-sleeve top + dark forest-green trousers**, white sneakers with a green heel.
- Bright green backpack with the white **SHOOFI** wordmark.

Check those three bold details on every clip's first and last frame — a model that drifts
changes the stripe or the wordmark first.

## Poses (`../assets/shadi/`, 1152x2048, flat #0000FF background)
| File | Used for |
|---|---|
| `stand.png` | intro and outro segments: full body, facing camera, arms down |
| `point.png` | step segments: full body on the left half, one arm extended pointing RIGHT at shoulder height (where the reel puts the phone) |

**Blue, not green, screen** — Shadi is mostly green, so a green key eats him. The builder keys
with `colorkey=0x0000FF:0.34:0.10,despill=type=blue`.

A new pose (sitting, holding a phone…) is made with Artlist image generation (GPT Image 2.5
"Sunburst" variant worked) from `stand.png` as the reference: "Same exact character, same 3D
style, same outfit … Background: perfectly flat, uniform pure blue #0000FF chroma-key backdrop,
no gradient, no shadow, no floor. Keep everything else identical." Generate 2, pick one, check
the three details, save it here, and add it to the table.

## Voice

| Setting | Value |
|---|---|
| Voice | **Explore** (Artlist library, adult male) |
| Model | **Eleven v4** (not v3) |
| Language | Arabic, or Hebrew for the Hebrew take |
| Stability | 50% |
| Effect | none |
| Text | **plain lines, no `[tone]` tags**; a blank line between groups gives a longer pause |

Why v4 plain: v3 with tone tags kept reading تبع→تابع, عشرة شيكل→«عشرت», and dropped the ع in
ادعي. Sari picked v4 on 2026-10-31 and the same text came out right.

**Generate the whole script as ONE take per language** — separate takes drift in pitch and
speed and he stops sounding like one person. Cut it into segments afterwards
(`reel.py segments`).

### Arabic wording (Shadi)
- Palestinian colloquial, house voice C — short, tight. Same register as the social-marketing
  operator's CORE §1, with **one deliberate difference: the courier is المرسل** in Shadi's
  videos (Sari, 2026-10-31), not الشليح.
- Self-introduction: «أهلا، اسمي شادي، المرسل تبع شوفي».
- Light tashkeel only where the model guessed wrong: المُرسِل، تَبَع، المَلَفّ، ادْعي.
- **Numbers as words, ه not ة on عشره**: «عشره شيكل», «عشرين شيكل», «سبعين شيكل», «تسعين يوم».
  A ة makes the model read the construct state «عشرت».
- Words that came out right and can be reused: طوّالي، لحالها، بتوخذ، بتلاقيها، هسّا، لَهَسّا،
  عالواتساب، عالطلب.

### Hebrew wording
Plural imperative (היכנסו, לחצו, שלחו), plain spoken Hebrew, השליח (Hebrew keeps it). Numbers
as words (עשרים שקל, שבעים שקל ומעלה, תשעים יום).

### Pronunciation fixes — respell, don't re-record
1. Transcribe the take: `whisper-cli -m ~/.cache/whisper-cpp/ggml-large-v3-turbo-q5_0.bin -l ar -np -f voice.wav`
   (convert with `ffmpeg -i voice.mp3 -ar 16000 -ac 1 voice.wav`; `-l he` for Hebrew).
2. Diff word by word against the script. If the person can't describe the problem in writing,
   they record the line on their phone; transcribe that too and diff the two.
3. Respell or re-word the bad word (tashkeel, ه for ة, a synonym), regenerate the **single
   line** to test cheaply, then the full take, then transcribe again.

**Speech-to-speech is rejected** (Sari, 2026-10-31: "I want it the same Explore way — the
recording is only for how words are pronounced"). A recording guides the spelling, it is never
the source audio.

## Lip-sync (Wan 2.7 image-to-video)
- **720p, 9:16**, image = pose asset, audio = segment asset (the audio drives the mouth).
- **Upload the pose and each segment mp3 as assets** (upload → PUT → confirm) and pass the asset
  ids. A previous generation's id as an input is refused. Seedance's reference-to-video does not
  accept image + audio together — Wan is the one that does.
- `duration` = segment length rounded **up** to a whole second, **min 4 s, max 15 s**. Segments
  under ~3.5 s fail (no charge); `reel.py segments` pads them with silence to 4 s, and the
  builder trims the clip back to the segment.
- Cost ≈ 200 credits per second at 720p. Quote all clips of both languages in one batch.

Prompts that worked (2026-10-31):

**Intro (stand.png)** — "The full-body 3D cartoon courier talks to the camera with lips
precisely synced to the voice audio, mouth clearly opening and closing with every syllable. At
the very start he raises one hand and waves hello warmly while greeting, then lowers it and
keeps talking with friendly expressions, gentle head movement and natural hand gestures on key
words. Keep the exact character, outfit, full-body framing and the perfectly flat pure blue
#0000FF background unchanged. Static camera."

**Steps (point.png)** — "The full-body 3D cartoon courier keeps one arm extended, pointing with
his index finger to the right side of the frame the whole time, while talking to the camera with
lips precisely synced to the voice audio, mouth clearly opening and closing with every syllable.
His other hand makes small natural gestures on key words; friendly expressions and gentle head
nods. Keep the exact character, outfit, full-body framing and the perfectly flat pure blue
#0000FF background unchanged. Static camera." Extra negative: "lowering the pointing arm".

**Outro (stand.png)** — "…talks excitedly to the camera … making an inviting open-hand gesture
toward the camera and then a friendly wave goodbye. …"

Negative prompt for all: "text, subtitles, extra people, camera movement, background change,
shadows on background, warped hands, extra fingers, changing outfit, closed mouth while
speaking".

Without "mouth clearly opening and closing with every syllable" and the "closed mouth while
speaking" negative, the full-body clips barely moved the lips (the face is small in a full-body
frame).
