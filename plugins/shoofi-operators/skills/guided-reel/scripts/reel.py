#!/usr/bin/env python3
"""Build a guided reel (1080x1920): Shadi explains a feature over real app screenshots.

Everything about one reel lives in a project folder with a reel.json (see
../references/reel-json.md and ../examples/invite-friend/reel.json):

    <project>/reel.json
    <project>/screens/<lang>/<screen>.png     real simulator screenshots
    <project>/<voice file per language>       the approved voiceover
    <project>/clips/<lang>-<n>.mp4            Shadi lip-sync clips, one per segment (blue screen)

Shadi is a blue-screen track (720x1280): full frame for intro/outro rows, smaller and
pointing at the phone for phone/card rows. Headless Chrome renders every graphic
(captions, phone with the screenshot, the cut-out callout of the important item,
backgrounds) as PNGs; ffmpeg keys Shadi and animates the layers.

    python3 -I reel.py check    <project>              validate reel.json + files
    python3 -I reel.py pauses   <project> <lang>       silences in the voice (where rows/segments may cut)
    python3 -I reel.py segments <project> <lang>       cut the voice per segment, padded to >= 4 s for Wan
    python3 -I reel.py track    <project> <lang>       Shadi track; still poses wherever a clip is missing
    python3 -I reel.py reel     <project> <lang>       track + reel -> <project>/reel-<lang>.mp4
    python3 -I reel.py qa       <project> <lang>       biggest frame jumps + a frame strip
"""
import argparse
import html
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
POSES = SKILL / "assets" / "shadi"
SHOOFI_APP = Path(os.environ.get("SHOOFI_APP", Path.home() / "Documents/project/shoofi/shoofi-app"))
FONT = SHOOFI_APP / "assets/fonts/middleeast/MiddleEast-Regular.ttf"
LOGO = SHOOFI_APP / "assets/icon.png"
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

W, H, FPS = 1080, 1920, 30
BG, LIME, DARK = "#F9F8F5", "#8AEA5F", "#17320F"
HOLD = 2.6                      # seconds of end card after the voice
XF = 0.25                       # crossfade between layers that replace each other
KEY = "colorkey=0x0000FF:0.34:0.10,despill=type=blue"
MIN_CLIP = 4.0                  # Wan fails on shorter audio; pad the segment to this

SCREEN_W, BEZEL = 480, 14
PHONE_W = SCREEN_W + 2 * BEZEL
PHONE_X, PHONE_Y = W - PHONE_W - 36, 330
CARD_X, CARD_Y, CARD_W = 420, 360, 624
CALLOUT_W = 840
CALLOUT_TARGET = (640, 975)     # where Shadi's finger points
SHADI_SMALL = dict(x=-110, y=729, w=670, h=1191)

FULL, STEPS = ("intro", "outro"), ("phone", "card")


# ---------- the spec ----------

class Spec:
    def __init__(self, project):
        self.dir = Path(project).resolve()
        self.raw = json.loads((self.dir / "reel.json").read_text(encoding="utf-8"))
        self.shot_w, self.shot_h = self.raw.get("shotSize", [1206, 2622])
        self.phone_s = SCREEN_W / self.shot_w

    def lang(self, lang):
        if lang not in self.raw["langs"]:
            raise SystemExit(f"reel.json has no language {lang!r}")
        return self.raw["langs"][lang]

    def voice(self, lang):
        return self.dir / self.lang(lang)["voice"]

    def text(self, lang):
        return self.raw["text"][lang]

    def region(self, lang, r):
        """A callout region: inline [x, y, w, h], a name in "regions", or a per-language dict."""
        if r is None:
            return None
        if isinstance(r, str):
            if r not in self.raw.get("regions", {}):
                raise SystemExit(f"unknown region {r!r}")
            r = self.raw["regions"][r]
        if isinstance(r, dict):
            r = r[lang]
        return tuple(r)

    def rows(self, lang, vdur):
        """(a, b, kind, screen, region, caption, crop) with b = None resolved to the voice end."""
        out = []
        for row in self.lang(lang)["rows"]:
            a, b = row["t"]
            out.append((a, vdur if b is None else b, row["kind"], row.get("screen"),
                        self.region(lang, row.get("callout")), row.get("caption"), row.get("crop")))
        return out

    def segments(self, lang, vdur):
        """[(start, end, pose, clip path or None)] — consecutive, the last one ends with the voice."""
        segs, start = [], 0.0
        for s in self.lang(lang)["segments"]:
            end = vdur if s.get("until") is None else s["until"]
            clip = self.dir / s["clip"] if s.get("clip") else None
            segs.append((start, end, s["pose"], clip if clip and clip.exists() else None))
            start = end
        return segs

    def shot(self, lang, screen):
        return self.dir / "screens" / lang / f"{screen}.png"


