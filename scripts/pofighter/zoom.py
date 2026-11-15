"""Blow up a few frames so a limb can be judged (PoFighter, offline tool).

Usage: python -I zoom.py <out.jpg> <idx> [<idx> ...]

Reads the 480-wide review frames, crops the middle of each, scales it 3x (LANCZOS) and tiles
them three to a row with the frame number and time on each.
"""
import pathlib
import sys

from PIL import Image, ImageDraw

SRC = pathlib.Path("artifacts/pofighter-p2/review")
OUT = pathlib.Path("artifacts/pofighter-p2/zoom")
COLS, BOX, SCALE = 3, (60, 0, 330, 270), 2


def main() -> None:
    out = pathlib.Path(sys.argv[1])
    idxs = [int(a) for a in sys.argv[2:]]
    OUT.mkdir(parents=True, exist_ok=True)
    tw, th = (BOX[2] - BOX[0]) * SCALE, (BOX[3] - BOX[1]) * SCALE
    rows = (len(idxs) + COLS - 1) // COLS
    sheet = Image.new("RGB", (COLS * tw, rows * th), (16, 16, 16))
    d = ImageDraw.Draw(sheet)
    for i, idx in enumerate(idxs):
        im = Image.open(SRC / f"s{idx + 1:04d}.jpg").crop(BOX)
        im = im.resize((tw, th), Image.LANCZOS)
        x, y = (i % COLS) * tw, (i // COLS) * th
        sheet.paste(im, (x, y))
        d.text((x + 6, y + 6), f"{idx} {idx / 30:.2f}s", fill=(255, 255, 0))
    sheet.save(out, quality=82, optimize=True)
    print(out, sheet.size, out.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
