"""Game 3's thumbnails (game c0416225, "Chinese AIs vs American AIs", owner 2026-10-28), as a NEW script: it borrows
make_thumbnails.py's parts (the video's figures, the real logos, the sharp title pass) without changing Game 1's or
Game 2's scripts.

    python thumbnail/make_flags.py      (once: the two flags, drawn to their official construction sheets)
    blender --background --factory-startup --python thumbnail/make_thumbnails_g3.py [-- 1_standoff]

1_standoff  (owner) the screen split in two: China on the left in red, the USA on the right in blue, each side's flag
            barely visible in its fog; the two Chinese AIs (DeepSeek, Qwen) big and close on the left as werewolves
            (ears, glowing red eyes, as in the intro), three American AIs on the right (GPT, Claude, Gemini; owner:
            only these three); a big VS in the middle as the divider (owner: "it is like a
            challenge and gamers love that"); WEREWOLF across the top, a little thinner than Games 1-2 (Arial Narrow
            Bold, not Impact).
4_standoff_faces  (owner) 1_standoff without the WEREWOLF title, the wolves with angry red brows, the Americans
            smug (a raised brow and a lopsided grin, white); it replaces 1_standoff in the A/B test.
3_liar      (owner, the drama creators' style) DeepSeek's head and shoulders on a black frame, angry glowing red
            brows, red mist painted in behind it, one huge word LIAR with a red underline (3_liar_base +
            add_liar_g3.py). Dropped on the way: a wolf-shadow standoff, a standoff with faces, a two-wolf close-up
            with speech bubbles.
Output: thumbnail/Game 3/<name>.png, 1280x720.
SPOILERS: none. The video's premise (its intro) is that the two Chinese AIs are the secret wolves; the Americans are
plain (no role tells: hats or crossbows would add clutter at phone size).
"""
import functools
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_thumbnails as mt  # noqa: E402  (Game 1's parts; its __main__ does not run on import)
import colors  # noqa: E402  (village/, on the path through make_thumbnails)

GID = "c0416225"
colors.use_game(GID)  # each seat in its model's colour (model_colors.json), as in the video
mt.GAME = "Game 3"
mt.OUT = os.path.join(HERE, "Game 3")
mt.IMPACT = "C:/Windows/Fonts/ARIALNB.TTF"  # owner: the title "a bit thinner" than Impact (mt.title reads this name)
figure, glow, toon, add, light, camera, fog_box, common = mt.figure, mt.glow, mt.toon, mt.add, mt.light, mt.camera, mt.fog_box, mt.common

# Game 3's seats 1..7: DeepSeek and Qwen are the two wolves (Team China), the other five are Team USA
MODELS = ["DeepSeek V4 Pro", "Qwen 3.8 Max", "GPT-6 Sol", "Claude Opus 5.5", "Gemini 4 Argon", "Grok 4.7", "Muse Wonder"]
LAB = {**mt.LAB, "DeepSeek": "deepseek", "Qwen": "qwen", "Muse": "meta"}
mt.LOGO_GLOW.update({"deepseek": 1.3, "qwen": 1.4, "meta": 1.35})

RED = (1.0, 0.07, 0.05)    # Team China (the intro's TEAM CHINA red)
BLUE = (0.12, 0.38, 1.0)   # Team USA (the intro's TEAM USA blue)


def lab_of(model):
    return next((v for k, v in LAB.items() if model.startswith(k)), None)


def contestant(M, seat, loc, yaw, scale, wolf=False, logo_at=(0.0, 0.37, 0.92), expr=None):
    """One of the video's figures in its model's colour with its lab's logo on the chest; `wolf`: the werewolf form of
    the intro (ears and glowing red eyes)."""
    root, _ = figure(M, f"T{seat}", loc, yaw, seat, "werewolf" if wolf else "villager", pose="stand", night=wolf)
    root.scale = (scale, scale, scale)
    if expr:  # red strokes for a wolf (its eyes' colour), white for the others
        face_lines(root, seat, expr, M["wolf_eye"] if wolf else M["eye"])
    lab = lab_of(MODELS[seat - 1])
    if lab and os.path.exists(os.path.join(HERE, "logos", "png", f"{lab}.png")):
        mt.logo(lab, root, at=logo_at)
    return root


