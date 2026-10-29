"""The channel's profile picture (owner, 2026-10-20): a brain in the centre with a red hue around it, in the videos'
cel-shaded, ink-outlined style. A new scene of its own: nothing in the game, intro or thumbnail scenes changes.

    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --factory-startup --python profile/make_profile.py
    python profile/finish_profile.py

The brain: two hemispheres (squashed spheres, a gap for the fissure between them) and a cerebellum; the folds are
procedural (geometry nodes: a Voronoi "distance to edge" pattern, wobbled by noise, pushes the gyri out and leaves the
sulci in; the same value is stored as "fold" so the material darkens, or lights, the creases). A bundle of dark
cables trails down from underneath (the "AI" hint). Rendered on a transparent background at 1600x1600 per look:
    out/brain_natural.png  pink brain, warm key, hard red rims
    out/brain_glow.png     darker brain, the creases glowing red like circuitry
finish_profile.py lays them on the backgrounds (a red halo on black, a solid red disc) -> out/<n>_<look>.png, 800x800.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "village"))
OUT = os.path.join(HERE, "out")

import common  # noqa: E402
from common import begin_scene, glow, light  # noqa: E402

SIZE = 1600


def fold_nodes(scale, strength, stripes=False):
    """Geometry nodes: push the gyri out along the normals; store the gyrus amount (0 = deep in a sulcus) as "fold"."""
    ng = bpy.data.node_groups.new(f"Folds_{scale}_{int(stripes)}", "GeometryNodeTree")
    ng.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    N, L = ng.nodes, ng.links
    gi, go = N.new("NodeGroupInput"), N.new("NodeGroupOutput")
    pos = N.new("GeometryNodeInputPosition")
    noise = N.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 1.6
    noise.inputs["Detail"].default_value = 2.0
    centre = N.new("ShaderNodeVectorMath")
    centre.operation = "SUBTRACT"
    centre.inputs[1].default_value = (0.5, 0.5, 0.5)
    wob = N.new("ShaderNodeVectorMath")
    wob.operation = "SCALE"
    wob.inputs["Scale"].default_value = 0.55
    warped = N.new("ShaderNodeVectorMath")
    warped.operation = "ADD"
    L.new(pos.outputs["Position"], noise.inputs["Vector"])
    L.new(noise.outputs["Color"], centre.inputs[0])
    L.new(centre.outputs[0], wob.inputs[0])
    L.new(pos.outputs["Position"], warped.inputs[0])
    L.new(wob.outputs[0], warped.inputs[1])
    if stripes:  # the cerebellum: fine horizontal bands
        tex = N.new("ShaderNodeTexWave")
        tex.wave_type = "BANDS"
        tex.bands_direction = "Z"
        tex.inputs["Scale"].default_value = scale
        tex.inputs["Distortion"].default_value = 1.5
        L.new(warped.outputs[0], tex.inputs["Vector"])
        raw = tex.outputs["Fac"]
        rng = (0.15, 0.75)
    else:  # the cortex: long winding folds (wave bands, heavily distorted)
        tex = N.new("ShaderNodeTexWave")
        tex.wave_type = "RINGS"
        tex.rings_direction = "SPHERICAL"
        tex.inputs["Scale"].default_value = scale
        tex.inputs["Distortion"].default_value = 9.0
        tex.inputs["Detail"].default_value = 1.5
        tex.inputs["Detail Scale"].default_value = 1.0
        L.new(warped.outputs[0], tex.inputs["Vector"])
        raw = tex.outputs["Fac"]
        rng = (0.04, 0.3)  # narrow creases, broad rounded folds
    mr = N.new("ShaderNodeMapRange")
    mr.interpolation_type = "SMOOTHSTEP"
    mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = rng
    L.new(raw, mr.inputs["Value"])
    amt = N.new("ShaderNodeMath")
    amt.operation = "MULTIPLY"
    amt.inputs[1].default_value = strength
    L.new(mr.outputs["Result"], amt.inputs[0])
    nrm = N.new("GeometryNodeInputNormal")
    off = N.new("ShaderNodeVectorMath")
    off.operation = "SCALE"
    L.new(nrm.outputs["Normal"], off.inputs[0])
    L.new(amt.outputs[0], off.inputs["Scale"])
    setp = N.new("GeometryNodeSetPosition")
    L.new(gi.outputs[0], setp.inputs["Geometry"])
    L.new(off.outputs[0], setp.inputs["Offset"])
    store = N.new("GeometryNodeStoreNamedAttribute")
    store.data_type = "FLOAT"
    store.domain = "POINT"
    store.inputs["Name"].default_value = "fold"
    L.new(setp.outputs["Geometry"], store.inputs["Geometry"])
    L.new(mr.outputs["Result"], store.inputs["Value"])
    L.new(store.outputs["Geometry"], go.inputs[0])
    return ng


def rgba(sockets, name):
    """A Mix node's colour socket by name (its float and vector sockets share the names)."""
    return next(x for x in sockets if x.name == name and x.type == "RGBA")


