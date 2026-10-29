"""Location 3: the wolf clearing. A hollow in the forest with a flat council rock under a cold moonbeam, bones in the grass.

Marks:   Wolf_1..4 (a horseshoe on the far side of the rock, facing it and the cameras).
Cameras: Clearing_Wide, Clearing_Low (up at the pack, against the moon), Clearing_Rock (over the rock).
"""
import math

import bpy
from mathutils import Vector

import kit
from common import Ctx, add, begin_scene, camera, fog_box, jitter, light, look_yaw, mark, moon, night_sky, outline_all


def build(M):
    sc = begin_scene("Clearing", seed=13)
    r = Ctx.rng
    wide = camera("Clearing_Wide", (0.4, -4.0, 2.1), (0.0, 2.6, 1.45), lens=30, moment="night: the pack's council at the rock", covers=["Wolf_1", "Wolf_2", "Wolf_3", "Wolf_4"])
    # low beside the rock, looking up at the pack: the moon sits behind them in this shot
    lowcam = camera("Clearing_Low", (3.1, 0.7, 0.95), (-0.4, 3.6, 2.0), lens=22, moment="night: looking up at the pack, the moon behind them", covers=["Wolf_1", "Wolf_2", "Wolf_3", "Wolf_4"])
    moon_dir = moon(lowcam, frame_xy=(-0.2, 0.62), M=M, radius=5.0, strength=0.3)
    night_sky(moon_dir, top=(0.02, 0.06, 0.08), halo_strength=0.1, halo_min=0.985)
    add(bpy.ops.mesh.primitive_plane_add, "Ground", M["forest_floor"], loc=(0, 0, -0.02), size=600)
    kit.hills(M, (0, 1), 58)

    # the council rock and a ring of standing stones
    altar = add(bpy.ops.mesh.primitive_cylinder_add, "CouncilRock", M["mossy"], loc=(0, 1.0, 0.35), vertices=9, radius=1.5, depth=0.7, scale=(1.2, 1.0, 1.0))
    jitter(altar, 0.08)
    for k in range(7):
        a = k / 7 * math.tau + 0.4
        if math.sin(a) < -0.6:  # keep the view from the wide camera open
            continue
        st = add(bpy.ops.mesh.primitive_cube_add, f"Standing{k}", M["mossy"], loc=(math.cos(a) * 6.2, 1.0 + math.sin(a) * 6.2, 0.9), rot=(r.uniform(-0.12, 0.12), r.uniform(-0.12, 0.12), a), scale=(0.35, 0.5, 0.95))
        jitter(st, 0.06)
    for k in range(12):
        a = r.uniform(0, math.tau)
        d = r.uniform(3.0, 7.5)
        kit.rock(M, math.cos(a) * d, 1.0 + math.sin(a) * d, r.uniform(0.25, 0.6), "mossy")
    # bones and a skull by the rock
    for k in range(6):
        a = r.uniform(0, math.tau)
        d = r.uniform(1.9, 3.0)
        x, y = math.cos(a) * d, 1.0 + math.sin(a) * d
        add(bpy.ops.mesh.primitive_cylinder_add, f"Bone{k}", M["bone"], loc=(x, y, 0.05), rot=(math.radians(90), 0, r.uniform(0, 3)), vertices=6, radius=0.035, depth=0.55)
        for e in (-1, 1):
            add(bpy.ops.mesh.primitive_uv_sphere_add, f"BoneEnd{k}{e}", M["bone"], loc=(x + e * 0.27 * math.cos(a), y + e * 0.27 * math.sin(a), 0.06), segments=6, ring_count=4, radius=0.06)
    add(bpy.ops.mesh.primitive_uv_sphere_add, "Skull", M["bone"], loc=(1.0, -0.8, 0.14), segments=10, ring_count=8, radius=0.16, scale=(1, 1.15, 0.9))
    for e in (-1, 1):
        add(bpy.ops.mesh.primitive_uv_sphere_add, "SkullEye", M["face"], loc=(1.0 + e * 0.06, -0.95, 0.17), segments=6, ring_count=4, radius=0.04)
    for k in range(18):  # tall grass tufts
        a = r.uniform(0, math.tau)
        d = r.uniform(2.5, 9.0)
        jitter(add(bpy.ops.mesh.primitive_cone_add, f"Tuft{k}", M["grass"], loc=(math.cos(a) * d, 1.0 + math.sin(a) * d, 0.2), vertices=5, radius1=0.4, depth=0.5), 0.1)

    for k in range(4):  # the pack's places: a horseshoe behind the rock, so the cameras see their eyes
        a = math.radians((35, 75, 105, 145)[k])
        p = (math.cos(a) * 2.3, 1.0 + math.sin(a) * 2.3, 0)
        mark(f"Wolf_{k + 1}", p, look_yaw(p, (0, 1.0)))

    # a cold moonbeam on the rock
    beam = light("Moonbeam", "SPOT", 2600, (0.55, 0.75, 1.0), (2.0, -1.0, 14.0), 0.3)
    beam.rotation_euler = (Vector((0, 1.0, 0)) - Vector(beam.location)).to_track_quat("-Z", "Y").to_euler()
    beam.data.spot_size = math.radians(28)
    beam.data.spot_blend = 0.4

    cam2 = Vector((lowcam.location.x, lowcam.location.y))  # the gap in the trees is for the shot that shows the moon
    m2 = Vector((moon_dir.x, moon_dir.y)).normalized()

    def clear(x, y):
        dd = Vector((x, y)) - cam2
        along = dd.dot(m2)
        return math.hypot(x, y - 1.0) < 8.5 or (y < -6 and abs(x) < 8) or (along > 0 and (dd - m2 * along).length < 2.0 + along * 0.18)

    kit.forest_ring(M, (0, 1), 8.5, 46, 240, keep_clear=clear, mix=(0.45, 0.25, 0.3), h=(9, 16))
    kit.gnarly(M, "WitnessTree", -5.5, 6.5, 11, branches=9)
    fog_box(size=(60, 60, 8), center=(0, 1, 3), color=(0.25, 0.32, 0.5), ground_density=0.05, falloff=0.25)

    camera("Clearing_Rock", (1.7, -0.9, 2.0), (-0.3, 3.3, 1.55), lens=32, moment="night: a wolf speaks at council (close)", covers=["Wolf_2", "Wolf_3"])
    outline_all(M)
    return sc
