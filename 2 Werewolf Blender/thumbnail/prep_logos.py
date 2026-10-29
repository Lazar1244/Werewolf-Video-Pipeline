"""The labs' real logos for the chests (owner, 2026-10-19: downloaded, not built). logos/*.svg are from Wikimedia
Commons (see logos/SOURCES.txt); each is rasterized to a 1024 px transparent PNG with headless Edge (the only way
to keep Gemini's blurred colour gradient), then made ready here:
    openai  the black mark recoloured white (it sits on a dark cloak);
    grok    only the white mark, the icon's black rounded square dropped;
    deepseek the blue whale as it is (Game 2, 2026-10-23);
    qwen, meta  as they are (Game 3, 2026-10-28);
    claude, gemini  as they are.
Each is cropped to its shape and centred on a square canvas: logos/png/<lab>.png.

    python thumbnail/prep_logos.py <folder with the rasterized <lab>.png>
"""
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DST = os.path.join(HERE, "logos", "png")


def prep(src, lab):
    a = np.asarray(Image.open(os.path.join(src, f"{lab}.png")).convert("RGBA")).astype(np.float32) / 255
    if lab in ("openai", "grok"):
        alpha = a[..., 3] if lab == "openai" else a[..., 3] * a[..., :3].mean(axis=2)  # grok: the white mark only
        a = np.dstack([np.ones_like(alpha)] * 3 + [alpha])
    ys, xs = np.nonzero(a[..., 3] > 0.02)
    a = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = a.shape[:2]
    side = int(max(h, w) * 1.04)
    out = np.zeros((side, side, 4), np.float32)
    y0, x0 = (side - h) // 2, (side - w) // 2
    out[y0:y0 + h, x0:x0 + w] = a
    Image.fromarray((out * 255).round().astype(np.uint8)).save(os.path.join(DST, f"{lab}.png"))
    return side


if __name__ == "__main__":
    os.makedirs(DST, exist_ok=True)
    for lab in ("openai", "claude", "gemini", "grok", "deepseek", "qwen", "meta"):
        print(lab, prep(sys.argv[1], lab))
