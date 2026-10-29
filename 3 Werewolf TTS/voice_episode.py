"""Voice a whole episode (owner, 2026-10-14): every beat of the Blender episode gets its speaker's locked voice and the
approved style for that kind of moment; the Narrator voices titles, narration, death cards and vote results.
Output: FullGameFolder/<game>/voices/beat_###_<speaker>.wav and voices.json (a copy goes to the Blender game folder,
where the video pipeline times each beat to its audio); takes.json keeps every take ever made. One line per request;
Google's daily limit is waited out. A line already voiced (same speaker, same words) is reused whatever its beat
number, so it can be re-run any time, also after scenes were added to the episode.

    python voice_episode.py <game id> [<start time>]
"""
import datetime
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PIPE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
os.chdir(HERE)
import night_job as nj  # noqa: E402  (its api() waits out Google's limits)
import tts  # noqa: E402

sys.path.insert(0, os.path.join(PIPE, "2 Werewolf Blender", "director"))
import spoken  # noqa: E402  (what each beat says, and who says it: shared with the video's plan.py)



def style_of(name, situation):
    c = tts.character(name)
    return c["approved"][situation]["style"], c["voice"]


def save_json(path, data):
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(path + ".tmp", path)


def main(gid):
    gdir = os.path.join(PIPE, "2 Werewolf Blender", "games", gid)
    ep = json.load(open(os.path.join(gdir, "episode.json"), encoding="utf-8"))
    seats = {s["seat"]: s for s in ep["seats"]}
    out = os.path.join(PIPE, "FullGameFolder", gid)
    vdir = os.path.join(out, "voices")
    os.makedirs(vdir, exist_ok=True)
    man_path, pool_path = os.path.join(out, "voices.json"), os.path.join(out, "takes.json")
    old = json.load(open(man_path, encoding="utf-8")) if os.path.exists(man_path) else {}
    pool = json.load(open(pool_path, encoding="utf-8")) if os.path.exists(pool_path) else []
    known = {e["file"] for e in pool}
    pool += [e for e in old.values() if e["file"] not in known]  # every take ever made for this game
    # a take is found by its speaker and words, so beats added or moved never re-voice a line (owner, 2026-10-14)
    have = {(e["speaker"], e["text"]): e for e in pool if os.path.exists(e["file"])}
    save_json(pool_path, pool)
    model = tts.load("config.json")["model"]
    man = {}
    for i, b in enumerate(ep["beats"]):
        speaker, sit, text = spoken.line(b, seats)
        key = str(i)
        if (speaker, text) in have:
            man[key] = have[(speaker, text)]
            continue
        style, voice = style_of(speaker, sit)
        fname = os.path.join(vdir, f"beat_{i:03d}_{speaker}.wav")
        n = 1
        while os.path.exists(fname):  # the name may belong to another line's take: never overwrite one
            n += 1
            fname = os.path.join(vdir, f"beat_{i:03d}_{speaker}_{n}.wav")

        def go():
            tts.guard(tts.estimate(text, model))
            raw = tts.speak(text, voice, style, model)
            secs = tts.write_wav(raw, fname)
            tts.charge(tts.audio_cost(secs, text, model), f"episode {gid} beat {i}")
            return secs
        secs = nj.api(go)
        e = {"file": fname, "seconds": round(secs, 2), "speaker": speaker, "voice": voice, "situation": sit,
             "style": style, "text": text, "kind": b["kind"]}
        man[key] = have[(speaker, text)] = e
        pool.append(e)
        save_json(pool_path, pool)
        save_json(man_path, man)  # the takes found so far (every older take stays in takes.json)
        nj.note(f"voice {gid} beat {i}: {speaker} ({sit}) {secs:.1f} s")
    save_json(man_path, man)
    shutil.copy(man_path, os.path.join(gdir, "voices.json"))
    nj.note(f"voice {gid}: all {len(ep['beats'])} beats voiced")


if __name__ == "__main__":
    if len(sys.argv) > 2:
        start = datetime.datetime.fromisoformat(sys.argv[2])
        while datetime.datetime.now() < start:
            time.sleep(30)
    main(sys.argv[1])
