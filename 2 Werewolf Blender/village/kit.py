"""Reusable set pieces: half-timbered houses, trees, lanterns, barrels, rocks, fences, the gallows, the well, the hay cart."""
import math

import bpy
from mathutils import Vector

from common import Ctx, add, attach, group, jitter, light, mesh_obj


def house(M, name, loc, yaw, w=4.0, d=4.0, h1=2.8, h2=2.4, roof="roof", lit=(True, True, True), tilt=2.0):
    """A crooked two-storey half-timbered house. Its front (+Y local) is turned by `yaw`."""
    r = Ctx.rng
    root = group(name, loc, yaw=yaw, tilt=math.radians(tilt))
    ps = [add(bpy.ops.mesh.primitive_cube_add, "GroundFloor", M["plaster"], loc=(0, 0, h1 / 2), scale=(w / 2, d / 2, h1 / 2)),
          add(bpy.ops.mesh.primitive_cube_add, "UpperFloor", M["plaster"], loc=(0, 0.2, h1 + h2 / 2), scale=(w / 2 + 0.2, d / 2 + 0.2, h2 / 2))]
    fy = d / 2 + 0.4 + 0.03
    for x in (-w / 2 - 0.15, w / 2 + 0.15):
        ps.append(add(bpy.ops.mesh.primitive_cube_add, "Post", M["beam"], loc=(x, fy, h1 + h2 / 2), scale=(0.1, 0.05, h2 / 2)))
        ps.append(add(bpy.ops.mesh.primitive_cube_add, "Post", M["beam"], loc=(x * 0.93, d / 2 + 0.03, h1 / 2), scale=(0.1, 0.05, h1 / 2)))
    for z in (h1 + 0.06, h1 + h2 - 0.06):
        ps.append(add(bpy.ops.mesh.primitive_cube_add, "Rail", M["beam"], loc=(0, fy, z), scale=(w / 2 + 0.25, 0.05, 0.08)))
    # one diagonal brace, on the side away from the upper window: the other ran straight through the window at the same
    # depth (a timber "log" across the glass that flickered; owner, 2026-10-27)
    for sx in (1,):
        ang = math.atan2(h2, w / 2) * sx
        ps.append(add(bpy.ops.mesh.primitive_cube_add, "Brace", M["beam"], loc=(sx * w / 4, fy, h1 + h2 / 2), rot=(0, ang, 0), scale=(0.06, 0.05, math.hypot(w / 4, h2 / 2) * 0.95)))
    z0, rh, W = h1 + h2, w * 0.95, w / 2 + 0.55
    yf, yb = d / 2 + 0.85, -d / 2 - 0.35
    sk = r.uniform(-0.25, 0.25)
    rf = mesh_obj("Roof", [(-W, yf, z0 - 0.1), (W, yf, z0 - 0.1), (sk, yf, z0 + rh), (-W, yb, z0 - 0.1), (W, yb, z0 - 0.1), (sk * 0.6, yb, z0 + rh)],
                  [(0, 2, 5, 3), (1, 4, 5, 2)], M[roof])
    th = rf.modifiers.new("Thickness", "SOLIDIFY")
    th.thickness, th.offset = 0.16, 1.0
    jitter(rf, 0.05)
    ps.append(rf)
    Wg, gy = w / 2 + 0.2, d / 2 + 0.4
    rg = rh * (Wg / W) * 0.98
    ps.append(mesh_obj("Gable", [(-Wg, gy, z0), (Wg, gy, z0), (sk * Wg / W, gy, z0 + rg), (-Wg, -d / 2, z0), (Wg, -d / 2, z0), (sk * Wg / W * 0.6, -d / 2, z0 + rg)],
                       [(0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (0, 2, 5, 3), (1, 4, 5, 2)], M["plaster"]))
    for sx in (-1, 1):
        ps.append(add(bpy.ops.mesh.primitive_cube_add, "GableBeam", M["beam"], loc=(sx * Wg / 2 + sk * 0.5, gy + 0.04, z0 + rg / 2),
                      rot=(0, -sx * (math.pi / 2 - math.atan2(rg, Wg)), 0), scale=(0.07, 0.05, math.hypot(Wg, rg) / 2)))
    win = lambda on: M["window"] if on else M["window_dark"]
    ps.append(add(bpy.ops.mesh.primitive_cylinder_add, "GableWin", win(lit[0]), loc=(sk * 0.4, gy + 0.03, z0 + rg * 0.38), rot=(math.radians(90), 0, 0), vertices=4, radius=0.3, depth=0.06))
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "UpperWin", win(lit[1]), loc=(-w * 0.22, fy + 0.02, h1 + h2 * 0.5), scale=(0.28, 0.03, 0.34)))
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "UpperWinFrame", M["beam"], loc=(-w * 0.22, fy, h1 + h2 * 0.5), scale=(0.36, 0.03, 0.42)))
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "LowerWin", win(lit[2]), loc=(w * 0.22, d / 2 + 0.04, h1 * 0.55), scale=(0.3, 0.03, 0.3)))
    for sx in (-1, 1):
        ps.append(add(bpy.ops.mesh.primitive_cube_add, "Shutter", M["beam"], loc=(w * 0.22 + sx * 0.46, d / 2 + 0.05, h1 * 0.55), rot=(0, 0, math.radians(sx * 25)), scale=(0.16, 0.03, 0.34)))
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "Door", M["dark_wood"], loc=(-w * 0.2, d / 2 + 0.04, 0.95), scale=(0.42, 0.04, 0.95)))
    ps.append(add(bpy.ops.mesh.primitive_cylinder_add, "DoorArch", M["dark_wood"], loc=(-w * 0.2, d / 2 + 0.04, 1.9), rot=(math.radians(90), 0, 0), vertices=10, radius=0.42, depth=0.08))
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "Chimney", M["stone"], loc=(w * 0.28, -0.6, h1 + h2 + rh * 0.55), scale=(0.25, 0.25, 0.9)))
    # a token plaque by the door: the director paints it in the owner's seat colour ("whose house is this?")
    token = add(bpy.ops.mesh.primitive_cylinder_add, "DoorToken", M["token"], loc=(-w * 0.2 + 0.75, d / 2 + 0.07, 1.75), rot=(math.radians(90), 0, 0), vertices=10, radius=0.17, depth=0.05)
    ps.append(token)
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "DoorLamp", M["lantern"], loc=(-w * 0.2 - 0.7, d / 2 + 0.3, 2.05), scale=(0.08, 0.08, 0.11)))
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "LampArm", M["dark_wood"], loc=(-w * 0.2 - 0.7, d / 2 + 0.16, 2.24), scale=(0.025, 0.16, 0.025)))
    ps.append(add(bpy.ops.mesh.primitive_cone_add, "LampCap", M["dark_wood"], loc=(-w * 0.2 - 0.7, d / 2 + 0.3, 2.2), vertices=4, radius1=0.12, depth=0.1))
    attach(ps, root)
    light("DoorLight", "SPOT", 90, (1.0, 0.72, 0.3), tuple(root.matrix_basis @ Vector((-w * 0.2 - 0.3, d / 2 + 1.0, 2.3))), 0.1, shadow=False, cutoff=3.2, spot=60)
    door = root.matrix_basis @ Vector((-w * 0.2, d / 2 + 0.9, 0))  # just outside the door
    root["token"] = token.name
    root["w"], root["d"] = w, d
    return root, door


