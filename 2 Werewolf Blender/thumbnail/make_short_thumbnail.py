"""The Short's thumbnail (owner, 2026-10-20): the full video's "WEREWOLF + small white texts" thumbnail, re-made for the
vertical frame (1080x1920). A NEW scene: it borrows make_thumbnails.py's parts (the grid floor, fog, figures, real
logos, the sharp title pass, the dead body) but changes nothing there; the full videos' thumbnails stay as they are.

    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --factory-startup --python thumbnail/make_short_thumbnail.py
    python thumbnail/add_short_questions.py

Six in one row would be tiny on a phone card, so the cast stands in two rows of three like a team photo, the back row
on a low riser so every logo shows: back Fable, Gemini, Astra (their names in the band under the title, as before),
front Sol, Grok, Opus. The dead body lies across the front.
Writes <GAME>/bases/short_1_base.png (add_short_questions.py adds the texts -> <GAME>/short_1.png).
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_thumbnails as mt  # noqa: E402  (its own renders only run when it is the script itself)
from make_thumbnails import common, Ctx, add, begin_scene, camera, fog_box, glow, light, toon, figure  # noqa: E402

W, H = 1080, 1920
BACK = [(2, -1.65), (3, 0.0), (5, 1.65)]   # (seat, x): Fable, Gemini, Astra, on the riser
FRONT = [(1, -1.65), (4, 0.0), (6, 1.65)]  # Sol, Grok, Opus
RISER = 1.85  # m: the back row stands this high, so its chests show above the front row's hoods
TITLE = [("WEREWOLF", 2.0, 7.75)]  # (text, size, height): across the top of the frame


def build():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    M = common.materials()
    sc = begin_scene("ThumbShort", seed=7)
    sc.render.resolution_x, sc.render.resolution_y = W, H
    w = bpy.data.worlds.new("ThumbShortWorld")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.07, 0.004, 0.006, 1)
    sc.world = w
    # the floor: black with a glowing red grid, as in the full video's thumbnails
    add(bpy.ops.mesh.primitive_plane_add, "Floor", toon("ThumbFloor", (0.02, 0.015, 0.02)), loc=(0, 6, 0), size=80)
    grid = glow("Grid", (0.9, 0.08, 0.06), 1.3)
    for k in range(-14, 15):
        add(bpy.ops.mesh.primitive_cube_add, f"GridX{k}", grid, loc=(k * 1.2, 6, 0.004), scale=(0.018, 40, 0.004))
    for k in range(-4, 30):
        add(bpy.ops.mesh.primitive_cube_add, f"GridY{k}", grid, loc=(0, k * 1.2, 0.004), scale=(40, 0.018, 0.004))
    # the riser: a black step with a red glowing edge, for the back row
    add(bpy.ops.mesh.primitive_cube_add, "Riser", toon("ThumbRiser", (0.025, 0.018, 0.024)), loc=(0, 2.45, RISER / 2), scale=(2.75, 0.85, RISER / 2))
    add(bpy.ops.mesh.primitive_cube_add, "GridRiserEdge", grid, loc=(0, 1.6, RISER), scale=(2.75, 0.02, 0.02))
    for row, y, z in ((BACK, 2.45, RISER), (FRONT, 0.35, 0.0)):
        for seat, x in row:
            root, _ = figure(M, f"T{seat}", (x, y, z), math.pi + math.atan2(x, 10) * 0.6, seat, "villager", pose="stand", night=False)
            root.scale = (1.5, 1.5, 1.5)
            lab = next((v for k2, v in mt.LAB.items() if mt.MODELS[seat - 1].startswith(k2)), None)
            if lab:
                mt.logo(lab, root, at=(0.02 * x, 0.37, 0.92))
    # the dead body across the front, tipped toward the camera with big X eyes and red claw tears (as before)
    body, _ = figure(M, "Dead", (0.3, -1.45, 0), math.radians(92), 7, "villager", pose="body", clawed=True)
    body.matrix_world = Matrix.Translation((0.3, -1.45, 0.12)) @ Matrix.Rotation(math.radians(mt.BODY_TIP + 6), 4, "X") \
        @ Matrix.Rotation(math.radians(92), 4, "Z") @ Matrix.Diagonal((1.4, 1.4, 1.4, 1.0))
    tear = glow("ThumbTear", (0.85, 0.02, 0.02), 1.0)
    for o in body.children_recursive:
        if o.name.startswith("BloodPool2") or (o.data is not None and o.data.name.startswith("BloodPool2")):
            o.hide_render = True
        elif "DeadX" in o.name or (o.data is not None and o.data.name.startswith("DeadX")):
            mt.grow(o, (2.0, 2.0, 2.0), apart=0.05)
        elif "TearD" in o.name or (o.data is not None and o.data.name.startswith("TearD")):
            o.data = o.data.copy()
            o.data.materials.clear()
            o.data.materials.append(tear)
            mt.grow(o, (1.8, 1.15, 3.5))
    pool = glow("ThumbBlood", (0.42, 0.0, 0.008), 0.75)
    add(bpy.ops.mesh.primitive_cylinder_add, "BloodPool", pool, loc=(-0.2, -1.6, 0.012), vertices=40, radius=1.35, depth=0.01, scale=(1.4, 0.6, 1))
    # light: a strong warm key from the front, hard red rims from behind
    key = light("Key", "AREA", 1100, (1.0, 0.93, 0.85), (1.5, -8, 7), 4.0)
    key.rotation_euler = (Vector((0, 0.8, 1.6)) - key.location).to_track_quat("-Z", "Y").to_euler()
    for x in (-5, 5):
        rim = light(f"Rim{x}", "SPOT", 3500, (1.0, 0.1, 0.06), (x, 7, 5), 0.4, spot=60)
        rim.rotation_euler = (Vector((x * 0.3, 1.2, 2.0)) - rim.location).to_track_quat("-Z", "Y").to_euler()
    fog_box(size=(40, 30, 14), center=(0, 12, 6), color=(0.7, 0.06, 0.05), ground_density=0.045, falloff=0.3)
    cam = camera("Thumb", (0.0, -10.5, 3.6), (0.0, 2.0, 3.35), lens=38, moment="the Short's thumbnail")
    cam.data.sensor_fit = "VERTICAL"
    cam.data.sensor_height = 36.0
    common.outline_all(M, skip=("Floor", "Fog", "Grid", "Title", "Moon", "Eye", "Logo", "BloodPool", "Riser"))
    return sc, M


if __name__ == "__main__":
    sc, M = build()
    mt.variant(sc, M, "short_1_base", TITLE)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "short_thumbnail.blend"))
    print("[thumb] short done")
