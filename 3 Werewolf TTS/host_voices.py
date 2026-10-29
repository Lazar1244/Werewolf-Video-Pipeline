"""Voice candidates for the intro host (owner, 2026-10-19): an energetic, younger voice that hooks viewers in the
first seconds. Each candidate is designed from its own description, then reads the same hook reel in the same style,
so they can be compared side by side. Output: output/Host/0 Voice pick/ (design sample + hook reel per candidate, and
Voice pick.txt with every description). Google's limits are waited out (night_job.api).

    python host_voices.py
"""
import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.chdir(HERE)
import night_job as nj  # noqa: E402
import tts  # noqa: E402

CANDIDATES = [  # permanent traits only (TIPS 2): age, gender, timbre, accent, how they speak
    ("A", "male", "A young man in his early 20s with a bright, clear tenor voice, an American accent, and quick, lively delivery."),
    ("B", "female", "A young woman in her mid 20s with a bright, crisp voice, a General American accent, and a fast, confident delivery."),
    ("C", "male", "A young man in his mid 20s with a lively, slightly husky baritone, a London accent, and a cheeky, quick-witted delivery."),
    ("D", "female", "A young woman in her early 20s with a warm, bubbly voice, an Australian accent, and a fast, playful delivery."),
    ("E", "male", "A young man in his late 20s with a rich, punchy baritone, a General American accent, and the crisp, driving delivery of a movie-trailer narrator."),
    ("F", "female", "A young woman in her late 20s with a low, smoky voice, a General American accent, and a sly, energetic delivery."),
    ("G", "male", "A young man in his early 20s with a slightly raspy, energetic voice, a Californian accent, and the fast, excited delivery of a gaming streamer."),
    ("H", "female", "A young woman in her mid 20s with a clear, polished voice, a Southern English accent, and a brisk, witty delivery."),
    ("I", "male", "A young man in his mid 20s with a warm, lively voice, an Irish accent, and a fast, storytelling delivery."),
    ("J", "female", "A young woman in her mid 20s with a slightly raspy, intense voice, a General American accent, and the gripping, fast delivery of a true-crime podcaster."),
    ("K", "male", "A young man in his mid 20s with a crisp, confident voice, a Canadian accent, and the sharp, energetic delivery of a documentary host."),
    ("L", "female", "A young woman in her early 20s with a bright, punchy voice, a Scottish accent, and a fast, spirited delivery."),
]
HOOK = ("Today, I put the six smartest AIs in the world against each other... in a game of Werewolf. Two of them are wolves. "
        "The rest have no idea. The Seer sees the truth. The Witch holds life and death in two potions. "
        "And every night... someone doesn't wake up.")
STYLE = "high-energy video host, punchy and fast"


def main():
    path = os.path.join("characters", "Host.json")
    if not os.path.exists(path):
        tts.save(path, {"name": "Host", "kind": "host", "gender": None, "candidates": [], "base_style": "",
                        "notes": "The intro: the hook, the players, the rules and every role. Energetic and younger."})
    out = os.path.join("output", "Host", "0 Voice pick")
    os.makedirs(out, exist_ok=True)
    model = tts.load("config.json")["model"]
    for label, gender, desc in CANDIDATES:
        c = tts.character("Host")
        if not any(x["label"] == label for x in c["candidates"]):
            try:
                nj.api(tts.cmd_design, argparse.Namespace(char="Host", description=desc, gender=gender, label=label))
            except BaseException as e:  # a refused design: noted, the others go on
                nj.note(f"Host {label}: design failed ({str(e)[:120]})")
                continue
        c = tts.character("Host")
        cand = next(x for x in c["candidates"] if x["label"] == label)
        sample = next((e for e in reversed([json.loads(l) for l in open(os.path.join(tts.TAKES, "Host", "log.jsonl"), encoding="utf-8")])
                       if e["situation"] == "design" and e["label"] == label), None)
        if sample:
            shutil.copy(os.path.join(tts.TAKES, "Host", sample["file"]), os.path.join(out, f"{label} - 1 design sample.wav"))
        reel = os.path.join(out, f"{label} - 2 hook reel.wav")
        if not os.path.exists(reel):
            def go():
                tts.guard(tts.estimate(HOOK, model))
                raw = tts.speak(HOOK, cand["voice"], STYLE, model)
                secs = tts.write_wav(raw, reel)
                tts.charge(tts.audio_cost(secs, HOOK, model), f"Host {label} hook reel")
                return secs
            try:
                secs = nj.api(go)
                nj.note(f"Host {label}: hook reel {secs:.1f} s")
            except BaseException as e:
                nj.note(f"Host {label}: hook reel failed ({str(e)[:120]})")
    c = tts.character("Host")
    with open(os.path.join(out, "Voice pick.txt"), "w", encoding="utf-8") as f:
        f.write("Intro host: voice candidates. Each reads the same hook reel in the same style.\n")
        f.write(f"Hook reel text: {HOOK}\nStyle: {STYLE}\n\n")
        for x in c["candidates"]:
            f.write(f"{x['label']}  {x['voice']}\n   {x['description']}\n\n")
    nj.note(f"Host: {len(c['candidates'])} candidates ready in output/Host/0 Voice pick/")


if __name__ == "__main__":
    main()