def probe_duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         check=True, capture_output=True, text=True).stdout
    return float(out.strip())


def check(spec):
    problems = []
    for need in (FONT, LOGO, Path(CHROME)):
        if not need.exists():
            problems.append(f"missing {need}")
    for lang in spec.raw["langs"]:
        voice = spec.voice(lang)
        if not voice.exists():
            problems.append(f"{lang}: voice {voice.name} missing")
            continue
        vdur = probe_duration(voice)
        rows = spec.rows(lang, vdur)
        prev = 0.0
        for a, b, k, s, r, c, crop in rows:
            if abs(a - prev) > 1e-6:
                problems.append(f"{lang}: row at {a} does not start where the previous ended ({prev})")
            if b <= a:
                problems.append(f"{lang}: row at {a} has no length")
            if k not in FULL + STEPS:
                problems.append(f"{lang}: row at {a} has unknown kind {k!r}")
            if k in STEPS and not spec.shot(lang, s).exists():
                problems.append(f"{lang}: screen {s} missing")
            if k == "card" and not crop:
                problems.append(f"{lang}: card row at {a} needs a crop [y0, y1]")
            if not c:
                problems.append(f"{lang}: row at {a} has no caption")
            prev = b
        if abs(prev - vdur) > 1e-6:
            problems.append(f"{lang}: rows end at {prev}, the voice at {vdur:.2f} (give the last row t1 = null)")
        segs = spec.segments(lang, vdur)
        cuts = {round(e, 3) for _, e, *_ in segs}
        for (a, _, k, *_), (_, pb, pk, *_) in zip(rows[1:], rows):
            if (k in FULL) != (pk in FULL) and round(a, 3) not in cuts:
                problems.append(f"{lang}: Shadi switches full/pointing at {a} but no segment ends there")
        for a, b, pose, clip in segs:
            if pose not in ("stand", "point"):
                problems.append(f"{lang}: segment at {a} has unknown pose {pose!r}")
            if b - a > 15:
                problems.append(f"{lang}: segment {a}-{b} is over 15 s (Wan's limit)")
    return problems


# ---------- audio helpers ----------

def pauses(voice, min_len=0.18):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(voice), "-af", f"silencedetect=n=-35dB:d={min_len}",
                        "-f", "null", "-"], capture_output=True, text=True)
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    return list(zip(starts, ends))


def cut_segments(spec, lang):
    voice = spec.voice(lang)
    vdur = probe_duration(voice)
    out_dir = spec.dir / "build"
    out_dir.mkdir(exist_ok=True)
    outs = []
    for i, (a, b, pose, _) in enumerate(spec.segments(lang, vdur), 1):
        out = out_dir / f"seg-{lang}-{i}.mp3"
        pad = max(MIN_CLIP - (b - a), 0)
        af = f"apad=pad_dur={pad:.3f}" if pad else "anull"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(voice),
                        "-af", af, "-c:a", "libmp3lame", "-q:a", "2", str(out)], check=True)
        outs.append((out, pose, b - a, pad))
    return outs


# ---------- Chrome graphics ----------

