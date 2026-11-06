#!/usr/bin/env python3
"""
The reel's soundtrack, from its parts — music (on by default), food/impact sounds, and the voice
(only when the reel has one). Writes one AAC track, -14 LUFS, that render.mjs muxes as `audio`.

  python3 -I mix.py out.m4a --duration 11.4 \\
      --music music.mp3 --music-start 86.9 \\
      --voice voice.mp3 --cut 0:3.1@0.4 --cut 3.2:6.25@5.2 --cut 6.35:@8.55 \\
      --sound sizzle.aac@0:0.45:2.2 --sound impact.aac@3.0:0.8

--cut FROM:TO@AT places the voice from FROM to TO (TO empty = the end) at AT seconds — cut a take
at its pauses (silencedetect) and put each phrase on its scene. --sound FILE@AT:VOLUME[:LENGTH].
The music ducks under the voice (sidechain) and fades in and out.
"""
import argparse
import subprocess


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--music")
    ap.add_argument("--music-start", type=float, default=0.0)
    ap.add_argument("--music-volume", type=float, default=0.5)
    ap.add_argument("--voice")
    ap.add_argument("--cut", action="append", default=[])
    ap.add_argument("--sound", action="append", default=[])
    a = ap.parse_args()
    D = a.duration

    ins, f, mix = [], [], []

    def add(path):
        ins.extend(["-i", path])
        return len(ins) // 2 - 1

    if a.voice and a.cut:
        parts = []
        for n, c in enumerate(a.cut):
            span, at = c.split("@")
            t0, t1 = span.split(":")
            i = add(a.voice)
            trim = f"atrim=start={t0}" + (f":end={t1}" if t1 else "")
            ms = int(float(at) * 1000)
            f.append(f"[{i}:a]{trim},asetpts=PTS-STARTPTS,adelay={ms}|{ms},apad[v{n}]")
            parts.append(f"[v{n}]")
        f.append(f"{''.join(parts)}amix=inputs={len(parts)}:normalize=0:duration=longest,atrim=0:{D},volume=1.6,asplit=2[voice][key]")
        mix.append("[voice]")
    if a.music:
        i = add(a.music)
        f.append(f"[{i}:a]atrim=start={a.music_start}:duration={D},asetpts=PTS-STARTPTS,afade=t=in:d=0.3,"
                 f"afade=t=out:st={max(D - 1.0, 0)}:d=1.0,volume={a.music_volume}[m0]")
        if "[voice]" in mix:
            f.append("[m0][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[m]")
        else:
            f.append("[m0]anull[m]")
        mix.append("[m]")
    elif "[voice]" in mix:
        f.append("[key]anullsink")
    for n, s in enumerate(a.sound):
        path, rest = s.rsplit("@", 1)
        bits = rest.split(":")
        at, vol = float(bits[0]), float(bits[1])
        i = add(path)
        ln = f"atrim=0:{bits[2]},asetpts=PTS-STARTPTS,afade=t=out:st={max(float(bits[2]) - 0.6, 0)}:d=0.6," if len(bits) > 2 else ""
        ms = int(at * 1000)
        f.append(f"[{i}:a]{ln}adelay={ms}|{ms},volume={vol},apad[s{n}]")
        mix.append(f"[s{n}]")
    if not mix:
        raise SystemExit("nothing to mix: no music, voice or sound")
    f.append(f"{''.join(mix)}amix=inputs={len(mix)}:normalize=0:duration=longest,atrim=0:{D},"
             f"alimiter=limit=0.95,loudnorm=I=-14:TP=-1.5:LRA=11[o]")
    subprocess.run(["ffmpeg", "-v", "error", "-y", *ins, "-filter_complex", ";".join(f),
                    "-map", "[o]", "-c:a", "aac", "-b:a", "192k", a.out], check=True)


if __name__ == "__main__":
    main()
