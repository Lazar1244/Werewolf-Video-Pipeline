"""Step 3b (inside Blender): render the clips of plan.json; run several of these in parallel with --part i --parts n.

    blender --background out/village.blend --python director/render_clips.py -- <id8> [--part 0 --parts 2] [--size 1280x720]
            [--only <key,key>] [--outdir <folder under the game>] [--vfit <key=s,...>] [--aim <key,key>] [--preview] [--maps <seat>]

Each clip: place the cast (a "walk" clip keys the walkers along their paths), set the light, give everyone their motion (the speaker talks or thinks, the others
breathe, blink and turn toward the speaker) and a 3D name sign facing the camera, give the world its motion (fire, wind, flicker, fog), set or move the
camera, render the frames. Clips are cached in games/<id8>/clips/<key>/ (with the set file's build time, so a rebuilt
set or edited motion re-renders). meta_<part>.json has each clip's head positions and sign boxes on screen (for the text and the inner-voice light).
--maps <seat> (the inner voice, thought_fx.py): instead of the picture, render a 16-bit DATA MAP of each frame into
<outdir>/<key>_map<seat>/: R = each surface's distance from that seat's FEET / 30 m, G = 0 village, 0.5 another
player or their sign, 1 that seat or its sign (map_materials()). The clip's picture must be rendered already.
For the vertical Short (short_intro.py): --size 1080x1920 --only <its game clips> --outdir short/gclips. Upright, a clip's
vfit sets how much taller than its 16:9 view the frame sees (1 = the same height: the centre of the original framing),
and --aim re-aims the camera at the speaker. --preview renders only frame 0 of each, into <outdir>/preview/<key>.png.
"""
import json
import math
import os
import sys

import bmesh
import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix, Vector

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # this Blender folder ("2 Werewolf Blender")
sys.path.insert(0, os.path.join(BASE, "village"))
import animate  # noqa: E402
import common  # noqa: E402
from figures import figure, seat_mat  # noqa: E402
from lighting import apply_preset  # noqa: E402
from signs import sign  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
gid = args[0]
part = int(args[args.index("--part") + 1]) if "--part" in args else 0
parts = int(args[args.index("--parts") + 1]) if "--parts" in args else 1
W, H = (int(v) for v in (args[args.index("--size") + 1] if "--size" in args else "1280x720").split("x"))
GDIR = os.path.join(BASE, "games", gid)
import colors  # noqa: E402  (village/colors.py: each model keeps its colour, owner 2026-10-27)
colors.use_game(gid)
ONLY = set(args[args.index("--only") + 1].split(",")) if "--only" in args else None
OUTDIR = args[args.index("--outdir") + 1] if "--outdir" in args else "clips"
VFIT = {k: float(v) for k, v in (kv.split("=") for kv in args[args.index("--vfit") + 1].split(","))} if "--vfit" in args else {}
AIM = set(args[args.index("--aim") + 1].split(",")) if "--aim" in args else set()
PREVIEW = "--preview" in args
TEST_FRAMES = {int(x) for x in args[args.index("--frames") + 1].split(",")} if "--frames" in args else None
META_ONLY = "--meta-only" in args  # rendered clips: only their meta again (head, sign and door positions), no rendering
plan = json.load(open(os.path.join(GDIR, "plan.json"), encoding="utf-8"))
L = plan["L"]
# the set file's build time and the motion and figure code's edit times: a change to any re-renders the clips
RENDER_V = 4  # bump when a renderer change alters how clips look (2: lens keys leaked from moves; 3: 3D name signs;
#              4: signs show model + role only, the day campfire glows as dying embers)
BUILD = "-".join(str(int(os.path.getmtime(f))) for f in (bpy.data.filepath, animate.__file__, figure.__code__.co_filename)) + f"-r{RENDER_V}" + colors.signature()
M = common.materials()
WOLVES = {"werewolf", "big_bad_wolf", "accursed_wolf_father", "white_werewolf"}
SOLO = {"white_werewolf", "thief", "wild_child", "wolf_hound", "piper", "angel"}


def clear_cast(sc):
    for o in [o for o in sc.objects if o.get("cast")]:
        bpy.data.objects.remove(o, do_unlink=True)
    for o in sc.objects:
        if o.name.startswith("Door_Token_") and o.material_slots and o.material_slots[0].link == "OBJECT":
            o.material_slots[0].link = "DATA"


