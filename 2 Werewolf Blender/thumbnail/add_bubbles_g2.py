"""Thumbnails A and B's texts (Game 2, owner 2026-10-23), drawn onto Game 2/bases/B_vs_base.png:
A -> Game 2/A_vs.png: the plain picture (names were tried and dropped: the logos say who they are)
B -> Game 2/B_vs_hunter.png: the names, and an "I'M THE HUNTER" speech bubble above each (in the game both claimed
the Hunter; only one was telling the truth).

    python thumbnail/add_bubbles_g2.py

Classic comic bubbles: white, a thick black outline, a tail pointing down to the speaker's head; black Impact text
big enough to read at 320 px wide (the YouTube home feed). Sizes and places are in BUBBLES.
"""
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "Game 2", "bases", "B_vs_base.png")
OUT = os.path.join(HERE, "Game 2", "B_vs_hunter.png")
OUT_A = os.path.join(HERE, "Game 2", "A_vs.png")
# who they are, above their heads: (text, centre x, centre y, size, tilt) in Game 1's style (add_questions.label)
NAMES = []  # owner (2026-10-23): no names after all: the logos already say who they are
NAMES_B = [(t, x, 156, s, r) for t, x, _, s, r in NAMES]  # under the bubbles
IMPACT = "C:/Windows/Fonts/impact.ttf"
TEXT = "I'M THE HUNTER"
# (bubble centre, the point of its tail = just above the speaker's head)
BUBBLES = [((262, 74), (352, 152)),   # Fable, left (the tail to the top of his hood)
           ((1018, 74), (928, 152))]  # Sol, right
SIZE, PAD, EDGE = 58, 26, 7
S = 3  # drawn at 3x and scaled down: smooth edges


def names(img, items):
    from add_questions import label  # Game 1's white tilted labels
    for text, x, y, size, tilt in items:
        lab = label(text, size, tilt)
        img.alpha_composite(lab, (int(x - lab.width / 2), int(y - lab.height / 2)))
    return img


def main():
    a = names(Image.open(SRC).convert("RGBA"), NAMES)
    a.convert("RGB").save(OUT_A)
    print("[texts] ->", OUT_A)
    img = names(Image.open(SRC).convert("RGBA"), NAMES_B)
    W, H = img.size
    layer = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    f = ImageFont.truetype(IMPACT, SIZE * S)
    tw = d.textlength(TEXT, font=f)
    th = SIZE * S
    for (cx, cy), (tx, ty) in BUBBLES:
        cx, cy, tx, ty = cx * S, cy * S, tx * S, ty * S
        bw, bh = tw + 2 * PAD * S, th + 1.4 * PAD * S
        box = (cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2)
        base_l, base_r = cx + (tx - cx) * 0.35 - 22 * S, cx + (tx - cx) * 0.35 + 22 * S
        tail = [(base_l, box[3] - EDGE * S), (base_r, box[3] - EDGE * S), (tx, ty)]
        # the outline first (bubble and tail grown by EDGE), then the white over it: one clean shape
        d.rounded_rectangle([box[0] - EDGE * S, box[1] - EDGE * S, box[2] + EDGE * S, box[3] + EDGE * S], radius=bh / 2 + EDGE * S, fill=(0, 0, 0, 255))
        d.polygon([(base_l - EDGE * S * 1.4, tail[0][1]), (base_r + EDGE * S * 1.4, tail[1][1]), (tx, ty + EDGE * S * 1.6)], fill=(0, 0, 0, 255))
        d.rounded_rectangle(box, radius=bh / 2, fill=(255, 255, 255, 255))
        d.polygon(tail, fill=(255, 255, 255, 255))
        d.text((cx, cy + 2 * S), TEXT, font=f, fill=(12, 10, 12, 255), anchor="mm")
    layer = layer.resize((W, H), Image.LANCZOS)
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))  # a soft drop shadow so the bubbles sit above the scene
    a = layer.split()[3].point(lambda v: v * 0.55)
    shadow.putalpha(a)
    from PIL import ImageFilter
    shadow = shadow.filter(ImageFilter.GaussianBlur(6))
    out = Image.alpha_composite(img, Image.new("RGBA", (W, H), (0, 0, 0, 0)))
    out.alpha_composite(shadow, (5, 7))
    out = Image.alpha_composite(out, layer)
    out.convert("RGB").save(OUT)
    print("[bubbles] ->", OUT)


if __name__ == "__main__":
    main()
