"""Step 3a: turn episode.json into plan.json: the clips to render and how each beat uses them (plain Python).

    python director/plan.py <id8>

Clips:
  loop        a seamless loop of L frames (rendered on twos) for a held shot: fire, breathing, talking, wind
  move        the camera gliding sideways round the circle to the next speaker (rendered on ones); figures keep moving.
              An inner thought adds one slight, slow zoom in toward the thinker (done in the edit: "push" on its loop)
  walk        the pack at the far end of the street walking away into the forest, seen from the street's start (on twos)
  transition  the same crane move rendered in two lights (dawn and day), cross-faded in the edit as the village wakes
Discussion framings ("circle:<seat>") are computed here from the manifest: a medium-wide view across the fire
toward the speaker; "circle:0" is the wide view of the whole circle.
"""
import hashlib
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import spoken  # noqa: E402
from sound import lead_of  # noqa: E402  (an effect that leads a beat: its voice waits)

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # this Blender folder ("2 Werewolf Blender")
FPS, L, MOVE = 24, 48, 36
PAD = {"speech": 0.7, "thought": 0.7, "narration": 0.6, "title": 0.8, "card": 1.4, "tally": 1.4, "transition": 0.6}  # s after a voice
LEAD = 0.25  # s between a beat's text appearing and its voice starting
PAD_CONT, LEAD_CONT = 0.2, 0.05  # between two screens of one speech: about a quarter second instead of about one
TRANSITION = 96  # frames: the dawn-to-day cross-fade (a longer voice holds its last frame)


def key(spec):
    return hashlib.sha1(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:14]


def circle_framing(marks, k):
    if k == 0:
        return {"loc": [1.2, -11.8, 7.0], "look": [0.0, 0.4, 0.6], "lens": 24}
    p = marks[f"Seat_{k}"]["loc"]
    a = math.atan2(p[1], p[0]) + math.pi + 0.38  # across the fire, a little to the side
    head = (p[0], p[1], 1.75)
    look = [head[0] * 0.8, head[1] * 0.8, 1.45]
    return {"loc": [round(6.8 * math.cos(a), 3), round(6.8 * math.sin(a), 3), 3.3], "look": [round(v, 3) for v in look], "lens": 32}


def lane_x(y):
    """The middle of the Street's crooked lane at y (as built in village/loc_street.py)."""
    return 0.8 * math.sin((y + 8) / 5.5 * 0.55)


WALK_SPEED = 1.45  # m/s: an unhurried walk
# the far end of the lane, then off to the right past the last house: from the street's start, a figure beyond
# x = 7.5 m there is hidden by that house's corner, with the forest behind (checked by ray casts from the camera)
WALK_PATH = [(2.4, 35.7), (5.2, 37.2), (8.4, 38.7), (11.0, 40.0), (14.0, 41.4)]  # clear of the hay cart
WALK_GAITS = [{"pace": 1.0, "stride": 0.70, "phase": 0.0, "bob": 0.045, "sway": 0.05},
              {"pace": 1.05, "stride": 0.62, "phase": 1.9, "bob": 0.038, "sway": 0.065},
              {"pace": 0.96, "stride": 0.76, "phase": 0.9, "bob": 0.05, "sway": 0.04}]
WALK_GAP = 2.4  # m between one wolf and the next, so their name signs never overlap


def walk_paths(seats):
    """The pack at the far end of the street, walking off one behind the other into the forest."""
    paths = {}
    for k, s in enumerate(seats):
        x0, y0 = WALK_PATH[0]
        x1, y1 = WALK_PATH[1]
        L = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        back = WALK_GAP * k  # further back along the way, so the later wolf follows the first
        pts = ([(x0 - (x1 - x0) / L * back, y0 - (y1 - y0) / L * back - 0.5 * k)] if k else []) + list(WALK_PATH)
        gait = WALK_GAITS[k % len(WALK_GAITS)]  # each wolf its own stride, pace and step timing: never in step
        paths[str(s)] = {"path": [[round(x, 3), round(y, 3)] for x, y in pts], "delay": 0.0, "speed": round(WALK_SPEED * gait["pace"], 3),
                         "ramp": 0.0, "stride": gait["stride"], "step_phase": gait["phase"], "bob": gait["bob"], "sway": gait["sway"]}
    return paths


