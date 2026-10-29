"""Shared building blocks for every location: cel-shaded materials, ink outlines, primitive helpers, lights, marks.

Style (owner's reference, 2026-10-01): an illustrated, cel-shaded horror village.
- Light is cut into flat bands that keep its colour.
- Shadows fall to a cool violet.
- Dark ink outlines (inverted hull).
- Warm windows and lanterns against a deep teal night.

Everything is built from primitives with fixed seeds, so every build is identical.
"""
import math
import os
import random

import bpy
from mathutils import Matrix, Vector

AMBIENT = (0.05, 0.05, 0.10)
# seats 1..10: amber, sky blue, green, magenta, white, cyan, violet, lime, orange, royal blue (no red: red is the wolves')
INK_SCALE = 0.8  # all ink outlines (sets and figures); owner 2026-10-04: 20% thinner
from colors import SEAT_COLORS  # noqa: E402  (by seat; colors.use_game(gid) gives each seat its model's colour)


class Ctx:
    """The scene and collection being built, and its random generator."""
    scene: bpy.types.Scene = None
    coll: bpy.types.Collection = None
    rng = random.Random(1)


def use_scene(sc, seed: int = 1) -> bpy.types.Scene:
    """Make an existing scene the build target without clearing it (the director places figures this way)."""
    if isinstance(sc, str):
        sc = bpy.data.scenes[sc]
    Ctx.scene, Ctx.coll, Ctx.rng = sc, sc.collection, random.Random(seed)
    return sc


def begin_scene(name: str, seed: int) -> bpy.types.Scene:
    """Create (or empty) a scene and make it the build target."""
    sc = bpy.data.scenes.get(name)
    if sc is None:
        sc = bpy.data.scenes.new(name)
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for w in [w for w in bpy.data.worlds if w.name.split(".")[0] in (f"Night_{name}", f"Dawn_{name}", f"Day_{name}", "RoomDark") and w.users == 0]:
        bpy.data.worlds.remove(w)
    for m in [m for m in bpy.data.materials if m.name.split(".")[0] == f"Fog_{name}" and m.users == 0]:
        bpy.data.materials.remove(m)
    Ctx.scene, Ctx.coll, Ctx.rng = sc, sc.collection, random.Random(seed)
    sc["ww_ambient"] = AMBIENT
    sc["ww_seat_glow"] = 0.75
    sc["ww_phase"] = 0.0  # 0..1 over one loop, driven by the director (fog drift, star twinkle)
    sc["ww_preset"] = "night"
    if bpy.context.window is not None:
        bpy.context.window.scene = sc
    elif bpy.context.window_manager.windows:
        bpy.context.window_manager.windows[0].scene = sc
    setup_render(sc)
    return sc


def setup_render(sc):
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    sc.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
    for attr, value in [("taa_render_samples", 48), ("volumetric_tile_size", "4"), ("volumetric_samples", 64),
                        ("volumetric_end", 90.0), ("use_volumetric_shadows", False)]:
        try_set(sc.eevee, attr, value)
    try_set(sc.view_settings, "view_transform", "Standard")
    try_set(sc.view_settings, "look", "None")


def try_set(obj, attr, value):
    try:
        setattr(obj, attr, value)
    except Exception as e:
        print(f"[village] skip {attr}: {e}")


# ================================================================ materials (shared by all scenes, created once)

