"""Game 2's Short 3 thumbnail (owner, 2026-10-26): ONLY Astra (GPT-6 Astra, seat 5, white collar) with the OpenAI logo,
filling almost the whole vertical frame, in the same red world as the other thumbnails (black floor, glowing red
grid, red fog, warm key, red rims). No text. A NEW script; it borrows make_thumbnails.py / make_thumbnails_g2.py's parts
and changes neither.

    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --factory-startup --python thumbnail/make_short3_thumbnail_g2.py

The villain shot (owner, same day): the camera low by Astra's feet, looking up through a wide lens (a slightly warped,
looming perspective), Astra's head bowed to stare down at the viewer.
Astra is the plain figure (no wolf ears, no red eyes): the Short reveals her side in its first second, the thumbnail
does not (spoiler rule: nothing on a thumbnail points at a real wolf).
Writes Game 2/short_3.png.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_thumbnails_g2 as g2  # noqa: E402  (sets Game 2's output folder and models; its __main__ does not run)

mt = g2.mt
add, camera, fog_box, glow, light, toon, common = mt.add, mt.camera, mt.fog_box, mt.glow, mt.light, mt.toon, mt.common

W, H = 1080, 1920
ASTRA = 5
SCALE = 1.5
CAM = ((0.0, -1.85, 0.68), (0.0, 0.0, 1.72), 18)  # location, look-at, lens: low, below the face, looking up, wide (a slight warp)
HEAD_BOW = -32  # degrees (negative bows forward): the head bowed toward the camera below, so Astra looks down at the viewer


def build():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    M = common.materials()
    sc = mt.begin_scene("ThumbShort3", seed=7)
    sc.render.resolution_x, sc.render.resolution_y = W, H
    w = bpy.data.worlds.new("ThumbShort3World")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.07, 0.004, 0.006, 1)
    sc.world = w
    add(bpy.ops.mesh.primitive_plane_add, "Floor", toon("ThumbFloor", (0.02, 0.015, 0.02)), loc=(0, 6, 0), size=80)
    grid = glow("Grid", (0.9, 0.08, 0.06), 1.3)
    for k in range(-14, 15):
        add(bpy.ops.mesh.primitive_cube_add, f"GridX{k}", grid, loc=(k * 1.2, 6, 0.004), scale=(0.018, 40, 0.004))
    for k in range(-4, 30):
        add(bpy.ops.mesh.primitive_cube_add, f"GridY{k}", grid, loc=(0, k * 1.2, 0.004), scale=(40, 0.018, 0.004))
    root = g2.contestant(M, ASTRA, (0.0, 0.0, 0.0), math.pi, SCALE, logo_at=(0.0, 0.37, 0.92))
    head = next(o for o in root.children_recursive if o.name == f"T{ASTRA}_Head")
    head.rotation_euler.x += math.radians(HEAD_BOW)
    key = light("Key", "AREA", 900, (1.0, 0.93, 0.85), (1.6, -6, 5.5), 3.0)
    key.rotation_euler = (Vector((0, 0, 2.0)) - key.location).to_track_quat("-Z", "Y").to_euler()
    for x in (-3.5, 3.5):  # hard red rims from behind, both sides of the figure
        rim = light(f"Rim{x}", "SPOT", 3200, (1.0, 0.1, 0.06), (x, 4.5, 4.5), 0.4, spot=50)
        rim.rotation_euler = (Vector((0, 0, 2.0)) - rim.location).to_track_quat("-Z", "Y").to_euler()
    fog_box(size=(40, 30, 14), center=(0, 12, 6), color=(0.7, 0.06, 0.05), ground_density=0.045, falloff=0.3)
    loc, look, lens = CAM
    cam = camera("Thumb", loc, look, lens=lens, moment="Game 2's Short 3 thumbnail")
    cam.data.sensor_fit = "VERTICAL"
    cam.data.sensor_height = 36.0
    common.outline_all(M, skip=("Floor", "Fog", "Grid", "Title", "Moon", "Eye", "Logo"))
    return sc, M


if __name__ == "__main__":
    sc, M = build()
    mt.variant(sc, M, "short_3", [])
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "short3_thumbnail_g2.blend"))
    print("[thumb2] short 3 done")
