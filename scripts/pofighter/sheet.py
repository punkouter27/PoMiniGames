"""Build a close-up contact sheet of a frame range (PoFighter, offline tool).

Usage: python -I sheet.py <from> <to> <step> [--x0 .22] [--x1 .72]

Writes artifacts/pofighter-p2/fine/<from>-<to>-<step>.jpg: the frames between <from> and
<to> (inclusive) sampled every <step>, each showing the middle columns of the 480-wide
review image, blown up so a limb's position can be judged.
"""
import argparse
import pathlib

from PIL import Image, ImageDraw

SRC = pathlib.Path("artifacts/pofighter-p2/review")
OUT = pathlib.Path("artifacts/pofighter-p2/fine")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("lo", type=int)
    ap.add_argument("hi", type=int)
    ap.add_argument("step", type=int)
    ap.add_argument("--x0", type=float, default=0.22)
    ap.add_argument("--x1", type=float, default=0.72)
    ap.add_argument("--cols", type=int, default=5)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    pick = list(range(args.lo, args.hi + 1, args.step))
    cols, tw, th = args.cols, 240, 300
    rows = (len(pick) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows * th), (16, 16, 16))
    d = ImageDraw.Draw(sheet)
    for i, idx in enumerate(pick):
        im = Image.open(SRC / f"s{idx + 1:04d}.jpg")
        w, h = im.size
        crop = im.crop((int(w * args.x0), 0, int(w * args.x1), h)).resize((tw, th), Image.LANCZOS)
        x, y = (i % cols) * tw, (i // cols) * th
        sheet.paste(crop, (x, y))
        d.text((x + 3, y + 3), f"{idx} {idx / 30:.2f}s", fill=(255, 255, 0))
    out = OUT / f"{args.lo}-{args.hi}-{args.step}.jpg"
    sheet.save(out, quality=76, optimize=True)
    print(out, sheet.size, out.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
