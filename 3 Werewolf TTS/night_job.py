"""Overnight job (owner, 2026-10-08): Jonas's situations, then 3 voice proposals for every remaining character.
Several lines per request where possible (tts.take_many); when Google's daily limit is reached it waits for the next
reset (00:00 UTC) and carries on. Progress: night_job.log; finished steps are remembered in night_job_state.json,
so the job can be stopped and started again without redoing anything.

    python night_job.py <start time, e.g. 2026-10-08T02:03:00>
"""
import datetime
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
sys.path.insert(0, HERE)
import tts  # noqa: E402

LOG = open("night_job.log", "a", encoding="utf-8")
STATE_PATH = "night_job_state.json"
STATE = json.load(open(STATE_PATH, encoding="utf-8")) if os.path.exists(STATE_PATH) else {}


def note(msg):
    LOG.write(f"{datetime.datetime.now():%m-%d %H:%M:%S} {msg}\n")
    LOG.flush()


def done(key):
    return STATE.get(key) is not None


def mark(key, value=True):
    STATE[key] = value
    with open(STATE_PATH + ".tmp", "w", encoding="utf-8") as f:
        json.dump(STATE, f, indent=1)
    os.replace(STATE_PATH + ".tmp", STATE_PATH)  # never half-written, even if the job is killed


class Refused(Exception):
    pass


def api(fn, *args):
    """Run a tts call; a daily-limit refusal waits for the next reset, network/server trouble waits a few minutes,
    anything else (e.g. a safety refusal) is raised for the caller to handle."""
    for attempt in range(36):  # up to ~6 hours of server trouble per call
        try:
            return fn(*args)
        except SystemExit as e:
            msg = str(e)
            if ("429" in msg or "RESOURCE_EXHAUSTED" in msg) and "per day" not in msg:
                note("per-minute limit (voice creation): waiting 70 s")
                time.sleep(70)
                continue
            if "429" in msg or "too_many_requests" in msg:
                now = datetime.datetime.now(datetime.timezone.utc)
                nxt = (now + datetime.timedelta(days=1)).replace(hour=0, minute=4, second=0, microsecond=0)
                if (nxt - now).total_seconds() > 86000:  # just after midnight: the reset is now, not tomorrow
                    nxt = now + datetime.timedelta(minutes=10)
                note(f"daily limit reached; waiting until {nxt.astimezone():%m-%d %H:%M} local")
                time.sleep(max(60, (nxt - now).total_seconds()))
                continue
            if "network error" in msg or "API error 5" in msg:
                errors_5xx = locals().get("errors_5xx", 0) + 1
                if errors_5xx >= 3:  # e.g. Dario's descriptions made voice creation fail every time: move on
                    raise Refused("gave up: server error 3 times in a row (" + msg[-80:] + ")")
                note("Google server error (500) or network trouble, retrying in 2 min")
                time.sleep(120)
                continue
            raise Refused(msg)
    raise Refused("gave up after repeated waits")


def character(name):
    return tts.character(name)


# ---------------------------------------------------------------- Jonas

def jonas():
    if done("jonas:pick"):
        pass
    else:
        c = character("Jonas")
        cand = next(x for x in c["candidates"] if x["label"] == "C")
        c["voice"], c["voice_description"] = cand["voice"], cand["description"]
        tts.save_character(c)
        mark("jonas:pick")
    sits = {s["id"]: s for s in tts.situations(character("Jonas"))}
    A = ", strong German accent"
    styles = {"intro": "", "sheriff": "firm and determined, full of conviction",
              "lie": "smooth and confident, slightly too relaxed" + A,
              "guiltydefend": "controlled, wounded innocence, a little too smooth" + A,
              "packwhisper": "whispered urgently, conspiratorial" + A,
              "wolfthought": "whispering to himself, cold and calculating" + A,
              "seerthought": "whispering to himself, uneasy" + A}
    # C's two test lines (in one request)
    if not done("jonas:testlines"):
        lines = [{"sit": sits["intro"], "text": sits["intro"]["text"], "style": "", "label": "C"},
                 {"sit": sits["defend"], "text": sits["defend"]["text"], "style": None, "label": "C"}]
        many(character("Jonas"), lines, "jonas test lines")
        mark("jonas:testlines")
    # the 12 situations: lines with a long pause inside go alone, the rest in groups of 4
    order = ["intro", "accuse", "defend", "fear", "sheriff", "lastwords", "lie", "guiltydefend", "packwhisper", "seerthought", "seerreveal", "wolfthought"]
    plain = [k for k in order if "<long pause>" not in sits[k]["text"]]
    groups = [plain[i:i + 4] for i in range(0, len(plain), 4)] + [[k] for k in order if k not in plain]
    for gi, g in enumerate(groups):
        key = f"jonas:situations:{gi}"
        if done(key):
            continue
        c = character("Jonas")
        items = [{"sit": sits[k], "text": sits[k]["text"], "style": styles.get(k), "label": None} for k in g]
        entries = many(c, items, f"jonas situations {g}")
        c = character("Jonas")
        desc = c.get("voice_description") or ""
        for it, e in zip(items, entries):
            tts.write_folder(c, it["sit"], e, e["voice"], desc)
        mark(key, [e["no"] for e in entries])
    voicepick("Jonas")
    note("Jonas: all 12 situations made")


