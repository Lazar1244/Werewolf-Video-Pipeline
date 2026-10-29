"""Step 5 (inside Blender): assemble clips + overlays into the MP4.

    blender --background --factory-startup --python director/encode_clips.py -- <id8> [--out name]

For each beat: its camera move (if any), then its loop repeated to fill the beat. Loops rendered on twos show every
frame twice. The dawn-to-day transition cross-fades its two renders. An inner thought slowly zooms in a little toward the
thinker's head (a 2D push on its loop, so it costs no rendering). The beat's voice (if the episode was voiced) is laid in as a sound strip. The beat's text layer sits on top (an image sequence: the text types itself out).
"""
import json
import math
import os
import sys

import bpy

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # this Blender folder ("2 Werewolf Blender")
args = sys.argv[sys.argv.index("--") + 1:]
gid = args[0]
name = args[args.index("--out") + 1] if "--out" in args else f"{gid}_animated"
GDIR = os.path.join(BASE, "games", gid)
OUT = args[args.index("--outdir") + 1] if "--outdir" in args else os.path.join(BASE, "out", "episodes")
os.makedirs(OUT, exist_ok=True)
plan = json.load(open(os.path.join(GDIR, "plan.json"), encoding="utf-8"))
FPS = plan["fps"]
ov_index = json.load(open(os.path.join(GDIR, "overlays", "index.json"), encoding="utf-8"))
ep = json.load(open(os.path.join(GDIR, "episode.json"), encoding="utf-8"))
meta = {}
for f in os.listdir(GDIR):
    if f.startswith("meta_") and f.endswith(".json"):
        meta.update(json.load(open(os.path.join(GDIR, f), encoding="utf-8")))
PUSH = 1.06  # how far an inner thought zooms in (6%)


def push(s, clip, seat, start, length):
    """A slight, slow zoom in toward the thinker's head over the whole stretch, easing in and out."""
    h = meta.get(clip, {}).get("heads", {}).get(str(seat))
    w, hgt = meta.get(clip, {}).get("size", [1280, 720])
    if h and h[2]:
        s.transform.origin = (min(0.85, max(0.15, h[0] / w)), min(0.85, max(0.15, 1 - h[1] / hgt)))
    for fr, v in ((start, 1.0), (start + length - 1, PUSH)):
        s.transform.scale_x = s.transform.scale_y = v
        s.transform.keyframe_insert("scale_x", frame=fr)
        s.transform.keyframe_insert("scale_y", frame=fr)


def try_set(obj, attr, value):
    try:
        setattr(obj, attr, value)
    except Exception as e:
        print(f"[encode] skip {attr}: {e}")


sc = bpy.context.scene
sc.render.fps = FPS
try_set(sc.view_settings, "view_transform", "Standard")
try_set(sc.view_settings, "look", "None")
se = sc.sequence_editor_create()
strips = se.strips if hasattr(se, "strips") else se.sequences


def clip_files(key):
    c = plan["clips"][key]
    files = [f"{f:04d}.png" for f in range(0, c["frames"], c["step"])]
    if c["step"] == 2:  # on twos: each rendered frame shows for two
        files = [f for f in files for _ in (0, 1)]
    return os.path.join(GDIR, "clips", key), files


def add_seq(label, key, start, length, channel, loop=False):
    folder, files = clip_files(key)
    seq = []
    while len(seq) < length:
        seq += files
        if not loop:
            break
    seq = seq[:length]
    while len(seq) < length:  # a move shorter than its slot holds its last frame
        seq.append(seq[-1])
    s = strips.new_image(name=label, filepath=os.path.join(folder, seq[0]), channel=channel, frame_start=start)
    for f in seq[1:]:
        s.elements.append(f)
    s.frame_final_duration = length
    return s


first = None
frame = 1
for pb in plan["beats"]:
    t0 = frame
    for n, seg in enumerate(pb["segments"]):
        s = add_seq(f"b{pb['index']:03d}_{n}", seg["clip"], frame, seg["frames"], 1, loop=seg.get("loop", False))
        if first is None:
            first = s
        if seg.get("push"):
            push(s, seg["clip"], ep["beats"][pb["index"]].get("seat"), frame, seg["frames"])
        if "crossfade_to" in seg:  # night slowly turns to dawn
            s2 = add_seq(f"b{pb['index']:03d}_x", seg["crossfade_to"], frame, seg["frames"], 2)
            s2.blend_type = "ALPHA_OVER"
            s2.blend_alpha = 0.0
            s2.keyframe_insert("blend_alpha", frame=frame)
            s2.blend_alpha = 1.0
            s2.keyframe_insert("blend_alpha", frame=frame + seg["frames"] - 1)
        frame += seg["frames"]
    n_ov = ov_index["beats"].get(str(pb["index"]), 0)
    start = t0 + pb.get("overlay_start", 0)
    if n_ov and frame - start > 0:  # the text types itself out: each image for `step` frames, the last one holds
        ov_dir = os.path.join(GDIR, "overlays", f"beat_{pb['index']:03d}")
        seq = [f"{i:04d}.png" for i in range(n_ov) for _ in range(ov_index["step"])][:frame - start]
        seq += [seq[-1]] * (frame - start - len(seq))
        o = strips.new_image(name=f"ov{pb['index']:03d}", filepath=os.path.join(ov_dir, seq[0]), channel=4, frame_start=start)
        for f in seq[1:]:
            o.elements.append(f)
        o.frame_final_duration = frame - start
        o.blend_type = "ALPHA_OVER"
    if pb.get("voice") and os.path.exists(pb["voice"]):  # the line's voice, starting just after its text appears
        strips.new_sound(name=f"vo{pb['index']:03d}", filepath=pb["voice"], channel=6 + pb["index"] % 2, frame_start=t0 + pb["voice_at"])
