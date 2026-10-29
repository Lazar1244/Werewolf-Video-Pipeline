"""YouTube thumbnails (owner, 2026-10-19): a giant 3D title behind the six contestants on a glowing grid floor in red
fog, with a dead body in front, in the style of the popular "AIs play Mafia" videos, with our own characters.

    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --factory-startup --python thumbnail/make_thumbnails.py

Versions (thumbnail/<GAME>/<name>.png, 1280x720; plain renders that get texts on top go to <GAME>/bases/):
    1_werewolf       WEREWOLF, the classic
    2_whos_the_wolf  WHO'S THE WOLF?, the question, with small white texts (2_whos_the_wolf_base + add_questions.py)
    3_two_are_lying  2 ARE LYING, two pairs of red wolf eyes glowing in the fog behind them, with small white texts
    4_blood_moon     WEREWOLF before a huge red moon
    5_questions      WEREWOLF, smaller, with small white questions around the cast (5_questions_base + add_questions.py)
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "village"))
GAME = "Game 1"  # the episode these thumbnails are for (game 3880b590)
OUT = os.path.join(HERE, GAME)

import common  # noqa: E402
from common import Ctx, add, begin_scene, camera, fog_box, glow, light, toon  # noqa: E402
from figures import figure  # noqa: E402
from intro_stages import glow_finish, wolf_head  # noqa: E402

IMPACT = "C:/Windows/Fonts/impact.ttf"


def title_material(name, color, strength):
    """Bold red letters that glow a little on their faces (they read on any screen)."""
    return glow(name, color, strength)


def title(name, body, size, loc, M_face, M_side, shadow=None):
    """Solid 3D letters; `shadow`: a dark, slightly larger copy just behind, so they read crisply on any background."""
    if shadow is not None:
        sh = title(name + "Shadow", body, size * 1.035, (loc[0] + 0.12, loc[1] + 0.25, loc[2] - 0.12), shadow, shadow)
        sh["variant"] = True
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body
    cu.font = bpy.data.fonts.load(IMPACT, check_existing=True)
    cu.size = size
    cu.space_character = 1.04  # a hair of air between the letters (they touched)
    cu.align_x, cu.align_y = "CENTER", "CENTER"
    cu.extrude = 0.32
    cu.bevel_depth = 0.035
    cu.materials.append(M_face)
    cu.materials.append(M_side)
    o = bpy.data.objects.new(name, cu)
    o.location = loc
    o.rotation_euler = (math.radians(90), 0, 0)  # standing up, facing the camera (-y)
    Ctx.coll.objects.link(o)
    o["outline"] = False
    return o


# ---------------------------------------------------------------- the labs' logos (the real ones: logos/, prep_logos.py)

LOGO_GLOW = {"openai": 1.5, "claude": 1.15, "gemini": 1.25, "grok": 1.5}


def logo_material(lab):
    """The logo image glowing on its own, transparent around its shape."""
    name = f"Logo_{lab}"
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        try:
            setattr(m, attr, val)
        except Exception:
            pass
    nt = m.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(os.path.join(HERE, "logos", "png", f"{lab}.png"), check_existing=True)
    tex.interpolation = "Cubic"
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = LOGO_GLOW[lab]
    clear = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(tex.outputs["Color"], em.inputs["Color"])
    nt.links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
    nt.links.new(clear.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return m


def logo(lab, root, half=0.23, at=(0.0, 0.37, 0.92)):
    """The lab's logo on the figure's chest: a square decal in its chest plane (local x right, z up), facing its front
    (+y). The figure is turned to face the camera, so local +x is screen left: u runs along -x (the logo not mirrored)."""
    me = bpy.data.meshes.new(f"Logo_{lab}")
    me.from_pydata([(half, 0, -half), (-half, 0, -half), (-half, 0, half), (half, 0, half)], [], [[0, 1, 2, 3]])
    uv = me.uv_layers.new(name="UVMap")
    for loop, co in zip(uv.data, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop.uv = co
    me.materials.append(logo_material(lab))
    o = bpy.data.objects.new(f"Logo_{lab}", me)
    o.parent = root
    o.location = at
    Ctx.coll.objects.link(o)
    o["outline"] = False
    return o


def grow(o, f, apart=0.0):
    """Scale an object's own copy of its mesh about the mesh's centre (its origin may be a pivot elsewhere, e.g. the head);
    `apart` also moves it that far further out along x, away from the middle (the two eyes)."""
    me = o.data.copy()
    c = sum((v.co for v in me.vertices), Vector()) / len(me.vertices)
    shift = Vector((math.copysign(apart, c.x), 0, 0))
    for v in me.vertices:
        d = v.co - c
        v.co = c + shift + Vector((d.x * f[0], d.y * f[1], d.z * f[2]))
    o.data = me


BODY_TIP = 22  # degrees the body is tipped toward the camera

LAB = {"GPT": "openai", "Claude": "claude", "Gemini": "gemini", "Grok": "grok"}
MODELS = ["GPT-6 Sol", "Claude Fable 5.1", "Gemini 3.1 Pro", "Grok 4.7", "GPT-6 Astra", "Claude Opus 5.5"]  # seats 1..6 (game 3880b590)


def build():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    M = common.materials()
    sc = begin_scene("Thumb", seed=7)
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    w = bpy.data.worlds.new("ThumbWorld")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.07, 0.004, 0.006, 1)
    sc.world = w
    # the floor: black with a glowing red grid, running off to the horizon
    add(bpy.ops.mesh.primitive_plane_add, "Floor", toon("ThumbFloor", (0.02, 0.015, 0.02)), loc=(0, 6, 0), size=80)
    grid = glow("Grid", (0.9, 0.08, 0.06), 1.3)
    for k in range(-14, 15):
        add(bpy.ops.mesh.primitive_cube_add, f"GridX{k}", grid, loc=(k * 1.2, 6, 0.004), scale=(0.018, 40, 0.004))
    for k in range(-4, 30):
        add(bpy.ops.mesh.primitive_cube_add, f"GridY{k}", grid, loc=(0, k * 1.2, 0.004), scale=(40, 0.018, 0.004))
    # the six contestants in a row, each in its seat colour
    xs = [-3.6, -2.2, -0.75, 0.75, 2.2, 3.6]
    for k, x in enumerate(xs):
        root, _ = figure(M, f"T{k + 1}", (x, 0.4 + abs(x) * 0.12, 0), math.pi + math.atan2(x, 9) * 0.6, k + 1, "villager", pose="stand", night=False)
        root.scale = (1.5, 1.5, 1.5)
        lab = next((v for k2, v in LAB.items() if MODELS[k].startswith(k2)), None)
        if lab:
            logo(lab, root, at=(0.033 * x, 0.37, 0.92))  # nudged inward at the edges: centred under the hood in the lens
    # the dead body in front, across the frame: one of them didn't make it
    body, _ = figure(M, "Dead", (0.7, -0.45, 0), math.radians(92), 7, "villager", pose="body", clawed=True)
    # tipped toward the camera (about the world x axis, after its yaw) so the hood opening and the X eyes face us: the
    # village's body lies flat on its back, which this low camera sees edge-on (thumbnail review)
    body.matrix_world = Matrix.Translation((0.7, -0.45, 0.12)) @ Matrix.Rotation(math.radians(BODY_TIP), 4, "X")         @ Matrix.Rotation(math.radians(92), 4, "Z") @ Matrix.Diagonal((1.4, 1.4, 1.4, 1.0))
    tear = glow("ThumbTear", (0.85, 0.02, 0.02), 1.0)
    for o in body.children_recursive:
        if o.name.startswith("BloodPool2") or (o.data is not None and o.data.name.startswith("BloodPool2")):
            o.hide_render = True  # its own pool would tip up with it: the scene's pool lies flat under it instead
        elif "DeadX" in o.name or (o.data is not None and o.data.name.startswith("DeadX")):
            grow(o, (2.0, 2.0, 2.0), apart=0.05)  # X eyes big enough to read small, set wider so they stay two
        elif "TearD" in o.name or (o.data is not None and o.data.name.startswith("TearD")):
            o.data = o.data.copy()
            o.data.materials.clear()
            o.data.materials.append(tear)  # the claw tears bright red
            grow(o, (1.8, 1.15, 3.5))  # wider and standing proud of the cloak, so they show
    pool = glow("ThumbBlood", (0.42, 0.0, 0.008), 0.75)  # a wet red that reads on the black floor (owner's thumbnail review)
    add(bpy.ops.mesh.primitive_cylinder_add, "BloodPool", pool, loc=(0.1, -0.62, 0.012), vertices=40, radius=1.35, depth=0.01, scale=(1.55, 0.62, 1))
    # light: a strong warm key from the front, a hard red rim from behind
    key = light("Key", "AREA", 900, (1.0, 0.93, 0.85), (1.5, -7, 6), 4.0)
    key.rotation_euler = (Vector((0, 0.5, 1.2)) - key.location).to_track_quat("-Z", "Y").to_euler()
    for x in (-5, 5):
        rim = light(f"Rim{x}", "SPOT", 3500, (1.0, 0.1, 0.06), (x, 6, 4), 0.4, spot=60)
        rim.rotation_euler = (Vector((x * 0.3, 0.4, 1.4)) - rim.location).to_track_quat("-Z", "Y").to_euler()
    fog_box(size=(40, 30, 10), center=(0, 11, 4), color=(0.7, 0.06, 0.05), ground_density=0.045, falloff=0.3)
    camera("Thumb", (0.0, -8.2, 2.4), (0.0, 2.0, 2.55), lens=28, moment="the thumbnail")
    common.outline_all(M, skip=("Floor", "Fog", "Grid", "Title", "Moon", "Eye", "Logo", "BloodPool"))
    return sc, M


def _load(path):
    import numpy as np
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)


def _blur(a, r):
    import numpy as np
    k = 2 * r + 1
    for _ in range(2):
        c = np.cumsum(np.pad(a, ((r + 1, r), (0, 0)), mode="edge"), axis=0)
        a = (c[k:] - c[:-k]) / k
        c = np.cumsum(np.pad(a, ((0, 0), (r + 1, r)), mode="edge"), axis=1)
        a = (c[:, k:] - c[:, :-k]) / k
    return a


def _grow(alpha, r):
    """The alpha grown by r px in every direction (a round brush): the title's ink outline."""
    import numpy as np
    out = alpha.copy()
    p = np.pad(alpha, r)
    h, w = alpha.shape
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r + r:
                np.maximum(out, p[r + dy:r + dy + h, r + dx:r + dx + w], out=out)
    return out


