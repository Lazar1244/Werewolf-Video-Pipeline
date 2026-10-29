"""The intro's stages (owner, 2026-10-19): one thematic set per role, plus the contestants' lineup, in the same
cel-shaded style as the village, each with a strong key colour, for quick hook cuts while the host explains the rules.

    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --factory-startup --python village/intro_stages.py -- [--only Intro_Seer] [--no-render]

Writes out/intro.blend (separate from village.blend, so the game's sets and their render caches stay untouched) and
preview stills out/intro_previews/<scene>_<camera>.png.

Stages (scene: key colour; cameras):
    Intro_Lineup    the contestants under spotlights (6, or the --game's count)   Lineup_Wide, Lineup_Low, Lineup_1..n
    Intro_Versus    a team match (Game 3, China vs USA; built only when --game has both sides): the Chinese AIs on
                    the left as werewolves under red-tinted spotlights, a gap, the American AIs on the right in their
                    village bodies with their roles' tells                        Versus_Wide, Versus_China, Versus_USA
    Intro_Werewolf  blood red: a rock under a huge red moon Werewolf_Hero, Werewolf_Eyes, Werewolf_Wide
    Intro_Seer      icy blue: a giant crystal orb           Seer_Hero, Seer_Reveal (a wolf flashes in the orb), Seer_Wide
    Intro_Witch     toxic green and purple: the cauldron    Witch_Hero (two hero potions), Witch_Save, Witch_Kill
    Intro_Villager  amber lantern at night: cottage door    Villager_Hero, Villager_Wide (a wolf's shadow on the wall)

Objects with an "only_cam" property show in that camera's shot only; "hide_cam" hides one in that shot.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
OUT = os.path.join(os.path.dirname(HERE), "out")
PREV = os.path.join(OUT, "intro_previews")

import common  # noqa: E402
import kit  # noqa: E402
from common import Ctx, add, begin_scene, camera, fog_box, glow, jitter, light, look_yaw, mark, moon, night_sky, outline_all, toon  # noqa: E402
from figures import figure  # noqa: E402
from signs import sign  # noqa: E402

MODELS = {}  # seat -> model name for the lineup signs (from --game <id8>; generic "Seat n" without)
ROLES = {}  # seat -> {"role", "sheriff"} (from --game: the Versus stage dresses each American in their role)
CHINESE_LABS = ("DeepSeek", "Qwen", "Kimi", "GLM", "MiniMax", "MiMo", "Hunyuan", "Step", "Seed", "Ling")


def team_of(model):
    return "china" if model.startswith(CHINESE_LABS) else "usa"

NEUTRAL = 5  # the role figures wear the white scarf: a role, not a contestant


def stage_mats(M):
    M = dict(M)
    M.update({
        "blood_moon": glow("BloodMoon", (1.0, 0.16, 0.08), 2.4),
        "claw": glow("ClawMark", (0.9, 0.05, 0.04), 2.2),
        "rune": glow("Rune", (0.35, 0.8, 1.0), 2.4),
        "star_dot": glow("StarDot", (0.75, 0.9, 1.0), 2.5),
        "orb_big": orb_glass("OrbGlass", (0.3, 0.68, 1.0)),
        "brew": glow("Brew", (0.35, 1.0, 0.3), 2.0),
        "brew_bubble": glow("BrewBubble", (0.6, 1.0, 0.5), 2.4),
        "cauldron": toon("Cauldron", (0.10, 0.10, 0.12)),
        "stage_floor": toon("StageFloor", (0.16, 0.15, 0.19), noise=0.15, noise_scale=3),
        "spot_beam": glow("SpotDisc", (1.0, 0.92, 0.75), 0.75),
        "herb": toon("Herb", (0.30, 0.42, 0.22), noise=0.2, noise_scale=4),
        "sunset_sun": glow("SunsetSun", (1.0, 0.55, 0.2), 1.5),
        "wall_shadow": toon("WallShadow", (0.025, 0.02, 0.03)),
        "shelf_green": toon("ShelfGreen", (0.22, 0.45, 0.25)),  # the shelves' bottles: coloured, not glowing,
        "shelf_purple": toon("ShelfPurple", (0.35, 0.2, 0.45)),  # so the two hero potions are the only lights
        "shelf_blue": toon("ShelfBlue", (0.2, 0.32, 0.45)),
        "neck_green": toon("NeckGreen", (0.35, 0.6, 0.4)),
        "neck_purple": toon("NeckPurple", (0.4, 0.28, 0.5)),
        "poison_dark": glow("PoisonDark", (0.5, 0.08, 0.85), 1.4),
        "highlight": glow("Highlight", (1.0, 1.0, 1.0), 2.5),
        "sparkle": glow("Sparkle", (0.7, 1.0, 0.6), 3.0),
        "fume": glow("Fume", (0.55, 0.2, 0.8), 0.8),
        "vision": glow("Vision", (1.0, 0.06, 0.04), 3.0),
        "amber": glow("Amber", (1.0, 0.62, 0.18), 1.0),
        "lantern_hot": glow("LanternHot", (1.0, 0.75, 0.3), 3.0),
    })
    heal = M["potion_heal"].node_tree.nodes.get("Emission")  # the healing potion stays green in a close-up (this file only)
    if heal is not None:
        heal.inputs["Strength"].default_value = 0.9
        heal.inputs["Color"].default_value = (0.2, 0.95, 0.3, 1)
    eye = M["wolf_eye"].node_tree.nodes.get("Emission")  # the wolf's eyes burn (this file only)
    if eye is not None:
        eye.inputs["Strength"].default_value = 2.6
        eye.inputs["Color"].default_value = (1.0, 0.03, 0.02, 1)
    for m in M.values():
        m.use_fake_user = True
    return M


def orb_glass(name, color, core=2.6, rim=0.25):
    """A crystal ball that glows from inside: bright where you look straight into it, dimmer toward its edge."""
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes.get("Principled BSDF"))
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.45
    ramp = nt.nodes.new("ShaderNodeMapRange")
    ramp.inputs["From Min"].default_value, ramp.inputs["From Max"].default_value = 0.0, 1.0
    ramp.inputs["To Min"].default_value, ramp.inputs["To Max"].default_value = core, rim
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*color, 1)
    nt.links.new(lw.outputs["Facing"], ramp.inputs["Value"])
    nt.links.new(ramp.outputs["Result"], em.inputs["Strength"])
    nt.links.new(em.outputs[0], nt.nodes.get("Material Output").inputs["Surface"])
    m["outline"] = False
    return m


def void_world(name, color, strength=1.0):
    w = bpy.data.worlds.new(name)
    w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (*color, 1)
    bg.inputs["Strength"].default_value = strength
    Ctx.scene.world = w


def stand(M, name, loc, yaw, seat, role, color=None, **kw):
    """A standing figure; `color` dresses its scarf and hood rim in the role's key colour (not a contestant's)."""
    root, head = figure(M, name, loc, yaw, seat, role, pose="stand", **kw)
    if color is not None:
        for o in root.children_recursive:
            if o.name.split(".")[0] in ("Scarf", "HoodRim") and o.material_slots:
                o.material_slots[0].link = "OBJECT"
                o.material_slots[0].material = color
    return root, head


WOLF_HEAD = [(-0.55, -0.62), (-0.5, -0.12), (-0.42, 0.2), (-0.3, 0.34), (-0.17, 0.74), (-0.07, 0.33), (0.08, 0.27),
             (0.36, 0.12), (0.63, 0.06), (0.69, 0.0), (0.62, -0.06), (0.28, -0.1), (0.56, -0.22), (0.42, -0.31),
             (0.06, -0.38), (-0.06, -0.62)]  # a wolf's head in profile, facing +x: ear up, long snout, jaws open


def wolf_head(name, material, loc, size, yaw=0.0, mirror=False):
    """A flat wolf-head silhouette (for shadows on walls and the vision in the orb), standing upright."""
    pts = [((-x if mirror else x) * size, 0.0, z * size) for x, z in WOLF_HEAD]
    me = bpy.data.meshes.new(name)
    me.from_pydata(pts, [], [list(range(len(pts)))])
    me.materials.append(material)
    o = bpy.data.objects.new(name, me)
    o.location = loc
    o.rotation_euler = (0, 0, yaw)
    Ctx.coll.objects.link(o)
    return o


def beam_material(name, color, alpha=0.07):
    """A see-through glow for visible light beams."""
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes.get("Principled BSDF"))
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*color, 1)
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.inputs["Fac"].default_value = alpha
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], nt.nodes.get("Material Output").inputs["Surface"])
    common.try_set(m, "surface_render_method", "BLENDED")
    m["outline"] = False
    return m


def only_for(o, cam_name):
    """Show an object only in one camera's shot (e.g. the wolf in the orb, in the reveal)."""
    o["only_cam"] = cam_name
    return o


