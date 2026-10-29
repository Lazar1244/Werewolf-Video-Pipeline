# Runs INSIDE the owner's open Blender (sent through blender_live.py): loads the built locations.
# Loads village_demo.blend (the sets with the sample cast) by default. It replaces earlier copies of these scenes,
# and afterwards removes only data those old copies left unused. It never touches any other scene or the owner's own data.
import bpy

PATH = "C:/Users/PC/Desktop/Werewolf Video Pipeline/2 Werewolf Blender/out/village_demo.blend"
NAMES = ["Square", "Street", "Clearing", "Room"]
START = "Square"

win = bpy.context.window or bpy.context.window_manager.windows[0]
old = [bpy.data.scenes[n] for n in NAMES + ["Village"] if n in bpy.data.scenes]
# everything the old copies used (objects' data, their materials, the worlds)
owned = set()
for sc in old:
    if sc.world:
        owned.add(sc.world)
    for o in sc.objects:
        owned.add(o)
        if o.data is not None:
            owned.add(o.data)
            for m in getattr(o.data, "materials", []) or []:
                if m is not None:
                    owned.add(m)
keep = next((s for s in bpy.data.scenes if s.name not in NAMES + ["Village"]), None)
if keep is not None:
    win.scene = keep
for sc in old:
    bpy.data.scenes.remove(sc)
removed = 0
for _ in range(3):  # objects first, then their data, then materials
    for idb in list(owned):
        try:
            if idb.users == 0 and not idb.use_fake_user:
                coll = {bpy.types.Object: bpy.data.objects, bpy.types.Material: bpy.data.materials, bpy.types.World: bpy.data.worlds,
                        bpy.types.Mesh: bpy.data.meshes, bpy.types.Light: bpy.data.lights, bpy.types.Camera: bpy.data.cameras,
                        bpy.types.TextCurve: bpy.data.curves}.get(type(idb))
                if coll is not None:
                    coll.remove(idb)
                    owned.discard(idb)
                    removed += 1
        except ReferenceError:
            owned.discard(idb)
with bpy.data.libraries.load(PATH, link=False) as (src, dst):
    dst.scenes = [n for n in NAMES if n in src.scenes]
win.scene = bpy.data.scenes[START]
for area in win.screen.areas:
    if area.type == "VIEW_3D":
        sp = area.spaces.active
        sp.shading.type = "RENDERED"
        sp.region_3d.view_perspective = "CAMERA"
        sp.overlay.show_overlays = False
    area.tag_redraw()
print("loaded:", [s.name for s in dst.scenes], "| removed old data blocks:", removed, "| now showing", win.scene.name,
      "| other scenes kept:", [s.name for s in bpy.data.scenes if s.name not in NAMES])
