"""Thumbnail 3's word (Game 3, owner 2026-10-28: "literally like the photo", the drama creators' style), drawn onto
Game 3/bases/3_liar_base.png -> Game 3/3_liar.png: a red mist painted in behind DeepSeek (owner's example: a bank
of red smoke across the lower middle, a soft ragged top, dark above and at the very bottom, "just a bit less"), then
one huge white word, LIAR, on the right, with a red brush-stroke underline. The mist goes only where the figure is
not (bases/3_liar_base_alpha.png, the same frame rendered with a transparent background). The word is the game's own story: DeepSeek, a werewolf, said "I'm just a Villager",
then "I am the Hunter". No spoiler: the video's intro reveals the two Chinese AIs as the wolves.

    python thumbnail/add_liar_g3.py
"""
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "Game 3", "bases", "3_liar_base.png")
MASK = os.path.join(HERE, "Game 3", "bases", "3_liar_base_alpha.png")
MIST_RGB = (170, 38, 44)  # the example's smoky red
MIST_PEAK = 0.78         # its strongest cover (the example is close to solid: owner, "a bit less")
OUT = os.path.join(HERE, "Game 3", "3_liar.png")
FONT = "C:/Windows/Fonts/ARIALNB.TTF"  # the WEREWOLF title's font, so the channel's thumbnails match
WORD = "LIAR"
BOX = (600, 1250)    # the word's left and right edges (px): it fills the right side
BASELINE = 470       # the word's baseline (px)
RED = (225, 22, 30)
S = 3                # drawn at 3x, scaled down: smooth edges


def underline(d, x0, x1, y, h):
    """A red brush stroke: thick in the middle, tapering to both ends, its edges a little rough."""
    rng = random.Random(3)
    top, bot = [], []
    n = 60
    for k in range(n + 1):
        t = k / n
        x = x0 + (x1 - x0) * t
        w = h * (0.35 + 0.65 * math.sin(math.pi * min(1.0, t * 1.15)) ** 0.6)  # the right end trails off longer
        dy = (t - 0.5) * h * 0.35  # a slight rise to the right, like a quick swipe
        top.append((x, y - dy - w / 2 + rng.uniform(-0.06, 0.06) * h))
        bot.append((x, y - dy + w / 2 + rng.uniform(-0.06, 0.06) * h))
    d.polygon(top + bot[::-1], fill=RED + (255,))


def fbm(w, h, seed, octaves=6, first=3):
    """Cloudy noise in 0..1: random grids at doubling sizes, each smoothly enlarged to w x h and summed."""
    import numpy as np
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    for k in range(octaves):
        cells = first * 2 ** k
        g = rng.random((max(2, cells * h // w), cells)).astype(np.float32)
        layer = np.asarray(Image.fromarray((g * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) / 255
        out += amp * layer
        total += amp
        amp *= 0.55
    out /= total
    return (out - out.min()) / (out.max() - out.min())


def mist(img):
    """The red smoke bank, laid over the black background only (the figure's mask keeps it behind DeepSeek)."""
    import numpy as np
    W, H = img.size
    yy = np.linspace(0.0, 1.0, H, dtype=np.float32)[:, None]
    edge = fbm(W, 8, 11, octaves=4)[4][None, :]                     # one row of noise: the bank's height along x
    puff = fbm(W, H, 17, octaves=6, first=5)                        # rounded puffs, mid sized
    puff = np.clip((puff - 0.25) / 0.55, 0.0, 1.0)
    top = 0.40 + (edge - 0.5) * 0.28                                # the bank rises and dips across the frame
    cover = np.clip((yy - top + (puff - 0.5) * 0.22) / 0.22, 0.0, 1.0)  # the puffs push the edge up and down: billows
    cover *= np.clip((0.97 - yy) / 0.12, 0.0, 1.0)                 # a dark strip at the very bottom
    cover *= 0.5 + 0.5 * puff                                       # lighter puffs, darker gaps inside
    cover = np.asarray(Image.fromarray((np.clip(cover, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(5)), np.float32) / 255
    a = cover * MIST_PEAK * (1.0 - np.asarray(Image.open(MASK).convert("RGBA"), np.float32)[..., 3] / 255)
    base = np.asarray(img.convert("RGB"), np.float32)
    base = base * (1 - a[..., None]) + np.array(MIST_RGB, np.float32) * a[..., None]
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)).convert("RGBA")


def main():
    img = mist(Image.open(SRC).convert("RGBA"))
    W, H = img.size
    layer = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    size = 100
    while True:  # the largest size whose ink fits the box
        f = ImageFont.truetype(FONT, size * S)
        l, t, r, b = d.textbbox((0, 0), WORD, font=f, anchor="ls")
        if (r - l) / S > BOX[1] - BOX[0]:
            size -= 4
            f = ImageFont.truetype(FONT, size * S)
            break
        size += 4
    l, t, r, b = d.textbbox((0, 0), WORD, font=f, anchor="ls")
    x = (BOX[0] + BOX[1]) / 2 * S - (l + r) / 2
    d.text((x, BASELINE * S), WORD, font=f, fill=(255, 255, 255, 255), anchor="ls")
    underline(d, (BOX[0] + 10) * S, (BOX[1] - 10) * S, (BASELINE + 42) * S, 22 * S)
    layer = layer.resize((W, H), Image.LANCZOS)
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    shadow.putalpha(layer.split()[3].point(lambda v: v * 0.6))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(8)), (4, 6))
    img = Image.alpha_composite(img, layer)
    img.convert("RGB").save(OUT)
    print("[liar] ->", OUT, "size", size)


if __name__ == "__main__":
    main()
