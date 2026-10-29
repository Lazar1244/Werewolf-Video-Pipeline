"""The vertical Short (owner, 2026-10-20): the intro as it was first made (INTRO_PLAN.md, Option A, the 49.5 s first
render): the cold open (the wolf's own lie and its inner voice), the six AIs, the roles, the stakes over the game's
best moments, "Can they catch Fable in time? Let's play." - re-framed for a phone screen (1080x1920).

    python director/short_intro.py <id8>

Reads the game (episode.json, plan.json) and FullGameFolder/<id8>/short_voices.json (the original host take: the
three lines the final intro reworded are cut back out of _host_all.wav). Writes games/<id8>/short/intro_plan.json,
the same shot list format as intro.py, plus for the vertical frame:
    "vfit": how much taller than the 16:9 shot's view the 9:16 frame sees (1 = the same height: a sharp centre
            crop of the original framing; more = the camera sees wider, for the group shots)
    "aim":  re-aim the camera at the subject (the speaker / the stage's nearest mark) so it sits mid-frame
and "captions": the host's lines as big on-screen words (Shorts are often watched muted).
Then: render_intro.py -- <id8> --plan short (stages), render_clips.py ... --only <clips> --outdir short/gclips
(the game's moments, vertical), short_overlays.py, encode_intro.py -- <id8> --plan short.
"""
import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIPE = os.path.dirname(BASE)
FPS = 24
LEAD, PAD = 0.12, 0.25  # s before a line starts in its shot / after it ends: tight, energetic cuts
SIZE = [1080, 1920]


def f(s):
    return max(2, round(s * FPS))