CSS = f"""
@font-face {{ font-family: ME; src: url('{FONT.as_uri()}'); }}
html, body {{ margin: 0; background: transparent; overflow: hidden; }}
* {{ box-sizing: border-box; }}
body {{ font-family: ME, 'Arial Hebrew', 'Geeza Pro', sans-serif; direction: rtl; color: {DARK}; }}
.cap {{ position: absolute; left: 56px; right: 56px; background: #fff; border-radius: 36px;
        padding: 26px 40px; font-size: 54px; line-height: 1.38; text-align: center;
        box-shadow: 0 14px 40px rgba(23,50,15,.16); }}
b {{ font-weight: normal; background: {LIME}; border-radius: 14px; padding: 0 12px; white-space: nowrap; }}
.pill {{ position: absolute; top: 110px; left: 50%; transform: translateX(-50%); white-space: nowrap;
         display: flex; align-items: center; gap: 22px; background: {DARK}; color: #fff;
         border-radius: 60px; padding: 14px 40px 14px 18px; font-size: 48px; }}
.pill img {{ width: 78px; height: 78px; border-radius: 20px; }}
.phone {{ position: absolute; left: 30px; top: 30px; background: #111; border-radius: 58px; padding: {BEZEL}px;
          box-shadow: 0 26px 50px rgba(23,50,15,.30); }}
.phone .scr {{ border-radius: 44px; overflow: hidden; width: {SCREEN_W}px; }}
.phone img {{ display: block; width: 100%; }}
.hl {{ position: absolute; border: 6px solid {LIME}; border-radius: 20px; box-shadow: 0 0 0 3px {DARK}; }}
.card {{ position: absolute; left: 30px; top: 30px; border-radius: 40px; overflow: hidden; background: #fff;
         box-shadow: 0 26px 50px rgba(23,50,15,.25); }}
.co {{ position: absolute; left: 40px; top: 40px; border-radius: 28px; overflow: hidden; background: #fff;
       border: 8px solid {LIME}; box-shadow: 0 0 0 5px {DARK}, 0 30px 60px rgba(23,50,15,.40); }}
.end {{ position: absolute; left: 56px; right: 56px; bottom: 300px; background: {DARK}; color: #fff;
        border-radius: 40px; padding: 36px 44px; text-align: center; }}
.end .r {{ font-size: 64px; margin-bottom: 18px; }}
.end .r b {{ color: {DARK}; }}
.end .f {{ font-size: 32px; line-height: 1.5; opacity: .9; }}
"""


def page(body, w=W, h=H, bg="transparent"):
    return (f'<!doctype html><meta charset="utf-8"><style>{CSS} html,body{{width:{w}px;height:{h}px;'
            f'background:{bg}}}</style><body>{body}</body>')


def chrome_png(html_text, out_png, size=(W, H)):
    src = out_png.with_suffix(".html")
    src.write_text(html_text, encoding="utf-8")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--allow-file-access-from-files", "--default-background-color=00000000",
                    "--force-device-scale-factor=1", "--virtual-time-budget=2000",
                    f"--window-size={size[0]},{size[1]}", f"--screenshot={out_png}", src.as_uri()],
                   check=True, capture_output=True)


def esc_caption(text):
    """Escape a caption but keep its <b> keyword tags."""
    return html.escape(text).replace("&lt;b&gt;", "<b>").replace("&lt;/b&gt;", "</b>")


def bg_png(work, kind):
    """Opaque backgrounds: a big lime glow behind full-frame Shadi, a smaller one behind him on the left."""
    if kind == "full":
        glow = f"radial-gradient(circle at 50% 50%, {LIME}88 0, {LIME}55 330px, transparent 560px)"
    else:
        glow = f"radial-gradient(circle at 26% 76%, {LIME}88 0, {LIME}44 260px, transparent 470px)"
    dots = "radial-gradient(rgba(23,50,15,.07) 2px, transparent 2.5px) 0 0/34px 34px"
    out = work / f"bg-{kind}.png"
    chrome_png(page("", bg=f"{glow}, {dots}, {BG}"), out)
    return out


def phone_png(spec, work, lang, screen, hl, name):
    """Phone frame with the real screenshot; 30px margin around it for the shadow."""
    ring = ""
    if hl:
        x, y, w, h = (round(v * spec.phone_s) for v in hl)
        ring = f'<div class="hl" style="left:{x + BEZEL - 6}px;top:{y + BEZEL - 6}px;width:{w + 12}px;height:{h + 12}px"></div>'
    ph = round(SCREEN_W * spec.shot_h / spec.shot_w) + 2 * BEZEL
    size = (PHONE_W + 60, ph + 70)
    out = work / f"{name}.png"
    chrome_png(page(f'<div class="phone"><div class="scr"><img src="{spec.shot(lang, screen).as_uri()}"></div>{ring}</div>',
                    *size), out, size)
    return out, size


