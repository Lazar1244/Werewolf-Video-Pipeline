"""Step 4b: the sound cue sheet: music, ambience and effects for every beat, by fixed rules (sounds/SOUNDS.md).

    python director/sound.py <id8>

Reads plan.json (where each beat starts and where its voice sits), episode.json (what each beat is) and
sounds/library.json (the prepared file of each sound id). Writes games/<id8>/sound_cues.json, which encode_clips.py lays
under the picture:
  music          one track per stretch of the story, looped, cross-faded at the beat where it changes
  bed, bed2      ambience loops per place and time (by day: the embers and a breeze together)
  bed3           the heartbeat: one strip under the whole vote, and under the wolves' inner monologues
  oneshot        one effect at a moment of a beat (seconds after its start, or ("end", seconds before its end))
Everything but the voices is ducked while someone speaks; the ducking holds through continuous dialogue.
A sound id that is not prepared yet is skipped with a note, so the rest still plays.
"""
import json
import os
import sys
import wave

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # this Blender folder ("2 Werewolf Blender")
SOUNDS = os.path.join(BASE, "sounds")
FPS = 24
XFADE = 1.5  # s: music and ambience cross-fade where they change
REST = 60.0  # s of round 2 with ambience only
TENSION = 90.0  # s before the day's rebuttal / vote when the tension music comes in; between the rest and then, a drone
# volume when nobody speaks / under a voice (the files are already levelled per layer by prep_sounds.py)
LEVELS = {"music": (1.0, 0.6), "bed": (1.0, 0.65), "bed2": (1.0, 0.65), "bed3": (1.0, 0.75), "oneshot": (1.0, 0.8)}
# voices closer than MERGE count as one (the ducking holds between speakers); the effect pre-rolls (>= 1.25 s after a
# beat's pause) stay outside it, so effects and the music between scenes are heard in full
MERGE, ATTACK, RELEASE = 1.5, 0.3, 0.8  # s: voices closer than MERGE count as one; duck in over ATTACK, back over RELEASE
WOLVES = {"werewolf", "big_bad_wolf", "accursed_wolf_father", "white_werewolf"}


def is_gallows(b):
    cam = b["shot"]["camera"]
    return b.get("context") == "last words" or "Gallows" in cam or "Crowd" in cam


def is_ending(b):
    return b["kind"] == "title" and b.get("text", "").endswith(("WIN", "WINS"))


def lead_of(b):
    """Seconds of an effect before the beat's voice starts (plan.py waits this long): the effect is heard on its own."""
    kind, text = b["kind"], b.get("text", "") or ""
    if kind == "title" and (text.startswith("NIGHT") or is_ending(b)):
        return 1.2
    if kind == "card" or text.startswith(("Claws scratch", "The pack has chosen", "Dawn. A cry rises")) or "climbs the gallows" in text:
        return 1.0
    return 0.0


def music_track(beats, starts):
    """[(music id or None, gain)] per beat: a small state machine over the story."""
    out, pack, r2 = [], False, None
    tense_at = {}  # day number -> frame where the tension music may start (TENSION s before the day's rebuttal/vote)
    for b, s in zip(beats, starts):
        if b.get("context") in ("rebuttal", "vote", "defence") or b["kind"] == "tally":
            tense_at.setdefault(b.get("phase", ""), s - TENSION * FPS)
    for b, s in zip(beats, starts):
        kind, ph, preset, scene = b["kind"], b.get("phase", ""), b["shot"]["preset"], b["shot"]["scene"]
        if kind == "thought" and out:
            out.append(out[-1])  # an inner monologue keeps the music of the scene it sits in
        elif is_ending(b):
            out.append(("M2", 1.0) if "WEREWOLVES" in b["text"] else ("M6", 1.0))
        elif kind == "transition":
            r2 = None  # a new day: its round 2 gets its own rest
            out.append(("M3", 0.8))
        elif kind == "title" and b.get("text", "").startswith("NIGHT"):
            pack = False
            out.append(("M1", 1.0))
        elif ph.startswith("Night"):
            pack = pack or scene == "Clearing"  # from the pack's gathering to dawn, one track: their deed
            out.append(("M2", 1.0) if pack else ("M1", 1.0))
        elif ph.startswith("Dawn") and preset == "dawn":
            out.append((None, 0))  # the discovery: no music, the birds and the gasp
        elif is_gallows(b):
            out.append(("M5", 1.0))
        elif b.get("context") in ("rebuttal", "vote", "defence") or kind == "tally":
            out.append(("M4", 0.8))
        elif b.get("context") == "discussion" and b.get("round", 1) >= 2:
            r2 = r2 if r2 is not None else s
            if s - r2 < REST * FPS:
                out.append((None, 0))  # a rest: ambience only
            elif s < tense_at.get(ph, 1e9):
                out.append(("M1", 0.5))  # a low drone while suspicion builds
            else:
                out.append(("M4", 0.8))  # the tension, into the rebuttals and the vote
        else:
            out.append(("M3", 0.8))  # the day: low and calm
    return out