def main(gid):
    gdir = os.path.join(BASE, "games", gid)
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    plan = json.load(open(os.path.join(gdir, "plan.json"), encoding="utf-8"))
    V = json.load(open(os.path.join(PIPE, "FullGameFolder", gid, "short_voices.json"), encoding="utf-8"))
    seats = {s["seat"]: s for s in ep["seats"]}
    holds = {pb["index"]: pb["hold"] for pb in plan["beats"]}

    def beat_clip(test):
        i = next(i for i, b in enumerate(ep["beats"]) if test(b))
        return holds[i]

    wolf_seat = next(s for s, x in seats.items() if x["call"] == "Fable")
    talk = beat_clip(lambda b: b["kind"] == "speech" and "What stands out now is Grok" in b.get("text", ""))
    think = beat_clip(lambda b: b["kind"] == "thought" and b.get("seat") == wolf_seat and "Three leans" in b.get("text", ""))
    vote = beat_clip(lambda b: b.get("context") == "vote")
    gallows = beat_clip(lambda b: b.get("context") == "last words")
    dawn = beat_clip(lambda b: b["kind"] == "card" and "Bodies" in b["shot"]["camera"])
    order = ["Fable", "Opus", "Sol", "Astra", "Gemini", "Grok"]  # the roll-call, in the order the host says them
    by_call = {x["call"]: s for s, x in seats.items()}

    def line(k):
        return f(V[k]["seconds"] + LEAD + PAD)

    shots = []

    def add(**kw):
        kw.setdefault("vfit", 1.0)
        kw.setdefault("aim", False)
        shots.append(kw)

    # 1-2: the cold open, the wolf's own words (re-rendered upright), then its thought under the red haze
    add(id="cold_say", source="game", clip=talk, frames=line("c1"), voice="c1", voice_at=f(LEAD), vfit=0.6, aim=True,
        overlay={"kind": "say", "seat": wolf_seat, "text": V["c1"]["text"], "tag": seats[wolf_seat]["model_short"]}, push=1.04,
        sfx=[("S15", 0.0, 0.6)])
    add(id="cold_think", source="game", clip=think, frames=line("c2") + f(0.3), voice="c2", voice_at=f(LEAD), vfit=0.6, aim=True,
        overlay={"kind": "think", "seat": wolf_seat, "text": V["c2"]["text"], "caption": "SECRETLY A WEREWOLF"}, push=1.12,
        sfx=[("S15", 0.0, 0.9)])
    # 3: the lineup, spotlights snapping on
    add(id="lineup", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("h3"), voice="h3", voice_at=f(0.35),
        effects={"spots_on": 0.12}, push=0.12, vfit=2.6, overlay=None, sfx=[("S16", 0.0, 0.8)])
    # 4: the roll-call, a close-up per name
    n = line("h4")
    per = n // 6
    for k, call in enumerate(order):
        seat = by_call[call]
        add(id=f"roll_{call}", source="stage", scene="Intro_Lineup", camera=f"Lineup_{seat}", frames=per if k < 5 else n - per * 5,
            voice="h4" if k == 0 else None, voice_at=f(LEAD), push=0.06, effects={}, vfit=1.3, aim=True,
            overlay={"kind": "name", "seat": seat, "text": seats[seat]["model_short"]}, sfx=[("S16", 0.0, 0.35)])
    # 5: every figure's eyes flicker red in turn
    add(id="eyes", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("h5"), voice="h5", voice_at=f(LEAD),
        effects={"red_eyes": [by_call[c] for c in order]}, push=0.15, vfit=2.6, overlay=None, sfx=[])
    # 6-9: the roles, two cuts each (the second on the line's turn)
    roles = [("h6", "Werewolf", "Werewolf_Hero", "Werewolf_Eyes", "KILLS AT NIGHT", 0.5, [("S1", 0.0, 0.55)]),
             ("h7", "Seer", "Seer_Hero", "Seer_Reveal", "SEES ONE TRUTH", 0.62, [("S12", 0.0, 0.6)]),
             ("h8", "Witch", "Witch_Save", "Witch_Kill", "SAVE OR KILL", 0.5, [("S13", 0.1, 0.6)]),
             ("h9", "Villager", "Villager_Wide", "Villager_Hero", "VOTE THEM OUT", 0.5, [("S10", 0.0, 0.35)])]
    for k, role, cam1, cam2, cap, split, sfx in roles:
        n = line(k) + f(0.25)
        a = round(n * split)
        fx = {"shadow_slide": True} if role == "Villager" else {}
        add(id=f"{role}_1", source="stage", scene=f"Intro_{role}", camera=cam1, frames=a, voice=k, voice_at=f(LEAD), push=0.08, effects=fx,
            vfit=1.5, overlay={"kind": "role", "role": role.upper(), "caption": cap}, sfx=[("S16", 0.0, 0.7)] + sfx)
        add(id=f"{role}_2", source="stage", scene=f"Intro_{role}", camera=cam2, frames=n - a, voice=None, push=0.1, effects={},
            vfit=1.5, overlay={"kind": "role", "role": role.upper(), "caption": cap}, sfx=[("S14", 0.0, 0.4)] if role == "Witch" else [])
    # 10: the stakes over the game's best moments: the vote, the gallows, the dawn
    n = line("h10")
    for k, (clip, name, vfit, aim) in enumerate(((vote, "vote", 1.6, False), (gallows, "gallows", 1.3, True), (dawn, "dawn", 1.7, False))):
        add(id=f"stakes_{name}", source="game", clip=clip, frames=n // 3 if k < 2 else n - 2 * (n // 3), voice="h10" if k == 0 else None,
            voice_at=f(LEAD), push=1.08, vfit=vfit, aim=aim, overlay=None, sfx=[("S16", 0.0, 0.5)] if k else [])
    # 11: the title over the werewolf on its rock, the howl
    add(id="title", source="stage", scene="Intro_Werewolf", camera="Werewolf_Hero", frames=line("h11") + f(3.0), voice="h11", voice_at=f(LEAD),
        push=0.1, effects={}, vfit=1.5,
        overlay={"kind": "title", "text": "WEREWOLF", "sub": "AI EDITION", "cta": "FULL GAME ON THE CHANNEL", "at": V["h11"]["seconds"] + LEAD},
        sfx=[("S16", V["h11"]["seconds"] + LEAD, 0.9), ("S1", V["h11"]["seconds"] + LEAD + 0.2, 0.9)])
    out = os.path.join(gdir, "short")
    os.makedirs(out, exist_ok=True)
    plan_out = {"game": gid, "fps": FPS, "size": SIZE, "captions": True, "shots": shots, "voices": V,
                "music": {"id": "M4", "from": "lineup", "level": 0.55}}
    with open(os.path.join(out, "intro_plan.json"), "w", encoding="utf-8") as fh:
        json.dump(plan_out, fh, indent=1, ensure_ascii=False)
    total = sum(s["frames"] for s in shots)
    games = sorted({s["clip"] for s in shots if s["source"] == "game"})
    print(f"[short] {len(shots)} shots, {total / FPS:.1f} s; stage shots {sum(1 for s in shots if s['source'] == 'stage')}; "
          f"game clips {','.join(games)}")


