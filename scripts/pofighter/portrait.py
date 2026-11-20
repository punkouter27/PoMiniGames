"""Cut a select-screen portrait from a packed fighter (PoFighter, offline tool).

Usage: python -I portrait.py <data_dir> <fighter_id> [...]

Reads <data_dir>/<id>.json and its sprite sheet, takes the first idle picture's head and
shoulders (the top 42% of the body, square, centred on the head) and writes
<data_dir>/<id>-portrait.webp (256x256, transparent). The 4x4 roster grid shows it.
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
