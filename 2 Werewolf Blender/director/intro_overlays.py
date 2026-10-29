"""The intro's text layer (plain Python + Pillow): one transparent image per 2 frames of each shot.

    python director/intro_overlays.py <id8>

Kinds (intro_plan.json, "overlay"):
  say    the wolf's name tag (top left, seat colour) and its speech box typing out beside its head
  think  the red inner-voice haze, the thought box typing out, and SECRETLY A WEREWOLF; with "fx": "dimension" (Game 2
         on): the NEW inner voice instead (thought_fx.py): whole opaque frames, the other dimension with the rings,
         the thought box and a 6% push in, built from the game clip and its data map
  name   a contestant's full model name in its seat colour (the roll-call)
  role   the role's name, huge, in its key colour, with its three-word caption
  title  WEREWOLF / AI EDITION, from the moment the host says "Let's play"
Every image carries the vignette. The frame size is the plan's ("size", 1280x720 by default; Game 2: 1920x1080):
every size below is given for 1280 wide and scaled by S. Output: games/<id8>/intro/overlays/<shot id>/####.png and index.json.
"""
import json
import os
import shutil
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compose import box, rgb, wrap  # noqa: E402
from overlays import inner_voice, vignette  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H, STEP, CPS = 1280, 720, 2, 26
S = 1.0  # W / 1280, set from the plan
FONTS = "C:/Windows/Fonts/"
ROLE_COLOUR = {"WEREWOLF": (235, 55, 45), "SEER": (90, 175, 255), "WITCH": (190, 90, 255), "VILLAGER": (255, 175, 60),
               "HUNTER": (255, 130, 40), "SHERIFF": (250, 200, 60), "CHALLENGE!": (255, 70, 95)}  # Game 2 added the last three
TEAM_COLOUR = {"TEAM CHINA": (232, 60, 50), "TEAM USA": (80, 150, 255)}  # Game 3: the two sides of the roll-call


def font(name, size):
    return ImageFont.truetype(FONTS + name, round(size * S))


def outlined(d, xy, text, f, fill, anchor="mm", stroke=4):
    d.text(xy, text, font=f, fill=fill, anchor=anchor, stroke_width=round(stroke * S), stroke_fill=(8, 6, 12, 255))


def head_of(gdir, clip, seat):
    meta = {}
    for fn in os.listdir(gdir):
        if fn.startswith("meta_") and fn.endswith(".json"):
            meta.update(json.load(open(os.path.join(gdir, fn), encoding="utf-8")))
    h = meta.get(clip, {}).get("heads", {}).get(str(seat))
    return (h[0], h[1]) if h else (W * 0.5, H * 0.45)


def speech_box(d, x, y, text, seat, thought=False, side=None):
    """side: "right" or "left" of the head, fixed for a whole shot (a pushed-in shot moves the head across the middle,
    and the box flipped sides for a few frames); None = by the head's half of the screen."""
    f = font("constani.ttf" if thought else "constan.ttf", 30)
    lines = wrap(d, text, f, int(W * 0.36))
    pad, lh, head = 18 * S, 37 * S, (24 * S if thought else 0)
    bw = max([d.textlength(l, font=f) for l in lines] + [40 * S]) + pad * 2 + 8 * S
    bh = len(lines) * lh + pad * 2 + head
    right = (x < W / 2) if side is None else side == "right"
    x0 = x + 0.09 * W if right else x - 0.09 * W - bw
    x0 = min(max(16 * S, x0), W - bw - 16 * S)
    y0 = min(max(70 * S, y - bh / 2), H - bh - 150 * S)
    if thought:
        box(d, (x0, y0, x0 + bw, y0 + bh), fill=(28, 10, 14, 215), edge=(220, 60, 50, 235), radius=round(12 * S), edge_w=round(5 * S))
        d.text((x0 + pad + 8 * S, y0 + pad - 4 * S), "thinks…", font=font("constan.ttf", 19), fill=(230, 140, 130, 255))
    else:
        box(d, (x0, y0, x0 + bw, y0 + bh), edge=rgb(seat), radius=round(12 * S), edge_w=round(5 * S))
    for i, l in enumerate(lines):
        d.text((x0 + pad + 8 * S, y0 + pad + head + i * lh), l, font=f, fill=(244, 238, 230, 255))


