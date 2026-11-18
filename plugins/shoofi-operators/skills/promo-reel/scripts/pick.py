"""
Pick the look of the next promo reel so no two posts look alike.

    python3 -I pick.py <history.json> --store <appName> --subject deal|dish|store|coupon
                       [--dish-type burger|pizza|...] [--styles closeup,rush,...] [--write]

Every choice — style, theme, opening motion, end card, music, food sound, opening line — is
the option used least recently FOR THIS STORE, and never one of the last two reels overall;
ties go to a stable hash of store + date, so a rerun on the same day picks the same. Prints the
choice as JSON (merge it into the spec); --write appends it to the history.

`--styles` = the styles the owner approved (marketingTemplates channel "reel"); the default
is all six, filtered by what fits the subject.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path

FITS = {
    "closeup": {"dish", "store", "deal"},
    "rush": {"store", "deal"},
    "number": {"deal", "coupon"},
    "table": {"store", "deal"},
    "inapp": {"coupon", "store", "deal"},
    "shadi": {"store", "dish", "deal", "coupon"},
}
THEMES = ["green", "lime", "dark", "beige"]
END_CARDS = ["drop", "spin", "stamp"]
OPENING = ["question", "number", "new"]
# Catalog tracks (search_music, instrumental), by mood; each entry is a song and the start of its hook.
MUSIC = [
    {"title": "Let's Go!", "artist": "Max Jackson", "mood": "upbeat", "start": 86.9},
    {"title": "WALKTHETALK", "artist": "Out of Flux", "mood": "groove", "start": 0.0},
    {"title": "Crosswalk Bounce", "artist": "Isaac DaBom", "mood": "hip-hop", "start": 123.1},
    {"title": "A Pretty Good Day", "artist": "Isaac DaBom", "mood": "warm", "start": 134.3},
    {"title": "Out of My Head", "artist": "Letra", "mood": "funky", "start": 50.2},
]
SOUNDS = ["sizzle", "pour", "crunch", "whoosh"]
# The AI opening motion that fits the dish (references/motion.md has each prompt); "still" = the
# photo with the free effects only (split for a stacked dish, a slow push-in otherwise).
MOTIONS = {
    "burger": ["ai-split", "free-split", "ai-steam", "still"],
    "pizza": ["ai-cheese-pull", "ai-steam", "still"],
    "shawarma": ["ai-slice", "ai-steam", "still"],
    "salad": ["ai-toss", "still"],
    "drink": ["ai-pour", "ai-condensation", "still"],
    "dessert": ["ai-drizzle", "still"],
    "fries": ["ai-tumble", "still"],
    "other": ["ai-steam", "still"],
}


def least_recent(options, history, key, store, seed):
    """The option this store used longest ago (never = first), avoiding the last two reels overall."""
    recent = {h.get(key) for h in history[-2:]}
    pool = [o for o in options if o not in recent] or list(options)
    mine = [h for h in history if h.get("store") == store]

    def last_used(o):
        idx = [i for i, h in enumerate(mine) if h.get(key) == o]
        return idx[-1] if idx else -1

    def tie(o):
        return hashlib.sha256(f"{seed}|{key}|{o}".encode()).hexdigest()

    return sorted(pool, key=lambda o: (last_used(o), tie(o)))[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("history")
    ap.add_argument("--store", required=True)
    ap.add_argument("--subject", required=True, choices=["deal", "dish", "store", "coupon"])
    ap.add_argument("--dish-type", default="other")
    ap.add_argument("--styles", default=",".join(FITS))
    # The owner's defaults (2026-11-07): plain is the default — no voice, no Shadi; the soundtrack
    # is on unless switched off. Each is asked for per reel.
    ap.add_argument("--voice", action="store_true", help="add a voice-over (Artlist credits)")
    ap.add_argument("--shadi", action="store_true", help="allow Shadi (the shadi style, lip-sync credits)")
    ap.add_argument("--no-music", action="store_true", help="no soundtrack")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()

    path = Path(a.history)
    history = json.loads(path.read_text()) if path.exists() else []
    seed = f"{a.store}|{datetime.date.today().isoformat()}"
    styles = [s for s in a.styles.split(",") if a.subject in FITS.get(s, set()) and (a.shadi or s != "shadi")]
    if not styles:
        raise SystemExit(f"no approved style fits a {a.subject}")
    pick = {
        "date": datetime.date.today().isoformat(),
        "store": a.store,
        "subject": a.subject,
        "style": least_recent(styles, history, "style", a.store, seed),
        "theme": least_recent(THEMES, history, "theme", a.store, seed),
        "endCard": least_recent(END_CARDS, history, "endCard", a.store, seed),
        "opening": least_recent(OPENING, history, "opening", a.store, seed),
        "motion": least_recent(MOTIONS.get(a.dish_type, MOTIONS["other"]), history, "motion", a.store, seed),
        "sound": least_recent(SOUNDS, history, "sound", a.store, seed),
        "music": None if a.no_music else least_recent([m["title"] for m in MUSIC], history, "music", a.store, seed),
        "voice": a.voice,
        "shadi": a.shadi,
    }
    print(json.dumps(pick, ensure_ascii=False, indent=1))
    if a.write:
        history.append(pick)
        path.write_text(json.dumps(history, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
