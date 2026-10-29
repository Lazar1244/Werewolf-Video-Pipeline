"""Step 4: the 2D layer: one transparent image per beat (plain Python + Pillow), laid over the animated clips.

    python director/overlays.py <id8>

Speech boxes above the 3D name signs (the signs themselves are rendered in Blender; the Room keeps 2D name labels), the lower-third plate in close-ups, captions, title cards, death cards and
vote tallies, the phase badge and a vignette. For a thought ("inner voice"), Game 2 on (owner, 2026-10-22): the NEW look, whole opaque frames
(dimension_beat(), thought_fx.py: the other dimension with red rings from the thinker's feet), wherever the thought's
loop has a data map (render_clips.py --maps <seat>); without one, the old look: the scene dimmed except a soft spotlight
on the thinker, with a haze of the thinker's team colour from the edges. When the camera is on one character
(their speech or thought, or a close-up about them), a badge in the top right corner names their role.
Text types itself out (speech, thoughts, captions, title lines): each beat is a short image sequence on twos, the
text growing a few letters per image until it is whole by about 60% of the beat; the last image holds.
Output: games/<id8>/overlays/beat_###/####.png and overlays/index.json (images per beat, shown 2 frames each)
"""
import json
import math
import os
import shutil
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compose import CLOSE, Fonts, box, rgb, wrap  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # this Blender folder ("2 Werewolf Blender")
FPS, STEP, CPS = 24, 2, 22  # typing: images on twos, about 22 letters a second at most
TEAM = {"wolf": (215, 30, 22), "village": (60, 110, 240), "lovers": (255, 105, 180), "solo": (150, 80, 230)}
TEAM_TEXT = {"wolf": (240, 78, 66), "village": (120, 165, 255), "lovers": (255, 140, 200), "solo": (185, 140, 255)}
TEAM_NAME = {"wolf": "Werewolf team", "village": "Village team", "solo": "Plays alone"}
WOLVES = {"werewolf", "big_bad_wolf", "accursed_wolf_father", "white_werewolf"}
SOLO = {"white_werewolf", "thief", "wild_child", "wolf_hound", "piper", "angel"}


def vignette(W, H):
    yy, xx = np.mgrid[0:H, 0:W]
    r2 = ((xx / W - 0.5) * 2) ** 2 * 0.8 + ((yy / H - 0.5) * 2) ** 2
    a = np.clip(0.42 * np.clip(r2, 0, 1.6) ** 1.6, 0, 1) * 255
    img = np.zeros((H, W, 4), np.uint8)
    img[..., 3] = a.astype(np.uint8)
    return Image.fromarray(img, "RGBA")


def cut(lines, n):
    """The first n letters of the wrapped text, line by line (None = all of it)."""
    if n is None:
        return lines
    out = []
    for l in lines:
        out.append(l[:max(0, n)])
        n -= len(l) + 1
    return out