def director_cam(sc):
    cam = sc.objects.get("Cam_Director")
    if cam is None:
        cam = bpy.data.objects.new("Cam_Director", bpy.data.cameras.new("Cam_Director"))
        sc.collection.objects.link(cam)
    for idb in (cam, cam.data):  # the lens is keyed on the camera data: a move must not leak into the next clip
        if idb.animation_data:
            idb.animation_data_clear()
    return cam


def resolve(sc, spec):
    """A camera spec -> (location, look-at point, lens)."""
    if "preset" in spec:
        p = sc.objects[f"Cam_{spec['preset']}"]
        fwd = p.matrix_basis.to_3x3() @ Vector((0, 0, -1))
        loc = p.location.copy() + Vector((0, 0, spec.get("dz", 0.0)))
        return loc, p.location + fwd * 12.0, p.data.lens
    return Vector(spec["loc"]), Vector(spec["look"]), spec["lens"]


def place_camera(cam, loc, look, lens):
    cam.location = loc
    cam.rotation_euler = (look - loc).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = lens


def key_move(cam, a, b, frames):
    """Glide from framing a to b round the circle centre (cylindrical), easing in and out; keyed every frame."""
    (la, ta, fa), (lb, tb, fb) = a, b
    ra, rb = la.xy.length, lb.xy.length
    aa, ab = math.atan2(la.y, la.x), math.atan2(lb.y, lb.x)
    d = (ab - aa + math.pi) % (2 * math.pi) - math.pi  # the short way round
    for f in range(frames):
        t = f / max(1, frames - 1)
        e = t * t * (3 - 2 * t)
        ang, rad = aa + d * e, ra + (rb - ra) * e
        loc = Vector((rad * math.cos(ang), rad * math.sin(ang), la.z + (lb.z - la.z) * e)) if ra > 1 else la.lerp(lb, e)
        place_camera(cam, loc, ta.lerp(tb, e), fa + (fb - fa) * e)
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_euler", frame=f)
        cam.data.keyframe_insert("lens", frame=f)


def room_guest(sc):
    """A second seat at the Room's table (its right end, facing along it), for the Lovers' meeting: a stool and a mark,
    added for the clip only (cast objects), so the set file stays as it is."""
    if sc.objects.get("Mark_Guest") is not None:
        return
    st = sc.objects["Stool"].copy()
    sc.collection.objects.link(st)
    st.location = (1.3, 0.75, st.location.z)  # the table's right end, by the bed's head: the camera sees the face 3/4
    mk = bpy.data.objects.new("Mark_Guest", None)
    sc.collection.objects.link(mk)
    mk.location = (1.3, 0.75, 0.0)
    mk["facing_yaw"] = math.atan2(1.0, -0.3)  # toward the table (-x), turned a little to the camera
    for o in (st, mk):
        o["cast"] = True


def walk_keys(root, spec, frames, fps):
    """Key a figure walking its path: it waits (facing its door), turns, then walks with a step bob and a side sway.
    Returns the root's (location, yaw, bob) for every frame, so its sign can follow."""
    pts = [Vector((x, y)) for x, y in spec["path"]]
    pts = [p for k, p in enumerate(pts) if k == 0 or (p - pts[k - 1]).length > 1e-6]  # no zero-length steps
    seg = [(pts[k + 1] - pts[k]).length for k in range(len(pts) - 1)]
    z0, yaw0 = root.location.z, root.rotation_euler.z
    ramp = spec.get("ramp", 0.6)  # s to reach full pace (0: already walking when the shot starts)

    def at(d):
        for k, L in enumerate(seg):
            if d <= L or k == len(seg) - 1:
                return pts[k] + (pts[k + 1] - pts[k]) * (min(d, L) / L)
            d -= L

    out = []
    for f in range(frames):
        t = f / fps - spec["delay"]
        if t <= 0:
            d = 0.0
        elif ramp <= 0:
            d = spec["speed"] * t
        elif t < ramp:
            d = spec["speed"] * t * t / (2 * ramp)
        else:
            d = spec["speed"] * (t - ramp / 2)
        p, ahead = at(d), at(d + 0.9)
        to = ahead - p
        heading = math.atan2(-to.x, to.y) if to.length > 1e-4 else yaw0
        turn = min(1.0, max(0.0, t / 0.5)) if ramp > 0 else 1.0  # already walking: already facing the way
        dy = (heading - yaw0 + math.pi) % (2 * math.pi) - math.pi
        yaw = yaw0 + dy * (turn * turn * (3 - 2 * turn))
        pace = min(1.0, max(0.0, t / ramp)) if ramp > 0 else 1.0
        phase = d / spec.get("stride", 0.7) * math.pi + spec.get("step_phase", 0.0)  # a step every stride (m); own timing
        bob = spec.get("bob", 0.045) * abs(math.sin(phase)) * pace
        root.location = (p.x, p.y, z0 + bob)
        root.rotation_euler.z = yaw
        root.rotation_euler.y = spec.get("sway", 0.05) * math.sin(phase) * pace  # the weight shifting from foot to foot
        root.keyframe_insert("location", frame=f)
        root.keyframe_insert("rotation_euler", frame=f)
        out.append((Vector((p.x, p.y, z0 + bob)), yaw))
    return out