# ---------------------------------------------------------------- the contestants' lineup

def lineup(M):
    sc = begin_scene("Intro_Lineup", seed=101)
    void_world("IntroLineupVoid", (0.01, 0.01, 0.018))
    add(bpy.ops.mesh.primitive_cylinder_add, "StageDisc", M["stage_floor"], loc=(0, 1.5, -0.05), vertices=48, radius=9, depth=0.1)
    n = max(MODELS) if MODELS else 6  # Game 1 had six, Game 2 seven (2026-10-22)
    span = 8.0 if n <= 6 else 9.0  # names stay inside the title-safe area
    xs = [-span / 2 + span * i / (n - 1) for i in range(n)]  # six: -4.0, -2.4, ... 4.0 as before
    heads = []
    BEAM = beam_material("SpotBeam", (1.0, 0.93, 0.8), 0.035)
    for k in range(7):  # the village behind them, dark against the haze
        hr, _ = kit.house(M, f"BackHouse{k}", (-12 + k * 4.0, 16 + (k % 2) * 2.5, 0), math.pi, w=3.6, d=3.4, h1=2.6, h2=2.6, lit=(k % 3 == 0, False, False), tilt=3.0)
        for o in [hr, *hr.children_recursive]:  # in the close-ups: a black void behind the face
            o["hide_cam"] = ",".join(f"Lineup_{i}" for i in range(1, n + 1))
    for k, x in enumerate(xs):
        p = (x, 2.0 + abs(x) * 0.18, 0.0)  # a slight arc toward the camera
        mark(f"Lineup_{k + 1}", p, look_yaw(p, (0, -6)))
        _, head = stand(M, f"L{k + 1}", p, look_yaw(p, (0, -6)), k + 1, "villager", night=False)
        heads.append((k + 1, head))
        cone = add(bpy.ops.mesh.primitive_cone_add, f"Beam{k + 1}", BEAM, loc=(x, p[1] - 0.3, 3.75), vertices=24, radius1=0.72, radius2=0.05, depth=7.5)
        cone["outline"] = False
        sp = light(f"Spot{k + 1}", "SPOT", 2200, (1.0, 0.93, 0.8), (x, p[1] - 0.6, 7.5), 0.15, spot=22)
        sp.rotation_euler = (Vector(p) + Vector((0, 0, 1.0)) - sp.location).to_track_quat("-Z", "Y").to_euler()
        add(bpy.ops.mesh.primitive_cylinder_add, f"SpotPool{k + 1}", M["spot_beam"], loc=(x, p[1], 0.005), vertices=32, radius=0.95, depth=0.01)
        camera(f"Lineup_{k + 1}", (x * 0.9, p[1] - 3.2, 1.75), (x, p[1], 1.55), lens=45, moment=f"intro: contestant {k + 1} close-up", covers=[f"Lineup_{k + 1}"])
    light("BackRim", "AREA", 220, (0.45, 0.55, 1.0), (0, 5.0, 3.0), 6.0, shadow=False)
    fog_box(size=(30, 12, 9), center=(0, 1, 4), color=(0.18, 0.19, 0.27), ground_density=0.03, falloff=0.3)  # haze only around the stage
    wide = camera("Lineup_Wide", (0, -6.2 if n <= 6 else -6.9, 1.9), (0, 2.4, 1.45), lens=30, moment=f"intro: {n} AIs, side by side")
    for seat, head in heads:  # each contestant's model name above its head (this game's cast, for the previews)
        sign(f"LineupSign{seat}", head, seat, MODELS.get(seat, f"Seat {seat}"), "", " ", "village", wide)
    camera("Lineup_Low", (2.2, -4.5, 0.45), (-1.2, 2.4, 1.6), lens=22, moment="intro: low and heroic along the row")
    outline_all(M, skip=("StageDisc", "SpotPool", "Fog"))
    return sc


