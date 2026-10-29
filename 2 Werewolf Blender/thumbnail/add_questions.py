"""The small white texts (owner, 2026-10-19): tilted questions and model names in the free spots around the cast.

    python thumbnail/add_questions.py

For each layout below: reads <GAME>/bases/<name>_base.png (rendered by make_thumbnails.py) and writes <GAME>/<name>.png.
Each text: white Impact with a black outline and a soft dark shadow, so it reads on the red at any size.
SPOILER CHECK per game: no text may give away who the wolves are by accident (see HOW_IT_WAS_MADE.txt).
"""
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "Game 1")
FONT = "C:/Windows/Fonts/impact.ttf"

NAMES = [  # the owner's pick: the best-known models, above their figures
    ("CLAUDE FABLE", 392, 272, 40, 5),     # above Fable (seat 2)
    ("GPT ASTRA", 886, 272, 40, -5),       # above Astra (seat 5)
]
KILL = [("WHO KILLED HIM?", 300, 660, 44, 5)]  # bottom left, an arrow to the body
ARROW = ((468, 668), (520, 678), (562, 646))  # a smooth curve (start, bend, tip) from WHO KILLED HIM? to the body's X eyes

# name -> texts: (text, centre x, centre y, size px, tilt degrees: + is counter-clockwise), and whether it gets the arrow
LAYOUTS = {
    "5_questions": ([("WHO'S LYING?", 135, 250, 46, 8),    # left, beside the title, above the first hood
                     ("CAN AI LIE?", 1148, 250, 46, -8)]   # right: the "AI" hook
                    + NAMES + KILL, True),
    "3_two_are_lying": ([("WHICH TWO?", 125, 262, 42, 8),     # left (WHO'S LYING? would repeat the title)
                         ("CAN AI LIE?", 1155, 262, 42, -8)]  # right
                        + [(t, x, 266, 38, r) for t, x, _, _, r in NAMES] + KILL, True),  # names just above the wolf eyes
    "2_whos_the_wolf": ([("TRUST NO ONE", 135, 262, 42, 8),   # under the wide title, left
                         ("CAN AI LIE?", 1148, 262, 42, -8)]  # right
                        + NAMES + KILL, True),
}


def label(text, size, tilt):
    font = ImageFont.truetype(FONT, size)
    pad = size
    l, t, r, b = font.getbbox(text, stroke_width=4)
    w, h = r - l + pad * 2, b - t + pad * 2
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).text((pad - l + 3, pad - t + 4), text, font=font, fill=(0, 0, 0, 200), stroke_width=6, stroke_fill=(0, 0, 0, 200))
    layer = Image.alpha_composite(layer, shadow.filter(ImageFilter.GaussianBlur(size / 8)))
    ImageDraw.Draw(layer).text((pad - l, pad - t), text, font=font, fill=(255, 255, 255, 255), stroke_width=max(2, size // 12),
                               stroke_fill=(10, 0, 0, 255))
    return layer.rotate(tilt, resample=Image.BICUBIC, expand=True)


def arrow(img, ctrl):
    """A smooth curved white arrow with a black edge: a quadratic curve through the bend, a solid head at the tip."""
    import math
    (x0, y0), (x1, y1), (x2, y2) = ctrl
    pts = [((1 - t) ** 2 * x0 + 2 * (1 - t) * t * x1 + t * t * x2, (1 - t) ** 2 * y0 + 2 * (1 - t) * t * y1 + t * t * y2)
           for t in (k / 24 for k in range(25))]
    a = math.atan2(y2 - pts[-3][1], x2 - pts[-3][0])
    tip = (x2 + 8 * math.cos(a), y2 + 8 * math.sin(a))
    head = [tip, (x2 - 20 * math.cos(a - 0.62), y2 - 20 * math.sin(a - 0.62)), (x2 - 20 * math.cos(a + 0.62), y2 - 20 * math.sin(a + 0.62))]
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).line([(x + 3, y + 4) for x, y in pts[:-2]], fill=(0, 0, 0, 170), width=13, joint="curve")
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(4)))
    d = ImageDraw.Draw(img)
    d.line(pts[:-2], fill=(10, 0, 0, 255), width=15, joint="curve")
    d.polygon(head, fill=(10, 0, 0, 255), outline=(10, 0, 0, 255), width=7)
    d.line(pts[:-2], fill=(255, 255, 255, 255), width=9, joint="curve")
    d.polygon(head, fill=(255, 255, 255, 255))


def main():
    for name, (texts, with_arrow) in LAYOUTS.items():
        img = Image.open(os.path.join(OUT, "bases", f"{name}_base.png")).convert("RGBA")
        for text, x, y, size, tilt in texts:
            q = label(text, size, tilt)
            img.alpha_composite(q, (x - q.width // 2, y - q.height // 2))
        if with_arrow:
            arrow(img, ARROW)
        path = os.path.join(OUT, f"{name}.png")
        img.convert("RGB").save(path)
        print(f"[thumb] {path}")


if __name__ == "__main__":
    main()