def dimension_frames(gdir, plan, shot, ov, sdir, n, vig):
    """The new inner voice (owner-approved, 2026-10-22; FullGameFolder/Game 2/Inner voice/HOW_IT_WAS_MADE.txt): opaque
    frames built from the game clip and its data map (render_clips.py --maps <seat>), the rings following the voice."""
    import numpy as np
    from thought_fx import envelope, read_map, ring_births, thought_frame
    cdir = os.path.join(gdir, "clips", shot["clip"])
    mdir = os.path.join(gdir, "clips", ov["map"])
    far = json.load(open(os.path.join(mdir, "map.json"), encoding="utf-8"))["far"]
    frames = sorted(f for f in os.listdir(cdir) if f.endswith(".png"))
    fps = plan["fps"]
    lead = shot.get("voice_at", 0) / fps
    env = envelope(plan["voices"][ov["voice"]]["file"])
    births = [b + lead for b in ring_births(env)]
    env = np.concatenate([np.zeros(int(lead * fps)), env])
    hx, hy = head_of(gdir, shot["clip"], ov["seat"])
    side = "right" if hx < W / 2 else "left"  # decided once: the push in must not flip the box
    for i in range(n):
        sec = i * STEP / fps
        fn = frames[i % len(frames)]  # one image per 2 frames, as the clip (rendered on twos)
        beauty = np.asarray(Image.open(os.path.join(cdir, fn)).convert("RGB"))
        dist, cls = read_map(os.path.join(mdir, fn), far)
        y, x = np.unravel_index(np.argmin(np.where(cls < 0.25, dist, 1e9)), dist.shape)
        img = thought_frame(beauty, dist, cls, sec, env, births, (x, y))
        k = min(1.0, (i + 1) / 3)  # a quick sink into the other dimension (6 frames)
        img = (beauty * (1 - k) + img * k).astype(np.uint8)
        z = 1 + 0.06 * i / max(1, n - 1)  # the slow push in toward the thinker
        cw, ch = W / z, H / z
        x0, y0 = min(max(0, hx - cw / 2), W - cw), min(max(0, hy - ch / 2), H - ch)
        pic = Image.fromarray(img).crop((x0, y0, x0 + cw, y0 + ch)).resize((W, H), Image.LANCZOS).convert("RGBA")
        pic = Image.alpha_composite(pic, vig)
        shown = ov["text"][: max(1, int((sec - lead) * CPS))] if sec > lead else ""
        if shown:
            speech_box(ImageDraw.Draw(pic), (hx - x0) * z, (hy - y0) * z, shown, ov["seat"], thought=True, side=side)
        pic.save(os.path.join(sdir, f"{i:04d}.png"))
    return n


