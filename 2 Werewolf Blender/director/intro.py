"""The intro's shot list (INTRO_PLAN.md: the owner's version of 2026-10-19), timed to the voiced lines. Only the intro's
own stages: no cold open and no game footage (nothing that spoils the game).

    python director/intro.py <id8>

Game 2 (06ce0859) has its own shot list, game2() below: FullGameFolder/Game 2/Intro/INTRO_SCRIPT_v4.txt (owner,
2026-10-22): the hook over a fast spotlight across the seven, seven short best moments in the AIs' own voices (the
wolves' thoughts in the new inner-voice look, thought_fx.py), the rules (the game's own shots for the Hunter and the
Sheriff; no Challenge), then the twist line, plainly, and the title. 1920x1080. Run plan.py first (it reads plan.json).

Reads the game (episode.json, plan.json: the frames already rendered for the cold open and the montage) and
FullGameFolder/<id8>/intro_voices.json. Writes games/<id8>/intro/intro_plan.json: a list of shots, each
    {"id", "frames", "source": "stage" | "game", "scene"/"camera" or "clip", "effects", "overlay", "voice", "voice_at",
     "push": zoom factor over the shot (edit-time push for game shots; a camera dolly for stage shots), "sfx": [...]}
render_intro.py renders the stage shots from out/intro.blend, intro_overlays.py draws the text, encode_intro.py cuts it.
"""
import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIPE = os.path.dirname(BASE)
FPS = 24
LEAD, PAD = 0.12, 0.25  # s before a line starts in its shot / after it ends: tight, energetic cuts


def f(s):
    return max(2, round(s * FPS))