# ---------------------------------------------------------------- a team match (Game 3: China vs USA)

def versus(M):
    """The owner's VS staging (2026-10-27): Team China on the left as werewolves (ears, red eyes, claws) under
    red-tinted spotlights, a gap, Team USA on the right in their village bodies, each with the tells of their role (the
    Seer's orb, the Witch's hat, the Hunter's hat and crossbow, the Sheriff's star). Spot{seat} lights and their pools
    and beams snap on with render_intro's spots_on effect (Team China first)."""
    sc = begin_scene("Intro_Versus", seed=103)
    void_world("IntroVersusVoid", (0.01, 0.008, 0.014))
    add(bpy.ops.mesh.primitive_cylinder_add, "StageDisc", M["stage_floor"], loc=(0, 1.5, -0.05), vertices=48, radius=10, depth=0.1)
    china = [st for st in sorted(MODELS) if team_of(MODELS[st]) == "china"]
    usa = [st for st in sorted(MODELS) if team_of(MODELS[st]) == "usa"]
    step, gap = 1.45, 3.1  # the gap between the teams is about two places wide
    width = step * (len(china) - 1) + gap + step * (len(usa) - 1)
    x0 = -width / 2
    places = [(st, x0 + step * k) for k, st in enumerate(china)]
    places += [(st, x0 + step * (len(china) - 1) + gap + step * k) for k, st in enumerate(usa)]
    red_beam, warm_beam = beam_material("SpotBeamRed", (1.0, 0.22, 0.16), 0.05), beam_material("SpotBeam", (1.0, 0.93, 0.8), 0.035)
    red_pool = glow("SpotDiscRed", (1.0, 0.25, 0.18), 0.8)
    for k in range(7):  # the village behind them, dark against the haze
        kit.house(M, f"BackHouse{k}", (-13 + k * 4.3, 16 + (k % 2) * 2.5, 0), math.pi, w=3.6, d=3.4, h1=2.6, h2=2.6, lit=(k % 3 == 0, False, False), tilt=3.0)
    heads = []
    for st, x in places:
        wolf = st in china
        p = (x, 2.0 + abs(x) * 0.12, 0.0)
        info = ROLES.get(st, {})
        role = "werewolf" if wolf else info.get("role", "villager")
        _, head = stand(M, f"V{st}", p, look_yaw(p, (0, -6)), st, role, night=wolf, sheriff=bool(info.get("sheriff")) and not wolf)
        heads.append((st, head))
        cone = add(bpy.ops.mesh.primitive_cone_add, f"Beam{st}", red_beam if wolf else warm_beam, loc=(x, p[1] - 0.3, 3.75), vertices=24, radius1=0.72, radius2=0.05, depth=7.5)
        cone["outline"] = False
        colour = (1.0, 0.3, 0.22) if wolf else (1.0, 0.93, 0.8)
        sp = light(f"Spot{st}", "SPOT", 2600 if wolf else 2200, colour, (x, p[1] - 0.6, 7.5), 0.15, spot=22)
        sp.rotation_euler = (Vector(p) + Vector((0, 0, 1.0)) - sp.location).to_track_quat("-Z", "Y").to_euler()
        add(bpy.ops.mesh.primitive_cylinder_add, f"SpotPool{st}", red_pool if wolf else M["spot_beam"], loc=(x, p[1], 0.005), vertices=32, radius=0.95, depth=0.01)
    light("BackRim", "AREA", 220, (0.45, 0.55, 1.0), (0, 5.0, 3.0), 6.0, shadow=False)
    light("BackRimRed", "AREA", 160, (1.0, 0.2, 0.15), (places[0][1] + step * (len(china) - 1) / 2, 5.0, 3.0), 3.0, shadow=False)
    fog_box(size=(34, 12, 9), center=(0, 1, 4), color=(0.18, 0.17, 0.25), ground_density=0.03, falloff=0.3)
    wide = camera("Versus_Wide", (0, -7.6, 2.0), (0, 2.4, 1.45), lens=28, moment="intro: Team China vs Team USA, both sides")

    def framing(name, xs, moment):
        cx = (min(xs) + max(xs)) / 2
        span = max(xs) - min(xs) + 2.2
        dist = max(5.4, span * 1.05)  # far enough to keep the whole team in, heads to feet (two wolves need room too)
        camera(name, (cx, 2.0 - dist, 1.75), (cx, 2.2, 1.5), lens=32, moment=moment)

    framing("Versus_China", [x for st, x in places if st in china], "intro: Team China, the wolves")
    framing("Versus_USA", [x for st, x in places if st not in china], "intro: Team USA, the village")
    for st, head in heads:  # each model's name above its head
        sign(f"VersusSign{st}", head, st, MODELS.get(st, f"Seat {st}"), "", " ", "village", wide)
    outline_all(M, skip=("StageDisc", "SpotPool", "Fog"))
    return sc


