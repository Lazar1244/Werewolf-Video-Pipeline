"""The channel banner (owner, 2026-10-20): "MECHANICAL BRAINS AT PLAY" as a red neon sign on black, after the owner's
"AI NEVER SLEEPS" reference; red to match the profile picture (1_natural_halo).

    python profile/make_banner.py ["<SLOGAN>" <out name>]   (default: the slogan below -> banner.png)

YouTube banners are 2560x1440, but only the middle 1546x423 shows on every device (TV shows all of it, desktop a
2560x423 band, phones the middle 1546x423), so the sign sits inside that middle box.
The neon: Bahnschrift SemiBold Condensed (a Windows font, close to the reference's), a white-hot core and four layers
of red glow (blurred copies of the letters, from tight to wide), added up like light.
Writes out/banner.png (2560x1440) and out/banner_preview.png (the safe areas drawn on it).
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
W, H = 2560, 1440
SAFE = (1546, 423)  # shows on every device
TEXT = sys.argv[1] if len(sys.argv) > 1 else "MECHANICAL BRAINS AT PLAY"
NAME = sys.argv[2] if len(sys.argv) > 2 else "banner"
CORE = np.array([1.0, 0.86, 0.84])   # the tube's white-hot middle
GLOW = np.array([1.0, 0.13, 0.09])   # the red light round it
LAYERS = [(3, 1.0), (12, 0.85), (34, 0.7), (90, 0.45)]  # (blur radius px, strength)


def font(size):
    f = ImageFont.truetype("C:/Windows/Fonts/bahnschrift.ttf", size)
    f.set_variation_by_name("SemiBold Condensed")
    return f


def letters(width):
    """The text's mask, as big as fits `width`, centred on the canvas."""
    size = 300
    while True:
        f = font(size)
        l, t, r, b = f.getbbox(TEXT)
        if r - l <= width:
            break
        size -= 4
    m = Image.new("L", (W, H), 0)
    ImageDraw.Draw(m).text((W / 2, H / 2), TEXT, font=f, fill=255, anchor="mm")
    return m, size


def main():
    os.makedirs(OUT, exist_ok=True)
    mask, size = letters(SAFE[0] - 140)
    a = np.asarray(mask).astype(np.float32) / 255
    img = np.zeros((H, W, 3), np.float32) + np.array([0.012, 0.004, 0.006])  # near-black, a hint of red
    for r, k in LAYERS:
        g = np.asarray(mask.filter(ImageFilter.GaussianBlur(r))).astype(np.float32) / 255
        img += GLOW * (g * k * (1.6 if r > 20 else 1.0))[..., None]
    core = np.asarray(mask.filter(ImageFilter.MinFilter(3))).astype(np.float32) / 255  # a slightly thinner bright core
    img = img * (1 - a[..., None]) + (GLOW * 0.95)[None, None, :] * a[..., None]  # the tube's red skin
    img = img * (1 - core[..., None]) + CORE[None, None, :] * core[..., None]
    out = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    out.save(os.path.join(OUT, f"{NAME}.png"))
    prev = out.copy()
    d = ImageDraw.Draw(prev)
    d.rectangle((0, (H - 423) / 2, W - 1, (H + 423) / 2), outline=(80, 160, 255), width=4)  # desktop
    d.rectangle(((W - SAFE[0]) / 2, (H - SAFE[1]) / 2, (W + SAFE[0]) / 2, (H + SAFE[1]) / 2), outline=(90, 255, 120), width=4)  # every device
    prev.resize((1280, 720), Image.LANCZOS).save(os.path.join(OUT, f"{NAME}_preview.png"))
    out.crop((0, (H - 423) // 2, W, (H + 423) // 2)).resize((1280, 212), Image.LANCZOS).save(os.path.join(OUT, f"{NAME}_desktop_view.png"))
    print(f"[banner] font {size}px -> out/{NAME}.png")


if __name__ == "__main__":
    main()