def card_png(spec, work, lang, screen, crop, name):
    """A crop of the screenshot as a floating card (used when the phone would show test data around it)."""
    y0, y1 = crop
    s = CARD_W / spec.shot_w
    ch = round((y1 - y0) * s)
    size = (CARD_W + 60, ch + 70)
    out = work / f"{name}.png"
    chrome_png(page(f'<div class="card" style="width:{CARD_W}px;height:{ch}px">'
                    f'<img src="{spec.shot(lang, screen).as_uri()}" style="width:{CARD_W}px;margin-top:{-round(y0 * s)}px"></div>',
                    *size), out, size)
    return out, size


def callout_png(spec, work, lang, screen, reg, name):
    x, y, w, h = reg
    s = CALLOUT_W / w
    ch = round(h * s)
    size = (CALLOUT_W + 96, ch + 120)
    out = work / f"{name}.png"
    chrome_png(page(f'<div class="co" style="width:{CALLOUT_W + 16}px;height:{ch + 16}px">'
                    f'<img src="{spec.shot(lang, screen).as_uri()}" style="display:block;width:{round(spec.shot_w * s)}px;'
                    f'margin-left:{-round(x * s)}px;margin-top:{-round(y * s)}px"></div>', *size), out, size)
    return out, s


def caption_png(spec, work, lang, kind, caption, name, end_card=False):
    t = spec.text(lang)
    parts = []
    if kind in FULL:
        parts.append(f'<div class="pill"><img src="{LOGO.as_uri()}"><span>{html.escape(t["title"])}</span></div>')
        if end_card:
            parts.append(f'<div class="end"><div class="r">{esc_caption(t["endCard"]["big"])}</div>'
                         f'<div class="f">{html.escape(t["endCard"]["fine"])}</div></div>')
        else:
            parts.append(f'<div class="cap" style="bottom:400px">{esc_caption(caption)}</div>')
    else:
        parts.append(f'<div class="cap" style="top:96px">{esc_caption(caption)}</div>')
    out = work / f"{name}.png"
    chrome_png(page("".join(parts)), out)
    return out


def ease_back(t0, d):
    """easeOutBack 0→1 (with ~10% overshoot) between t0 and t0+d, as an ffmpeg expression of t."""
    u = f"clip((t-{t0:.3f})/{d},0,1)"
    return f"(1+2.70158*pow({u}-1,3)+1.70158*pow({u}-1,2))"


# ---------- Shadi track ----------

def build_track(spec, lang, out):
    """Concatenate one blue-screen piece per segment (720x1280) to the exact voice timing."""
    vdur = probe_duration(spec.voice(lang))
    segs = spec.segments(lang, vdur)
    args = ["ffmpeg", "-loglevel", "error", "-y"]
    for a, b, pose, clip in segs:
        if clip:
            args += ["-i", str(clip)]
        else:
            args += ["-loop", "1", "-framerate", str(FPS), "-t", f"{b - a:.3f}", "-i", str(POSES / f"{pose}.png")]
    f = []
    for i, (a, b, *_) in enumerate(segs):
        # a clip a little shorter than its segment holds its last frame instead of cutting the track short
        f.append(f"[{i}:v]scale=720:1280,fps={FPS},setsar=1,tpad=stop_mode=clone:stop_duration=2,"
                 f"trim=duration={b - a:.3f},setpts=PTS-STARTPTS[s{i}]")
    f.append("".join(f"[s{i}]" for i in range(len(segs))) + f"concat=n={len(segs)}:v=1:a=0[v]")
    args += ["-filter_complex", ";".join(f), "-map", "[v]", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(out)]
    subprocess.run(args, check=True)
    missing = [i + 1 for i, s in enumerate(segs) if not s[3]]
    return out, missing


# ---------- reel ----------

def merge_windows(rows, kinds):
    """Contiguous time windows where the row kind is in `kinds`."""
    wins = []
    for a, b, k, *_ in rows:
        if k in kinds:
            if wins and abs(wins[-1][1] - a) < 1e-6:
                wins[-1][1] = b
            else:
                wins.append([a, b])
    return wins


