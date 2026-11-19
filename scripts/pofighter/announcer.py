"""Builds PoFighter's match announcer: a cut-out head-and-shoulders picture plus the jaw geometry
the canvas uses to move the mouth (wwwroot/js/pofighter/announcer.js).

    python scripts/pofighter/announcer.py <face.png>

Writes wwwroot/data/pofighter/announcer.webp (background removed with rembg, as cutout.py does
for the fighters) and announcer.json. The jaw points are measured by hand on the 450x449 source
(FACE_Alan.png) and scaled with the picture, so a different face needs new numbers here:
  mouth  the line between the lips (centre x, y) and the mouth's half width
  jaw    the polygon below that line that drops when he speaks (chin and lower cheeks)
  drop   how far the jaw opens at most, in source pixels
"""
import json
import pathlib
import sys

from PIL import Image
from rembg import new_session, remove

OUT = pathlib.Path(__file__).resolve().parents[2] / 'src/PoMiniGames.Client/wwwroot/data/pofighter'
SOURCE_W = 450
MOUTH = {'x': 236, 'y': 201, 'half': 21}
JAW = [(186, 201), (286, 201), (282, 226), (270, 244), (238, 252), (206, 244), (192, 226)]
DROP = 9


def main(path: str) -> None:
    src = Image.open(path).convert('RGBA')
    cut = remove(src, session=new_session('isnet-general-use'))
    k = cut.width / SOURCE_W
    cut.save(OUT / 'announcer.webp', 'WEBP', quality=88, method=6)
    meta = {
        'width': cut.width,
        'height': cut.height,
        'mouth': {key: round(v * k, 1) for key, v in MOUTH.items()},
        'jaw': [[round(x * k, 1), round(y * k, 1)] for x, y in JAW],
        'drop': round(DROP * k, 1),
    }
    (OUT / 'announcer.json').write_text(json.dumps(meta, indent=2) + '\n', encoding='utf-8')
    print(f'announcer.webp {cut.width}x{cut.height}, announcer.json written')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: announcer.py <face.png>')
    main(sys.argv[1])