def main2(gid):
    """Short 2 (owner, 2026-10-21: Short 1 lost 58% in the first seconds and the viewers who stayed left at the role
    cards): the premise first ("I made the six smartest AIs compete in a game of Werewolf."), then "two of them are
    secretly werewolves", then the lie as the payoff (Fable's words, its thought), the stakes over the game's moments,
    "Can they catch Fable in time? Let's play." No role cards; about 26 s. Every line already voiced
    (FullGameFolder/<id8>/short2_voices.json). Writes games/<id8>/short2/intro_plan.json."""
    gdir = os.path.join(BASE, "games", gid)
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    plan = json.load(open(os.path.join(gdir, "plan.json"), encoding="utf-8"))
    V = json.load(open(os.path.join(PIPE, "FullGameFolder", gid, "short2_voices.json"), encoding="utf-8"))
    seats = {s["seat"]: s for s in ep["seats"]}
    holds = {pb["index"]: pb["hold"] for pb in plan["beats"]}

    def beat_clip(test):
        return holds[next(i for i, b in enumerate(ep["beats"]) if test(b))]

    wolf_seat = next(s for s, x in seats.items() if x["call"] == "Fable")
    by_call = {x["call"]: s for s, x in seats.items()}
    order = ["Fable", "Opus", "Sol", "Astra", "Gemini", "Grok"]

    def line(k):
        return f(V[k]["seconds"] + LEAD + PAD)

    shots = []

    def add(**kw):
        kw.setdefault("vfit", 1.0)
        kw.setdefault("aim", False)
        shots.append(kw)

    # 1: the premise, at once, over the lineup as the spotlights snap on
    add(id="lineup", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("h3"), voice="h3", voice_at=f(0.05),
        effects={"spots_on": 0.08}, push=0.12, vfit=2.6, overlay=None, sfx=[("S16", 0.0, 0.8)])
    # 2: two of them are wolves: every figure's eyes flash red in turn, a heartbeat
    add(id="eyes", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("h5"), voice="h5", voice_at=f(LEAD),
        effects={"red_eyes": [by_call[c] for c in order]}, push=0.15, vfit=2.6, overlay=None, sfx=[("S15", 0.0, 0.8)])
    # 3-4: the payoff: one of them, lying, then its secret thought
    talk = beat_clip(lambda b: b["kind"] == "speech" and "What stands out now is Grok" in b.get("text", ""))
    think = beat_clip(lambda b: b["kind"] == "thought" and b.get("seat") == wolf_seat and "Three leans" in b.get("text", ""))
    add(id="cold_say", source="game", clip=talk, frames=line("c1"), voice="c1", voice_at=f(LEAD), vfit=0.6, aim=True,
        overlay={"kind": "say", "seat": wolf_seat, "text": V["c1"]["text"], "tag": seats[wolf_seat]["model_short"]}, push=1.04,
        sfx=[("S16", 0.0, 0.5), ("S15", 0.0, 0.6)])
    add(id="cold_think", source="game", clip=think, frames=line("c2") + f(0.3), voice="c2", voice_at=f(LEAD), vfit=0.6, aim=True,
        overlay={"kind": "think", "seat": wolf_seat, "text": V["c2"]["text"], "caption": "SECRETLY A WEREWOLF"}, push=1.12,
        sfx=[("S15", 0.0, 0.9)])
    # 5: the stakes over the game's moments: the vote, the gallows, the dawn
    vote = beat_clip(lambda b: b.get("context") == "vote")
    gallows = beat_clip(lambda b: b.get("context") == "last words")
    dawn = beat_clip(lambda b: b["kind"] == "card" and "Bodies" in b["shot"]["camera"])
    n = line("h10")
    for k, (clip, name, vfit, aim) in enumerate(((vote, "vote", 1.6, False), (gallows, "gallows", 1.3, True), (dawn, "dawn", 1.7, False))):
        add(id=f"stakes_{name}", source="game", clip=clip, frames=n // 3 if k < 2 else n - 2 * (n // 3), voice="h10" if k == 0 else None,
            voice_at=f(LEAD), push=1.08, vfit=vfit, aim=aim, overlay=None, sfx=[("S16", 0.0, 0.5)])
    # 6: the title, the howl, the way to the full game
    add(id="title", source="stage", scene="Intro_Werewolf", camera="Werewolf_Hero", frames=line("h11") + f(3.0), voice="h11", voice_at=f(LEAD),
        push=0.1, effects={}, vfit=1.5,
        overlay={"kind": "title", "text": "WEREWOLF", "sub": "AI EDITION", "cta": "FULL GAME ON THE CHANNEL", "at": V["h11"]["seconds"] + LEAD},
        sfx=[("S16", V["h11"]["seconds"] + LEAD, 0.9), ("S1", V["h11"]["seconds"] + LEAD + 0.2, 0.9)])
    out = os.path.join(gdir, "short2")
    os.makedirs(out, exist_ok=True)
    plan_out = {"game": gid, "fps": FPS, "size": SIZE, "captions": True, "shots": shots, "voices": V,
                "music": {"id": "M4", "from": "lineup", "level": 0.5}}
    with open(os.path.join(out, "intro_plan.json"), "w", encoding="utf-8") as fh:
        json.dump(plan_out, fh, indent=1, ensure_ascii=False)
    print(f"[short2] {len(shots)} shots, {sum(s['frames'] for s in shots) / FPS:.1f} s")