def many(c, items, what):
    """Several lines in one request; if that fails or can't be cut cleanly, one request per line."""
    voice = tts.current_voice(c, None)
    if len(items) > 2:  # pairs go singly: when a 2-line cut is unclear it costs 3 requests instead of 2 (2026-10-08)
        try:
            entries = api(tts.take_many, c, items, voice, tts.load("config.json")["model"])
            if entries:
                note(f"{what}: {len(items)} lines in ONE request, cut cleanly")
                return entries
            note(f"{what}: one request made, but the cut was unclear -> one by one")
        except Refused as e:
            note(f"{what}: combined request refused ({str(e)[-120:]}) -> one by one")
    out = []
    for it in items:
        c = character(c["name"])
        out.append(api(tts.take, c, it["sit"], voice, it["style"], it["text"], it.get("label"), tts.load("config.json")["model"]))
    note(f"{what}: {len(items)} lines, one request each")
    return out


# ---------------------------------------------------------------- the cast proposals

PROPOSALS = [  # (name, [(label, description)], adult fallback if a child voice is refused)
 ("Hugo", [("A", "An arrogant, self-important man in his late 40s with a loud, booming baritone voice, a strong Texas drawl, and a slow, self-satisfied swagger."),
           ("B", "A cocky, loud-mouthed rancher in his mid 30s with a bright, brassy tenor voice, a strong Texas drawl, and a fast, boastful pace."),
           ("C", "A pompous old cattle baron in his 60s with a gravelly, rumbling bass voice, a thick Texas drawl, and a slow, condescending cadence.")], None),
 ("Nico", [("A", "A slight young man in his early 20s with a light, bright boyish tenor voice, an American accent, and a quick, excitable pace."),
           ("B", "A shy young man in his early 20s with a soft, gentle tenor voice, an American accent, and a hesitant, careful pace."),
           ("C", "A cheeky young man in his early 20s with a clear, confident voice, a strong Scottish accent, and a quick, playful pace.")], None),
 ("Kira", [("A", "A young woman in her early 20s with a clear, high, slightly raspy voice, a strong Australian accent, and a lively, cheeky pace."),
           ("B", "A sweet young woman in her early 20s with a soft, high voice, a strong Australian accent, and a careful, earnest pace."),
           ("C", "A sassy young woman in her early 20s with a sharp, bright voice, a strong Australian accent, and a fast, cocky pace.")], None),
 ("Narrator", [("A", "A deep, resonant storyteller in his 60s with a rich bass-baritone voice, a neutral British accent, and slow, dramatic pacing."),
               ("B", "A grave storyteller in his 50s with a dark, smoky baritone voice, a soft Scottish accent, and an unhurried, ominous cadence."),
               ("C", "A wise old woman storyteller in her 70s with a low, warm, slightly rasping voice, a neutral British accent, and a slow, haunting cadence.")], None),
 ("Viggo", [("A", "A huge blacksmith in his 50s with a very deep, rumbling bass voice, a strong Swedish accent, and a heavy, unhurried cadence."),
            ("B", "A broad-shouldered man in his early 40s with a deep, warm baritone voice, a strong Swedish accent, and a calm, steady pace."),
            ("C", "A weathered man in his late 60s with a deep, gravelly bass voice, a thick Swedish accent, and a slow, rumbling cadence.")], None),
 ("Greta", [("A", "A stern woman in her 50s with a firm, clipped contralto voice, a strong Russian accent, and a cold, deliberate cadence."),
            ("B", "A severe woman in her late 30s with a low, steely voice, a strong Russian accent, and a precise, controlled pace."),
            ("C", "An imposing woman in her late 60s with a deep, smoky voice, a thick Russian accent, and a slow, heavy cadence.")], None),
 ("Oda", [("A", "A sly woman in her 40s with a low, husky alto voice, a strong New York accent, and a fast, sardonic pace."),
          ("B", "A street-smart woman in her early 30s with a sharp, nasal mezzo voice, a strong New York accent, and a rapid, wisecracking pace."),
          ("C", "A world-weary woman in her late 50s with a raspy, smoky voice, a thick New York accent, and a slow, dry cadence.")], None),
 ("Fenn", [("A", "A gruff young man in his mid 20s with a low, rough voice, a strong Cockney accent, and a clipped, blunt pace."),
           ("B", "A wiry street-smart man in his early 30s with a sharp, raspy tenor voice, a strong Cockney accent, and a fast, cheeky pace."),
           ("C", "A hard-bitten man in his late 40s with a deep, gravelly voice, a thick Cockney accent, and a slow, blunt cadence.")], None),
 ("Elin", [("A", "A cheerful woman in her late 20s with a bright, sing-song mezzo voice, a strong Norwegian accent, and a bouncy pace."),
           ("B", "A warm woman in her late 30s with a rich, friendly alto voice, a strong Norwegian accent, and an easy, relaxed pace."),
           ("C", "A bubbly young woman in her early 20s with a high, clear voice, a strong Norwegian accent, and a quick, chirpy pace.")], None),
 ("Ines", [("A", "A sharp young woman in her late 20s with a quick, crisp mezzo voice, a strong Brazilian Portuguese accent, and a fast, lively pace."),
           ("B", "A confident woman in her mid 30s with a warm, husky alto voice, a strong Brazilian Portuguese accent, and a smooth, playful pace."),
           ("C", "A spirited young woman in her early 20s with a bright, energetic voice, a strong Brazilian Portuguese accent, and a rapid, animated pace.")], None),
 ("Mila", [("A", "A gentle woman in her early 30s with a soft, warm soprano voice, a strong Polish accent, and a calm, kind pace."),
           ("B", "A quiet young woman in her early 20s with a light, airy voice, a strong Polish accent, and a slow, shy pace."),
           ("C", "A motherly woman in her late 40s with a warm, steady mezzo voice, a strong Polish accent, and a patient, soothing cadence.")], None),
 ("Bram", [("A", "A nervous, fussy man in his 40s with a thin, reedy tenor voice, a strong Dutch accent, and a fast, fidgety pace."),
           ("B", "A jittery young man in his late 20s with a light, slightly cracking tenor voice, a strong Dutch accent, and a rapid, stumbling pace."),
           ("C", "A fretful man in his late 50s with a thin, quavering voice, a strong Dutch accent, and a hurried, anxious pace.")], None),
 ("Soren", [("A", "A soft-spoken scholar in his 50s with a calm, dry tenor voice, a strong Danish accent, and a slow, careful cadence."),
            ("B", "A thoughtful man in his late 30s with a quiet, clear baritone voice, a strong Danish accent, and a measured, deliberate pace."),
            ("C", "An elderly scholar in his early 70s with a thin, papery voice, a strong Danish accent, and a slow, precise cadence.")], None),
 ("Rhea", [("A", "An elderly woman in her late 70s with a frail, high, trembling voice, a strong Welsh accent, and a slow, wandering pace."),
           ("B", "An old woman in her late 60s with a warm, crackly voice, a strong Welsh accent, and a gentle, sing-song pace."),
           ("C", "A very old woman in her late 80s with a thin, wavering voice, a strong Welsh accent, and a slow, halting pace.")], None),
 ("Tilde", [("A", "A bubbly young woman in her early 20s with a high, breathy voice, a strong Finnish accent, and a giggly, quick pace."),
            ("B", "A dreamy young woman in her mid 20s with a soft, clear soprano voice, a strong Finnish accent, and a slow, floaty pace."),
            ("C", "A blunt young woman in her late 20s with a flat, deadpan mezzo voice, a strong Finnish accent, and a steady, matter-of-fact pace.")], None),
 ("Dario", [("A", "A man in his mid 30s with a warm, smooth baritone voice, a strong Italian accent, and a relaxed pace."),
            ("B", "A young man in his mid 20s with a bright, clear tenor voice, a strong Italian accent, and a quick, lively pace."),
            ("C", "A man in his early 50s with a rich, deep baritone voice, a thick Italian accent, and a slow, calm cadence.")], None),
]
NARRATOR_GENDER = {"A": "male", "B": "male", "C": "female"}