def inner_voice(W, H, head, team):
    """Dim everything but a spotlight on the thinker; the team colour closes in from the edges."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    hx, hy = head
    d = np.sqrt((xx - hx) ** 2 + ((yy - hy) * 1.15) ** 2) / H
    dim = np.clip((d - 0.16) / 0.22, 0, 1) * 0.62
    r2 = ((xx / W - 0.5) * 2) ** 2 * 0.7 + ((yy / H - 0.5) * 2) ** 2
    edge = np.clip((r2 - 0.5) / 0.85, 0, 1)  # the coloured band at the edges (owner: a little thinner)
    main = TEAM["wolf"] if team.get("wolf") else TEAM["solo"] if team.get("solo") else TEAM["lovers"] if team.get("lovers") else TEAM["village"]
    outer = TEAM["lovers"] if team.get("lovers") and team.get("wolf") else main
    col = np.zeros((H, W, 3), np.float32)
    for c in range(3):
        col[..., c] = main[c] * (1 - edge) + outer[c] * edge
    tint_a = edge * 0.55
    # composite: black dim first, the coloured haze over it
    a = dim + tint_a * (1 - dim)
    rgbv = (col * tint_a[..., None]) / np.maximum(a[..., None], 1e-4)
    img = np.dstack([np.clip(rgbv, 0, 255), np.clip(a * 255, 0, 255)]).astype(np.uint8)
    return Image.fromarray(img, "RGBA")


class Overlays:
    def __init__(self, gid):
        import colors  # village/colors.py: each seat in its model's colour (owner, 2026-10-27)
        colors.use_game(gid)
        self.dir = os.path.join(BASE, "games", gid)
        self.ep = json.load(open(os.path.join(self.dir, "episode.json"), encoding="utf-8"))
        self.plan = json.load(open(os.path.join(self.dir, "plan.json"), encoding="utf-8"))
        self.meta = {}
        for f in os.listdir(self.dir):
            if f.startswith("meta_") and f.endswith(".json"):
                self.meta.update(json.load(open(os.path.join(self.dir, f), encoding="utf-8")))
        self.seats = {s["seat"]: s for s in self.ep["seats"]}
        first = next(iter(self.meta.values()))
        self.W, self.H = first["size"]
        self.vig = vignette(self.W, self.H)
        self.keeps = []  # boxes a speech box must keep clear of (the role badge, the speaker's sign)
        self.xf = None  # (x0, y0, zoom) while drawing on a pushed-in picture (the new inner voice)
        self.frame = None  # the loop's rendered frame under this image (the claw marks follow the door in each frame)
        self.gouges = None  # how far each claw mark is drawn (0..1), set per image by claws_beat
        self.fixed_side = None  # a beside-the-head bubble keeps one side for a whole pushed-in beat (it flipped)

    def _xf(self, x, y):
        if not self.xf:
            return x, y
        x0, y0, z = self.xf
        return (x - x0) * z, (y - y0) * z

    def sign_box(self, clip, seat):
        """The 3D name sign's box on screen (x0, y0, x1, y1), if it is in the picture."""
        r = self.meta.get(clip, {}).get("signs", {}).get(str(seat))
        if r and self.xf:
            r = [*self._xf(r[0], r[1]), *self._xf(r[2], r[3])]
        return tuple(r) if r and r[2] > 0 and r[0] < self.W and r[3] > 0 and r[1] < self.H else None

    def head(self, clip, seat):
        h = self.meta.get(clip, {}).get("heads", {}).get(str(seat))
        return self._xf(h[0], h[1]) if h and h[2] else None

    def role_of(self, seat):
        """(role name, team key) of a seat, e.g. ("Cupid", "village")."""
        role = self.seats[seat]["role"]
        return role.replace("_", " ").title(), "wolf" if role in WOLVES else "solo" if role in SOLO else "village"

    def label(self, d, F, x, y, seat):
        """Above a head, in the Room (no 3D signs there): the model in the seat colour, then the role (in the team colour;
        owner 2026-10-15: model names only, no character names). Labels that would overlap a label already drawn stack above it."""
        s = self.seats[seat]
        top = s["model_short"]
        role, team = self.role_of(seat)
        parts = [(role, F.tag_b, TEAM_TEXT[team] + (255,))]
        bw = sum(d.textlength(t, font=f) for t, f, _ in parts)
        tw = max(d.textlength(top, font=F.label), bw)
        pad = 8 * F.scale
        h = F.label.size + F.tag.size + pad * 2.4
        y = max(y, h + 48 * F.scale)  # a head near the top edge: keep the whole label in the picture, under the phase badge
        x0 = min(max(8, x - tw / 2 - pad), self.W - tw - pad * 2 - 8)
        x1 = x0 + tw + pad * 2
        for _ in range(len(self.taken)):
            hit = next((r for r in self.taken if x0 < r[2] + 4 and x1 > r[0] - 4 and y - h < r[3] + 4 and y > r[1] - 4), None)
            if hit is None:
                break
            y = hit[1] - 4
        self.taken.append((x0, y - h, x1, y))
        box(d, (x0, y - h, x1, y), fill=(8, 7, 14, 190), radius=8)
        d.text((x0 + pad + tw / 2, y - h + pad), top, font=F.label, fill=rgb(seat), anchor="mt")
        cx = x0 + pad + tw / 2 - bw / 2
        for t, f, col in parts:
            d.text((cx, y - h + pad + F.label.size + 3), t, font=f, fill=col, anchor="lt")
            cx += d.textlength(t, font=f)
        return y - h

    def plate(self, d, F, seat, right):
        s = self.seats[seat]
        role, _ = self.role_of(seat)
        tw = max(d.textlength(s["model_short"], font=F.card_role), d.textlength(role, font=F.label))
        pad = 14 * F.scale
        bw, bh = tw + pad * 2 + 10, F.card_role.size + F.label.size + pad * 2.2
        x0 = self.W - bw - 40 * F.scale if right else 40 * F.scale
        y0 = self.H - bh - 40 * F.scale
        box(d, (x0, y0, x0 + bw, y0 + bh), fill=(8, 7, 14, 205), edge=rgb(seat))
        d.text((x0 + pad + 8, y0 + pad), s["model_short"], font=F.card_role, fill=rgb(seat))
        d.text((x0 + pad + 8, y0 + pad + F.card_role.size + 4), role, font=F.label, fill=(214, 208, 218, 255))

    def bubble(self, d, F, x, anchor_y, seat, text, thought=False, beside=False, reveal=None, side=None):
        side = side or self.fixed_side
        W, H = self.W, self.H
        font = F.thought if thought else F.speech
        lines = wrap(d, text, font, int(W * (0.36 if beside else 0.42)))
        lh = font.size * 1.22
        pad = 16 * F.scale
        head = F.small.size + 6 if thought else 0
        bh = len(lines) * lh + pad * 2 + head
        if not beside and anchor_y - 10 - bh < 50 * F.scale:  # no room above the label: sit beside the speaker instead
            beside = True
            lines = wrap(d, text, font, int(W * 0.36))
            bh = len(lines) * lh + pad * 2 + head
        bw = max(d.textlength(l, font=font) for l in lines) + pad * 2 + 8
        if beside:
            x0 = x - 0.1 * W - bw if (side == "left" if side else x > W / 2) else x + 0.1 * W
            x0 = min(max(12, x0), W - bw - 12)
            y0 = min(max(56 * F.scale, anchor_y - bh / 2), H - bh - 150 * F.scale)
        else:
            x0 = min(max(12, x - bw / 2), W - bw - 12)
            y0 = max(50 * F.scale, anchor_y - 10 - bh)
        for k in self.keeps:  # never over the role badge or the speaker's own sign: move left, or else down
            if x0 + bw > k[0] - 10 and x0 < k[2] + 10 and y0 < k[3] + 10 and y0 + bh > k[1] - 10:
                x0, y0 = (k[0] - 10 - bw, y0) if k[0] - 10 - bw >= 12 else (x0, k[3] + 10)
        y1 = y0 + bh
        if thought:
            box(d, (x0, y0, x0 + bw, y1), fill=(24, 18, 36, 215), edge=(170, 150, 210, 235))
            d.text((x0 + pad + 8, y0 + pad - 2), "thinks…", font=F.small, fill=(180, 170, 210, 255))
            col = (215, 208, 232, 255)
        else:
            box(d, (x0, y0, x0 + bw, y1), edge=rgb(seat))
            col = (244, 240, 232, 255)
        for i, l in enumerate(cut(lines, reveal)):  # the box has its full size from the start; the text fills it
            d.text((x0 + pad + 8, y0 + pad + head + i * lh), l, font=font, fill=col)
        return (x0, y0, x0 + bw, y1)

    def door(self, clip):
        """The door's front on screen (render_clips meta, door shots only), as seen in a pushed-in picture."""
        m = self.meta.get(clip, {})
        q = m.get("door_frames", {}).get(str(self.frame)) if self.frame is not None else None
        q = q or m.get("door")
        if not q:
            return None
        if self.xf:
            x0, y0, z = self.xf
            q = [[(x - x0) * z, (y - y0) * z] for x, y in q]
        return q

    def claws_beat(self, b, pb, bdir):
        """A "Claws scratch at ...'s door" beat as one image per 2 frames over the whole beat (owner, 2026-10-28): in
        each image the marks sit on the door where that frame of the loop shows it (the camera drifts), and the three
        gouges are torn one by one while the narrator speaks, then stay."""
        clip = pb["segments"][-1]["clip"]
        rendered = self.meta[clip]["frames"]
        start = pb.get("overlay_start", 0)
        offset = start - sum(s["frames"] for s in pb["segments"][:-1])
        n = math.ceil((pb["frames"] - start) / STEP)
        text = self.typed(b)
        typing = max(STEP * 3, min(round(0.6 * (pb["frames"] - start)), math.ceil(len(text) / CPS * FPS))) // STEP
        base = self.base(b, pb)
        voice = pb.get("voice_at", start)
        for i in range(n):
            self.frame = rendered[(offset // STEP + i) % len(rendered)]
            t = (start + i * STEP - voice) / FPS  # seconds since the narrator began
            self.gouges = [min(1.0, max(0.0, (t - (0.1 + 0.5 * k)) / 0.25)) for k in range(3)]  # each torn in 0.25 s, 0.5 s apart
            rv = round(len(text) * i / typing) if i < typing else None
            self.overlay(b, pb, base, rv).save(os.path.join(bdir, f"{i:04d}.png"), compress_level=1)
        self.frame = self.gouges = None
        return n

    def claws(self, d, F, quad, qs):
        """Owner (2026-10-27): the claw marks appear on the door as the wolves scratch it. Three long gouges, one after
        the other (`qs`: how far each is drawn, 0..1), in the door's own perspective: pale torn wood with a dark edge."""
        (tlx, tly), (trx, try_), (brx, bry), (blx, bly) = quad

        def at(u, v):  # door coordinates (u across from the left, v down from the top) -> screen
            top = (tlx + (trx - tlx) * u, tly + (try_ - tly) * u)
            bot = (blx + (brx - blx) * u, bly + (bry - bly) * u)
            return (top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v)

        width = max(4, abs(trx - tlx) * 0.07)  # the widest point of a gouge
        for k, u in enumerate((0.3, 0.47, 0.64)):
            q = qs[k]
            if q <= 0:
                continue
            n = 16
            spine = []
            for i in range(n + 1):  # slanting down, slightly curved, as a paw drags
                t = q * i / n
                spine.append((u - 0.06 + 0.16 * t + 0.05 * math.sin(t * math.pi), 0.18 + 0.03 * k + (0.44 - 0.01 * k) * t))
            pts = [at(*c) for c in spine]
            if len(pts) < 2:
                continue
            left, right = [], []
            for i, (x, y) in enumerate(pts):  # tapered: thin at both ends, widest in the middle
                x2, y2 = pts[min(i + 1, len(pts) - 1)]
                x1, y1 = pts[max(i - 1, 0)]
                dx, dy = x2 - x1, y2 - y1
                ln = max(1e-3, (dx * dx + dy * dy) ** 0.5)
                tt = (i / n) / max(q, 1e-3) if q < 1 else i / n
                half = width / 2 * max(0.12, math.sin(math.pi * min(1.0, tt)) ** 0.7)
                left.append((x - dy / ln * half, y + dx / ln * half))
                right.append((x + dy / ln * half, y - dx / ln * half))
            shape = left + right[::-1]
            d.polygon(shape, fill=(16, 7, 5, 240), outline=(16, 7, 5, 240), width=3)  # the dark torn edge
            inner = [((lx + rx) / 2 + (lx - rx) * 0.28, (ly + ry) / 2 + (ly - ry) * 0.28) for (lx, ly), (rx, ry) in zip(left, right)]
            inner += [((lx + rx) / 2 - (lx - rx) * 0.28, (ly + ry) / 2 - (ly - ry) * 0.28) for (lx, ly), (rx, ry) in zip(left[::-1], right[::-1])]
            d.polygon(inner, fill=(206, 168, 120, 255))  # pale wood inside
            d.line(pts, fill=(110, 30, 22, 210), width=max(1, round(width * 0.12)))  # the deepest cut

    def pointer(self, d, F, box_xy, head, seat):
        """Owner (2026-10-27): in a vote it must be clear WHO is voting. A line in the voter's colour (with a dark edge)
        from their words to them, ending in an arrowhead, and a ring round the voter."""
        x0, y0, x1, y1 = box_xy
        hx, hy = head
        r = 30 * F.scale  # the ring round the voter's head
        # from the side of the box nearest the voter
        sx = min(max(hx, x0 + 14), x1 - 14)
        sy = y1 if hy > y1 else y0 if hy < y0 else (y0 + y1) / 2
        if y0 <= hy <= y1:
            sx = x1 if hx > x1 else x0
        dx, dy = hx - sx, hy - sy
        dist = max(1.0, (dx * dx + dy * dy) ** 0.5)
        ux, uy = dx / dist, dy / dist
        ex, ey = hx - ux * (r + 6 * F.scale), hy - uy * (r + 6 * F.scale)  # stop at the ring
        col = rgb(seat)
        edge = (8, 6, 12, 230)
        w = max(3, round(4 * F.scale))
        a = 16 * F.scale  # the arrowhead
        tip = (ex, ey)
        left = (ex - ux * a - uy * a * 0.55, ey - uy * a + ux * a * 0.55)
        right = (ex - ux * a + uy * a * 0.55, ey - uy * a - ux * a * 0.55)
        d.line([(sx, sy), (ex - ux * a * 0.6, ey - uy * a * 0.6)], fill=edge, width=w + 4)
        d.polygon([tip, left, right], fill=edge, outline=edge, width=4)
        d.ellipse((hx - r - 2, hy - r - 2, hx + r + 2, hy + r + 2), outline=edge, width=w + 4)
        d.line([(sx, sy), (ex - ux * a * 0.6, ey - uy * a * 0.6)], fill=col, width=w)
        d.polygon([tip, left, right], fill=col)
        d.ellipse((hx - r, hy - r, hx + r, hy + r), outline=col, width=w)

    def role_badge(self, d, F, seat):
        """Top right: the role of the character the camera is on, in their team's colour (and a Lovers tag)."""
        s = self.seats[seat]
        name, team = self.role_of(seat)
        tags = [(TEAM_NAME[team], (190, 184, 200, 255))] + ([("in love", TEAM_TEXT["lovers"] + (255,))] if s.get("lover") else [])
        tag = "  ·  ".join(t for t, _ in tags)
        pad = 14 * F.scale
        tw = max(d.textlength(name.upper(), font=F.card_role), d.textlength(tag, font=F.small), d.textlength("ROLE", font=F.small))
        bw, bh = tw + pad * 2 + 8, F.small.size * 2.5 + F.card_role.size + pad * 2
        x1, y0 = self.W - 16, 14
        x0 = x1 - bw
        box(d, (x0, y0, x1, y0 + bh), fill=(8, 7, 14, 200), edge=TEAM_TEXT[team] + (255,))
        d.text((x0 + pad + 8, y0 + pad), "ROLE", font=F.small, fill=(160, 154, 172, 255))
        d.text((x0 + pad + 8, y0 + pad + F.small.size * 1.2), name.upper(), font=F.card_role, fill=TEAM_TEXT[team] + (255,))
        x, y = x0 + pad + 8, y0 + pad + F.small.size * 1.3 + F.card_role.size * 1.15
        for i, (t, col) in enumerate(tags):
            if i:
                d.text((x, y), "  ·  ", font=F.small, fill=(150, 144, 160, 255))
                x += d.textlength("  ·  ", font=F.small)
            d.text((x, y), t, font=F.small, fill=col)
            x += d.textlength(t, font=F.small)
        return (x0, y0, x1, y0 + bh)

    def focus(self, b):
        """The one character the camera is on in this beat, if any."""
        if b["kind"] in ("speech", "thought"):
            return b["seat"]
        on_screen = {m["seat"] for m in b["shot"]["cast"]}  # e.g. the door shot names the victim but shows the wolf
        if b["kind"] == "narration" and len(b.get("labels", [])) == 1 and any(c in b["shot"]["camera"] for c in CLOSE) and b["labels"][0] in on_screen:
            return b["labels"][0]
        return None

    def caption(self, d, F, text, reveal=None):
        lines = wrap(d, text, F.cap, int(self.W * 0.7))
        lh, pad = F.cap.size * 1.25, 18 * F.scale
        bw = max(d.textlength(l, font=F.cap) for l in lines) + pad * 2
        bh = len(lines) * lh + pad * 2
        x0, y1 = (self.W - bw) / 2, self.H - 36 * F.scale
        box(d, (x0, y1 - bh, x0 + bw, y1), fill=(8, 7, 14, 200))
        for i, (full, l) in enumerate(zip(lines, cut(lines, reveal))):  # left edge of the whole line, so letters don't slide
            d.text((self.W / 2 - d.textlength(full, font=F.cap) / 2, y1 - bh + pad + i * lh), l, font=F.cap, fill=(236, 228, 214, 255), anchor="lt")

    # ---------------- the NEW inner voice (owner-approved 2026-10-22; FullGameFolder/Game 2/Inner voice/HOW_IT_WAS_MADE.txt)
    def dimension_map(self, pb, b):
        """The data map folder of this thought beat's loop (render_clips.py --maps <seat>), if it was rendered."""
        loop = pb["segments"][-1]["clip"]
        d = os.path.join(self.dir, "clips", f"{loop}_map{b['seat']}")
        return (loop, d) if os.path.exists(os.path.join(d, "map.json")) else (loop, None)

    def dimension_beat(self, b, pb, bdir):
        """A thought beat as whole opaque frames from its text start to its end: the other dimension (the village dim,
        the other players as see-through ghosts, the thinker in colour, red rings from the thinker's feet across the
        surfaces, following this beat's voice), a 6% push in toward the thinker, and the usual text on top (bubble,
        badges) at the pushed-in positions. One image per 2 frames, as the loop (rendered on twos)."""
        from thought_fx import LIGHT_BLUE, RED, envelope, read_map, ring_births, thought_frame
        rings = RED if b.get("team", {}).get("wolf") else LIGHT_BLUE  # owner (2026-10-27): red for wolves only
        loop, mdir = self.dimension_map(pb, b)
        far = json.load(open(os.path.join(mdir, "map.json"), encoding="utf-8"))["far"]
        cdir = os.path.join(self.dir, "clips", loop)
        files = sorted(f for f in os.listdir(cdir) if f.endswith(".png"))
        start = pb.get("overlay_start", 0)
        offset = start - sum(s["frames"] for s in pb["segments"][:-1])  # frames into the loop where the text starts
        n = math.ceil((pb["frames"] - start) / STEP)
        lead = (pb.get("voice_at", start) - start) / FPS
        env = envelope(pb["voice"]) if pb.get("voice") and os.path.exists(pb["voice"]) else np.zeros(1)
        births = [x + lead for x in ring_births(env)]
        env = np.concatenate([np.zeros(max(0, int(lead * FPS))), env])
        text = self.typed(b)
        typing = max(STEP * 3, min(round(0.6 * (pb["frames"] - start)), math.ceil(len(text) / CPS * FPS))) // STEP
        hx, hy = self.head(loop, b["seat"]) or (self.W / 2, self.H * 0.45)
        self.fixed_side = "left" if hx > self.W / 2 else "right"  # decided once (the push moves the head)
        clean = self.vig.copy()  # the vignette only: the dimension replaces the old red haze
        for i in range(n):
            t = i * STEP / FPS
            fn = files[(offset // STEP + i) % len(files)]
            beauty = np.asarray(Image.open(os.path.join(cdir, fn)).convert("RGB"))
            dist, cls = read_map(os.path.join(mdir, fn), far)
            y, x = np.unravel_index(np.argmin(np.where(cls < 0.25, dist, 1e9)), dist.shape)
            img = thought_frame(beauty, dist, cls, t, env, births, (x, y), rings)
            k = min(1.0, (i + 1) / 3)  # a quick sink into the other dimension (6 frames)
            img = (beauty * (1 - k) + img * k).astype(np.uint8)
            z = 1 + 0.06 * i / max(1, n - 1)  # the slow push in toward the thinker (as the old look's)
            cw, ch = self.W / z, self.H / z
            x0, y0 = min(max(0, hx - cw / 2), self.W - cw), min(max(0, hy - ch / 2), self.H - ch)
            pic = Image.fromarray(img).crop((x0, y0, x0 + cw, y0 + ch)).resize((self.W, self.H), Image.LANCZOS).convert("RGBA")
            self.xf = (x0, y0, z)  # head and sign positions as seen in the pushed-in picture
            rv = round(len(text) * i / typing) if i < typing else None
            pic = Image.alpha_composite(pic, self.overlay(b, pb, clean, rv))
            self.xf = None
            pic.save(os.path.join(bdir, f"{i:04d}.png"), compress_level=1)
        self.fixed_side = None
        return n

    def base(self, b, pb):
        """The parts that do not change while the text types: the vignette and the inner-voice light."""
        img = self.vig.copy()
        if b["kind"] == "thought":
            hp = self.head(pb["hold"], b["seat"]) or (self.W / 2, self.H * 0.45)
            img = Image.alpha_composite(img, inner_voice(self.W, self.H, hp, b.get("team", {})))
        return img

    def typed(self, b):
        """The text that types itself out in this beat (None: the beat appears at once)."""
        if b["kind"] in ("speech", "thought", "narration"):
            return b["text"]
        return b.get("sub") if b["kind"] in ("title", "transition") else None

    def overlay(self, b, pb, base, reveal=None):
        W, H = self.W, self.H
        F = Fonts(W / 1280)
        img = base.copy()
        clip = pb["hold"]
        cam = b["shot"]["camera"]
        close = any(c in cam for c in CLOSE)
        d = ImageDraw.Draw(img)
        room, forest = b["shot"]["scene"] == "Room", b["shot"]["scene"] == "Clearing"
        # the wolves in the forest are named by their 3D signs: no role badge, no name plate there (owner)
        self.keeps = [self.role_badge(d, F, self.focus(b))] if self.focus(b) is not None and not forest else []
        self.taken = []  # 2D labels drawn so far (the Room only)
        lift = (0.17 if close else 0.075) * H
        if b["kind"] == "title" or (b["kind"] == "transition" and b.get("text")):
            d.rectangle((0, 0, W, H), fill=(0, 0, 0, 110))
            d.text((W / 2, H * 0.42), b["text"], font=F.title, fill=(240, 232, 214, 255), anchor="mm")
            sub = b["sub"] if reveal is None else b["sub"][:reveal]
            d.text((W / 2 - d.textlength(b["sub"], font=F.sub) / 2, H * 0.42 + F.title.size * 0.85), sub, font=F.sub, fill=(200, 190, 210, 255), anchor="lm")
        elif b["kind"] in ("speech", "thought"):
            hp = self.head(clip, b["seat"])
            x, y = hp if hp else (W / 2, H * 0.45)
            sb = self.sign_box(clip, b["seat"])
            if sb:
                self.keeps.append(sb)
            if close:
                if not forest:
                    self.plate(d, F, b["seat"], x < W / 2)
                self.bubble(d, F, x, y, b["seat"], b["text"], thought=b["kind"] == "thought", beside=True, reveal=reveal)
            elif room and b.get("context") == "lovers":  # two at the table: the words beside the speaker, clear of the name label
                self.label(d, F, x, y - lift, b["seat"])
                other = next((self.head(clip, m["seat"]) for m in b["shot"]["cast"] if m["seat"] != b["seat"]), None)
                side = ("left" if other[0] > x else "right") if other else None  # away from the other lover
                self.bubble(d, F, x, y + 0.1 * H, b["seat"], b["text"], beside=True, reveal=reveal, side=side)  # below the labels
            else:  # just above the speaker's sign (or above the head where there is no sign)
                anchor = self.label(d, F, x, y - lift, b["seat"]) if room else (sb[1] if sb else y - lift)
                bx = self.bubble(d, F, x, anchor - 6, b["seat"], b["text"], thought=b["kind"] == "thought", reveal=reveal)
                if b.get("context") == "vote" and hp:  # the voter, pointed at (owner, 2026-10-27)
                    self.pointer(d, F, bx, (x, y), b["seat"])
        elif b["kind"] == "narration" and b["text"].startswith("Claws scratch") and self.door(clip) and not self.plan["clips"][clip].get("claws"):
            self.claws(d, F, self.door(clip), self.gouges or [1.0, 1.0, 1.0])
            self.caption(d, F, b["text"], reveal=reveal)
        elif b["kind"] == "narration":
            if room:  # the Room keeps its 2D labels above heads, as before the 3D signs (owner)
                for s in b.get("labels", []):
                    hp = self.head(clip, s)
                    if hp:
                        self.label(d, F, hp[0], hp[1] - lift, s)
            self.caption(d, F, b["text"], reveal=reveal)
        elif b["kind"] == "card":
            # a compact card in the bottom-left corner: the body (centre of the shot) stays fully in view
            pw, ph = W * 0.34, F.card_name.size * 1.15 + F.card_role.size * 1.4 + F.cap.size * 1.4 + F.small.size + 48 * F.scale
            x0, y0 = 36 * F.scale, H - ph - 36 * F.scale
            cx = x0 + pw / 2
            box(d, (x0, y0, x0 + pw, y0 + ph), fill=(10, 8, 14, 225), edge=rgb(b["seat"]), radius=16, edge_w=8)
            y = y0 + 22 * F.scale
            d.text((cx, y), b["name"].upper(), font=F.card_name, fill=rgb(b["seat"]), anchor="mt")  # the short model name
            y += F.card_name.size * 1.15
            d.text((cx, y), f"was {b['role']}", font=F.card_role, fill=(236, 228, 214, 255), anchor="mt")
            y += F.card_role.size * 1.4
            d.text((cx, y), b["cause"], font=F.cap, fill=(220, 90, 80, 255), anchor="mt")
            d.text((cx, y + F.cap.size * 1.4), self.seats[b["seat"]]["model_short"], font=F.small, fill=(180, 175, 190, 255), anchor="mt")
        elif b["kind"] == "tally":
            rows = b["rows"]
            pw, rh = W * 0.46, F.speech.size * 1.6
            ph = F.label.size * 2.2 + rh * max(1, len(rows)) + F.small.size * 2.4
            x0, y0 = (W - pw) / 2, (H - ph) / 2
            box(d, (x0, y0, x0 + pw, y0 + ph), fill=(10, 8, 14, 215), radius=16)
            d.text((W / 2, y0 + 16 * F.scale), b["title"], font=F.label, fill=(240, 232, 214, 255), anchor="mt")
            top = max([r["votes"] for r in rows] + [1])
            for i, r in enumerate(rows):
                yy = y0 + F.label.size * 2.2 + i * rh
                d.text((x0 + 24 * F.scale, yy), r["name"], font=F.speech, fill=rgb(r["seat"]))
                bx, bw = x0 + pw * 0.38, (pw * 0.5) * r["votes"] / top
                d.rounded_rectangle((bx, yy + 4, bx + bw, yy + rh * 0.62), radius=6, fill=rgb(r["seat"], 230))
                d.text((bx + bw + 10, yy), str(r["votes"]), font=F.speech, fill=(240, 232, 214, 255))
            d.text((W / 2, y0 + ph - F.small.size * 1.6), f"{b['abstain']} abstained", font=F.small, fill=(180, 175, 190, 255), anchor="mt")
        if b.get("phase"):
            tw = d.textlength(b["phase"].upper(), font=F.badge)
            box(d, (16, 14, 16 + tw + 28 * F.scale, 14 + F.badge.size + 16 * F.scale), fill=(8, 7, 14, 180), radius=8)
            d.text((16 + 14 * F.scale, 14 + 8 * F.scale), b["phase"].upper(), font=F.badge, fill=(226, 214, 190, 255))
        return img

    def door_beat(self, b, pb):
        """A door beat that needs the 2D marks: only where the shot has no 3D ones (plan clip "claws", owner 2026-10-28)."""
        clip = pb["segments"][-1]["clip"]
        return (b["kind"] == "narration" and b["text"].startswith("Claws scratch") and bool(self.meta.get(clip, {}).get("door"))
                and not self.plan["clips"][clip].get("claws"))

    def run(self, only=None):
        """All beats (the folder is made anew), or with `only` just those beats (the others' images are kept)."""
        odir = os.path.join(self.dir, "overlays")
        if only is None:
            shutil.rmtree(odir, ignore_errors=True)
            os.makedirs(odir)
            index = {}
        else:
            index = {int(k): v for k, v in json.load(open(os.path.join(odir, "index.json"), encoding="utf-8"))["beats"].items()}
        total = 0
        for pb in self.plan["beats"]:
            if only is not None and pb["index"] not in only:
                continue
            b = self.ep["beats"][pb["index"]]
            bdir = os.path.join(odir, f"beat_{pb['index']:03d}")
            shutil.rmtree(bdir, ignore_errors=True)
            os.makedirs(bdir)
            if self.door_beat(b, pb):
                index[pb["index"]] = self.claws_beat(b, pb, bdir)
                total += index[pb["index"]]
                continue
            if b["kind"] == "thought":
                if self.dimension_map(pb, b)[1]:
                    index[pb["index"]] = self.dimension_beat(b, pb, bdir)
                    total += index[pb["index"]]
                    continue
                print(f"[overlays] beat {pb['index']}: no data map for its thought yet: the old inner-voice look")
            base, text = self.base(b, pb), self.typed(b)
            steps = [None]
            if text:
                shown = pb["frames"] - pb.get("overlay_start", 0)
                frames = max(STEP * 3, min(round(0.6 * shown), math.ceil(len(text) / CPS * FPS)))
                n = frames // STEP
                steps = [round(len(text) * i / n) for i in range(n)] + [None]
            for i, rv in enumerate(steps):
                self.overlay(b, pb, base, rv).save(os.path.join(bdir, f"{i:04d}.png"), compress_level=1)
            index[pb["index"]] = len(steps)
            total += len(steps)
        with open(os.path.join(odir, "index.json"), "w", encoding="utf-8") as f:
            json.dump({"step": STEP, "beats": index}, f)
        print(f"[overlays] {len(self.plan['beats'])} beats, {total} images")


if __name__ == "__main__":
    # --beats 10,112: redo only those beats' images (the rest stay as they are)
    Overlays(sys.argv[1]).run({int(x) for x in sys.argv[sys.argv.index("--beats") + 1].split(",")} if "--beats" in sys.argv else None)