def door_of(sc, clip):
    """The door object of a Street_Door_<n> shot (the house that Door_Token_<n> belongs to), or None."""
    preset = (clip.get("camera") or {}).get("preset", "") or ""
    if not preset.startswith("Street_Door_"):
        return None
    tok = sc.objects.get(f"Door_Token_{preset.rsplit('_', 1)[1]}")
    root = tok.parent if tok else None
    return next((o for o in (root.children_recursive if root else []) if o.name.split(".")[0] == "Door"), None)


def invisible():
    m = bpy.data.materials.get("Invisible")
    if m is None:
        m = bpy.data.materials.new("Invisible")
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.remove(nt.nodes.get("Principled BSDF"))
        tr = nt.nodes.new("ShaderNodeBsdfTransparent")
        nt.links.new(tr.outputs[0], nt.nodes.get("Material Output").inputs["Surface"])
        try_set = common.try_set
        try_set(m, "surface_render_method", "DITHERED")
        try_set(m, "blend_method", "CLIP")
    return m


def claw_wood():
    """Fresh torn wood: the cel-shaded wood, warm, with a little light of its own so it reads pale in the moonlight."""
    m = common.toon("ClawWood", (1.0, 0.55, 0.27))
    nt = m.node_tree
    em = next(n for n in nt.nodes if n.type == "EMISSION")
    src = em.inputs["Color"].links[0].from_socket
    add = nt.nodes.new("ShaderNodeVectorMath")
    add.operation = "ADD"
    add.inputs[1].default_value = (0.13, 0.075, 0.038)
    nt.links.new(src, add.inputs[0])
    nt.links.new(add.outputs[0], em.inputs["Color"])
    return m


