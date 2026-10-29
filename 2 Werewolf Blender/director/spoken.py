"""What each beat says out loud, and in whose voice: shared by the voicing tool ('3 Werewolf TTS/voice_episode.py')
and plan.py, so a voice is found by its speaker and words, never by its beat number (beats shift when scenes are added).

    line(beat, seats) -> (speaker, situation whose approved style is used, text)
"""
WOLVES = {"werewolf", "big_bad_wolf", "accursed_wolf_father", "white_werewolf"}
NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]


def line(b, seats):
    kind, phase = b["kind"], b.get("phase", "")
    if kind in ("speech", "thought"):
        s = seats[b["seat"]]
        wolf = s["role"] in WOLVES
        if kind == "thought":
            sit = "wolfthought" if wolf else "seerthought"
        else:
            ctx = b.get("context", "")
            # owner (2026-10-15): only inner monologues whisper; the pack and the Lovers talk in their normal voice
            sit = ("intro" if ctx in ("council", "lovers") else "lastwords" if ctx == "last words"
                   else "intro" if ctx == "sheriff" else ("lie" if wolf else "intro"))
        return s.get("voice", s["name"]), sit, b["text"]  # the model's own voice (voice_cast.json), else the seat's
    if kind == "title":
        return "Narrator", "nightfall", f"{b['text'].title()}. {b['sub']}"
    if kind == "transition":
        return "Narrator", "verdict", f"{b['text'].title()}. {b['sub']}."
    if kind == "card":
        return "Narrator", "dawn" if phase.startswith("Dawn") else "verdict", f"{b['name']} was {b['role']}. {b['cause'].capitalize()}."
    if kind == "tally":
        rows = " ".join(f"{r['name']}: {NUM[r['votes']] if r['votes'] < len(NUM) else r['votes']} vote{'' if r['votes'] == 1 else 's'}."
                        for r in b["rows"])
        return "Narrator", "verdict", f"{b['title']}. {rows}"
    t = b["text"]  # narration
    sit = ("pack" if ("pack" in t.lower() or "claws" in t.lower()) else "dawn" if phase.startswith("Dawn")
           else "nightfall" if phase.startswith("Night") else "verdict")
    return "Narrator", sit, t
