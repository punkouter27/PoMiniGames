"""Cut the select-screen pictures from a packed fighter (PoFighter, offline tool).

Usage: python -I portrait.py <data_dir> <fighter_id> [...]

Reads <data_dir>/<id>.json and its sprite sheet and, from the first idle picture, writes:

  <id>-portrait.webp  head and shoulders (the top 42% of the body, square, centred on the head),
                      256x256, transparent: the roster grid's tile and the health bar's portrait.
  <id>-select.webp    the body from the waist up (the top 56%), at the sheet's own detail,
                      transparent: the large corner art on the select screen (PoFighterSelect).
"""
import json
import pathlib
import sys

import numpy as np
from PIL import Image

data_dir = pathlib.Path(sys.argv[1])
for fid in sys.argv[2:]:
    meta = json.loads((data_dir / f"{fid}.json").read_text())
    sheet = Image.open(data_dir / meta["sheet"]).convert("RGBA")
    f = meta["moves"]["idle"]["frames"][0]
    cell = sheet.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))
    side = int(cell.height * 0.42)
    a = np.array(cell)[..., 3]
    top_rows = a[: max(1, side // 3)] > 96          # the head: where the top third has pixels
    xs = np.nonzero(top_rows.any(axis=0))[0]
    cx = int(xs.mean()) if len(xs) else cell.width // 2
    x0 = min(max(0, cx - side // 2), max(0, cell.width - side))
    box = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    box.paste(cell.crop((x0, 0, x0 + side, side)), (0, 0))
    box.resize((256, 256), Image.LANCZOS).save(data_dir / f"{fid}-portrait.webp", quality=88, method=6)
    print(f"{fid}-portrait.webp")

    # The waist-up art: as wide as the body is there (raised fists included), a little air each side.
    tall = int(cell.height * 0.56)
    cols = np.nonzero((a[:tall] > 96).any(axis=0))[0]
    left, right = (int(cols[0]), int(cols[-1]) + 1) if len(cols) else (0, cell.width)
    pad = max(4, (right - left) // 12)
    art = Image.new("RGBA", (right - left + 2 * pad, tall + pad), (0, 0, 0, 0))
    art.paste(cell.crop((left, 0, right, tall)), (pad, pad))
    art.save(data_dir / f"{fid}-select.webp", quality=88, method=6)
    print(f"{fid}-select.webp {art.width}x{art.height}")