# ---------------------------------------------------------------- the werewolf

def werewolf(M):
    sc = begin_scene("Intro_Werewolf", seed=102)
    hero = camera("Werewolf_Hero", (0.6, -5.2, 0.7), (0.0, 1.0, 2.7), lens=24, moment="intro: the werewolf on the rock, the red moon behind")
    mm = dict(M)
    mm["moon"] = M["blood_moon"]
    moon_dir = moon(hero, frame_xy=(0.18, 0.5), M=mm, radius=17.0, strength=0.25)
    night_sky(moon_dir, top=(0.09, 0.02, 0.025), zenith=(0.012, 0.004, 0.01), halo_strength=0.0, stars=False, halo_min=0.99)
    add(bpy.ops.mesh.primitive_plane_add, "Ground", M["forest_floor"], loc=(0, 0, -0.02), size=400)
    # the outcrop: stacked, jittered stones with a flat top
    for k, (x, y, z, s) in enumerate([(0, 1.0, 0.45, 1.6), (0.3, 1.2, 1.2, 1.15), (-0.2, 1.0, 1.8, 0.85), (0.9, 0.6, 0.35, 0.9), (-1.1, 1.4, 0.4, 1.0)]):
        jitter(add(bpy.ops.mesh.primitive_cylinder_add, f"Outcrop{k}", M["stone"], loc=(x, y, z), vertices=7, radius=s, depth=0.9, rot=(0.06 * k, -0.05 * k, 0.4 * k)), 0.09)
    top = (-0.1, 1.0, 2.25)
    mark("Werewolf", top, look_yaw(top, (0.6, -5.2)))
    stand(M, "Wolf", top, look_yaw(top, (0.6, -5.2)), NEUTRAL, "werewolf", color=M["blood"], night=True, lean=-0.22)  # hunched
    for k in range(70):  # embers drifting up through the scene
        add(bpy.ops.mesh.primitive_ico_sphere_add, f"Ember{k}", M["ember"], loc=(Ctx.rng.uniform(-4, 4), Ctx.rng.uniform(-2.5, 5), Ctx.rng.uniform(0.2, 6)),
            subdivisions=1, radius=Ctx.rng.uniform(0.015, 0.04))
    # three claw marks glowing on the stone's face
    for j in range(3):
        add(bpy.ops.mesh.primitive_cube_add, f"Claw{j}", M["claw"], loc=(0.55 + j * 0.16, -0.62, 0.9 + j * 0.03), rot=(0, math.radians(22), math.radians(-8)), scale=(0.025, 0.02, 0.42))
    for k, (x, y, h) in enumerate([(-4.5, 4.5, 9), (4.2, 5.5, 10), (-7.5, 9.0, 12), (6.8, 10.0, 11), (-2.5, 11.5, 13)]):
        kit.gnarly(M, f"DeadTree{k}", x, y, h, branches=7)
    for k in range(9):
        kit.rock(M, Ctx.rng.uniform(-6, 6), Ctx.rng.uniform(-2, 7), Ctx.rng.uniform(0.25, 0.6), "stone")
    rim = light("RedRim", "SPOT", 3500, (1.0, 0.18, 0.1), (0.0, 6.5, 4.5), 0.3, spot=35)
    rim.rotation_euler = (Vector(top) + Vector((0, 0, 1.0)) - rim.location).to_track_quat("-Z", "Y").to_euler()
    light("UnderGlow", "POINT", 120, (1.0, 0.2, 0.12), (0.4, -0.8, 0.6), 0.5)
    fog_box(size=(60, 60, 8), center=(0, 4, 3), color=(0.55, 0.16, 0.14), ground_density=0.06, falloff=0.3)
    camera("Werewolf_Eyes", (0.75, -1.3, 2.95), (-0.12, 1.0, 4.05), lens=50, moment="intro: the red eyes from below, the moon behind")
    camera("Werewolf_Wide", (3.5, -9.5, 2.0), (0.0, 2.0, 2.6), lens=26, moment="intro: the outcrop, the dead trees, the moon")
    outline_all(M, skip=("Ground", "Fog", "Moon", "Ember"))
    return sc


# ---------------------------------------------------------------- the seer