def brain_material(name, base, crease, glow_col=None, glow_str=0.0):
    """Cel-shaded: two light bands, the creases darker (or glowing), read from the "fold" attribute."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    N, L = nt.nodes, nt.links
    diff = N.new("ShaderNodeBsdfDiffuse")
    s2r = N.new("ShaderNodeShaderToRGB")
    ramp = N.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    ramp.color_ramp.elements[0].position, ramp.color_ramp.elements[0].color = 0.0, (0.5, 0.5, 0.5, 1)
    ramp.color_ramp.elements[1].position, ramp.color_ramp.elements[1].color = 0.22, (1.0, 1.0, 1.0, 1)
    attr = N.new("ShaderNodeAttribute")
    attr.attribute_name = "fold"
    mixc = N.new("ShaderNodeMix")
    mixc.data_type = "RGBA"
    rgba(mixc.inputs, "A").default_value = crease + (1,)
    rgba(mixc.inputs, "B").default_value = base + (1,)
    shade = N.new("ShaderNodeMix")
    shade.data_type = "RGBA"
    shade.blend_type = "MULTIPLY"
    shade.inputs["Factor"].default_value = 1.0
    em = N.new("ShaderNodeEmission")
    out = N.new("ShaderNodeOutputMaterial")
    L.new(diff.outputs[0], s2r.inputs[0])
    L.new(s2r.outputs["Color"], ramp.inputs["Fac"])
    L.new(attr.outputs["Fac"], mixc.inputs["Factor"])
    L.new(rgba(mixc.outputs, "Result"), rgba(shade.inputs, "A"))
    L.new(ramp.outputs["Color"], rgba(shade.inputs, "B"))
    if glow_col:  # the creases glow: emission where fold is low, added on top
        inv = N.new("ShaderNodeMath")
        inv.operation = "SUBTRACT"
        inv.inputs[0].default_value = 1.0
        L.new(attr.outputs["Fac"], inv.inputs[1])
        sharp = N.new("ShaderNodeMath")
        sharp.operation = "POWER"
        sharp.inputs[1].default_value = 3.0
        L.new(inv.outputs[0], sharp.inputs[0])
        gem = N.new("ShaderNodeEmission")
        gem.inputs["Color"].default_value = glow_col + (1,)
        L.new(sharp.outputs[0], gem.inputs["Strength"])
        mul = N.new("ShaderNodeMath")
        mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = glow_str
        L.new(sharp.outputs[0], mul.inputs[0])
        L.new(mul.outputs[0], gem.inputs["Strength"])
        L.new(rgba(shade.outputs, "Result"), em.inputs["Color"])
        add = N.new("ShaderNodeAddShader")
        L.new(em.outputs[0], add.inputs[0])
        L.new(gem.outputs[0], add.inputs[1])
        L.new(add.outputs[0], out.inputs["Surface"])
    else:
        L.new(rgba(shade.outputs, "Result"), em.inputs["Color"])
        L.new(em.outputs[0], out.inputs["Surface"])
    return m


def lobe(name, loc, scale, inner, mats, folds, ink):
    """One hemisphere (or the cerebellum): a squashed sphere, flattened on its inner side and underneath."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, radius=1.0, location=(0, 0, 0))
    o = bpy.context.active_object
    o.name = name
    for v in o.data.vertices:
        x, y, z = v.co
        if inner and x * inner > 0:  # the medial side: flatter, against the other hemisphere
            x *= 0.35
        if z < -0.35:  # the underside: flatter
            z = -0.35 + (z + 0.35) * 0.45
        if y > 0.2:  # the frontal lobe: a little lower and narrower
            z *= 1 - 0.12 * (y - 0.2)
            x *= 1 - 0.08 * (y - 0.2)
        v.co = (x * scale[0], y * scale[1], z * scale[2])
    o.location = loc
    for p in o.data.polygons:
        p.use_smooth = True
    for m in mats:
        o.data.materials.append(m)
    o.data.materials.append(ink)
    sub = o.modifiers.new("Sub", "SUBSURF")
    sub.levels = sub.render_levels = 3
    gn = o.modifiers.new("Folds", "NODES")
    gn.node_group = folds
    sol = o.modifiers.new("Ink", "SOLIDIFY")
    sol.thickness, sol.offset, sol.use_flip_normals, sol.use_rim = 0.014, 1.0, True, False
    sol.material_offset = len(o.data.materials) - 1
    return o


