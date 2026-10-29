"""Name signs above heads, built in 3D (owner, 2026-10-05): the model in the seat colour, then "Name · Role" with the role
in its team colour, on a dark rounded plate. Each sign always turns to face the camera (a Track To constraint), glows on
its own (night, fire or dusk light never changes it) and casts no shadow and gets no ink outline. A driver scales it
with its distance to the camera, so every sign has about the same size on screen: near ones never fill the picture and far
ones stay readable.

    sign(name, head, seat, model, who, role, team, cam, hat=False) -> (root, plate)
"""
import bpy
from mathutils import Vector

from common import Ctx, SEAT_COLORS

FONT_DIR = "C:/Windows/Fonts/"
TEAM_TEXT = {"wolf": (240, 78, 66), "village": (120, 165, 255), "solo": (185, 140, 255)}  # as in the 2D role badge (sRGB)
TOP_SIZE, LINE_SIZE = 0.15, 0.12  # text heights in metres, at the reference distance
REF_DIST = 6.0  # metres from the camera at which a sign has its built size
PAD = 0.06


def _linear(c255):
    return tuple(((v / 255 + 0.055) / 1.055) ** 2.4 for v in c255)


def _flat(name, color, alpha=1.0):
    """An unlit material (emission), so the sign reads the same in every light."""
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes.get("Principled BSDF"))
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*color, 1)
    out = nt.nodes.get("Material Output")
    if alpha < 1.0:
        tr = nt.nodes.new("ShaderNodeBsdfTransparent")
        mix = nt.nodes.new("ShaderNodeMixShader")
        mix.inputs["Fac"].default_value = alpha
        nt.links.new(tr.outputs[0], mix.inputs[1])
        nt.links.new(em.outputs[0], mix.inputs[2])
        nt.links.new(mix.outputs[0], out.inputs["Surface"])
        try:
            m.surface_render_method = "BLENDED"
        except (AttributeError, TypeError):
            m.blend_method = "BLEND"
    else:
        nt.links.new(em.outputs[0], out.inputs["Surface"])
    m["outline"] = False
    return m


def _font(file):
    return bpy.data.fonts.load(FONT_DIR + file, check_existing=True)


def _text(name, body, font, size, mats, parent, y):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body, cu.font, cu.size = body, font, size
    cu.align_x, cu.align_y = "CENTER", "CENTER"
    for m in mats:
        cu.materials.append(m)
    o = bpy.data.objects.new(name, cu)
    Ctx.coll.objects.link(o)
    o.parent = parent
    o.location = (0, y, 0.002)
    return o


def _plate(name, w, h, mat, parent):
    """A rounded rectangle (a plane with its corners bevelled), just behind the text."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([(-w / 2, -h / 2, 0), (w / 2, -h / 2, 0), (w / 2, h / 2, 0), (-w / 2, h / 2, 0)], [], [(0, 1, 2, 3)])
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    Ctx.coll.objects.link(o)
    o.parent = parent
    bev = o.modifiers.new("Round", "BEVEL")
    bev.affect, bev.width, bev.segments = "VERTICES", min(0.06, h * 0.3), 4
    return o


def sign(name, head, seat, model, who, role, team, cam, hat=False):
    """Build the sign above `head` (world space). `hat`: lift it clear of a tall hat."""
    root = bpy.data.objects.new(name, None)
    Ctx.coll.objects.link(root)
    root.location = Vector(head) + Vector((0, 0, 1.12 if hat else 0.78))
    tc = root.constraints.new("TRACK_TO")  # +Z (the text's front) always points at the camera, +Y stays up
    tc.target, tc.track_axis, tc.up_axis = cam, "TRACK_Z", "UP_Y"
    seat_m = _flat(f"SignSeat{seat}", SEAT_COLORS[seat - 1])
    em = next((n for n in seat_m.node_tree.nodes if n.type == "EMISSION"), None)
    if em is not None:  # a sign material made earlier: the seat's current colour (its model's, colors.py)
        em.inputs["Color"].default_value = (*SEAT_COLORS[seat - 1], 1)
    grey = _flat("SignGrey", _linear((205, 200, 210)))
    team_m = _flat(f"SignTeam_{team}", _linear(TEAM_TEXT[team]))
    top = _text(f"{name}_Model", model, _font("constanb.ttf"), TOP_SIZE, [seat_m], root, LINE_SIZE * 0.62)
    line = f"{who}  ·  {role}" if who else role  # owner 2026-10-15: model and role only (who = "")
    low = _text(f"{name}_Who", line, _font("constan.ttf"), LINE_SIZE, [grey, team_m], root, -TOP_SIZE * 0.55)
    low.data.body_format.foreach_set("material_index", [1 if i >= len(line) - len(role) else 0 for i in range(len(line))])
    for i in range(len(line) - len(role), len(line)):
        low.data.body_format[i].use_bold = True
    low.data.font_bold = _font("constanb.ttf")
    bpy.context.view_layer.update()
    w = max(top.dimensions.x, low.dimensions.x) + PAD * 2.4
    h = TOP_SIZE + LINE_SIZE + PAD * 2.6
    plate = _plate(f"{name}_Plate", w, h, _flat("SignPlate", _linear((8, 7, 14)), 0.82), root)
    for i in range(3):  # after measuring the text: the same size on screen at any distance (within limits)
        fc = root.driver_add("scale", i)
        dr = fc.driver
        dr.type = "SCRIPTED"
        v = dr.variables.new()
        v.name, v.type = "d", "LOC_DIFF"
        v.targets[0].id, v.targets[1].id = root, cam
        dr.expression = f"min(max(d/{REF_DIST}, 0.3), 1.8)"
    for o in [root, *root.children]:
        o["cast"] = True
        o.visible_shadow = False
    return root, plate