def vote_framing(marks, seats):
    """The vote, from above the square (owner, 2026-10-16): centred on the seats in play (a small table fills only part
    of the ring), tilted a little so the far side's faces show. "top": the signs lie flat toward the camera."""
    xs = [marks[f"Seat_{s}"]["loc"][0] for s in seats]
    ys = [marks[f"Seat_{s}"]["loc"][1] for s in seats]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    return {"loc": [round(cx, 3), round(cy - 5.0, 3), 14.0], "look": [round(cx, 3), round(cy + 0.4, 3), 0.6], "lens": 27, "top": True}


# from the start of the street, a long lens down the whole lane to its far end
WALK_CAMERA = {"loc": [0.6, -9.0, 2.2], "look": [3.0, 36.0, 1.5], "lens": 55}


def camera_spec(manifest, scene, cam):
    if cam.startswith("circle:"):
        return circle_framing(manifest[scene]["marks"], int(cam.split(":")[1]))
    if cam.startswith("walk:"):
        return WALK_CAMERA
    if cam.startswith("vote_top:"):
        return vote_framing(manifest[scene]["marks"], [int(x) for x in cam.split(":")[1].split(",")])
    return {"preset": cam}


def main(gid):
    gdir = os.path.join(BASE, "games", gid)
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    manifest = json.load(open(os.path.join(BASE, "out", "manifest.json"), encoding="utf-8"))
    vpath = os.path.join(gdir, "voices.json")  # made by '3 Werewolf TTS/voice_episode.py': each beat lasts as long as its voice
    voices = json.load(open(vpath, encoding="utf-8")) if os.path.exists(vpath) else {}
    # a voice belongs to a beat by its speaker and words, not by the beat's number (scenes can be added later)
    takes = {(e["speaker"], e["text"]): e for e in voices.values() if os.path.exists(e["file"])}
    seat_info = {x["seat"]: x for x in ep["seats"]}
    clips, beats = {}, []
    prev = None  # (scene, preset, cast json, camera spec) of the previous beat
    for i, b in enumerate(ep["beats"]):
        sh = b["shot"]
        speaker, _, said = spoken.line(b, seat_info)
        v = takes.get((speaker, said))
        # one speech over several screens (owner: shorter pauses between them): a short pause before the next screen
        # of the same speech, and its voice starts almost at once
        goes_on = b.get("page", 1) < b.get("pages", 1)
        lead = (LEAD_CONT if b.get("page", 1) > 1 else LEAD) + lead_of(b)  # an effect-led beat: the effect first
        vframes = round((v["seconds"] + (PAD_CONT if goes_on else PAD.get(b["kind"], 0.6)) + lead) * FPS) if v else None
        total = (max(12, round(b["duration"] * FPS)) if not v else max(12, vframes)) + round(b.get("tail", 0) * FPS)  # tail: the ending holds
        cam = camera_spec(manifest, sh["scene"], sh["camera"])
        anim = b.get("anim") or {}
        base = {"scene": sh["scene"], "preset": sh["preset"], "cast": sh["cast"], "tokens": sh.get("tokens", {}), "anim": anim}
        segs = []
        if b["kind"] == "transition":
            total = max(TRANSITION, vframes or 0)
            night = {**base, "preset": b["from"], "cast": [{**m, "night": b["from"] == "night"} for m in sh["cast"]], "kind": "move", "frames": TRANSITION, "step": 2,
                     "camera_from": {"preset": sh["camera"], "dz": -1.2}, "camera_to": {"preset": sh["camera"]}}
            dawn = {**base, "kind": "move", "frames": TRANSITION, "step": 2, "camera_from": {"preset": sh["camera"], "dz": -1.2}, "camera_to": {"preset": sh["camera"]}}
            kn, kd = key(night), key(dawn)
            clips[kn], clips[kd] = night, dawn
            segs = [{"clip": kn, "frames": total, "crossfade_to": kd}]
            beats.append({"index": i, "frames": total, "segments": segs, "overlay_start": 0, "hold": kd, "cut": True,
                          **({"voice": v["file"], "voice_at": round(lead * FPS)} if v else {})})
            prev = None
            continue
        if b.get("walk"):  # the pack walking away down the street into the forest: one clip as long as the beat
            total = max(total, round(b["duration"] * FPS))
            walk = {**base, "kind": "walk", "camera": cam, "frames": total, "step": 2, "walk": walk_paths(b["walk"]["seats"])}
            wk = key(walk)
            clips[wk] = walk
            beats.append({"index": i, "frames": total, "segments": [{"clip": wk, "frames": total}], "overlay_start": 0, "hold": wk, "cut": True,
                          **({"voice": v["file"], "voice_at": round(lead * FPS)} if v else {})})
            prev = None
            continue
        same_stage = prev is not None and prev[0] == sh["scene"] and prev[1] == sh["preset"] and prev[2] == json.dumps(sh["cast"], sort_keys=True)
        moving = same_stage and "loc" in cam and "loc" in prev[3] and cam != prev[3]
        if v and moving:
            total = vframes + MOVE  # the glide first, then the voice
        hold = {**base, "kind": "loop", "camera": cam, "frames": L, "step": 2}
        if b["kind"] == "narration" and b.get("text", "").startswith("Claws scratch") and sh["camera"].startswith("Street_Door_"):
            # owner (2026-10-28): the claw marks cut into the door itself, one by one with the narration (render_clips
            # add_claws): a shot as long as the beat, so the marks stay once made (a 2-second loop would reset them)
            at = [round((lead + 0.1 + 0.5 * k) * FPS) for k in range(3)]
            hold = {**hold, "frames": total, "claws": {"at": at, "grow": 6}}
        hk = key(hold)
        clips[hk] = hold
        start = 0
        if moving:
            m = min(MOVE, total - 12)
            move = {**base, "kind": "move", "camera_from": prev[3], "camera_to": cam, "frames": m, "step": 1}
            mk = key(move)
            clips[mk] = move
            segs.append({"clip": mk, "frames": m})
            start = m
        segs.append({"clip": hk, "frames": total - start, "loop": True, **({"push": True} if b["kind"] == "thought" else {})})
        ov = start if b["kind"] in ("speech", "thought") else 0
        beats.append({"index": i, "frames": total, "segments": segs, "overlay_start": ov, "hold": hk, "cut": not same_stage,
                      **({"voice": v["file"], "voice_at": ov + round(lead * FPS)} if v else {})})
        prev = (sh["scene"], sh["preset"], json.dumps(sh["cast"], sort_keys=True), cam)
    seats = {str(x["seat"]): {"name": x["name"], "model": x["model_short"], "role": x["role"]} for x in ep["seats"]}  # for the name signs
    plan = {"game": gid, "fps": FPS, "L": L, "clips": clips, "beats": beats, "seats": seats}
    with open(os.path.join(gdir, "plan.json"), "w", encoding="utf-8") as f:
        json.dump(plan, f, indent=1)
    renders = sum(math.ceil(c["frames"] / c["step"]) for c in clips.values())
    loops = sum(1 for c in clips.values() if c["kind"] == "loop")
    moves = sum(1 for c in clips.values() if c["kind"] == "move")
    walks = sum(1 for c in clips.values() if c["kind"] == "walk")
    print(f"[plan] {len(beats)} beats -> {len(clips)} clips ({loops} loops, {moves} moves, {walks} walks), {renders} frames to render, "
          f"{sum(b['frames'] for b in beats) / FPS:.1f} s of video")


if __name__ == "__main__":
    main(sys.argv[1])