def _tree_root(name, x, y, parts):
    """Group a tree's parts (made in world space) under an empty at its base: wind sways the whole tree."""
    root = bpy.data.objects.new(name + "Root", None)
    Ctx.coll.objects.link(root)
    root.location = (x, y, 0)
    root["sway"] = True
    inv = root.matrix_basis.inverted()
    for p in parts:
        p.parent = root
        p.matrix_parent_inverse = inv
    return root


def pine(M, name, x, y, h):
    parts = [add(bpy.ops.mesh.primitive_cylinder_add, name + "Trunk", M["bark"], loc=(x, y, h * 0.12), vertices=5, radius=0.22, depth=h * 0.25)]
    for j in range(4):
        c = add(bpy.ops.mesh.primitive_cone_add, name + f"T{j}", M["pine"], loc=(x, y, h * (0.3 + j * 0.17)), vertices=7, radius1=h * (0.24 - j * 0.045), depth=h * 0.36)
        jitter(c, 0.15)
        parts.append(c)
    _tree_root(name, x, y, parts)


def blob_tree(M, name, x, y, h):
    r = Ctx.rng
    parts = [add(bpy.ops.mesh.primitive_cylinder_add, name + "Trunk", M["bark"], loc=(x, y, h * 0.3), vertices=6, radius=0.35, depth=h * 0.6)]
    for j in range(3):
        b = add(bpy.ops.mesh.primitive_ico_sphere_add, name + f"C{j}", M["canopy"], loc=(x + r.uniform(-1, 1), y + r.uniform(-1, 1), h * (0.65 + j * 0.12)), subdivisions=1, radius=h * 0.28)
        jitter(b, 0.4)
        parts.append(b)
    _tree_root(name, x, y, parts)