def _base_color(nt, color, noise, noise_scale, voronoi=None):
    if voronoi:
        vo = nt.nodes.new("ShaderNodeTexVoronoi")
        vo.feature = "DISTANCE_TO_EDGE"
        vo.inputs["Scale"].default_value = voronoi
        edge = nt.nodes.new("ShaderNodeMath")
        edge.operation = "LESS_THAN"
        edge.inputs[1].default_value = 0.06
        nt.links.new(vo.outputs["Distance"], edge.inputs[0])
        vo2 = nt.nodes.new("ShaderNodeTexVoronoi")
        vo2.inputs["Scale"].default_value = voronoi
        tint = nt.nodes.new("ShaderNodeMapRange")
        tint.inputs["To Min"].default_value = 0.75
        tint.inputs["To Max"].default_value = 1.15
        nt.links.new(vo2.outputs["Color"], tint.inputs["Value"])
        stone = nt.nodes.new("ShaderNodeVectorMath")
        stone.operation = "SCALE"
        stone.inputs[0].default_value = color
        nt.links.new(tint.outputs["Result"], stone.inputs["Scale"])
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        nt.links.new(edge.outputs[0], mix.inputs["Factor"])
        nt.links.new(stone.outputs["Vector"], mix.inputs[6])
        mix.inputs[7].default_value = (*(c * 0.35 for c in color), 1)
        return mix.outputs[2]
    if noise > 0:
        tex = nt.nodes.new("ShaderNodeTexNoise")
        tex.inputs["Scale"].default_value = noise_scale
        tex.inputs["Detail"].default_value = 0.5
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.interpolation = "CONSTANT"
        ramp.color_ramp.elements[0].color = (*(c * (1 - noise) for c in color), 1)
        ramp.color_ramp.elements[1].position = 0.45
        ramp.color_ramp.elements[1].color = (*color, 1)
        top = ramp.color_ramp.elements.new(0.64)
        top.color = (*(min(1, c * (1 + noise * 0.5)) for c in color), 1)
        nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
        return ramp.outputs["Color"]
    rgb = nt.nodes.new("ShaderNodeRGB")
    rgb.outputs[0].default_value = (*color, 1)
    return rgb.outputs[0]


