"""Cut the intro (inside Blender's sequencer):

    blender --background --factory-startup --python director/encode_intro.py -- <id8> [--outdir <folder>] [--plan short]

Shots end to end (games/<id8>/intro/intro_plan.json):
- stage shots from intro/clips/<shot>/ (on twos);
- game shots from the game's own clips, looped, with a slow zoom in;
- the text layer (intro/overlays) on top.
Sound:
- the voices;
- each shot's effects (sounds/ library);
- a heartbeat under the cold open;
- the music bed (M4) from the lineup to the end, under the voices, fading out with the howl.
Output: <outdir>/<id8> intro.mp4 (default FullGameFolder/<id8>).
--plan short: the vertical Short (games/<id8>/short/: its game moments re-rendered upright in short/gclips/) ->
<outdir>/<id8> short.mp4.
"""
import json
import os
import sys

import bpy

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[sys.argv.index("--") + 1:]
gid = args[0]
GDIR = os.path.join(BASE, "games", gid)
PLAN = args[args.index("--plan") + 1] if "--plan" in args else "intro"
IDIR = os.path.join(GDIR, PLAN)
GCLIPS = os.path.join(GDIR, "clips") if PLAN == "intro" else os.path.join(IDIR, "gclips")  # the game's own frames
OUT = args[args.index("--outdir") + 1] if "--outdir" in args else os.path.join(os.path.dirname(BASE), "FullGameFolder", gid)
plan = json.load(open(os.path.join(IDIR, "intro_plan.json"), encoding="utf-8"))
gplan = json.load(open(os.path.join(GDIR, "plan.json"), encoding="utf-8"))
ov_index = json.load(open(os.path.join(IDIR, "overlays", "index.json")))
lib = json.load(open(os.path.join(BASE, "sounds", "library.json"), encoding="utf-8"))
FPS = plan["fps"]

sc = bpy.context.scene
sc.render.fps = FPS
for attr, val in (("view_transform", "Standard"), ("look", "None")):
    try:
        setattr(sc.view_settings, attr, val)
    except Exception:
        pass
se = sc.sequence_editor_create()
strips = se.strips if hasattr(se, "strips") else se.sequences


def image_strip(name, folder, files, start, length, channel):
    seq = []
    while len(seq) < length:
        seq += files
    seq = seq[:length]
    s = strips.new_image(name=name, filepath=os.path.join(folder, seq[0]), channel=channel, frame_start=start)
    for f in seq[1:]:
        s.elements.append(f)
    s.frame_final_duration = length
    return s


def sound(name, path, start, channel, volume, end=None, fade_in=0, fade_out=6):
    if not os.path.exists(path):
        return None
    s = strips.new_sound(name=name, filepath=path, channel=channel, frame_start=start)
    if end:
        s.frame_final_end = min(end, s.frame_final_end) if s.frame_final_end > start else end
    a, e = s.frame_final_start, s.frame_final_end
    keys = {a: 0.0 if fade_in else volume, a + max(1, fade_in): volume, max(a + 1, e - fade_out): volume, e: 0.0}
    for fr in sorted(keys):
        s.volume = keys[fr]
        s.keyframe_insert("volume", frame=fr)
    return s


COLD_FIRST = plan["shots"][0]["id"] == "cold_say"  # the wolf's own words open the cut (not when they come later)
frame, sfx_ch, first, starts = 1, 10, None, {}
for k, shot in enumerate(plan["shots"]):
    n = shot["frames"]
    starts[shot["id"]] = frame
    if shot["source"] == "stage":
        folder = os.path.join(IDIR, "clips", shot["id"])
        files = [f"{f:04d}.png" for f in range(0, n, 2)]
        files = [f for f in files for _ in (0, 1)]
    else:
        c = gplan["clips"][shot["clip"]]
        folder = os.path.join(GCLIPS, shot["clip"])
        files = [f"{f:04d}.png" for f in range(0, c["frames"], c["step"])]
        if c["step"] == 2:
            files = [f for f in files for _ in (0, 1)]
    s = image_strip(f"shot{k:02d}", folder, files, frame, n, 1 + k % 2)
    first = first or s
    if shot["source"] == "game" and shot.get("push"):  # a slow zoom in on the game's frames
        for fr, v in ((frame, 1.0), (frame + n - 1, shot["push"])):
            s.transform.scale_x = s.transform.scale_y = v
            s.transform.keyframe_insert("scale_x", frame=fr)
            s.transform.keyframe_insert("scale_y", frame=fr)
    m = ov_index["shots"].get(shot["id"], 0)
    if m:
        o = image_strip(f"ov{k:02d}", os.path.join(IDIR, "overlays", shot["id"]), [f"{i:04d}.png" for i in range(m) for _ in (0, 1)], frame, n, 4)
        o.blend_type = "ALPHA_OVER"
    if shot.get("voice"):
        sound(f"vo{k:02d}", plan["voices"][shot["voice"]]["file"], frame + shot.get("voice_at", 0), 6 + k % 2, 1.0, fade_out=2)
    for j, (sid, at, gain) in enumerate(shot.get("sfx", [])):
        if sid == "S15" and COLD_FIRST:
            continue  # with a cold open, the heartbeat runs under all of it (below)
        sfx_ch = 10 + (sfx_ch - 9) % 10
        loop_end = frame + n if sid == "S15" else None  # the heartbeat lasts as long as its shot
        sound(f"fx{k:02d}_{j}", os.path.join(BASE, "sounds", lib[sid]["file"]), frame + round(at * FPS), sfx_ch, gain, end=loop_end,
              fade_in=4 if sid == "S15" else 0, fade_out=8 if sid == "S15" else 4)
    frame += n
end = frame - 1
if COLD_FIRST:  # a cold open: the heartbeat under all of it
    sound("heartbeat", os.path.join(BASE, "sounds", lib["S15"]["file"]), 1, 21, 0.9, end=starts["lineup"] + 6, fade_in=4, fade_out=10)
music = plan["music"]
mus = os.path.join(BASE, "sounds", lib[music["id"]]["file"])
pos = starts[music["from"]]
while pos < end:  # the bed, looped (a seamless prepared loop) to the end, fading out under the howl
    s = sound(f"music{pos}", mus, pos, 22 + (pos % 2), music["level"], end=end, fade_in=12 if pos == starts[music["from"]] else 0,
              fade_out=36 if pos + 1 >= end else 0)
    if s is None:
        break
    pos = s.frame_final_end
sc.frame_start, sc.frame_end = 1, end
img = bpy.data.images.load(os.path.join(first.directory, first.elements[0].filename))
sc.render.resolution_x, sc.render.resolution_y = img.size[0] - img.size[0] % 2, img.size[1] - img.size[1] % 2
sc.render.resolution_percentage = 100
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
os.makedirs(OUT, exist_ok=True)
out = os.path.join(OUT, f"{gid} {'intro' if PLAN == 'intro' else PLAN}.mp4")
sc.render.filepath = out
bpy.ops.render.render(animation=True)
print(f"[intro] encoded {end / FPS:.1f} s -> {out}")