def main3(gid):
    """Short 3 (owner, 2026-10-21, option B): the video's final intro without the role cards: the premise, the
    roll-call, "two of them are secretly werewolves", the stakes over the intro's own stages, "Who's lying? Who
    survives? Let the game begin." and FULL GAME ON THE CHANNEL. No game footage (no spoilers); about 24 s. Every line
    already voiced (FullGameFolder/<id8>/short3_voices.json). Its lineup and eyes shots match Short 2's and its
    roll-call Short 1's (same spec), so those renders are reused. Writes games/<id8>/short3/intro_plan.json."""
    gdir = os.path.join(BASE, "games", gid)
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    V = json.load(open(os.path.join(PIPE, "FullGameFolder", gid, "short3_voices.json"), encoding="utf-8"))
    seats = {s["seat"]: s for s in ep["seats"]}
    by_call = {x["call"]: s for s, x in seats.items()}
    order = ["Fable", "Opus", "Sol", "Astra", "Gemini", "Grok"]

    def line(k):
        return f(V[k]["seconds"] + LEAD + PAD)

    shots = []

    def add(**kw):
        kw.setdefault("vfit", 1.0)
        kw.setdefault("aim", False)
        shots.append(kw)

    # 1: the premise, at once, over the lineup as the spotlights snap on (as Short 2)
    add(id="lineup", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("h3"), voice="h3", voice_at=f(0.05),
        effects={"spots_on": 0.08}, push=0.12, vfit=2.6, overlay=None, sfx=[("S16", 0.0, 0.8)])
    # 2: the roll-call, a close-up per name (as Short 1)
    n = line("h4")
    per = n // 6
    for k, call in enumerate(order):
        seat = by_call[call]
        add(id=f"roll_{call}", source="stage", scene="Intro_Lineup", camera=f"Lineup_{seat}", frames=per if k < 5 else n - per * 5,
            voice="h4" if k == 0 else None, voice_at=f(LEAD), push=0.06, effects={}, vfit=1.3, aim=True,
            overlay={"kind": "name", "seat": seat, "text": seats[seat]["model_short"]}, sfx=[("S16", 0.0, 0.35)])
    # 3: two of them are wolves: every figure's eyes flash red in turn, a heartbeat (as Short 2)
    add(id="eyes", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("h5"), voice="h5", voice_at=f(LEAD),
        effects={"red_eyes": [by_call[c] for c in order]}, push=0.15, vfit=2.6, overlay=None, sfx=[("S15", 0.0, 0.8)])
    # 4: the stakes, over the intro's own stages (as the video's intro)
    n = line("h10")
    add(id="stakes_1", source="stage", scene="Intro_Lineup", camera="Lineup_Low", frames=n // 2, voice="h10", voice_at=f(LEAD), push=0.12,
        effects={}, vfit=2.6, overlay=None, sfx=[("S16", 0.0, 0.6)])
    add(id="stakes_2", source="stage", scene="Intro_Werewolf", camera="Werewolf_Wide", frames=n - n // 2, voice=None, push=0.1,
        effects={}, vfit=1.6, overlay=None, sfx=[("S16", 0.0, 0.5)])
    # 5: the title, the howl, the way to the full game (a short hold: the Short ends soon after the line)
    add(id="title", source="stage", scene="Intro_Werewolf", camera="Werewolf_Hero", frames=line("h11") + f(2.2), voice="h11", voice_at=f(LEAD),
        push=0.1, effects={}, vfit=1.5,
        overlay={"kind": "title", "text": "WEREWOLF", "sub": "AI EDITION", "cta": "FULL GAME ON THE CHANNEL", "at": V["h11"]["seconds"] + LEAD},
        sfx=[("S16", V["h11"]["seconds"] + LEAD, 0.9), ("S1", V["h11"]["seconds"] + LEAD + 0.2, 0.9)])
    out = os.path.join(gdir, "short3")
    os.makedirs(out, exist_ok=True)
    plan_out = {"game": gid, "fps": FPS, "size": SIZE, "captions": True, "shots": shots, "voices": V,
                "music": {"id": "M4", "from": "lineup", "level": 0.5}}
    with open(os.path.join(out, "intro_plan.json"), "w", encoding="utf-8") as fh:
        json.dump(plan_out, fh, indent=1, ensure_ascii=False)
    print(f"[short3] {len(shots)} shots, {sum(s['frames'] for s in shots) / FPS:.1f} s")


