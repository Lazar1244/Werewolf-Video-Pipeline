"""The Short thumbnail's small white texts (owner, 2026-10-20): the same texts as the full video's main thumbnail
(5_questions), placed for the vertical frame. Borrows add_questions.py's drawing (label, arrow); changes nothing there.

    python thumbnail/add_short_questions.py

Reads <GAME>/bases/short_1_base.png (make_short_thumbnail.py), writes <GAME>/short_1.png, and from the same clean base
<GAME>/short_3.png (Short 3, 2026-10-21): the full video's A/B test favoured the clean WEREWOLF thumbnail, so Short 3's
has one line only, the Short's premise.
"""
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from add_questions import OUT, arrow, label  # noqa: E402

# (text, centre x, centre y, size px, tilt degrees: + is counter-clockwise); a bigger size than 16:9: a Short card is small
TEXTS = [
    ("WHO'S LYING?", 290, 515, 70, 8),       # under the title, left
    ("CAN AI LIE?", 800, 535, 70, -8),       # right: the "AI" hook
    ("CLAUDE FABLE", 280, 670, 58, 5),       # above Fable (back row, left)
    ("GPT ASTRA", 800, 670, 58, -5),         # above Astra (back row, right)
    ("WHO KILLED HIM?", 640, 1830, 66, 3),   # under the body, an arrow up to its X eyes
]
ARROW = ((420, 1815), (330, 1800), (352, 1745))  # start, bend, tip: from the question round to the body's X eyes


LAYOUTS = {  # out name -> (texts, arrow or None), all on bases/short_1_base.png
    "short_1": (TEXTS, ARROW),
    "short_3": ([("6 AIs. 2 SECRET WOLVES.", 540, 575, 84, -3)], None),  # one line, in the band under the title
}


def main():
    for name, (texts, arr) in LAYOUTS.items():
        img = Image.open(os.path.join(OUT, "bases", "short_1_base.png")).convert("RGBA")
        for text, x, y, size, tilt in texts:
            q = label(text, size, tilt)
            img.alpha_composite(q, (x - q.width // 2, y - q.height // 2))
        if arr:
            arrow(img, arr)
        path = os.path.join(OUT, f"{name}.png")
        img.convert("RGB").save(path)
        print(f"[thumb] {path}")


if __name__ == "__main__":
    main()
