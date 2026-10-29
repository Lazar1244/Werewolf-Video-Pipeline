"""Life for the scenes: procedural motion with drivers, no keyframes.

Every motion is a sum of sines with a whole number of cycles per loop of L frames, so any stretch of L frames
loops seamlessly. Figures move "on twos" (their formulas read floor(frame/2)*2, the stylized hand-animated feel);
fire, wind and camera drift move on ones. Drivers only use Blender's simple expressions (no Python is executed).

    figure_motion(root, mode, L, look_yaw=0.0)   mode: idle | talk | think | sleep
    world_motion(scene, L)                         fire, sparks, flicker, wind (trees, rope), fog/star clock
    camera_drift(cam, L)                           a slow hand-held breathing of the camera
"""
import math
import random

import bpy

TWOS = "(floor(frame/2)*2)"


def _drive(idb, path, index, expr):
    try:
        idb.driver_remove(path, index)
    except TypeError:
        pass
    fc = idb.driver_add(path, index) if index is not None else idb.driver_add(path)
    fc.driver.type = "SCRIPTED"
    fc.driver.expression = expr
    return fc


def _sin(t, L, n, amp, ph):
    return f"{amp:.4f}*sin({t}*{n * 2 * math.pi / L:.6f}+{ph:.3f})"


def figure_motion(root, mode="idle", L=48, look_yaw=0.0):
    anim = root.get("anim")
    if not anim:
        return
    sc_objs = bpy.data.objects
    r = random.Random(1000 + int(anim["seat"]))
    ph = [r.uniform(0, 6.283) for _ in range(12)]
    S = lambda n, amp, p: _sin(TWOS, L, n, amp, p)
    body = sc_objs.get(anim["body"])
    if body:  # breathing
        _drive(body, "delta_scale", 2, "1+" + S(1, 0.014, ph[0]))
        _drive(body, "delta_scale", 0, "1-" + S(1, 0.006, ph[0]))
        _drive(body, "delta_scale", 1, "1-" + S(1, 0.006, ph[0]))
    head = sc_objs.get(anim["head"])
    if head:
        look = max(-0.55, min(0.55, look_yaw)) * 0.65
        if mode == "talk":
            rx = f"-0.05+{S(4, 0.075, ph[1])}+{S(7, 0.03, ph[4])}"
            ry = S(2, 0.05, ph[2])
            rz = f"{look:.3f}+{S(1, 0.06, ph[3])}"
        elif mode == "think":
            rx = f"0.13+{S(1, 0.015, ph[1])}"
            ry = S(1, 0.03, ph[2])
            rz = S(1, 0.02, ph[3])
        elif mode == "sleep":
            rx, ry, rz = S(1, 0.012, ph[1]), "0", "0"
        else:
            rx = S(1, 0.03, ph[1])
            ry = S(1, 0.02, ph[2])
            rz = f"{look:.3f}+{S(1, 0.035, ph[3])}"
        for i, e in enumerate((rx, ry, rz)):
            _drive(head, "delta_rotation_euler", i, e)
        _drive(head, "delta_location", 2, S(1, 0.01, ph[0]))
    hat = sc_objs.get(anim.get("hat", ""))
    if hat:  # follow-through: the same rhythm as the head, a little later and a little further
        if mode == "talk":
            _drive(hat, "delta_rotation_euler", 0, f"{S(4, 0.07, ph[1] - 0.9)}+{S(7, 0.03, ph[4] - 0.9)}")
            _drive(hat, "delta_rotation_euler", 1, S(2, 0.06, ph[2] - 0.7))
        else:
            _drive(hat, "delta_rotation_euler", 0, S(1, 0.03, ph[1] - 0.8))
            _drive(hat, "delta_rotation_euler", 1, S(1, 0.025, ph[2] - 0.8))
    feather = sc_objs.get(anim.get("feather", ""))
    if feather:
        _drive(feather, "delta_rotation_euler", 1, f"{S(2, 0.2, ph[5])}+{S(4 if mode == 'talk' else 3, 0.08, ph[6])}")
    for i, en in enumerate(anim.get("ears", [])):
        ear = sc_objs.get(en)
        if ear:  # an occasional twitch
            _drive(ear, "delta_rotation_euler", 0, f"0.4*max(0,sin({TWOS}*{2 * math.pi / L:.6f}+{ph[7] + i * 1.7:.3f}))**12")
    star = sc_objs.get(anim.get("star", ""))
    if star:
        _drive(star, "delta_rotation_euler", 1, S(1, 0.35, ph[8]))
    for i, pn in enumerate(anim.get("potions", [])):
        p = sc_objs.get(pn)
        if p:
            _drive(p, "delta_location", 2, S(2, 0.018, ph[9] + i * 2.1))
    orb = sc_objs.get(anim.get("orb", ""))
    if orb:
        _drive(orb, "delta_location", 2, S(1, 0.035, ph[10]))
        for i in range(3):
            _drive(orb, "delta_scale", i, "1+" + S(2, 0.07, 0.0))
    for hn in anim.get("hands", []):
        h = sc_objs.get(hn)
        if h:
            if mode == "talk":
                _drive(h, "delta_location", 2, f"0.035*max(0,sin({TWOS}*{4 * math.pi / L:.6f}+{ph[11]:.3f}))")
            else:
                _drive(h, "delta_location", 2, S(1, 0.006, ph[0]))
    scarf = sc_objs.get(anim.get("scarf", ""))
    if scarf:
        _drive(scarf, "delta_rotation_euler", 2, S(1, 0.05, ph[3] + 0.5))
    off = int(r.uniform(0, L - 6))
    for en in anim.get("eyes", []):  # a blink once per loop, at a different moment for each seat
        e = sc_objs.get(en)
        if e:
            _drive(e, "hide_render", None, f"fmod({TWOS}+{off},{L})<4")
            _drive(e, "hide_viewport", None, f"fmod({TWOS}+{off},{L})<4")


