"""Step 4: draw the text onto the stills, one frame per beat (plain Python + Pillow).

    python director/compose.py <id8>

Name labels (model name in the seat colour, character name under it), the speech or thought box above the speaker's
head, narration captions, title cards, death cards and vote tallies. The glow and vignette finish is applied here
too. Output: games/<id8>/frames/beat_###.png and timeline.json (file + seconds per beat).
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # this Blender folder ("2 Werewolf Blender")
sys.path.insert(0, os.path.join(BASE, "village"))
FONTS = "C:/Windows/Fonts/"
from colors import SEAT_COLORS  # noqa: E402  (by seat; colors.use_game(gid) gives each seat its model's colour)
CLOSE = ("Seat_", "Room_Table", "Clearing_Rock", "Street_Door", "Square_Gallows", "Street_Peek")


def rgb(seat, a=255):
    r, g, b = SEAT_COLORS[(seat - 1) % 10]
    return (int(r * 255), int(g * 255), int(b * 255), a)


class Fonts:
    def __init__(self, scale):
        self.scale = scale
        f = lambda name, size: ImageFont.truetype(FONTS + name, int(size * scale))
        self.label = f("constanb.ttf", 24)
        self.small = f("constan.ttf", 17)
        self.tag, self.tag_b = f("constan.ttf", 20), f("constanb.ttf", 20)  # the name and role line under a label's model
        self.speech = f("constan.ttf", 27)
        self.thought = f("constani.ttf", 25)
        self.cap = f("georgiai.ttf", 28)
        self.title = f("constanb.ttf", 96)
        self.sub = f("georgiai.ttf", 34)
        self.card_name = f("constanb.ttf", 58)
        self.card_role = f("constan.ttf", 32)
        self.badge = f("constanb.ttf", 20)


def wrap(draw, text, font, width):
    lines, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def finish(img):
    """Glow around bright lights and a vignette (film grain comes later, animated, in the video)."""
    base = np.asarray(img.convert("RGB"), dtype=np.float32)
    bright = Image.fromarray(np.clip((base - 175) * 3, 0, 255).astype("uint8"))
    glow = np.asarray(bright.filter(ImageFilter.GaussianBlur(img.width // 90)), dtype=np.float32)
    h, w = base.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    r2 = ((xx / w - 0.5) * 2) ** 2 * 0.8 + ((yy / h - 0.5) * 2) ** 2
    vignette = (1 - 0.42 * np.clip(r2, 0, 1.6) ** 1.6)[..., None]
    return Image.fromarray(np.clip((base + glow * 0.55) * vignette, 0, 255).astype("uint8")).convert("RGBA")


def box(d, xy, fill=(10, 9, 16, 205), edge=None, radius=12, edge_w=5):
    x0, y0, x1, y1 = xy
    d.rounded_rectangle(xy, radius=radius, fill=fill)
    if edge:
        d.rounded_rectangle((x0, y0, x0 + edge_w + radius, y1), radius=radius, fill=edge)
        d.rectangle((x0 + edge_w, y0, x0 + edge_w + radius, y1), fill=fill)


class Composer:
    def __init__(self, gid):
        self.dir = os.path.join(BASE, "games", gid)
        self.ep = json.load(open(os.path.join(self.dir, "episode.json"), encoding="utf-8"))
        self.meta = json.load(open(os.path.join(self.dir, "stills", "meta.json"), encoding="utf-8"))
        self.seats = {s["seat"]: s for s in self.ep["seats"]}
        self.cache = {}

    def still(self, key):
        if key not in self.cache:
            self.cache[key] = finish(Image.open(os.path.join(self.dir, "stills", key + ".png")))
        return self.cache[key].copy()

    def head(self, key, seat):
        h = self.meta[key]["heads"].get(str(seat))
        return (h[0], h[1]) if h and h[2] else None

    def label(self, d, F, x, y, seat):
        s = self.seats[seat]
        top, bottom = s["model_short"], s["name"]
        tw = max(d.textlength(top, font=F.label), d.textlength(bottom, font=F.small))
        pad = 8 * F.scale
        h = F.label.size + F.small.size + pad * 2.2
        x0, y1 = x - tw / 2 - pad, y
        box(d, (x0, y1 - h, x0 + tw + pad * 2, y1), fill=(8, 7, 14, 190), radius=8)
        d.text((x, y1 - h + pad), top, font=F.label, fill=rgb(seat), anchor="mt")
        d.text((x, y1 - h + pad + F.label.size + 2), bottom, font=F.small, fill=(205, 200, 210, 255), anchor="mt")
        return y1 - h

    def plate(self, d, F, seat, right):
        """Lower-third name plate for close-ups (on the side away from the speaker's face)."""
        W, H = d.im.size
        s = self.seats[seat]
        tw = max(d.textlength(s["model_short"], font=F.card_role), d.textlength(s["name"], font=F.label))
        pad = 14 * F.scale
        bw, bh = tw + pad * 2 + 10, F.card_role.size + F.label.size + pad * 2.2
        x0 = W - bw - 40 * F.scale if right else 40 * F.scale
        y0 = H - bh - 40 * F.scale
        box(d, (x0, y0, x0 + bw, y0 + bh), fill=(8, 7, 14, 205), edge=rgb(seat))
        d.text((x0 + pad + 8, y0 + pad), s["model_short"], font=F.card_role, fill=rgb(seat))
        d.text((x0 + pad + 8, y0 + pad + F.card_role.size + 4), s["name"], font=F.label, fill=(214, 208, 218, 255))

    def bubble(self, img, d, F, x, top_y, seat, text, thought=False, beside=False):
        W, H = img.size
        width = int(W * (0.36 if beside else 0.42))
        font = F.thought if thought else F.speech
        lines = wrap(d, text, font, width)
        lh = font.size * 1.22
        pad = 16 * F.scale
        head = F.small.size + 6 if thought else 0
        bh = len(lines) * lh + pad * 2 + head
        bw = max(d.textlength(l, font=font) for l in lines) + pad * 2 + 8
        if beside:  # next to the head, on whichever side has more room
            gap = 0.1 * W
            x0 = x - gap - bw if x > W / 2 else x + gap
            x0 = min(max(12, x0), W - bw - 12)
            y0 = min(max(56 * F.scale, top_y - bh / 2), H - bh - 150 * F.scale)
            y1 = y0 + bh
        else:
            x0 = min(max(12, x - bw / 2), W - bw - 12)
            y1 = max(top_y - 10, bh + 50 * F.scale)
            y0 = y1 - bh
        if thought:
            box(d, (x0, y0, x0 + bw, y1), fill=(30, 24, 44, 200), edge=(150, 130, 190, 230))
            d.text((x0 + pad + 8, y0 + pad - 2), "thinks…", font=F.small, fill=(170, 160, 200, 255))
            col = (205, 198, 222, 255)
        else:
            box(d, (x0, y0, x0 + bw, y1), edge=rgb(seat))
            col = (244, 240, 232, 255)
        for i, l in enumerate(lines):
            d.text((x0 + pad + 8, y0 + pad + head + i * lh), l, font=font, fill=col)

    def caption(self, img, d, F, text):
        W, H = img.size
        lines = wrap(d, text, F.cap, int(W * 0.7))
        lh = F.cap.size * 1.25
        pad = 18 * F.scale
        bw = max(d.textlength(l, font=F.cap) for l in lines) + pad * 2
        bh = len(lines) * lh + pad * 2
        x0, y1 = (W - bw) / 2, H - 36 * F.scale
        box(d, (x0, y1 - bh, x0 + bw, y1), fill=(8, 7, 14, 200))
        for i, l in enumerate(lines):
            d.text((W / 2, y1 - bh + pad + i * lh), l, font=F.cap, fill=(236, 228, 214, 255), anchor="mt")

    def frame(self, b):
        key = b["still"]
        img = self.still(key)
        W, H = img.size
        F = Fonts(W / 1280)
        over = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(over)
        close = any(c in b["shot"]["camera"] for c in CLOSE)
        lift = (0.17 if close else 0.045) * H
        if b["kind"] == "title":
            d.rectangle((0, 0, W, H), fill=(0, 0, 0, 120))
            d.text((W / 2, H * 0.42), b["text"], font=F.title, fill=(240, 232, 214, 255), anchor="mm")
            d.text((W / 2, H * 0.42 + F.title.size * 0.85), b["sub"], font=F.sub, fill=(200, 190, 210, 255), anchor="mm")
        elif b["kind"] in ("speech", "thought"):
            hp = self.head(key, b["seat"])
            x, y = hp if hp else (W / 2, H * 0.45)
            if close:  # a name plate in the lower third; the words beside the head
                self.plate(d, F, b["seat"], x < W / 2)
                self.bubble(img, d, F, x, y, b["seat"], b["text"], thought=b["kind"] == "thought", beside=True)
            else:
                top = self.label(d, F, x, y - lift, b["seat"])
                self.bubble(img, d, F, x, top - 6, b["seat"], b["text"], thought=b["kind"] == "thought")
        elif b["kind"] == "narration":
            for s in b.get("labels", []):
                hp = self.head(key, s)
                if hp:
                    self.label(d, F, hp[0], hp[1] - lift, s)
            self.caption(img, d, F, b["text"])
        elif b["kind"] == "card":
            d.rectangle((0, 0, W, H), fill=(0, 0, 0, 70))
            pw, ph = W * 0.5, H * 0.34
            x0, y0 = (W - pw) / 2, H * 0.3
            box(d, (x0, y0, x0 + pw, y0 + ph), fill=(10, 8, 14, 225), edge=rgb(b["seat"]), radius=16, edge_w=8)
            d.text((W / 2, y0 + ph * 0.2), b["name"].upper(), font=F.card_name, fill=rgb(b["seat"]), anchor="mt")
            d.text((W / 2, y0 + ph * 0.2 + F.card_name.size * 1.15), f"was {b['role']}", font=F.card_role, fill=(236, 228, 214, 255), anchor="mt")
            d.text((W / 2, y0 + ph * 0.2 + F.card_name.size * 1.15 + F.card_role.size * 1.4), b["cause"], font=F.cap, fill=(220, 90, 80, 255), anchor="mt")
            d.text((W / 2, y0 + ph * 0.2 + F.card_name.size * 1.15 + F.card_role.size * 1.4 + F.cap.size * 1.4),
                   self.seats[b["seat"]]["model_short"], font=F.small, fill=(180, 175, 190, 255), anchor="mt")
        elif b["kind"] == "tally":
            rows = b["rows"]
            pw = W * 0.46
            rh = F.speech.size * 1.6
            ph = F.label.size * 2.2 + rh * max(1, len(rows)) + F.small.size * 2.4
            x0, y0 = (W - pw) / 2, (H - ph) / 2
            box(d, (x0, y0, x0 + pw, y0 + ph), fill=(10, 8, 14, 215), radius=16)
            d.text((W / 2, y0 + 16 * F.scale), b["title"], font=F.label, fill=(240, 232, 214, 255), anchor="mt")
            top = max([r["votes"] for r in rows] + [1])
            for i, r in enumerate(rows):
                yy = y0 + F.label.size * 2.2 + i * rh
                d.text((x0 + 24 * F.scale, yy), r["name"], font=F.speech, fill=rgb(r["seat"]))
                bx = x0 + pw * 0.38
                bw = (pw * 0.5) * r["votes"] / top
                d.rounded_rectangle((bx, yy + 4, bx + bw, yy + rh * 0.62), radius=6, fill=rgb(r["seat"], 230))
                d.text((bx + bw + 10, yy), str(r["votes"]), font=F.speech, fill=(240, 232, 214, 255))
            d.text((W / 2, y0 + ph - F.small.size * 1.6), f"{b['abstain']} abstained", font=F.small, fill=(180, 175, 190, 255), anchor="mt")
        if b.get("phase"):
            tw = d.textlength(b["phase"].upper(), font=F.badge)
            box(d, (16, 14, 16 + tw + 28 * F.scale, 14 + F.badge.size + 16 * F.scale), fill=(8, 7, 14, 180), radius=8)
            d.text((16 + 14 * F.scale, 14 + 8 * F.scale), b["phase"].upper(), font=F.badge, fill=(226, 214, 190, 255))
        return Image.alpha_composite(img, over).convert("RGB")

    def run(self):
        fdir = os.path.join(self.dir, "frames")
        os.makedirs(fdir, exist_ok=True)
        timeline = []
        for i, b in enumerate(self.ep["beats"]):
            path = os.path.join(fdir, f"beat_{i:03d}.png")
            self.frame(b).save(path)
            timeline.append({"file": path, "seconds": b["duration"], "still": b["still"]})
        with open(os.path.join(self.dir, "timeline.json"), "w", encoding="utf-8") as f:
            json.dump(timeline, f, indent=1)
        print(f"[compose] {len(timeline)} frames, {sum(t['seconds'] for t in timeline):.1f} s")


if __name__ == "__main__":
    Composer(sys.argv[1]).run()
