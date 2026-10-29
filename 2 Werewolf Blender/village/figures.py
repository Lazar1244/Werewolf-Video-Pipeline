"""The cast: one hooded figure for everyone, with a seat colour (1..10) and small role tells.

Every part is a template mesh built once (and kept in the .blend), so placing a figure is a handful of
`bpy.data.objects.new` calls rather than operators. That's fast enough for a director to place 10 figures per shot.

Poses: "sit" (on a log or stool, 0.46 m seat), "stand", "sleep" (on its back, in bed), "body" (the dead character on their back, at dawn).
Roles: villager (plain), werewolf (at night: ears, red eyes, claws), seer (glowing orb), witch (hat + two potions),
hunter (brimmed hat with a feather, crossbow across the chest); `sheriff=True` adds a gold star on the hood.
Seat colours are unlit (emission), so they read the same in firelight, moonlight or daylight.
"""
import math
import random
import zlib

import bpy
from mathutils import Matrix, Vector

from common import INK_SCALE, Ctx, SEAT_COLORS, glow

WOLVES = ("werewolf", "big_bad_wolf", "accursed_wolf_father", "white_werewolf")
_cache = {}


def seat_mat(seat):
    """The unlit seat colour (seats 1..10). Its strength comes from the scene ("ww_seat_glow"): about 0.75 normally,
    turned down by the dusk preset so a figure against the sky reads as a black silhouette."""
    name = f"SeatGlow{seat}"
    m = bpy.data.materials.get(name)
    if m is not None:  # made earlier (saved in the .blend): give it the seat's current colour (its model's, colors.py)
        em = next((n for n in m.node_tree.nodes if n.type == "EMISSION"), None) if m.use_nodes else None
        if em is not None:
            em.inputs["Color"].default_value = (*SEAT_COLORS[seat - 1], 1)
        return m
    m = glow(name, SEAT_COLORS[seat - 1], 1.0)
    nt = m.node_tree
    em = next(n for n in nt.nodes if n.type == "EMISSION")
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_type, attr.attribute_name = "VIEW_LAYER", "ww_seat_glow"
    nt.links.new(attr.outputs["Fac"], em.inputs["Strength"])
    m.use_fake_user = True
    return m


def _template(key, op, material, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), jitter=0.0, **kw):
    """A mesh in figure space, built once (by operator) and reused by every figure."""
    name = f"T_{key}"
    me = _cache.get(name) or bpy.data.meshes.get(name)
    if me is None:
        op(location=(0, 0, 0), **kw)
        tmp = bpy.context.active_object
        me = tmp.data
        bpy.data.objects.remove(tmp, do_unlink=True)
        me.name = name
        rng = random.Random(zlib.crc32(key.encode()))  # the same jitter on every run (str hash() is randomised)
        for v in me.vertices:
            if jitter:
                v.co += Vector((rng.uniform(-jitter, jitter), rng.uniform(-jitter, jitter), rng.uniform(-jitter, jitter)))
        me.transform(Matrix.LocRotScale(Vector(loc), __import__("mathutils").Euler(rot), Vector(scale)))
        me.materials.append(material)
        me.materials.append(bpy.data.materials["Ink"])
        me.use_fake_user = True  # templates survive in the saved file for the director
    _cache[name] = me
    return me


def _place(root, me, ink=0.03, override=None, name=None, pivot=None):
    """Add a part. Parts are modelled in figure space; with a pivot they hang from it (and move with it)."""
    o = bpy.data.objects.new(name or me.name[2:], me)
    Ctx.coll.objects.link(o)
    if pivot is not None:
        o.parent = pivot
        o.matrix_parent_inverse = Matrix.Translation(Vector(pivot["abs"])).inverted()
    else:
        o.parent = root
    if override is not None:  # per-figure material on slot 0 (the seat colour), the mesh stays shared
        o.material_slots[0].link = "OBJECT"
        o.material_slots[0].material = override
    if ink and me.materials[0].get("outline", False) or (ink and override is not None and override.get("outline", False)):
        sol = o.modifiers.new("Ink", "SOLIDIFY")
        sol.thickness, sol.offset, sol.use_flip_normals, sol.use_rim = ink * INK_SCALE, 1.0, True, False
        sol.material_offset = 1
    return o


def _pivot(parent, name, abs_pos, parent_abs=(0, 0, 0)):
    """An animation pivot at `abs_pos` (figure space), child of `parent` (whose own pivot sits at `parent_abs`)."""
    e = bpy.data.objects.new(name, None)
    Ctx.coll.objects.link(e)
    e.parent = parent
    e.location = Vector(abs_pos) - Vector(parent_abs)
    e.empty_display_size = 0.06
    e["abs"] = list(abs_pos)
    return e


