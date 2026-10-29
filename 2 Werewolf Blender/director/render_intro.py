"""Render the intro's stage shots (inside Blender, on out/intro.blend):

    blender --background out/intro.blend --python director/render_intro.py -- <id8> [--plan short] [--preview]

For every "stage" shot in games/<id8>/intro/intro_plan.json:
- an eased dolly toward the subject (push = fraction of the distance);
- the figures breathe and blink, and the fires and candles flicker (village/animate.py);
- per-shot effects, set frame by frame:
  - spots_on: the spotlights snap on one by one;
  - red_eyes: each contestant's eyes flash red in turn; with red_eyes_hold (Game 3) they turn red in turn and stay red;
  - shadow_slide: the wolf's shadow slides along the wall.
Frames are rendered on twos at the plan's size (1280x720 by default) with the previews' glow pass, into
games/<id8>/<plan>/clips/<shot id>/####.png. Shots already rendered (same spec) are skipped.
--plan short: the vertical Short (games/<id8>/short/, 1080x1920; short_intro.py). Upright, a shot's "vfit" sets how
much taller than its 16:9 view the frame sees (1 = the same height: the centre of the original framing), and "aim"
re-aims the camera at its subject first. --preview: only each shot's first frame, into <plan>/preview/<shot id>.png.
"""
import hashlib
import json
import math
import os
import sys

import bpy
from mathutils import Vector

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "village"))
import animate  # noqa: E402
from intro_stages import glow_finish  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
gid = args[0]
GDIR = os.path.join(BASE, "games", gid, args[args.index("--plan") + 1] if "--plan" in args else "intro")
import colors  # noqa: E402  (village/colors.py: each model keeps its colour, owner 2026-10-27)
colors.use_game(gid)
PREVIEW = "--preview" in args
plan = json.load(open(os.path.join(GDIR, "intro_plan.json"), encoding="utf-8"))
W, H = plan.get("size", [1280, 720])
STEP, L = 2, 48


def ease(t):
    return t * t * (3 - 2 * t)


def subject(sc, cam):
    """The mark nearest the camera's line of sight: what the dolly pushes toward."""
    fwd = cam.matrix_world.to_3x3() @ Vector((0, 0, -1))
    best, bd = None, 1e9
    for o in sc.objects:
        if o.name.startswith("Mark_"):
            v = o.location + Vector((0, 0, 1.4)) - cam.location
            off = (v - fwd * v.dot(fwd)).length
            if v.dot(fwd) > 0 and off < bd:
                best, bd = o, off
    return (best.location + Vector((0, 0, 1.4))) if best else cam.location + fwd * 5.0


def visibility(sc, cam):
    for o in sc.objects:
        if o.get("only_cam"):
            o.hide_render = o["only_cam"] != cam.name[4:]
        if o.get("hide_cam"):
            o.hide_render = cam.name[4:] in o["hide_cam"].split(",")


def roots_by_seat(sc):
    return {o["anim"]["seat"]: o for o in sc.objects if o.get("anim") and o.parent is None}


