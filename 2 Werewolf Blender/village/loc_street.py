"""Location 2: the houses street. A crooked lane of cottages at night, the village asleep; a chapel closes the lane.

Marks:   Door_1..10 (just outside each front door, facing it), Lane_1..4 (wolves creeping up the lane), Peek (the Little
         Girl at a house corner).
Objects: Door_Token_1..10 (a plaque by each door; the director paints it in the owner's seat colour).
Cameras: Street_Wide (down the lane), Street_High, Street_Peek, Street_Door_1..10 (each door, from the front).
"""
import math

import bpy
from mathutils import Vector

import kit
from common import Ctx, add, begin_scene, camera, fog_box, look_yaw, mark, moon, night_sky, outline_all


def build(M):
    sc = begin_scene("Street", seed=77)
    r = Ctx.rng
    wide = camera("Street_Wide", (0.6, -9.0, 2.6), (0.0, 20.0, 3.4), lens=26, moment="night: the sleeping village; wolves on the move")
    moon_dir = moon(wide, frame_xy=(-0.42, 0.75), M=M, radius=5.5)
    night_sky(moon_dir)
    add(bpy.ops.mesh.primitive_plane_add, "Ground", M["ground"], loc=(0, 10, -0.02), size=600)
    kit.hills(M, (0, 15), 95, mat="ground")
    for k in range(9):
        y = -8 + k * 5.5
        x = math.sin(k * 0.55) * 0.8
        add(bpy.ops.mesh.primitive_cube_add, f"Lane{k}", M["path"], loc=(x, y, 0.0), rot=(0, 0, math.sin(k * 0.55 + 0.3) * 0.12), scale=(3.0, 3.0, 0.03))
        add(bpy.ops.mesh.primitive_cube_add, f"LaneStones{k}", M["cobble"], loc=(x, y, 0.02), rot=(0, 0, math.sin(k * 0.55 + 0.3) * 0.12), scale=(1.1, 2.9, 0.02))

    houses = []
    for k in range(10):
        side = -1 if k % 2 == 0 else 1
        y = -3 + (k // 2) * 7.2 + r.uniform(-0.6, 0.6)
        x = side * (7.2 + r.uniform(-0.4, 0.8)) + math.sin((y + 8) / 5.5 * 0.55) * 0.8
        lit = r.random() < 0.25  # most of the village is asleep
        root, door = kit.house(M, f"House{k + 1}", (x, y, 0), look_yaw((x, y), (0, y)), w=r.uniform(3.8, 4.8), d=r.uniform(3.8, 4.6),
                               h1=r.uniform(2.6, 3.1), h2=r.uniform(2.2, 2.8), roof="roof_red" if k % 4 == 1 else "roof",
                               lit=(lit and r.random() < 0.5, lit, False), tilt=3.0)
        sc.objects[root["token"]].name = f"Door_Token_{k + 1}"
        houses.append(root)
        out = (Vector((door.x, door.y, 0)) - Vector((x, y, 0))).normalized()  # from the house out to the lane
        lamp_side = root.matrix_basis.to_3x3() @ Vector((-1, 0, 0))  # the door lamp's side of the door
        stand = Vector((door.x, door.y, 0)) + lamp_side * 0.85 + out * 0.1  # beside the door, not in front of it
        mark(f"Door_{k + 1}", tuple(stand), look_yaw(stand, (door.x - out.x * 0.9, door.y - out.y * 0.9)))
        # a 3/4 view from the token's side: the door, its token and whoever stands at it all read
        view = (out * 0.82 - lamp_side * 0.57).normalized()
        cam = Vector((door.x, door.y, 0)) + view * 3.7 + Vector((0, 0, 1.7))
        camera(f"Street_Door_{k + 1}", tuple(cam), (door.x - out.x * 0.5, door.y - out.y * 0.5, 1.3), lens=28,
               moment=f"night: wolves at house {k + 1}'s door (the victim's home)", covers=[f"Door_{k + 1}"])
    for k, (x, y) in enumerate([(-0.6, 4.0), (0.8, 6.0), (-0.3, 8.5), (1.0, 10.5)]):
        mark(f"Lane_{k + 1}", (x, y, 0), look_yaw((x, y), (0, 30)))
    # the Little Girl leans out from behind the lane-side corner of house 5, eyes on the lane
    h5 = houses[4]
    hw, hd = h5["w"], h5["d"]
    spot = h5.matrix_basis @ Vector((hw / 2 + 0.32, hd / 2 - 0.45, 0))
    ahead = h5.matrix_basis @ Vector((hw / 2 + 0.6, hd / 2 + 3.0, 0))  # out into the lane
    pk = mark("Peek", (spot.x, spot.y, 0), look_yaw(spot, (ahead.x, ahead.y)))
    pk["lean"] = -0.19  # tipped forward round the corner
    # from the lane on the house's other side: the front corner splits her about 60/40
    pc = h5.matrix_basis @ Vector((-hw * 0.3, hd / 2 + 6.0, 1.3))
    camera("Street_Peek", tuple(pc), (spot.x, spot.y, 1.25), lens=35, moment="night: the Little Girl peeks from a corner", covers=["Peek"])

    for (lx, ly, yaw) in [(-3.6, 2.0, 0.0), (3.8, 15.0, math.pi)]:
        kit.lantern_post(M, lx, ly, yaw, energy=320)
    for (bx, by) in [(-4.2, -7.5), (4.4, 31.0), (4.9, 31.6)]:
        kit.barrel(M, bx, by, lying=r.random() < 0.3)
    # props live beyond the last houses, toward the chapel: no door camera looks through them
    kit.fence(M, (-3.8, 32.0), (-3.4, 37.0))
    kit.fence(M, (3.6, -9.5), (3.9, -6.5))
    kit.hay_cart(M, (4.6, 34.5, 0), math.radians(95))
    kit.well(M, (-3.2, 39.0, 0))
    kit.crates(M, -4.4, 30.5, math.radians(-20))
    kit.church(M, (0.6, 44.0, 0), math.pi)  # its tower faces down the lane

    cam2 = Vector((wide.location.x, wide.location.y))
    m2 = Vector((moon_dir.x, moon_dir.y)).normalized()

    def clear(x, y):
        return (abs(x) < 12 and -12 < y < 40) or (abs(x) < 6 and y < 52)  # the village and the chapel

    def low(x, y):
        dd = Vector((x, y)) - cam2
        along = dd.dot(m2)
        return along > 0 and (dd - m2 * along).length < 2.5 + along * 0.22

    kit.forest_ring(M, (0, 16), 16, 48, 170, keep_clear=clear, low=low)
    kit.gnarly(M, "LaneTree", -5.2, 27.0, 9)
    fog_box(size=(60, 90, 12), center=(0, 18, 5), ground_density=0.05, falloff=0.3)
    camera("Street_High", (8.0, -10.0, 13.0), (0.0, 12.0, 0.0), lens=28, moment="night: over the roofs")
    outline_all(M)
    return sc