# music, ambience and effects (director/sound.py -> sound_cues.json; sounds/SOUNDS.md says what plays where)
cue_path = os.path.join(GDIR, "sound_cues.json")
if os.path.exists(cue_path):
    cs = json.load(open(cue_path, encoding="utf-8"))
    SND = os.path.join(BASE, "sounds")
    lanes = {"music": [9, 10], "bed": [11, 12], "bed2": [13, 14], "bed3": [15, 16], "oneshot": list(range(17, 30))}
    busy = {ch: 0 for chs in lanes.values() for ch in chs}  # the last frame used on each channel
    att, rel = cs["attack"], cs["release"]

    def lane(layer, start):
        free = [ch for ch in lanes[layer] if busy[ch] <= start]
        return free[0] if free else min(lanes[layer], key=lambda ch: busy[ch])

    def volume_curve(st, cue, a, e):
        """One envelope: equal-power fade in and out, multiplied by the ducking under the voices (which holds through
        continuous dialogue), keyed at every corner and every few frames inside the curves."""
        hi, lo, fi, fo = cue["high"], cue["low"], max(1, cue["fade_in"]), max(1, cue["fade_out"])
        dl = lo / hi if hi else 1.0

        def fade(f):
            if f <= a or f >= e:
                return 0.0
            g = 1.0
            if f < a + fi:
                g *= math.sin((f - a) / fi * math.pi / 2)
            if f > e - fo:
                g *= math.cos((f - (e - fo)) / fo * math.pi / 2)
            return g

        def duck(f):
            g = 1.0
            for d0, d1 in cs["duck"]:
                if d0 - att <= f <= d1 + rel:
                    if f < d0:
                        x = (f - (d0 - att)) / max(1, att)
                    elif f > d1:
                        x = 1 - (f - d1) / max(1, rel)
                    else:
                        x = 1.0
                    g = min(g, 1 - (1 - dl) * x)
            return g

        pts = {a, e, a + fi, e - fo}
        pts.update(range(a, a + fi, 3))
        pts.update(range(e - fo, e, 3))
        for d0, d1 in cs["duck"]:
            if d1 + rel >= a and d0 - att <= e:
                pts.update((d0 - att, d0, d1, d1 + rel))
        for f in sorted(p for p in pts if a <= p <= e):
            st.volume = hi * fade(f) * duck(f)
            st.keyframe_insert("volume", frame=f)

    for k, cue in enumerate(cs["cues"]):
        path = os.path.join(SND, cue["file"])
        if not os.path.exists(path):
            continue
        a, e = cue["start"], min(cue["end"], frame - 1)
        if e <= a:
            continue
        ch = lane(cue["layer"], a)
        pos, n = a, 0
        while pos < e:  # a baked loop (prep_sounds.py) is laid end to end until it covers the stretch
            st = strips.new_sound(name=f"{cue['id']}_{k}_{n}", filepath=path, channel=ch, frame_start=pos)
            st.frame_final_end = min(e, pos + st.frame_final_duration)
            volume_curve(st, cue, a, e)
            pos, n = st.frame_final_end, n + 1
            if not cue.get("loop"):
                break
        busy[ch] = e
    ad = sc.animation_data
    if ad and ad.action:  # straight lines between the keys: the envelope is exactly what was computed
        fcs = ad.action.fcurves if hasattr(ad.action, "fcurves") else [fc for layer in ad.action.layers for strip in layer.strips
                                                                       for bag in strip.channelbags for fc in bag.fcurves]
        for fc in fcs:
            if fc.data_path.endswith(".volume"):
                for kp in fc.keyframe_points:
                    kp.interpolation = "LINEAR"
    print(f"[encode] sound: {len(cs['cues'])} cues" + (f", not prepared: {', '.join(cs['missing'])}" if cs.get("missing") else ""))
sc.frame_start, sc.frame_end = 1, frame - 1
img = bpy.data.images.load(os.path.join(first.directory, first.elements[0].filename))
sc.render.resolution_x, sc.render.resolution_y = (v - v % 2 for v in img.size)
sc.render.resolution_percentage = 100
img_s = sc.render.image_settings
try_set(img_s, "media_type", "VIDEO")
img_s.file_format = "FFMPEG"
ff = sc.render.ffmpeg
ff.format, ff.codec = "MPEG4", "H264"
# --best (Game 2 onward, owner 2026-10-22: TV is a third of the watching): near-lossless, slower encode, bigger file
try_set(ff, "constant_rate_factor", "PERC_LOSSLESS" if "--best" in args else "HIGH")
try_set(ff, "ffmpeg_preset", "BEST" if "--best" in args else "GOOD")
ff.gopsize = FPS * 2
try_set(ff, "audio_codec", "AAC")
try_set(ff, "audio_bitrate", 192)
try_set(ff, "audio_channels", "STEREO")
try_set(ff, "audio_mixrate", 48000)
out = os.path.join(OUT, f"{name}.mp4")
sc.render.filepath = out
bpy.ops.render.render(animation=True)
print(f"[encode] {len(plan['beats'])} beats, {(frame - 1) / FPS:.1f} s -> {out}")