def main(gid):
    if gid.startswith("06ce0859"):
        return game2(gid)
    if gid.startswith("c0416225"):
        return game3(gid)
    gdir = os.path.join(BASE, "games", gid)
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    plan = json.load(open(os.path.join(gdir, "plan.json"), encoding="utf-8"))
    V = json.load(open(os.path.join(PIPE, "FullGameFolder", gid, "intro_voices.json"), encoding="utf-8"))
    seats = {s["seat"]: s for s in ep["seats"]}
    holds = {pb["index"]: pb["hold"] for pb in plan["beats"]}

    def beat_clip(test):
        i = next(i for i, b in enumerate(ep["beats"]) if test(b))
        return holds[i], i

    wolf_seat = next(s for s, x in seats.items() if x["call"] == "Fable")
    talk, ti = beat_clip(lambda b: b["kind"] == "speech" and "What stands out now is Grok" in b.get("text", ""))
    think, _ = beat_clip(lambda b: b["kind"] == "thought" and b.get("seat") == wolf_seat and "Three leans" in b.get("text", ""))
    vote, _ = beat_clip(lambda b: b.get("context") == "vote")
    gallows, _ = beat_clip(lambda b: b.get("context") == "last words")
    dawn, _ = beat_clip(lambda b: b["kind"] == "card" and "Bodies" in b["shot"]["camera"])
    order = ["Fable", "Opus", "Sol", "Astra", "Gemini", "Grok"]  # the roll-call, in the order the host says them
    by_call = {x["call"]: s for s, x in seats.items()}

    def line(k):
        return f(V[k]["seconds"] + LEAD + PAD)

    shots = []

    def add(**kw):
        shots.append(kw)

    # (owner, 2026-10-19: no cold open and no game footage in the intro: nothing that spoils the game)
    # 3: the lineup, spotlights snapping on
    add(id="lineup", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("h3"), voice="h3", voice_at=f(0.35),
        effects={"spots_on": 0.12}, push=0.12, overlay=None, sfx=[("S16", 0.0, 0.8)])
    # 4: the roll-call, a close-up per name
    n = line("h4")
    per = n // 6
    for k, call in enumerate(order):
        seat = by_call[call]
        add(id=f"roll_{call}", source="stage", scene="Intro_Lineup", camera=f"Lineup_{seat}", frames=per if k < 5 else n - per * 5,
            voice="h4" if k == 0 else None, voice_at=f(LEAD), push=0.06, effects={},
            overlay={"kind": "name", "seat": seat, "text": seats[seat]["model_short"]}, sfx=[("S16", 0.0, 0.35)])
    # 5: every figure's eyes flicker red in turn
    add(id="eyes", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("h5"), voice="h5", voice_at=f(LEAD),
        effects={"red_eyes": [by_call[c] for c in order]}, push=0.3, overlay=None, sfx=[("S15", 0.0, 0.8)])
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
            overlay={"kind": "role", "role": role.upper(), "caption": cap}, sfx=[("S16", 0.0, 0.7)] + sfx)
        add(id=f"{role}_2", source="stage", scene=f"Intro_{role}", camera=cam2, frames=n - a, voice=None, push=0.1, effects={},
            overlay={"kind": "role", "role": role.upper(), "caption": cap}, sfx=[("S14", 0.0, 0.4)] if role == "Witch" else [])
    # 10: the stakes, over the intro's own stages (no game footage: no spoilers)
    n = line("h10")
    add(id="stakes_1", source="stage", scene="Intro_Lineup", camera="Lineup_Low", frames=n // 2, voice="h10", voice_at=f(LEAD), push=0.12,
        effects={}, overlay=None, sfx=[("S16", 0.0, 0.6)])
    add(id="stakes_2", source="stage", scene="Intro_Werewolf", camera="Werewolf_Wide", frames=n - n // 2, voice=None, push=0.1,
        effects={}, overlay=None, sfx=[("S16", 0.0, 0.5)])
    # 11: the title over the werewolf on its rock, the howl
    add(id="title", source="stage", scene="Intro_Werewolf", camera="Werewolf_Hero", frames=line("h11") + f(3.0), voice="h11", voice_at=f(LEAD),
        push=0.1, effects={}, overlay={"kind": "title", "text": "WEREWOLF", "sub": "AI EDITION", "at": V["h11"]["seconds"] + LEAD},
        sfx=[("S16", V["h11"]["seconds"] + LEAD, 0.9), ("S1", V["h11"]["seconds"] + LEAD + 0.2, 0.9)])
    out = os.path.join(gdir, "intro")
    os.makedirs(out, exist_ok=True)
    plan_out = {"game": gid, "fps": FPS, "shots": shots, "voices": V, "music": {"id": "M4", "from": "lineup", "level": 0.55}}
    with open(os.path.join(out, "intro_plan.json"), "w", encoding="utf-8") as fh:
        json.dump(plan_out, fh, indent=1, ensure_ascii=False)
    total = sum(s["frames"] for s in shots)
    print(f"[intro] {len(shots)} shots, {total / FPS:.1f} s; stage shots to render: {sum(1 for s in shots if s['source'] == 'stage')}")


