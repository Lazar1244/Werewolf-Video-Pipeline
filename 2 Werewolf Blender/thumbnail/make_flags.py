"""The two flags for Game 3's thumbnail (owner, 2026-10-28: China on the left, the USA on the right, barely visible),
drawn to their official construction sheets, so they are the real flags, not look-alikes:
    China  3:2, red #EE1C25, yellow #FFFF00 stars on a 30 x 20 grid: the big star at (5, 5), radius 3; four small ones,
           radius 1, at (10, 2) (12, 4) (12, 7) (10, 9), each with one point toward the big star's centre.
    USA    hoist 1, fly 1.9; 13 stripes (red #B22234, white); the blue #3C3B6E canton 0.76 x 7/13 with 50 stars,
           diameter 0.0616, in 9 rows (6 and 5) spaced 0.054 down and 0.063 across.
Output: thumbnail/flags/china.png and usa.png (make_thumbnails_g3.py maps them on its background flags).

    python thumbnail/make_flags.py
"""
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "flags")
SS = 4  # drawn 4x, then scaled down: smooth star edges


def star(d, cx, cy, r, toward=None, fill=(255, 255, 255)):
    """A five-pointed star centred at (cx, cy), outer radius r; one point up, or toward the point `toward`."""
    a0 = -math.pi / 2 if toward is None else math.atan2(toward[1] - cy, toward[0] - cx)
    ri = r * 0.381966  # the regular star's inner radius
    pts = []
    for k in range(10):
        a = a0 + k * math.pi / 5
        rr = r if k % 2 == 0 else ri
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d.polygon(pts, fill=fill)


def china(h=1000):
    w = h * 3 // 2
    c = h / 20 * SS  # one grid cell
    im = Image.new("RGB", (w * SS, h * SS), (0xEE, 0x1C, 0x25))
    d = ImageDraw.Draw(im)
    yellow = (0xFF, 0xFF, 0x00)
    star(d, 5 * c, 5 * c, 3 * c, fill=yellow)
    for x, y in ((10, 2), (12, 4), (12, 7), (10, 9)):
        star(d, x * c, y * c, 1 * c, toward=(5 * c, 5 * c), fill=yellow)
    return im.resize((w, h), Image.LANCZOS)


def usa(h=1000):
    w = int(h * 1.9)
    u = h * SS  # the hoist
    im = Image.new("RGB", (w * SS, h * SS), (255, 255, 255))
    d = ImageDraw.Draw(im)
    red, blue = (0xB2, 0x22, 0x34), (0x3C, 0x3B, 0x6E)
    for k in range(0, 13, 2):  # seven red stripes, top and bottom red
        d.rectangle([0, k * u / 13, w * SS, (k + 1) * u / 13], fill=red)
    d.rectangle([0, 0, 0.76 * u, 7 * u / 13], fill=blue)
    for row in range(1, 10):
        cols = range(1, 12, 2) if row % 2 else range(2, 11, 2)  # 6 stars on odd rows, 5 on even
        for col in cols:
            star(d, col * 0.063 * u, row * 0.054 * u, 0.0616 * u / 2)
    return im.resize((w, h), Image.LANCZOS)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    china().save(os.path.join(OUT, "china.png"))
    usa().save(os.path.join(OUT, "usa.png"))
    print("flags ->", OUT)
