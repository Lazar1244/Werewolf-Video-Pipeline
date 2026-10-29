"""The inner voice, NEW LOOK (owner idea, 2026-10-22; a sample for the owner to approve before it replaces the red haze):
the world darkens into another dimension: the village (houses, campfire, ground) stays readable but dim, the other
players turn into barely visible see-through silhouettes, and the thinker alone keeps their colours. While they think
out loud, thin red rings spread from the thinker's FEET across the surfaces of the village (the ground, logs, walls),
never over the other players, one about every second, like drops falling into water; each ring's edge trembles a
little with the voice's loudness.

It needs a data map per frame next to the clip (render_clips.py --maps <thinker seat>): R = each surface's distance from
the thinker's feet (/ "far" m), G = what it is (0 village, 0.5 another player or their sign, 1 the thinker or their sign).

    blender --background out/village.blend --python director/render_clips.py -- <id8> --only <clip> --size 1920x1080 --maps <seat>
    python director/thought_fx.py sample        -> games/06ce0859/samples/thought_fx/ (frames + sample.json)

thought_frame() makes one frame and is meant to be reused by the video's text layers (approved 2026-10-22).
The full story (design rounds, every setting, the problems met): FullGameFolder/Game 2/Inner voice/HOW_IT_WAS_MADE.txt.
Sample MP4: director/encode_sample.py.
"""
import json
import math
import os
import sys
import wave

import cv2
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIPE = os.path.dirname(BASE)
FPS = 24

VILLAGE = 0.30         # how bright the village stays (houses, campfire, ground still readable)
DESAT = 0.45           # how much colour the village loses
GHOST = 0.07           # what is left of the other players: a barely visible see-through silhouette...
GHOST_EDGE = 0.30      # ...with a faint pale rim, so their shape still reads
RING_EVERY = 1.0       # s between rings while the voice is on
RING_SPEED = 3.6       # m per second, outward from the thinker's feet
RING_LIFE = 3.4        # s a ring lives (it fades out as it travels)
RING_WIDTH = 0.11      # m (thicker near the camera, thinner far away, as a real ripple on the ground)
WOBBLE = 0.09          # m: the edge's tremble at full voice ("a bit" of the sound)
RED = np.array([255, 42, 38], dtype=np.float32)
LIGHT_BLUE = np.array([120, 200, 255], dtype=np.float32)  # owner, 2026-10-27 (Game 3 on): the rings of a non-wolf's thought


def envelope(wav_path):
    """The voice's loudness per video frame, 0..1 (smoothed)."""
    with wave.open(wav_path, "rb") as w:
        sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
        a = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32)
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    hop = sr // FPS
    rms = np.array([np.sqrt(np.mean(a[i:i + hop] ** 2)) for i in range(0, len(a), hop)] or [0.0])
    rms = np.convolve(rms, np.ones(3) / 3, mode="same")
    return rms / (rms.max() or 1.0)


def ring_births(env, threshold=0.12):
    """A ring every RING_EVERY seconds while the voice is on (the first one on the first word)."""
    births, last = [], -1e9
    for i, e in enumerate(env):
        t = i / FPS
        if e > threshold and t - last >= RING_EVERY:
            births.append(t)
            last = t
    return births


def read_map(path, far):
    """(distance from the thinker's feet in m, class 0 / 0.5 / 1) from a 16-bit data map (undoing its sRGB encoding)."""
    m = cv2.imread(path, cv2.IMREAD_UNCHANGED)[..., ::-1].astype(np.float32) / 65535.0
    lin = np.where(m <= 0.04045, m / 12.92, ((m + 0.055) / 1.055) ** 2.4)
    return lin[..., 0] * far, lin[..., 1]


def thought_frame(beauty, dist, cls, t, env, births, feet_px, colour=RED):
    """One finished frame (RGB uint8 array) from the clip's picture and its data map. `colour`: the rings (RED for a
    wolf's thought, LIGHT_BLUE for anyone else's)."""
    img = beauty.astype(np.float32)
    thinker = np.clip((cls - 0.75) / 0.2, 0, 1)[..., None]
    player = np.clip(1 - np.abs(cls - 0.5) / 0.2, 0, 1)[..., None]
    village = np.clip(1 - thinker - player, 0, 1)
    grey = img.mean(axis=2, keepdims=True)
    dim = (img * (1 - DESAT) + grey * DESAT) * VILLAGE
    pm = (player[..., 0] * 255).astype(np.uint8)
    rim = cv2.morphologyEx(pm, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)).astype(np.float32)[..., None] / 255
    # see-through: what is behind a player is guessed from the village around them (inpainted at a quarter size)
    h4, w4 = dim.shape[0] // 4, dim.shape[1] // 4
    small = cv2.resize(dim.clip(0, 255).astype(np.uint8), (w4, h4), interpolation=cv2.INTER_AREA)
    hole = cv2.dilate(cv2.resize(pm, (w4, h4)), np.ones((3, 3), np.uint8))
    behind = cv2.resize(cv2.inpaint(small, hole, 5, cv2.INPAINT_TELEA), (dim.shape[1], dim.shape[0])).astype(np.float32)
    ghost = behind * (1 - GHOST * 4) + dim * GHOST / VILLAGE * 4 * GHOST + rim * GHOST_EDGE * np.array([200, 205, 225], dtype=np.float32)
    out = img * thinker + ghost * player + dim * village
    # the rings: on the village's surfaces only
    e = env[min(len(env) - 1, int(t * FPS))] if len(env) else 0.0
    h, w = dist.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ang = np.arctan2(yy - feet_px[1], xx - feet_px[0])
    ring = np.zeros_like(dist)
    for b in births:
        age = t - b
        if age < 0 or age > RING_LIFE:
            continue
        r = RING_SPEED * age
        fade = (1 - age / RING_LIFE) ** 1.5
        rr = r + WOBBLE * e * np.sin(14 * ang + 7 * t) * np.sin(5 * ang - 3 * t + b)
        ring = np.maximum(ring, np.exp(-((dist - rr) / RING_WIDTH) ** 2) * fade)
    ring *= village[..., 0]
    glow = cv2.GaussianBlur(ring, (0, 0), w / 400)
    out += (ring[..., None] * 0.95 + glow[..., None] * 0.6) * colour
    return out.clip(0, 255).astype(np.uint8)