def build_reel(spec, lang, track, out):
    work = spec.dir / "build" / f"work-{lang}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    voice = spec.voice(lang)
    vdur = probe_duration(voice)
    total = round(vdur + HOLD, 2)
    rows = spec.rows(lang, vdur)
    rows.append((vdur, total + 0.5, "outro", None, None, None, None))   # end card (runs past -t so the last frame is never empty)
    full_win = merge_windows(rows, FULL)
    step_win = merge_windows(rows, STEPS)

    inputs, f = [], []

    def add_png(png, a, b):
        inputs.extend(["-loop", "1", "-framerate", str(FPS), "-t", f"{b - a:.3f}", "-i", str(png)])
        return len(inputs) // 8 - 1 + 2          # +2: track and voice come first

    def win(a, b):                               # half-open, so two layers never share a frame by accident
        return f"gte(t,{a:.3f})*lt(t,{b:.3f})"

    # Every layer that is replaced by another one stays XF longer and the newcomer fades in over it.
    def fade_in_out(a, b, fade_in, fade_out):
        d = b - a
        fx = []
        if fade_in:
            fx.append(f"fade=in:st=0:d={XF}:alpha=1")
        if fade_out:
            fx.append(f"fade=out:st={d - XF:.3f}:d={XF}:alpha=1")
        return ("," + ",".join(fx)) if fx else ""

    last = "base"

    def over(src, x, y, a, b, tag):
        nonlocal last
        f.append(f"[{last}][{src}]overlay=x='{x}':y='{y}':enable='{win(a, b)}':eof_action=pass[{tag}]")
        last = tag

    f.append(f"color=c={BG.replace('#', '0x')}:s={W}x{H}:r={FPS}:d={total}[base]")

    # ---- backgrounds + Shadi, one segment per window, crossfading at the intro/steps/outro joins ----
    segs = sorted([(a, b, "full") for a, b in full_win] + [(a, b, "steps") for a, b in step_win])
    bgs = {k: bg_png(work, k) for k in ("full", "steps")}
    f.append(f"[0:v]fps={FPS},tpad=stop_mode=clone:stop_duration={HOLD + 5},{KEY},format=rgba,split={len(segs)}"
             + "".join(f"[tr{i}]" for i in range(len(segs))))
    for i, (a, b, kind) in enumerate(segs):
        first, has_next = i == 0, i < len(segs) - 1
        end = b + XF if has_next else b
        idx = add_png(bgs[kind], a, end)
        f.append(f"[{idx}:v]format=rgba{fade_in_out(a, end, not first, False)},setpts=PTS-STARTPTS+{a:.3f}/TB[bg{i}]")
        over(f"bg{i}", 0, 0, a, end, f"vb{i}")
    for i, (a, b, kind) in enumerate(segs):
        first, has_next = i == 0, i < len(segs) - 1
        end = b + XF if has_next else b
        size = f"{W}:{H}" if kind == "full" else f"{SHADI_SMALL['w']}:{SHADI_SMALL['h']}"
        xy = (0, 0) if kind == "full" else (SHADI_SMALL["x"], SHADI_SMALL["y"])
        hold = f",tpad=stop_mode=clone:stop_duration={XF}" if has_next else ""   # fade out on its own last frame
        f.append(f"[tr{i}]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS{hold},scale={size}"
                 f"{fade_in_out(a, end, not first, has_next)},setpts=PTS+{a:.3f}/TB[sh{i}]")
        over(f"sh{i}", *xy, a, end, f"vs{i}")

    # ---- phone / card: pop in once when it arrives, then only the screen content crossfades ----
    groups = []
    for a, b, k, s, r, c, crop in rows:
        if k in STEPS:
            g = groups[-1] if groups else None
            if g and g["screen"] == s and g["kind"] == k and g["crop"] == crop and abs(g["b"] - a) < 1e-6:
                g["b"] = b
            else:
                groups.append(dict(kind=k, screen=s, a=a, b=b, hl=r, crop=crop))
    for gi, g in enumerate(groups):
        prev = groups[gi - 1] if gi else None
        nxt = groups[gi + 1] if gi + 1 < len(groups) else None
        g["swap_in"] = bool(prev and prev["kind"] == g["kind"] == "phone" and abs(prev["b"] - g["a"]) < 1e-6)
        g["swap_out"] = bool(nxt and nxt["kind"] == g["kind"] == "phone" and abs(nxt["a"] - g["b"]) < 1e-6)
    for gi, g in enumerate(groups):
        if g["kind"] == "phone":
            png, (pw, ph) = phone_png(spec, work, lang, g["screen"], g["hl"], f"phone{gi:02d}")
            pos = (PHONE_X - 30, PHONE_Y - 30)
        else:
            png, (pw, ph) = card_png(spec, work, lang, g["screen"], g["crop"], f"card{gi:02d}")
            pos = (CARD_X - 30, CARD_Y - 30)
        a, b = g["a"], g["b"] + XF                        # every device lingers XF: under the next screen, or fading out
        idx = add_png(png, a, b)
        cx, cy = pos[0] + pw / 2, pos[1] + ph / 2
        out_fx = "" if g["swap_out"] else f",fade=out:st={b - a - XF:.3f}:d={XF}:alpha=1"
        if g["swap_in"]:                                  # same phone, new screen: plain crossfade
            f.append(f"[{idx}:v]format=rgba,fade=in:st=0:d={XF}:alpha=1{out_fx},setpts=PTS-STARTPTS+{a:.3f}/TB[dv{gi}]")
            over(f"dv{gi}", pos[0], pos[1], a, b, f"vd{gi}")
        else:                                             # arrives: short pop, then holds still
            sc = f"(0.86+0.14*{ease_back(a, 0.42)})"
            f.append(f"[{idx}:v]format=rgba,fade=in:st=0:d=0.18:alpha=1{out_fx},setpts=PTS-STARTPTS+{a:.3f}/TB,"
                     f"scale=w='trunc(iw*{sc}/2)*2':h='trunc(ih*{sc}/2)*2':eval=frame[dv{gi}]")
            over(f"dv{gi}", f"{cx:.1f}-overlay_w/2", f"{cy:.1f}-overlay_h/2", a, b, f"vd{gi}")

    # ---- callouts: fly out of the phone, settle, fade out just before the next line ----
    tx, ty = CALLOUT_TARGET
    for i, (a, b, k, s, reg, c, crop) in enumerate(rows):
        if k not in STEPS or not reg:
            continue
        png, cs = callout_png(spec, work, lang, s, reg, f"co{i:02d}")
        x, y, w, h = reg
        if k == "phone":
            ps = spec.phone_s
            sx, sy = PHONE_X + BEZEL + (x + w / 2) * ps, PHONE_Y + BEZEL + (y + h / 2) * ps
        else:
            ps = CARD_W / spec.shot_w
            sx, sy = CARD_X + (x + w / 2) * ps, CARD_Y + (y - crop[0] + h / 2) * ps
        t0, r0 = a + 0.45, ps / cs
        idx = add_png(png, t0, b)
        e = ease_back(t0, 0.5)
        sc = f"(({r0:.4f})+(1-{r0:.4f})*{e})"
        cx = f"({sx:.1f}+({tx}-{sx:.1f})*{e})"
        cy = f"({sy:.1f}+({ty}-{sy:.1f})*{e})"
        f.append(f"[{idx}:v]format=rgba,fade=out:st={max(b - t0 - 0.18, 0):.3f}:d=0.18:alpha=1,"
                 f"setpts=PTS-STARTPTS+{t0:.3f}/TB,"
                 f"scale=w='max(2,trunc(iw*{sc}/2)*2)':h='max(2,trunc(ih*{sc}/2)*2)':eval=frame[cv{i}]")
        over(f"cv{i}", f"{cx}-overlay_w/2", f"{cy}-overlay_h/2", t0, b, f"vc{i}")

    # ---- captions: the old one stays until the new one has faded in on top of it ----
    for i, (a, b, k, s, r, c, crop) in enumerate(rows):
        png = caption_png(spec, work, lang, k, c or "", f"cap{i:02d}", end_card=c is None)
        end = b + XF if i < len(rows) - 1 else b
        idx = add_png(png, a, end)
        f.append(f"[{idx}:v]format=rgba{fade_in_out(a, end, i > 0, False)},setpts=PTS-STARTPTS+{a:.3f}/TB[cp{i}]")
        over(f"cp{i}", 0, 0, a, end, f"vp{i}")
    f.append(f"[{last}]format=yuv420p[vout]")

    # ---- audio: voice + soft pop on every caption change ----
    pops = [a for a, *_ in rows[1:]]
    f.append(f"sine=f=1250:d=0.07,afade=t=out:st=0.02:d=0.05,volume=0.10,asplit={len(pops)}"
             + "".join(f"[p{i}]" for i in range(len(pops))))
    for i, a in enumerate(pops):
        f.append(f"[p{i}]adelay={int(a * 1000)}|{int(a * 1000)}[pd{i}]")
    f.append(f"[1:a]aresample=48000,apad=whole_dur={total}[vo]")
    f.append("[vo]" + "".join(f"[pd{i}]" for i in range(len(pops)))
             + f"amix=inputs={1 + len(pops)}:normalize=0:duration=first,loudnorm=I=-14:TP=-1.5[aout]")

    args = ["ffmpeg", "-loglevel", "error", "-y", "-i", str(track), "-i", str(voice)] + inputs
    args += ["-filter_complex", ";".join(f), "-map", "[vout]", "-map", "[aout]",
             "-t", str(total), "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "18",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    subprocess.run(args, check=True)
    return out


# ---------- QA ----------

def qa(spec, lang):
    reel = spec.dir / f"reel-{lang}.mp4"
    work = spec.dir / "build"
    log = work / f"ydif-{lang}.log"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(reel), "-vf",
                    f"signalstats,metadata=print:key=lavfi.signalstats.YDIF:file={log}", "-f", "null", "-"], check=True)
    jumps, t = [], None
    for line in log.read_text().splitlines():
        m = re.search(r"pts_time:([\d.]+)", line)
        if m:
            t = float(m.group(1))
        m = re.search(r"YDIF=([\d.]+(?:e[-+]?\d+)?)", line)
        if m and t is not None:
            jumps.append((float(m.group(1)), t))
    jumps.sort(reverse=True)
    dur = probe_duration(reel)
    frames = work / f"strip-{lang}"
    shutil.rmtree(frames, ignore_errors=True)
    frames.mkdir()
    for i in range(12):
        ts = 0.5 + i * (dur - 1) / 11
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{ts:.2f}", "-i", str(reel), "-frames:v", "1",
                        "-vf", "scale=270:480", str(frames / f"f{i:02d}.png")], check=True)
    strip = work / f"strip-{lang}.jpg"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(frames / "f%02d.png"), "-vf", "tile=6x2:padding=4",
                    "-frames:v", "1", str(strip)], check=True)
    return jumps[:6], strip


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["check", "pauses", "segments", "track", "reel", "qa"])
    ap.add_argument("project", type=Path)
    ap.add_argument("lang", nargs="?")
    a = ap.parse_args()
    spec = Spec(a.project)
    if a.what == "check":
        problems = check(spec)
        print("\n".join(problems) if problems else "ok")
        raise SystemExit(1 if problems else 0)
    if not a.lang:
        raise SystemExit(f"{a.what} needs a language")
    if a.what == "pauses":
        for s, e in pauses(spec.voice(a.lang)):
            print(f"{s:7.2f} - {e:7.2f}   cut at {(s + e) / 2:.2f}")
    elif a.what == "segments":
        for out, pose, length, pad in cut_segments(spec, a.lang):
            print(f"{out}  pose={pose}  {length:.2f}s" + (f"  (+{pad:.2f}s silence for Wan)" if pad else ""))
    elif a.what == "track":
        out, missing = build_track(spec, a.lang, spec.dir / "build" / f"track-{a.lang}.mp4")
        print(out, f"(still pose for segments {missing})" if missing else "")
    elif a.what == "reel":
        (spec.dir / "build").mkdir(exist_ok=True)
        track, missing = build_track(spec, a.lang, spec.dir / "build" / f"track-{a.lang}.mp4")
        out = build_reel(spec, a.lang, track, spec.dir / f"reel-{a.lang}.mp4")
        print(out, f"(DRAFT: still pose for segments {missing})" if missing else "")
    else:
        jumps, strip = qa(spec, a.lang)
        print("biggest frame jumps (YDIF, time):", "; ".join(f"{j:.1f}@{t:.2f}s" for j, t in jumps))
        print("frame strip:", strip)


if __name__ == "__main__":
    main()