def toon(name, color, noise=0.0, noise_scale=3.0, voronoi=None, bands=0.2, cap=None):
    """Cel shading: incoming light is cut into flat bands (its hue kept); shadow falls to the violet ambient."""
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes.get("Principled BSDF"))
    out = nt.nodes.get("Material Output")
    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    s2r = nt.nodes.new("ShaderNodeShaderToRGB")
    nt.links.new(diff.outputs[0], s2r.inputs[0])
    lum = nt.nodes.new("ShaderNodeRGBToBW")
    nt.links.new(s2r.outputs["Color"], lum.inputs[0])
    lmax = nt.nodes.new("ShaderNodeMath")
    lmax.operation = "MAXIMUM"
    lmax.inputs[1].default_value = 0.0005
    nt.links.new(lum.outputs[0], lmax.inputs[0])
    hue = nt.nodes.new("ShaderNodeVectorMath")
    hue.operation = "DIVIDE"
    nt.links.new(s2r.outputs["Color"], hue.inputs[0])
    nt.links.new(lmax.outputs[0], hue.inputs[1])
    gam = nt.nodes.new("ShaderNodeMath")
    gam.operation = "POWER"
    gam.inputs[1].default_value = 0.4545
    nt.links.new(lum.outputs[0], gam.inputs[0])
    # painterly: the band edges are broken up by a little noise, like brush strokes
    ptc = nt.nodes.new("ShaderNodeTexCoord")
    pn = nt.nodes.new("ShaderNodeTexNoise")  # in object space: the same stroke size on a wall or a hood
    pn.inputs["Scale"].default_value = 3.5
    pn.inputs["Detail"].default_value = 2.0
    nt.links.new(ptc.outputs["Object"], pn.inputs["Vector"])
    pc = nt.nodes.new("ShaderNodeMath")
    pc.operation = "MULTIPLY_ADD"  # (noise - 0.5) * 0.035 + gam: only pixels right at a band edge flip
    pc.inputs[1].default_value = 0.035
    gsh = nt.nodes.new("ShaderNodeMath")
    gsh.operation = "SUBTRACT"
    gsh.inputs[1].default_value = 0.0175
    nt.links.new(gam.outputs[0], gsh.inputs[0])
    nt.links.new(pn.outputs["Fac"], pc.inputs[0])
    nt.links.new(gsh.outputs[0], pc.inputs[2])
    ramp = nt.nodes.new("ShaderNodeValToRGB")  # shadow / half / lit / hot: a few hand-placed steps, no rings
    ramp.color_ramp.interpolation = "CONSTANT"
    ramp.color_ramp.elements[0].color = (0, 0, 0, 1)
    ramp.color_ramp.elements[1].position = 0.16
    ramp.color_ramp.elements[1].color = (0.42, 0.42, 0.42, 1)
    for pos, v in ((0.46, 0.82), (0.9, 1.1)):
        e = ramp.color_ramp.elements.new(pos)
        e.color = (v, v, v, 1)
    nt.links.new(pc.outputs[0], ramp.inputs["Fac"])
    lin = nt.nodes.new("ShaderNodeMath")
    lin.operation = "POWER"
    lin.inputs[1].default_value = 2.2
    if cap is not None:  # some surfaces never get brighter than a band (dark hoods stay dark by the fire)
        cp = nt.nodes.new("ShaderNodeMath")
        cp.operation = "MINIMUM"
        cp.inputs[1].default_value = cap
        nt.links.new(ramp.outputs["Color"], cp.inputs[0])
        nt.links.new(cp.outputs[0], lin.inputs[0])
    else:
        nt.links.new(ramp.outputs["Color"], lin.inputs[0])
    lit = nt.nodes.new("ShaderNodeVectorMath")
    lit.operation = "SCALE"
    nt.links.new(hue.outputs[0], lit.inputs[0])
    nt.links.new(lin.outputs[0], lit.inputs["Scale"])
    # rim light: surfaces turning away from the camera catch extra light where they are lit
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.3
    rm = nt.nodes.new("ShaderNodeMapRange")
    rm.inputs["From Min"].default_value = 0.62
    rm.inputs["From Max"].default_value = 0.92
    nt.links.new(lw.outputs["Facing"], rm.inputs["Value"])
    rs = nt.nodes.new("ShaderNodeMath")
    rs.operation = "MULTIPLY"
    nt.links.new(rm.outputs["Result"], rs.inputs[0])
    nt.links.new(lin.outputs[0], rs.inputs[1])
    rv = nt.nodes.new("ShaderNodeVectorMath")
    rv.operation = "SCALE"
    nt.links.new(hue.outputs[0], rv.inputs[0])
    nt.links.new(rs.outputs[0], rv.inputs["Scale"])
    rw = nt.nodes.new("ShaderNodeVectorMath")
    rw.operation = "MULTIPLY_ADD"  # lit + rim * 0.55
    rw.inputs[1].default_value = (0.55, 0.55, 0.55)
    nt.links.new(rv.outputs[0], rw.inputs[0])
    nt.links.new(lit.outputs[0], rw.inputs[2])
    amb = nt.nodes.new("ShaderNodeVectorMath")
    amb.operation = "ADD"
    nt.links.new(rw.outputs[0], amb.inputs[0])
    # the shadow colour comes from the scene ("ww_ambient"), so lighting presets (night/dawn/day) can change it
    amb_attr = nt.nodes.new("ShaderNodeAttribute")
    amb_attr.attribute_type = "VIEW_LAYER"
    amb_attr.attribute_name = "ww_ambient"
    nt.links.new(amb_attr.outputs["Color"], amb.inputs[1])
    base = _base_color(nt, color, noise, noise_scale, voronoi)
    col = nt.nodes.new("ShaderNodeVectorMath")
    col.operation = "MULTIPLY"
    nt.links.new(amb.outputs[0], col.inputs[0])
    nt.links.new(base, col.inputs[1])
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(col.outputs[0], em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    m["outline"] = True
    return m


def glow(name, color, strength=1.0):
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes.get("Principled BSDF"))
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*color, 1)
    em.inputs["Strength"].default_value = strength
    nt.links.new(em.outputs[0], nt.nodes.get("Material Output").inputs["Surface"])
    m["outline"] = False
    return m