def g2short(gid):
    """Game 2's Short 1 (owner, 2026-10-24): it opens on the game itself (Fable's threat, Gemini's accusation, Sol's
    inner thought in the new inner-voice look, exactly as in the intro), then the premise over the lineup (no
    roll-call), then Astra's lie and Gemini calling it a lie (owner, same day: Sol's Hunter line and Astra's thought
    cut), then the intro's twist line over the wolf's eyes and its ending (the title, FULL GAME ON THE CHANNEL).
    Every line is the intro's take
    (FullGameFolder/<id8>/intro_voices.json). Writes games/<id8>/short_g2/intro_plan.json; the thoughts need their
    vertical data maps (render_clips.py ... --outdir short_g2/gclips --maps <seat>)."""
    gdir = os.path.join(BASE, "games", gid)
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    plan = json.load(open(os.path.join(gdir, "plan.json"), encoding="utf-8"))
    V = json.load(open(os.path.join(PIPE, "FullGameFolder", gid, "intro_voices.json"), encoding="utf-8"))
    seats = {s["seat"]: s for s in ep["seats"]}
    by_call = {x["call"]: s for s, x in seats.items()}
    holds = {pb["index"]: pb["hold"] for pb in plan["beats"]}

    def said(call, words, kind="speech"):
        return holds[next(i for i, b in enumerate(ep["beats"]) if b["kind"] == kind and b.get("seat") == by_call[call] and words in b.get("text", ""))]

    def line(k):
        return f(V[k]["seconds"] + LEAD + PAD)

    shots = []

    def add(**kw):
        kw.setdefault("vfit", 1.0)
        kw.setdefault("aim", False)
        kw.setdefault("effects", {})
        shots.append(kw)

    HIT = "S16"  # the whoosh / cut sound: the owner's pick from sounds/candidates replaces it

    def moment(sid, key, call, clip, kind, extra=0.25, cta=False):
        s = by_call[call]
        if kind == "say":
            ov = {"kind": "say", "seat": s, "text": V[key]["text"], "tag": seats[s]["model_short"]}
        else:  # the new inner voice: whole frames, the push drawn in
            ov = {"kind": "think", "fx": "dimension", "seat": s, "text": V[key]["text"], "map": f"{clip}_map{s}", "voice": key}
        if cta:
            ov["cta"] = "FULL GAME ON THE CHANNEL"
        add(id=sid, source="game", clip=clip, frames=line(key) + f(extra), voice=key, voice_at=f(LEAD), vfit=0.6, aim=True,
            push=1.05 if kind == "say" else 1.0, overlay=ov, sfx=[(HIT, 0.0, 0.45)])

    # 1-3: the game first: the threat, the accusation, the wolf's secret thought (as in the intro)
    moment("m1", "m1", "Fable", said("Fable", "Vote me out and I shoot someone"), "say")
    moment("m2", "m2", "Gemini", said("Gemini", "you are both the wolves"), "say")
    moment("m3", "m3", "Sol", said("Sol", "put the cards together", "thought"), "think", extra=0.35)
    # 4: the premise over the lineup as the spotlights snap on (no roll-call: owner)
    add(id="lineup", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("g1"), voice="g1", voice_at=f(0.1),
        effects={"spots_on": 0.08}, push=0.12, vfit=2.6, overlay=None, sfx=[(HIT, 0.0, 0.8)])
    # 5-6: the scene goes on, as in the intro: Astra's lie, and it is called a lie
    moment("m6", "m6", "Astra", said("Astra", "I'm the Witch, and I healed YOU"), "say")
    moment("m7", "m7", "Gemini", said("Gemini", "that is a desperate lie"), "say")
    # 7-8: the intro's ending: the twist, said plainly over the wolf's eyes (heartbeat, one hit), then the title
    add(id="twist", source="stage", scene="Intro_Werewolf", camera="Werewolf_Eyes", frames=line("g3"), voice="g3", voice_at=f(LEAD),
        push=0.1, vfit=1.5, overlay=None, sfx=[("S15", 0.0, 0.6), (HIT, V["g3"]["seconds"] * 0.75, 0.7)])
    add(id="title", source="stage", scene="Intro_Werewolf", camera="Werewolf_Hero", frames=line("h11") + f(2.2), voice="h11", voice_at=f(LEAD),
        push=0.1, vfit=1.5,
        overlay={"kind": "title", "text": "WEREWOLF", "sub": "AI EDITION", "cta": "FULL GAME ON THE CHANNEL", "at": V["h11"]["seconds"] + LEAD},
        sfx=[(HIT, V["h11"]["seconds"] + LEAD, 0.9), ("S1", V["h11"]["seconds"] + LEAD + 0.2, 0.9)])
    out = os.path.join(gdir, "short_g2")
    os.makedirs(out, exist_ok=True)
    plan_out = {"game": gid, "fps": FPS, "size": SIZE, "captions": True, "shots": shots, "voices": V,
                "music": {"id": "M4", "from": "m1", "level": 0.5}}
    with open(os.path.join(out, "intro_plan.json"), "w", encoding="utf-8") as fh:
        json.dump(plan_out, fh, indent=1, ensure_ascii=False)
    games = sorted({(s["clip"], s["overlay"]["seat"], s["overlay"].get("kind")) for s in shots if s["source"] == "game"})
    print(f"[short_g2] {len(shots)} shots, {sum(s['frames'] for s in shots) / FPS:.1f} s")
    print("GCLIPS " + ",".join(sorted({c for c, _, _ in games})))
    print("THINK " + " ".join(f"{c}:{s}" for c, s, k in games if k == "think"))


