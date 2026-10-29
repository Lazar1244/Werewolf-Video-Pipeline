"""Game 2's thumbnails (game 06ce0859, owner 2026-10-23), in Game 1's picture style, as a NEW script: it borrows
make_thumbnails.py's parts (grid floor, red fog, the video's figures, the real logos, the sharp title pass, the wolf
eyes, the dead body) without changing Game 1's script.

    blender --background --factory-startup --python thumbnail/make_thumbnails_g2.py [-- B_vs_base C_two_are_lying]
    python thumbnail/add_bubbles_g2.py          (B: the two "I'M THE HUNTER" bubbles on B_vs_base)

A_vs            Fable (Claude) VS Sol (GPT): the two face off, a big VS between them, no other text
B_vs_base       the same picture; add_bubbles_g2.py puts "I'M THE HUNTER" over each -> B_vs_hunter
C_two_are_lying Game 1's style with Game 2's seven, two pairs of wolf eyes in the fog, the body, only "2 ARE LYING"
Output: thumbnail/Game 2/ (and bases/), 1280x720. Both figures are plain (no Hunter hat or crossbow, no Sheriff star):
in B both claim to be the Hunter, and a tell would give away which one is lying.
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_thumbnails as mt  # noqa: E402  (Game 1's parts; its __main__ does not run on import)

mt.GAME = "Game 2"
mt.OUT = os.path.join(HERE, "Game 2")
figure, glow, toon, add, light, camera, fog_box, common = mt.figure, mt.glow, mt.toon, mt.add, mt.light, mt.camera, mt.fog_box, mt.common

# Game 2's seats 1..7 and their labs (seat colours follow the seat numbers, as in the video)
MODELS = ["Gemini 3.1 Pro", "GPT-6 Sol", "Grok 4.7", "Claude Fable 5.1", "GPT-6 Astra", "DeepSeek V4.1 Flash", "Claude Opus 5.5"]
LAB = {**mt.LAB, "DeepSeek": "deepseek"}
mt.LOGO_GLOW.setdefault("deepseek", 1.3)
FABLE, SOL = 4, 2


def lab_of(model):
    return next((v for k, v in LAB.items() if model.startswith(k)), None)


def has_logo(lab):
    return lab and os.path.exists(os.path.join(HERE, "logos", "png", f"{lab}.png"))


def stage():
    """Game 1's world: the black floor with the red glowing grid, the red fog, the warm key and the red rims."""
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    M = common.materials()
    sc = mt.begin_scene("Thumb2", seed=7)
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    w = bpy.data.worlds.new("ThumbWorld2")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.07, 0.004, 0.006, 1)
    sc.world = w
    add(bpy.ops.mesh.primitive_plane_add, "Floor", toon("ThumbFloor", (0.02, 0.015, 0.02)), loc=(0, 6, 0), size=80)
    grid = glow("Grid", (0.9, 0.08, 0.06), 1.3)
    for k in range(-14, 15):
        add(bpy.ops.mesh.primitive_cube_add, f"GridX{k}", grid, loc=(k * 1.2, 6, 0.004), scale=(0.018, 40, 0.004))
    for k in range(-4, 30):
        add(bpy.ops.mesh.primitive_cube_add, f"GridY{k}", grid, loc=(0, k * 1.2, 0.004), scale=(40, 0.018, 0.004))
    key = light("Key", "AREA", 900, (1.0, 0.93, 0.85), (1.5, -7, 6), 4.0)
    key.rotation_euler = (Vector((0, 0.5, 1.2)) - key.location).to_track_quat("-Z", "Y").to_euler()
    for x in (-5, 5):
        rim = light(f"Rim{x}", "SPOT", 3500, (1.0, 0.1, 0.06), (x, 6, 4), 0.4, spot=60)
        rim.rotation_euler = (Vector((x * 0.3, 0.4, 1.4)) - rim.location).to_track_quat("-Z", "Y").to_euler()
    fog_box(size=(40, 30, 10), center=(0, 11, 4), color=(0.7, 0.06, 0.05), ground_density=0.045, falloff=0.3)
    camera("Thumb", (0.0, -8.2, 2.4), (0.0, 2.0, 2.55), lens=28, moment="the thumbnail")
    return sc, M


def contestant(M, seat, loc, yaw, scale, logo_at=(0.0, 0.37, 0.92), name=None):
    root, _ = figure(M, name or f"T{seat}", loc, yaw, seat, "villager", pose="stand", night=False)
    root.scale = (scale, scale, scale)
    lab = lab_of(MODELS[seat - 1])
    if has_logo(lab):
        mt.logo(lab, root, at=logo_at)
    elif lab:
        print(f"[thumb2] no logo file for {lab} yet: {MODELS[seat - 1]} has none")
    return root


def side_logo(lab, root, side):
    """The logo on the side of the cloak that faces the camera (the duel shows the two side-on): the chest decal turned
    90 degrees about the figure's up axis, at its flank (side = +1 local +x, -1 local -x)."""
    o = mt.logo(lab, root, half=0.19, at=(side * 0.5, 0.0, 0.86))  # on the outer sleeve, like an arm patch (the flank is hidden by it)
    o.rotation_euler = (0.0, 0.0, side * math.pi / 2)
    return o