def seer(M):
    sc = begin_scene("Intro_Seer", seed=103)
    void_world("IntroSeerVoid", (0.005, 0.012, 0.03))
    add(bpy.ops.mesh.primitive_cylinder_add, "Floor", M["stage_floor"], loc=(0, 0, -0.05), vertices=48, radius=7, depth=0.1)
    for r_, w in ((2.2, 0.035), (2.6, 0.02), (3.4, 0.03)):  # a glowing ring of runes on the floor
        add(bpy.ops.mesh.primitive_torus_add, f"RuneRing{r_}", M["rune"], loc=(0, 0.6, 0.01), major_radius=r_, minor_radius=w, major_segments=64, minor_segments=4)
    for k in range(12):
        a = k / 12 * math.tau
        add(bpy.ops.mesh.primitive_cube_add, f"Rune{k}", M["rune"], loc=(math.cos(a) * 3.0, 0.6 + math.sin(a) * 3.0, 0.012), rot=(0, 0, a), scale=(0.12, 0.03, 0.005))
    add(bpy.ops.mesh.primitive_cylinder_add, "Pedestal", M["stone"], loc=(0, 0.3, 0.55), vertices=8, radius=0.32, depth=1.1)
    add(bpy.ops.mesh.primitive_cylinder_add, "PedestalTop", M["stone"], loc=(0, 0.3, 1.12), vertices=8, radius=0.45, depth=0.08)
    blue = add(bpy.ops.mesh.primitive_ico_sphere_add, "BigOrb", M["orb_big"], loc=(0, 0.3, 1.5), subdivisions=3, radius=0.36, smooth=True)
    blue["hide_cam"] = "Seer_Reveal"
    only_for(add(bpy.ops.mesh.primitive_ico_sphere_add, "BigOrbRed", orb_glass("OrbGlassRed", (1.0, 0.12, 0.08)), loc=(0, 0.3, 1.5),
                 subdivisions=3, radius=0.36, smooth=True), "Seer_Reveal")  # "Wolf...!": the whole orb flashes red
    light("OrbLight", "POINT", 260, (0.35, 0.7, 1.0), (0, 0.15, 1.6), 0.36)
    add(bpy.ops.mesh.primitive_cylinder_add, "Dais", M["stone"], loc=(0, 1.3, 0.2), vertices=10, radius=0.75, depth=0.4)
    p = (0, 1.3, 0.4)  # on a dais behind the orb: the face shows over it
    mark("Seer", p, look_yaw(p, (0, -5)))
    stand(M, "Seer", p, look_yaw(p, (0, -5)), NEUTRAL, "seer", color=M["rune"], night=True)
    only_for(wolf_head("OrbVision", M["wall_shadow"], (-0.05, -0.075, 1.56), 0.19, yaw=0.0), "Seer_Reveal")  # a wolf in profile, centred in the red orb
    for k in range(6):  # candles around the ring
        a = math.radians(200 + k * 28)
        x, y = math.cos(a) * 2.0, 0.6 + math.sin(a) * 2.0
        add(bpy.ops.mesh.primitive_cylinder_add, f"Candle{k}", M["shroud"], loc=(x, y, 0.2), vertices=8, radius=0.06, depth=0.4)
        add(bpy.ops.mesh.primitive_cone_add, f"CandleFlame{k}", M["candle"], loc=(x, y, 0.47), vertices=6, radius1=0.04, depth=0.12)
        light(f"CandleLight{k}", "POINT", 18, (1.0, 0.7, 0.35), (x, y, 0.6), 0.1, cutoff=3.0)
    for k in range(140):  # a sky of tiny stars in the void
        a, d = Ctx.rng.uniform(0, math.tau), Ctx.rng.uniform(6, 14)
        add(bpy.ops.mesh.primitive_ico_sphere_add, f"StarDot{k}", M["star_dot"], loc=(math.cos(a) * d, 4 + abs(math.sin(a)) * d, Ctx.rng.uniform(0.5, 9)), subdivisions=1, radius=Ctx.rng.uniform(0.015, 0.045))
    rim = light("BlueRim", "SPOT", 1500, (0.4, 0.65, 1.0), (0.0, 4.5, 4.0), 0.3, spot=40)
    rim.rotation_euler = (Vector(p) + Vector((0, 0, 1.2)) - rim.location).to_track_quat("-Z", "Y").to_euler()
    fog_box(size=(30, 30, 8), center=(0, 2, 3), color=(0.25, 0.4, 0.7), ground_density=0.03, falloff=0.4)
    camera("Seer_Hero", (0.7, -3.3, 2.15), (0.0, 1.0, 1.75), lens=30, moment="intro: the seer behind the orb")
    camera("Seer_Reveal", (0.3, -1.75, 1.95), (0.0, 0.5, 1.72), lens=40, moment="intro: a wolf flashes red in the orb, the seer beyond")
    camera("Seer_Wide", (-2.5, -7.5, 4.2), (0.0, 0.8, 0.8), lens=26, moment="intro: the rune circle from above")
    outline_all(M, skip=("Floor", "Fog", "StarDot", "RuneRing", "Rune", "OrbVision"))
    return sc


# ---------------------------------------------------------------- the witch

