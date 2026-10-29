"""S1 style test: the village square at night, one still.

Run (does not touch an open Blender window):
    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --factory-startup --python blender/style_test.py

Writes out/style_test_raw.png (straight render), out/style_test.png (with the horror-game finish:
grain, vignette, bloom, colour fringe) and out/style_test.blend.
Everything is built from primitives; there are no downloaded assets. The random seed is fixed, so it rebuilds identically.
"""
import math
import os
import random

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
RES = (1920, 1080)
rng = random.Random(1307)


def try_set(obj, attr, value):
    try:
        setattr(obj, attr, value)
    except Exception as e:  # attribute names move between Blender versions
        print(f"[style_test] skip {attr}: {e}")


# ---------------------------------------------------------------- scene and render
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
scene = bpy.context.scene
engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
scene.render.resolution_x, scene.render.resolution_y = RES
scene.render.resolution_percentage = 100
ee = scene.eevee
for attr, value in [("taa_render_samples", 64), ("volumetric_tile_size", "4"), ("volumetric_samples", 96),
                    ("volumetric_start", 0.5), ("volumetric_end", 90.0), ("use_volumetric_shadows", True),
                    ("volumetric_shadow_samples", 32), ("use_shadows", True)]:
    try_set(ee, attr, value)
try_set(scene.view_settings, "view_transform", "AgX")
try_set(scene.view_settings, "look", "AgX - Medium High Contrast")
try_set(scene.view_settings, "exposure", 0.4)

# ---------------------------------------------------------------- materials