def design(name, label, desc, gender):
    """Design one candidate voice (like 'tts.py design'); returns True, or raises Refused. Designs are spaced 8 s apart:
    voice creation has a per-minute limit."""
    time.sleep(8)
    def go():
        c = character(name)
        cfg = tts.load("config.json")
        tts.guard(tts.estimate("a short sample sentence for the new voice", "flash"))
        v = {"model": tts.MODELS["flash"], "type": "prompted", "display_name": f"WW {name} {label}",
             "language_code": cfg["language_code"], "prompted": {"input": desc}}
        if gender:
            v["gender"] = gender
        r = tts.call("POST", "/voices", {"store": True, "voice": v})
        vid = r.get("id") or r.get("name", "").split("/")[-1]
        raw = tts.find_audio(r.get("sample_audio") or r)
        secs = 4.0
        if raw:
            n = tts.next_no(c)
            fname = f"{n:03d}_design_{label}.wav"
            secs = tts.write_wav(raw, os.path.join(tts.TAKES, name, fname))
            tts.log_take(c, {"no": n, "file": fname, "situation": "design", "title": "Voice design sample", "voice": vid, "style": "",
                             "text": desc, "model": "flash", "seconds": round(secs, 2), "label": label,
                             "at": datetime.datetime.now().isoformat(timespec="seconds")})
        tts.charge(tts.audio_cost(secs, desc, "flash"), f"design {name} {label}")
        c = character(name)
        c["candidates"].append({"label": label, "voice": vid, "description": desc, "created": datetime.date.today().isoformat(),
                                "expire_time": r.get("expire_time"), "usage": r.get("usage")})
        tts.save_character(c)
    api(go)


