"""S1 style test, take 2: an illustrated, cel-shaded horror village (owner's reference image, 2026-10-01).

Run (does not touch an open Blender window):
    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --factory-startup --python blender/style_toon.py

Look:
- Cel shading: light is cut into a few flat bands, keeping its colour (cold moon, warm lanterns).
- Ink outlines: an inverted hull on every solid object.
- Crooked half-timbered houses, a cobbled square, and a deep teal starry sky.
Everything is built from primitives (no downloaded assets) with a fixed seed.
Writes out/style_toon.png and style_toon.blend.
"""
import math
import os
import random

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
rng = random.Random(2024)


def try_set(obj, attr, value):
    try:
        setattr(obj, attr, value)
    except Exception as e:
        print(f"[toon] skip {attr}: {e}")


LIVE = not bpy.app.background  # run inside an open Blender (through the MCP bridge): build, don't render
old = bpy.data.scenes.get("Village")
if old is not None:
    for o in list(old.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    scene = old
elif LIVE:
    scene = bpy.data.scenes.new("Village")
else:
    scene = bpy.context.scene
    scene.name = "Village"
    for o in list(scene.objects):
        bpy.data.objects.remove(o, do_unlink=True)
if bpy.context.window is not None:
    bpy.context.window.scene = scene
coll = scene.collection
for m in [m for m in bpy.data.materials if m.users == 0]:
    bpy.data.materials.remove(m)
engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
for attr, value in [("taa_render_samples", 48), ("volumetric_tile_size", "4"), ("volumetric_samples", 64),
                    ("volumetric_end", 90.0), ("use_volumetric_shadows", False)]:
    try_set(scene.eevee, attr, value)
try_set(scene.view_settings, "view_transform", "Standard")  # flat colours stay exactly as designed
try_set(scene.view_settings, "look", "None")

# ================================================================ materials
AMBIENT = (0.05, 0.05, 0.10)  # the colour of shadow: cool violet


def _base_color(nt, color, noise, noise_scale, voronoi=None):
    """The painted base colour: flat, or mottled in a few stepped tones, or cobbles (voronoi)."""
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
        nt.links.new(vo2.outputs["Color"], tint.inputs["Value"])  # colour -> float (average)
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


def toon(name, color, noise=0.0, noise_scale=3.0, voronoi=None, bands=0.2):
    """Cel shading. Light hitting the surface is cut into flat bands; its hue (warm lantern / cold moon) is kept.
    Shadowed areas fall to the violet ambient."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes.get("Principled BSDF"))
    out = nt.nodes.get("Material Output")
    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    diff.inputs["Color"].default_value = (1, 1, 1, 1)
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
    snap = nt.nodes.new("ShaderNodeMath")
    snap.operation = "SNAP"
    snap.inputs[1].default_value = bands
    nt.links.new(gam.outputs[0], snap.inputs[0])
    lin = nt.nodes.new("ShaderNodeMath")
    lin.operation = "POWER"
    lin.inputs[1].default_value = 2.2
    nt.links.new(snap.outputs[0], lin.inputs[0])
    lit = nt.nodes.new("ShaderNodeVectorMath")
    lit.operation = "SCALE"
    nt.links.new(hue.outputs[0], lit.inputs[0])
    nt.links.new(lin.outputs[0], lit.inputs["Scale"])
    amb = nt.nodes.new("ShaderNodeVectorMath")
    amb.operation = "ADD"
    nt.links.new(lit.outputs[0], amb.inputs[0])
    amb.inputs[1].default_value = AMBIENT
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


INK = glow("Ink", (0.012, 0.01, 0.022))
INK.use_backface_culling = True

M = {
    "ground": toon("Ground", (0.30, 0.30, 0.26), noise=0.25, noise_scale=0.4),
    "grass": toon("Grass", (0.22, 0.30, 0.22), noise=0.3, noise_scale=0.8),
    "cobble": toon("Cobble", (0.55, 0.50, 0.50), voronoi=28),
    "path": toon("Path", (0.62, 0.55, 0.50), noise=0.2, noise_scale=1.0),
    "plaster": toon("Plaster", (0.70, 0.64, 0.62), noise=0.12, noise_scale=1.5),
    "beam": toon("Beam", (0.24, 0.16, 0.13)),
    "roof": toon("Roof", (0.30, 0.29, 0.36), noise=0.18, noise_scale=2.5),
    "roof_red": toon("RoofRed", (0.42, 0.24, 0.24), noise=0.18, noise_scale=2.5),
    "stone": toon("Stone", (0.48, 0.47, 0.50), noise=0.25, noise_scale=3),
    "wood": toon("Wood", (0.45, 0.30, 0.22), noise=0.2, noise_scale=5),
    "dark_wood": toon("DarkWood", (0.22, 0.15, 0.13)),
    "hay": toon("Hay", (0.85, 0.66, 0.30), noise=0.25, noise_scale=8),
    "pine": toon("Pine", (0.16, 0.30, 0.27), noise=0.15, noise_scale=1.2),
    "canopy": toon("Canopy", (0.18, 0.24, 0.27), noise=0.15, noise_scale=1.0),
    "bark": toon("Bark", (0.30, 0.24, 0.22)),
    "cloak": toon("Cloak", (0.36, 0.33, 0.40), noise=0.12, noise_scale=6),
    "face": glow("Face", (0.01, 0.008, 0.015)),
    "window": glow("Window", (1.0, 0.86, 0.25), 1.4),
    "window_dark": toon("WindowDark", (0.10, 0.10, 0.16)),
    "lantern": glow("Lantern", (1.0, 0.80, 0.30), 1.6),
    "flame": glow("Flame", (1.0, 0.55, 0.12), 1.8),
    "flame_core": glow("FlameCore", (1.0, 0.88, 0.45), 2.0),
    "ember": glow("Ember", (0.9, 0.25, 0.05), 1.2),
    "moon": glow("Moon", (0.96, 0.95, 0.84), 1.2),
    "eye": glow("Eye", (0.95, 0.95, 0.85), 2.0),
    "wolf_eye": glow("WolfEye", (1.0, 0.08, 0.05), 3.0),
    "orb": glow("Orb", (0.45, 0.85, 1.0), 2.0),
    "rope": toon("Rope", (0.62, 0.52, 0.36)),
    "text": glow("Text", (0.95, 0.93, 0.88), 1.0),
    "bubble": glow("Bubble", (0.04, 0.035, 0.06), 1.0),
}
SEAT_COLORS = [(0.90, 0.62, 0.0), (0.34, 0.71, 0.91), (0.0, 0.62, 0.45), (0.94, 0.89, 0.26),
               (0.25, 0.50, 0.95), (0.90, 0.40, 0.10), (0.85, 0.50, 0.70), (0.75, 0.75, 0.75)]
SEAT_MATS = [toon(f"Seat{i}", c) for i, c in enumerate(SEAT_COLORS)]
NAME_MATS = [glow(f"Name{i}", c, 1.1) for i, c in enumerate(SEAT_COLORS)]

# ================================================================ helpers


def add(op, name, material, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), smooth=False, **kw):
    op(location=loc, rotation=rot, **kw)
    o = bpy.context.active_object
    o.name = name
    if tuple(scale) != (1, 1, 1):  # bake the scale into the mesh, so outlines stay even
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
    coll.objects.link(o)
    o.data.materials.append(material)
    return o


def jitter(o, amount):
    for v in o.data.vertices:
        v.co += Vector((rng.uniform(-amount, amount), rng.uniform(-amount, amount), rng.uniform(-amount, amount)))


def group(name, loc, yaw=0.0, tilt=0.0):
    e = bpy.data.objects.new(name, None)
    coll.objects.link(e)
    e.location = loc
    e.rotation_euler = (rng.uniform(-tilt, tilt), rng.uniform(-tilt, tilt), yaw)
    bpy.context.view_layer.update()
    return e


def attach(parts, root):
    for p in parts:
        p.matrix_world = root.matrix_world @ p.matrix_world
        p.parent = root
        p.matrix_parent_inverse = root.matrix_world.inverted()


def light(name, kind, energy, color, loc, radius=0.2):
    d = bpy.data.lights.new(name, kind)
    d.energy, d.color = energy, color
    if kind != "SUN":
        d.shadow_soft_size = radius
    o = bpy.data.objects.new(name, d)
    o.location = loc
    coll.objects.link(o)
    return o


def text_obj(body, size, material, loc, cam):
    cu = bpy.data.curves.new("T", "FONT")
    cu.body, cu.size, cu.align_x, cu.align_y = body, size, "CENTER", "CENTER"
    for fnt in ("C:/Windows/Fonts/constanb.ttf", "C:/Windows/Fonts/georgiab.ttf"):
        if os.path.exists(fnt):
            cu.font = bpy.data.fonts.load(fnt)
            break
    o = bpy.data.objects.new("Text", cu)
    o.data.materials.append(material)
    o.location = loc
    coll.objects.link(o)
    c = o.constraints.new("TRACK_TO")
    c.target, c.track_axis, c.up_axis = cam, "TRACK_Z", "UP_Y"
    return o


# ================================================================ camera
cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
cam.data.lens = 24
coll.objects.link(cam)
cam.location = Vector((1.5, -17.5, 5.6))
look = Vector((0.0, 3.0, 3.3))
cam.rotation_euler = (look - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam
bpy.context.view_layer.update()
_tx = 18 / cam.data.lens
moon_dir = (cam.matrix_world.to_3x3() @ Vector((0.55 * _tx, 0.86 * _tx * 9 / 16, -1))).normalized()

# ================================================================ sky: teal gradient, stars, moon halo
world = bpy.data.worlds.new("Sky")
scene.world = world
world.use_nodes = True
wn = world.node_tree
bg = wn.nodes.get("Background")
tc = wn.nodes.new("ShaderNodeTexCoord")
sep = wn.nodes.new("ShaderNodeSeparateXYZ")
wn.links.new(tc.outputs["Generated"], sep.inputs[0])
grad = wn.nodes.new("ShaderNodeValToRGB")
grad.color_ramp.elements[0].position = 0.0
grad.color_ramp.elements[0].color = (0.035, 0.085, 0.11, 1)
grad.color_ramp.elements[1].position = 0.55
grad.color_ramp.elements[1].color = (0.004, 0.012, 0.03, 1)
wn.links.new(sep.outputs["Z"], grad.inputs["Fac"])
stars = wn.nodes.new("ShaderNodeTexVoronoi")
stars.inputs["Scale"].default_value = 160
stars.inputs["Randomness"].default_value = 1.0
wn.links.new(tc.outputs["Generated"], stars.inputs["Vector"])
smask = wn.nodes.new("ShaderNodeMapRange")
smask.inputs["From Min"].default_value = 0.035
smask.inputs["From Max"].default_value = 0.0
wn.links.new(stars.outputs["Distance"], smask.inputs["Value"])
above = wn.nodes.new("ShaderNodeMapRange")
above.inputs["From Min"].default_value = 0.12
above.inputs["From Max"].default_value = 0.35
wn.links.new(sep.outputs["Z"], above.inputs["Value"])
smul = wn.nodes.new("ShaderNodeMath")
smul.operation = "MULTIPLY"
wn.links.new(smask.outputs["Result"], smul.inputs[0])
wn.links.new(above.outputs["Result"], smul.inputs[1])
dot = wn.nodes.new("ShaderNodeVectorMath")
dot.operation = "DOT_PRODUCT"
dot.inputs[1].default_value = tuple(moon_dir)
wn.links.new(tc.outputs["Generated"], dot.inputs[0])
halo = wn.nodes.new("ShaderNodeMapRange")
halo.inputs["From Min"].default_value = 0.965
halo.inputs["From Max"].default_value = 1.0
halo.inputs["To Max"].default_value = 0.22
wn.links.new(dot.outputs["Value"], halo.inputs["Value"])
add1 = wn.nodes.new("ShaderNodeMix")
add1.data_type = "RGBA"
add1.blend_type = "ADD"
add1.inputs["Factor"].default_value = 1.0
wn.links.new(grad.outputs["Color"], add1.inputs[6])
wn.links.new(smul.outputs[0], add1.inputs[7])
add2 = wn.nodes.new("ShaderNodeMix")
add2.data_type = "RGBA"
add2.blend_type = "ADD"
add2.inputs["Factor"].default_value = 1.0
wn.links.new(add1.outputs[2], add2.inputs[6])
wn.links.new(halo.outputs["Result"], add2.inputs[7])
wn.links.new(add2.outputs[2], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 1.0

add(bpy.ops.mesh.primitive_uv_sphere_add, "Moon", M["moon"], loc=tuple(cam.location + moon_dir * 120), segments=32, ring_count=16, radius=6.5, smooth=True)
moonlight = light("Moonlight", "SUN", 0.42, (0.5, 0.7, 0.95), (0, 0, 20))
moonlight.rotation_euler = (-moon_dir).to_track_quat("-Z", "Y").to_euler()
moonlight.data.angle = math.radians(2)

# ================================================================ ground and the square
add(bpy.ops.mesh.primitive_plane_add, "Ground", M["ground"], loc=(0, 0, -0.02), size=200)
cob = add(bpy.ops.mesh.primitive_cylinder_add, "Square", M["cobble"], loc=(0, 0, 0.0), vertices=40, radius=10.5, depth=0.08)
add(bpy.ops.mesh.primitive_cube_add, "PathOut", M["path"], loc=(13, -5.5, -0.005), rot=(0, 0, math.radians(-25)), scale=(7, 1.6, 0.03))
for i in range(14):  # grass tufts at the edge of the square
    a = rng.uniform(0, math.tau)
    r = rng.uniform(10.5, 12.5)
    t = add(bpy.ops.mesh.primitive_cone_add, f"Tuft{i}", M["grass"], loc=(math.cos(a) * r, math.sin(a) * r, 0.15), vertices=5, radius1=0.45, depth=0.35)
    jitter(t, 0.08)

# fire pit at the centre of the circle
for i in range(10):
    a = i / 10 * math.tau
    s = add(bpy.ops.mesh.primitive_ico_sphere_add, f"PitStone{i}", M["stone"], loc=(math.cos(a) * 0.9, math.sin(a) * 0.9, 0.12), subdivisions=1, radius=1, scale=(0.3, 0.26, 0.2))
    jitter(s, 0.05)
for i in range(4):
    a = i / 4 * math.tau
    add(bpy.ops.mesh.primitive_cylinder_add, f"FireLog{i}", M["dark_wood"], loc=(math.cos(a) * 0.28, math.sin(a) * 0.28, 0.28), rot=(math.radians(65), 0, a + math.pi / 2), vertices=6, radius=0.08, depth=1.0)
for i, (h, r, dx, dy, mt) in enumerate([(1.2, 0.36, 0, 0, "flame"), (0.8, 0.26, 0.2, 0.1, "flame"), (0.75, 0.22, -0.18, -0.1, "flame"), (0.6, 0.18, 0.02, 0.0, "flame_core")]):
    f = add(bpy.ops.mesh.primitive_cone_add, f"Flame{i}", M[mt], loc=(dx, dy, 0.3 + h / 2), vertices=6, radius1=r, depth=h)
    jitter(f, 0.06)
add(bpy.ops.mesh.primitive_circle_add, "Embers", M["ember"], loc=(0, 0, 0.1), fill_type="NGON", vertices=9, radius=0.7)
light("Fire", "POINT", 1400, (1.0, 0.55, 0.2), (0, 0, 1.1), 0.3)

# ================================================================ figures around the fire
NAMES = ["Fable 5.1", "GPT-6 Sol", "Gemini Pro", "Grok 4.7", "DeepSeek V4", "Kimi K3", "Qwen Max", "GLM 5.3"]
ROLE = {2: "wolf", 5: "seer", 6: "witch"}
SPEAKER = 3
heads = {}
for i in range(8):
    a = i / 8 * math.tau + math.radians(20)
    pos = Vector((math.cos(a) * 3.8, math.sin(a) * 3.8, 0))
    face_in = math.atan2(-pos.y, -pos.x)
    lg = add(bpy.ops.mesh.primitive_cylinder_add, f"Log{i}", M["wood"], loc=(pos.x, pos.y, 0.26), rot=(math.radians(90), 0, face_in), vertices=7, radius=0.24, depth=1.3)
    jitter(lg, 0.02)
    root = group(f"Figure{i}", (pos.x, pos.y, 0.46), yaw=face_in - math.pi / 2)
    parts = [
        add(bpy.ops.mesh.primitive_cone_add, "Body", M["cloak"], loc=(0, 0, 0.55), vertices=9, radius1=0.48, radius2=0.18, depth=1.1),
        add(bpy.ops.mesh.primitive_uv_sphere_add, "Hood", M["cloak"], loc=(0, -0.06, 1.27), scale=(1, 1.05, 1.15), segments=10, ring_count=7, radius=0.28),
        add(bpy.ops.mesh.primitive_cone_add, "HoodTip", M["cloak"], loc=(0, -0.22, 1.58), rot=(math.radians(-40), 0, 0), vertices=6, radius1=0.13, depth=0.4),
        add(bpy.ops.mesh.primitive_uv_sphere_add, "Face", M["face"], loc=(0, 0.12, 1.24), scale=(0.85, 0.55, 1.0), segments=8, ring_count=6, radius=0.2),
        add(bpy.ops.mesh.primitive_torus_add, "Scarf", SEAT_MATS[i], loc=(0, 0, 1.03), major_radius=0.22, minor_radius=0.075, major_segments=10, minor_segments=5),
    ]
    jitter(parts[0], 0.02)
    wolf = ROLE.get(i) == "wolf"
    for k in (-1, 1):
        parts.append(add(bpy.ops.mesh.primitive_uv_sphere_add, f"Eye{k}", M["wolf_eye" if wolf else "eye"], loc=(0.068 * k, 0.24, 1.28), segments=6, ring_count=4, radius=0.034 if wolf else 0.028))
    if ROLE.get(i) == "seer":
        parts.append(add(bpy.ops.mesh.primitive_ico_sphere_add, "Orb", M["orb"], loc=(0, 0.45, 0.66), subdivisions=2, radius=0.12, smooth=True))
    if ROLE.get(i) == "witch":
        parts.append(add(bpy.ops.mesh.primitive_cone_add, "WitchHat", M["cloak"], loc=(0, -0.05, 1.76), rot=(math.radians(-14), 0, 0), vertices=8, radius1=0.25, depth=0.7))
        parts.append(add(bpy.ops.mesh.primitive_cylinder_add, "HatBrim", M["cloak"], loc=(0, -0.02, 1.47), vertices=12, radius=0.44, depth=0.04))
    attach(parts, root)
    heads[i] = root.matrix_world @ Vector((0, 0, 1.3))

for i in range(8):
    d = (heads[i] - cam.location).length
    text_obj(NAMES[i], 0.021 * d, NAME_MATS[i], tuple(heads[i] + Vector((0, 0, 0.42 + 0.024 * d))), cam)
sd = (heads[SPEAKER] - cam.location).length
line = text_obj("Kimi was far too quiet last night.\nI don't trust them.", 0.019 * sd, M["text"], tuple(heads[SPEAKER] + Vector((0, 0, 0.7 + 0.07 * sd))), cam)
bpy.context.view_layer.update()
bpy.ops.mesh.primitive_plane_add(size=1)
box = bpy.context.active_object
box.name = "SpeechBox"
box.data.materials.append(M["bubble"])
box.scale = (line.dimensions.x + 0.5, line.dimensions.y + 0.35, 1)
box.parent = line
box.location = (0, 0, -0.02)

# ================================================================ props on the square
# the well
wroot = group("Well", (5.6, 3.2, 0))
wp = [add(bpy.ops.mesh.primitive_cylinder_add, "WellRing", M["stone"], loc=(0, 0, 0.45), vertices=12, radius=0.85, depth=0.9),
      add(bpy.ops.mesh.primitive_cylinder_add, "WellWater", M["face"], loc=(0, 0, 0.88), vertices=12, radius=0.7, depth=0.04)]
for dx in (-0.75, 0.75):
    wp.append(add(bpy.ops.mesh.primitive_cube_add, "WellPost", M["dark_wood"], loc=(dx, 0, 1.4), scale=(0.07, 0.07, 1.0)))
wroof = add(bpy.ops.mesh.primitive_cylinder_add, "WellRoof", M["roof_red"], loc=(0, 0, 2.55), rot=(0, math.radians(90), 0), vertices=3, radius=0.75, depth=2.0, scale=(1, 1.15, 1))
wp += [wroof, add(bpy.ops.mesh.primitive_cylinder_add, "Bucket", M["wood"], loc=(0, 0.0, 1.5), vertices=8, radius=0.16, depth=0.28)]
attach(wp, wroot)

# the gallows, on a wooden platform at the edge of the square
groot = group("Gallows", (-6.8, 5.8, 0), yaw=math.radians(-40))
gp = [add(bpy.ops.mesh.primitive_cube_add, "Platform", M["wood"], loc=(0, 0, 0.75), scale=(1.8, 1.5, 0.1))]
for dx, dy in [(-1.6, -1.3), (1.6, -1.3), (-1.6, 1.3), (1.6, 1.3)]:
    gp.append(add(bpy.ops.mesh.primitive_cube_add, "Leg", M["dark_wood"], loc=(dx, dy, 0.35), scale=(0.09, 0.09, 0.38)))
for k in range(4):
    gp.append(add(bpy.ops.mesh.primitive_cube_add, f"Step{k}", M["wood"], loc=(0, -1.75 - k * 0.3, 0.6 - k * 0.17), scale=(0.6, 0.15, 0.04)))
for dx in (-1.1, 1.1):
    gp.append(add(bpy.ops.mesh.primitive_cube_add, "Post", M["dark_wood"], loc=(dx, 0.6, 2.6), scale=(0.12, 0.12, 1.8)))
gp.append(add(bpy.ops.mesh.primitive_cube_add, "Beam", M["dark_wood"], loc=(0, 0.6, 4.45), scale=(1.5, 0.13, 0.13)))
gp.append(add(bpy.ops.mesh.primitive_cube_add, "Brace", M["dark_wood"], loc=(0.75, 0.6, 3.85), rot=(0, math.radians(45), 0), scale=(0.06, 0.06, 0.62)))
gp.append(add(bpy.ops.mesh.primitive_cylinder_add, "Rope", M["rope"], loc=(-0.3, 0.6, 3.85), vertices=6, radius=0.03, depth=1.15))
gp.append(add(bpy.ops.mesh.primitive_torus_add, "Loop", M["rope"], loc=(-0.3, 0.6, 3.15), rot=(math.radians(90), 0, 0), major_radius=0.17, minor_radius=0.03, major_segments=10, minor_segments=4))
attach(gp, groot)

# a hay cart and barrels
croot = group("Cart", (-7.4, -3.2, 0), yaw=math.radians(20))
cp = [add(bpy.ops.mesh.primitive_cube_add, "Bed", M["wood"], loc=(0, 0, 0.75), scale=(1.2, 0.7, 0.25))]
for dx in (-0.7, 0.7):
    for dy in (-0.78, 0.78):
        cp.append(add(bpy.ops.mesh.primitive_cylinder_add, "Wheel", M["dark_wood"], loc=(dx, dy, 0.45), rot=(math.radians(90), 0, 0), vertices=10, radius=0.42, depth=0.08))
for k in range(5):
    h = add(bpy.ops.mesh.primitive_cube_add, "Hay", M["hay"], loc=(rng.uniform(-0.8, 0.8), rng.uniform(-0.4, 0.4), 1.15), scale=(0.45, 0.35, 0.25))
    jitter(h, 0.06)
    cp.append(h)
cp.append(add(bpy.ops.mesh.primitive_cube_add, "Shaft", M["dark_wood"], loc=(1.9, 0, 0.6), rot=(0, math.radians(-12), 0), scale=(0.8, 0.05, 0.05)))
attach(cp, croot)
for (bx, by) in [(-5.4, -5.6), (-4.9, -6.3), (7.6, -1.5)]:
    add(bpy.ops.mesh.primitive_cylinder_add, "Barrel", M["wood"], loc=(bx, by, 0.45), vertices=10, radius=0.38, depth=0.9)

# lantern posts with warm pools of light
for (lx, ly) in [(4.2, -8.0), (-3.6, 9.0), (8.8, 5.2), (-9.4, 1.0)]:
    add(bpy.ops.mesh.primitive_cylinder_add, "LanternPost", M["dark_wood"], loc=(lx, ly, 1.5), vertices=6, radius=0.08, depth=3.0)
    add(bpy.ops.mesh.primitive_cube_add, "Arm", M["dark_wood"], loc=(lx + 0.3, ly, 2.95), scale=(0.35, 0.04, 0.04))
    add(bpy.ops.mesh.primitive_cube_add, "Lantern", M["lantern"], loc=(lx + 0.6, ly, 2.68), scale=(0.13, 0.13, 0.18))
    add(bpy.ops.mesh.primitive_cone_add, "Cap", M["dark_wood"], loc=(lx + 0.6, ly, 2.92), vertices=4, radius1=0.2, depth=0.18)
    light("LanternLight", "POINT", 220, (1.0, 0.72, 0.3), (lx + 0.6, ly, 2.55), 0.1).data.use_shadow = False

# ================================================================ half-timbered houses around the square


def house(name, loc, yaw, w, d, h1, h2, roof_mat, lit_windows):
    root = group(name, loc, yaw=yaw, tilt=math.radians(2.0))
    ps = []
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "Ground floor", M["plaster"], loc=(0, 0, h1 / 2), scale=(w / 2, d / 2, h1 / 2)))
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "Upper floor", M["plaster"], loc=(0, 0.2, h1 + h2 / 2), scale=(w / 2 + 0.2, d / 2 + 0.2, h2 / 2)))
    fy = d / 2 + 0.4 + 0.03  # just proud of the upper floor's front face
    # timber frame on the front: corner posts, rails, crosses
    for x in (-w / 2 - 0.15, w / 2 + 0.15):
        ps.append(add(bpy.ops.mesh.primitive_cube_add, "Post", M["beam"], loc=(x, fy, h1 + h2 / 2), scale=(0.1, 0.05, h2 / 2)))
        ps.append(add(bpy.ops.mesh.primitive_cube_add, "Post", M["beam"], loc=(x * 0.93, d / 2 + 0.03, h1 / 2), scale=(0.1, 0.05, h1 / 2)))
    for z in (h1 + 0.06, h1 + h2 - 0.06):
        ps.append(add(bpy.ops.mesh.primitive_cube_add, "Rail", M["beam"], loc=(0, fy, z), scale=(w / 2 + 0.25, 0.05, 0.08)))
    for sx in (-1, 1):
        ang = math.atan2(h2, w / 2) * sx
        ps.append(add(bpy.ops.mesh.primitive_cube_add, "Brace", M["beam"], loc=(sx * w / 4, fy, h1 + h2 / 2), rot=(0, ang, 0), scale=(0.06, 0.05, math.hypot(w / 4, h2 / 2) * 0.95)))
    # steep, slightly crooked gable roof; the gable faces the square
    z0 = h1 + h2
    rh = w * 0.95
    W = w / 2 + 0.55
    yf, yb = d / 2 + 0.85, -d / 2 - 0.35
    sk = rng.uniform(-0.25, 0.25)  # a crooked ridge
    roof = mesh_obj("Roof", [(-W, yf, z0 - 0.1), (W, yf, z0 - 0.1), (sk, yf, z0 + rh), (-W, yb, z0 - 0.1), (W, yb, z0 - 0.1), (sk * 0.6, yb, z0 + rh)],
                    [(0, 2, 5, 3), (1, 4, 5, 2)], roof_mat)
    thick = roof.modifiers.new("Thickness", "SOLIDIFY")
    thick.thickness, thick.offset = 0.16, 1.0
    jitter(roof, 0.05)
    ps.append(roof)
    # gable wall: a plaster triangle under the roof, with a window
    Wg = w / 2 + 0.2
    rg = rh * (Wg / W) * 0.98
    gy = d / 2 + 0.4
    ps.append(mesh_obj("Gable", [(-Wg, gy, z0), (Wg, gy, z0), (sk * Wg / W, gy, z0 + rg), (-Wg, -d / 2, z0), (Wg, -d / 2, z0), (sk * Wg / W * 0.6, -d / 2, z0 + rg)],
                       [(0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (0, 2, 5, 3), (1, 4, 5, 2)], M["plaster"]))
    for sx in (-1, 1):  # timber along the gable edges
        ln = math.hypot(Wg, rg)
        ps.append(add(bpy.ops.mesh.primitive_cube_add, "GableBeam", M["beam"], loc=(sx * Wg / 2 + sk * 0.5, gy + 0.04, z0 + rg / 2),
                      rot=(0, -sx * (math.pi / 2 - math.atan2(rg, Wg)), 0), scale=(0.07, 0.05, ln / 2)))
    lit = lit_windows
    ps.append(add(bpy.ops.mesh.primitive_cylinder_add, "GableWin", M["window"] if lit[0] else M["window_dark"], loc=(sk * 0.4, gy + 0.03, z0 + rg * 0.38), rot=(math.radians(90), 0, 0), vertices=4, radius=0.3, depth=0.06))
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "UpperWin", M["window"] if lit[1] else M["window_dark"], loc=(-w * 0.22, fy + 0.02, h1 + h2 * 0.5), scale=(0.28, 0.03, 0.34)))
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "UpperWinFrame", M["beam"], loc=(-w * 0.22, fy, h1 + h2 * 0.5), scale=(0.36, 0.03, 0.42)))
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "LowerWin", M["window"] if lit[2] else M["window_dark"], loc=(w * 0.22, d / 2 + 0.04, h1 * 0.55), scale=(0.3, 0.03, 0.3)))
    for sx in (-1, 1):
        ps.append(add(bpy.ops.mesh.primitive_cube_add, "Shutter", M["beam"], loc=(w * 0.22 + sx * 0.46, d / 2 + 0.05, h1 * 0.55), rot=(0, 0, math.radians(sx * 25)), scale=(0.16, 0.03, 0.34)))
    door = add(bpy.ops.mesh.primitive_cube_add, "Door", M["dark_wood"], loc=(-w * 0.2, d / 2 + 0.04, 0.95), scale=(0.42, 0.04, 0.95))
    ps.append(door)
    ps.append(add(bpy.ops.mesh.primitive_cylinder_add, "DoorArch", M["dark_wood"], loc=(-w * 0.2, d / 2 + 0.04, 1.9), rot=(math.radians(90), 0, 0), vertices=10, radius=0.42, depth=0.08))
    ps.append(add(bpy.ops.mesh.primitive_cube_add, "Chimney", M["stone"], loc=(w * 0.28, -0.6, h1 + h2 + rh * 0.55), scale=(0.25, 0.25, 0.9)))
    attach(ps, root)


slots = [(-2, 14.5), (16, 13.8), (36, 14.0), (60, 15.0), (100, 14.5), (122, 13.6), (144, 14.2), (166, 14.0), (188, 14.6), (-24, 15.5)]
for k, (deg, r) in enumerate(slots):
    a = math.radians(deg)
    pos = Vector((math.cos(a) * r, math.sin(a) * r, 0))
    yaw = math.atan2(-pos.y, -pos.x) - math.pi / 2  # front (+Y local) faces the square
    w = rng.uniform(3.6, 4.6)
    house(f"House{k}", pos, yaw, w, rng.uniform(3.6, 4.4), rng.uniform(2.6, 3.0), rng.uniform(2.2, 2.7),
          M["roof_red"] if k % 3 == 1 else M["roof"], [rng.random() < 0.5, rng.random() < 0.55, rng.random() < 0.6])

# ================================================================ the forest: dark canopies and pines framing the village


def pine(name, x, y, h):
    add(bpy.ops.mesh.primitive_cylinder_add, name + "Trunk", M["bark"], loc=(x, y, h * 0.12), vertices=5, radius=0.22, depth=h * 0.25)
    for j in range(4):
        c = add(bpy.ops.mesh.primitive_cone_add, name + f"T{j}", M["pine"], loc=(x, y, h * (0.3 + j * 0.17)), vertices=7, radius1=h * (0.24 - j * 0.045), depth=h * 0.36)
        jitter(c, 0.15)


def blob_tree(name, x, y, h):
    add(bpy.ops.mesh.primitive_cylinder_add, name + "Trunk", M["bark"], loc=(x, y, h * 0.3), vertices=6, radius=0.35, depth=h * 0.6)
    for j in range(3):
        b = add(bpy.ops.mesh.primitive_ico_sphere_add, name + f"C{j}", M["canopy"], loc=(x + rng.uniform(-1, 1), y + rng.uniform(-1, 1), h * (0.65 + j * 0.12)), subdivisions=1, radius=h * 0.28)
        jitter(b, 0.4)


def gnarly(name, x, y, h):
    t = add(bpy.ops.mesh.primitive_cone_add, name, M["bark"], loc=(x, y, h / 2), vertices=7, radius1=0.5, radius2=0.08, depth=h)
    jitter(t, 0.1)
    for j in range(6):
        z = h * rng.uniform(0.4, 0.92)
        ang = rng.uniform(0, math.tau)
        L = h * rng.uniform(0.25, 0.45)
        add(bpy.ops.mesh.primitive_cone_add, name + f"B{j}", M["bark"], loc=(x + math.cos(ang) * L * 0.4, y + math.sin(ang) * L * 0.4, z + L * 0.25),
            rot=(math.radians(rng.uniform(45, 70)), 0, ang + math.pi / 2), vertices=5, radius1=0.12, radius2=0.01, depth=L)


cam2 = Vector((cam.location.x, cam.location.y))
moon2 = Vector((moon_dir.x, moon_dir.y)).normalized()


def blocks_moon(x, y):
    d = Vector((x, y)) - cam2
    along = d.dot(moon2)
    return along > 0 and (d - moon2 * along).length < 2.0 + along * 0.2


n = 0
while n < 140:
    a = rng.uniform(0, math.tau)
    r = rng.uniform(21, 45)
    x, y = math.cos(a) * r, math.sin(a) * r
    if (y < -12 and abs(x) < 25) or blocks_moon(x, y):  # keep the camera side and the moon open
        continue
    h = rng.uniform(10, 17)
    (pine if rng.random() < 0.6 else blob_tree)(f"Tree{n}", x, y, h)
    n += 1
gnarly("FrameTreeL", -13.5, -6.5, 12)
gnarly("FrameTreeR", 15.0, 2.0, 11)

# ================================================================ light ground fog
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 4), size=1)
fog = bpy.context.active_object
fog.name = "Fog"
fog.scale = (70, 70, 10)
fm = bpy.data.materials.new("Fog")
fm.use_nodes = True
fnt = fm.node_tree
fnt.nodes.remove(fnt.nodes.get("Principled BSDF"))
fv = fnt.nodes.new("ShaderNodeVolumePrincipled")
fv.inputs["Color"].default_value = (0.28, 0.36, 0.55, 1)
ftc = fnt.nodes.new("ShaderNodeTexCoord")
fs = fnt.nodes.new("ShaderNodeSeparateXYZ")
fnt.links.new(ftc.outputs["Generated"], fs.inputs[0])
fh = fnt.nodes.new("ShaderNodeMapRange")
fh.inputs["From Min"].default_value = 0.0
fh.inputs["From Max"].default_value = 0.35
fh.inputs["To Min"].default_value = 0.035
fh.inputs["To Max"].default_value = 0.0
fnt.links.new(fs.outputs["Z"], fh.inputs["Value"])
fnt.links.new(fh.outputs["Result"], fv.inputs["Density"])
fnt.links.new(fv.outputs["Volume"], fnt.nodes.get("Material Output").inputs["Volume"])
fog.data.materials.append(fm)
fog["outline"] = False

# ================================================================ ink outlines (inverted hull) on every solid object
for o in list(scene.objects):
    if o.type != "MESH" or o.name in ("Ground", "Fog") or not o.data.materials:
        continue
    if not o.data.materials[0].get("outline", False):
        continue
    dims = o.dimensions
    t = max(0.03, min(0.09, 0.025 + 0.012 * max(dims)))
    o.data.materials.append(INK)
    sol = o.modifiers.new("Ink", "SOLIDIFY")
    sol.thickness = t
    sol.offset = 1.0
    sol.use_flip_normals = True
    sol.use_rim = False
    sol.material_offset = len(o.data.materials) - 1

# ================================================================ render + a light finish
def finish():
    raw = os.path.join(OUT, "style_toon_raw.png")
    scene.render.filepath = raw
    bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "style_toon.blend"))

    img = bpy.data.images.load(raw)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    rgb = px[..., :3].copy()


    def blur(a, radius):
        for _ in range(3):
            k = 2 * radius + 1
            c = np.cumsum(np.pad(a, ((radius + 1, radius), (0, 0), (0, 0)), mode="edge"), axis=0)
            a = (c[k:] - c[:-k]) / k
            c = np.cumsum(np.pad(a, ((0, 0), (radius + 1, radius), (0, 0)), mode="edge"), axis=1)
            a = (c[:, k:] - c[:, :-k]) / k
        return a


    bright = np.clip(rgb - 0.7, 0, None)
    rgb = rgb + blur(bright, 14) * 0.9  # soft glow around lanterns, windows, fire, eyes
    yy, xx = np.mgrid[0:h, 0:w]
    r2 = ((xx / w - 0.5) * 2) ** 2 * 0.8 + ((yy / h - 0.5) * 2) ** 2
    rgb *= (1 - 0.42 * np.clip(r2, 0, 1.6) ** 1.6)[..., None]  # vignette
    rgb += np.random.default_rng(3).normal(0, 1, (h, w, 1)).astype(np.float32) * 0.012  # faint paper grain
    px[..., :3] = np.clip(rgb, 0, 1)
    fin = bpy.data.images.new("style_toon", w, h, alpha=False)
    fin.pixels.foreach_set(px.ravel())
    fin.filepath_raw = os.path.join(OUT, "style_toon.png")
    fin.file_format = "PNG"
    fin.save()
    print("[toon] done:", fin.filepath_raw)


if LIVE:
    print("[toon] built live in scene 'Village'")
else:
    finish()
