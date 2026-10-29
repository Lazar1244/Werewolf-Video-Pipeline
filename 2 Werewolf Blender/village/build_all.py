"""Build every location, write the manifest, then render preview stills with a sample cast.

    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --factory-startup --python village/build_all.py -- [--no-render] [--only Square,Room]

Writes:
    out/village.blend        the empty sets (scenes Square, Street, Clearing, Room); what the director uses
    out/manifest.json        every mark (position, facing) and camera (story moment, marks it covers) per scene
    out/village_demo.blend   the same sets with the sample cast at night (for looking around in Blender)
    out/previews/<Scene>_<Camera>_<moment>.png
"""
import json
import math
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
OUT = os.path.join(os.path.dirname(HERE), "out")
PREV = os.path.join(OUT, "previews")
os.makedirs(PREV, exist_ok=True)

import cast_demo  # noqa: E402
import common  # noqa: E402
import figures  # noqa: E402
import loc_clearing  # noqa: E402
import loc_room  # noqa: E402
import loc_square  # noqa: E402
import loc_street  # noqa: E402
from lighting import apply_preset  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
only = args[args.index("--only") + 1].split(",") if "--only" in args else None
render = "--no-render" not in args

LOCATIONS = [("Square", loc_square), ("Street", loc_street), ("Clearing", loc_clearing), ("Room", loc_room)]
# (cast variant, lighting preset, [(scene, camera), ...])
SHOTS = [
    ("night", "night", [("Square", "Square_Wide"), ("Square", "Square_High"), ("Square", "Square_Seat_3"), ("Square", "Square_Seat_6"), ("Square", "Square_Hunter"),
                        ("Street", "Street_Wide"), ("Street", "Street_Door_5"), ("Street", "Street_Peek"),
                        ("Clearing", "Clearing_Wide"), ("Clearing", "Clearing_Low"), ("Clearing", "Clearing_Rock"),
                        ("Room", "Room_Wide"), ("Room", "Room_Table"), ("Room", "Room_Window")]),
    ("dawn", "dawn", [("Square", "Square_Wide"), ("Square", "Square_Bodies")]),
    ("day", "day", [("Square", "Square_Seat_4"), ("Square", "Square_Seat_9"), ("Square", "Square_High"), ("Street", "Street_Wide")]),
    ("night", "night", [("Square", f"Square_Seat_{i}") for i in range(1, 11)] + [("Street", f"Street_Door_{i}") for i in range(1, 11)]),
    ("execution", "dusk", [("Square", "Square_Gallows"), ("Square", "Square_Crowd"), ("Square", "Square_Wide")]),
]

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
M = common.materials()
built = []
for name, mod in LOCATIONS:
    if only and name not in only:
        continue
    sc = mod.build(M)
    sc.camera = sc.objects.get(f"Cam_{name}_Wide") or next(o for o in sc.objects if o.type == "CAMERA")
    print(f"[village] built {name}: {len(sc.objects)} objects")
    built.append(sc)
default = bpy.data.scenes.get("Scene")
if default is not None and default not in built and len(bpy.data.scenes) > 1:
    bpy.data.scenes.remove(default)
figures.prebuild(M)  # every figure template, saved with the sets (fake user) for the director
bpy.data.orphans_purge(do_recursive=True)  # our own headless file: drop leftovers (templates keep a fake user)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "village.blend"))

# the manifest: what the director reads instead of guessing names
manifest = {}
for sc in built:
    marks = {o.name[5:]: {"loc": [round(v, 3) for v in o.location], "yaw": round(o.get("facing_yaw", 0.0), 4)}
             for o in sc.objects if o.name.startswith("Mark_")}
    cams = {o.name[4:]: {"moment": o.get("moment", ""), "covers": list(o.get("covers", [])), "lens": o.data.lens,
                         "loc": [round(v, 3) for v in o.location]} for o in sc.objects if o.type == "CAMERA"}
    tokens = sorted((o.name for o in sc.objects if o.name.startswith("Door_Token_")), key=lambda n: int(n.rsplit("_", 1)[1]))
    manifest[sc.name] = {"marks": marks, "cameras": cams, "tokens": tokens, "presets": ["night", "dawn", "day", "dusk"],
                         "head_z": {"sit": 1.74, "stand": 1.58, "speech_box_above_head": 0.45}}
with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=1)
print("[village] manifest:", {k: (len(v["marks"]), len(v["cameras"])) for k, v in manifest.items()})


def blur(a, radius):
    for _ in range(3):
        k = 2 * radius + 1
        c = np.cumsum(np.pad(a, ((radius + 1, radius), (0, 0), (0, 0)), mode="edge"), axis=0)
        a = (c[k:] - c[:-k]) / k
        c = np.cumsum(np.pad(a, ((0, 0), (radius + 1, radius), (0, 0)), mode="edge"), axis=1)
        a = (c[:, k:] - c[:, :-k]) / k
    return a


def finish(raw, final):
    """Soft glow around lights, a vignette and a faint grain (stills only; video gets animated grain later)."""
    img = bpy.data.images.load(raw)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    rgb = px[..., :3].copy()
    rgb = rgb + blur(np.clip(rgb - 0.7, 0, None), max(4, w // 140)) * 0.9
    yy, xx = np.mgrid[0:h, 0:w]
    r2 = ((xx / w - 0.5) * 2) ** 2 * 0.8 + ((yy / h - 0.5) * 2) ** 2
    rgb *= (1 - 0.42 * np.clip(r2, 0, 1.6) ** 1.6)[..., None]
    rgb += np.random.default_rng(3).normal(0, 1, (h, w, 1)).astype(np.float32) * 0.012
    px[..., :3] = np.clip(rgb, 0, 1)
    out = bpy.data.images.new("final", w, h, alpha=False)
    out.pixels.foreach_set(px.ravel())
    out.filepath_raw = final
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(img)
    bpy.data.images.remove(out)


def render_cam(sc, cam_name, tag):
    cam = sc.objects.get(f"Cam_{cam_name}")
    if cam is None:
        print(f"[village] no camera {cam_name}")
        return
    keep = sc.camera
    sc.camera = cam
    sc.render.resolution_percentage = 50
    raw = os.path.join(PREV, f"{sc.name}_{cam_name}_{tag}_raw.png")
    sc.render.filepath = raw
    bpy.ops.render.render(write_still=True, scene=sc.name)
    finish(raw, os.path.join(PREV, f"{sc.name}_{cam_name}_{tag}.png"))
    os.remove(raw)
    sc.camera = keep
    sc.render.resolution_percentage = 100
    print(f"[village] preview {sc.name}/{cam_name}_{tag}")


if render:
    names = {sc.name for sc in built}
    for f in os.listdir(PREV):
        os.remove(os.path.join(PREV, f))
    for variant, preset, shots in SHOTS:
        cast_demo.populate(M, variant)
        for scene_name in {s for s, _ in shots} & names:
            apply_preset(bpy.data.scenes[scene_name], preset)
        # regression check: a preset must never strip a figure's seat colour
        for sc in built:
            for o in sc.objects:
                if o.get("demo") and o.name.split(".")[0] in ("Scarf", "HoodRim", "Sleeve"):
                    got = o.material_slots[0].material.name
                    assert got.startswith("SeatGlow"), f"{sc.name}/{o.name}: seat colour lost after '{preset}' ({got})"
        for scene_name, cam_name in shots:
            if scene_name in names:
                render_cam(bpy.data.scenes[scene_name], cam_name, variant)
        for sc in built:
            apply_preset(sc, "night")
cast_demo.populate(M, "night")
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "village_demo.blend"))
print("[village] done")