def title_pass(sc, path):
    """The title alone, rendered sharp and laid over the finished scene (owner, 2026-10-19: it read foggy and soft).
    It renders at twice the size with no fog and no glow, is scaled down, and gets a dark ink outline and a soft red
    halo behind it, so its edges are crisp at any size."""
    import numpy as np
    keep = {o.name: o.hide_render for o in sc.objects}
    for o in sc.objects:
        if o.type != "LIGHT":
            o.hide_render = not o.name.startswith("Title")
    film, pct = sc.render.film_transparent, sc.render.resolution_percentage
    sc.render.film_transparent, sc.render.resolution_percentage = True, 200
    sc.render.image_settings.color_mode = "RGBA"
    tmp = os.path.join(OUT, "_title_pass.png")
    sc.render.filepath = tmp
    bpy.ops.render.render(write_still=True, scene=sc.name)
    sc.render.film_transparent, sc.render.resolution_percentage = film, pct
    for o in sc.objects:
        o.hide_render = keep[o.name]
    t = _load(tmp)
    os.remove(tmp)
    h, w = t.shape[0] // 2, t.shape[1] // 2  # 2x2 down, alpha-weighted: a clean anti-aliased edge
    pre = t[..., :3] * t[..., 3:]
    pre = pre.reshape(h, 2, w, 2, 3).mean(axis=(1, 3))
    a = t[..., 3].reshape(h, 2, w, 2).mean(axis=(1, 3))
    rgb = pre / np.maximum(a, 1e-4)[..., None]
    base = _load(path)
    out = base[..., :3]
    ink = _grow(a, max(3, w // 300))
    halo = np.clip(_blur(ink, max(6, w // 70)) * 0.55, 0, 1)
    out = out * (1 - halo[..., None]) + np.array([0.75, 0.04, 0.03]) * halo[..., None]  # a soft red halo
    out = out * (1 - ink[..., None]) + np.array([0.04, 0.0, 0.0]) * ink[..., None]       # the ink outline
    out = out * (1 - a[..., None]) + rgb * a[..., None]                                  # the title
    base[..., :3] = np.clip(out, 0, 1)
    base[..., 3] = 1
    img = bpy.data.images.new("thumb_out", w, h, alpha=True)
    img.pixels.foreach_set(base.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def variant(sc, M, name, lines, extras=()):
    for o in [o for o in sc.objects if o.get("variant")]:
        bpy.data.objects.remove(o, do_unlink=True)
    face = title_material("TitleFace", (1.0, 0.06, 0.035), 0.9)
    side = toon("TitleSide", (0.32, 0.015, 0.015))
    ink = glow("TitleInk", (0.02, 0.0, 0.0), 1.0)
    for k, (text, size, z) in enumerate(lines):
        t = title(f"Title{k}", text, size, (0, 3.0, z), face, side, shadow=ink)
        t["variant"] = True
    for fn in extras:
        for o in fn(sc, M):
            o["variant"] = True
    sc.camera = sc.objects["Cam_Thumb"]
    titles = [o for o in sc.objects if o.name.startswith("Title")]
    for o in titles:  # the scene first, without the title (its glow and the fog would soften the letters)
        o.hide_render = True
    sc.render.image_settings.color_mode = "RGB"
    path = os.path.join(OUT, "bases", f"{name}.png") if name.endswith("_base") else os.path.join(OUT, f"{name}.png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True, scene=sc.name)
    glow_finish(path)
    for o in titles:
        o.hide_render = False
    title_pass(sc, path)
    print(f"[thumb] {name}")


def lying_eyes(sc, M):
    """Two pairs of red wolf eyes glowing in the fog behind the row: two of them are wolves."""
    eye = glow("EyeBurn", (1.0, 0.05, 0.03), 5.0)
    out = []
    for (x, z) in ((-1.5, 3.05), (2.2, 2.85)):
        for s in (-1, 1):
            out.append(add(bpy.ops.mesh.primitive_uv_sphere_add, "Eye", eye, loc=(x + s * 0.26, 2.6, z), segments=12, ring_count=8, radius=0.16, scale=(1.4, 1, 0.7)))
    return out


def blood_moon(sc, M):
    moon_m = glow("ThumbMoon", (1.0, 0.18, 0.08), 2.0)
    m = add(bpy.ops.mesh.primitive_uv_sphere_add, "Moon", moon_m, loc=(4.5, 24, 5.0), segments=48, ring_count=24, radius=6.5, smooth=True)
    return [m]


VARIANTS = {
    "1_werewolf": dict(lines=[("WEREWOLF", 3.6, 5.0)]),
    "2_whos_the_wolf_base": dict(lines=[("WHO'S THE WOLF?", 2.6, 5.0)]),  # + texts: add_questions.py -> 2_whos_the_wolf
    "3_two_are_lying_base": dict(lines=[("2 ARE LYING", 3.0, 5.0)], extras=[lying_eyes]),  # + texts -> 3_two_are_lying
    "4_blood_moon": dict(lines=[("WEREWOLF", 3.6, 5.0)], extras=[blood_moon]),
    # the base of the questions version: a smaller title, room around it for the small white questions (add_questions.py)
    "5_questions_base": dict(lines=[("WEREWOLF", 2.9, 5.25)]),
}

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    want = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else list(VARIANTS)
    sc, M = build()
    for name in want:
        variant(sc, M, name, **VARIANTS[name])
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "thumbnails.blend"))
    print("[thumb] done")
