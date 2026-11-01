---
name: guided-reel
description: >-
  Make a guided explainer reel for a Shoofi app feature: Shadi, the 3D courier mascot, explains
  the feature step by step in Arabic (Palestinian) and Hebrew, lip-synced, standing beside a phone
  that shows REAL app screenshots, with the important item cut out and zoomed. Use when asked to
  "make a reel/video explaining <feature>", "a Shadi video for X", "a guided reel", "explain the
  <flow> in a video", or to redo/update an existing guided reel. The output is a 1080x1920 MP4 per
  language for a human to approve and post — it never publishes. Spends Artlist credits, so every
  paid step stops for a person's yes. Do NOT use for still images or banner/story artwork (the
  admin's marketing wizard generates those) or for text-only social posts (social-marketing).
---

# Guided reel — Shadi explains a feature

Worked example, end to end: the invite-a-friend reel (2026-10-31). Its spec is
`examples/invite-friend/reel.json`; its source files live in
`~/Documents/project/shoofi/marketing/shadi-character/` (screens, voices, clips). Rebuilding it
with `scripts/reel.py` gives a byte-identical copy of the approved reels.

```
truth → script ──▶ GATE 1 ──▶ screens ──▶ voice ──▶ GATE 2 ──▶ timing ──▶ clips ──▶ GATE 3 ──▶ build + QA ──▶ GATE 4
        (facts)    (words)     (simulator)  (Artlist)  (listen)  (reel.json) (Artlist)  (credits)    (reel.py)     (watch)
```

**The gates are hard stops.** At each one, show the person what they need to decide and wait
for their answer. A subagent running this skill ends its turn at a gate and returns what to
show; the session resumes it after the person answers. **Never confirm an Artlist cost the
person has not approved in this conversation** — when a generation answers
`confirmation_required`, that quote is the question to ask, not a formality.

Work folder: `~/Documents/project/shoofi/marketing/<feature>-reel/` (create it). Keep every take;
never overwrite an approved file.

---

## Step 1 — The truth about the feature (before a single word of script)

A reel that explains a feature wrong is worse than no reel: people screenshot it and argue with
support. So:

1. **Ask the owning domain agent** how the feature really works (rules, amounts, limits,
   edge cases) — e.g. referrals → `shoofi-domains:customers`, coupons → `shoofi-domains:orders`,
   checkout/payment → `shoofi-domains:payments`. Its context doc knows the traps.
2. **Read the live values from prod, read-only** (amounts, minimums, days, caps) — not from code
   defaults. Note the source and the date.
3. Write two lists into `<work>/script.md`: **claims we make** (each with its source) and
   **claims we deliberately avoid** (true-sounding things that are false — e.g. "share your code"
   when there is no visible code, "unlimited" when there is a cap, "free" when it's a coupon with
   a minimum).

## Step 2 — Script → GATE 1

Write it as a table in `<work>/script.md`: # · Arabic · Hebrew · what's on screen.

- **8–13 lines, ~35–45 s per language.** Line 1–2 intro (Shadi full frame, waves), the steps
  (Shadi small, pointing at the phone), one outro call to action (full frame).
- **One line = one screen + one highlighted item.** If a line needs two things highlighted,
  split it.
- Arabic: Palestinian colloquial, voice C (short, tight) — see `references/shadi.md` §Voice for
  the words Shadi says and the ones he never says. **The courier word is المرسل** for Shadi.
- Hebrew: plural imperative (היכנסו, לחצו), plain spoken Hebrew; השליח stays.
- In the **voice text**, numbers are words (عشرين شيكل / עשרים שקל); in the **captions**, digits
  with ₪ (20₪). Caption keyword in `<b>…</b>` (lime highlight) — one per line.
- Title pill (top) and end card (reward line + fine print) per language; the fine print carries
  the conditions from Step 1.

**GATE 1:** show the table + the avoided claims. Wait for "approve" (or edits).

## Step 3 — Real screens

