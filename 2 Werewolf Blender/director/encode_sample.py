"""Encode a folder of finished frames + one voice into an MP4 (for design samples, e.g. the inner-voice look).

    blender --background --factory-startup --python director/encode_sample.py -- <frames folder> <out.mp4>

The folder holds ####.png frames and sample.json {"frames", "fps", "voice": wav path, "voice_at": seconds}
(thought_fx.py writes both). Same encoder settings as encode_intro.py (H.264 "high", AAC 192 kb/s stereo 48 kHz);
a scene left at its defaults crashed Blender (EXCEPTION_ACCESS_VIOLATION) before the audio settings were set.
"""
import bpy, json, os, sys
d = sys.argv[sys.argv.index("--") + 1]
out = sys.argv[sys.argv.index("--") + 2]
info = json.load(open(os.path.join(d, "sample.json")))
FPS = info["fps"]
sc = bpy.context.scene
sc.render.fps = FPS
ed = sc.sequence_editor_create()
strips = ed.strips if hasattr(ed, "strips") else ed.sequences
files = sorted(f for f in os.listdir(d) if f.endswith(".png"))
s = strips.new_image(name="frames", filepath=os.path.join(d, files[0]), channel=1, frame_start=1)
for f in files[1:]:
    s.elements.append(f)
s.frame_final_duration = len(files)
strips.new_sound(name="voice", filepath=info["voice"], channel=2, frame_start=1 + round(info["voice_at"] * FPS))
sc.frame_start, sc.frame_end = 1, len(files)
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1920, 1080, 100
im = sc.render.image_settings
try:
    im.media_type = "VIDEO"
except Exception:
    pass
im.file_format = "FFMPEG"
ff = sc.render.ffmpeg
ff.format, ff.codec = "MPEG4", "H264"
for attr, val in (("constant_rate_factor", "HIGH"), ("ffmpeg_preset", "GOOD"), ("audio_codec", "AAC"), ("audio_bitrate", 192),
                  ("audio_channels", "STEREO"), ("audio_mixrate", 48000)):
    try:
        setattr(ff, attr, val)
    except Exception:
        pass
ff.gopsize = FPS * 2
sc.render.filepath = out
bpy.ops.render.render(animation=True)
print("[sample] ->", out)