def add_claws(sc, clip):
    """Owner (2026-10-28): three claw gouges cut into the door itself, torn one by one (clip["claws"]["at"], each
    growing from its top over "grow" frames), then staying. Each is a tapered, slightly bowed V-groove: a hidden cutter
    mesh and a Boolean placed before the door's ink hull, so the ink follows the grooves; the cut faces are pale torn
    wood. Returns a function that takes it all away again (the next clip uses the same set)."""
    door = door_of(sc, clip)
    if door is None:
        return lambda: None
    mw, bb = door.matrix_world, [v.co for v in door.data.vertices]  # the wood itself (bound_box counts the ink hull)
    x0, x1 = min(c.x for c in bb), max(c.x for c in bb)
    y1 = max(c.y for c in bb)
    z0, z1 = min(c.z for c in bb), max(c.z for c in bb)
    normal = (mw.to_3x3() @ Vector((0, 1, 0))).normalized()  # the face toward the lane

    def on_door(u, v):  # u across from the door's local -x side, v down from the top
        return mw @ Vector((x0 + (x1 - x0) * u, y1, z1 - (z1 - z0) * v))

    mesh = door.data
    wood = bpy.data.materials.get("ClawWood") or claw_wood()
    slots = len(mesh.materials)
    mesh.materials.append(wood)  # slot `slots`: the cut faces
    mesh.materials.append(M["ink"])  # (kept in pairs with the hull's material_offset of 1)
    made, mods = [], []
    spec = clip["claws"]
    for k, u in enumerate((0.3, 0.47, 0.64)):
        a, b = on_door(u - 0.06, 0.18 + 0.03 * k), on_door(u + 0.1, 0.62 + 0.02 * k)  # as the 2D marks: slanting
        along = (b - a).normalized()
        side = along.cross(normal).normalized()
        half, depth, n = 0.042, 0.022, 14  # wide and shallow: the walls face the light, as the door does
        verts, faces = [], []
        for i in range(n + 1):
            t = i / n
            w = half * (math.sin(math.pi * min(1.0, t * 1.15)) ** 0.7 if t < 0.87 else max(0.0, 1 - t) / 0.13 * 0.35) + 0.0015
            p = a + (b - a) * t + side * (0.025 * math.sin(math.pi * t)) - a  # local to the gouge's top (it grows from there)
            verts += [p - side * w + normal * 0.012, p + side * w + normal * 0.012, p - normal * depth * (w / half) - normal * 0.002]
        for i in range(n):
            l0, r0, d0, l1, r1, d1 = 3 * i, 3 * i + 1, 3 * i + 2, 3 * i + 3, 3 * i + 4, 3 * i + 5
            faces += [(l0, r0, r1, l1), (l0, l1, d1, d0), (r0, d0, d1, r1)]
        faces += [(0, 2, 1), (3 * n, 3 * n + 1, 3 * n + 2)]
        me = bpy.data.meshes.new(f"ClawCutter{k}")
        me.from_pydata([tuple(v) for v in verts], [], faces)
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)  # outward: an inside-out cutter cuts the rest of the door away
        bm.to_mesh(me)
        bm.free()
        me.update()
        for poly in me.polygons:
            poly.material_index = slots  # material_mode INDEX: the door's ClawWood slot
        cut = bpy.data.objects.new(f"ClawCutter{k}", me)
        sc.collection.objects.link(cut)
        cut.location, cut["cast"] = a, True
        cut.hide_render, cut.display_type = True, "WIRE"
        # the tear: from nothing at its top to its full length in `grow` frames
        f0, g = spec["at"][k], spec["grow"]
        for fr, s in ((0, 0.001), (f0, 0.001), (f0 + g, 1.0)):
            cut.scale = (s, s, s)
            cut.keyframe_insert("scale", frame=fr)
        mod = door.modifiers.new(f"Claw{k}", "BOOLEAN")
        mod.operation, mod.solver, mod.object, mod.material_mode = "DIFFERENCE", "EXACT", cut, "INDEX"
        for fr, on in ((0, False), (f0, True)):
            mod.show_render = mod.show_viewport = on
            mod.keyframe_insert("show_render", frame=fr)
            mod.keyframe_insert("show_viewport", frame=fr)
        made.append(cut)
        mods.append(mod)

    # the ink: an inverted hull rebuilt round the cut's long thin triangles breaks into dark slivers, and a cut after
    # the hull makes the solver drop the door's face. So the cut door has no hull, and a copy of the uncut door draws
    # only the hull (its own wood invisible); the hull's back faces never cover the grooves
    ink = door.modifiers.get("Ink")
    shell = None
    if ink:
        shell = bpy.data.objects.new("DoorInk", door.data)
        sc.collection.objects.link(shell)
        shell.matrix_world, shell["cast"] = door.matrix_world.copy(), True
        sol = shell.modifiers.new("Ink", "SOLIDIFY")
        for attr in ("thickness", "offset", "use_flip_normals", "use_rim", "material_offset"):
            setattr(sol, attr, getattr(ink, attr))
        shell.material_slots[0].link = "OBJECT"
        shell.material_slots[0].material = invisible()
        ink.show_render = ink.show_viewport = False

    def remove():
        if ink:
            ink.show_render = ink.show_viewport = True
            bpy.data.objects.remove(shell, do_unlink=True)
        for m in mods:
            door.modifiers.remove(m)
        if door.animation_data:
            door.animation_data_clear()
        for o in made:
            bpy.data.objects.remove(o, do_unlink=True)
        for _ in range(2):
            mesh.materials.pop()
    return remove


