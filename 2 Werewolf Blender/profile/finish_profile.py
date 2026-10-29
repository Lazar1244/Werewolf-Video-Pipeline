"""The profile picture's backgrounds (owner, 2026-10-20): each brain render (make_profile.py) laid on a red hue.

    python profile/finish_profile.py

    halo  near-black, a soft red glow behind the brain and a thin red light round its outline
    disc  a solid red disc behind the brain (the reference's idea, in the channel's red), dark outside it
Writes out/<n>_<look>_<bg>.png at 800x800 (YouTube's size; it shows them in a circle) and out/preview_round.png, every
version cropped round, side by side, large and at the small sizes YouTube shows them.
"""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
S = 1600
RED = np.array([0.86, 0.06, 0.05])


def radial(c=(0.5, 0.47)):
    yy, xx = np.mgrid[0:S, 0:S] / S
    return np.sqrt((xx - c[0]) ** 2 + (yy - c[1]) ** 2)


def background(kind):
    r = radial()
    if kind == "halo":
        glow = np.clip(1 - r / 0.5, 0, 1) ** 1.6
        base = np.array([0.035, 0.008, 0.012])
        return base + (RED * 0.85 - base) * glow[..., None]
    inside = np.clip((0.43 - r) * S / 3, 0, 1)  # an anti-aliased disc
    shade = 1 - 0.25 * np.clip(r / 0.43, 0, 1) ** 2  # a touch darker toward its rim
    disc = RED[None, None, :] * shade[..., None]
    dark = np.array([0.03, 0.006, 0.01])
    return dark + (disc - dark) * inside[..., None]


def compose(look, bg):
    brain = np.asarray(Image.open(os.path.join(OUT, f"brain_{look}.png")).convert("RGBA")).astype(np.float32) / 255
    a = brain[..., 3:]
    img = background(bg)
    if bg == "halo":  # a thin red light round the brain's outline
        sil = Image.fromarray((a[..., 0] * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(17)).filter(ImageFilter.GaussianBlur(14))
        rim = np.asarray(sil).astype(np.float32)[..., None] / 255 * 0.9
        img = img + (RED * 1.15 - img) * rim
    img = img * (1 - a) + brain[..., :3] * a
    out = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).resize((800, 800), Image.LANCZOS)
    return out


def round_crop(im, size):
    im = im.resize((size, size), Image.LANCZOS)
    m = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(m).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(im, (0, 0), m.resize((size, size), Image.LANCZOS))
    return out


if __name__ == "__main__":
    combos = [("natural", "halo"), ("natural", "disc"), ("glow", "halo"), ("glow", "disc")]
    prev = Image.new("RGB", (len(combos) * 420, 560), (245, 245, 245))
    for n, (look, bg) in enumerate(combos, 1):
        im = compose(look, bg)
        im.save(os.path.join(OUT, f"{n}_{look}_{bg}.png"))
        x = (n - 1) * 420 + 10
        prev.paste(round_crop(im, 400), (x, 10), round_crop(im, 400))
        prev.paste(round_crop(im, 98), (x + 40, 430), round_crop(im, 98))
        prev.paste(round_crop(im, 40), (x + 180, 460), round_crop(im, 40))
        prev.paste(round_crop(im, 24), (x + 260, 470), round_crop(im, 24))
        print(f"[profile] {n}_{look}_{bg}")
    prev.save(os.path.join(OUT, "preview_round.png"))
