"""Location 4: the night-role room. A candle-lit cottage interior reused for every solo night role (Seer, Witch,
Protector, Cupid ...): the role's figure sits at the table with its props; moonlight falls through the window.

Marks:   Role (on the stool at the table, facing it), Bed (a sleeper, for a victim's house), Door.
Cameras: Room_Wide, Room_Table (close over the table), Room_Window (the figure against the moonlit window).
"""
import math

import bpy
from mathutils import Vector

from common import Ctx, add, begin_scene, camera, jitter, light, look_yaw, mark, outline_all

W, D, H = 6.0, 5.0, 3.2  # interior width (x), depth (y), height


def build(M):
    sc = begin_scene("Room", seed=5)
    r = Ctx.rng
    world = bpy.data.worlds.new("RoomDark")
    world.use_nodes = True
    world.node_tree.nodes.get("Background").inputs["Color"].default_value = (0.012, 0.012, 0.025, 1)
    sc.world = world
    sc["night_world"] = world.name

    # shell: floor, walls with timber, ceiling beams (the wall toward the camera is left out)
    add(bpy.ops.mesh.primitive_cube_add, "Floor", M["floorboards"], loc=(0, 0, -0.05), scale=(W / 2, D / 2, 0.05))
    add(bpy.ops.mesh.primitive_cube_add, "BackWall", M["plaster_in"], loc=(0, D / 2, H / 2), scale=(W / 2, 0.1, H / 2))
    add(bpy.ops.mesh.primitive_cube_add, "LeftWall", M["plaster_in"], loc=(-W / 2, 0, H / 2), scale=(0.1, D / 2, H / 2))
    add(bpy.ops.mesh.primitive_cube_add, "RightWall", M["plaster_in"], loc=(W / 2, 0, H / 2), scale=(0.1, D / 2, H / 2))
    add(bpy.ops.mesh.primitive_cube_add, "Ceiling", M["dark_wood"], loc=(0, 0, H + 0.05), scale=(W / 2, D / 2, 0.05))
    for x in (-W / 2 + 0.05, -1.0, 1.0, W / 2 - 0.05):
        add(bpy.ops.mesh.primitive_cube_add, "WallPost", M["beam"], loc=(x, D / 2 - 0.12, H / 2), scale=(0.1, 0.05, H / 2))
    add(bpy.ops.mesh.primitive_cube_add, "WallRail", M["beam"], loc=(0, D / 2 - 0.12, 1.0), scale=(W / 2, 0.05, 0.07))
    for y in (-1.6, 0.0, 1.6):
        add(bpy.ops.mesh.primitive_cube_add, "CeilingBeam", M["beam"], loc=(0, y, H - 0.12), scale=(W / 2, 0.12, 0.12))
    for y in (-1.2, 1.2):
        add(bpy.ops.mesh.primitive_cube_add, "SidePost", M["beam"], loc=(-W / 2 + 0.12, y, H / 2), scale=(0.05, 0.1, H / 2))

    # the window in the back wall: night sky, moonlight streaming in
    add(bpy.ops.mesh.primitive_cube_add, "WindowGlass", M["night_window"], loc=(1.9, D / 2 - 0.08, 1.9), scale=(0.55, 0.02, 0.6))
    for z in (1.3, 2.5):
        add(bpy.ops.mesh.primitive_cube_add, "WindowSill", M["beam"], loc=(1.9, D / 2 - 0.13, z), scale=(0.65, 0.06, 0.06))
    for x in (1.3, 1.9, 2.5):
        add(bpy.ops.mesh.primitive_cube_add, "WindowBar", M["beam"], loc=(x, D / 2 - 0.13, 1.9), scale=(0.05, 0.05, 0.62))
    moonin = light("MoonIn", "SPOT", 600, (0.55, 0.72, 1.0), (2.4, D / 2 + 1.5, 3.4), 0.2)
    moonin.rotation_euler = (Vector((0.4, -0.8, 0.0)) - Vector(moonin.location)).to_track_quat("-Z", "Y").to_euler()
    moonin.data.spot_size = math.radians(40)
    moonin.data.spot_blend = 0.2

    # the table, a stool, the candle
    tx, ty = 0.0, 0.2
    add(bpy.ops.mesh.primitive_cube_add, "TableTop", M["wood"], loc=(tx, ty, 0.82), scale=(0.9, 0.6, 0.05))
    for dx in (-0.8, 0.8):
        for dy in (-0.5, 0.5):
            add(bpy.ops.mesh.primitive_cube_add, "TableLeg", M["dark_wood"], loc=(tx + dx, ty + dy, 0.4), scale=(0.05, 0.05, 0.4))
    # the role sits on the far side of the table, facing the cameras, the moonlit window behind
    add(bpy.ops.mesh.primitive_cylinder_add, "Stool", M["wood"], loc=(tx, ty + 1.05, 0.23), vertices=8, radius=0.28, depth=0.46)
    add(bpy.ops.mesh.primitive_cylinder_add, "Candle", M["shroud"], loc=(tx + 0.45, ty + 0.15, 0.97), vertices=8, radius=0.04, depth=0.24)
    jitter(add(bpy.ops.mesh.primitive_cone_add, "CandleFlame", M["candle"], loc=(tx + 0.45, ty + 0.15, 1.15), vertices=6, radius1=0.035, depth=0.1), 0.005)
    light("CandleLight", "POINT", 55, (1.0, 0.65, 0.3), (tx + 0.45, ty + 0.15, 1.25), 0.15, cutoff=2.6)
    add(bpy.ops.mesh.primitive_cube_add, "OpenBook", M["book"], loc=(tx - 0.3, ty + 0.1, 0.89), rot=(0, 0, 0.2), scale=(0.25, 0.18, 0.02))
    add(bpy.ops.mesh.primitive_cube_add, "Pages", M["shroud"], loc=(tx - 0.3, ty + 0.1, 0.91), rot=(0, 0, 0.2), scale=(0.23, 0.16, 0.01))
    mark("Role", (tx, ty + 1.05, 0), look_yaw((tx, ty + 1.05), (tx, ty)))

    # shelves with bottles and jars along the left wall; a bed in the corner
    for z in (1.4, 2.1):
        add(bpy.ops.mesh.primitive_cube_add, "Shelf", M["dark_wood"], loc=(-W / 2 + 0.35, 0.6, z), scale=(0.25, 1.1, 0.04))
        for k in range(5):
            mat = r.choice(["potion_heal", "potion_poison", "orb", "stone", "book"])
            add(bpy.ops.mesh.primitive_cylinder_add, "Jar", M[mat], loc=(-W / 2 + 0.35, -0.3 + k * 0.42, z + 0.16), vertices=8, radius=r.uniform(0.06, 0.1), depth=r.uniform(0.18, 0.3))
    add(bpy.ops.mesh.primitive_cube_add, "BedFrame", M["dark_wood"], loc=(2.0, -0.6, 0.25), scale=(0.65, 1.1, 0.25))
    add(bpy.ops.mesh.primitive_cube_add, "Blanket", M["cloth"], loc=(2.0, -0.85, 0.55), scale=(0.62, 0.85, 0.08))
    add(bpy.ops.mesh.primitive_cube_add, "Pillow", M["shroud"], loc=(2.0, 0.25, 0.58), scale=(0.45, 0.2, 0.08))
    mark("Bed", (2.0, -1.5, 0.62), 0.0)  # the sleeper's feet; pose "sleep" lies with the head toward the pillow (+Y)
    mark("Door", (-2.2, -2.0, 0), look_yaw((-2.2, -2.0), (0, 0)))
    add(bpy.ops.mesh.primitive_cylinder_add, "Rug", M["cloth"], loc=(tx, ty - 0.4, 0.01), vertices=16, radius=1.5, depth=0.02, scale=(1.2, 0.9, 1))

    camera("Room_Wide", (-1.3, -4.3, 2.0), (0.4, 1.0, 1.1), lens=20, moment="night: a role wakes and acts (the room)", covers=["Role"])
    camera("Room_Table", (0.55, -1.55, 1.45), (0.0, 1.2, 1.25), lens=35, moment="night: the role's face over the candle", covers=["Role"])
    camera("Room_Window", (-1.7, -1.9, 1.45), (1.9, 2.4, 1.8), lens=24, moment="night: the moonlit window; a sleeper in bed", covers=["Role", "Bed"])
    outline_all(M, skip=("Floor",))
    return sc