def g2short2(gid):
    """Game 2's Short 2 (owner, 2026-10-25): Sol's vote switch, about 25 s. Sol's public promise ("I'm voting Astra."),
    the premise in one host line (Sol is a wolf), Gemini's context (Astra outed himself, Sol is his partner), Sol's
    private thought at the vote in the new inner voice (he drops his own partner), his actual vote ("I vote for Fable."),
    then the end card (WEREWOLF, the howl, FULL GAME ON THE CHANNEL; no voice). Lines: FullGameFolder/<id8>/
    short2_voices.json (intro_voice.py --set short2). Writes games/<id8>/short2_g2/intro_plan.json."""
    gdir = os.path.join(BASE, "games", gid)
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    plan = json.load(open(os.path.join(gdir, "plan.json"), encoding="utf-8"))
    V = json.load(open(os.path.join(PIPE, "FullGameFolder", gid, "short2_voices.json"), encoding="utf-8"))
    seats = {s["seat"]: s for s in ep["seats"]}
    by_call = {x["call"]: s for s, x in seats.items()}
    holds = {pb["index"]: pb["hold"] for pb in plan["beats"]}

    def said(call, words, kind="speech"):
        return holds[next(i for i, b in enumerate(ep["beats"]) if b["kind"] == kind and b.get("seat") == by_call[call] and words in b.get("text", ""))]

    def line(k):
        return f(V[k]["seconds"] + LEAD + PAD)

    shots = []
    HIT = "S16"  # the whoosh / cut sound: the owner's pick from sounds/candidates replaces it

    def moment(sid, key, call, clip, kind, extra=0.25, vfit=0.6, aim=True):
        s = by_call[call]
        if kind == "say":
            ov = {"kind": "say", "seat": s, "text": V[key]["text"], "tag": seats[s]["model_short"]}
        else:  # the new inner voice: whole frames, the push drawn in
            ov = {"kind": "think", "fx": "dimension", "seat": s, "text": V[key]["text"], "map": f"{clip}_map{s}", "voice": key}
        shots.append(dict(id=sid, source="game", clip=clip, frames=line(key) + f(extra), voice=key, voice_at=f(LEAD), vfit=vfit,
                          aim=aim, effects={}, push=1.05 if kind == "say" else 1.0, overlay=ov, sfx=[(HIT, 0.0, 0.45)]))

    moment("s1", "s1", "Sol", said("Sol", "Grok's result gives me reason to trust you"), "say")  # the promise (Day 2)
    shots.append(dict(id="lineup", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("p1"), voice="p1",
                      voice_at=f(0.1), effects={"spots_on": 0.08}, push=0.12, vfit=2.6, aim=False, overlay=None, sfx=[(HIT, 0.0, 0.8)]))
    moment("s2", "s2", "Gemini", said("Gemini", "Astra just outed himself"), "say")
    moment("s3", "s3", "Sol", said("Sol", "made a mess of this", "thought"), "think", extra=0.35)
    # the vote is the game's overhead shot: framed wide like Game 1's vote shot (re-aimed it showed only the cobbles)
    moment("s4", "s4", "Sol", said("Sol", "I vote for Fable"), "say", extra=0.5, vfit=1.6, aim=False)
    shots.append(dict(id="title", source="stage", scene="Intro_Werewolf", camera="Werewolf_Hero", frames=f(3.4), voice=None, push=0.1,
                      vfit=1.5, aim=False, effects={},
                      overlay={"kind": "title", "text": "WEREWOLF", "sub": "AI EDITION", "cta": "FULL GAME ON THE CHANNEL", "at": 0.25},
                      sfx=[(HIT, 0.25, 0.9), ("S1", 0.45, 0.9)]))
    out = os.path.join(gdir, "short2_g2")
    os.makedirs(out, exist_ok=True)
    plan_out = {"game": gid, "fps": FPS, "size": SIZE, "captions": True, "shots": shots, "voices": V,
                "music": {"id": "M4", "from": "s1", "level": 0.5}}
    with open(os.path.join(out, "intro_plan.json"), "w", encoding="utf-8") as fh:
        json.dump(plan_out, fh, indent=1, ensure_ascii=False)
    games = sorted({(s["clip"], s["overlay"]["seat"], s["overlay"].get("kind")) for s in shots if s["source"] == "game"})
    print(f"[short2_g2] {len(shots)} shots, {sum(s['frames'] for s in shots) / FPS:.1f} s")
    print("GCLIPS " + ",".join(sorted({c for c, _, _ in games})))
    print("THINK " + " ".join(f"{c}:{s}" for c, s, k in games if k == "think"))


