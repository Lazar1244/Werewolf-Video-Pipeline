"""All situations for every chosen (not yet locked) voice in one run (owner, 2026-10-09). Uses night_job's machinery:
several lines per request where the cut is clean (groups of 4; a line with a <long pause> inside goes alone), one by
one otherwise; the daily limit is waited out. Lessons built in (TIPS_AND_TRICKS.txt, section 13):
  - opening words: no style for bright voices, "speaking up clearly..." for soft/low/slow ones
  - Sheriff: "firm and determined, full of conviction" with "I WILL find them"
  - quiet lines (lie, guilty defending, whisper, thoughts) name the voice's accent; thoughts are "whispering to himself/herself"
Progress: night_job.log (same log), state in night_job_state.json.

    python situations_job.py <start time>
"""
import datetime
import re
import sys
import time

import night_job as nj
import tts

CAST = ["Hugo", "Nico", "Kira", "Viggo", "Greta", "Oda", "Fenn", "Elin", "Ines", "Mila", "Bram", "Soren", "Rhea", "Tilde", "Dario", "Narrator"]
SOFT = re.compile(r"\b(soft|airy|quiet|thin|wavering|low|slow|gentle|breathy|calm|smoky|husky|trembling|frail)\b", re.I)
SHERIFF_TEXT = "Thank you. I'll carry this star with care <short pause> and I WILL find them. I promise."


def accent_of(desc):
    m = re.search(r"\b(?:a|an) ([^,]*(?:accent|drawl|lilt))", desc)
    if not m:
        return ""
    a = m.group(1).replace("fast-talking ", "")
    return a if a.startswith(("strong", "thick")) else "strong " + a.replace("soft ", "").replace("crisp ", "")


def plan(c, desc):
    """(situation, text, style) for every situation of this character."""
    sits = [s for s in tts.situations(c) if s.get("no")]
    if c["kind"] == "narrator":
        return [(s, s["text"], s["style"]) for s in sits]
    acc = accent_of(desc)
    A = f", {acc}" if acc else ""
    self_ = "herself" if c.get("gender") == "female" else "himself"
    style = {"intro": "speaking up clearly to the whole circle, full voice" if SOFT.search(desc) else "",
             "sheriff": "firm and determined, full of conviction",
             "lie": "smooth and confident, slightly too relaxed" + A,
             "guiltydefend": "controlled, wounded innocence, a little too smooth" + A,
             "packwhisper": "whispered urgently, conspiratorial" + A,
             "wolfthought": f"whispering to {self_}, cold and calculating" + A,
             "seerthought": f"whispering to {self_}, uneasy" + A}
    return [(s, SHERIFF_TEXT if s["id"] == "sheriff" else s["text"], style.get(s["id"], s["style"])) for s in sits]


def run_character(name):
    c = tts.character(name)
    desc = next(x["description"] for x in c["candidates"] if x["voice"] == c["voice"])
    rows = plan(c, desc)
    plain = [r for r in rows if "<long pause>" not in r[1]]
    groups = [plain[i:i + 4] for i in range(0, len(plain), 4)] + [[r] for r in rows if r not in plain]
    for gi, g in enumerate(groups):
        key = f"sit:{name}:{gi}"
        if nj.done(key):
            continue
        items = [{"sit": s, "text": t, "style": st, "label": None} for s, t, st in g]
        entries = nj.many(tts.character(name), items, f"{name} situations {[s['id'] for s, _, _ in g]}")
        c = tts.character(name)
        for it, e in zip(items, entries):
            tts.write_folder(c, it["sit"], e, e["voice"], desc)
            c = tts.character(name)
        nj.mark(key, [e["no"] for e in entries])
    nj.note(f"{name}: all {len(rows)} situations made")


if __name__ == "__main__":
    start = datetime.datetime.fromisoformat(sys.argv[1])
    while datetime.datetime.now() < start:
        time.sleep(30)
    nj.note("situations job: start")
    for name in CAST:
        try:
            run_character(name)
        except Exception as e:  # noqa: BLE001 - one character's problem must not stop the others
            nj.note(f"{name}: stopped with an error, moving on: {e!r}")
    tts.cmd_page()
    nj.note("situations job: ALL DONE")