def _root(name, loc, rot):
    e = bpy.data.objects.new(name, None)
    Ctx.coll.objects.link(e)
    e.location = loc
    e.rotation_euler = rot
    return e


def figure(M, name, loc, yaw, seat, role="villager", pose="sit", night=True, sheriff=False, clawed=False, lean=0.0):
    """Place one figure at `loc`, its front (+Y) turned by `yaw`. Returns (root, head position in world space)."""
    if pose == "body":
        return body(M, name, loc, yaw, seat, clawed, role, sheriff)
    P = bpy.ops.mesh
    sitting = pose == "sit"
    tall = 1.1 if sitting else 1.4
    base = 0.46 if sitting else 0.0
    if pose == "sleep":
        root = _root(name, loc, (math.radians(90), 0, yaw + math.pi))  # on its back, head toward the pillow
    else:
        root = _root(name, (loc[0], loc[1], loc[2] + base), (lean, 0, yaw))  # lean < 0 tips forward
    k = "s" if sitting else "t"
    sm = seat_mat(seat)
    anim = {"seat": seat, "pose": pose, "eyes": [], "ears": [], "potions": [], "hands": []}
    neck = (0, 0, tall - 0.02)
    head = _pivot(root, f"{name}_Head", neck)
    anim["head"] = head.name
    anim["body"] = _place(root, _template(f"Body_{k}", P.primitive_cone_add, M["cloak"], (0, 0, tall / 2), jitter=0.02, vertices=9, radius1=0.48, radius2=0.18, depth=tall), 0.03).name
    _place(root, _template(f"Hood_{k}", P.primitive_uv_sphere_add, M["cloak"], (0, -0.06, tall + 0.17), scale=(1, 1.05, 1.15), segments=10, ring_count=7, radius=0.28), 0.03, pivot=head)
    _place(root, _template(f"HoodTip_{k}", P.primitive_cone_add, M["cloak"], (0, -0.22, tall + 0.48), (math.radians(-40), 0, 0), vertices=6, radius1=0.13, depth=0.4), 0.025, pivot=head)
    # the dark face fills the whole hood opening (a lower face read as a beard, with the lit hood inside above it)
    _place(root, _template(f"FaceC_{k}", P.primitive_uv_sphere_add, M["face"], (0, 0.125, tall + 0.16), scale=(0.92, 0.6, 1.08), segments=12, ring_count=8, radius=0.2), 0, pivot=head)
    anim["scarf"] = _place(root, _template(f"Scarf_{k}", P.primitive_torus_add, M["cloak"], (0, 0, tall - 0.07), major_radius=0.23, minor_radius=0.085, major_segments=12, minor_segments=5), 0.02, override=sm, name="Scarf").name
    _place(root, _template(f"HoodRim_{k}", P.primitive_torus_add, M["cloak"], (0, 0.13, tall + 0.16), (math.radians(90), 0, 0), scale=(0.95, 1, 1.15), major_radius=0.2, minor_radius=0.04, major_segments=12, minor_segments=4), 0, override=sm, name="HoodRim", pivot=head)
    if sitting:  # knees under the cloak and hands folded in the lap
        for s in (-1, 1):
            _place(root, _template(f"Knee{s}", P.primitive_uv_sphere_add, M["cloak"], (0.17 * s, 0.33, 0.12), scale=(0.17, 0.28, 0.13), segments=8, ring_count=6, radius=1), 0.025)
        anim["hands"].append(_place(root, _template("Sleeves_s", P.primitive_cylinder_add, M["cloak"], (0, 0.3, 0.42), (0, math.radians(90), 0), scale=(1, 1, 1), vertices=8, radius=0.1, depth=0.55), 0.025).name)
        anim["hands"].append(_place(root, _template("Hands_s", P.primitive_uv_sphere_add, M["face"], (0, 0.4, 0.42), scale=(1.3, 0.8, 0.8), segments=6, ring_count=4, radius=0.08), 0).name)
    else:  # sleeves hanging at the sides, dark hands
        for s in (-1, 1):
            anim["hands"].append(_place(root, _template(f"Sleeve{s}", P.primitive_cone_add, M["cloak"], (0.36 * s, 0.05, tall * 0.55), (0, math.radians(-8 * s), 0), vertices=7, radius1=0.12, radius2=0.08, depth=0.62), 0.025).name)
            anim["hands"].append(_place(root, _template(f"Hand{s}", P.primitive_uv_sphere_add, M["face"], (0.38 * s, 0.08, tall * 0.55 - 0.36), segments=6, ring_count=4, radius=0.07), 0).name)
    wolf_form = role in WOLVES and night
    eye = "WolfEye" if wolf_form else "Eye"
    for s in (-1, 1):
        anim["eyes"].append(_place(root, _template(f"{eye}{s}_{k}", P.primitive_uv_sphere_add, M["wolf_eye" if wolf_form else "eye"], (0.068 * s, 0.24, tall + 0.18), segments=6, ring_count=4, radius=0.034 if wolf_form else 0.028), 0, pivot=head).name)
    if wolf_form:
        for s in (-1, 1):
            ear = _pivot(head, f"{name}_Ear{s}", (0.15 * s, -0.02, tall + 0.32), neck)
            anim["ears"].append(ear.name)
            _place(root, _template(f"Ear{s}_{k}", P.primitive_cone_add, M["cloak"], (0.17 * s, -0.02, tall + 0.46), (math.radians(-10), math.radians(18 * s), 0), vertices=4, radius1=0.09, depth=0.3), 0.02, pivot=ear)
            for j in range(3):
                z = 0.1 if sitting else 0.12
                _place(root, _template(f"Claw{s}{j}_{k}", P.primitive_cone_add, M["bone"], (0.36 * s + (j - 1) * 0.05 * s, 0.34, z), (math.radians(110), 0, 0), vertices=4, radius1=0.025, depth=0.14), 0)
    if role == "seer":
        anim["orb"] = _place(root, _template(f"Orb_{k}", P.primitive_ico_sphere_add, M["orb"], (0, 0.5, 0.62 if sitting else tall * 0.62), subdivisions=2, radius=0.13), 0).name
    if role == "witch":
        hat = _pivot(head, f"{name}_Hat", (0, -0.03, tall + 0.37), neck)
        anim["hat"] = hat.name
        _place(root, _template(f"WitchHat_{k}", P.primitive_cone_add, M["cloak"], (0, -0.05, tall + 0.66), (math.radians(-14), 0, 0), vertices=8, radius1=0.25, depth=0.7), 0.025, pivot=hat)
        _place(root, _template(f"HatBrim_{k}", P.primitive_cylinder_add, M["cloak"], (0, -0.02, tall + 0.37), vertices=12, radius=0.44, depth=0.04), 0.02, pivot=hat)
        for s, pm in ((-1, "potion_heal"), (1, "potion_poison")):
            anim["potions"].append(_place(root, _template(f"Potion{s}_{k}", P.primitive_uv_sphere_add, M[pm], (0.3 * s, 0.36, tall * 0.42), segments=8, ring_count=6, radius=0.075), 0).name)
    if role == "hunter":  # a wide hat that reads from any side, and a crossbow carried across the chest
        hat = _pivot(head, f"{name}_Hat", (0, -0.02, tall + 0.4), neck)
        anim["hat"] = hat.name
        _place(root, _template(f"HunterBrim_{k}", P.primitive_cylinder_add, M["dark_wood"], (0, -0.02, tall + 0.4), (math.radians(-6), 0, 0), vertices=12, radius=0.46, depth=0.04), 0.02, pivot=hat)
        _place(root, _template(f"HunterCrown_{k}", P.primitive_cone_add, M["dark_wood"], (0, -0.04, tall + 0.53), vertices=10, radius1=0.25, radius2=0.18, depth=0.26), 0.02, pivot=hat)
        feather = _pivot(hat, f"{name}_Feather", (0.14, -0.02, tall + 0.52), (0, -0.02, tall + 0.4))
        anim["feather"] = feather.name
        _place(root, _template(f"Feather_{k}", P.primitive_cone_add, M["cloth"], (0.22, -0.05, tall + 0.68), (math.radians(-25), math.radians(35), 0), vertices=4, radius1=0.05, depth=0.42), 0.015, pivot=feather)
        _place(root, _template(f"Stock_{k}", P.primitive_cube_add, M["wood"], (0, 0.42, tall * 0.62), (0, math.radians(55), 0), scale=(0.035, 0.035, 0.4)), 0.015)
        _place(root, _template(f"Bow_{k}", P.primitive_torus_add, M["dark_wood"], (0.18, 0.46, tall * 0.78), (math.radians(90), 0, math.radians(-35)), major_radius=0.22, minor_radius=0.022, major_segments=12, minor_segments=4), 0.015)
    if sheriff:  # a gold star on the hood, above the face
        star = _pivot(head, f"{name}_Star", (0, 0.29, tall + 0.4), neck)
        anim["star"] = star.name
        _place(root, _star(M, f"Star_{k}", (0, 0.29, tall + 0.4), 0.12), 0.012, pivot=star)
    root["anim"] = anim
    return root, root.matrix_basis @ Vector((0, 0, tall + 0.18))