def mat(name, color, rough=0.9, emit=None, strength=0.0, noise=0.0, noise_scale=4.0):
    """A flat, slightly mottled material. `noise` adds low-frequency colour variation (a 'low-res texture' feel)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = rough
    base = (*color, 1.0)
    if noise > 0:
        tex = nt.nodes.new("ShaderNodeTexNoise")
        tex.inputs["Scale"].default_value = noise_scale
        tex.inputs["Detail"].default_value = 1.0
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.interpolation = "CONSTANT"  # stepped colour = chunky, game-like
        ramp.color_ramp.elements[0].color = (*(c * (1 - noise) for c in color), 1)
        ramp.color_ramp.elements[1].color = base
        ramp.color_ramp.elements[1].position = 0.5
        mid = ramp.color_ramp.elements.new(0.62)
        mid.color = (*(min(1, c * (1 + noise * 0.6)) for c in color), 1)
        nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        bsdf.inputs["Base Color"].default_value = base
    if emit is not None:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1)
        bsdf.inputs["Emission Strength"].default_value = strength
    return m


M = {
    "ground": mat("Ground", (0.16, 0.15, 0.12), noise=0.45, noise_scale=0.35),
    "path": mat("Path", (0.2, 0.17, 0.13), noise=0.4, noise_scale=1.2),
    "stone": mat("Stone", (0.26, 0.26, 0.27), noise=0.35, noise_scale=3),
    "wood": mat("Wood", (0.22, 0.14, 0.09), noise=0.4, noise_scale=6),
    "dark_wood": mat("DarkWood", (0.12, 0.08, 0.06), noise=0.3, noise_scale=5),
    "plaster": mat("Plaster", (0.42, 0.39, 0.33), noise=0.35, noise_scale=1.5),
    "roof": mat("Roof", (0.16, 0.13, 0.13), noise=0.4, noise_scale=3),
    "window": mat("Window", (0.0, 0.0, 0.0), emit=(1.0, 0.42, 0.1), strength=1.6),
    "window_dark": mat("WindowDark", (0.01, 0.01, 0.012), rough=0.3),
    "pine": mat("Pine", (0.06, 0.09, 0.075), noise=0.35, noise_scale=2),
    "dead": mat("DeadTree", (0.1, 0.09, 0.085), noise=0.3, noise_scale=4),
    "flame": mat("Flame", (0.0, 0.0, 0.0), emit=(1.0, 0.28, 0.03), strength=5.0),
    "ember": mat("Ember", (0.02, 0.01, 0.0), emit=(1.0, 0.2, 0.02), strength=3.0),
    "moon": mat("Moon", (0.0, 0.0, 0.0), emit=(0.8, 0.86, 0.95), strength=1.6, noise=0.0),
    "cloak": mat("Cloak", (0.16, 0.15, 0.14), noise=0.3, noise_scale=8),
    "face": mat("Face", (0.004, 0.004, 0.005), rough=1.0),
    "eye": mat("Eye", (0.0, 0.0, 0.0), emit=(0.9, 0.95, 0.85), strength=8.0),
    "wolf_eye": mat("WolfEye", (0.0, 0.0, 0.0), emit=(1.0, 0.04, 0.02), strength=25.0),
    "orb": mat("Orb", (0.0, 0.0, 0.0), emit=(0.35, 0.8, 1.0), strength=10.0),
    "rope": mat("Rope", (0.12, 0.1, 0.07), noise=0.3, noise_scale=20),
    "lantern": mat("Lantern", (0.0, 0.0, 0.0), emit=(1.0, 0.45, 0.12), strength=3.0),
    "text": mat("Text", (0.0, 0.0, 0.0), emit=(0.92, 0.9, 0.85), strength=2.5),
    "bubble": mat("Bubble", (0.01, 0.01, 0.012), emit=(0.015, 0.014, 0.016), strength=1.0, rough=1.0),
}

# Seat colours (Okabe-Ito, colour-blind safe)
SEAT_COLORS = [(0.90, 0.62, 0.0), (0.34, 0.71, 0.91), (0.0, 0.62, 0.45), (0.94, 0.89, 0.26),
               (0.0, 0.45, 0.70), (0.84, 0.37, 0.0), (0.80, 0.47, 0.65), (0.6, 0.6, 0.6)]
SEAT_MATS = [mat(f"Seat{i}", c, rough=0.7, emit=c, strength=0.25) for i, c in enumerate(SEAT_COLORS)]
NAME_MATS = [mat(f"Name{i}", (0, 0, 0), emit=c, strength=3.0) for i, c in enumerate(SEAT_COLORS)]

# ---------------------------------------------------------------- helpers
coll = scene.collection


def add(mesh_op, name, material, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), flat=True, **kw):
    mesh_op(location=loc, rotation=rot, **kw)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    if material is not None:
        o.data.materials.append(material)
    if not flat:
        bpy.ops.object.shade_smooth()
    return o


def parent(child, par):
    child.parent = par
    child.matrix_parent_inverse = par.matrix_world.inverted()


def jitter_mesh(o, amount):
    """Seeded vertex jitter: crooked, hand-made shapes."""
    for v in o.data.vertices:
        v.co += Vector((rng.uniform(-amount, amount), rng.uniform(-amount, amount), rng.uniform(-amount, amount)))


def text_obj(body, size, material, loc):
    cu = bpy.data.curves.new(f"T_{body[:12]}", "FONT")
    cu.body = body
    cu.size = size
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    o = bpy.data.objects.new(f"Text_{body[:12]}", cu)
    o.data.materials.append(material)
    o.location = loc
    coll.objects.link(o)
    return o


# ---------------------------------------------------------------- camera (placed first: other things are framed from it)
cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 30
cam = bpy.data.objects.new("Cam", cam_data)
coll.objects.link(cam)
cam.location = Vector((-6.2, -10.8, 3.9))
look_at = Vector((0.8, 3.5, 1.7))
cam.rotation_euler = (look_at - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam

view = (look_at - cam.location)
view_az = math.atan2(view.y, view.x)
moon_az = view_az - math.radians(9)       # a little right of centre
moon_el = math.radians(5.5)
moon_dir = Vector((math.cos(moon_az) * math.cos(moon_el), math.sin(moon_az) * math.cos(moon_el), math.sin(moon_el)))

# ---------------------------------------------------------------- ground, path, sky
bpy.ops.mesh.primitive_grid_add(x_subdivisions=90, y_subdivisions=90, size=160)
ground = bpy.context.active_object
ground.name = "Ground"
ground.data.materials.append(M["ground"])
tex = bpy.data.textures.new("GroundNoise", "CLOUDS")
tex.noise_scale = 7.0
disp = ground.modifiers.new("Displace", "DISPLACE")
disp.texture = tex
disp.strength = 0.9
disp.mid_level = 0.5
ground.location.z = -0.45  # keeps the square roughly at z=0

moon = add(bpy.ops.mesh.primitive_uv_sphere_add, "Moon", M["moon"], loc=tuple(cam.location + moon_dir * 115),
           segments=24, ring_count=12, radius=5.0, flat=False)
sun_data = bpy.data.lights.new("Moonlight", "SUN")
sun_data.energy = 2.2
sun_data.color = (0.55, 0.65, 1.0)
sun_data.angle = math.radians(1.5)
sun = bpy.data.objects.new("Moonlight", sun_data)
coll.objects.link(sun)
sun.rotation_euler = (-moon_dir).to_track_quat("-Z", "Y").to_euler()

world = bpy.data.worlds.new("NightSky")
scene.world = world
world.use_nodes = True
wn = world.node_tree
bg = wn.nodes.get("Background")
tc = wn.nodes.new("ShaderNodeTexCoord")
dot = wn.nodes.new("ShaderNodeVectorMath")
dot.operation = "DOT_PRODUCT"
dot.inputs[1].default_value = tuple(moon_dir)
wn.links.new(tc.outputs["Generated"], dot.inputs[0])
halo = wn.nodes.new("ShaderNodeMapRange")
halo.inputs["From Min"].default_value = 0.80
halo.inputs["From Max"].default_value = 1.0
wn.links.new(dot.outputs["Value"], halo.inputs["Value"])
pw = wn.nodes.new("ShaderNodeMath")
pw.operation = "POWER"
pw.inputs[1].default_value = 3.0
wn.links.new(halo.outputs["Result"], pw.inputs[0])
sky = wn.nodes.new("ShaderNodeMix")
sky.data_type = "RGBA"
sky.inputs[6].default_value = (0.012, 0.016, 0.03, 1)   # A: night sky
sky.inputs[7].default_value = (0.32, 0.38, 0.5, 1)      # B: moon glow
wn.links.new(pw.outputs["Value"], sky.inputs["Factor"])
wn.links.new(sky.outputs[2], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 1.0

# fog: a big box volume, thick near the ground and thinning with height, patchy
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 9), size=1)
fog = bpy.context.active_object
fog.name = "Fog"
fog.scale = (110, 110, 20)
fm = bpy.data.materials.new("FogVolume")
fm.use_nodes = True
fnt = fm.node_tree
fnt.nodes.remove(fnt.nodes.get("Principled BSDF"))
fvol = fnt.nodes.new("ShaderNodeVolumePrincipled")
fvol.inputs["Color"].default_value = (0.6, 0.66, 0.78, 1)
fvol.inputs["Anisotropy"].default_value = 0.4
ftc = fnt.nodes.new("ShaderNodeTexCoord")
fsep = fnt.nodes.new("ShaderNodeSeparateXYZ")
fnt.links.new(ftc.outputs["Generated"], fsep.inputs[0])
fh = fnt.nodes.new("ShaderNodeMapRange")       # z: 0 = bottom of the box (z=-1), 0.2 = 3 m up
fh.inputs["From Min"].default_value = 0.0
fh.inputs["From Max"].default_value = 0.22
fh.inputs["To Min"].default_value = 0.09
fh.inputs["To Max"].default_value = 0.012
fnt.links.new(fsep.outputs["Z"], fh.inputs["Value"])
fn = fnt.nodes.new("ShaderNodeTexNoise")
fn.inputs["Scale"].default_value = 3.0
fnt.links.new(ftc.outputs["Generated"], fn.inputs["Vector"])
fnm = fnt.nodes.new("ShaderNodeMapRange")
fnm.inputs["To Min"].default_value = 0.45
fnm.inputs["To Max"].default_value = 1.4
fnt.links.new(fn.outputs["Fac"], fnm.inputs["Value"])
fmul = fnt.nodes.new("ShaderNodeMath")
fmul.operation = "MULTIPLY"
fnt.links.new(fh.outputs["Result"], fmul.inputs[0])
fnt.links.new(fnm.outputs["Result"], fmul.inputs[1])
fnt.links.new(fmul.outputs["Value"], fvol.inputs["Density"])
fnt.links.new(fvol.outputs["Volume"], fnt.nodes.get("Material Output").inputs["Volume"])
fog.data.materials.append(fm)

# ---------------------------------------------------------------- the square: fire pit, logs, figures
for i in range(11):
    a = i / 11 * math.tau
    s = add(bpy.ops.mesh.primitive_ico_sphere_add, f"PitStone{i}", M["stone"], loc=(math.cos(a) * 0.95, math.sin(a) * 0.95, 0.05),
            scale=(0.32, 0.28, 0.2), subdivisions=1, radius=1)
    jitter_mesh(s, 0.12)
for i in range(3):
    a = i / 3 * math.tau
    add(bpy.ops.mesh.primitive_cylinder_add, f"FireLog{i}", M["dark_wood"], loc=(math.cos(a) * 0.3, math.sin(a) * 0.3, 0.15),
        rot=(math.radians(70), 0, a), vertices=6, radius=0.09, depth=1.1)
for i, (h, r, dx) in enumerate([(1.3, 0.32, 0.0), (0.9, 0.25, 0.18), (0.8, 0.22, -0.2)]):
    f = add(bpy.ops.mesh.primitive_cone_add, f"Flame{i}", M["flame"], loc=(dx, dx * 0.5, 0.2 + h / 2), vertices=7, radius1=r, depth=h)
    jitter_mesh(f, 0.05)
add(bpy.ops.mesh.primitive_circle_add, "Embers", M["ember"], loc=(0, 0, 0.06), fill_type="NGON", vertices=9, radius=0.75)
fire_data = bpy.data.lights.new("Fire", "POINT")
fire_data.energy = 1600
fire_data.color = (1.0, 0.42, 0.1)
fire_data.shadow_soft_size = 0.35
fire = bpy.data.objects.new("Fire", fire_data)
fire.location = (0, 0, 0.9)
coll.objects.link(fire)

NAMES = ["Fable 5.1", "GPT-6 Sol", "Gemini Pro", "Grok 4.7", "DeepSeek V4", "Kimi K3", "Qwen Max", "GLM 5.3"]
ROLE = {2: "wolf", 5: "seer", 6: "witch"}
SPEAKER = 3
SEAT_R = 4.3
heads = {}
for i in range(8):
    a = i / 8 * math.tau + math.radians(12)
    pos = Vector((math.cos(a) * SEAT_R, math.sin(a) * SEAT_R, 0))
    face_in = math.atan2(-pos.y, -pos.x)
    log = add(bpy.ops.mesh.primitive_cylinder_add, f"Log{i}", M["wood"], loc=(pos.x, pos.y, 0.22),
              rot=(math.radians(90), 0, face_in), vertices=7, radius=0.24, depth=1.5)
    jitter_mesh(log, 0.03)

    root = bpy.data.objects.new(f"Figure{i}", None)
    coll.objects.link(root)
    root.location = (pos.x, pos.y, 0.42)
    root.rotation_euler = (0, 0, face_in - math.pi / 2)  # local +Y faces the fire
    bpy.context.view_layer.update()
    parts = []
    body = add(bpy.ops.mesh.primitive_cone_add, "Body", M["cloak"], loc=(0, 0, 0.55), vertices=8, radius1=0.46, radius2=0.17, depth=1.1)
    jitter_mesh(body, 0.025)
    hood = add(bpy.ops.mesh.primitive_uv_sphere_add, "Hood", M["cloak"], loc=(0, -0.07, 1.27), scale=(1, 1.05, 1.18), segments=9, ring_count=7, radius=0.27)
    tip = add(bpy.ops.mesh.primitive_cone_add, "HoodTip", M["cloak"], loc=(0, -0.2, 1.55), rot=(math.radians(-35), 0, 0), vertices=6, radius1=0.12, depth=0.35)
    face = add(bpy.ops.mesh.primitive_uv_sphere_add, "Face", M["face"], loc=(0, 0.1, 1.24), scale=(0.85, 0.6, 1.0), segments=8, ring_count=6, radius=0.2)
    scarf = add(bpy.ops.mesh.primitive_torus_add, "Scarf", SEAT_MATS[i], loc=(0, 0, 1.03), major_radius=0.21, minor_radius=0.07, major_segments=10, minor_segments=5)
    eye_mat = M["wolf_eye"] if ROLE.get(i) == "wolf" else M["eye"]
    eyes = [add(bpy.ops.mesh.primitive_uv_sphere_add, f"Eye{k}", eye_mat, loc=(0.065 * k, 0.21, 1.27), segments=6, ring_count=4,
                radius=0.026 if ROLE.get(i) != "wolf" else 0.032) for k in (-1, 1)]
    parts += [body, hood, tip, face, scarf, *eyes]
    if ROLE.get(i) == "seer":
        parts.append(add(bpy.ops.mesh.primitive_ico_sphere_add, "Orb", M["orb"], loc=(0, 0.42, 0.62), subdivisions=2, radius=0.11, flat=False))
        glow = bpy.data.lights.new("OrbGlow", "POINT")
        glow.energy, glow.color, glow.shadow_soft_size = 15, (0.35, 0.8, 1.0), 0.1
        gl = bpy.data.objects.new("OrbGlow", glow)
        gl.location = (0, 0.5, 0.65)
        coll.objects.link(gl)
        parts.append(gl)
    if ROLE.get(i) == "witch":
        parts.append(add(bpy.ops.mesh.primitive_cone_add, "WitchHat", M["cloak"], loc=(0, -0.05, 1.72), rot=(math.radians(-12), 0, 0), vertices=7, radius1=0.24, depth=0.62))
        parts.append(add(bpy.ops.mesh.primitive_cylinder_add, "HatBrim", M["cloak"], loc=(0, -0.02, 1.47), vertices=10, radius=0.42, depth=0.03))
    for p in parts:
        # parts were made in the figure's local frame: move them into it
        p.matrix_world = root.matrix_world @ p.matrix_world
        parent(p, root)
    heads[i] = root.matrix_world @ Vector((0, 0, 1.3))

    dist = (heads[i] - cam.location).length
    label = text_obj(NAMES[i], 0.026 * dist, NAME_MATS[i], tuple(heads[i] + Vector((0, 0, 0.45 + 0.03 * dist))))
    c = label.constraints.new("TRACK_TO")
    c.target, c.track_axis, c.up_axis = cam, "TRACK_Z", "UP_Y"

# the speaker's line, above their head
sd = (heads[SPEAKER] - cam.location).length
line = text_obj("Kimi was far too quiet last night.\nI don't trust them.", 0.022 * sd, M["text"], tuple(heads[SPEAKER] + Vector((0, 0, 0.75 + 0.075 * sd))))
c = line.constraints.new("TRACK_TO")
c.target, c.track_axis, c.up_axis = cam, "TRACK_Z", "UP_Y"
bpy.context.view_layer.update()
w, h = line.dimensions.x + 0.35, line.dimensions.y + 0.25
bpy.ops.mesh.primitive_plane_add(size=1)
box = bpy.context.active_object
box.name = "SpeechBox"
box.data.materials.append(M["bubble"])
box.scale = (w, h, 1)
box.parent = line
box.location = (0, 0, -0.02)
box.matrix_parent_inverse.identity()

# ---------------------------------------------------------------- gallows on a mound, on the line to the moon
t = (12.5 - cam.location.y) / moon_dir.y
gx = cam.location.x + moon_dir.x * t
gal = Vector((gx, 12.5, 0))
mound = add(bpy.ops.mesh.primitive_uv_sphere_add, "Mound", M["ground"], loc=(gal.x, gal.y, -2.2), scale=(5.5, 4.5, 1.0), segments=12, ring_count=8, radius=1)
jitter_mesh(mound, 0.25)
top = 0.8
for dx in (-1.1, 1.1):
    p = add(bpy.ops.mesh.primitive_cube_add, "GallowsPost", M["dark_wood"], loc=(gal.x + dx, gal.y, top + 2.1), scale=(0.13, 0.13, 2.1))
    p.rotation_euler.y = math.radians(rng.uniform(-2, 2))
add(bpy.ops.mesh.primitive_cube_add, "GallowsBeam", M["dark_wood"], loc=(gal.x, gal.y, top + 4.15), scale=(1.55, 0.13, 0.12))
add(bpy.ops.mesh.primitive_cube_add, "GallowsBrace", M["dark_wood"], loc=(gal.x + 0.75, gal.y, top + 3.6), rot=(0, math.radians(45), 0), scale=(0.06, 0.06, 0.6))
add(bpy.ops.mesh.primitive_cube_add, "Platform", M["wood"], loc=(gal.x, gal.y, top + 0.55), scale=(1.8, 1.4, 0.08))
for dx, dy in [(-1.6, -1.2), (1.6, -1.2), (-1.6, 1.2), (1.6, 1.2)]:
    add(bpy.ops.mesh.primitive_cube_add, "PlatformLeg", M["dark_wood"], loc=(gal.x + dx, gal.y + dy, top + 0.25), scale=(0.08, 0.08, 0.3))
add(bpy.ops.mesh.primitive_cylinder_add, "Rope", M["rope"], loc=(gal.x - 0.3, gal.y, top + 3.55), vertices=6, radius=0.025, depth=1.2)

# ---------------------------------------------------------------- cottages around the square
cam2 = Vector((cam.location.x, cam.location.y))
moon2 = Vector((moon_dir.x, moon_dir.y)).normalized()


def blocks_moon(x, y, margin=3.0):
    d = Vector((x, y)) - cam2
    along = d.dot(moon2)
    if along < 0:
        return False
    return (d - moon2 * along).length < margin + along * 0.17


for k, deg in enumerate([18, 52, 128, 158, 195, 300, 333, 75, 240]):
    a = math.radians(deg)
    r = rng.uniform(12.5, 15.0)
    base = Vector((math.cos(a) * r, math.sin(a) * r, 0))
    if blocks_moon(base.x, base.y, 4.5) or (base - Vector((cam.location.x, cam.location.y, 0))).length < 7:
        continue
    yaw = math.atan2(-base.y, -base.x) - math.pi / 2
    house = bpy.data.objects.new(f"House{k}", None)
    coll.objects.link(house)
    house.location = base
    house.rotation_euler = (math.radians(rng.uniform(-2.5, 2.5)), math.radians(rng.uniform(-2.5, 2.5)), yaw)
    bpy.context.view_layer.update()
    wdt, dep, hgt = rng.uniform(3.2, 4.2), rng.uniform(3.0, 3.8), rng.uniform(2.3, 2.9)
    parts = [add(bpy.ops.mesh.primitive_cube_add, "Walls", M["plaster"], loc=(0, 0, hgt / 2), scale=(wdt / 2, dep / 2, hgt / 2))]
    roof = add(bpy.ops.mesh.primitive_cylinder_add, "Roof", M["roof"], loc=(0, 0, hgt + 0.85), rot=(0, math.radians(90), 0),
               scale=(1.0, 1.0, 1.0), vertices=3, radius=1.0, depth=wdt + 0.5)
    roof.scale = (1.15, dep / 1.5, 1.0)
    jitter_mesh(roof, 0.06)
    parts.append(roof)
    parts.append(add(bpy.ops.mesh.primitive_cube_add, "Chimney", M["stone"], loc=(wdt * 0.28, -0.4, hgt + 1.2), scale=(0.25, 0.25, 0.6)))
    parts.append(add(bpy.ops.mesh.primitive_cube_add, "Door", M["dark_wood"], loc=(-wdt * 0.15, dep / 2 + 0.01, 0.85), scale=(0.42, 0.03, 0.85)))
    lit = rng.random() < 0.55
    parts.append(add(bpy.ops.mesh.primitive_cube_add, "Window", M["window"] if lit else M["window_dark"], loc=(wdt * 0.22, dep / 2 + 0.01, 1.45), scale=(0.3, 0.03, 0.26)))
    parts.append(add(bpy.ops.mesh.primitive_cube_add, "MullionV", M["dark_wood"], loc=(wdt * 0.22, dep / 2 + 0.05, 1.45), scale=(0.035, 0.03, 0.28)))
    parts.append(add(bpy.ops.mesh.primitive_cube_add, "MullionH", M["dark_wood"], loc=(wdt * 0.22, dep / 2 + 0.05, 1.45), scale=(0.32, 0.03, 0.035)))
    parts.append(add(bpy.ops.mesh.primitive_cube_add, "Frame", M["dark_wood"], loc=(wdt * 0.22, dep / 2 + 0.02, 1.45), scale=(0.36, 0.025, 0.32)))
    for p in parts:
        p.matrix_world = house.matrix_world @ p.matrix_world
        parent(p, house)
    if lit:
        wl = bpy.data.lights.new("WindowGlow", "POINT")
        wl.energy, wl.color, wl.shadow_soft_size = 140, (1.0, 0.5, 0.15), 0.3
        o = bpy.data.objects.new("WindowGlow", wl)
        o.location = house.matrix_world @ Vector((wdt * 0.22, dep / 2 + 0.6, 1.45))
        coll.objects.link(o)

# a lantern post near the path
for (lx, ly) in [(7.5, -3.0), (-7.8, 2.5)]:
    add(bpy.ops.mesh.primitive_cylinder_add, "LanternPost", M["dark_wood"], loc=(lx, ly, 1.3), vertices=6, radius=0.07, depth=2.6)
    add(bpy.ops.mesh.primitive_cube_add, "Lantern", M["lantern"], loc=(lx, ly, 2.65), scale=(0.09, 0.09, 0.12))
    add(bpy.ops.mesh.primitive_cone_add, "LanternCap", M["dark_wood"], loc=(lx, ly, 2.84), vertices=4, radius1=0.16, depth=0.14)
    ll = bpy.data.lights.new("LanternLight", "POINT")
    ll.energy, ll.color, ll.shadow_soft_size = 120, (1.0, 0.5, 0.16), 0.15
    o = bpy.data.objects.new("LanternLight", ll)
    o.location = (lx, ly, 2.55)
    coll.objects.link(o)

# ---------------------------------------------------------------- forest ring (with a gap toward the moon)
def pine(name, loc, h):
    tr = add(bpy.ops.mesh.primitive_cylinder_add, name + "Trunk", M["dead"], loc=(loc[0], loc[1], h * 0.15), vertices=5, radius=0.18, depth=h * 0.3)
    for j in range(3):
        cone = add(bpy.ops.mesh.primitive_cone_add, name + f"Tier{j}", M["pine"], loc=(loc[0], loc[1], h * (0.35 + j * 0.2)),
                   vertices=7, radius1=h * (0.26 - j * 0.06), depth=h * 0.42)
        jitter_mesh(cone, 0.12)


def dead_tree(name, loc, h):
    tr = add(bpy.ops.mesh.primitive_cone_add, name, M["dead"], loc=(loc[0], loc[1], h / 2), vertices=6, radius1=0.35, radius2=0.06, depth=h)
    tr.rotation_euler = (math.radians(rng.uniform(-6, 6)), math.radians(rng.uniform(-6, 6)), 0)
    for j in range(rng.randint(2, 4)):
        z = h * rng.uniform(0.45, 0.85)
        ang = rng.uniform(0, math.tau)
        add(bpy.ops.mesh.primitive_cone_add, name + f"Branch{j}", M["dead"], loc=(loc[0] + math.cos(ang) * 0.6, loc[1] + math.sin(ang) * 0.6, z + 0.4),
            rot=(math.radians(rng.uniform(40, 65)), 0, ang + math.pi / 2), vertices=5, radius1=0.08, radius2=0.01, depth=h * 0.35)


n = 0
while n < 210:
    a = rng.uniform(0, math.tau)
    r = rng.uniform(21, 52)
    x, y = math.cos(a) * r, math.sin(a) * r
    if blocks_moon(x, y):
        continue
    h = rng.uniform(7, 12)
    (dead_tree if rng.random() < 0.25 else pine)(f"Tree{n}", (x, y), h)
    n += 1
for j in range(5):  # a few bare trees close to the square, for silhouettes
    a = rng.uniform(0, math.tau)
    r = rng.uniform(8, 11)
    x, y = math.cos(a) * r, math.sin(a) * r
    if not blocks_moon(x, y):
        dead_tree(f"NearTree{j}", (x, y), rng.uniform(5, 7))

# ---------------------------------------------------------------- render
raw = os.path.join(OUT, "style_test_raw.png")
scene.render.filepath = raw
scene.render.image_settings.file_format = "PNG"
bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "style_test.blend"))

# ---------------------------------------------------------------- the horror-game finish (2D, on the render)
img = bpy.data.images.load(raw)
wpx, hpx = img.size
px = np.empty(wpx * hpx * 4, dtype=np.float32)
img.pixels.foreach_get(px)
px = px.reshape(hpx, wpx, 4)
rgb = px[..., :3].copy()


def blur(a, radius):
    """Separable box blur, applied three times (close to a gaussian)."""
    for _ in range(3):
        k = 2 * radius + 1
        c = np.cumsum(np.pad(a, ((radius + 1, radius), (0, 0), (0, 0)), mode="edge"), axis=0)
        a = (c[k:] - c[:-k]) / k
        c = np.cumsum(np.pad(a, ((0, 0), (radius + 1, radius), (0, 0)), mode="edge"), axis=1)
        a = (c[:, k:] - c[:, :-k]) / k
    return a


bright = np.clip(rgb - 0.55, 0, None)
rgb = rgb + blur(bright, 18) * 1.4 + blur(bright, 5) * 0.6  # bloom around fire, windows, eyes, the moon
yy, xx = np.mgrid[0:hpx, 0:wpx]
nx, ny = (xx / wpx - 0.5) * 2, (yy / hpx - 0.5) * 2
r2 = nx ** 2 * 0.85 + ny ** 2
shift = 3  # colour fringe toward the edges
fr = np.roll(rgb[..., 0], shift, axis=1)
fb = np.roll(rgb[..., 2], -shift, axis=1)
edge = np.clip(r2 - 0.25, 0, 1)
rgb[..., 0] = rgb[..., 0] * (1 - edge) + fr * edge
rgb[..., 2] = rgb[..., 2] * (1 - edge) + fb * edge
rgb *= (1 - 0.55 * np.clip(r2, 0, 1.6) ** 1.4)[..., None]  # vignette
noise = np.random.default_rng(7).normal(0, 1, (hpx, wpx, 1)).astype(np.float32)
rgb += noise * 0.028 * (0.6 + 0.4 * (1 - np.clip(rgb.mean(-1, keepdims=True) * 2, 0, 1)))  # grain, stronger in shadows
px[..., :3] = np.clip(rgb, 0, 1)
fin = bpy.data.images.new("style_test", wpx, hpx, alpha=False)
fin.pixels.foreach_set(px.ravel())
fin.filepath_raw = os.path.join(OUT, "style_test.png")
fin.file_format = "PNG"
fin.save()
print("[style_test] done:", fin.filepath_raw)