def setup(clip, key=None):
    sc = common.use_scene(clip["scene"])
    bpy.context.window.scene = sc  # drivers (all the motion) only evaluate in the window's scene
    clear_cast(sc)
    animate.clear_world_motion(sc)
    apply_preset(sc, clip["preset"])
    speaker = (clip.get("anim") or {}).get("speaker")
    mode = (clip.get("anim") or {}).get("mode", "idle")
    roots, heads = {}, {}
    if any(m["mark"] == "Guest" for m in clip["cast"]):
        room_guest(sc)
    for m in clip["cast"]:
        mk = sc.objects.get(f"Mark_{m['mark']}")
        if mk is None:
            continue
        root, head = figure(M, f"C{m['seat']}", tuple(mk.location), mk["facing_yaw"], m["seat"], m["role"], pose=m["pose"], night=m["night"],
                            sheriff=m["sheriff"], clawed=m.get("clawed", False), lean=m.get("lean") or mk.get("lean", 0.0))
        for o in [root, *root.children_recursive]:
            o["cast"] = True
        roots[m["seat"]], heads[m["seat"]] = root, Vector(head)
    for seat, root in roots.items():
        if root.get("anim") is None:
            continue
        look = 0.0
        if speaker and seat != speaker and speaker in heads:  # turn toward whoever is speaking
            to = heads[speaker] - root.location
            look = (math.atan2(to.y, to.x) - (root.rotation_euler.z + math.pi / 2) + math.pi) % (2 * math.pi) - math.pi
        pose_mode = "sleep" if root["anim"]["pose"] == "sleep" else (mode if seat == speaker else "idle")
        animate.figure_motion(root, pose_mode, L, look)
    walks = {}  # seat -> per-frame (root location, yaw), and the head's offset from the root at rest
    for seat, spec in (clip.get("walk") or {}).items():
        root = roots.get(int(seat))
        if root is None:
            continue
        loc0, yaw0 = root.location.copy(), root.rotation_euler.z
        rel = Matrix.Rotation(-yaw0, 3, "Z") @ (heads[int(seat)] - loc0)
        walks[int(seat)] = (walk_keys(root, spec, clip["frames"], plan["fps"]), rel)
    animate.world_motion(sc, L)
    for tok, seat in clip.get("tokens", {}).items():
        o = sc.objects.get(tok)
        if o is not None:
            o.material_slots[0].link = "OBJECT"
            o.material_slots[0].material = seat_mat(seat)
    cam = director_cam(sc)
    if clip["kind"] == "move":
        key_move(cam, resolve(sc, clip["camera_from"]), resolve(sc, clip["camera_to"]), clip["frames"])
    else:
        place_camera(cam, *resolve(sc, clip["camera"]))
        if H > W and key in AIM and speaker in heads:  # upright: the speaker mid-frame, a little above centre
            loc, _, lens = resolve(sc, clip["camera"])
            place_camera(cam, loc, heads[speaker] - Vector((0, 0, 0.15)), lens)
    if H > W:  # upright: see vfit x the 16:9 frame's height
        cam.data.sensor_fit = "VERTICAL"
        cam.data.sensor_height = cam.data.sensor_width * 9 / 16 * VFIT.get(key, 1.0)
    animate.camera_drift(cam, L, 0.6 if clip["kind"] == "loop" else 0.3)
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = W, H, 100
    sc.frame_set(clip["frames"] - 1 if clip["kind"] == "move" else 0)  # judge the signs where the camera ends up
    plates = {}
    cam_at = resolve(sc, clip["camera_to"] if clip["kind"] == "move" else clip["camera"])[0]  # where the camera ends up
    if clip["scene"] != "Room":  # owner: signs above the living (and the wolves); none on the dead, none in the Room close-ups
        for m in clip["cast"]:
            if m["pose"] in ("body", "sleep") or m["seat"] not in heads:
                continue
            root = roots[m["seat"]]
            front = Vector((-math.sin(root.rotation_euler.z), math.cos(root.rotation_euler.z)))
            to_cam = (cam_at - heads[m["seat"]]).xy.normalized()
            walking = m["seat"] in walks  # a walker's sign goes with it the whole way (it turns toward the camera as it sets off)
            top = (clip.get("camera") or {}).get("top", False)  # seen from above: every sign shows, lying flat toward the camera
            if front.dot(to_cam) < -0.5 and not walking and not top:  # back to the camera, in the foreground: its sign would cover the people behind
                continue
            if not 0.08 < world_to_camera_view(sc, cam, heads[m["seat"]]).x < 0.92 and not walking:  # at the frame edge: it would be cut off
                continue
            info = plan["seats"][str(m["seat"])]
            role = info["role"]
            team = "wolf" if role in WOLVES else "solo" if role in SOLO else "village"
            sroot, plates[m["seat"]] = sign(f"Sign{m['seat']}", heads[m["seat"]], m["seat"], info["model"], "",  # model + role only
                                            role.replace("_", " ").title(), team, cam, hat=m["role"] == "witch")
            if top:  # "face the camera" is ambiguous straight from above: take the camera's own rotation instead
                for c in list(sroot.constraints):
                    sroot.constraints.remove(c)
                cr = sroot.constraints.new("COPY_ROTATION")
                cr.target = cam
            if walking:  # the sign rides above the walker's head
                track, rel = walks[m["seat"]]
                lift = sroot.location - heads[m["seat"]]
                for f, (loc, yaw) in enumerate(track):
                    sroot.location = loc + Matrix.Rotation(yaw, 3, "Z") @ rel + lift
                    sroot.keyframe_insert("location", frame=f)
    for seat, (track, rel) in walks.items():  # the text layer reads heads where the walk ends
        loc, yaw = track[-1]
        heads[seat] = loc + Matrix.Rotation(yaw, 3, "Z") @ rel
    sc.frame_set(0)
    return sc, cam, heads, plates


