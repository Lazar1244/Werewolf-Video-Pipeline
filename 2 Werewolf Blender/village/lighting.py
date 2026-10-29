"""Lighting presets: switch a built location between night, dawn and day in place.

    apply_preset(scene, "night" | "dawn" | "day")

It works the same headless (the director, before each shot) and in the owner's open Blender (through the MCP bridge).
Night is how a location is built. The night values are remembered on the objects the first time a preset is applied,
so switching back is exact. Objects are found by their build names: Moonlight / MoonIn / Moonbeam (the sky light),
Fire, LanternLight, CandleLight, Moon, Flame*, Embers, Fog, and the Window / Lantern / NightWindow materials.
"""
import math

import bpy
from mathutils import Vector

PRESETS = {
    # ambient = the shadow colour; sky = (horizon, zenith); sun = (colour, strength, elevation°, azimuth°, angle°)
    "night": {},
    "dawn": {
        "ambient": (0.14, 0.11, 0.17),
        "sky": ((0.62, 0.42, 0.45), (0.10, 0.14, 0.24)),
        "sun": ((1.0, 0.72, 0.62), 1.1, 7.0, 25.0, 4.0),
        "fire": 0.25, "lanterns": 0.35, "candle": 0.6, "windows": "dawn", "sky_light": 0.4,
        "fog": ((0.62, 0.50, 0.56), 1.2), "moon": True, "flames": True,
    },
    "dusk": {
        "ambient": (0.03, 0.02, 0.05),
        # a hot band on the horizon behind the gallows; the sun sits straight behind it as seen from Cam_Square_Gallows
        "sky": [(0.0, (1.0, 0.58, 0.2)), (0.13, (0.85, 0.25, 0.1)), (0.38, (0.12, 0.06, 0.18))],
        "sun": ((1.0, 0.42, 0.25), 1.5, 6.0, 174.0, 3.0), "glow": 0.25, "sky_light": 0.08,
        "fire": 0.0, "lanterns": 0.0, "candle": 0.8, "windows": "dawn",
        "fog": ((0.55, 0.30, 0.28), 1.0), "moon": False, "flames": True, "rim": 1.4,
    },
    "day": {
        "ambient": (0.15, 0.16, 0.20),
        "sky": ((0.50, 0.53, 0.54), (0.27, 0.32, 0.38)),
        "sun": ((1.0, 0.93, 0.82), 2.5, 34.0, 140.0, 8.0),
        "fire": 0.0, "embers": 0.12, "lanterns": 0.0, "candle": 0.0, "windows": "day", "sky_light": 0.6,
        "fog": ((0.62, 0.65, 0.66), 0.55), "moon": False, "flames": False,
    },
}
SKY_LIGHTS = ("Moonlight", "MoonIn", "Moonbeam")


def _mat(name, color, strength=1.0, emissive=True):
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


def _variants():
    return {
        "dawn": {"Window": _mat("WindowDawn", (0.85, 0.66, 0.30), 1.0), "Lantern": _mat("LanternDawn", (0.75, 0.6, 0.35), 0.8),
                 "NightWindow": _mat("DawnWindowGlass", (0.75, 0.55, 0.55), 1.0)},
        "dusk": {"Window": _mat("WindowDawn", (0.85, 0.66, 0.30), 1.0), "Lantern": _mat("LanternDawn", (0.75, 0.6, 0.35), 0.8),
                 "NightWindow": _mat("DuskWindowGlass", (0.8, 0.4, 0.3), 1.0)},
        "day": {"Window": _mat("WindowDay", (0.10, 0.11, 0.14), 1.0), "Lantern": _mat("LanternDay", (0.22, 0.2, 0.16), 1.0),
                "NightWindow": _mat("DayWindowGlass", (0.75, 0.8, 0.85), 1.2), "Ember": _mat("EmberDayGlow", (0.55, 0.05, 0.015), 1.4)},  # a fire that just burned out: dim red embers (owner, 2026-10-15)
    }


def _sky_world(sc, preset, p):
    name = f"{preset.capitalize()}_{sc.name}"
    w = bpy.data.worlds.get(name)
    if w is not None:
        return w
    w = bpy.data.worlds.new(name)
    w.use_nodes = True
    wn = w.node_tree
    tc = wn.nodes.new("ShaderNodeTexCoord")
    sep = wn.nodes.new("ShaderNodeSeparateXYZ")
    wn.links.new(tc.outputs["Generated"], sep.inputs[0])
    grad = wn.nodes.new("ShaderNodeValToRGB")
    stops = p["sky"] if isinstance(p["sky"], list) else [(0.0, p["sky"][0]), (0.5, p["sky"][1])]
    for i, (pos, col) in enumerate(stops):
        e = grad.color_ramp.elements[i] if i < 2 else grad.color_ramp.elements.new(pos)
        e.position, e.color = pos, (*col, 1)
    wn.links.new(sep.outputs["Z"], grad.inputs["Fac"])
    out = grad.outputs["Color"]
    col, strength, el, az, ang = p["sun"]
    if el < 12:  # a low sun glows in the sky around it
        d = Vector((math.cos(math.radians(az)) * math.cos(math.radians(el)), math.sin(math.radians(az)) * math.cos(math.radians(el)), math.sin(math.radians(el))))
        dot = wn.nodes.new("ShaderNodeVectorMath")
        dot.operation = "DOT_PRODUCT"
        dot.inputs[1].default_value = tuple(d)
        wn.links.new(tc.outputs["Generated"], dot.inputs[0])
        halo = wn.nodes.new("ShaderNodeMapRange")
        halo.inputs["From Min"].default_value = 0.93
        halo.inputs["To Max"].default_value = 0.8
        wn.links.new(dot.outputs["Value"], halo.inputs["Value"])
        tint = wn.nodes.new("ShaderNodeVectorMath")
        tint.operation = "SCALE"
        tint.inputs[0].default_value = col
        wn.links.new(halo.outputs["Result"], tint.inputs["Scale"])
        addn = wn.nodes.new("ShaderNodeVectorMath")
        addn.operation = "ADD"
        wn.links.new(out, addn.inputs[0])
        wn.links.new(tint.outputs[0], addn.inputs[1])
        out = addn.outputs[0]
    wn.links.new(out, wn.nodes.get("Background").inputs["Color"])
    lp = wn.nodes.new("ShaderNodeLightPath")
    mix = wn.nodes.new("ShaderNodeMath")
    mix.operation = "MULTIPLY_ADD"  # is_camera * (1 - k) + k
    k = p.get("sky_light", 1.0)
    mix.inputs[1].default_value = 1.0 - k
    mix.inputs[2].default_value = k
    wn.links.new(lp.outputs["Is Camera Ray"], mix.inputs[0])
    wn.links.new(mix.outputs[0], wn.nodes.get("Background").inputs["Strength"])
    return w


