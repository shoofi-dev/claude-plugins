# Moving dishes: clips from the real photo

A draft uses the still photos with a slow zoom (free). The final reel replaces each dish with a
clip whose **first frame is the store's own photo**, so the food on screen is the real dish.

## The model and its price (Artlist, quoted 2026-11-06)

| Model | Credits | Use |
|---|---|---|
| **Kling v3 Standard (720), no audio, image-to-video** | **400 per 5 s** | every dish clip |
| Wan 2.7 lip-sync (guided-reel) | 800 per 4 s | Shadi talking (optional) |
| Seedance 2.5 I2V 720p | 500 per second (15 s = 7,500; 480p draft 200/s) | not used — six times the price, and a multi-shot generation can invent food that is not on the menu |

Upload each photo as an asset first, then one batch for all clips of a reel; every
`confirmation_required` price goes to a person.

## The prompt (the Seedance guide's formula, approved in the Library)

One shot, 60–120 words, in this order: **subject** (the dish exactly as in the reference) →
**action** (one food motion: steam, cheese softening, sauce drip, fries settling) → **setting
and light** (as in the photo, warm side light) → **one camera move** (slow push-in, or a slow
orbit — never both; camera and subject in separate sentences) → **style anchor** (a named look,
e.g. "food-commercial macro, shallow depth of field" — not "cinematic", not "8K") → **what must
stay** (said positively: "the dish, the bun and the plate stay identical to the reference").
The reference image has one job: the dish's identity.

Example (5 s):
> The burger from the reference photo, exactly as it is, on its plate. Gentle steam rises from the
> patty and the cheese softens at the edge. The background and light stay as in the photo, warm
> side light from the left. Slow push-in toward the burger, stable. Food-commercial macro look,
> shallow depth of field. The burger, the bun and the plate stay identical to the reference.

### The split (tested 2026-11-06, Master Burgers' Sweet Diablo, 400 credits)

Kling v3 Standard takes a **start AND an end frame**: give the same real photo as both, and the
dish can come apart and land back exactly as it is (`input: {startFrame: {assetId}, endFrame:
{assetId}}`, 5 s). The prompt that worked:
> The burger from the reference photo, exactly as it is, on its plate with fries. Its layers lift
> apart vertically one by one: the top bun rises first, then the two crispy coated pieces, then the
> beef patty, until they float in mid-air with small even gaps between them, a few crumbs drifting.
> They hold for a moment, then fall back down in order and land together into the exact original
> burger. The background and the warm light stay as in the photo. The camera stays fixed and
> stable. Food-commercial macro look, shallow depth of field. The bun, the crispy pieces, the
> patty, the fries and the plate stay identical to the reference.

The layers separate at ~1.0 s, hover 2.0–3.0 s and land at ~3.8 s — put the impact sound there.

**Sharp version (2026-11-07, 630 credits).** The Standard clip came back 856x1072 and showed at 1.8× on
the 9:16 frame — soft. The fix that passed the review: re-render the menu photo vertical at 2K
(Nano Banana 2 I2I 2K, 9:16, 130 credits — prompt: recompose into 9:16, keep every layer identical,
extend the background) → 1536x2752; then the same split on **Kling v3 Pro (1080)** with that image as
start and end frame (500 / 5 s) → 1076x1924, 24 fps, shown at 1.0×. Use the 2K image for the stills
too. This take lands at ~3.5 s (impact at 3.0 s in the mix: the sound has a short lead-in). Look at the
2K image first: the model zooms out a little (the dish fills ~55% of the width) and redraws the fries.

### A motion for each kind of dish (the picker's `motion`)

| Dish | Motions (AI, from the real photo) | Free fallback |
|---|---|---|
| burger | `ai-split` (start = end frame, above), `ai-steam` | `free-split`, push-in |
| pizza | `ai-cheese-pull` (a slice lifts, the cheese stretches) | push-in |
| shawarma / wrap | `ai-slice` (a knife cuts it in half, the inside shows) | push-in |
| salad | `ai-toss` (the leaves lift and settle) | push-in |
| drink | `ai-pour` (ice and drink poured), `ai-condensation` | push-in |
| dessert | `ai-drizzle` (sauce runs down) | push-in |
| fries | `ai-tumble` (fries drop into the box) | push-in |
| anything | `ai-steam` (steam rises, slow push-in) | push-in |

Write each with the formula above: the dish exactly as in the photo, ONE motion, one camera
instruction, what must stay identical. Use the start = end frame trick whenever the motion should
return to the dish as it is (split, toss, tumble).

Look at every clip before using it: a changed dish (extra toppings, a different bun) is a false
claim — drop it and keep the still.