def gnarly(M, name, x, y, h, branches=6):
    r = Ctx.rng
    t = add(bpy.ops.mesh.primitive_cone_add, name, M["bark"], loc=(x, y, h / 2), vertices=7, radius1=0.5, radius2=0.08, depth=h)
    jitter(t, 0.1)
    parts = [t]
    for j in range(branches):
        z = h * r.uniform(0.4, 0.92)
        ang = r.uniform(0, math.tau)
        ln = h * r.uniform(0.25, 0.45)
        parts.append(add(bpy.ops.mesh.primitive_cone_add, name + f"B{j}", M["bark"], loc=(x + math.cos(ang) * ln * 0.4, y + math.sin(ang) * ln * 0.4, z + ln * 0.25),
                         rot=(math.radians(r.uniform(45, 70)), 0, ang + math.pi / 2), vertices=5, radius1=0.12, radius2=0.01, depth=ln))
    _tree_root(name, x, y, parts)


def forest_ring(M, center, r_min, r_max, count, keep_clear=None, mix=(0.55, 0.3, 0.15), h=(10, 17), low=None):
    """Scatter trees in a ring. `keep_clear(x, y)` is True where no tree may stand; `low(x, y)` is True where trees
    must stay short (e.g. under the moon's line of sight: thinned, not cut away)."""
    r = Ctx.rng
    n = tries = 0
    while n < count and tries < count * 20:
        tries += 1
        a = r.uniform(0, math.tau)
        d = r.uniform(r_min, r_max)
        x, y = center[0] + math.cos(a) * d, center[1] + math.sin(a) * d
        if keep_clear and keep_clear(x, y):
            continue
        k = r.random()
        hh = r.uniform(*h) * (0.42 if low and low(x, y) else 1.0)
        if k < mix[0]:
            pine(M, f"Tree{n}", x, y, hh)
        elif k < mix[0] + mix[1]:
            blob_tree(M, f"Tree{n}", x, y, hh)
        else:
            gnarly(M, f"Tree{n}", x, y, hh * 0.8)
        n += 1


def lantern_post(M, x, y, yaw=0.0, energy=420):
    dx, dy = math.cos(yaw), math.sin(yaw)
    add(bpy.ops.mesh.primitive_cylinder_add, "LanternPost", M["dark_wood"], loc=(x, y, 1.5), vertices=6, radius=0.08, depth=3.0)
    add(bpy.ops.mesh.primitive_cube_add, "Arm", M["dark_wood"], loc=(x + dx * 0.3, y + dy * 0.3, 2.95), rot=(0, 0, yaw), scale=(0.35, 0.04, 0.04))
    add(bpy.ops.mesh.primitive_cube_add, "Lantern", M["lantern"], loc=(x + dx * 0.6, y + dy * 0.6, 2.68), rot=(0, 0, yaw), scale=(0.13, 0.13, 0.18))
    add(bpy.ops.mesh.primitive_cone_add, "Cap", M["dark_wood"], loc=(x + dx * 0.6, y + dy * 0.6, 2.92), vertices=4, radius1=0.2, depth=0.18)
    # a downward pool with a cut-off: light on the ground, not rings on the walls
    light("LanternLight", "SPOT", energy, (1.0, 0.72, 0.3), (x + dx * 0.6, y + dy * 0.6, 2.55), 0.1, shadow=False, cutoff=7.0, spot=130)


def barrel(M, x, y, lying=False):
    if lying:
        return add(bpy.ops.mesh.primitive_cylinder_add, "Barrel", M["wood"], loc=(x, y, 0.38), rot=(math.radians(90), 0, Ctx.rng.uniform(0, 3)), vertices=10, radius=0.38, depth=0.9)
    return add(bpy.ops.mesh.primitive_cylinder_add, "Barrel", M["wood"], loc=(x, y, 0.45), vertices=10, radius=0.38, depth=0.9)