def materials():
    ink = glow("Ink", (0.012, 0.01, 0.022))
    ink.use_backface_culling = True
    try_set(ink, "use_backface_culling_shadow", True)
    M = {
        "ink": ink,
        "ground": toon("Ground", (0.30, 0.30, 0.26), noise=0.25, noise_scale=0.4),
        "forest_floor": toon("ForestFloor", (0.20, 0.24, 0.20), noise=0.3, noise_scale=0.6),
        "grass": toon("Grass", (0.22, 0.30, 0.22), noise=0.3, noise_scale=0.8),
        "cobble": toon("Cobble", (0.55, 0.50, 0.50), voronoi=44),
        "crate": toon("Crate", (0.40, 0.29, 0.20), noise=0.2, noise_scale=6),
        "token": toon("TokenBlank", (0.35, 0.33, 0.30)),
        "flame_grad": flame_material(),
        "path": toon("Path", (0.50, 0.44, 0.40), noise=0.2, noise_scale=1.0),
        "plaster": toon("Plaster", (0.70, 0.64, 0.62), noise=0.12, noise_scale=1.5),
        "plaster_in": toon("PlasterIn", (0.62, 0.55, 0.50), noise=0.12, noise_scale=1.5),
        "beam": toon("Beam", (0.24, 0.16, 0.13)),
        "floorboards": toon("Floorboards", (0.36, 0.25, 0.19), noise=0.25, noise_scale=7),
        "roof": toon("Roof", (0.30, 0.29, 0.36), noise=0.18, noise_scale=2.5),
        "roof_red": toon("RoofRed", (0.42, 0.24, 0.24), noise=0.18, noise_scale=2.5),
        "stone": toon("Stone", (0.48, 0.47, 0.50), noise=0.25, noise_scale=3),
        "mossy": toon("MossyStone", (0.36, 0.42, 0.36), noise=0.3, noise_scale=2),
        "wood": toon("Wood", (0.45, 0.30, 0.22), noise=0.2, noise_scale=5),
        "dark_wood": toon("DarkWood", (0.22, 0.15, 0.13)),
        "hay": toon("Hay", (0.85, 0.66, 0.30), noise=0.25, noise_scale=8),
        "pine": toon("Pine", (0.16, 0.30, 0.27), noise=0.15, noise_scale=1.2),
        "canopy": toon("Canopy", (0.18, 0.24, 0.27), noise=0.15, noise_scale=1.0),
        "bark": toon("Bark", (0.30, 0.24, 0.22)),
        "bone": toon("Bone", (0.85, 0.82, 0.72)),
        "cloth": toon("Cloth", (0.55, 0.20, 0.22), noise=0.15, noise_scale=6),
        "shroud": toon("Shroud", (0.78, 0.76, 0.74), noise=0.1, noise_scale=4),
        "cloak": toon("Cloak", (0.21, 0.195, 0.25), noise=0.12, noise_scale=6, cap=0.45),  # dark: firelight leaves a warm rim, not pink
        "metal": toon("Metal", (0.45, 0.47, 0.52)),
        "rope": toon("Rope", (0.62, 0.52, 0.36)),
        "book": toon("Book", (0.35, 0.18, 0.15)),
        "face": glow("Face", (0.01, 0.008, 0.015)),
        "window": glow("Window", (1.0, 0.86, 0.25), 1.4),
        "window_dark": toon("WindowDark", (0.10, 0.10, 0.16)),
        "night_window": glow("NightWindow", (0.10, 0.18, 0.30), 1.0),
        "lantern": glow("Lantern", (1.0, 0.80, 0.30), 1.6),
        "candle": glow("Candle", (1.0, 0.85, 0.45), 2.2),
        "flame": glow("Flame", (1.0, 0.55, 0.12), 1.8),
        "flame_core": glow("FlameCore", (1.0, 0.88, 0.45), 2.0),
        "ember": glow("Ember", (0.9, 0.25, 0.05), 1.2),
        "moon": glow("Moon", (0.96, 0.95, 0.84), 1.2),
        "eye": glow("Eye", (0.95, 0.95, 0.85), 2.0),
        "wolf_eye": glow("WolfEye", (1.0, 0.08, 0.05), 3.0),
        "orb": glow("Orb", (0.25, 0.7, 1.0), 1.15),
        "potion_heal": glow("PotionHeal", (0.35, 1.0, 0.45), 1.6),
        "potion_poison": glow("PotionPoison", (0.75, 0.25, 1.0), 1.6),
        "blood": toon("Blood", (0.45, 0.03, 0.04)),
        "gold": toon("Gold", (0.95, 0.72, 0.20)),
        "text": glow("Text", (0.95, 0.93, 0.88), 1.0),
        "bubble": glow("Bubble", (0.04, 0.035, 0.06), 1.0),
    }
    for m in M.values():  # keep every shared material in the saved file, including those only figures use
        m.use_fake_user = True
    return M