# ---------------------------------------------------------------- the inner-voice map (thought_fx.py, owner 2026-10-22)
MAPS = int(args[args.index("--maps") + 1]) if "--maps" in args else None  # the thinker's seat
MAP_FAR = 30.0  # m: R = distance from the thinker's feet / MAP_FAR


def map_materials(sc, thinker):
    """Paint every surface with data instead of colour: R = its distance from the thinker's FEET (the rings spread from
    there), G = what it is (0 the village, 0.5 another player or their sign, 1 the thinker or their sign). Volumes
    (fog) are hidden; outline shells keep their back-face culling so they stay outlines."""
    owner = {}
    for o in sc.objects:
        top = o
        while top.parent is not None:
            top = top.parent
        for prefix, cls in ((f"C{thinker}", 1.0), (f"Sign{thinker}", 1.0)):
            if top.name == prefix or top.name.startswith(prefix + "_"):
                owner[o.name] = cls
        if o.name not in owner and (o.get("cast") or top.name.startswith("Sign")):
            owner[o.name] = 0.5
    root = next(o for o in sc.objects if o.name == f"C{thinker}")
    pts = [o.matrix_world @ Vector(c) for o in [root, *root.children_recursive] if o.type == "MESH" for c in o.bound_box]
    feet = Vector((root.matrix_world.translation.x, root.matrix_world.translation.y, min(p.z for p in pts)))
    cache = {}

    def data_mat(cls, culling, blend):
        k = (cls, culling, blend)
        if k not in cache:
            m = bpy.data.materials.new(f"Map_{cls}_{int(culling)}_{blend}")
            m.use_nodes = True
            m.use_backface_culling = culling
            nt = m.node_tree
            nt.nodes.clear()
            geo = nt.nodes.new("ShaderNodeNewGeometry")
            dist = nt.nodes.new("ShaderNodeVectorMath")
            dist.operation = "DISTANCE"
            dist.inputs[1].default_value = feet
            div = nt.nodes.new("ShaderNodeMath")
            div.operation = "DIVIDE"
            div.inputs[1].default_value = MAP_FAR
            div.use_clamp = True
            comb = nt.nodes.new("ShaderNodeCombineColor")
            comb.inputs[1].default_value = cls
            em = nt.nodes.new("ShaderNodeEmission")
            out = nt.nodes.new("ShaderNodeOutputMaterial")
            nt.links.new(geo.outputs["Position"], dist.inputs[0])
            nt.links.new(dist.outputs["Value"], div.inputs[0])
            nt.links.new(div.outputs[0], comb.inputs[0])
            nt.links.new(comb.outputs[0], em.inputs["Color"])
            nt.links.new(em.outputs[0], out.inputs["Surface"])
            cache[k] = m
        return cache[k]

    for o in sc.objects:
        if o.type in ("MESH", "CURVE", "FONT", "SURFACE", "META") and not o.material_slots and o.data is not None:
            o.data.materials.append(None)  # no material: it would render in Blender's default grey, not as data
        if not hasattr(o, "material_slots") or not o.material_slots:
            continue
        vol = any(s.material and s.material.use_nodes and any(l.to_socket.name == "Volume" for l in s.material.node_tree.links) for s in o.material_slots)
        if vol:
            o.hide_render = True
            continue
        cls = owner.get(o.name, 0.0)
        for s in o.material_slots:
            orig = s.material
            s.link = "OBJECT"
            s.material = data_mat(cls, bool(orig and orig.use_backface_culling), "x")
    w = sc.world
    if w is not None and w.use_nodes:  # the sky: far away, the village
        for n in w.node_tree.nodes:
            if n.type == "BACKGROUND":
                for l in list(n.inputs["Color"].links) + list(n.inputs["Strength"].links):  # the sky gradient: unhooked
                    w.node_tree.links.remove(l)
                n.inputs["Color"].default_value = (1.0, 0.0, 0.0, 1.0)
                n.inputs["Strength"].default_value = 1.0
        for l in list(w.node_tree.links):
            if l.to_socket.name == "Volume":
                w.node_tree.links.remove(l)
    sc.render.use_compositing = False
    sc.view_settings.view_transform, sc.view_settings.look = "Standard", "None"
    sc.view_settings.exposure, sc.view_settings.gamma = 0.0, 1.0
    im = sc.render.image_settings
    im.file_format, im.color_mode, im.color_depth = "PNG", "RGB", "16"
    return feet