def rock(M, x, y, size=1.0, mat="stone"):
    o = add(bpy.ops.mesh.primitive_ico_sphere_add, "Rock", M[mat], loc=(x, y, size * 0.25), subdivisions=1, radius=size, scale=(1, 0.85, 0.6))
    jitter(o, size * 0.18)
    return o


def fence(M, a, b, posts=6):
    a, b = Vector(a), Vector(b)
    yaw = math.atan2(b.y - a.y, b.x - a.x)
    for i in range(posts):
        p = a.lerp(b, i / (posts - 1))
        o = add(bpy.ops.mesh.primitive_cube_add, "FencePost", M["dark_wood"], loc=(p.x, p.y, 0.55), rot=(Ctx.rng.uniform(-0.08, 0.08), 0, yaw), scale=(0.06, 0.06, 0.55))
    mid = (a + b) / 2
    ln = (b - a).length
    for z in (0.45, 0.85):
        add(bpy.ops.mesh.primitive_cube_add, "FenceRail", M["wood"], loc=(mid.x, mid.y, z), rot=(0, Ctx.rng.uniform(-0.03, 0.03), yaw), scale=(ln / 2, 0.035, 0.04))


def gallows(M, loc, yaw):
    """A raised platform with steps, posts, a beam and a rope. Returns the spot under the rope."""
    root = group("Gallows", loc, yaw=yaw)
    gp = [add(bpy.ops.mesh.primitive_cube_add, "Platform", M["wood"], loc=(0, 0, 0.75), scale=(1.8, 1.5, 0.1))]
    for dx, dy in [(-1.6, -1.3), (1.6, -1.3), (-1.6, 1.3), (1.6, 1.3)]:
        gp.append(add(bpy.ops.mesh.primitive_cube_add, "Leg", M["dark_wood"], loc=(dx, dy, 0.35), scale=(0.09, 0.09, 0.38)))
    for k in range(4):
        gp.append(add(bpy.ops.mesh.primitive_cube_add, f"Step{k}", M["wood"], loc=(0, -1.75 - k * 0.3, 0.6 - k * 0.17), scale=(0.6, 0.15, 0.04)))
    for dx in (-1.1, 1.1):
        gp.append(add(bpy.ops.mesh.primitive_cube_add, "Post", M["dark_wood"], loc=(dx, 0.6, 2.6), scale=(0.12, 0.12, 1.8)))
    gp.append(add(bpy.ops.mesh.primitive_cube_add, "Beam", M["dark_wood"], loc=(0, 0.6, 4.45), scale=(1.5, 0.13, 0.13)))
    gp.append(add(bpy.ops.mesh.primitive_cube_add, "Brace", M["dark_wood"], loc=(0.75, 0.6, 3.85), rot=(0, math.radians(45), 0), scale=(0.06, 0.06, 0.62)))
    attach(gp, root)
    pivot = bpy.data.objects.new("RopePivot", None)
    Ctx.coll.objects.link(pivot)
    pivot.parent = root
    pivot.location = (-0.3, 0.6, 4.42)
    for o, z in ((add(bpy.ops.mesh.primitive_cylinder_add, "Rope", M["rope"], vertices=6, radius=0.03, depth=1.15), -0.57),
                 (add(bpy.ops.mesh.primitive_torus_add, "Loop", M["rope"], rot=(math.radians(90), 0, 0), major_radius=0.17, minor_radius=0.03, major_segments=28, minor_segments=8), -1.27)):
        o.parent = pivot
        o.location = (0, 0, z)
    return root.matrix_basis @ Vector((-0.3, 0.6, 0.85))


def well(M, loc):
    root = group("Well", loc)
    wp = [add(bpy.ops.mesh.primitive_cylinder_add, "WellRing", M["stone"], loc=(0, 0, 0.45), vertices=12, radius=0.85, depth=0.9),
          add(bpy.ops.mesh.primitive_cylinder_add, "WellWater", M["face"], loc=(0, 0, 0.88), vertices=12, radius=0.7, depth=0.04)]
    for dx in (-0.75, 0.75):
        wp.append(add(bpy.ops.mesh.primitive_cube_add, "WellPost", M["dark_wood"], loc=(dx, 0, 1.4), scale=(0.07, 0.07, 1.0)))
    wp.append(add(bpy.ops.mesh.primitive_cylinder_add, "WellRoof", M["roof_red"], loc=(0, 0, 2.55), rot=(0, math.radians(90), 0), vertices=3, radius=0.75, depth=2.0, scale=(1, 1.15, 1)))
    wp.append(add(bpy.ops.mesh.primitive_cylinder_add, "Bucket", M["wood"], loc=(0, 0, 1.5), vertices=8, radius=0.16, depth=0.28))
    attach(wp, root)