def _star(M, key, loc, r):
    name = f"T_{key}"
    me = _cache.get(name) or bpy.data.meshes.get(name)
    if me is None:
        verts = []
        for i in range(10):
            a = math.pi / 2 + i * math.pi / 5
            rr = r if i % 2 == 0 else r * 0.45
            verts += [(math.cos(a) * rr, -0.015, math.sin(a) * rr), (math.cos(a) * rr, 0.015, math.sin(a) * rr)]
        faces = [tuple(range(1, 20, 2)), tuple(range(18, -1, -2))]
        faces += [(2 * i, 2 * ((i + 1) % 10), 2 * ((i + 1) % 10) + 1, 2 * i + 1) for i in range(10)]
        me = bpy.data.meshes.new(name)
        me.from_pydata(verts, [], faces)
        me.transform(Matrix.Translation(Vector(loc)))
        me.materials.append(M["gold"])
        me.materials.append(bpy.data.materials["Ink"])
        me.use_fake_user = True
    _cache[name] = me
    return me


def body(M, name, loc, yaw, seat, clawed, role="villager", sheriff=False):
    """The dead character themselves (owner: so we see who died): their cloak, seat-colour scarf and role tells, on
    their back with the head end toward +Y, X-ed out eyes, a pool of blood beneath; claw tears if the pack killed them."""
    P = bpy.ops.mesh
    root = _root(name, loc, (0, 0, yaw))
    # an irregular pool, mostly under the body, spreading out on one side
    _place(root, _template("BloodPool2", P.primitive_circle_add, M["blood"], (0.32, 0.25, 0.006), scale=(0.75, 1.05, 1), jitter=0.12, vertices=13, radius=0.5, fill_type="NGON"), 0)
    fig, _ = figure(M, f"{name}_Fig", (0, 0, 0), 0.0, seat, role, pose="stand", night=False, sheriff=sheriff)
    del fig["anim"]  # the dead keep still: no breathing, no blinking
    # on its back (front up), head toward +Y, tipped 12 degrees so the wide cloak hem and the hood both rest on the ground
    lie = Matrix.Rotation(math.radians(-12), 4, "X") @ Matrix.Rotation(math.pi, 4, "Y") @ Matrix.Rotation(-math.pi / 2, 4, "X")
    fig.parent = root
    fig.matrix_parent_inverse = Matrix.Identity(4)
    flat = Matrix.Diagonal((1.0, 0.72, 1.0, 1.0))  # a little flattened front to back: a slumped cloak, not a fallen cone
    fig.matrix_basis = Matrix.Translation(Vector((0, -0.85, 0.36))) @ lie @ flat
    head = next(o for o in fig.children if o.name.startswith(f"{name}_Fig_Head"))
    for o in [o for o in fig.children_recursive if o.data is not None and o.data.name.startswith(("T_Eye", "T_WolfEye"))]:
        bpy.data.objects.remove(o, do_unlink=True)
    tall = 1.4
    for s in (-1, 1):  # X-ed out eyes
        for j in (-1, 1):
            _place(fig, _template(f"DeadX{s}{j}", P.primitive_cube_add, M["eye"], (0.068 * s, 0.245, tall + 0.18), (0, math.radians(45 * j), 0), scale=(0.008, 0.012, 0.045)), 0, pivot=head)
    if clawed:  # killed by the pack: three dark tears across the chest
        for j, (dx, dy, ang, ln) in enumerate(((-0.13, -0.2, 14, 0.2), (0.0, -0.3, 27, 0.26), (0.13, -0.4, 41, 0.21))):
            _place(root, _template(f"TearD{j}", P.primitive_cube_add, M["blood"], (dx, dy, 0.43 + 0.21 * dy), (math.radians(-12), 0, math.radians(ang)), scale=(0.02, ln, 0.012)), 0)
    return root, root.matrix_basis @ Vector((0, 0.75, 0.45))


def prebuild(M):
    """Build every template once (into a throwaway scene), so the saved set file carries them all for the director."""
    from common import Ctx, use_scene
    tmp = bpy.data.scenes.new("_templates")
    prev = (Ctx.scene, Ctx.coll, Ctx.rng)
    use_scene(tmp)
    for pose in ("sit", "stand", "sleep"):
        for role in ("villager", "werewolf", "seer", "witch", "hunter"):
            for night in (True, False):
                figure(M, "tmp", (0, 0, 0), 0.0, 1, role, pose=pose, night=night, sheriff=True)
    for role in ("villager", "werewolf", "seer", "witch", "hunter"):
        figure(M, "tmp", (0, 0, 0), 0.0, 1, role, pose="body", clawed=True, sheriff=True)
    for o in list(tmp.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.scenes.remove(tmp)
    Ctx.scene, Ctx.coll, Ctx.rng = prev