def build_vs():
    """Fable (left) and Sol (right) face to face (owner, 2026-10-23): bodies turned three-quarters toward each other so
    each lab's logo sits on the chest as in Game 1, heads turned further so they look straight at each other; the other
    five watch from a wide half circle behind them, seen from a little above so the circle reads (near ones lower, far
    ones higher in the fog); a warm spotlight on the ground between the two."""
    sc, M = stage()
    cam = sc.objects["Cam_Thumb"]
    cam.location = (0.0, -8.6, 3.5)
    cam.rotation_euler = (Vector((0.0, 2.6, 2.05)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    for seat, x, toward in ((FABLE, -2.35, 1), (SOL, 2.35, -1)):
        # front = (-sin yaw, cos yaw): 45 degrees between the camera (-y) and the other duellist
        yaw = math.pi + toward * math.radians(45)  # Fable: front (0.71, -0.71), toward Sol and the camera
        root, _ = figure(M, f"T{seat}", (x, -0.1, 0), yaw, seat, "villager", pose="stand", night=False)
        root.scale = (2.15, 2.15, 2.15)
        head = next((o for o in root.children_recursive if o.name == f"T{seat}_Head"), None)
        if head is not None:  # the head turns on toward the other: they look each other in the eye
            head.rotation_euler.z += toward * math.radians(32)
        lab = lab_of(MODELS[seat - 1])
        if has_logo(lab):
            mt.logo(lab, root, at=(0.0, 0.37, 0.92))
    centre = Vector((0.0, -0.1))
    # an arc round the duel: the outer two wrap round beside it at the frame's edges, three behind, between the two
    ring = [(1, -5.0, 2.4), (3, -1.9, 5.6), (5, 0.0, 6.4), (6, 1.9, 5.6), (7, 5.0, 2.4)]  # seat, x, y
    for seat, x, y in ring:
        d = centre - Vector((x, y))
        contestant(M, seat, (x, y, 0), math.atan2(-d.x, d.y), 1.5)
    spot = light("DuelSpot", "SPOT", 2200, (1.0, 0.85, 0.65), (0.0, 0.4, 8.0), 0.3, spot=28)
    spot.rotation_euler = (Vector((0.0, 0.3, 0.0)) - spot.location).to_track_quat("-Z", "Y").to_euler()
    common.outline_all(M, skip=("Floor", "Fog", "Grid", "Title", "Moon", "Eye", "Logo", "BloodPool"))
    return sc, M


def build_row():
    """Game 1's row, with Game 2's seven (scale 1.35 so all seven fit) and the dead body in front."""
    sc, M = stage()
    xs = [-3.9, -2.6, -1.3, 0.0, 1.3, 2.6, 3.9]
    for k, x in enumerate(xs):
        contestant(M, k + 1, (x, 0.4 + abs(x) * 0.12, 0), math.pi + math.atan2(x, 9) * 0.6, 1.35, logo_at=(0.03 * x, 0.37, 0.92))
    body, _ = figure(M, "Dead", (0.7, -0.45, 0), math.radians(92), 8, "villager", pose="body", clawed=True)
    body.matrix_world = Matrix.Translation((0.7, -0.45, 0.12)) @ Matrix.Rotation(math.radians(mt.BODY_TIP), 4, "X") \
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
    add(bpy.ops.mesh.primitive_cylinder_add, "BloodPool", pool, loc=(0.1, -0.62, 0.012), vertices=40, radius=1.35, depth=0.01, scale=(1.55, 0.62, 1))
    common.outline_all(M, skip=("Floor", "Fog", "Grid", "Title", "Moon", "Eye", "Logo", "BloodPool"))
    return sc, M


def lying_eyes_g2(sc, M):
    """Two pairs of red wolf eyes in the fog behind the row (Game 1's idea), placed in the GAPS between figures, further
    back and higher, so they hang over no one: Game 1's positions put a pair right above Astra, a real wolf this game
    (spoiler rule: nothing may point at a real wolf)."""
    eye = glow("EyeBurn", (1.0, 0.05, 0.03), 5.0)
    out = []
    # on screen (perspective!), in the only two gaps with no wolf beside them: Grok | Fable and DeepSeek | Opus
    # (screen x 566 and 999 at y 3.6; the wolves this game are Sol, seat 2, and Astra, seat 5)
    for (x, z) in ((-0.88, 3.7), (4.26, 3.45)):
        for s in (-1, 1):
            out.append(add(bpy.ops.mesh.primitive_uv_sphere_add, "Eye", eye, loc=(x + s * 0.26, 3.6, z), segments=12, ring_count=8, radius=0.16, scale=(1.4, 1, 0.7)))
    return out


VARIANTS = {
    "B_vs_base": (build_vs, dict(lines=[("VS", 2.8, 4.5)])),  # + add_bubbles_g2.py -> A_vs (names) and B_vs_hunter
    "C_two_are_lying": (build_row, dict(lines=[("2 ARE LYING", 3.0, 5.0)], extras=[lying_eyes_g2])),
}

if __name__ == "__main__":
    os.makedirs(mt.OUT, exist_ok=True)
    want = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else list(VARIANTS)
    built = None
    for name in want:
        make, kw = VARIANTS[name]
        if built != make:
            sc, M = make()
            built = make
        mt.variant(sc, M, name, **kw)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "thumbnails_g2.blend"))
    print("[thumb2] done")