Capture the real app on the iOS simulator with `/shoofi-testing:local-app-e2e` (local stack,
seeded data — never a real customer's account). One PNG per screen the script names, saved as
`<work>/screens/<lang>/<NN-name>.png`, in **both** app languages. Full procedure and traps
(push banners on a sim, VFR recordings, hiding test data): `references/screens.md`.

Then measure the callout region of every highlighted item, `[x, y, w, h]` in screenshot pixels
(open the PNG, read the box). Wrong regions are the most common visual bug — check each one
on a crop before moving on.

## Step 4 — Voice → GATE 2

One full take per language with Artlist voiceover — **voice "Explore", model Eleven v4, Arabic
(or Hebrew), stability 50%, no effect, plain text with no tone tags**. Full settings,
pronunciation fixes and the whisper check: `references/shadi.md` §Voice.

1. Quote the cost, get the person's yes, generate, download to `<work>/voice-<lang>.mp3`.
2. Transcribe locally with whisper.cpp and diff against the script. A word that comes back
   wrong is a word to respell (e.g. «عشره» with ه, not «عشرة») — regenerate only then.

**GATE 2:** the person listens to both. Pronunciation complaints are fixed by respelling, never
by switching to speech-to-speech (rejected 2026-10-31: it loses the Explore sound).

## Step 5 — Timing → `reel.json`

```bash
SK=<this skill's folder>            # e.g. ${CLAUDE_PLUGIN_ROOT}/skills/guided-reel
cp $SK/examples/invite-friend/reel.json <work>/reel.json      # then rewrite it for the feature
python3 -I $SK/scripts/reel.py pauses <work> ar               # silences = where rows may cut
```

- Each script line becomes a **row** `{t:[start,end], kind, screen, callout, caption}`; cut rows
  at the pause midpoints `pauses` prints. Last row `t:[x, null]` (= end of voice).
- Group rows into **segments** (Shadi clips) of ≤ 15 s each: segment 1 = the intro rows (pose
  `stand`), then the step rows split into 2–3 segments (pose `point`), last = the outro (pose
  `stand`). Every switch between full-frame and pointing rows **must** be a segment edge.
- Format reference: `references/reel-json.md`.

```bash
python3 -I $SK/scripts/reel.py check <work>          # must print ok
python3 -I $SK/scripts/reel.py reel <work> ar        # DRAFT: still poses, real voice + screens
```

Show the draft reels now — layout, regions and timing problems are free to fix here and paid
for after Step 6.

## Step 6 — Lip-sync clips → GATE 3

```bash
python3 -I $SK/scripts/reel.py segments <work> ar    # build/seg-ar-N.mp3, short ones padded to 4 s
```

For each segment: Artlist **Wan 2.7 image-to-video, 720p, 9:16**, image = the pose PNG
(`assets/shadi/stand.png` or `point.png`, blue screen), audio = the segment mp3, duration = the
segment length rounded up to a whole second (min 4 s). Prompts and upload rules:
`references/shadi.md` §Lip-sync. **Upload the pose and every mp3 as assets first** — a previous
generation's id is refused as a video input.

**GATE 3:** batch every clip of both languages into one quote (~200 credits per second of
clip at 720p — the invite reel was 10 clips, 16,200 credits) and wait for the yes. Download to
`<work>/clips/<lang>-<n>.mp4` (the names `reel.json` points at). A failed clip costs nothing;
re-quote only the failed ones.

## Step 7 — Build, QA → GATE 4

```bash
python3 -I $SK/scripts/reel.py reel <work> ar && python3 -I $SK/scripts/reel.py qa <work> ar
python3 -I $SK/scripts/reel.py reel <work> he && python3 -I $SK/scripts/reel.py qa <work> he
```

Before showing anyone:
- `reel` must not say DRAFT (a missing clip falls back to a still pose and says which).
- **Look at the frame strip** (`build/strip-<lang>.jpg`): Shadi keyed clean (no blue fringe),
  callouts not covering his face, captions inside the frame, Arabic/Hebrew reading right-to-left.
- **Frame jumps** printed by `qa` stay ≲ 10 outside the intro→steps hand-over. A jump of 30+ is
  a flash — see `references/reel-json.md` §Flicker.
- Transcribe the final reel's audio once more and compare with the approved script.

**GATE 4:** hand over `<work>/reel-ar.mp4` and `<work>/reel-he.mp4` with: what's in them, what's
a placeholder, credits spent. Posting is a human's job — the admin's **פרסום ידני** on
`/admin/social-publications` uploads a ready video (a Facebook video + an Instagram Reel).

## Definition of done
1. Every claim in the script traced to the domain agent / prod read in Step 1; the avoided
   claims written down.
2. Script, voice and clip credits each approved by a person at their gate.
3. Both reels built from real screens, no DRAFT segments, QA clean, strip looked at.
4. `<work>/` holds script.md, reel.json, voices, clips, reels — enough to rebuild or edit later.
5. Nothing was published.
6. Anything new learned (a pronunciation, a trap) is added to `references/` in this skill.