def witch(M):
    sc = begin_scene("Intro_Witch", seed=104)
    void_world("IntroWitchVoid", (0.01, 0.006, 0.014))
    W, D, H = 7.0, 5.0, 3.4
    add(bpy.ops.mesh.primitive_cube_add, "Floor", M["floorboards"], loc=(0, 0, -0.05), scale=(W / 2, D / 2, 0.05))
    add(bpy.ops.mesh.primitive_cube_add, "BackWall", M["plaster_in"], loc=(0, D / 2, H / 2), scale=(W / 2, 0.1, H / 2))
    add(bpy.ops.mesh.primitive_cube_add, "LeftWall", M["plaster_in"], loc=(-W / 2, 0, H / 2), scale=(0.1, D / 2, H / 2))
    for x in (-2.4, 0.0, 2.4):
        add(bpy.ops.mesh.primitive_cube_add, "WallPost", M["beam"], loc=(x, D / 2 - 0.12, H / 2), scale=(0.1, 0.05, H / 2))
    # shelves crowded with potions along the back wall
    for z in (1.1, 1.7, 2.3):
        add(bpy.ops.mesh.primitive_cube_add, "Shelf", M["dark_wood"], loc=(0, D / 2 - 0.3, z), scale=(2.9, 0.22, 0.04))
        for k in range(16):
            x = -2.7 + k * 0.36 + Ctx.rng.uniform(-0.05, 0.05)
            mat = Ctx.rng.choice(["shelf_green", "shelf_green", "shelf_purple", "shelf_purple", "shelf_blue", "stone", "book"])
            h = Ctx.rng.uniform(0.16, 0.32)
            add(bpy.ops.mesh.primitive_cylinder_add, "Bottle", M[mat], loc=(x, D / 2 - 0.3, z + 0.04 + h / 2), vertices=8, radius=Ctx.rng.uniform(0.05, 0.09), depth=h)
    add(bpy.ops.mesh.primitive_uv_sphere_add, "ShelfSkull", M["bone"], loc=(1.6, D / 2 - 0.3, 2.42), segments=10, ring_count=8, radius=0.13, scale=(1, 1.15, 0.9))
    for k in range(9):  # bundles of herbs hanging from a beam
        x = -2.8 + k * 0.62
        add(bpy.ops.mesh.primitive_cone_add, f"Herb{k}", M["herb"], loc=(x, 0.9, H - 0.45), rot=(math.radians(180), 0, 0), vertices=6, radius1=0.12, depth=0.5)
    add(bpy.ops.mesh.primitive_cube_add, "HerbBeam", M["beam"], loc=(0, 0.9, H - 0.15), scale=(W / 2, 0.08, 0.08))
    # the cauldron over a small fire, brewing green
    c = (0.0, -0.2, 0.0)
    add(bpy.ops.mesh.primitive_uv_sphere_add, "CauldronPot", M["cauldron"], loc=(c[0], c[1], 0.62), segments=20, ring_count=12, radius=0.62, scale=(1, 1, 0.85))
    add(bpy.ops.mesh.primitive_torus_add, "CauldronRim", M["cauldron"], loc=(c[0], c[1], 1.05), major_radius=0.55, minor_radius=0.06, major_segments=24, minor_segments=6)
    add(bpy.ops.mesh.primitive_cylinder_add, "Brew", M["brew"], loc=(c[0], c[1], 1.0), vertices=24, radius=0.53, depth=0.03)
    for k in range(9):
        a, d = Ctx.rng.uniform(0, math.tau), Ctx.rng.uniform(0, 0.4)
        add(bpy.ops.mesh.primitive_uv_sphere_add, f"BrewBubble{k}", M["brew_bubble"], loc=(c[0] + math.cos(a) * d, c[1] + math.sin(a) * d, 1.04), segments=8, ring_count=6, radius=Ctx.rng.uniform(0.04, 0.09))
    for k in range(3):
        a = k / 3 * math.tau
        add(bpy.ops.mesh.primitive_cylinder_add, f"CauldronLeg{k}", M["cauldron"], loc=(c[0] + math.cos(a) * 0.4, c[1] + math.sin(a) * 0.4, 0.15), vertices=6, radius=0.05, depth=0.3)
    kit.fire(M, center=(c[0], c[1], 0.0), size=0.4)
    light("BrewLight", "POINT", 420, (0.35, 1.0, 0.3), (c[0], c[1], 1.6), 0.4)
    light("PoisonGlow", "POINT", 160, (0.75, 0.25, 1.0), (-2.2, D / 2 - 0.8, 1.9), 0.6)
    p = (0.0, 0.85, 0)
    mark("Witch", p, look_yaw(p, (0, -5)))
    stand(M, "Witch", p, look_yaw(p, (0, -5)), NEUTRAL, "witch", color=M["potion_poison"], night=True)
    rim = light("PurpleRim", "SPOT", 1400, (0.75, 0.3, 1.0), (0.0, 3.6, 3.2), 0.3, spot=35)
    rim.rotation_euler = (Vector(p) + Vector((0, 0, 1.3)) - rim.location).to_track_quat("-Z", "Y").to_euler()
    for side, mat in ((-1, "potion_heal"), (1, "poison_dark")):  # the two potions: one saves, one kills
        x, y, z = 0.62 * side, 0.1, 1.42
        add(bpy.ops.mesh.primitive_uv_sphere_add, f"HeroVial{side}", M[mat], loc=(x, y, z), segments=14, ring_count=10, radius=0.2)
        add(bpy.ops.mesh.primitive_cylinder_add, f"HeroNeck{side}", M["neck_green" if side < 0 else "neck_purple"], loc=(x, y, z + 0.26), vertices=8, radius=0.065, depth=0.16)
        add(bpy.ops.mesh.primitive_uv_sphere_add, f"HeroShine{side}", M["highlight"], loc=(x - 0.07, y - 0.16, z + 0.08), segments=8, ring_count=6, radius=0.03)
        for j in range(7):  # sparkles over the healing potion, purple fumes over the poison
            add(bpy.ops.mesh.primitive_ico_sphere_add, f"HeroSpark{side}{j}", M["sparkle" if side < 0 else "fume"],
                loc=(x + Ctx.rng.uniform(-0.12, 0.12), y + Ctx.rng.uniform(-0.1, 0.1), z + 0.42 + j * 0.07), subdivisions=1,
                radius=Ctx.rng.uniform(0.012, 0.025) if side < 0 else Ctx.rng.uniform(0.03, 0.06))
        add(bpy.ops.mesh.primitive_cylinder_add, f"HeroCork{side}", M["wood"], loc=(x, y, z + 0.37), vertices=8, radius=0.075, depth=0.08)
        light(f"VialGlow{side}", "POINT", 40, (0.35, 1.0, 0.45) if side < 0 else (0.75, 0.25, 1.0), (x, y - 0.2, z), 0.1, cutoff=2.5)
    # a white bone skull on the poison: cranium, jaw, teeth, dark sockets
    sx, sy, sz = 0.62, -0.115, 1.45
    add(bpy.ops.mesh.primitive_uv_sphere_add, "VialSkull", M["bone"], loc=(sx, sy, sz + 0.02), segments=12, ring_count=8, radius=0.085, scale=(1, 0.55, 0.9))
    add(bpy.ops.mesh.primitive_cube_add, "VialSkullJaw", M["bone"], loc=(sx, sy - 0.01, sz - 0.065), scale=(0.05, 0.03, 0.025))
    for t in range(4):
        add(bpy.ops.mesh.primitive_cube_add, "VialSkullTooth", M["face"], loc=(sx - 0.03 + t * 0.02, sy - 0.045, sz - 0.05), scale=(0.003, 0.004, 0.012))
    for e in (-1, 1):
        add(bpy.ops.mesh.primitive_uv_sphere_add, "VialSkullEye", M["face"], loc=(sx + e * 0.032, sy - 0.04, sz + 0.03), segments=6, ring_count=4, radius=0.022, scale=(1, 0.5, 0.85))
    add(bpy.ops.mesh.primitive_cone_add, "VialSkullNose", M["face"], loc=(sx, sy - 0.045, sz - 0.015), rot=(math.radians(180), 0, 0), vertices=3, radius1=0.012, depth=0.022)
    fog_box(size=(10, 8, 4), center=(0, 0, 1.8), color=(0.3, 0.55, 0.3), ground_density=0.012, falloff=0.5)
    camera("Witch_Hero", (0.4, -3.4, 1.35), (0.0, 0.6, 1.6), lens=30, moment="intro: the witch over her cauldron")
    camera("Witch_Save", (-0.85, -1.25, 1.62), (-0.62, 0.1, 1.6), lens=40, moment="intro: the whole green flask: one saves")
    camera("Witch_Kill", (0.95, -1.25, 1.62), (0.62, 0.1, 1.6), lens=40, moment="intro: the purple flask with a skull: one kills")
    outline_all(M, skip=("Floor", "Fog", "Brew"))
    return sc


