"""Voice the intro (owner, 2026-10-19: script Option A, host voice E in the "hook host" style of its take 1; Game 2:
FullGameFolder/Game 2/Intro/INTRO_SCRIPT_v3.txt, 2026-10-22). Each game has its own lines below (HOST, PLAYERS, REUSE).
The host's lines go out together in one request (one style) and are cut at the text model's timings, each piece
checked by transcript (voice_batch.py); the cold open is the wolf's own voice (spoken, then whispered).
Output: FullGameFolder/<game>/intro_voices/ and intro_voices.json (line id -> file, seconds, text).
--set <name>: another line set of the same game (a Short's own lines) -> <name>_voices/ and <name>_voices.json, so
the intro's takes are never touched.

    python intro_voice.py <game id> [--set short2]
"""
import json
import os
import shutil
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
PIPE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
os.chdir(HERE)
import night_job as nj  # noqa: E402
import tts  # noqa: E402
import voice_batch as vb  # noqa: E402

HOST_STYLE = "high-energy video host, punchy and fast"  # the style of "E - 1 hook host - take 1", the owner's pick
HOST_G1 = [
    ("h3", "I made the six smartest AIs compete in a game of Werewolf."),
    ("h4", "Two Claudes. Two GPTs. Gemini... and Grok."),
    ("h5", "Two of them are secretly werewolves. The other four have to find them."),
    ("h6", "Werewolves kill at night... and lie all day."),
    ("h7", "The Seer gets one look into a soul. Wolf... or not?"),
    ("h8", "The Witch: one potion saves... one kills."),
    ("h9", "Everyone else? Just their voice... and their vote."),
    ("h10", "Catch both wolves, the village wins. Let the wolves match the village... wolves win."),
    ("h11", "Who's lying? Who survives? Let the game begin."),
]
COLD = [  # the wolf's real words from the game (names as the video says them)
    ("c1", "Nico", "intro", "What stands out now is Grok."),
    ("c2", "Nico", "wolfthought", "Grok was our Night 1 target... a fine, village-looking mislynch."),
]
HOST_G2 = [  # script v4 (FullGameFolder/Game 2/Intro/INTRO_SCRIPT_v4.txt): the rules in the owner's wording, no Challenge
    ("g1", "I forced the seven smartest AIs to lie to each other... in a game of Werewolf."),
    ("g3", "But this game took a crazy, unexpected twist."),  # owner: said plainly, not cinematic (no pauses)
    ("g4", "But before we start the game, here are the rules."),  # owner, 2026-10-22
    ("g5", "Seven players. Two of them are secretly werewolves."),
    ("g6", "Every night, the wolves kill someone. Their goal is to lie and pass for villagers."),
    ("g7", "Every day, the village votes one player out, and their role is revealed."),
    ("g8", "If the wolves equal the villagers in number, the wolves win."),
    ("g9", "The Seer can check one player each night: wolf or not."),
    ("g10", "The Witch has two potions: one to heal, one to poison."),
    ("g11", "If the Hunter dies, they can shoot one player."),
    ("g12", "Everyone else is a Villager."),
    ("g13", "The Sheriff's vote counts double."),
    ("g15", "Find both wolves, and the village wins."),
]
MOMENTS_G2 = [  # the best moments (script v4): only the most engaging words, in each model's own voice (voice_cast.json)
    ("m1", "Nico", "intro", "Vote me out and I shoot someone."),  # Fable (Hunter)
    ("m2", "Mila", "intro", "Sol, Astra... you are both the wolves."),  # Gemini (Witch)
    ("m3", "Dario", "wolfthought", "Gemini has put the cards together, and she's right about Astra and me."),  # Sol thinks
    ("m4", "Dario", "lie", "Yes, Gemini. I'm the Hunter."),  # Sol says
    ("m5", "Pavel", "wolfthought", "I'll claim the Witch and say I saved her. It's a desperate move."),  # Astra thinks
    ("m6", "Pavel", "lie", "I'm the Witch, and I healed YOU on the first night."),  # Astra says
    ("m7", "Mila", "intro", "Astra, that is a desperate lie."),  # Gemini
]
SAMPLES_G2 = {"m3": "samples/sol_thought.wav"}  # the same words, voice and style were voiced for the inner-voice sample
# Game 2's Short 2 (owner, 2026-10-25): Sol's vote switch. Real words from the game (names and pronouns as the video
# says them; Sol and Astra have male voices); the thought is Sol's private thought at the Day 2 vote, shortened.
HOST_G2_S2 = [("p1", "Seven AIs play Werewolf. Two are secret wolves, and Sol is one of them.")]
PLAYERS_G2_S2 = [
    ("s1", "Dario", "lie", "I'm voting Astra."),  # Sol, Day 2 (beats 175/177)
    ("s2", "Mila", "intro", "Astra just outed himself as a werewolf. That means Sol is his partner."),  # Gemini (beat 170)
    ("s3", "Dario", "wolfthought", "I told everyone I'd vote for him... I'll vote Fable instead."),  # Sol thinks, at the vote
    ("s4", "Dario", "lie", "I vote for Fable."),  # Sol's vote (beat 180)
]
# Game 2's Short 3 (owner, 2026-10-26): "Kill the Seer" (FullGameFolder/Game 2/Shorts/Short 3 - SCRIPT (proposal).txt,
# approved with a voiced end card). The hook is Astra's private thought at the Night 2 council (game.json event 119).
HOST_G2_S3 = [("p1", "Seven AIs play Werewolf. Two are secret wolves, and only the Seer can find them."),
              ("e1", "Full game out now on the channel.")]
