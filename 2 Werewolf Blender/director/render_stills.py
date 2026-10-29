"""Step 3 (inside Blender): render each unique shot of an episode once, and record where every head is on screen.

    blender --background out/village.blend --python director/render_stills.py -- <id8> [--size 1280x720]

Stills are cached in games/<id8>/stills/<hash>.png, keyed by the shot (scene, camera, light, cast, tokens) and
the set file's build time, so a re-run only renders shots that changed. meta.json gives, per still, each cast
member's head position in pixels (and whether it's on screen), for the text overlays.
"""
import hashlib
import json
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # this Blender folder ("2 Werewolf Blender")
sys.path.insert(0, os.path.join(BASE, "village"))
import common  # noqa: E402
from figures import figure, seat_mat  # noqa: E402
from lighting import apply_preset  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
gid = args[0]
W, H = (int(v) for v in (args[args.index("--size") + 1] if "--size" in args else "1280x720").split("x"))  # even sizes (video needs them)
GDIR = os.path.join(BASE, "games", gid)
SDIR = os.path.join(GDIR, "stills")
os.makedirs(SDIR, exist_ok=True)
ep = json.load(open(os.path.join(GDIR, "episode.json"), encoding="utf-8"))
build = str(int(os.path.getmtime(bpy.data.filepath)))  # a rebuilt set invalidates the cache

M = common.materials()
meta_path = os.path.join(SDIR, "meta.json")
meta = json.load(open(meta_path, encoding="utf-8")) if os.path.exists(meta_path) else {}


def key_of(shot):
    return hashlib.sha1((json.dumps(shot, sort_keys=True) + build + f"{W}x{H}").encode()).hexdigest()[:14]


def clear_cast(sc):
    for o in [o for o in sc.objects if o.get("cast")]:
        bpy.data.objects.remove(o, do_unlink=True)
    for o in sc.objects:
        if o.name.startswith("Door_Token_") and o.material_slots and o.material_slots[0].link == "OBJECT":
            o.material_slots[0].link = "DATA"  # back to the blank plaque


shots = {}
for b in ep["beats"]:
    b["still"] = key_of(b["shot"])
    shots[b["still"]] = b["shot"]
todo = [k for k in shots if not (os.path.exists(os.path.join(SDIR, k + ".png")) and k in meta)]
print(f"[stills] {len(shots)} unique, {len(todo)} to render")
for n, k in enumerate(todo):
    shot = shots[k]
    sc = common.use_scene(shot["scene"])
    clear_cast(sc)
    apply_preset(sc, shot["preset"])
    heads = {}
    for m in shot["cast"]:
        mk = sc.objects.get(f"Mark_{m['mark']}")
        if mk is None:
            print(f"[stills] missing mark {m['mark']} in {sc.name}")
            continue
        root, head = figure(M, f"C{m['seat']}", tuple(mk.location), mk["facing_yaw"], m["seat"], m["role"], pose=m["pose"], night=m["night"],
                            sheriff=m["sheriff"], clawed=m.get("clawed", False), lean=m.get("lean") or mk.get("lean", 0.0))
        for o in [root, *root.children_recursive]:
            o["cast"] = True
        heads[m["seat"]] = Vector(head)
    for tok, seat in shot.get("tokens", {}).items():
        o = sc.objects.get(tok)
        if o is not None:
            o.material_slots[0].link = "OBJECT"
            o.material_slots[0].material = seat_mat(seat)
    cam = sc.objects[f"Cam_{shot['camera']}"]
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = W, H, 100
    sc.render.filepath = os.path.join(SDIR, k + ".png")
    bpy.ops.render.render(write_still=True, scene=sc.name)
    info = {}
    for seat, h in heads.items():
        v = world_to_camera_view(sc, cam, h)
        info[str(seat)] = [round(v.x * W, 1), round((1 - v.y) * H, 1), bool(v.z > 0 and 0 <= v.x <= 1 and 0 <= v.y <= 1), round(v.z, 2)]
    meta[k] = {"scene": sc.name, "camera": shot["camera"], "preset": shot["preset"], "heads": info, "size": [W, H]}
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    print(f"[stills] {n + 1}/{len(todo)} {sc.name}/{shot['camera']} ({shot['preset']}) -> {k}.png")
for sc_name in {s["scene"] for s in shots.values()}:
    clear_cast(bpy.data.scenes[sc_name])
    apply_preset(bpy.data.scenes[sc_name], "night")
with open(os.path.join(GDIR, "episode.json"), "w", encoding="utf-8") as f:  # beats now carry their still's key
    json.dump(ep, f, ensure_ascii=False, indent=1)
print("[stills] done")
