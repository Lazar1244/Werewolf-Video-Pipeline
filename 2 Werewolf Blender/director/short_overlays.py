"""The vertical Short's text layer (plain Python + Pillow): one transparent 1080x1920 image per 2 frames of each shot.

    python director/short_overlays.py <id8> [--plan short2]

The intro's look (intro_overlays.py: the same fonts, boxes, inner-voice haze and colours), laid out for a phone:
everything stays inside the Shorts safe area (clear of the top bar, the title and buttons at the bottom, and the
button column on the right). Kinds (games/<id8>/short/intro_plan.json, "overlay"):
  say    the wolf's speech box typing out under it
  think  the red inner-voice haze round the wolf, the thought box typing out, and SECRETLY A WEREWOLF; with "fx":
         "dimension" (Game 2 on): the NEW inner voice (thought_fx.py, as intro_overlays.py): whole opaque frames
         from the upright clip and its data map (<plan>/gclips/<map>), the rings following the voice, a 6% push in
  name   a contestant's full model name, big, in its seat colour (the roll-call)
  role   the role's name, huge, in its key colour, with its three-word caption
  title  WEREWOLF / AI EDITION and FULL GAME ON THE CHANNEL, from the moment the host says "Let's play"
  card   a death card for the phone (Game 2 Short 3): the name in its seat colour, "was the Seer", the cause, the
         model, near the top over the fire, so the body stays fully in view (the game's compact card is in the corner; a
         phone has no corner to spare, and under the body the card covered it)
"cta" on a say/think overlay: FULL GAME ON THE CHANNEL under the box once the line has typed out (Game 2 Short).
Captions (plan "captions"): the host's words (plan "caption_speakers", default ["Host"]: Short 3 adds the Narrator),
a few at a time, big, as they are said (Shorts are often watched
muted); not over the roll-call (its names are the words), the cold open (it has its own boxes) or the title.
Output: games/<id8>/short/overlays/<shot id>/####.png and index.json.
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
STEP, CPS = 2, 26
FONTS = "C:/Windows/Fonts/"
ROLE_COLOUR = {"WEREWOLF": (235, 55, 45), "SEER": (90, 175, 255), "WITCH": (190, 90, 255), "VILLAGER": (255, 175, 60)}
PUNCT = (".", ",", "?", "!", ":", ";")


def font(name, size):
    return ImageFont.truetype(FONTS + name, size)


def outlined(d, xy, text, f, fill, anchor="mm", stroke=6):
    d.text(xy, text, font=f, fill=fill, anchor=anchor, stroke_width=stroke, stroke_fill=(8, 6, 12, 255))


def fitted(d, text, name, size, width):
    """The font at `size`, or smaller until the text fits `width`."""
    f = font(name, size)
    while d.textlength(text, font=f) > width and size > 20:
        size -= 4
        f = font(name, size)
    return f


def chunks(text, fits, most=3):
    """The line in groups of up to `most` words that fit on one caption line (fits(words) -> bool), breaking after
    punctuation, each with a weight for its timing."""
    out, cur = [], []
    for w in text.split():
        if cur and not fits(cur + [w]):
            out.append(cur)
            cur = []
        cur.append(w)
        if len(cur) >= most or w.endswith(PUNCT) or w.endswith("..."):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return [(" ".join(c), sum(len(w) + 1 for w in c) + sum(4 for w in c if w.endswith("..."))) for c in out]


def caption_track(plan, starts, fits):
    """frame -> the caption chunk on screen, over the whole Short (lines run across their shot's cuts)."""
    fps, track = plan["fps"], {}
    for shot in plan["shots"]:
        k = shot.get("voice")
        if not k or plan["voices"][k]["speaker"] not in plan.get("caption_speakers", ["Host"]):
            continue
        v = plan["voices"][k]
        t0 = starts[shot["id"]] + shot.get("voice_at", 0)
        parts = chunks(v["text"], fits)
        total = sum(w for _, w in parts)
        at = t0
        for n, (words, w) in enumerate(parts):
            end = t0 + round(v["seconds"] * fps * sum(x for _, x in parts[:n + 1]) / total)
            for fr in range(at, end + (4 if n == len(parts) - 1 else 0)):
                track[fr] = words
            at = end
    return track


def text_box(d, W, H, left, right, text, shown, seat, thought):
    """The phone's speech / thought box: full width at 60% down, keeping its final size while the text types out."""
    f = font("constani.ttf" if thought else "constan.ttf", 64)
    lines = wrap(d, shown, f, int(right - left - 60))
    full = wrap(d, text, f, int(right - left - 60))
    pad, lh = 30, 78
    bh = len(full) * lh + pad * 2 + (40 if thought else 0)
    x0, x1 = left - 20, right + 20
    y0 = H * 0.60
    if thought:
        box(d, (x0, y0, x1, y0 + bh), fill=(28, 10, 14, 215), edge=(220, 60, 50, 235), radius=18, edge_w=6)
        d.text((x0 + pad + 8, y0 + pad - 6), "thinks…", font=font("constan.ttf", 36), fill=(230, 140, 130, 255))
    else:
        box(d, (x0, y0, x1, y0 + bh), edge=rgb(seat), radius=18, edge_w=6)
    for j, l in enumerate(lines):
        d.text((x0 + pad + 10, y0 + pad + (40 if thought else 0) + j * lh), l, font=f, fill=(244, 238, 230, 255))


def cta(d, ov, sec, mid, width, H):
    """FULL GAME ON THE CHANNEL, on a dark panel just under the box (the top is the speaker's name sign), once the
    line has typed out; still above the Short's title and buttons."""
    if ov.get("cta") and sec >= len(ov["text"]) / CPS + 0.4:
        f = fitted(d, ov["cta"], "constanb.ttf", 76, width - 40)
        y = H * 0.725
        tw = d.textlength(ov["cta"], font=f)
        box(d, (mid - tw / 2 - 34, y - 62, mid + tw / 2 + 34, y + 62), fill=(10, 8, 14, 225), edge=(235, 60, 45, 255), radius=18, edge_w=6)
        outlined(d, (mid, y), ov["cta"], f, (245, 238, 225, 255), stroke=6)


def dimension_frames(sdir_root, plan, shot, ov, sdir, n, vig, head, layout):
    """The new inner voice (owner-approved 2026-10-22, FullGameFolder/Game 2/Inner voice/HOW_IT_WAS_MADE.txt), upright:
    intro_overlays.dimension_frames() with the phone's box (fixed in place, so the push in never moves it)."""
    import numpy as np
    from thought_fx import envelope, read_map, ring_births, thought_frame
    W, H, left, right = layout
    cdir = os.path.join(sdir_root, "gclips", shot["clip"])
    mdir = os.path.join(sdir_root, "gclips", ov["map"])
    far = json.load(open(os.path.join(mdir, "map.json"), encoding="utf-8"))["far"]
    frames = sorted(f for f in os.listdir(cdir) if f.endswith(".png"))
    fps = plan["fps"]
    lead = shot.get("voice_at", 0) / fps
    env = envelope(plan["voices"][ov["voice"]]["file"])
    births = [b + lead for b in ring_births(env)]
    env = np.concatenate([np.zeros(int(lead * fps)), env])
    hx, hy = head
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
        d = ImageDraw.Draw(pic)
        shown = ov["text"][: max(1, int((sec - lead) * CPS))] if sec > lead else ""
        if shown:
            text_box(d, W, H, left, right, ov["text"], shown, ov["seat"], True)
        cta(d, ov, sec - lead, (left + right) / 2, right - left, H)
        pic.save(os.path.join(sdir, f"{i:04d}.png"))
    return n


def main(gid):
    import colors  # village/colors.py: each seat in its model's colour (owner, 2026-10-27)
    colors.use_game(gid)
    gdir = os.path.join(BASE, "games", gid)
    sdir_root = os.path.join(gdir, sys.argv[sys.argv.index("--plan") + 1] if "--plan" in sys.argv else "short")
    plan = json.load(open(os.path.join(sdir_root, "intro_plan.json"), encoding="utf-8"))
    W, H = plan["size"]
    meta = {}
    gclips = os.path.join(sdir_root, "gclips")
    for fn in os.listdir(gclips) if os.path.isdir(gclips) else []:
        if fn.startswith("meta_") and fn.endswith(".json"):
            meta.update(json.load(open(os.path.join(gclips, fn), encoding="utf-8")))

    def head_of(clip, seat):
        h = meta.get(clip, {}).get("heads", {}).get(str(seat))
        return (h[0], h[1]) if h else (W * 0.5, H * 0.45)

    starts, fr = {}, 0
    for shot in plan["shots"]:
        starts[shot["id"]] = fr
        fr += shot["frames"]
    left, right = 70, W - 150  # clear of the button column on the right
    mid = (left + right) / 2
    cap_font = font("constanb.ttf", 88)
    probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    track = caption_track(plan, starts, lambda ws: probe.textlength(" ".join(ws).upper(), font=cap_font) <= right - left)         if plan.get("captions") else {}
    out = os.path.join(sdir_root, "overlays")
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
            index[shot["id"]] = dimension_frames(sdir_root, plan, shot, ov, sdir, n, vig, head_of(shot["clip"], ov["seat"]), (W, H, left, right))
            continue
        if kind == "think":
            base = Image.alpha_composite(base, inner_voice(W, H, head_of(shot["clip"], ov["seat"]), {"wolf": True}))
        for i in range(n):
            sec = i * STEP / plan["fps"]
            img = base.copy()
            d = ImageDraw.Draw(img)
            title_on = kind == "title" and sec >= ov["at"]
            if kind in ("say", "think"):
                shown = ov["text"][: max(1, int((sec - 0.05) * CPS))] if sec > 0.05 else ""
                if shown:
                    text_box(d, W, H, left, right, ov["text"], shown, ov["seat"], kind == "think")
                cta(d, ov, sec - 0.05, mid, right - left, H)
                if kind == "think" and ov.get("caption") and sec >= 0.6:
                    outlined(d, (mid, H * 0.135), ov["caption"], fitted(d, ov["caption"], "constanb.ttf", 100, right - left), (240, 50, 40, 255), stroke=8)
            elif kind == "name":
                name = ov["text"].upper()
                outlined(d, (mid, H * 0.70), name, fitted(d, name, "constanb.ttf", 96, right - left), rgb(ov["seat"]), stroke=7)
            elif kind == "role":
                col = ROLE_COLOUR.get(ov["role"], (240, 230, 210)) + (255,)
                outlined(d, (mid, H * 0.14), ov["role"], fitted(d, ov["role"], "constanb.ttf", 170, right - left), col, stroke=8)
                outlined(d, (mid, H * 0.14 + 140), ov["caption"], font("constanb.ttf", 62), (245, 238, 225, 255), stroke=6)
            elif kind == "card":
                x0, x1, y0 = left - 20, right + 20, H * 0.11  # over the fire: under the body it covered the body
                fn, fr, fc, fm = font("constanb.ttf", 104), font("constanb.ttf", 66), font("constanb.ttf", 56), font("constan.ttf", 40)
                bh = 104 * 1.15 + 66 * 1.4 + 56 * 1.4 + 40 + 70
                box(d, (x0, y0, x1, y0 + bh), fill=(10, 8, 14, 225), edge=rgb(ov["seat"]), radius=18, edge_w=8)
                y = y0 + 30
                d.text((mid, y), ov["name"].upper(), font=fn, fill=rgb(ov["seat"]), anchor="mt")
                y += 104 * 1.15
                d.text((mid, y), f"was {ov['role']}", font=fr, fill=(236, 228, 214, 255), anchor="mt")
                y += 66 * 1.4
                d.text((mid, y), ov["cause"], font=fc, fill=(220, 90, 80, 255), anchor="mt")
                d.text((mid, y + 56 * 1.4), ov["model"], font=fm, fill=(180, 175, 190, 255), anchor="mt")
            elif title_on:
                d.rectangle((0, 0, W, H), fill=(0, 0, 0, 100))
                outlined(d, (W / 2, H * 0.40), ov["text"], fitted(d, ov["text"], "constanb.ttf", 190, W - 120), (240, 230, 214, 255), stroke=9)
                outlined(d, (W / 2, H * 0.40 + 150), ov["sub"], font("constanb.ttf", 76), (235, 60, 45, 255), stroke=7)
                if ov.get("cta") and sec >= ov["at"] + 0.8:
                    outlined(d, (W / 2, H * 0.62), ov["cta"], fitted(d, ov["cta"], "constanb.ttf", 60, W - 160), (245, 238, 225, 255), stroke=6)
            words = track.get(starts[shot["id"]] + i * STEP)
            if words and kind not in ("name", "say", "think", "card") and not title_on:
                outlined(d, (mid, H * 0.665), words.upper(), cap_font, (255, 255, 255, 255), stroke=9)
            img.save(os.path.join(sdir, f"{i:04d}.png"))
        index[shot["id"]] = n
    json.dump({"step": STEP, "shots": index}, open(os.path.join(out, "index.json"), "w"), indent=1)
    print(f"[short overlays] {sum(index.values())} images for {len(index)} shots")


if __name__ == "__main__":
    main(sys.argv[1])