# ---------------------------------------------------------------- the villager

def villager(M):
    sc = begin_scene("Intro_Villager", seed=105)
    hero = camera("Villager_Hero", (1.6, -4.2, 1.3), (0.0, 1.2, 1.4), lens=30, moment="intro: the villager at the cottage door")
    moon_dir = moon(hero, frame_xy=(-0.6, 0.55), M=M, radius=5.0, strength=0.35)
    night_sky(moon_dir, top=(0.035, 0.07, 0.11), zenith=(0.006, 0.014, 0.03), halo_strength=0.2, stars=True, halo_min=0.97)
    add(bpy.ops.mesh.primitive_plane_add, "Ground", M["grass"], loc=(0, 0, -0.02), size=400)
    kit.house(M, "Cottage", (0.0, 3.8, 0), math.pi, w=4.4, d=4.0, h1=2.8, h2=2.4, roof="roof_red", lit=(True, True, True), tilt=2.5)
    p = (0.8, 1.6, 0)  # off the round top of the door, which read as an ear behind her hood
    mark("Villager", p, look_yaw(p, (1.6, -4.2)))
    root, _ = stand(M, "Villager", p, look_yaw(p, (1.6, -4.2)), NEUTRAL, "villager", color=M["amber"], night=False)
    hand = root.matrix_world @ Vector((0.42, 0.3, 0.55))  # a lantern held out in the right hand
    add(bpy.ops.mesh.primitive_cube_add, "HandLantern", M["lantern_hot"], loc=tuple(hand), scale=(0.08, 0.08, 0.11))
    add(bpy.ops.mesh.primitive_cone_add, "HandLanternTop", M["dark_wood"], loc=(hand.x, hand.y, hand.z + 0.15), vertices=4, radius1=0.12, depth=0.08)
    light("HandLanternLight", "POINT", 90, (1.0, 0.7, 0.3), tuple(hand), 0.1, cutoff=6.0)
    # something with a wolf's head is behind them: its shadow, huge, on a patch of wall lit by a warm light
    wolf_head("WallWolf", M["wall_shadow"], (-1.45, 1.74, 1.45), 1.9, yaw=0.0)  # in profile, snout toward her, clear of the round window
    wash = light("WallWash", "SPOT", 900, (1.0, 0.72, 0.4), (-0.6, -1.5, 1.2), 0.2, spot=55)
    wash.rotation_euler = (Vector((-1.15, 1.8, 1.55)) - wash.location).to_track_quat("-Z", "Y").to_euler()
    # a pitchfork leaning by the door
    pf = (-1.0, 1.75)
    add(bpy.ops.mesh.primitive_cylinder_add, "ForkHandle", M["wood"], loc=(pf[0], pf[1], 0.95), rot=(math.radians(-8), 0, 0), vertices=6, radius=0.03, depth=1.9)
    for j in (-1, 0, 1):
        add(bpy.ops.mesh.primitive_cylinder_add, "ForkTine", M["metal"], loc=(pf[0] + j * 0.07, pf[1] + 0.13, 2.02), rot=(math.radians(-8), 0, 0), vertices=5, radius=0.012, depth=0.32)
    add(bpy.ops.mesh.primitive_cube_add, "ForkBar", M["metal"], loc=(pf[0], pf[1] + 0.12, 1.86), scale=(0.1, 0.015, 0.015))
    kit.hay_cart(M, (-3.2, 1.0, 0), math.radians(20))
    kit.barrel(M, 2.2, 1.9)
    kit.barrel(M, 2.6, 2.5)
    kit.fence(M, (-5.5, -1.0), (-2.5, -0.2))
    kit.lantern_post(M, 1.6, 1.0, 0.0, energy=260)
    for k in range(6):
        kit.blob_tree(M, f"Tree{k}", Ctx.rng.uniform(-12, 12), Ctx.rng.uniform(9, 18), Ctx.rng.uniform(7, 11))
    fog_box(size=(60, 60, 8), center=(0, 6, 3), color=(0.25, 0.32, 0.5), ground_density=0.035, falloff=0.3)
    camera("Villager_Wide", (-4.5, -7.5, 2.4), (0.0, 2.2, 1.5), lens=26, moment="intro: the cottage at night, a wolf's shadow on the wall")
    outline_all(M, skip=("Ground", "Fog", "Moon", "WallWolf"))
    return sc