def game2(gid):
    gdir = os.path.join(BASE, "games", gid)
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    plan = json.load(open(os.path.join(gdir, "plan.json"), encoding="utf-8"))
    V = json.load(open(os.path.join(PIPE, "FullGameFolder", gid, "intro_voices.json"), encoding="utf-8"))
    seats = {s["seat"]: s for s in ep["seats"]}
    by_call = {x["call"]: s for s, x in seats.items()}
    holds = {pb["index"]: pb["hold"] for pb in plan["beats"]}

    def clip(test):
        return holds[next(i for i, b in enumerate(ep["beats"]) if test(b))]

    def said(call, words, kind="speech"):
        return clip(lambda b: b["kind"] == kind and b.get("seat") == by_call[call] and words in b.get("text", ""))

    def line(k):
        return f(V[k]["seconds"] + LEAD + PAD)

    shots = []

    def add(**kw):
        shots.append({"effects": {}, "overlay": None, "voice": None, "voice_at": f(LEAD), "sfx": [], **kw})

    HIT, WHOOSH = "S16", "S16"  # WHOOSH: the owner's pick from sounds/candidates (6 intro whoosh) replaces this
    # 1: the hook over a fast spotlight across the seven (owner: past them, not presenting each one)
    n = line("g1")
    wide = f(1.1)
    add(id="lineup", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=wide, voice="g1", voice_at=f(0.3),
        effects={"spots_on": 0.12}, push=0.06, sfx=[(HIT, 0.0, 0.8)])
    per = (n - wide) // 7
    for k in range(7):
        seat = k + 1
        add(id=f"spot_{seat}", source="stage", scene="Intro_Lineup", camera=f"Lineup_{seat}", frames=per if k < 6 else n - wide - per * 6,
            push=0.05, overlay={"kind": "name", "seat": seat, "text": seats[seat]["model_short"]}, sfx=[(HIT, 0.0, 0.35)])
    # 2: the best moments: only the most engaging words (script v4); a wolf's thought, then their lie. The thoughts use
    # the new inner voice (thought_fx.py: the other dimension; needs the clip's data map, render_clips.py --maps <seat>)
    moments = [("m1", "Fable", said("Fable", "Vote me out and I shoot someone"), "say"),
               ("m2", "Gemini", said("Gemini", "you are both the wolves"), "say"),
               ("m3", "Sol", said("Sol", "put the cards together", "thought"), "think"),
               ("m4", "Sol", said("Sol", "Yes, Gemini. I'm the Hunter"), "say"),
               ("m5", "Astra", said("Astra", "nowhere to hide", "thought"), "think"),
               ("m6", "Astra", said("Astra", "I'm the Witch, and I healed YOU"), "say"),
               ("m7", "Gemini", said("Gemini", "that is a desperate lie"), "say")]
    for k, (key, call, c, kind) in enumerate(moments):
        s = by_call[call]
        if kind == "say":
            ov = {"kind": "say", "seat": s, "text": V[key]["text"], "tag": seats[s]["model_short"]}
        else:  # the push in is drawn into the frames (opaque), so the edit adds none
            ov = {"kind": "think", "fx": "dimension", "seat": s, "text": V[key]["text"], "map": f"{c}_map{s}", "voice": key}
        add(id=f"moment_{k + 1}", source="game", clip=c, frames=line(key) + f(0.25), voice=key, push=1.06 if kind == "say" else 1.0,
            overlay=ov, sfx=[(WHOOSH, 0.0, 0.45)] if kind == "say" or key == "m3" else [])
    # 4-8: how it works
    fire = clip(lambda b: b["kind"] == "narration" and b["text"].startswith("Who will be Sheriff"))
    add(id="how", source="game", clip=fire, frames=line("g4"), voice="g4", push=1.04, sfx=[(HIT, 0.0, 0.6)])
    add(id="eyes", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("g5"), voice="g5",
        effects={"red_eyes": list(range(1, 8))}, push=0.06, sfx=[("S15", 0.0, 0.8)])  # a small push: all seven stay in
    n = line("g6")
    door = clip(lambda b: b["kind"] == "narration" and b["text"].startswith("Claws scratch"))
    add(id="night_1", source="game", clip=door, frames=n // 2, voice="g6", push=1.06, sfx=[("S6", 0.0, 0.6)])
    add(id="night_2", source="stage", scene="Intro_Werewolf", camera="Werewolf_Hero", frames=n - n // 2, push=0.08,
        overlay={"kind": "role", "role": "WEREWOLF", "caption": "KILL AT NIGHT. LIE BY DAY."}, sfx=[(HIT, 0.0, 0.7), ("S1", 0.0, 0.5)])
    n = line("g7")
    vote = clip(lambda b: b.get("context") == "vote" and b.get("text", "").startswith("I vote for"))
    card = clip(lambda b: b["kind"] == "card")
    add(id="day_1", source="game", clip=vote, frames=n // 2, voice="g7", push=1.05, sfx=[(HIT, 0.0, 0.5)])
    add(id="day_2", source="game", clip=card, frames=n - n // 2, push=1.06, sfx=[(HIT, 0.0, 0.7), ("S8", 0.0, 0.5)])
    n = line("g8")
    add(id="win_1", source="stage", scene="Intro_Lineup", camera="Lineup_Low", frames=n // 2, voice="g8", push=0.12, sfx=[(HIT, 0.0, 0.6)])
    add(id="win_2", source="stage", scene="Intro_Werewolf", camera="Werewolf_Wide", frames=n - n // 2, push=0.1, sfx=[(HIT, 0.0, 0.5)])
    # 9-14: the roles, each with its big word (the intro's stages; the game's own shots for the Hunter, Sheriff, Challenge)
    roles = [("g9", "SEER", "WOLF OR NOT?", [("stage", "Intro_Seer", "Seer_Hero"), ("stage", "Intro_Seer", "Seer_Reveal")], [("S12", 0.0, 0.6)]),
             ("g10", "WITCH", "HEAL OR POISON", [("stage", "Intro_Witch", "Witch_Save"), ("stage", "Intro_Witch", "Witch_Kill")], [("S13", 0.1, 0.6)]),
             ("g11", "HUNTER", "ONE LAST SHOT", [("game", said("Fable", "Vote me out and I shoot someone"), None)], []),
             ("g12", "VILLAGER", "VOICE AND VOTE", [("stage", "Intro_Villager", "Villager_Wide")], [("S10", 0.0, 0.35)]),
             ("g13", "SHERIFF", "DOUBLE VOTE", [("game", said("Sol", "before I use my double vote"), None)], [])]
    for k, word, cap, cuts, sfx in roles:
        n = line(k) + f(0.25)
        for j, (src, a, b) in enumerate(cuts):
            frames = n // len(cuts) if j < len(cuts) - 1 else n - (n // len(cuts)) * (len(cuts) - 1)
            ov = {"kind": "role", "role": word, "caption": cap}
            base = {"id": word.lower() + f"_{j + 1}", "frames": frames, "voice": k if j == 0 else None, "overlay": ov,
                    "sfx": ([(HIT, 0.0, 0.7)] + sfx) if j == 0 else []}
            if src == "stage":
                add(source="stage", scene=a, camera=b, push=0.08, effects={"shadow_slide": True} if word == "VILLAGER" else {}, **base)
            else:
                add(source="game", clip=a, push=1.08, **base)
    # 15: the stakes; then the twist, said plainly (owner: not too cinematic): the wolf's eyes, a heartbeat, one hit
    add(id="stakes", source="game", clip=fire, frames=line("g15"), voice="g15", push=1.05, sfx=[(HIT, 0.0, 0.6)])
    add(id="twist", source="stage", scene="Intro_Werewolf", camera="Werewolf_Eyes", frames=line("g3"), voice="g3", push=0.1,
        sfx=[("S15", 0.0, 0.6), (HIT, V["g3"]["seconds"] * 0.75, 0.7)])
    add(id="title", source="stage", scene="Intro_Werewolf", camera="Werewolf_Hero", frames=line("h11") + f(3.0), voice="h11", push=0.1,
        overlay={"kind": "title", "text": "WEREWOLF", "sub": "AI EDITION", "at": V["h11"]["seconds"] + LEAD},
        sfx=[(HIT, V["h11"]["seconds"] + LEAD, 0.9), ("S1", V["h11"]["seconds"] + LEAD + 0.2, 0.9)])
    out = os.path.join(gdir, "intro")
    os.makedirs(out, exist_ok=True)
    plan_out = {"game": gid, "fps": FPS, "size": [1920, 1080], "shots": shots, "voices": V, "music": {"id": "M4", "from": "lineup", "level": 0.55}}
    with open(os.path.join(out, "intro_plan.json"), "w", encoding="utf-8") as fh:
        json.dump(plan_out, fh, indent=1, ensure_ascii=False)
    total = sum(s["frames"] for s in shots)
    gclips = sorted({s["clip"] for s in shots if s["source"] == "game"})
    print(f"[intro] {len(shots)} shots, {total / FPS:.1f} s; stage shots: {sum(1 for s in shots if s['source'] == 'stage')}; game clips: {','.join(gclips)}")


def game3(gid):
    """Game 3 (c0416225): "Chinese AIs vs American AIs in a Werewolf Game (Round 1)", FullGameFolder/Game 3/Intro/
    INTRO_SCRIPT_v2.txt (owner, 2026-10-27; order changed 2026-10-28). The rivalry first, as a VS (Team China vs Team
    USA), then the hook (a lie caught in the act: Sol's Seer claim, Qwen's counter-claim and inner voice, the Night 2
    vision, DeepSeek's plan and her Hunter bluff), then the rules (Game 2's takes: the same cards), the fairness line over the two
    wolves' red eyes, and the send-off over the title with ROUND 1. No shot gives a death away: no death cards, and the
    Hunter and Sheriff are shown on Day 1. 1920x1080. Run plan.py first (it reads plan.json)."""
    gdir = os.path.join(BASE, "games", gid)
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    plan = json.load(open(os.path.join(gdir, "plan.json"), encoding="utf-8"))
    V = json.load(open(os.path.join(PIPE, "FullGameFolder", gid, "intro_voices.json"), encoding="utf-8"))
    for v in V.values():  # the game's own "..." reached some narrator takes as a broken character
        v["text"] = v["text"].replace(chr(0xFFFD), "...")
    seats = {s["seat"]: s for s in ep["seats"]}
    by_call = {x["call"]: s for s, x in seats.items()}
    holds = {pb["index"]: pb["hold"] for pb in plan["beats"]}

    def clip(test):
        return holds[next(i for i, b in enumerate(ep["beats"]) if test(b))]

    def said(call, words, kind="speech"):
        return clip(lambda b: b["kind"] == kind and b.get("seat") == by_call[call] and words in b.get("text", ""))

    def line(k):
        return f(V[k]["seconds"] + LEAD + PAD)

    shots = []

    def add(**kw):
        shots.append({"effects": {}, "overlay": None, "voice": None, "voice_at": f(LEAD), "sfx": [], **kw})

    HIT, WHOOSH = "S16", "S16"  # WHOOSH: the owner's pick from sounds/candidates (6 intro whoosh) replaces this
    china = [s for s, x in seats.items() if x["call"] in ("DeepSeek", "Qwen")]
    # 1: the rivalry as a VS, first (owner, 2026-10-28: a long video opens on the matchup, then the hook). Both teams in
    # full first (owner, 2026-10-27: Team China on the left as werewolves under red spotlights, a gap, Team USA on the
    # right in their roles), then a zoom on each TEAM (not on each player), timed to the words: "...two Chinese AIs the secret werewolves" on Team China, "...against five American AIs" on Team USA
    n = line("r1")
    a, b = round(n * 0.45), round(n * 0.75)
    add(id="versus", source="stage", scene="Intro_Versus", camera="Versus_Wide", frames=a, voice="r1", voice_at=f(0.3),
        effects={"spots_on": 0.12}, push=0.05, overlay={"kind": "versus", "left": 0.135, "mid": 0.36, "right": 0.67},
        sfx=[(HIT, 0.0, 0.8)])
    add(id="team_china", source="stage", scene="Intro_Versus", camera="Versus_China", frames=b - a, push=0.06,
        overlay={"kind": "team", "team": "TEAM CHINA"}, sfx=[(HIT, 0.0, 0.6), ("S1", 0.0, 0.35)])
    add(id="team_usa", source="stage", scene="Intro_Versus", camera="Versus_USA", frames=n - b, push=0.06,
        overlay={"kind": "team", "team": "TEAM USA"}, sfx=[(HIT, 0.0, 0.6)])
    # 2: the hook, after the matchup: each line on the game's own shot of the speaker; the thoughts in the new inner voice
    vision = clip(lambda b: b["kind"] == "narration" and b["text"].startswith("The Seer looks into DeepSeek"))
    night2 = clip(lambda b: b["kind"] == "narration" and b["text"].startswith("The pack has chosen: Sol"))
    moments = [("m1", "Sol", said("Sol", "Last night I checked Qwen"), "say"),
               ("m2", "Qwen", said("Qwen", "Sol is lying"), "say"),
               ("m3", "Qwen", said("Qwen", "challenge is the hardest", "thought"), "think"),
               ("m4", None, vision, "told"),
               ("m5", "DeepSeek", night2, "think"),  # no thought beat that night (a lone wolf has no council): the forest shot
               ("m6", "DeepSeek", said("DeepSeek", "I am the Hunter. Execute me"), "say")]
    for k, (key, call, c, kind) in enumerate(moments):
        s = by_call.get(call)
        if kind == "say":
            ov = {"kind": "say", "seat": s, "text": V[key]["text"], "tag": seats[s]["model_short"]}
        elif kind == "think":  # the push in is drawn into the frames (opaque), so the edit adds none
            ov = {"kind": "think", "fx": "dimension", "seat": s, "text": V[key]["text"], "map": f"{c}_map{s}", "voice": key}
        else:  # the narrator over the Seer's room: the vision itself, in red
            ov = {"kind": "role", "role": "WEREWOLF", "caption": "THE SEER'S VISION: DEEPSEEK"}
        add(id=f"moment_{k + 1}", source="game", clip=c, frames=line(key) + f(0.25), voice=key, push=1.06 if kind != "think" else 1.0,
            overlay=ov, sfx=[(WHOOSH, 0.0, 0.45)] + ([("S12", 0.1, 0.6)] if kind == "told" else []))
    # 3: the rules: Game 2's takes over this game's own shots (nothing that shows a death)
    fire = clip(lambda b: b["kind"] == "narration" and b["text"].startswith("Who will be Sheriff"))
    add(id="how", source="game", clip=fire, frames=line("g4"), voice="g4", push=1.04, sfx=[(HIT, 0.0, 0.6)])
    add(id="eyes", source="stage", scene="Intro_Lineup", camera="Lineup_Wide", frames=line("g5"), voice="g5",
        effects={"red_eyes": china, "red_eyes_hold": True}, push=0.06, sfx=[("S15", 0.0, 0.8)])  # the two wolves: the Chinese AIs, red and staying red
    n = line("g6")
    door = clip(lambda b: b["kind"] == "narration" and b["text"].startswith("Claws scratch"))
    add(id="night_1", source="game", clip=door, frames=n // 2, voice="g6", push=1.06, sfx=[("S6", 0.0, 0.6)])
    add(id="night_2", source="stage", scene="Intro_Werewolf", camera="Werewolf_Hero", frames=n - n // 2, push=0.08,
        overlay={"kind": "role", "role": "WEREWOLF", "caption": "KILL AT NIGHT. LIE BY DAY."}, sfx=[(HIT, 0.0, 0.7), ("S1", 0.0, 0.5)])
    vote = clip(lambda b: b.get("context") == "vote" and b.get("text", "").startswith("I vote for"))
    add(id="day_1", source="game", clip=vote, frames=line("g7"), voice="g7", push=1.05, sfx=[(HIT, 0.0, 0.5)])
    n = line("g8")
    add(id="win_1", source="stage", scene="Intro_Lineup", camera="Lineup_Low", frames=n // 2, voice="g8", push=0.12, sfx=[(HIT, 0.0, 0.6)])
    add(id="win_2", source="stage", scene="Intro_Werewolf", camera="Werewolf_Wide", frames=n - n // 2, push=0.1, sfx=[(HIT, 0.0, 0.5)])
    roles = [("g9", "SEER", "WOLF OR NOT?", [("stage", "Intro_Seer", "Seer_Hero"), ("stage", "Intro_Seer", "Seer_Reveal")], [("S12", 0.0, 0.6)]),
             ("g10", "WITCH", "HEAL OR POISON", [("stage", "Intro_Witch", "Witch_Save"), ("stage", "Intro_Witch", "Witch_Kill")], [("S13", 0.1, 0.6)]),
             ("g11", "HUNTER", "ONE LAST SHOT", [("game", said("Gemini", "are you kidding me"), None)], []),  # Day 1: the table still whole
             ("g12", "VILLAGER", "VOICE AND VOTE", [("stage", "Intro_Villager", "Villager_Wide")], [("S10", 0.0, 0.35)]),
             ("g13", "SHERIFF", "DOUBLE VOTE", [("game", said("Grok", "A real Seer with a wolf in hand"), None)], [])]  # Grok, Day 1, with the star
    for k, word, cap, cuts, sfx in roles:
        n = line(k) + f(0.25)
        for j, (src, a, b) in enumerate(cuts):
            frames = n // len(cuts) if j < len(cuts) - 1 else n - (n // len(cuts)) * (len(cuts) - 1)
            ov = {"kind": "role", "role": word, "caption": cap}
            base = {"id": word.lower() + f"_{j + 1}", "frames": frames, "voice": k if j == 0 else None, "overlay": ov,
                    "sfx": ([(HIT, 0.0, 0.7)] + sfx) if j == 0 else []}
            if src == "stage":
                add(source="stage", scene=a, camera=b, push=0.08, effects={"shadow_slide": True} if word == "VILLAGER" else {}, **base)
            else:
                add(source="game", clip=a, push=1.08, **base)
    add(id="stakes", source="game", clip=fire, frames=line("g15"), voice="g15", push=1.05, sfx=[(HIT, 0.0, 0.6)])
    # 4: the fairness line over the two wolves' red eyes ("Only you do."), then the send-off over the title + ROUND 1
    add(id="fair", source="stage", scene="Intro_Lineup", camera="Lineup_Low", frames=line("f1") + f(0.3), voice="f1",
        effects={"red_eyes": china, "red_eyes_hold": True}, push=0.1, sfx=[("S15", 0.0, 0.6)])
    add(id="title", source="stage", scene="Intro_Werewolf", camera="Werewolf_Hero", frames=line("s1") + f(3.2), voice="s1", push=0.1,
        overlay={"kind": "title", "text": "WEREWOLF", "sub": "AI EDITION", "matchup": ["TEAM CHINA", "VS", "TEAM USA"], "round": "ROUND 1",
                 "at": V["s1"]["seconds"] + LEAD},
        sfx=[(HIT, V["s1"]["seconds"] + LEAD, 0.9), ("S1", V["s1"]["seconds"] + LEAD + 0.2, 0.9)])
    out = os.path.join(gdir, "intro")
    os.makedirs(out, exist_ok=True)
    plan_out = {"game": gid, "fps": FPS, "size": [1920, 1080], "shots": shots, "voices": V, "music": {"id": "M4", "from": "versus", "level": 0.55}}
    with open(os.path.join(out, "intro_plan.json"), "w", encoding="utf-8") as fh:
        json.dump(plan_out, fh, indent=1, ensure_ascii=False)
    total = sum(s["frames"] for s in shots)
    gclips = sorted({s["clip"] for s in shots if s["source"] == "game"})
    thinks = sorted({(s["clip"], s["overlay"]["seat"]) for s in shots if s["source"] == "game" and (s["overlay"] or {}).get("kind") == "think"})
    print(f"[intro] {len(shots)} shots, {total / FPS:.1f} s; stage shots: {sum(1 for s in shots if s['source'] == 'stage')}; game clips: {','.join(gclips)}")
    print("[intro] thought maps: " + " ".join(f"{c}:{s}" for c, s in thinks))


if __name__ == "__main__":
    main(sys.argv[1])