def proposals():
    for name, cands, adult in PROPOSALS:
        try:
            propose(name, cands, adult)
        except Exception as e:  # noqa: BLE001 - one person's problem must not stop the rest of the cast
            note(f"{name}: stopped with an error, moving on: {e!r}")


def propose(name, cands, adult):
    if True:
        c = character(name)
        picked = c.get("voice")  # a voice the owner already picked must survive this pass
        for label, desc in cands:
            key = f"{name}:design:{label}"
            if done(key):
                continue
            gender = NARRATOR_GENDER[label] if name == "Narrator" else c.get("gender")
            ok, last_error = False, ""
            for d in ([desc, desc] + ([adult] if adult else [])):  # a refusal can pass on an identical retry
                try:
                    design(name, label, d, gender)
                    ok = True
                    if d != desc:
                        note(f"{name} {label}: the child voice was refused by Google; made the adult variant instead")
                    break
                except Refused as e:
                    last_error = "server" if "gave up" in str(e) else str(e)
                    note(f"{name} {label}: design refused ({str(e)[-100:]})")
                    if last_error == "server":
                        break
            if ok:
                mark(key, "ok")
            elif "server" not in last_error:  # a real refusal (e.g. safety); a server failure is retried on the next run
                mark(key, "refused")
        c = character(name)
        sits = {s["id"]: s for s in tts.situations(c)}
        for cand in c["candidates"]:
            key = f"{name}:lines:{cand['label']}"
            if done(key) or not done(f"{name}:design:{cand['label']}"):
                continue
            c["voice"] = cand["voice"]
            tts.save_character(c)
            if c["kind"] == "narrator":
                items = [{"sit": sits["nightfall"], "text": sits["nightfall"]["text"], "style": None, "label": cand["label"]},
                         {"sit": sits["dawn"], "text": sits["dawn"]["text"], "style": "dread, quiet and heavy", "label": cand["label"]}]
            else:
                items = [{"sit": sits["intro"], "text": sits["intro"]["text"], "style": "", "label": cand["label"]},
                         {"sit": sits["defend"], "text": sits["defend"]["text"], "style": None, "label": cand["label"]}]
            many(c, items, f"{name} {cand['label']} test lines")
            mark(key)
            c = character(name)
        c["voice"] = picked
        tts.save_character(c)
        voicepick(name)
        made = len(character(name)["candidates"])
        note(f"{name}: {made} proposal(s) ready" + ("" if made == 3 else " - CHECK: not all 3 were made"))


def voicepick(name):
    """Like 'tts.py voicepick', with the narrator's two lines named too."""
    class A:
        char = name
    tts.cmd_voicepick(A)


if __name__ == "__main__":
    start = datetime.datetime.fromisoformat(sys.argv[1])
    while datetime.datetime.now() < start:
        time.sleep(30)
    note("start")
    try:
        jonas()
    except Exception as e:  # noqa: BLE001 - keep going with the cast even if Jonas hits a problem
        note(f"Jonas stopped with an error: {e!r}")
    proposals()
    tts.cmd_page()
    note("ALL DONE")
