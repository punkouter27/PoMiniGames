"""Draw the packed fighter the way the game will (PoFighter, offline tool).

Usage: python -I preview.py <fighter.json> <sheet.webp> <out.jpg> [max frames per move]

One row per move. Each picture is placed exactly as index.js places it - the anchor on the
ground line - so a wrong anchor or a stray blob shows up here before the game is opened. A
move with more pictures than the maximum is sampled evenly, so its first, middle and last
pictures are always shown.
"""
import json
import pathlib
import sys

from PIL import Image, ImageDraw

ROW, GROUND, LEFT, PAD = 440, 380, 190, 6


def main() -> None:
    meta = json.loads(pathlib.Path(sys.argv[1]).read_text())
    sheet = Image.open(sys.argv[2]).convert("RGBA")
    out = pathlib.Path(sys.argv[3])
    limit = int(sys.argv[4]) if len(sys.argv) > 4 else 8
    moves = list(meta["moves"].items())

    picked = []
    for name, mv in moves:
        n = len(mv["frames"])
        if n > limit:
            idx = sorted({round(i * (n - 1) / (limit - 1)) for i in range(limit)})
        else:
            idx = list(range(n))
        picked.append((name, mv, idx))

    width = LEFT + max(sum(mv["frames"][i]["w"] + PAD for i in idx) + PAD for _, mv, idx in picked)
    img = Image.new("RGB", (width, ROW * len(picked)), (28, 34, 52))
    d = ImageDraw.Draw(img)

    for r, (name, mv, idx) in enumerate(picked):
        top = r * ROW
        d.rectangle([0, top, width, top + ROW], fill=(36, 42, 64) if r % 2 else (30, 36, 56))
        d.line([(LEFT, top + GROUND), (width, top + GROUND)], fill=(200, 120, 80), width=2)
        d.text((8, top + 8), name, fill=(255, 210, 90))
        info = f"{len(mv['frames']):d} frames, {mv['fps']:.1f} fps, {mv['loop']}"
        if "speed" in mv:
            info += f", speed {mv['speed']}"
        if "hitMin" in mv:
            info += f", hitMin {mv['hitMin']}"
        d.text((8, top + 26), info, fill=(150, 160, 180))
        x = LEFT
        for i in idx:
            f = mv["frames"][i]
            cell = sheet.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))
            img.paste(cell, (x - int(f["ax"]), top + GROUND - int(f["ay"])), cell)
            d.line([(x, top + GROUND - 5), (x, top + GROUND + 5)], fill=(255, 210, 90))
            d.text((x - 2, top + GROUND + 8), str(f["src"]), fill=(130, 140, 160))
            x += f["w"] + PAD
    img.save(out, quality=80, optimize=True)
    print(out, img.size, out.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