PLAYERS_G2_S3 = [
    ("t1", "Pavel", "wolfthought", "Grok could expose either of us tonight. I want him gone before he can speak again."),  # Astra
    ("t2", "Viggo", "intro", "I'm the Seer. If I'm still here tonight, I'll look again."),  # Grok, Day 1 (beats 36 + 39)
    ("t3", "Dario", "intro", "Agreed on Grok. Let's take him tonight."),  # Sol at the council (beat 118; owner: "agreed ON Grok": he is the target, not addressed)
]
# Game 3 (c0416225, owner 2026-10-27): "Chinese AIs vs American AIs in a Werewolf Game (Round 1)",
# FullGameFolder/Game 3/Intro/INTRO_SCRIPT_v2.txt. The rules reuse Game 2's takes (the same cards); three new host lines.
HOST_G3 = [
    ("r1", "America and China are racing to build the smartest AI. So I made two Chinese AIs the secret werewolves... against five American AIs."),
    ("f1", "I chose the roles, but the AIs don't know who's who. Only you do."),
    ("s1", "Can two Chinese AIs fool five American ones? Who lies better? Let the game begin."),
]
MOMENTS_G3 = [  # the hook, in each model's own voice (voice_cast.json: Sol = Dario, Qwen = Elin, DeepSeek = Tilde)
    ("m1", "Dario", "intro", "I'm the Seer. Last night I checked Qwen... and saw a werewolf."),  # Sol, the Sheriff speech
    ("m2", "Elin", "lie", "Sol is lying. I'm the real Seer."),  # Qwen
    ("m3", "Elin", "wolfthought", "The truth is I was hiding because I'm a wolf..."),  # Qwen thinks (Grok's challenge)
    ("m5", "Tilde", "wolfthought", "I have to take him out now, before he can point at me in the morning."),  # DeepSeek, Night 2
    ("m6", "Tilde", "lie", "I am the Hunter. Execute me, and I will take Gemini with me."),  # DeepSeek, Day 2
]
G3_REUSE = {**{k: "06ce0859" for k in ("g4", "g5", "g6", "g7", "g8", "g9", "g10", "g11", "g12", "g13", "g15")},
            "m4": "beat:108"}  # the Night 2 vision, in the game's own narrator take
GAMES = {  # id8 [/set] -> host lines, the players' lines, and takes copied from an earlier game (line id -> that game)
    "3880b590": (HOST_G1, COLD, {}),
    "06ce0859": (HOST_G2, MOMENTS_G2, {"h11": "3880b590"}),  # "Who's lying? Who survives? Let the game begin."
    "06ce0859/short2": (HOST_G2_S2, PLAYERS_G2_S2, {}),
    "06ce0859/short3": (HOST_G2_S3, PLAYERS_G2_S3, {"n1": "beat:120"}),
    "c0416225": (HOST_G3, MOMENTS_G3, G3_REUSE),  # the full game's narrator take (owner cut the Witch line and the card's narration)
}


def lock_host():
    c = tts.character("Host")
    e = next(x for x in c["candidates"] if x["label"] == "E")
    if c.get("voice") != e["voice"]:
        c.update({"voice": e["voice"], "locked": True, "locked_at": "2026-10-19", "voice_description": e["description"],
                  "base_style": HOST_STYLE, "approved": {"intro": {"style": HOST_STYLE, "text": "the intro script (Option A)",
                                                                     "source": "output/Host/1 Style variants/E - 1 hook host - take 1.wav"}}})
        tts.save(os.path.join("characters", "Host.json"), c)
    return e["voice"]