def hay_cart(M, loc, yaw):
    r = Ctx.rng
    root = group("Cart", loc, yaw=yaw)
    cp = [add(bpy.ops.mesh.primitive_cube_add, "Bed", M["wood"], loc=(0, 0, 0.75), scale=(1.2, 0.7, 0.25))]
    for dx in (-0.7, 0.7):
        for dy in (-0.78, 0.78):
            cp.append(add(bpy.ops.mesh.primitive_cylinder_add, "Wheel", M["dark_wood"], loc=(dx, dy, 0.45), rot=(math.radians(90), 0, 0), vertices=10, radius=0.42, depth=0.08))
    for k in range(5):
        h = add(bpy.ops.mesh.primitive_cube_add, "Hay", M["hay"], loc=(r.uniform(-0.8, 0.8), r.uniform(-0.4, 0.4), 1.15), scale=(0.45, 0.35, 0.25))
        jitter(h, 0.06)
        cp.append(h)
    cp.append(add(bpy.ops.mesh.primitive_cube_add, "Shaft", M["dark_wood"], loc=(1.9, 0, 0.6), rot=(0, math.radians(-12), 0), scale=(0.8, 0.05, 0.05)))
    attach(cp, root)


def fire(M, center=(0, 0, 0), size=1.0):
    """A camp fire: twisted flame tongues hot at the base, sparks above, embers, a stone ring, and its lights."""
    r = Ctx.rng
    cx, cy, cz = center
    for i in range(10):
        a = i / 10 * math.tau
        jitter(add(bpy.ops.mesh.primitive_ico_sphere_add, f"PitStone{i}", M["stone"], loc=(cx + math.cos(a) * 0.9 * size, cy + math.sin(a) * 0.9 * size, cz + 0.12), subdivisions=1, radius=1, scale=(0.3 * size, 0.26 * size, 0.2 * size)), 0.05)
    for i in range(4):
        a = i / 4 * math.tau
        add(bpy.ops.mesh.primitive_cylinder_add, f"FireLog{i}", M["dark_wood"], loc=(cx + math.cos(a) * 0.28, cy + math.sin(a) * 0.28, cz + 0.28), rot=(math.radians(65), 0, a + math.pi / 2), vertices=6, radius=0.08, depth=1.0 * size)
    for i in range(6):  # flame tongues: tall thin cones, twisted and leaning
        a = r.uniform(0, math.tau)
        rr = r.uniform(0.0, 0.25) * size
        h = r.uniform(0.6, 1.35) * size
        f = add(bpy.ops.mesh.primitive_cone_add, f"Flame{i}", M["flame_grad"], loc=(cx + math.cos(a) * rr, cy + math.sin(a) * rr, cz + 0.25 + h / 2),
                rot=(r.uniform(-0.25, 0.25), r.uniform(-0.25, 0.25), r.uniform(0, 3)), vertices=8, radius1=r.uniform(0.14, 0.26) * size, depth=h)
        f.data.transform(__import__("mathutils").Matrix.Scale(0.55, 4, Vector((1, 0, 0))))  # flattened into a tongue
        tw = f.modifiers.new("Twist", "SIMPLE_DEFORM")
        tw.deform_method, tw.angle = "TWIST", math.radians(r.uniform(60, 120))
    for i in range(14):  # sparks drifting up: tiny, so close-ups don't show them as dots
        add(bpy.ops.mesh.primitive_ico_sphere_add, f"Spark{i}", M["ember"], loc=(cx + r.uniform(-0.5, 0.5), cy + r.uniform(-0.5, 0.5), cz + r.uniform(1.3, 2.8) * size), subdivisions=1, radius=r.uniform(0.005, 0.01))
    add(bpy.ops.mesh.primitive_circle_add, "Embers", M["ember"], loc=(cx, cy, cz + 0.1), fill_type="NGON", vertices=9, radius=0.7 * size)
    light("Fire", "POINT", 1400 * size, (1.0, 0.55, 0.2), (cx, cy, cz + 1.1), 0.3)
    light("FireFill", "POINT", 260 * size, (1.0, 0.45, 0.18), (cx, cy, cz + 0.35), 0.5, shadow=False, cutoff=8.0)