def flame_material():
    """Fire that is hot yellow at the base and deep orange-red at the tips (object-generated height)."""
    m = bpy.data.materials.get("FlameGrad")
    if m is not None:
        return m
    m = bpy.data.materials.new("FlameGrad")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes.get("Principled BSDF"))
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sp = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sp.inputs[0])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (1.0, 0.92, 0.5, 1)
    ramp.color_ramp.elements[1].color = (0.9, 0.18, 0.03, 1)
    mid = ramp.color_ramp.elements.new(0.45)
    mid.color = (1.0, 0.55, 0.1, 1)
    nt.links.new(sp.outputs["Z"], ramp.inputs["Fac"])
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = 1.7
    nt.links.new(ramp.outputs["Color"], em.inputs["Color"])
    nt.links.new(em.outputs[0], nt.nodes.get("Material Output").inputs["Surface"])
    m["outline"] = False
    return m


# ================================================================ geometry helpers

def add(op, name, material, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), smooth=False, **kw):
    """Add a primitive to the current build scene; the scale is baked into the mesh so outlines stay even."""
    layer_coll = bpy.context.view_layer.layer_collection
    op(location=loc, rotation=rot, **kw)
    o = bpy.context.active_object
    # primitives land in the context scene: move them to the build scene if that is another one
    if o.name not in Ctx.coll.objects:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        Ctx.coll.objects.link(o)
    o.name = name
    if tuple(scale) != (1, 1, 1):
        o.data.transform(Matrix.Diagonal(Vector(scale)).to_4x4())
    if material is not None:
        o.data.materials.append(material)
    if smooth:
        for p in o.data.polygons:
            p.use_smooth = True
    return o


def mesh_obj(name, verts, faces, material):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    Ctx.coll.objects.link(o)
    o.data.materials.append(material)
    return o


def jitter(o, amount):
    r = Ctx.rng
    for v in o.data.vertices:
        v.co += Vector((r.uniform(-amount, amount), r.uniform(-amount, amount), r.uniform(-amount, amount)))


def group(name, loc, yaw=0.0, tilt=0.0):
    e = bpy.data.objects.new(name, None)
    Ctx.coll.objects.link(e)
    e.location = loc
    r = Ctx.rng
    e.rotation_euler = (r.uniform(-tilt, tilt), r.uniform(-tilt, tilt), yaw)
    return e


def attach(parts, root):
    mw = root.matrix_basis.copy()  # the build scene may not be evaluated yet: use the transform itself
    for p in parts:
        p.matrix_world = mw @ p.matrix_world
        p.parent = root
        p.matrix_parent_inverse = mw.inverted()