def cables(mat, ink):
    """A bundle of dark cables trailing down and away from under the brain."""
    out = []
    for k, (dx, dy, bend, r) in enumerate(((-0.12, -0.05, -0.5, 0.045), (0.0, 0.08, 0.15, 0.055), (0.12, -0.02, 0.6, 0.045),
                                           (-0.05, 0.15, -0.2, 0.035), (0.07, -0.15, 0.35, 0.035), (0.2, 0.1, 0.9, 0.03))):
        cu = bpy.data.curves.new(f"Cable{k}", "CURVE")
        cu.dimensions = "3D"
        cu.bevel_depth = r
        cu.bevel_resolution = 4
        sp = cu.splines.new("BEZIER")
        pts = [(dx, -0.15 + dy, -0.45), (dx * 1.5 + bend * 0.25, -0.1 + dy, -1.0), (dx * 2 + bend * 0.9, 0.0 + dy, -1.7), (dx * 2.5 + bend * 1.5, 0.1 + dy, -2.6)]
        sp.bezier_points.add(len(pts) - 1)
        for bp, p in zip(sp.bezier_points, pts):
            bp.co = p
            bp.handle_left_type = bp.handle_right_type = "AUTO"
        cu.materials.append(mat)
        o = bpy.data.objects.new(f"Cable{k}", cu)
        common.Ctx.coll.objects.link(o)
        out.append(o)
    return out


def build(look):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    M = common.materials()
    sc = begin_scene("Profile", seed=3)
    sc.render.resolution_x = sc.render.resolution_y = SIZE
    sc.render.film_transparent = True
    w = bpy.data.worlds.new("ProfileWorld")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.03, 0.005, 0.008, 1)
    sc.world = w
    if look == "glow":
        mat = brain_material("Brain", (0.62, 0.36, 0.42), (0.18, 0.04, 0.07), glow_col=(1.0, 0.08, 0.04), glow_str=3.0)
    else:
        mat = brain_material("Brain", (0.97, 0.52, 0.62), (0.45, 0.13, 0.22))
    ink = M["ink"]
    big = fold_nodes(3.6, 0.07)
    small = fold_nodes(9.0, 0.03, stripes=True)
    for side in (-1, 1):
        lobe(f"Hemi{side}", (side * 0.315, 0, 0), (0.6, 1.0, 0.72), -side, [mat], big, ink)
    lobe("Cerebellum", (0, -0.62, -0.42), (0.52, 0.34, 0.26), 0, [mat], small, ink)
    cmat = bpy.data.materials.new("Cable")
    cmat.use_nodes = True
    cmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.03, 0.03, 0.035, 1)
    cmat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.35
    cables(cmat, ink)
    # light: a warm key from the front left, hard red rims from behind
    key = light("Key", "AREA", 350, (1.0, 0.94, 0.88), (-3.0, 2.5, 3.0), 3.0)
    key.rotation_euler = (Vector((0, 0, 0)) - key.location).to_track_quat("-Z", "Y").to_euler()
    for name, pos, e in (("RimL", (-2.5, -3.0, 1.2), 900), ("RimR", (2.8, -2.2, 0.6), 900), ("RimTop", (0.0, -1.5, 3.2), 500)):
        r = light(name, "SPOT", e, (1.0, 0.08, 0.05), pos, 0.3, spot=50)
        r.rotation_euler = (Vector((0, 0, 0)) - r.location).to_track_quat("-Z", "Y").to_euler()
    cam = common.camera("Profile", (-4.9, 2.15, 1.55), (0.05, -0.05, -0.5), lens=58, moment="the profile picture")
    sc.camera = cam
    frame(sc, cam)
    return sc


def frame(sc, cam, width=0.8, centre=(0.5, 0.56)):
    """Centre the brain in the picture (camera shift) at `width` of the frame, from its outline as the camera sees it;
    a little above centre, so the cables have room below inside the round crop."""
    from bpy_extras.object_utils import world_to_camera_view
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in sc.objects:
        if o.name.startswith(("Hemi", "Cerebellum")):
            ev = o.evaluated_get(dg)
            pts += [ev.matrix_world @ Vector(c) for c in ev.bound_box]
    for _ in range(3):  # zoom, then re-centre (the shift changes nothing in the size)
        bpy.context.view_layer.update()
        vs = [world_to_camera_view(sc, cam, p) for p in pts]
        x0, x1 = min(v.x for v in vs), max(v.x for v in vs)
        y0, y1 = min(v.y for v in vs), max(v.y for v in vs)
        cam.data.lens *= width / (x1 - x0)
        bpy.context.view_layer.update()
        vs = [world_to_camera_view(sc, cam, p) for p in pts]
        cx = (min(v.x for v in vs) + max(v.x for v in vs)) / 2
        cy = (min(v.y for v in vs) + max(v.y for v in vs)) / 2
        cam.data.shift_x += cx - centre[0]
        cam.data.shift_y += cy - centre[1]


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for look in ("natural", "glow"):
        sc = build(look)
        sc.render.filepath = os.path.join(OUT, f"brain_{look}.png")
        sc.render.image_settings.color_mode = "RGBA"
        bpy.ops.render.render(write_still=True, scene=sc.name)
        print(f"[profile] brain_{look}")
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "profile.blend"))
    print("[profile] done")
