"""Location 1: the village square: the meeting circle at the fire, the centre for the bodies, and the gallows.

Marks:   Seat_1..10 (on the logs, facing the fire), Stand_1..10 (standing ring for dawn/day/vote, outside the bodies),
         Body_1..3 (inside the circle), Gallows (under the rope), Crowd_1..10 (standing, facing the gallows).
Cameras: Square_Wide, Square_High (votes), Square_Bodies (dawn), Square_Gallows (execution), Square_Crowd (reverse),
         Square_Seat_1..10 (a close-up across the fire for each seat, subject on a third, headroom for the speech box).
"""
import math

import bpy
from mathutils import Vector

import kit
from common import Ctx, add, begin_scene, camera, fog_box, jitter, light, look_yaw, mark, moon, night_sky, outline_all

SEATS = 10
SEAT_R = 3.8
STAND_R = 5.3
SEAT_HEAD = 0.46 + 1.28  # head height of a seated figure


def build(M):
    sc = begin_scene("Square", seed=2024)
    r = Ctx.rng
    wide = camera("Square_Wide", (1.5, -17.5, 6.4), (0.0, 3.0, 3.0), lens=24, moment="establishing; the village at the start of a phase")
    moon_dir = moon(wide, M=M)
    night_sky(moon_dir)

    add(bpy.ops.mesh.primitive_plane_add, "Ground", M["ground"], loc=(0, 0, -0.02), size=600)
    add(bpy.ops.mesh.primitive_cylinder_add, "Cobbles", M["cobble"], loc=(0, 0, 0.0), vertices=40, radius=10.5, depth=0.08)
    add(bpy.ops.mesh.primitive_cube_add, "PathOut", M["path"], loc=(13, -5.5, -0.005), rot=(0, 0, math.radians(-25)), scale=(7, 1.6, 0.03))
    for i in range(22):
        a = r.uniform(0, math.tau)
        d = r.uniform(10.3, 13.0)
        jitter(add(bpy.ops.mesh.primitive_cone_add, f"Tuft{i}", M["grass"], loc=(math.cos(a) * d, math.sin(a) * d, 0.15), vertices=5, radius1=r.uniform(0.3, 0.55), depth=0.35), 0.08)
    gal_cam = Vector((-5.57, 6.29))  # Cam_Square_Gallows (set below); the dusk sun sits at 174° behind the gallows
    sun_dir = Vector((math.cos(math.radians(174)), math.sin(math.radians(174))))

    def toward_sun(x, y, half_angle=22):
        dd = Vector((x, y)) - gal_cam
        return dd.length > 4 and dd.normalized().dot(sun_dir) > math.cos(math.radians(half_angle))

    kit.hills(M, (0, 0), 110, mat="ground", skip=toward_sun)

    kit.fire(M, (0, 0, 0))

    seat_pos = []
    for i in range(SEATS):
        a = i / SEATS * math.tau - math.pi / 2  # seat 1 nearest the wide camera
        radial = Vector((math.cos(a), math.sin(a), 0))
        tangent = Vector((-math.sin(a), math.cos(a), 0))
        p = radial * SEAT_R
        face = look_yaw(p, (0, 0))
        jitter(add(bpy.ops.mesh.primitive_cylinder_add, f"Log{i + 1}", M["wood"], loc=(p.x, p.y, 0.26), rot=(math.radians(90), 0, face + math.pi / 2), vertices=7, radius=0.24, depth=1.2), 0.02)
        mark(f"Seat_{i + 1}", (p.x, p.y, 0), face)
        s = radial * STAND_R
        mark(f"Stand_{i + 1}", (s.x, s.y, 0), look_yaw(s, (0, 0)))
        seat_pos.append((p, face))
        # close-up from across the fire, off to one side; the subject sits on a third with room above for the speech box
        # found by search: the fire stays 33° and every other seat 52° off the lens axis (a 50 mm lens sees about ±20°)
        cam_pos = -radial * 1.2 + tangent * 0.8 + Vector((0, 0, 1.8))
        aim = p + tangent * 0.55 + Vector((0, 0, SEAT_HEAD + 0.2))
        camera(f"Square_Seat_{i + 1}", tuple(cam_pos), tuple(aim), lens=50, moment=f"seat {i + 1} speaks or reacts (seated)", covers=[f"Seat_{i + 1}"])

    # the dead lie side by side on their backs, heads toward the fire; the first in the middle (one death is the usual case)
    for k, x in enumerate((0.0, -1.35, 1.35)):
        mark(f"Body_{k + 1}", (x, -2.25, 0.04), 0.0)
    # dawn: from above their feet, past seat 1, so every face, scarf and role tell reads; the fire glows behind them
    camera("Square_Bodies", (0.0, -6.0, 3.6), (0.0, -2.0, 0.0), lens=26, moment="dawn: the night's dead lie by the fire", covers=["Body_1", "Body_2", "Body_3"])
    camera("Square_Hunter", (-2.6, -0.9, 0.75), (1.8, 1.8, 1.6), lens=18, moment="the Hunter's last shot: a low wide across the fire",
           covers=[f"Seat_{i + 1}" for i in range(SEATS)])
    camera("Square_High", (0.0, -10.5, 14.0), (0.0, 0.5, 0.0), lens=24, moment="the vote: arrows from voters to targets", covers=[f"Seat_{i + 1}" for i in range(SEATS)])

    # (no well in the square: at 50 mm any tall prop behind a seat fills a sixth or more of its close-up; it lives in the street)
    G = Vector((-8.6, 6.6, 0))
    to_c = (-G).normalized()
    side = Vector((-to_c.y, to_c.x, 0))
    gyaw = math.atan2(to_c.x, -to_c.y)  # the steps (local -Y) face the centre
    gal_spot = kit.gallows(M, tuple(G), gyaw)
    mark("Gallows", tuple(gal_spot), look_yaw(gal_spot, (0, 0)))
    base = math.atan2(to_c.y, to_c.x)
    for k in range(10):
        a = base + (k - 4.5) * math.radians(11)
        rr = 3.6 + (k % 2) * 1.0
        p = Vector((G.x + math.cos(a) * rr, G.y + math.sin(a) * rr, 0))
        mark(f"Crowd_{k + 1}", (p.x, p.y, 0), look_yaw(p, (G.x, G.y)))
    # low, close, looking up: the beam stands against the sky above the roofs; a cold rim light behind it
    gc = G + to_c * 2.6 + side * 1.6  # between the steps (1.75-2.65 m out, ±0.6 m wide) and the crowd (3.6 m and beyond)
    assert (Vector((gc.x, gc.y)) - gal_cam).length < 0.05, "gal_cam (the sky gap) must match the gallows camera"
    camera("Square_Gallows", (gc.x, gc.y, 1.0), (G.x, G.y, 2.7), lens=16, moment="execution: the condemned under the rope (silhouette)", covers=["Gallows"])
    rim = light("GallowsRim", "SPOT", 900, (0.6, 0.75, 1.0), tuple(G - to_c * 3.0 + Vector((0, 0, 6.5))), 0.3, shadow=False, cutoff=12.0, spot=45)
    rim.rotation_euler = (Vector((G.x, G.y, 3.0)) - rim.location).to_track_quat("-Z", "Y").to_euler()
    cc = Vector((gal_spot.x, gal_spot.y, 0)) - to_c * 1.4 + side * 0.45 + Vector((0, 0, 3.75))  # high, behind the condemned
    camera("Square_Crowd", tuple(cc), tuple(G + to_c * 4.1 + Vector((0, 0, 1.0))), lens=26, moment="execution: the crowd watches (reverse shot)", covers=[f"Crowd_{k + 1}" for k in range(10)])

    kit.hay_cart(M, (-7.4, -3.2, 0), math.radians(20))
    for (bx, by) in [(-5.4, -5.6), (-4.9, -6.3), (7.6, -1.5)]:
        kit.barrel(M, bx, by)
    for (lx, ly, yaw) in [(4.2, -8.0, 0), (-3.6, 9.0, math.pi), (8.8, 5.2, math.pi), (-9.4, 1.0, 0)]:
        kit.lantern_post(M, lx, ly, yaw)
    # foreground framing for the wide shot
    kit.crates(M, 6.4, -12.2, math.radians(15))
    kit.barrel(M, 5.1, -12.9)
    kit.fence(M, (-8.5, -11.0), (-4.0, -12.6), posts=5)

    # no house behind the gallows (about 142°): the gallows stands against the open sky and trees
    slots = [(-2, 14.5), (16, 13.8), (36, 14.0), (60, 15.0), (100, 14.5), (118, 13.6), (170, 14.0), (192, 14.6), (-24, 15.5)]
    for k, (x, y) in enumerate([(-8.5, -21.5), (0.5, -23.5), (9.5, -21.0)]):  # behind the wide camera: seen only by the southern seats
        kit.house(M, f"SouthHouse{k}", (x, y, 0), look_yaw((x, y), (0, 0)), w=r.uniform(3.8, 4.6), d=r.uniform(3.8, 4.4), h1=r.uniform(2.6, 3.0),
                  h2=r.uniform(2.2, 2.7), roof="roof" if k != 1 else "roof_red", lit=(r.random() < 0.5, r.random() < 0.5, r.random() < 0.6))
    for k, (deg, d) in enumerate(slots):
        a = math.radians(deg)
        p = (math.cos(a) * d, math.sin(a) * d, 0)
        kit.house(M, f"House{k}", p, look_yaw(p, (0, 0)), w=r.uniform(3.6, 4.6), d=r.uniform(3.6, 4.4), h1=r.uniform(2.6, 3.0), h2=r.uniform(2.2, 2.7),
                  roof="roof_red" if k % 3 == 1 else "roof", lit=(r.random() < 0.5, r.random() < 0.55, r.random() < 0.6))

    cam2 = Vector((wide.location.x, wide.location.y))
    m2 = Vector((moon_dir.x, moon_dir.y)).normalized()

    def clear(x, y):
        return (-19 < y < -12 and abs(x) < 25) or toward_sun(x, y, 16)  # the wide camera's foreground; the gallows' sky

    def low(x, y):
        dd = Vector((x, y)) - cam2
        along = dd.dot(m2)
        return (along > 0 and (dd - m2 * along).length < 2.0 + along * 0.2) or toward_sun(x, y, 30)

    kit.forest_ring(M, (0, 0), 21, 48, 160, keep_clear=clear, low=low)
    kit.gnarly(M, "FrameTreeL", -13.5, -6.5, 12)
    kit.gnarly(M, "FrameTreeR", 15.0, 2.0, 11)
    fog_box()
    outline_all(M)
    return sc