def light(name, kind, energy, color, loc, radius=0.2, shadow=True, cutoff=None, spot=None):
    d = bpy.data.lights.new(name, kind)
    d.energy, d.color = energy, color
    d.use_shadow = shadow
    if cutoff is not None:
        try_set(d, "use_custom_distance", True)
        try_set(d, "cutoff_distance", cutoff)
    if spot is not None and kind == "SPOT":
        d.spot_size, d.spot_blend = math.radians(spot), 0.65
    if kind != "SUN":
        d.shadow_soft_size = radius
    o = bpy.data.objects.new(name, d)
    o.location = loc
    Ctx.coll.objects.link(o)
    return o


def mark(name, loc, yaw=0.0):
    """A named spot where the director places a figure (arrows show which way it faces)."""
    e = bpy.data.objects.new(f"Mark_{name}", None)
    e.empty_display_type = "SINGLE_ARROW"
    e.empty_display_size = 0.6
    e.location = loc
    e.rotation_euler = (math.radians(-90), 0, yaw)  # the arrow points along the figure's facing
    e["facing_yaw"] = yaw
    Ctx.coll.objects.link(e)
    return e


def camera(name, loc, look_at, lens=28, moment="", covers=()):
    """A named camera preset. `moment` says what story beat it is for; `covers` lists the marks it frames."""
    cam = bpy.data.objects.new(f"Cam_{name}", bpy.data.cameras.new(f"Cam_{name}"))
    cam.data.lens = lens
    cam["moment"] = moment
    cam["covers"] = list(covers)
    cam.location = Vector(loc)
    cam.rotation_euler = (Vector(look_at) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    Ctx.coll.objects.link(cam)
    if Ctx.scene.camera is None:
        Ctx.scene.camera = cam
    return cam


def look_yaw(frm, to):
    """The figure yaw so that its front (+Y) faces `to`."""
    return math.atan2(to[1] - frm[1], to[0] - frm[0]) - math.pi / 2


# ================================================================ sky and fog

def phase_circle(nt, radius):
    """A vector that walks once round a circle per loop (scene attribute "ww_phase" 0..1): periodic motion for noise."""
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_type, at.attribute_name = "VIEW_LAYER", "ww_phase"
    ang = nt.nodes.new("ShaderNodeMath")
    ang.operation = "MULTIPLY"
    ang.inputs[1].default_value = 6.283185
    nt.links.new(at.outputs["Fac"], ang.inputs[0])
    c = nt.nodes.new("ShaderNodeMath")
    c.operation = "COSINE"
    sn = nt.nodes.new("ShaderNodeMath")
    sn.operation = "SINE"
    nt.links.new(ang.outputs[0], c.inputs[0])
    nt.links.new(ang.outputs[0], sn.inputs[0])
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(c.outputs[0], comb.inputs["X"])
    nt.links.new(sn.outputs[0], comb.inputs["Y"])
    sc = nt.nodes.new("ShaderNodeVectorMath")
    sc.operation = "SCALE"
    sc.inputs["Scale"].default_value = radius
    nt.links.new(comb.outputs[0], sc.inputs[0])
    return sc.outputs[0]


def night_sky(moon_dir, top=(0.035, 0.085, 0.11), zenith=(0.004, 0.012, 0.03), halo_strength=0.22, stars=True, halo_min=0.965):
    world = bpy.data.worlds.new(f"Night_{Ctx.scene.name}")
    Ctx.scene.world = world
    Ctx.scene["night_world"] = world.name
    world.use_nodes = True
    wn = world.node_tree
    bg = wn.nodes.get("Background")
    tc = wn.nodes.new("ShaderNodeTexCoord")
    sep = wn.nodes.new("ShaderNodeSeparateXYZ")
    wn.links.new(tc.outputs["Generated"], sep.inputs[0])
    grad = wn.nodes.new("ShaderNodeValToRGB")
    grad.color_ramp.elements[0].color = (*top, 1)
    grad.color_ramp.elements[1].position = 0.55
    grad.color_ramp.elements[1].color = (*zenith, 1)
    wn.links.new(sep.outputs["Z"], grad.inputs["Fac"])
    col = grad.outputs["Color"]
    if stars:
        st = wn.nodes.new("ShaderNodeTexVoronoi")
        st.inputs["Scale"].default_value = 160
        wn.links.new(tc.outputs["Generated"], st.inputs["Vector"])
        sm = wn.nodes.new("ShaderNodeMapRange")
        sm.inputs["From Min"].default_value = 0.035
        sm.inputs["From Max"].default_value = 0.0
        wn.links.new(st.outputs["Distance"], sm.inputs["Value"])
        ab = wn.nodes.new("ShaderNodeMapRange")
        ab.inputs["From Min"].default_value = 0.12
        ab.inputs["From Max"].default_value = 0.35
        wn.links.new(sep.outputs["Z"], ab.inputs["Value"])
        tw_in = wn.nodes.new("ShaderNodeVectorMath")
        tw_in.operation = "MULTIPLY_ADD"  # generated * 40 + a slow circle: each star brightens and dims in turn
        tw_in.inputs[1].default_value = (40.0, 40.0, 40.0)
        wn.links.new(tc.outputs["Generated"], tw_in.inputs[0])
        wn.links.new(phase_circle(wn, 2.0), tw_in.inputs[2])
        tw = wn.nodes.new("ShaderNodeTexNoise")
        tw.inputs["Scale"].default_value = 1.0
        wn.links.new(tw_in.outputs[0], tw.inputs["Vector"])
        twm = wn.nodes.new("ShaderNodeMapRange")
        twm.inputs["From Min"].default_value = 0.3
        twm.inputs["From Max"].default_value = 0.7
        twm.inputs["To Min"].default_value = 0.25
        wn.links.new(tw.outputs["Fac"], twm.inputs["Value"])
        st2 = wn.nodes.new("ShaderNodeMath")
        st2.operation = "MULTIPLY"
        wn.links.new(sm.outputs["Result"], st2.inputs[0])
        wn.links.new(twm.outputs["Result"], st2.inputs[1])
        mul = wn.nodes.new("ShaderNodeMath")
        mul.operation = "MULTIPLY"
        wn.links.new(st2.outputs[0], mul.inputs[0])
        wn.links.new(ab.outputs["Result"], mul.inputs[1])
        a1 = wn.nodes.new("ShaderNodeMix")
        a1.data_type, a1.blend_type = "RGBA", "ADD"
        a1.inputs["Factor"].default_value = 1.0
        wn.links.new(col, a1.inputs[6])
        wn.links.new(mul.outputs[0], a1.inputs[7])
        col = a1.outputs[2]
    if moon_dir is not None:
        dot = wn.nodes.new("ShaderNodeVectorMath")
        dot.operation = "DOT_PRODUCT"
        dot.inputs[1].default_value = tuple(moon_dir)
        wn.links.new(tc.outputs["Generated"], dot.inputs[0])
        halo = wn.nodes.new("ShaderNodeMapRange")
        halo.inputs["From Min"].default_value = halo_min
        halo.inputs["To Max"].default_value = halo_strength
        wn.links.new(dot.outputs["Value"], halo.inputs["Value"])
        a2 = wn.nodes.new("ShaderNodeMix")
        a2.data_type, a2.blend_type = "RGBA", "ADD"
        a2.inputs["Factor"].default_value = 1.0
        wn.links.new(col, a2.inputs[6])
        wn.links.new(halo.outputs["Result"], a2.inputs[7])
        col = a2.outputs[2]
    wn.links.new(col, bg.inputs["Color"])
    return world


def fog_box(size=(70, 70, 10), center=(0, 0, 4), color=(0.28, 0.36, 0.55), ground_density=0.035, top_density=0.0, falloff=0.35):
    bpy.ops.mesh.primitive_cube_add(location=center, size=1)
    fog = bpy.context.active_object
    if fog.name not in Ctx.coll.objects:
        for c in list(fog.users_collection):
            c.objects.unlink(fog)
        Ctx.coll.objects.link(fog)
    fog.name = "Fog"
    fog.scale = size
    fm = bpy.data.materials.new(f"Fog_{Ctx.scene.name}")
    fm.use_nodes = True
    nt = fm.node_tree
    nt.nodes.remove(nt.nodes.get("Principled BSDF"))
    fv = nt.nodes.new("ShaderNodeVolumePrincipled")
    fv.inputs["Color"].default_value = (*color, 1)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sp = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sp.inputs[0])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.name = "FogHeight"  # lighting presets scale its density
    mr.inputs["From Max"].default_value = falloff
    mr.inputs["To Min"].default_value = ground_density
    mr.inputs["To Max"].default_value = top_density
    nt.links.new(sp.outputs["Z"], mr.inputs["Value"])
    # drifting patches: noise moved round a small circle once per loop
    fin = nt.nodes.new("ShaderNodeVectorMath")
    fin.operation = "ADD"
    nt.links.new(tc.outputs["Generated"], fin.inputs[0])
    nt.links.new(phase_circle(nt, 0.06), fin.inputs[1])
    fnz = nt.nodes.new("ShaderNodeTexNoise")
    fnz.inputs["Scale"].default_value = 5.0
    nt.links.new(fin.outputs[0], fnz.inputs["Vector"])
    fmr = nt.nodes.new("ShaderNodeMapRange")
    fmr.inputs["To Min"].default_value = 0.35
    fmr.inputs["To Max"].default_value = 1.5
    nt.links.new(fnz.outputs["Fac"], fmr.inputs["Value"])
    fml = nt.nodes.new("ShaderNodeMath")
    fml.operation = "MULTIPLY"
    nt.links.new(mr.outputs["Result"], fml.inputs[0])
    nt.links.new(fmr.outputs["Result"], fml.inputs[1])
    nt.links.new(fml.outputs[0], fv.inputs["Density"])
    nt.links.new(fv.outputs["Volume"], nt.nodes.get("Material Output").inputs["Volume"])
    fog.data.materials.append(fm)
    return fog