# ---------------------------------------------------------------- faces (owner, 2026-10-28: thumbnails only)
# The video's faces are a dark hollow with two glowing dot eyes, so an expression is drawn the same way: glowing
# strokes (brows, a mouth) in the eyes' own colour, on the face's surface, hanging from the head pivot so they turn
# and bow with it. Points are (x, z) in figure space (standing figure: eyes at x +-0.068, z 1.58); the figures face
# the camera, so local +x is on the SCREEN's left.
EXPRESSIONS = {
    # angry (owner, 2026-10-28: "adding brows to look angry ... no need for full face"): two brows pulled hard down
    # toward the middle, no mouth (a wary frown with a mouth was tried first)
    "angry": [[(0.024, 1.606), (0.07, 1.632), (0.118, 1.664)],
              [(-0.024, 1.606), (-0.07, 1.632), (-0.118, 1.664)]],
    # smug (owner, 2026-10-28, the Americans in 4_standoff_faces): one brow raised in an arch, the other low and
    # level; a lopsided grin rising to one corner
    "smug": [[(0.03, 1.64), (0.07, 1.675), (0.115, 1.66)],
             [(-0.03, 1.625), (-0.075, 1.628), (-0.115, 1.618)],
             [(0.075, 1.492), (0.03, 1.478), (-0.02, 1.48), (-0.06, 1.497), (-0.092, 1.528)]],
}
STROKE = 0.011  # the strokes' radius (m, figure space): thick enough to read at phone size


def face_surface_y(x, z, tall=1.4):
    """The front of the face (figures.py: a sphere at (0, 0.125, tall + 0.16), radius 0.2 scaled (0.92, 0.6, 1.08))."""
    k = 1.0 - (x / 0.184) ** 2 - ((z - tall - 0.16) / 0.216) ** 2
    return 0.125 + 0.12 * math.sqrt(max(0.0, k))


def face_lines(root, seat, expr, material):
    """The expression's strokes on figure `seat`'s face, as glowing curves parented to its head pivot."""
    head = next(o for o in root.children_recursive if o.name == f"T{seat}_Head")
    out = []
    for k, line in enumerate(EXPRESSIONS[expr]):
        cu = bpy.data.curves.new(f"EyeLine{seat}_{k}", "CURVE")
        cu.dimensions = "3D"
        cu.bevel_depth, cu.bevel_resolution, cu.resolution_u = STROKE, 3, 8
        cu.use_fill_caps = True
        sp = cu.splines.new("NURBS")
        sp.points.add(len(line) - 1)
        for pt, (x, z) in zip(sp.points, line):
            pt.co = (x, face_surface_y(x, z) + 0.014, z, 1.0)
        sp.use_endpoint_u = True
        sp.order_u = min(3, len(line))
        cu.materials.append(material)
        o = bpy.data.objects.new(f"EyeLine{seat}_{k}", cu)
        mt.Ctx.coll.objects.link(o)
        o.parent = head
        o.matrix_parent_inverse = Matrix.Translation(Vector(head["abs"])).inverted()
        o["outline"] = False
        out.append(o)
    return out


def facing(x, y, at):
    """The yaw that turns a figure at (x, y) to face the point `at` (its front is local +y)."""
    d = Vector(at) - Vector((x, y))
    return math.atan2(-d.x, d.y)