for shot in plan["shots"]:
    if shot["source"] != "stage":
        continue
    keys = ("scene", "camera", "frames", "push", "effects") + (("vfit", "aim") if H > W else ())
    spec = json.dumps({k: shot.get(k) for k in keys} | ({"size": [W, H]} if H > W else {}) | ({"colours": colors.signature()} if colors.signature() else {}), sort_keys=True)
    tag = hashlib.sha1(spec.encode()).hexdigest()[:10]
    out = os.path.join(GDIR, "clips", shot["id"])
    frames = [0] if PREVIEW else list(range(0, shot["frames"], STEP))
    if not PREVIEW and os.path.exists(os.path.join(out, "spec.txt")) and open(os.path.join(out, "spec.txt")).read() == tag and \
            all(os.path.exists(os.path.join(out, f"{f:04d}.png")) for f in frames):
        continue
    os.makedirs(out, exist_ok=True)
    sc = bpy.data.scenes[shot["scene"]]
    if bpy.context.window is not None:
        bpy.context.window.scene = sc  # drivers (the figures' life) only run in the window's scene
    cam = sc.objects[f"Cam_{shot['camera']}"]
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = W, H, 100
    visibility(sc, cam)
    loc0, rot0 = cam.location.copy(), cam.rotation_euler.copy()
    sens0 = (cam.data.sensor_fit, cam.data.sensor_height)
    target = subject(sc, cam)
    if H > W:  # upright: see vfit x the 16:9 frame's height, re-aimed at the subject if asked
        if shot.get("aim"):
            cam.rotation_euler = (target - loc0).to_track_quat("-Z", "Y").to_euler()
        cam.data.sensor_fit = "VERTICAL"
        cam.data.sensor_height = cam.data.sensor_width * 9 / 16 * shot.get("vfit", 1.0)
    end = loc0 + (target - loc0) * shot.get("push", 0.0)
    animate.clear_world_motion(sc)
    for root in roots_by_seat(sc).values():
        animate.figure_motion(root, "idle", L)
    animate.world_motion(sc, L)
    fx = shot.get("effects") or {}
    spots = sorted([o for o in sc.objects if o.type == "LIGHT" and o.name.startswith("Spot")], key=lambda o: o.name)
    spot_e = {o.name: o.data.energy for o in spots}
    pools = sorted([o for o in sc.objects if o.name.startswith(("SpotPool", "Beam"))], key=lambda o: o.name)
    seats = roots_by_seat(sc)
    eye_mat = bpy.data.materials.get("WolfEye")
    eyes = {name: bpy.data.objects[name] for root in seats.values() for name in root["anim"]["eyes"] if name in bpy.data.objects}
    eye_own = {name: (o.material_slots[0].material if o.material_slots else None) for name, o in eyes.items()}
    wall = sc.objects.get("WallWolf")
    wall_x = wall.location.x if wall else 0.0
    for f in frames:
        t = f / max(1, shot["frames"] - 1)
        cam.location = loc0.lerp(end, ease(t))
        sec = f / plan["fps"]
        if "spots_on" in fx:  # snap on, one by one
            for k, o in enumerate(spots):
                o.data.energy = spot_e[o.name] if sec >= k * fx["spots_on"] else 0.0
            for o in pools:
                # the number before any ".001" (a second stage's copies of Beam1, SpotPool1... get that suffix)
                k = int("".join(ch for ch in o.name.split(".")[0] if ch.isdigit()) or 1) - 1
                o.hide_render = sec < k * fx["spots_on"]
        if "red_eyes" in fx and eye_mat:  # each contestant's eyes flash red in turn
            order = fx["red_eyes"]
            slot = int((sec - 0.6) / 0.38) if sec >= 0.6 else -1
            for k, seat in enumerate(order):
                root = seats.get(seat)
                if not root:
                    continue
                red = (k == slot) or (fx.get("red_eyes_hold", False) and 0 <= slot and k <= slot)
                for name in root["anim"]["eyes"]:
                    e = eyes.get(name)
                    if e and e.material_slots:
                        e.material_slots[0].link = "OBJECT"
                        e.material_slots[0].material = eye_mat if red else eye_own[name]
        if fx.get("shadow_slide") and wall:  # the wolf's shadow slides in along the wall
            wall.location.x = wall_x - 0.9 * (1 - ease(min(1.0, t / 0.7)))  # stays on the lit wall (no shadow in mid-air)
        sc.frame_set(f)
        path = os.path.join(GDIR, "preview", f"{shot['id']}.png") if PREVIEW else os.path.join(out, f"{f:04d}.png")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True, scene=sc.name)
        glow_finish(path)
    cam.location, cam.rotation_euler = loc0, rot0  # leave the set as it was
    cam.data.sensor_fit, cam.data.sensor_height = sens0
    for o in spots:
        o.data.energy = spot_e[o.name]
    for o in pools:
        o.hide_render = False
    if wall:
        wall.location.x = wall_x
    for name, e in eyes.items():
        if e.material_slots and e.material_slots[0].link == "OBJECT":
            e.material_slots[0].link = "DATA"
    if PREVIEW:
        continue
    with open(os.path.join(out, "spec.txt"), "w") as fh:
        fh.write(tag)
    print(f"[intro] {shot['id']}: {len(frames)} frames", flush=True)
print("[intro] render done")
