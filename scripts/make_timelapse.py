#!/usr/bin/env python3
"""Turn a folder of timelapse JPGs into a fast GIF (or MP4).

Frames are ordered by the timestamp embedded in the filename
(YYYY-MM-DD_HH-MM-SS), falling back to file mtime -- so negative day
numbers (day -2, -1, 0 ...) don't scramble the order the way a plain
name-sort would.

Usage (on the PC):
    python scripts/make_timelapse.py "C:/path/to/folder"
    python scripts/make_timelapse.py "C:/path/to/folder" --fps 20 --width 900
    python scripts/make_timelapse.py "C:/path/to/folder" --match "drugA" --out drugA.gif
    python scripts/make_timelapse.py "C:/path/to/folder" --format mp4   # needs ffmpeg

Options:
    --out      output file (default: <folder>/timelapse.<gif|mp4>)
    --fps      playback frames per second (default 15)
    --width    downscale to this width in px, keep aspect (0 = original; default 1000)
    --step     use every Nth frame to keep it snappy (default 1 = all frames)
    --match    only include files whose name contains this text (pick one experiment)
    --format   gif (default, needs Pillow) or mp4 (needs ffmpeg on PATH)
"""
import argparse
import glob
import os
import re
import subprocess
import sys

TS = re.compile(r"(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})")


def sort_key(path):
    m = TS.search(os.path.basename(path))
    if m:
        return (0, "".join(m.groups()))
    return (1, f"{os.path.getmtime(path):020.6f}")


def collect(folder, match):
    files = []
    for ext in ("*.jpg", "*.jpeg", "*.png"):
        files += glob.glob(os.path.join(folder, ext))
        files += glob.glob(os.path.join(folder, ext.upper()))
    files = list(dict.fromkeys(files))  # dedupe (case-insensitive FS)
    if match:
        files = [f for f in files if match.lower() in os.path.basename(f).lower()]
    files.sort(key=sort_key)
    return files


def make_gif(files, out, fps, width):
    try:
        from PIL import Image
    except ImportError:
        sys.exit("GIF needs Pillow:  pip install pillow")
    dur = max(1, round(1000 / fps))
    frames = []
    for f in files:
        im = Image.open(f).convert("RGB")
        if width and im.width > width:
            h = round(im.height * width / im.width)
            im = im.resize((width, h), Image.LANCZOS)
        frames.append(im)
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=dur,
        loop=0,
        optimize=True,
        disposal=2,
    )


def make_mp4(files, out, fps, width):
    # concat demuxer handles spaces in names + our custom (timestamp) order
    listfile = out + ".txt"
    with open(listfile, "w", encoding="utf-8") as fh:
        for f in files:
            fh.write(f"file '{os.path.abspath(f)}'\n")
            fh.write(f"duration {1.0 / fps:.4f}\n")
        fh.write(f"file '{os.path.abspath(files[-1])}'\n")  # last frame needs a repeat
    vf = f"scale={width}:-2" if width else "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    cmd = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listfile,
        "-vf", vf, "-r", str(fps), "-pix_fmt", "yuv420p", out,
    ]
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        sys.exit("mp4 needs ffmpeg on PATH (https://ffmpeg.org). Or use --format gif.")
    finally:
        if os.path.exists(listfile):
            os.remove(listfile)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--out")
    ap.add_argument("--fps", type=int, default=15)
    ap.add_argument("--width", type=int, default=1000)
    ap.add_argument("--step", type=int, default=1)
    ap.add_argument("--match")
    ap.add_argument("--format", choices=["gif", "mp4"], default="gif")
    a = ap.parse_args()

    files = collect(a.folder, a.match)
    if a.step > 1:
        files = files[:: a.step]
    if not files:
        sys.exit("No images found (check folder / --match).")
    out = a.out or os.path.join(a.folder, f"timelapse.{a.format}")

    note = f", width {a.width}px" if a.width else ", original size"
    note += f", every {a.step}th frame" if a.step > 1 else ""
    print(f"{len(files)} frames -> {out}  @ {a.fps} fps{note}")

    if a.format == "gif":
        if len(files) > 600:
            print("  note: 600+ frames makes a heavy GIF; try --step 2 or --format mp4")
        make_gif(files, out, a.fps, a.width)
    else:
        make_mp4(files, out, a.fps, a.width)

    print(f"done: {out}  ({os.path.getsize(out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