def flag(name, image, center, width, strength):
    """A big flag hanging far back in its side's fog, a little wavy (a subdivided plane), glowing faintly on its own:
    the fog in front of it leaves it barely visible (owner)."""
    img = bpy.data.images.load(os.path.join(HERE, "flags", image), check_existing=True)
    aspect = img.size[0] / img.size[1]
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=48, y_subdivisions=24, size=1.0, location=(0, 0, 0))
    o = bpy.context.active_object
    o.name = name
    for v in o.data.vertices:  # the grid lies in x/y with size 1: stretch it to the flag's shape and add a soft wave
        u = v.co.x + 0.5
        v.co = Vector((v.co.x * width, 0.22 * math.sin(u * 7.0) * (0.3 + u), v.co.y * width / aspect))
    o.location = center
    m = bpy.data.materials.new(f"Flag_{name}")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = strength
    # soft edges: the flag fades out over the outer part of each side (no hard rectangle in the fog)
    uv = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(uv.outputs["UV"], sep.inputs[0])
    fades = []
    for axis, inner in (("X", 0.30), ("Y", 0.26)):
        off = nt.nodes.new("ShaderNodeMath")
        off.operation = "SUBTRACT"
        off.inputs[1].default_value = 0.5
        nt.links.new(sep.outputs[axis], off.inputs[0])
        ab = nt.nodes.new("ShaderNodeMath")
        ab.operation = "ABSOLUTE"
        nt.links.new(off.outputs[0], ab.inputs[0])
        mr = nt.nodes.new("ShaderNodeMapRange")
        mr.interpolation_type = "SMOOTHSTEP"
        mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = inner, 0.5
        mr.inputs["To Min"].default_value, mr.inputs["To Max"].default_value = 1.0, 0.0
        nt.links.new(ab.outputs[0], mr.inputs["Value"])
        fades.append(mr)
    both = nt.nodes.new("ShaderNodeMath")
    both.operation = "MULTIPLY"
    nt.links.new(fades[0].outputs["Result"], both.inputs[0])
    nt.links.new(fades[1].outputs["Result"], both.inputs[1])
    clear = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(tex.outputs["Color"], em.inputs["Color"])
    nt.links.new(both.outputs[0], mix.inputs["Fac"])
    nt.links.new(clear.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        try:
            setattr(m, attr, val)
        except Exception:
            pass
    o.data.materials.append(m)
    for c in list(o.users_collection):  # into the scene's collection, as add() does
        c.objects.unlink(o)
    mt.Ctx.coll.objects.link(o)
    o["outline"] = False
    return o


# 4_standoff_faces' framing: lens, look-at, Team China's x pulled in by this factor, Team USA's x, each flag's (centre, width, glow)
# the flags' glow evened out (owner: the US flag, white stripes and stars, outweighed China's dark red one and
# pulled the eye from the faces): measured as the spread of brightness in a patch of sky beside each
FACES = dict(lens=33, look=(0.0, 2.6, 1.6), pull=0.9, usa_x=(1.75, 3.0, 4.25), china=((-5.4, 13.0, 3.3), 14.0, 0.11), usa=((5.7, 13.0, 3.3), 16.0, 0.042))


def build(faces=False):
    """The split world: Games 1-2's black floor, grid, fog and rim lights, but red on China's half and blue on the USA's."""
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    M = common.materials()
    sc = mt.begin_scene("Thumb3", seed=7)
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    w = bpy.data.worlds.new("ThumbWorld3")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.03, 0.01, 0.025, 1)
    sc.world = w
    add(bpy.ops.mesh.primitive_plane_add, "Floor", toon("ThumbFloor", (0.02, 0.015, 0.02)), loc=(0, 40, 0), size=300)  # ends where the grid ends (y 190): the sky meets the grid with no black floor between (owner)
    grid_r, grid_b = glow("GridRed", (0.9, 0.08, 0.06), 1.3), glow("GridBlue", (0.1, 0.3, 1.0), 1.5)
    # the grid runs all the way to the horizon (owner: Games 1-2's grid stopped at y 35-46 m and x +-17 m, leaving a
    # black band under the sky and unfinished squares at the sides): the lines running away from the camera, red on
    # the left, blue on the right, out to x +-108 and back to y 190; the middle line is a red and a blue one side by
    # side, the seam between the halves
    for k in range(-90, 91):
        if k:
            add(bpy.ops.mesh.primitive_cube_add, f"GridX{k}", grid_r if k < 0 else grid_b, loc=(k * 1.2, 90, 0.004), scale=(0.018, 100, 0.004))
    for x, mat in ((-0.02, grid_r), (0.02, grid_b)):
        add(bpy.ops.mesh.primitive_cube_add, f"GridX0{'L' if x < 0 else 'R'}", mat, loc=(x, 90, 0.004), scale=(0.018, 100, 0.004))
    for k in range(-4, 159):  # the cross lines, each in two halves that meet in the middle
        for side, mat in ((-1, grid_r), (1, grid_b)):
            add(bpy.ops.mesh.primitive_cube_add, f"GridY{k}{'L' if side < 0 else 'R'}", mat, loc=(side * 110, k * 1.2, 0.004), scale=(110, 0.018, 0.004))
    key = light("Key", "AREA", 900, (1.0, 0.93, 0.85), (0.0, -7, 6), 4.0)
    key.rotation_euler = (Vector((0, 0.5, 1.2)) - key.location).to_track_quat("-Z", "Y").to_euler()
    for x, col in ((-5, RED), (5, BLUE)):
        rim = light(f"Rim{x}", "SPOT", 3500 if x < 0 else 4200, col, (x, 6, 4), 0.4, spot=60)
        rim.rotation_euler = (Vector((x * 0.3, 0.4, 1.4)) - rim.location).to_track_quat("-Z", "Y").to_euler()
    fog_box(size=(20, 30, 10), center=(-10, 11, 4), color=(0.7, 0.06, 0.05), ground_density=0.045, falloff=0.3)
    fog_box(size=(20, 30, 10), center=(10, 11, 4), color=(0.08, 0.2, 0.75), ground_density=0.045, falloff=0.3)
    # faces (4_standoff_faces, no title: owner "increase the size of figures and flags"): the lens zoomed in and
    # tilted down into the room the title left, the figures drawn a little closer together so the edges stay in
    # frame, the flags bigger
    flag("FlagChina", "china.png", (-6.4, 13.0, 4.4) if not faces else FACES["china"][0], 12.0 if not faces else FACES["china"][1], 0.09 if not faces else FACES["china"][2])
    flag("FlagUSA", "usa.png", (6.6, 13.0, 4.4) if not faces else FACES["usa"][0], 13.5 if not faces else FACES["usa"][1], 0.09 if not faces else FACES["usa"][2])
    if faces:
        camera("Thumb", (0.0, -8.6, 3.2), FACES["look"], lens=FACES["lens"], moment="the thumbnail")
    else:
        camera("Thumb", (0.0, -8.6, 3.2), (0.0, 2.6, 2.4), lens=28, moment="the thumbnail")
    pull = FACES["pull"] if faces else 1.0

    # Team China: the two wolves, big and close on the left, turned toward the middle
    for seat, x, y in ((2, -4.05 * pull, 0.6), (1, -2.0 * pull, -0.6)):  # owner: DeepSeek in front, Qwen behind (far enough left that its logo shows)
        contestant(M, seat, (x, y, 0), facing(x, y, (1.5, -5.0)), 2.0, wolf=True, expr="angry" if faces else None)
    # Team USA: GPT, Claude and Gemini, side by side, turned toward the middle (owner, 2026-10-28: only these three;
    # with all five in a line running back, each one hid the next one's logo)
    usa_x = FACES["usa_x"] if faces else (1.9, 3.2, 4.5)
    for seat, x, y in ((3, usa_x[0], 0.6), (4, usa_x[1], 0.9), (5, usa_x[2], 1.2)):
        # (faces: turned less toward the middle, so in the closer framing no chest hides behind its neighbour)
        contestant(M, seat, (x, y, 0), facing(x, y, (-0.3, -9.0) if faces else (-1.5, -5.0)), 1.7, expr="smug" if faces else None)
    common.outline_all(M, skip=("Floor", "Fog", "Grid", "Title", "Flag", "Eye", "Logo"))
    return sc, M


