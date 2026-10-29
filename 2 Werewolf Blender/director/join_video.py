"""Join finished parts into the upload video, end to end (inside Blender: the video sequencer, no ffmpeg on this PC).

    blender --background --factory-startup --python director/join_video.py -- <out.mp4> <part1.mp4> <part2.mp4> [...]

Each part's picture and sound are laid one after the other and encoded once more at the best setting (H.264
"perceptually lossless", "best" preset, AAC 192 kb/s stereo 48 kHz). Game 2 (2026-10-23): the intro, then the full game.
"""
import os
import sys

import bpy

args = sys.argv[sys.argv.index("--") + 1:]
out, parts = args[0], args[1:]
sc = bpy.context.scene
ed = sc.sequence_editor_create()
strips = ed.strips if hasattr(ed, "strips") else ed.sequences
frame = 1
for k, p in enumerate(parts):
    mv = strips.new_movie(name=f"v{k}", filepath=p, channel=1, frame_start=frame)
    strips.new_sound(name=f"a{k}", filepath=p, channel=2, frame_start=frame)
    if k == 0:  # the video's frame rate and size from the first part
        clip = bpy.data.movieclips.load(p)
        sc.render.fps = round(clip.fps)
        sc.render.resolution_x, sc.render.resolution_y = clip.size
        sc.render.resolution_percentage = 100
    frame = mv.frame_final_end
sc.frame_start, sc.frame_end = 1, frame - 1
im = sc.render.image_settings
try:
    im.media_type = "VIDEO"
except Exception:
    pass
im.file_format = "FFMPEG"
ff = sc.render.ffmpeg
ff.format, ff.codec = "MPEG4", "H264"
for attr, val in (("constant_rate_factor", "PERC_LOSSLESS"), ("ffmpeg_preset", "BEST"), ("audio_codec", "AAC"),
                  ("audio_bitrate", 192), ("audio_channels", "STEREO"), ("audio_mixrate", 48000)):
    try:
        setattr(ff, attr, val)
    except Exception as e:
        print(f"[join] skip {attr}: {e}")
ff.gopsize = sc.render.fps * 2
sc.render.filepath = out
bpy.ops.render.render(animation=True)
print(f"[join] {len(parts)} parts, {(frame - 1) / sc.render.fps:.1f} s -> {out}")