STAGES = [lineup, versus, werewolf, seer, witch, villager]


def glow_finish(path):
    """A soft glow around everything bright (eyes, orb, potions, moon) and a vignette, as the video will have."""
    import numpy as np
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    rgb = px[..., :3].copy()
    bright = np.clip(rgb - 0.62, 0, None)
    r = max(4, w // 90)
    for _ in range(3):
        k = 2 * r + 1
        c = np.cumsum(np.pad(bright, ((r + 1, r), (0, 0), (0, 0)), mode="edge"), axis=0)
        bright = (c[k:] - c[:-k]) / k
        c = np.cumsum(np.pad(bright, ((0, 0), (r + 1, r), (0, 0)), mode="edge"), axis=1)
        bright = (c[:, k:] - c[:, :-k]) / k
    rgb = rgb + bright * 1.4
    yy, xx = np.mgrid[0:h, 0:w]
    r2 = ((xx / w - 0.5) * 2) ** 2 * 0.8 + ((yy / h - 0.5) * 2) ** 2
    rgb *= (1 - 0.4 * np.clip(r2, 0, 1.6) ** 1.6)[..., None]
    px[..., :3] = np.clip(rgb, 0, 1)
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def render_previews(scenes):
    os.makedirs(PREV, exist_ok=True)
    for sc in scenes:
        if bpy.context.window is not None:
            bpy.context.window.scene = sc
        for cam in [o for o in sc.objects if o.type == "CAMERA"]:
            for o in sc.objects:  # objects meant for one shot only
                if o.get("only_cam"):
                    o.hide_render = o["only_cam"] != cam.name[4:]
                if o.get("hide_cam"):
                    o.hide_render = cam.name[4:] in o["hide_cam"].split(",")
            sc.camera = cam
            sc.render.resolution_percentage = 50
            out = os.path.join(PREV, f"{sc.name}_{cam.name[4:]}.png")
            sc.render.filepath = out
            bpy.ops.render.render(write_still=True, scene=sc.name)
            glow_finish(out)
            print(f"[intro] preview {sc.name}/{cam.name[4:]}")
        sc.render.resolution_percentage = 100


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    only = args[args.index("--only") + 1].split(",") if "--only" in args else None
    if "--game" in args:  # the lineup signs carry this game's model names, and the figures its models' colours
        import colors
        colors.use_game(args[args.index("--game") + 1])
        import json
        ep = json.load(open(os.path.join(os.path.dirname(HERE), "games", args[args.index("--game") + 1], "episode.json"), encoding="utf-8"))
        MODELS.update({x["seat"]: x["model_short"] for x in ep["seats"]})
        # the roles as dealt (for the Versus stage), and who held the Sheriff's badge
        sheriffs = {c["seat"] for b in ep["beats"] for c in (b.get("shot") or {}).get("cast", []) if c.get("sheriff")}
        ROLES.update({x["seat"]: {"role": x["role"], "sheriff": x["seat"] in sheriffs} for x in ep["seats"]})
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    M = stage_mats(common.materials())
    built = []
    for fn in STAGES:
        name = "Intro_" + fn.__name__.capitalize()
        if only and name not in only:
            continue
        if fn is versus and len({team_of(m) for m in MODELS.values()}) < 2:
            continue  # a team match needs both sides (Game 3 on)
        built.append(fn(M))
        print(f"[intro] built {name}: {len(built[-1].objects)} objects")
    default = bpy.data.scenes.get("Scene")
    if default is not None and default not in built and len(bpy.data.scenes) > 1:
        bpy.data.scenes.remove(default)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "intro.blend"))
    if "--no-render" not in args:
        render_previews(built)
    print("[intro] done")
