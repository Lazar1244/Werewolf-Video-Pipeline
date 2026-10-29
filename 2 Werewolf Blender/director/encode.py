"""Step 5 (inside Blender): put the composed frames on a video-editor timeline and write an MP4.

    blender --background --factory-startup --python director/encode.py -- <id8>

Each beat's frame is held for its seconds. When the camera changes, the new shot fades in over a few frames; within
a shot, held frames get a slow push-in (about 3%) so the picture is never fully still. Output: out/episodes/<id8>_test.mp4
"""
import json
import os
import sys

import bpy

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # this Blender folder ("2 Werewolf Blender")
gid = sys.argv[sys.argv.index("--") + 1]
GDIR = os.path.join(BASE, "games", gid)
OUTDIR = os.path.join(BASE, "out", "episodes")
os.makedirs(OUTDIR, exist_ok=True)
FPS = 24
timeline = json.load(open(os.path.join(GDIR, "timeline.json"), encoding="utf-8"))


def try_set(obj, attr, value):
    try:
        setattr(obj, attr, value)
    except Exception as e:
        print(f"[encode] skip {attr}: {e}")


sc = bpy.context.scene
sc.render.fps = FPS
try_set(sc.view_settings, "view_transform", "Standard")  # the frames are final colours: no AgX tone mapping on top
try_set(sc.view_settings, "look", "None")
first = bpy.data.images.load(timeline[0]["file"])
sc.render.resolution_x, sc.render.resolution_y = (v - v % 2 for v in first.size)  # video sizes must be even
sc.render.resolution_percentage = 100
bpy.data.images.remove(first)
se = sc.sequence_editor_create()
strips = se.strips if hasattr(se, "strips") else se.sequences  # Blender 5 renamed it (an empty collection is falsy)

frame = 1
prev_still = None
for n, t in enumerate(timeline):
    length = max(1, round(t["seconds"] * FPS))
    s = strips.new_image(name=f"beat{n:03d}", filepath=t["file"], channel=1 + n % 2, frame_start=frame)
    s.frame_final_duration = length
    # a slow push-in so held frames breathe
    tr = s.transform
    for f, scale in ((frame, 1.0), (frame + length, 1.03)):
        tr.scale_x = tr.scale_y = scale
        tr.keyframe_insert("scale_x", frame=f)
        tr.keyframe_insert("scale_y", frame=f)
    if prev_still is not None and t["still"] != prev_still and n > 0:
        # a new shot: fade it in over 6 frames on top of the previous one
        s.blend_type = "ALPHA_OVER"
        s.blend_alpha = 0.0
        s.keyframe_insert("blend_alpha", frame=frame)
        s.blend_alpha = 1.0
        s.keyframe_insert("blend_alpha", frame=frame + 6)
    prev_still = t["still"]
    frame += length
sc.frame_start, sc.frame_end = 1, frame - 1

out = os.path.join(OUTDIR, f"{gid}_test.mp4")
img = sc.render.image_settings
try_set(img, "media_type", "VIDEO")
img.file_format = "FFMPEG"
ff = sc.render.ffmpeg
ff.format = "MPEG4"
ff.codec = "H264"
try_set(ff, "constant_rate_factor", "MEDIUM")
try_set(ff, "ffmpeg_preset", "GOOD")
ff.gopsize = FPS * 2
sc.render.filepath = out
bpy.ops.render.render(animation=True)
print(f"[encode] {len(timeline)} beats, {(frame - 1) / FPS:.1f} s -> {out}")