def crates(M, x, y, yaw=0.0):
    """A small stack of crates and a sack."""
    root = group("Crates", (x, y, 0), yaw=yaw)
    ps = [add(bpy.ops.mesh.primitive_cube_add, "Crate", M["crate"], loc=(0, 0, 0.4), scale=(0.42, 0.42, 0.4)),
          add(bpy.ops.mesh.primitive_cube_add, "Crate", M["crate"], loc=(0.85, 0.1, 0.35), rot=(0, 0, 0.3), scale=(0.36, 0.36, 0.35)),
          add(bpy.ops.mesh.primitive_cube_add, "Crate", M["crate"], loc=(0.15, 0.05, 1.1), rot=(0, 0, -0.25), scale=(0.33, 0.33, 0.3))]
    sack = add(bpy.ops.mesh.primitive_uv_sphere_add, "Sack", M["hay"], loc=(-0.65, 0.3, 0.3), scale=(0.32, 0.28, 0.32), segments=8, ring_count=6, radius=1)
    jitter(sack, 0.03)
    ps.append(sack)
    attach(ps, root)


def hills(M, center, radius, count=14, mat="forest_floor", skip=None):
    """Low dark hills in a ring far out: the ground never ends in a hard edge. `skip(x, y)` leaves a gap."""
    r = Ctx.rng
    for i in range(count):
        a = i / count * math.tau + r.uniform(-0.1, 0.1)
        rr = radius * r.uniform(0.9, 1.15)
        if skip and skip(center[0] + math.cos(a) * rr, center[1] + math.sin(a) * rr):
            continue
        h = add(bpy.ops.mesh.primitive_uv_sphere_add, f"Hill{i}", M[mat], loc=(center[0] + math.cos(a) * rr, center[1] + math.sin(a) * rr, -2.0),
                segments=12, ring_count=8, radius=1, scale=(r.uniform(22, 34), r.uniform(16, 26), r.uniform(5, 9)))
        jitter(h, 0.05)


def church(M, loc, yaw):
    """A crooked chapel with a tall spire: closes the end of the lane against the sky."""
    root = group("Church", loc, yaw=yaw, tilt=math.radians(1.5))
    ps = [add(bpy.ops.mesh.primitive_cube_add, "Nave", M["stone"], loc=(0, -3.0, 2.6), scale=(2.6, 4.0, 2.6)),
          add(bpy.ops.mesh.primitive_cube_add, "Tower", M["stone"], loc=(0, 1.8, 5.0), scale=(1.5, 1.5, 5.0)),
          add(bpy.ops.mesh.primitive_cone_add, "Spire", M["roof"], loc=(0, 1.8, 12.6), vertices=4, radius1=2.0, depth=5.2, rot=(0, 0, math.radians(45))),
          add(bpy.ops.mesh.primitive_cube_add, "Belfry", M["window"], loc=(0, 0.28, 8.2), scale=(0.45, 0.04, 0.7)),
          add(bpy.ops.mesh.primitive_cylinder_add, "RoseWindow", M["window_dark"], loc=(0, 0.28, 5.6), rot=(math.radians(90), 0, 0), vertices=12, radius=0.6, depth=0.08)]
    nave_roof = mesh_obj("NaveRoof", [(-3.0, -7.3, 5.1), (3.0, -7.3, 5.1), (0, -7.3, 7.6), (-3.0, 0.3, 5.1), (3.0, 0.3, 5.1), (0, 0.3, 7.6)],
                         [(0, 2, 5, 3), (1, 4, 5, 2)], M["roof"])
    nave_roof.modifiers.new("Thickness", "SOLIDIFY").thickness = 0.2
    ps.append(nave_roof)
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "Cross", M["dark_wood"], loc=(0, 1.8, 15.6), scale=(0.06, 0.06, 0.6)))
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "CrossBar", M["dark_wood"], loc=(0, 1.8, 15.8), scale=(0.3, 0.06, 0.06)))
    attach(ps, root)