def world_motion(sc, L=48):
    """Fire, sparks, flickering lights, wind in the trees and on the gallows rope, and the shader clock."""
    _drive(sc, '["ww_phase"]', None, f"fmod(frame,{L})/{L}")
    r = random.Random(77)
    S = lambda n, amp, p: _sin("frame", L, n, amp, p)
    for o in sc.objects:
        base = o.name.split(".")[0]
        if base.startswith("Flame") and o.type == "MESH":
            n1, n2 = r.choice((2, 3, 4)), r.choice((5, 6))  # owner: slower, calmer fire (1-3 licks a second)
            p1, p2 = r.uniform(0, 6.3), r.uniform(0, 6.3)
            _drive(o, "delta_scale", 2, f"1+{S(n1, 0.15, p1)}+{S(n2, 0.05, p2)}")
            _drive(o, "delta_scale", 0, f"1+{S(n1, 0.07, p2)}")
            _drive(o, "delta_rotation_euler", 2, S(1, 0.22, p2))
        elif base.startswith("Spark"):
            k, p = r.choice((1, 2)), r.uniform(0, 1)
            _drive(o, "delta_location", 2, f"1.3*fmod(frame/{L}*{k}+{p:.3f},1)")
            _drive(o, "delta_location", 0, S(2, 0.12, p * 6.3))
        elif base == "CandleFlame":
            _drive(o, "delta_scale", 2, f"1+{S(2, 0.07, 0.4)}+{S(3, 0.03, 1.9)}")
        elif o.type == "LIGHT":
            e0 = o.data.energy  # the current preset's level: clear_world_motion() + apply_preset() first
            if base == "Fire":  # the strong key light stays almost steady: no flashes over the whole picture
                _drive(o.data, "energy", None, f"{e0:.2f}*(1+{S(1, 0.03, 0.3)})")
            elif base == "FireFill":
                # the wide fill carries the flicker. Close to the fire the key light already saturates the toon ramp,
                # so this only moves the light/shadow edge at the rim of the firelight: flicker at the edges
                _drive(o.data, "energy", None, f"{e0:.2f}*(1+{S(2, 0.3, 0.3)}+{S(3, 0.15, 1.1)})")
                _drive(o, "delta_location", 0, S(1, 0.12, 0.2))
                _drive(o, "delta_location", 1, S(2, 0.08, 1.4))
            elif base.startswith(("LanternLight", "DoorLight", "CandleLight")):
                p = r.uniform(0, 6.3)  # a slow, faint breathing
                _drive(o.data, "energy", None, f"{e0:.2f}*(1+{S(1, 0.05, p)}+{S(2, 0.02, p + 1)})")
        elif base == "RopePivot":
            _drive(o, "delta_rotation_euler", 0, S(1, 0.07, 0.0))
            _drive(o, "delta_rotation_euler", 1, S(1, 0.04, 1.3))
        elif o.get("sway"):  # trees: a slow sway, each with its own timing
            p = (o.location.x * 0.37 + o.location.y * 0.21) % 6.283
            _drive(o, "delta_rotation_euler", 0, S(1, 0.012, p))
            _drive(o, "delta_rotation_euler", 1, S(1, 0.009, p + 1.7))


def camera_drift(cam, L=48, amount=1.0):
    """A slow, seamless hand-held breathing (on delta channels, so a camera move on top still works)."""
    S = lambda n, amp, p: _sin("frame", L, n, amp * amount, p)
    _drive(cam, "delta_location", 0, S(1, 0.035, 0.0))
    _drive(cam, "delta_location", 1, S(1, 0.025, 1.9))
    _drive(cam, "delta_location", 2, S(1, 0.02, 3.1))
    _drive(cam, "delta_rotation_euler", 0, S(1, 0.004, 2.2))
    _drive(cam, "delta_rotation_euler", 2, S(1, 0.004, 0.7))


def clear_world_motion(sc):
    """Remove the world drivers again (e.g. before saving the set file)."""
    for idb in [sc, *sc.objects, *[o.data for o in sc.objects if o.type == "LIGHT"]]:
        ad = idb.animation_data
        if ad:
            for fc in list(ad.drivers):
                idb.driver_remove(fc.data_path, fc.array_index)