def g2short3(gid):
    """Game 2's Short 3, "Kill the Seer" (owner, 2026-10-26; FullGameFolder/Game 2/Shorts/Short 3 - SCRIPT.txt):
    Astra's secret thought at the Night 2 council (the hook, new inner voice), the premise, Grok's own Day 1 promise to
    look again, Sol agreeing on the kill, the claws at Grok's door (the narrator's own take), the dawn with Grok's body
    and his death card (no voice), and a voiced end card. The owner cut the Witch line and the card's narration after
    the first cut (39.7 s). Lines: FullGameFolder/<id8>/short3_voices.json
    (intro_voice.py --set short3). Writes games/<id8>/short3_g2/intro_plan.json."""
    gdir = os.path.join(BASE, "games", gid)
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    plan = json.load(open(os.path.join(gdir, "plan.json"), encoding="utf-8"))
    V = json.load(open(os.path.join(PIPE, "FullGameFolder", gid, "short3_voices.json"), encoding="utf-8"))
    for v in V.values():  # the game's own "..." came through as a broken character in some narrator lines
        v["text"] = v["text"].replace(chr(0xFFFD), "...")
    seats = {s["seat"]: s for s in ep["seats"]}
    by_call = {x["call"]: s for s, x in seats.items()}
    holds = {pb["index"]: pb["hold"] for pb in plan["beats"]}

    def beat(kind, words, call=None):
        return next(i for i, b in enumerate(ep["beats"]) if b["kind"] == kind and (call is None or b.get("seat") == by_call[call])
                    and words in (b.get("text") or ""))

    def line(k):
        return f(V[k]["seconds"] + LEAD + PAD)

    shots = []
    HIT = "S16"  # the whoosh / cut sound: the owner's pick from sounds/candidates replaces it

    def moment(sid, key, call, clip, kind, extra=0.25, vfit=0.6, aim=True):
        s = by_call[call]
        if kind == "say":
            ov = {"kind": "say", "seat": s, "text": V[key]["text"], "tag": seats[s]["model_short"]}
        else:  # the new inner voice: whole frames, the push drawn in
            ov = {"kind": "think", "fx": "dimension", "seat": s, "text": V[key]["text"], "map": f"{clip}_map{s}", "voice": key}
        shots.append(dict(id=sid, source="game", clip=clip, frames=line(key) + f(extra), voice=key, voice_at=f(LEAD), vfit=vfit,
                          aim=aim, effects={}, push=1.05 if kind == "say" else 1.0, overlay=ov, sfx=[(HIT, 0.0, 0.45)]))

    def told(sid, key, clip, sfx, vfit=1.0, extra=0.3):  # the narrator over the game's own shot (captions carry the words)
        shots.append(dict(id=sid, source="game", clip=clip, frames=line(key) + f(extra), voice=key, voice_at=f(LEAD), vfit=vfit,
                          aim=False, effects={}, push=1.05, overlay=None, sfx=sfx))

    # 1: the hook: Astra's private thought at the council (no thought beat in the video: on his council speech's shot)
    # the council's rock camera is already close: framed at 1.0 (0.6 cut off the name signs)
    moment("t1", "t1", "Astra", holds[beat("speech", "I suggest Grok", "Astra")], "think", extra=0.35, vfit=1.0)
    # 2: the premise over the spotlit lineup
    shots.append(dict(id="lineup", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("p1"), voice="p1",
                      voice_at=f(0.1), effects={"spots_on": 0.08}, push=0.12, vfit=2.6, aim=False, overlay=None, sfx=[(HIT, 0.0, 0.8)]))
    # 3-4: Grok's promise (Day 1), the wolves' decision (Night 2)
    moment("t2", "t2", "Grok", holds[beat("speech", "I'm the Seer. Last night", "Grok")], "say")
    moment("t3", "t3", "Sol", holds[beat("speech", "Agreed, Grok", "Sol")], "say", vfit=1.0)
    # 5: the night, in the narrator's own words: the claws at the door (owner's trim, same day: the Witch line is gone,
    # it raised a question the Short never answers)
    told("n1", "n1", holds[beat("narration", "Claws scratch at Grok")], [("S6", 0.15, 0.8)])
    # 6: the payoff: dawn, Grok's body by the fire, his death card; no narration (owner: the card already says it, and
    # the body with the gasp and the bell hits harder than a voice reading it)
    b = beat("card", "")
    cb = next(i for i in range(b, len(ep["beats"])) if ep["beats"][i]["kind"] == "card" and ep["beats"][i].get("seat") == by_call["Grok"])
    card = ep["beats"][cb]
    shots.append(dict(id="card", source="game", clip=holds[cb], frames=f(2.6), voice=None, vfit=1.0,
                      aim=False, effects={}, push=1.04, sfx=[("S9", 0.0, 0.6), ("S8", 0.25, 0.7), (HIT, 0.25, 0.6)],
                      overlay={"kind": "card", "seat": card["seat"], "name": card["name"], "role": card["role"], "cause": card["cause"],
                               "model": seats[card["seat"]]["model_short"]}))
    # 7: the end card, voiced (owner): "Full game out now on the channel."
    shots.append(dict(id="title", source="stage", scene="Intro_Werewolf", camera="Werewolf_Hero", frames=line("e1") + f(1.6), voice="e1",
                      voice_at=f(0.25), push=0.1, vfit=1.5, aim=False, effects={},
                      overlay={"kind": "title", "text": "WEREWOLF", "sub": "AI EDITION", "cta": "FULL GAME ON THE CHANNEL", "at": 0.25},
                      sfx=[(HIT, 0.25, 0.9), ("S1", 0.45, 0.9)]))
    out = os.path.join(gdir, "short3_g2")
    os.makedirs(out, exist_ok=True)
    plan_out = {"game": gid, "fps": FPS, "size": SIZE, "captions": True, "caption_speakers": ["Host", "Narrator"], "shots": shots,
                "voices": V, "music": {"id": "M2", "from": "t1", "level": 0.5}}  # M2: the pack in the forest until dawn
    with open(os.path.join(out, "intro_plan.json"), "w", encoding="utf-8") as fh:
        json.dump(plan_out, fh, indent=1, ensure_ascii=False)
    games = sorted({(s["clip"], (s["overlay"] or {}).get("seat"), (s["overlay"] or {}).get("kind")) for s in shots if s["source"] == "game"})
    print(f"[short3_g2] {len(shots)} shots, {sum(s['frames'] for s in shots) / FPS:.1f} s")
    print("GCLIPS " + ",".join(sorted({c for c, _, _ in games})))
    print("VFIT " + ",".join(f"{s['clip']}={s['vfit']}" for s in shots if s["source"] == "game"))
    print("AIM " + ",".join(s["clip"] for s in shots if s["source"] == "game" and s["aim"]))
    print("THINK " + " ".join(f"{c}:{s}" for c, s, k in games if k == "think"))


if __name__ == "__main__":
    version = sys.argv[sys.argv.index("--version") + 1] if "--version" in sys.argv else "1"
    {"1": main, "2": main2, "3": main3, "g2": g2short, "g2s2": g2short2, "g2s3": g2short3}[version](sys.argv[1])