def sharp_pass(sc, path, prefix, halo_rgb):
    """mt.title_pass for one group of title objects (those named `prefix`...) with its own halo colour: WEREWOLF gets
    the red halo of Games 1-2, VS a white-hot one (it stands on the seam between red and blue)."""
    import numpy as np
    keep = {o.name: o.hide_render for o in sc.objects}
    for o in sc.objects:
        if o.type != "LIGHT":
            o.hide_render = not o.name.startswith(prefix)
    film, pct = sc.render.film_transparent, sc.render.resolution_percentage
    sc.render.film_transparent, sc.render.resolution_percentage = True, 200
    sc.render.image_settings.color_mode = "RGBA"
    tmp = os.path.join(mt.OUT, "_title_pass.png")
    sc.render.filepath = tmp
    bpy.ops.render.render(write_still=True, scene=sc.name)
    sc.render.film_transparent, sc.render.resolution_percentage = film, pct
    for o in sc.objects:
        o.hide_render = keep[o.name]
    t = mt._load(tmp)
    os.remove(tmp)
    h, w = t.shape[0] // 2, t.shape[1] // 2
    pre = (t[..., :3] * t[..., 3:]).reshape(h, 2, w, 2, 3).mean(axis=(1, 3))
    a = t[..., 3].reshape(h, 2, w, 2).mean(axis=(1, 3))
    rgb = pre / np.maximum(a, 1e-4)[..., None]
    base = mt._load(path)
    out = base[..., :3]
    ink = mt._grow(a, max(3, w // 300))
    halo = np.clip(mt._blur(ink, max(6, w // 70)) * 0.55, 0, 1)
    out = out * (1 - halo[..., None]) + np.array(halo_rgb) * halo[..., None]
    out = out * (1 - ink[..., None]) + np.array([0.02, 0.0, 0.01]) * ink[..., None]
    out = out * (1 - a[..., None]) + rgb * a[..., None]
    base[..., :3] = np.clip(out, 0, 1)
    base[..., 3] = 1
    img = bpy.data.images.new("thumb_out", w, h, alpha=True)
    img.pixels.foreach_set(base.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def variant(sc, M, name, title=None, vs=None, extras=(), alpha_pass=False):
    """Render the scene (no titles), then each title sharp on top (as mt.variant does); no title: a plain render."""
    for o in [o for o in sc.objects if o.get("variant")]:
        bpy.data.objects.remove(o, do_unlink=True)
    for fn in extras:
        for o in fn(sc, M):
            o["variant"] = True
    ink = glow("TitleInk", (0.02, 0.0, 0.0), 1.0)
    if title:
        text, size, z = title
        t = mt.title("TitleW", text, size, (0, 3.0, z), mt.title_material("TitleFace", (1.0, 0.06, 0.035), 0.9), toon("TitleSide", (0.32, 0.015, 0.015)), shadow=ink)
        t["variant"] = True
    if vs:
        text, size, loc = vs
        v = mt.title("VsTitle", text, size, loc, mt.title_material("VsFace", (1.0, 0.92, 0.75), 1.2), toon("VsSide", (0.35, 0.3, 0.26)), shadow=ink)
        v["variant"] = True
    sc.camera = sc.objects["Cam_Thumb"]
    letters = [o for o in sc.objects if o.name.startswith(("TitleW", "VsTitle"))]
    for o in letters:
        o.hide_render = True
    sc.render.image_settings.color_mode = "RGB"
    path = os.path.join(mt.OUT, "bases", f"{name}.png") if name.endswith("_base") else os.path.join(mt.OUT, f"{name}.png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.makedirs(mt.OUT, exist_ok=True)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True, scene=sc.name)
    mt.glow_finish(path)
    if alpha_pass:  # the same frame with a transparent background: where the figure is (for a backdrop painted behind it)
        sc.render.film_transparent = True
        sc.render.image_settings.color_mode = "RGBA"
        sc.render.filepath = path.replace(".png", "_alpha.png")
        bpy.ops.render.render(write_still=True, scene=sc.name)
        sc.render.film_transparent = False
        sc.render.image_settings.color_mode = "RGB"
    for o in letters:
        o.hide_render = False
    if title:
        sharp_pass(sc, path, "TitleW", (0.75, 0.04, 0.03))
    if vs:
        sharp_pass(sc, path, "VsTitle", (1.0, 0.85, 0.6))
    print(f"[thumb3] {name}")


DEEPSEEK = 1

LIAR_CAM = ((0.86, -5.2, 2.2), (0.86, 0.0, 2.25), 50)  # location, look-at, lens: head and shoulders, DeepSeek on the left


def build_liar():
    """Thumbnail 3 (owner, 2026-10-28: "literally like the photo", the drama creators' style): DeepSeek's head and
    shoulders big on the left of a black frame, angry brows (glowing red strokes, like its eyes), red eyes and wolf
    ears as in the intro, its logo on the chest; the right half left empty for the word (add_liar_g3.py: the red
    mist painted in behind it, then LIAR with a red underline). Its lies in the game: "I'm just a Villager", then "I am the Hunter"."""
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    M = common.materials()
    sc = mt.begin_scene("Thumb3Liar", seed=7)
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    w = bpy.data.worlds.new("ThumbWorld3Liar")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.004, 0.003, 0.004, 1)
    sc.world = w
    contestant(M, DEEPSEEK, (0.0, 0.0, 0.0), facing(0.0, 0.0, (1.9, -5.2)), 1.5, wolf=True, logo_at=(0.0, 0.37, 1.0), expr="angry")
    key = light("Key", "AREA", 700, (1.0, 0.95, 0.9), (-1.6, -4.5, 4.2), 2.5)
    key.rotation_euler = (Vector((0, 0, 2.2)) - key.location).to_track_quat("-Z", "Y").to_euler()
    for x, energy in ((-2.6, 1400), (2.6, 2200)):  # red rims from behind: the dark cloak's edge against the black
        rim = light(f"Rim{x}", "SPOT", energy, RED, (x, 3.0, 3.6), 0.3, spot=45)
        rim.rotation_euler = (Vector((0, 0, 2.4)) - rim.location).to_track_quat("-Z", "Y").to_euler()
    loc, look, lens = LIAR_CAM
    camera("Thumb", loc, look, lens=lens, moment="Game 3's LIAR thumbnail")
    common.outline_all(M, skip=("Floor", "Fog", "Grid", "Title", "Flag", "Eye", "Logo"))
    return sc, M


VARIANTS = {
    "1_standoff": (build, dict(title=("WEREWOLF", 2.6, 5.35),  # raised from 5.0: clear of the wolves' ears (owner)
                               vs=("VS", 2.2, (0.0, 1.0, 2.3)))),
    # owner, 2026-10-28: to replace 1_standoff in the A/B test: no WEREWOLF, angry wolves, smug Americans
    "4_standoff_faces": (functools.partial(build, faces=True), dict(vs=("VS", 2.2, (0.0, 1.0, 2.3)))),
    "3_liar_base": (build_liar, dict(alpha_pass=True)),  # + add_liar_g3.py (the red mist behind, LIAR) -> 3_liar  # + add_bubble_g3.py -> 3_two_wolves
}

if __name__ == "__main__":
    want = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else list(VARIANTS)
    built = None
    for name in want:
        make, kw = VARIANTS[name]
        if built != make:
            sc, M = make()
            built = make
        variant(sc, M, name, **kw)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "thumbnails_g3.blend"))
    print("[thumb3] done")