keys = sorted(k for k in plan["clips"] if ONLY is None or k in ONLY)
mine = [k for n, k in enumerate(keys) if n % parts == part]
meta_path = os.path.join(GDIR, f"meta_{part}.json") if OUTDIR == "clips" else os.path.join(GDIR, OUTDIR, f"meta_{part}.json")
os.makedirs(os.path.dirname(meta_path), exist_ok=True)
meta = json.load(open(meta_path, encoding="utf-8")) if os.path.exists(meta_path) else {}
# only this part's clips: stale entries would win when the parts are merged. With --only, the other clips' entries stay
# (2026-10-28: an --only run had dropped the whole game's meta), and a clip written here is taken out of the other files
meta = {k: v for k, v in meta.items() if k in mine or (ONLY is not None and k not in ONLY)}


def drop_elsewhere(k):
    if ONLY is None:  # whole parts never share clips (and run side by side: never read each other's file mid-write)
        return
    for f in os.listdir(os.path.dirname(meta_path)):
        p = os.path.join(os.path.dirname(meta_path), f)
        if f.startswith("meta_") and f.endswith(".json") and os.path.normcase(p) != os.path.normcase(meta_path):
            try:
                other = json.load(open(p, encoding="utf-8"))
            except ValueError:
                continue
            if other.pop(k, None) is not None:
                json.dump(other, open(p, "w", encoding="utf-8"), indent=1)