def beds(b):
    """(bed, bed2, bed3) ids for a beat; bed gains come with the id as (id, gain)."""
    scene, preset, cam = b["shot"]["scene"], b["shot"]["preset"], b["shot"]["camera"]
    heart = ("S15", 1.0) if b.get("context") == "vote" or (b["kind"] == "thought" and b.get("team", {}).get("wolf")) else None
    if is_ending(b):
        return ("A5", 1.0), None, None
    if scene == "Clearing":
        return ("A2", 1.0), None, heart
    if scene == "Street":
        return ("A5", 1.0), ("A1", 0.6), heart
    if preset == "night":
        return ("A1", 0.5 if scene == "Room" else 1.0), None, heart  # indoors: the night outside, half as loud
    if preset == "dawn" or b["kind"] == "transition":
        return ("A3", 1.0), None, heart
    if preset == "dusk" or is_gallows(b):
        return ("A5", 1.0), None, heart
    return ("A4", 1.0), ("A5", 0.7), heart  # the day: embers and a breeze


def oneshots(b, nxt):
    """[(sound id, when, gain)]: when = seconds after the beat starts, or ("end", seconds before it ends)."""
    kind, text = b["kind"], b.get("text", "") or ""
    out = []
    if kind == "title" and text.startswith("NIGHT"):
        out.append(("S1", 0.1, 0.8))
    if is_ending(b) and "WEREWOLVES" in text:
        out += [("S1", 0.1, 0.85), ("S2", 4.5, 0.8)]
    elif is_ending(b):
        out.append(("S8", 0.6, 0.6))
    if kind == "narration":
        if text.startswith("The Seer looks"):
            out.append(("S12", 0.6, 0.55))
        if text.startswith("The Witch wakes"):
            out += [("S13", 0.6, 0.7), ("S14", 2.4, 0.6)]
        if b.get("walk"):
            out.append(("S2", ("end", 2.5), 0.5))
        if text.startswith("The pack has chosen"):
            out.append(("S16", 0.1, 0.75))
        if text.startswith("Claws scratch"):
            out.append(("S6", 0.3, 0.85))
        if text.startswith("Dawn. A cry rises"):
            out.append(("S9", 0.5, 0.65))
        if "climbs the gallows" in text:
            out += [("S16", 0.0, 0.8), ("S10", 0.6, 0.3)]  # the verdict lands on the vote build's end; a muffled murmur
        # Game 2 moments (owner, 2026-10-22). S19-S21 are the owner's picks from sounds/candidates (until they are
        # prepared, each is skipped with a note, so the rest still plays)
        if "was the Hunter" in text and "last shot" in text:
            out += [("S19", 1.6, 0.85), ("S16", 1.7, 0.6)]  # the crossbow, as the narrator says "fires"
        if text.endswith("is the new Sheriff."):
            out.append(("S20", 0.2, 0.6))
        if "hands the Sheriff's badge" in text:
            out.append(("S21", 0.5, 0.6))
    if kind == "card":
        out += [("S16", 0.0, 0.6), ("S8", 0.5, 0.6)]
    if kind == "tally":
        # the vote's build before a hanging: S18, the owner's pick (the S17 drum roll was dropped, owner 2026-10-22)
        out.append(("S18", ("end", 5.0), 0.6) if nxt and "climbs the gallows" in (nxt.get("text") or "") else ("S16", 0.0, 0.5))
    if kind == "speech" and b.get("context") == "last words" and b.get("page", 1) == 1:
        out.append(("S11", 0.0, 0.45))
    return out


