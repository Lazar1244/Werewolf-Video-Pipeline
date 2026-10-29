"""Game 2's Short thumbnail text (owner, 2026-10-24): one line, the Short's premise, in the band under the title, as on
Game 1's Short 3 (add_short_questions.py: the clean design won the full video's A/B test). Borrows add_questions.py's
label; changes nothing there.

    python thumbnail/add_short_text_g2.py

Reads Game 2/bases/short_1_base.png (make_short_thumbnail_g2.py), writes Game 2/short_1.png.
"""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from add_questions import label  # noqa: E402

OUT = os.path.join(HERE, "Game 2")
TEXTS = [("7 AIs. 2 ARE LYING.", 540, 600, 88, -3)]  # (text, centre x, centre y, size px, tilt: + is counter-clockwise)


def main():
    img = Image.open(os.path.join(OUT, "bases", "short_1_base.png")).convert("RGBA")
    for text, x, y, size, tilt in TEXTS:
        q = label(text, size, tilt)
        img.alpha_composite(q, (x - q.width // 2, y - q.height // 2))
    path = os.path.join(OUT, "short_1.png")
    img.convert("RGB").save(path)
    print(f"[thumb] {path}")


if __name__ == "__main__":
    main()