for n, k in enumerate(mine):
    clip = plan["clips"][k]
    cdir = os.path.join(GDIR, OUTDIR, k)
    frames = [0] if PREVIEW else list(range(0, clip["frames"], clip["step"]))
    if TEST_FRAMES:  # --frames 52,80: only those (a look test; the clip then counts as unfinished and renders in full later)
        frames = [f for f in frames if f in TEST_FRAMES]
    build = BUILD + (f"-{W}x{H}-v{VFIT.get(k, 1.0)}-a{int(k in AIM)}" if H > W else "")
    rendered = all(os.path.exists(os.path.join(cdir, f"{f:04d}.png")) for f in frames)
    if META_ONLY and not rendered:
        print(f"[clips:{part}] {n + 1}/{len(mine)} {k}: not rendered, no meta", flush=True)
        continue
    if MAPS is None and not PREVIEW and not META_ONLY and meta.get(k, {}).get("build") == build and rendered:
        continue
    if MAPS is not None:  # only the inner-voice map of each frame (the picture itself is rendered already)
        sc, cam, heads, plates = setup(clip, k)
        feet = map_materials(sc, MAPS)
        mdir = os.path.join(GDIR, OUTDIR, f"{k}_map{MAPS}")
        os.makedirs(mdir, exist_ok=True)
        for f in frames:
            sc.frame_set(f)
            sc.render.filepath = os.path.join(mdir, f"{f:04d}.png")
            bpy.ops.render.render(write_still=True, scene=sc.name)
        json.dump({"far": MAP_FAR, "feet": list(feet), "frames": frames}, open(os.path.join(mdir, "map.json"), "w"))
        print(f"[clips:{part}] map {k} seat {MAPS}: {len(frames)} frames", flush=True)
        continue
    os.makedirs(cdir, exist_ok=True)
    sc, cam, heads, plates = setup(clip, k)
    unclaw = add_claws(sc, clip) if clip.get("claws") else (lambda: None)
    for f in ([] if META_ONLY else frames):
        sc.frame_set(f)
        sc.render.filepath = os.path.join(GDIR, OUTDIR, "preview", f"{k}.png") if PREVIEW else os.path.join(cdir, f"{f:04d}.png")
        bpy.ops.render.render(write_still=True, scene=sc.name)
    if PREVIEW:
        continue
    sc.frame_set(frames[-1] if clip["kind"] in ("move", "walk") else 0)  # where the text will sit: the end of a move or walk, the start of a loop
    pos = {}
    for seat, h in heads.items():
        v = world_to_camera_view(sc, cam, h)
        pos[str(seat)] = [round(v.x * W, 1), round((1 - v.y) * H, 1), bool(v.z > 0 and 0 <= v.x <= 1 and 0 <= v.y <= 1)]
    signs = {}
    for seat, pl in plates.items():  # each sign's box on screen: the speech box sits above it and never covers it
        vs = [world_to_camera_view(sc, cam, pl.matrix_world @ Vector(c)) for c in pl.bound_box]
        if all(v.z > 0 for v in vs):
            xs, ys = [v.x * W for v in vs], [(1 - v.y) * H for v in vs]
            signs[str(seat)] = [round(min(xs), 1), round(min(ys), 1), round(max(xs), 1), round(max(ys), 1)]
    door = None  # the wolves at a door (owner, 2026-10-27): its front's four corners on screen, for the claw marks
    door_frames = {}  # ...in every rendered frame (owner, 2026-10-28: the marks must stay on the door as the camera drifts)
    preset = (clip.get("camera") or {}).get("preset", "") or ""
    if preset.startswith("Street_Door_"):
        tok = sc.objects.get(f"Door_Token_{preset.rsplit('_', 1)[1]}")
        root = tok.parent if tok else None
        obj = next((o for o in (root.children_recursive if root else []) if o.name.split(".")[0] == "Door"), None)
        if obj is not None:
            front = [Vector(c) for c in obj.bound_box if c[1] > 0]  # the face toward the lane (+y in the house)
            if len(front) == 4:
                # top-left, top-right, bottom-right, bottom-left as the camera sees them
                lo = sorted(front, key=lambda c: c[2])
                bottom, top = sorted(lo[:2], key=lambda c: c[0]), sorted(lo[2:], key=lambda c: c[0])
                for f in frames:
                    sc.frame_set(f)
                    quad = [world_to_camera_view(sc, cam, obj.matrix_world @ c) for c in (top[0], top[1], bottom[1], bottom[0])]
                    if all(v.z > 0 for v in quad):
                        door_frames[str(f)] = [[round(v.x * W, 1), round((1 - v.y) * H, 1)] for v in quad]
                door = door_frames.get(str(frames[0]))
    unclaw()
    meta[k] = {"build": build, "heads": pos, "signs": signs, "size": [W, H], "frames": frames,
               **({"door": door, "door_frames": door_frames} if door else {})}
    drop_elsewhere(k)
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1)
    print(f"[clips:{part}] {n + 1}/{len(mine)} {clip['kind']} {clip['scene']} {clip['preset']} -> {len(frames)} frames", flush=True)
print(f"[clips:{part}] done")