def secs(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / w.getframerate()


def main(gid, line_set="intro"):
    out = os.path.join(PIPE, "FullGameFolder", gid, f"{line_set}_voices")
    os.makedirs(out, exist_ok=True)
    man_path = os.path.join(PIPE, "FullGameFolder", gid, f"{line_set}_voices.json")
    man = json.load(open(man_path, encoding="utf-8")) if os.path.exists(man_path) else {}
    voice = lock_host()
    V = vb.Voicer(gid)
    HOST, PLAYERS, REUSE = GAMES[gid[:8] + ("" if line_set == "intro" else "/" + line_set)]
    for k, src in REUSE.items():  # the same words in an earlier game's intro, or "beat:<n>" the full game's own take: free
        if k not in man:
            if src.startswith("beat:"):
                man_g = os.path.join(PIPE, "2 Werewolf Blender", "games", gid[:8], "voices.json")
                if os.path.exists(man_g):
                    old = json.load(open(man_g, encoding="utf-8"))[src[5:]]
                else:  # the game's voicing has not finished (its list is written at the end): its take pool
                    pool = json.load(open(os.path.join(PIPE, "FullGameFolder", gid, "takes.json"), encoding="utf-8"))
                    old = next(t for t in pool if os.path.basename(t["file"]).startswith(f"beat_{src[5:]}_"))
            else:
                old = json.load(open(os.path.join(PIPE, "FullGameFolder", src, "intro_voices.json"), encoding="utf-8"))[k]
            f = os.path.join(out, f"{k}.wav")
            shutil.copyfile(old["file"], f)
            man[k] = {**old, "file": f, "from": src}
    todo = [(k, t) for k, t in HOST if man.get(k, {}).get("text") != t]  # new or reworded lines (owner's edits)
    if todo:  # one request for all the host's lines, cut and checked
        whole = os.path.join(out, f"_host_{len(todo)}.wav")
        V.speech([(t, HOST_STYLE) for _, t in todo], voice, whole)
        bounds = vb.cut_points(whole, [t for _, t in todo])
        sr, samples = vb.read(whole)
        for (k, t), (a, b) in zip(todo, bounds or []):
            f = os.path.join(out, f"{k}.wav")
            if os.path.exists(f):
                os.remove(f)  # the old wording of a reworded line
            vb.write_piece(samples, sr, a, b, f)
            vb.tighten(f)
            heard = vb.gemini([vb.audio_part(f), {"text": "Transcribe this audio exactly, word for word. Output only the transcript."}])
            if vb.matches(heard, t):
                man[k] = {"file": f, "seconds": round(secs(f), 2), "speaker": "Host", "text": t}
            else:
                os.remove(f)
                nj.note(f"intro {k}: piece did not match (heard: {heard[:80]}); redo alone")
        for k, t in todo:  # anything the cut missed: alone
            if k in man:
                continue
            f = os.path.join(out, f"{k}.wav")
            V.speech([(t, HOST_STYLE)], voice, f)
            vb.tighten(f)
            man[k] = {"file": f, "seconds": round(secs(f), 2), "speaker": "Host", "text": t}
    keep = {k for k, _ in HOST} | {k for k, *_ in PLAYERS} | set(REUSE)
    for k in [k for k in man if k not in keep]:  # lines dropped from the script (owner rule: no superseded files)
        if os.path.exists(man[k]["file"]):
            os.remove(man[k]["file"])
        del man[k]
    for k, who, sit, t in PLAYERS:
        if man.get(k, {}).get("text") == t:
            continue
        sample = os.path.join(PIPE, "FullGameFolder", gid, SAMPLES_G2.get(k, "-")) if gid.startswith("06ce0859") and line_set == "intro" else ""
        if os.path.exists(sample):  # already voiced for a sample: reused, free
            f = os.path.join(out, f"{k}.wav")
            shutil.copyfile(sample, f)
            man[k] = {"file": f, "seconds": round(secs(f), 2), "speaker": who, "text": t, "from": "sample"}
            continue
        style, v = V.style(who, sit)
        f = os.path.join(out, f"{k}.wav")
        V.speech([(t, style)], v, f)
        vb.tighten(f)
        man[k] = {"file": f, "seconds": round(secs(f), 2), "speaker": who, "text": t, "style": style}
    vb.save_json(man_path, man)
    nj.note(f"{line_set} {gid}: {len(man)} lines voiced: " + ", ".join(f"{k} {v['seconds']}s" for k, v in man.items()))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[sys.argv.index("--set") + 1] if "--set" in sys.argv else "intro")