def sample():
    gid = "06ce0859"
    gdir = os.path.join(BASE, "games", gid)
    # the game's own shots for beat 144 (plan.json): the camera glides from Gemini to Sol, then Sol's thinking loop
    move, clip, seat = "43f6c735e050c5", "12b84d358715e0", 2  # Sol: "Gemini has put the cards together, and she's right about Astra and me."
    text = "Gemini has put the cards together, and she's right about Astra and me."
    cdir, mdir = os.path.join(gdir, "clips", clip), os.path.join(gdir, "clips", f"{clip}_map{seat}")
    info = json.load(open(os.path.join(mdir, "map.json"), encoding="utf-8"))
    meta = {}
    for fn in os.listdir(gdir):
        if fn.startswith("meta_") and fn.endswith(".json"):
            meta.update(json.load(open(os.path.join(gdir, fn), encoding="utf-8")))
    head = tuple(meta[clip]["heads"][str(seat)])
    wav = os.path.join(PIPE, "FullGameFolder", gid, "samples", "sol_thought.wav")
    env = envelope(wav)
    lead = 0.6  # s of the new dimension before the voice starts
    fade_in = 10  # frames: the world sinks into the other dimension as the thought begins
    births = [b + lead for b in ring_births(env)]
    env = np.concatenate([np.zeros(int(lead * FPS)), env])
    n = len(env) + FPS  # one more second after the voice
    frames = sorted(f for f in os.listdir(cdir) if f.endswith(".png"))
    import intro_overlays as io  # the thought box, the same as the intro's
    out = os.path.join(gdir, "samples", "thought_fx")
    os.makedirs(out, exist_ok=True)
    for f in os.listdir(out):
        os.remove(os.path.join(out, f))
    first = Image.open(os.path.join(cdir, frames[0]))
    io.W, io.H = first.size
    io.S = io.W / 1280
    mframes = sorted(f for f in os.listdir(os.path.join(gdir, "clips", move)) if f.endswith(".png"))
    for i, fn in enumerate(mframes):  # the glide to Sol, as in the game: the ordinary look
        Image.open(os.path.join(gdir, "clips", move, fn)).convert("RGB").save(os.path.join(out, f"{i:04d}.png"))
    for i in range(n):
        t = i / FPS
        fn = frames[(i // 2) % len(frames)]
        beauty = np.asarray(Image.open(os.path.join(cdir, fn)).convert("RGB"))
        dist, cls = read_map(os.path.join(mdir, fn), info["far"])
        y, x = np.unravel_index(np.argmin(np.where(cls < 0.25, dist, 1e9)), dist.shape)  # the ground right at the feet
        img = thought_frame(beauty, dist, cls, t, env, births, (x, y))
        k = min(1.0, (i + 1) / fade_in)
        img = (beauty * (1 - k) + img * k).astype(np.uint8)
        z = 1 + 0.06 * i / n  # the slow push in toward the thinker
        H, W = img.shape[:2]
        cw, ch = W / z, H / z
        x0, y0 = min(max(0, head[0] - cw / 2), W - cw), min(max(0, head[1] - ch / 2), H - ch)
        pic = Image.fromarray(img).crop((x0, y0, x0 + cw, y0 + ch)).resize((W, H), Image.LANCZOS).convert("RGBA")
        hz = ((head[0] - x0) * z, (head[1] - y0) * z)
        if t > lead:
            io.speech_box(ImageDraw.Draw(pic), hz[0], hz[1], text[: max(1, int((t - lead) * io.CPS))], seat, thought=True)
        pic.convert("RGB").save(os.path.join(out, f"{len(mframes) + i:04d}.png"))
    json.dump({"frames": len(mframes) + n, "fps": FPS, "voice": wav, "voice_at": len(mframes) / FPS + lead},
              open(os.path.join(out, "sample.json"), "w"))
    print(f"[thought_fx] {n} frames, {len(births)} rings -> {out}")


if __name__ == "__main__":
    if sys.argv[1:] == ["sample"]:
        sample()