def moon(cam, frame_xy=(0.55, 0.86), distance=120, radius=6.5, M=None, strength=0.42):
    """Put the moon at a spot in a camera's frame (x, y in -1..1), and light the scene from it."""
    tx = 18 / cam.data.lens
    d = (cam.matrix_basis.to_3x3() @ Vector((frame_xy[0] * tx, frame_xy[1] * tx * 9 / 16, -1))).normalized()
    add(bpy.ops.mesh.primitive_uv_sphere_add, "Moon", M["moon"], loc=tuple(cam.location + d * distance), segments=32, ring_count=16, radius=radius, smooth=True)
    ml = light("Moonlight", "SUN", strength, (0.5, 0.7, 0.95), (0, 0, 20))
    ml.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    ml.data.angle = math.radians(2)
    return d


# ================================================================ ink outlines

def outline_all(M, skip=("Ground", "Fog")):
    """An inverted hull on every solid, cel-shaded mesh in the build scene."""
    for o in list(Ctx.scene.objects):
        if o.type != "MESH" or o.name.split(".")[0] in skip or not o.data.materials:
            continue
        if not o.data.materials[0].get("outline", False) or any(m.name == "Ink" for m in o.modifiers):
            continue
        t = max(0.03, min(0.09, 0.025 + 0.012 * max(o.dimensions)))
        o.data.materials.append(M["ink"])
        sol = o.modifiers.new("Ink", "SOLIDIFY")
        sol.thickness, sol.offset, sol.use_flip_normals, sol.use_rim = t * INK_SCALE, 1.0, True, False
        sol.material_offset = len(o.data.materials) - 1