def _remember(o, key, value):
    if key not in o:
        o[key] = value
    return o[key]


def apply_preset(sc, preset):
    if isinstance(sc, str):
        sc = bpy.data.scenes[sc]
    p = PRESETS[preset]
    night = preset == "night"
    var = {} if night else _variants()[preset]
    sc["ww_preset"] = preset
    sc["ww_ambient"] = (0.05, 0.05, 0.10) if night else p["ambient"]
    sc["ww_seat_glow"] = 0.75 if night else p.get("glow", 0.75)
    sc.world = bpy.data.worlds[sc["night_world"]] if night else _sky_world(sc, preset, p)
    for o in sc.objects:
        base = o.name.split(".")[0]
        if o.type == "LIGHT":
            e0 = _remember(o, "night_energy", o.data.energy)
            c0 = _remember(o, "night_color", list(o.data.color))
            r0 = _remember(o, "night_rot", list(o.rotation_euler))
            if night:
                o.data.energy, o.data.color, o.rotation_euler = e0, c0, r0
                if o.data.type == "SUN":
                    o.data.angle = math.radians(2)
            elif base in SKY_LIGHTS:
                col, strength, el, az, ang = p["sun"]
                o.data.color = col
                if o.data.type == "SUN":
                    o.data.energy = strength
                    o.data.angle = math.radians(ang)
                    d = Vector((math.cos(math.radians(az)) * math.cos(math.radians(el)), math.sin(math.radians(az)) * math.cos(math.radians(el)), math.sin(math.radians(el))))
                    o.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
                else:  # a spot through a window or the trees: same colour, scaled
                    o.data.energy = e0 * (2.5 if preset == "day" else 1.2)
            elif base in ("Fire", "FireFill"):
                # by day the key fire is out, but the embers still give a weak red light at the base (FireFill, "embers")
                o.data.energy = e0 * (p.get("embers", p["fire"]) if base == "FireFill" else p["fire"])
                o.data.color = (1.0, 0.25, 0.08) if base == "FireFill" and "embers" in p else c0
            elif base == "GallowsRim":
                o.data.energy = e0 * p.get("rim", 0.0 if preset == "day" else 0.8)
            elif base.startswith(("LanternLight", "WindowGlow", "DoorLight")):
                o.data.energy = e0 * p["lanterns"]
            elif base.startswith("CandleLight") or base.startswith("OrbGlow"):
                o.data.energy = e0 * p["candle"]
            continue
        if base == "Moon":
            o.hide_render = o.hide_viewport = not (night or p["moon"])
        elif base.startswith(("Flame", "Spark")) or base == "CandleFlame":
            o.hide_render = o.hide_viewport = not (night or p["flames"])
        if o.type == "MESH" and o.material_slots:
            # snapshot what each slot actually shows (object-linked overrides included: seat colours, door tokens)
            names = _remember(o, "night_mats", [sl.material.name if sl.material else "" for sl in o.material_slots])
            for i, n in enumerate(names):
                if not n or i >= len(o.material_slots):
                    continue
                target = bpy.data.materials.get(n) if night else var.get(n, bpy.data.materials.get(n))
                if o.material_slots[i].material is not target:
                    o.material_slots[i].material = target
    fog = bpy.data.materials.get(f"Fog_{sc.name}")
    if fog is not None:
        vol = next(n for n in fog.node_tree.nodes if n.type == "PRINCIPLED_VOLUME")
        mr = fog.node_tree.nodes.get("FogHeight") or next(n for n in fog.node_tree.nodes if n.type == "MAP_RANGE")
        c0 = _remember(fog, "night_color", list(vol.inputs["Color"].default_value))
        d0 = _remember(fog, "night_density", mr.inputs["To Min"].default_value)
        if night:
            vol.inputs["Color"].default_value, mr.inputs["To Min"].default_value = c0, d0
        else:
            vol.inputs["Color"].default_value = (*p["fog"][0], 1)
            mr.inputs["To Min"].default_value = d0 * p["fog"][1]
    return sc