def sections(keys, starts, frames):
    """Consecutive beats with the same (id, gain) -> [id, gain, first frame, last frame]. Keep one gain per track within a
    stretch: a different gain starts a new section, and the track would restart."""
    out = []
    for k, s, f in zip(keys, starts, frames):
        if out and out[-1][0] == k:
            out[-1][2] = s + f
        else:
            out.append([k, s, s + f])
    return [(k[0], k[1], a, e) for k, a, e in out if k and k[0]]


def duck_ranges(voiced):
    """Voiced stretches, merged where the gap is under MERGE seconds (no pumping between lines)."""
    out = []
    for a, e in sorted(voiced):
        if out and a - out[-1][1] < MERGE * FPS:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([a, e])
    return out


def main(gid):
    gdir = os.path.join(BASE, "games", gid)
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    plan = json.load(open(os.path.join(gdir, "plan.json"), encoding="utf-8"))
    lib = json.load(open(os.path.join(SOUNDS, "library.json"), encoding="utf-8"))
    beats = [ep["beats"][pb["index"]] for pb in plan["beats"]]
    frames = [pb["frames"] for pb in plan["beats"]]
    starts, f = [], 1
    for n in frames:
        starts.append(f)
        f += n
    total = f - 1
    voiced = []
    for pb, s in zip(plan["beats"], starts):
        if pb.get("voice") and os.path.exists(pb["voice"]):
            with wave.open(pb["voice"], "rb") as w:
                secs = w.getnframes() / w.getframerate()
            voiced.append((s + pb["voice_at"], s + pb["voice_at"] + round(secs * FPS)))
    cues, missing = [], set()

    def have(sid):
        if sid in lib and os.path.exists(os.path.join(SOUNDS, lib[sid]["file"])):
            return True
        missing.add(sid)
        return False

    x = round(XFADE * FPS)
    layers = {"music": music_track(beats, starts)}
    bb = [beds(b) for b in beats]
    for n, layer in enumerate(("bed", "bed2", "bed3")):
        layers[layer] = [t[n] for t in bb]
    for layer, keys in layers.items():
        for sid, gain, a, e in sections(keys, starts, frames):
            if not have(sid):
                continue
            hi, lo = LEVELS[layer]
            cues.append({"id": sid, "layer": layer, "file": lib[sid]["file"], "start": a, "end": min(total, e + x), "loop": True,
                         "fade_in": x if a > 1 else 12, "fade_out": x, "high": round(hi * gain, 3), "low": round(lo * gain, 3)})
    for i, (b, s, n) in enumerate(zip(beats, starts, frames)):
        for sid, when, gain in oneshots(b, beats[i + 1] if i + 1 < len(beats) else None):
            if not have(sid):
                continue
            at = s + n - round(when[1] * FPS) if isinstance(when, tuple) else s + round(when * FPS)
            ln = round(lib[sid].get("seconds", lib[sid].get("length", 4.0)) * FPS)
            hi, lo = LEVELS["oneshot"]
            cues.append({"id": sid, "layer": "oneshot", "file": lib[sid]["file"], "start": at, "end": min(total, at + ln), "loop": False,
                         "fade_in": 1, "fade_out": 2, "high": round(hi * gain, 3), "low": round(lo * gain, 3)})
    out = {"fps": FPS, "duck": duck_ranges(voiced), "attack": round(ATTACK * FPS), "release": round(RELEASE * FPS),
           "cues": cues, "missing": sorted(missing)}
    with open(os.path.join(gdir, "sound_cues.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1)
    count = {}
    for c in cues:
        count[c["layer"]] = count.get(c["layer"], 0) + 1
    print(f"[sound] {len(cues)} cues {count}" + (f"; not prepared yet: {', '.join(sorted(missing))}" if missing else ""))


if __name__ == "__main__":
    main(sys.argv[1])