def main(gid):
    import colors  # village/colors.py: each seat in its model's colour (owner, 2026-10-27)
    colors.use_game(gid)
    gdir = os.path.join(BASE, "games", gid)
    plan = json.load(open(os.path.join(gdir, "intro", "intro_plan.json"), encoding="utf-8"))
    global W, H, S
    W, H = plan.get("size", [1280, 720])
    S = W / 1280
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    seats = {s["seat"]: s for s in ep["seats"]}
    out = os.path.join(gdir, "intro", "overlays")
    shutil.rmtree(out, ignore_errors=True)
    vig = vignette(W, H)
    index = {}
    for shot in plan["shots"]:
        ov = shot.get("overlay") or {}
        sdir = os.path.join(out, shot["id"])
        os.makedirs(sdir, exist_ok=True)
        n = (shot["frames"] + STEP - 1) // STEP
        kind = ov.get("kind")
        base = vig.copy()
        if kind == "think" and ov.get("fx") == "dimension":
            index[shot["id"]] = dimension_frames(gdir, plan, shot, ov, sdir, n, vig)
            continue
        if kind == "think":
            hx, hy = head_of(gdir, shot["clip"], ov["seat"])
            base = Image.alpha_composite(base, inner_voice(W, H, (hx, hy), {"wolf": True}))
        for i in range(n):
            sec = i * STEP / plan["fps"]
            img = base.copy()
            d = ImageDraw.Draw(img)
            if kind in ("say", "think"):
                hx, hy = head_of(gdir, shot["clip"], ov["seat"])
                shown = ov["text"][: max(1, int((sec - 0.05) * CPS))] if sec > 0.05 else ""
                if shown:
                    speech_box(d, hx, hy, shown, ov["seat"], thought=kind == "think")
                if kind == "say":  # the name tag, from the first frame
                    tag = ov["tag"].upper()
                    f = font("constanb.ttf", 40)
                    tw = d.textlength(tag, font=f)
                    box(d, (28 * S, 26 * S, 28 * S + tw + 46 * S, 90 * S), fill=(10, 8, 14, 215), edge=rgb(ov["seat"]), edge_w=round(7 * S))
                    d.text((58 * S, 58 * S), tag, font=f, fill=rgb(ov["seat"]), anchor="lm")
                if kind == "think" and sec >= 0.6:
                    outlined(d, (W / 2, H - 92 * S), ov["caption"], font("constanb.ttf", 58), (240, 50, 40, 255), stroke=5)
            elif kind == "versus":  # Game 3: both teams in full: TEAM CHINA under the left, VS in the gap, TEAM USA under the right
                y = H - 100 * S
                outlined(d, (W * ov["left"], y), "TEAM CHINA", font("constanb.ttf", 50), TEAM_COLOUR["TEAM CHINA"] + (255,), stroke=5)
                outlined(d, (W * ov["mid"], y - 4 * S), "VS", font("constanb.ttf", 78), (245, 238, 225, 255), stroke=6)
                outlined(d, (W * ov["right"], y), "TEAM USA", font("constanb.ttf", 58), TEAM_COLOUR["TEAM USA"] + (255,), stroke=6)
            elif kind == "team":  # Game 3: the zoom on one team: its name, big, in its colour
                outlined(d, (W / 2, H - 105 * S), ov["team"], font("constanb.ttf", 96), TEAM_COLOUR[ov["team"]] + (255,), stroke=7)
            elif kind == "name":
                name = ov["text"].upper()
                f = font("constanb.ttf", 66)
                outlined(d, (W / 2, H - 110 * S), name, f, rgb(ov["seat"]), stroke=6)
                if ov.get("team"):  # Game 3: the side above the name (TEAM CHINA red, TEAM USA blue)
                    outlined(d, (W / 2, H - 182 * S), ov["team"], font("constanb.ttf", 44), TEAM_COLOUR.get(ov["team"], (240, 230, 214)) + (255,), stroke=5)
            elif kind == "role":
                col = ROLE_COLOUR.get(ov["role"], (240, 230, 210)) + (255,)
                if shot["source"] == "game":  # the village is busy (signs, figures): a dark panel keeps the words readable
                    tw = max(d.textlength(ov["role"], font=font("constanb.ttf", 96)), d.textlength(ov["caption"], font=font("constanb.ttf", 40)))
                    box(d, (34 * S, 50 * S, 92 * S + tw, 240 * S), fill=(8, 6, 12, 185), radius=round(14 * S))
                outlined(d, (60 * S, 70 * S), ov["role"], font("constanb.ttf", 96), col, anchor="lt", stroke=6)
                outlined(d, (64 * S, 182 * S), ov["caption"], font("constanb.ttf", 40), (245, 238, 225, 255), anchor="lt", stroke=4)
            elif kind == "title" and sec >= ov["at"]:
                d.rectangle((0, 0, W, H), fill=(0, 0, 0, 90))
                outlined(d, (W / 2, H * 0.42), ov["text"], font("constanb.ttf", 150), (240, 230, 214, 255), stroke=7)
                outlined(d, (W / 2, H * 0.42 + 112 * S), ov["sub"], font("constanb.ttf", 54), (235, 60, 45, 255), stroke=5)
                y = H * 0.42 + 196 * S
                if ov.get("matchup") and sec >= ov["at"] + 0.4:  # Game 3: TEAM CHINA (red) VS (white) TEAM USA (blue)
                    fm = font("constanb.ttf", 62)
                    parts = [(w, TEAM_COLOUR.get(w, (245, 238, 225)) + (255,)) for w in ov["matchup"]]
                    gap = 26 * S
                    widths = [d.textlength(w, font=fm) for w, _ in parts]
                    x = W / 2 - (sum(widths) + gap * (len(parts) - 1)) / 2
                    for (w, col), wd in zip(parts, widths):
                        outlined(d, (x + wd / 2, y), w, fm, col, stroke=6)
                        x += wd + gap
                    y += 92 * S
                if ov.get("round") and sec >= ov["at"] + 0.9:  # Game 3: "ROUND 1", a beat after the match-up
                    outlined(d, (W / 2, y), ov["round"], font("constanb.ttf", 64), (240, 230, 214, 255), stroke=6)
            img.save(os.path.join(sdir, f"{i:04d}.png"))
        index[shot["id"]] = n
    json.dump({"step": STEP, "shots": index}, open(os.path.join(out, "index.json"), "w"), indent=1)
    print(f"[intro overlays] {sum(index.values())} images for {len(index)} shots")


if __name__ == "__main__":
    main(sys.argv[1])
