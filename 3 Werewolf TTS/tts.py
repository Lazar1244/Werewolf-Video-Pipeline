"""Werewolf TTS: a voice for every video character, made and tested one character at a time (Gemini 3.8 TTS).

    python tts.py status                              key present?, spend so far, every character's state
    python tts.py voices [--search warm] [--gender female]   the ready-made voices (and our designed ones)
    python tts.py design <char> "<description>" [--label a] [--gender female]
                                                      design a voice from a description; saves its sample take
    python tts.py say <char> <situation> [--voice V] [--style "..."] [--text "..."] [--label x] [--model lite]
                                                      one take of one situation (see situations.json)
    python tts.py audition <char> [--voice V] [--only accuse,whisper] [--label x]
                                                      the character in every situation, one take each
    python tts.py voicepick <char>                    gather the candidates' samples into output/<char>/0 Voice pick/
    python tts.py pick <char> <label>                 work with one candidate voice (e.g. B)
    python tts.py scene <char> <ids|all> [--style "..."] [--text "..."]
                                                      the take for each situation into output/<char>/<situation>/
                                                      with "How it was made.txt" (replaces the previous version)
    python tts.py approve <char> <situation> <take#>  that exact take becomes the situation's approved version
    python tts.py keep <char> --voice V [--style "..."]   lock the character's voice for the videos
    python tts.py page                                rebuild listen.html (done after every take anyway)

The key is read from .env (GEMINI_API_KEY=...). Nothing is sent anywhere else. Every call is priced before it is made
and refused if it would pass the budget in config.json; the spend is kept in spend.json.
"""
import argparse
import base64
import datetime
import html
import io
import json
import os
import random
import sys
import urllib.error
import urllib.parse
import urllib.request
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://generativelanguage.googleapis.com/v1beta"
MODELS = {"flash": "gemini-3.8-flash-tts", "lite": "gemini-3.8-flash-lite-tts"}
PRICE_OUT = {"flash": 9.0, "lite": 6.0}  # $ per 1M audio tokens until 2026-12-31 (they double on 2027-01-01)
PRICE_IN = 0.5  # $ per 1M text tokens
TOKENS_PER_SEC = 32  # Google lists 25; a measured 32 keeps every estimate on the safe side
CHARS, TAKES = os.path.join(HERE, "characters"), os.path.join(HERE, "takes")


# ---------------------------------------------------------------- files

def load(name, default=None):
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save(name, data):
    """Write via a temporary file and swap it in, so a killed process never leaves a half-written file."""
    path = os.path.join(HERE, name)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(path + ".tmp", path)


def key():
    path = os.path.join(HERE, ".env")
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            if line.strip().startswith("GEMINI_API_KEY="):
                k = line.split("=", 1)[1].strip().strip('"').strip("'")
                if k:
                    return k
    return None


def character(name):
    c = load(os.path.join("characters", f"{name}.json"))
    if c is None:
        sys.exit(f"no character '{name}' (see the characters folder)")
    return c


def save_character(c):
    save(os.path.join("characters", f"{c['name']}.json"), c)


# ---------------------------------------------------------------- money

def spend():
    return load("spend.json", {"total_usd": 0.0, "calls": 0})


def guard(est):
    """Refuse a call that could take the spend past the budget."""
    cfg, s = load("config.json"), spend()
    if s["total_usd"] + est > cfg["budget_usd"]:
        sys.exit(f"budget: this call (about ${est:.4f}) would pass the ${cfg['budget_usd']:.2f} budget "
                 f"(${s['total_usd']:.4f} spent). Raise budget_usd in config.json to go on.")


def charge(usd, what):
    s = spend()
    s["total_usd"] = round(s["total_usd"] + usd, 6)
    s["calls"] += 1
    save("spend.json", s)
    print(f"  cost about ${usd:.4f} ({what}); spent so far ${s['total_usd']:.4f} of ${load('config.json')['budget_usd']:.2f}")


def estimate(text, model):
    secs = max(1.5, len(text.split()) / 2.5) * 1.3  # speech runs about 2.5 words a second; 30% margin
    return secs * TOKENS_PER_SEC * PRICE_OUT[model] / 1e6 + len(text) / 4 * PRICE_IN / 1e6


def audio_cost(secs, text, model):
    return secs * TOKENS_PER_SEC * PRICE_OUT[model] / 1e6 + len(text) / 4 * PRICE_IN / 1e6


# ---------------------------------------------------------------- the API

def call(method, path, body=None):
    k = key()
    if not k:
        sys.exit("no key yet: open .env in this folder and paste your key after GEMINI_API_KEY=")
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"x-goog-api-key": k, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"API error {e.code}: {e.read().decode('utf-8', 'replace')[:800]}")
    except urllib.error.URLError as e:
        sys.exit(f"network error: {e.reason}")


def find_audio(obj):
    """The first base64 audio blob anywhere in a response (the response layout is still in beta)."""
    if isinstance(obj, dict):
        mime = str(obj.get("mime_type") or obj.get("mimeType") or "")
        if isinstance(obj.get("data"), str) and (mime.startswith("audio") or obj.get("type") == "audio"):
            return base64.b64decode(obj["data"])
        for v in obj.values():
            a = find_audio(v)
            if a:
                return a
    elif isinstance(obj, list):
        for v in obj:
            a = find_audio(v)
            if a:
                return a
    return None


def write_wav(raw, path):
    """Save the audio (a WAV, or raw 24 kHz 16-bit mono PCM) and return its length in seconds."""
    if raw[:4] != b"RIFF":
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(raw)
        raw = buf.getvalue()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(raw)
    with wave.open(path, "rb") as w:
        return w.getnframes() / w.getframerate()


def speak(text, voice, style, model):
    content = {"type": "text", "text": text}
    if style:
        content["annotations"] = [{"type": "speech_metadata", "style": style}]
    body = {"model": MODELS[model], "input": [{"type": "user_input", "content": [content]}],
            "response_format": {"type": "audio", "mime_type": "audio/wav", "sample_rate": 24000},
            "generation_config": {"speech_config": [{"voice": voice}]}, "stream": False}
    r = call("POST", "/interactions", body)
    raw = find_audio(r)
    if not raw:
        sys.exit(f"no audio in the response: {json.dumps(r)[:600]}")
    return raw


# ---------------------------------------------------------------- takes

def fill(text, c):
    others = [n for n in load("config.json")["cast_names"] if n != c["name"]]
    rnd = random.Random(c["name"])
    a, b = rnd.sample(others, 2)
    return text.replace("{name}", c["name"]).replace("{other}", a).replace("{other2}", b)


def log_take(c, entry):
    os.makedirs(os.path.join(TAKES, c["name"]), exist_ok=True)
    with open(os.path.join(TAKES, c["name"], "log.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def next_no(c):
    p = os.path.join(TAKES, c["name"], "log.jsonl")
    return 1 + (sum(1 for _ in open(p, encoding="utf-8")) if os.path.exists(p) else 0)


def current_voice(c, voice):
    v = voice or c.get("voice") or (c["candidates"][-1]["voice"] if c.get("candidates") else None)
    if not v:
        sys.exit(f"{c['name']} has no voice yet: design one (python tts.py design {c['name']} \"...\") or pass --voice")
    return v


def take(c, sit, voice, style, text, label, model):
    text = fill(text, c)
    style = style if style is not None else ", ".join(x for x in (c.get("base_style"), sit.get("style")) if x)
    est = estimate(text, model)
    guard(est)
    n = next_no(c)
    fname = f"{n:03d}_{sit['id']}{'_' + label if label else ''}.wav"
    print(f"{c['name']} / {sit['id']}  voice {voice}  style \"{style}\"")
    raw = speak(text, voice, style, model)
    secs = write_wav(raw, os.path.join(TAKES, c["name"], fname))
    usd = audio_cost(secs, text, model)
    charge(usd, f"{secs:.1f} s of audio")
    entry = {"no": n, "file": fname, "situation": sit["id"], "title": sit["title"], "voice": voice, "style": style,
             "text": text, "model": model, "seconds": round(secs, 2), "usd": round(usd, 5), "label": label,
             "at": datetime.datetime.now().isoformat(timespec="seconds")}
    log_take(c, entry)
    print(f"  -> takes/{c['name']}/{fname} ({secs:.1f} s)")
    return entry


# ---------------------------------------------------------------- several lines in one request

def speak_many(texts_styles, voice, model):
    """One request for several lines of one voice: each line its own text part with its own style, two long pauses
    between them (one long pause, ~1.3 s, can be shorter than a natural pause). Returns the raw audio of all lines together."""
    content = []
    for i, (text, style) in enumerate(texts_styles):
        part = {"type": "text", "text": text + (" <long pause> <long pause>" if i < len(texts_styles) - 1 else "")}
        if style:
            part["annotations"] = [{"type": "speech_metadata", "style": style}]
        content.append(part)
    body = {"model": MODELS[model], "input": [{"type": "user_input", "content": content}],
            "response_format": {"type": "audio", "mime_type": "audio/wav", "sample_rate": 24000},
            "generation_config": {"speech_config": [{"voice": voice}]}, "stream": False}
    raw = find_audio(call("POST", "/interactions", body))
    if not raw:
        sys.exit("no audio in the response")
    return raw


def _words(text):
    return len([w for w in __import__("re").sub(r"<[^>]*>", " ", text).split() if w.strip()])


def split_lines(samples, sr, texts):
    """Where to cut the audio of len(texts) lines: at the len(texts)-1 longest silences (>= 0.3 s), but only if those
    clearly stand out from every other pause; returns [(start, end) in samples] or None (then make the lines one by one).
    Lines with a <long pause> inside are best sent on their own: their inner pause can look like a line break."""
    import numpy as np
    fr = int(sr * 0.02)
    n = len(samples) // fr
    rms = np.sqrt((samples[:n * fr].reshape(n, fr).astype(np.float64) ** 2).mean(1))
    quiet = rms < max(0.03 * np.percentile(rms, 95), 1e-4)
    voiced = np.where(~quiet)[0]
    if len(voiced) == 0:
        return None
    first, last = voiced[0], voiced[-1] + 1
    gaps, i = [], first
    while i < last:  # runs of silence inside the speech
        if quiet[i]:
            j = i
            while j < last and quiet[j]:
                j += 1
            if j - i >= 15:
                gaps.append((i, j))
            i = j
        else:
            i += 1
    k = len(texts) - 1
    if len(gaps) < k:
        return None
    by_len = sorted(gaps, key=lambda g: g[1] - g[0], reverse=True)
    chosen, rest = by_len[:k], by_len[k:]
    # only cut when the pauses between lines clearly stand out from every pause left inside the lines
    if k and rest and min(g[1] - g[0] for g in chosen) < 1.25 * max(g[1] - g[0] for g in rest):
        return None
    chosen.sort()
    bounds, s = [], first
    for g in chosen:
        bounds.append((s, g[0]))
        s = g[1]
    bounds.append((s, last))
    w = [_words(t) + 1 for t in texts]
    total = sum(b - a for a, b in bounds)
    for (a, b), wk in zip(bounds, w):  # loose sanity check: a piece can't be wildly longer or shorter than its words
        if not 0.25 <= ((b - a) / total) / (wk / sum(w)) <= 4.0:
            return None
    pad = int(0.12 / 0.02)
    return [(max(0, a - pad) * fr, min(n, b + pad) * fr) for a, b in bounds]


def take_many(c, items, voice, model):
    """Several lines (items: dicts with sit, text, style, label) in ONE request, cut into one take per line.
    Returns the take entries, or None if the request or the cutting failed (then make them one by one)."""
    import numpy as np
    texts = [fill(it["text"], c) for it in items]
    styles = [it["style"] if it["style"] is not None else it["sit"].get("style", "") for it in items]
    guard(sum(estimate(t, model) for t in texts))
    print(f"{c['name']}: {len(items)} lines in one request, voice {voice}")
    raw = speak_many(list(zip(texts, styles)), voice, model)
    os.makedirs(os.path.join(TAKES, c["name"]), exist_ok=True)
    whole = os.path.join(TAKES, c["name"], f"_batch_{datetime.datetime.now():%Y%m%d_%H%M%S}.wav")
    secs = write_wav(raw, whole)
    charge(audio_cost(secs, " ".join(texts), model), f"{secs:.1f} s of audio, {len(items)} lines in one request")
    with wave.open(whole, "rb") as wf:
        sr = wf.getframerate()
        samples = np.frombuffer(wf.readframes(wf.getnframes()), np.int16)
    cuts = split_lines(samples.astype(np.float32) / 32768, sr, texts)
    if cuts is None:
        print(f"  the cuts did not fit the texts; kept {os.path.basename(whole)} for reference")
        return None
    out = []
    for it, text, style, (a, b) in zip(items, texts, styles, cuts):
        n = next_no(c)
        fname = f"{n:03d}_{it['sit']['id']}{'_' + it['label'] if it.get('label') else ''}.wav"
        with wave.open(os.path.join(TAKES, c["name"], fname), "wb") as wo:
            wo.setnchannels(1); wo.setsampwidth(2); wo.setframerate(sr); wo.writeframes(samples[a:b].tobytes())
        e = {"no": n, "file": fname, "situation": it["sit"]["id"], "title": it["sit"]["title"], "voice": voice, "style": style,
             "text": text, "model": model, "seconds": round((b - a) / sr, 2), "usd": 0.0, "label": it.get("label"),
             "batch": os.path.basename(whole), "at": datetime.datetime.now().isoformat(timespec="seconds")}
        log_take(c, e)
        out.append(e)
        print(f"  -> takes/{c['name']}/{fname} ({e['seconds']} s)")
    return out


def situations(c):
    return [s for s in load("situations.json")["situations"] if c["kind"] in s["for"]]


# ---------------------------------------------------------------- commands

def cmd_status(a):
    k, s, cfg = key(), spend(), load("config.json")
    print(f"key: {'set (' + str(len(k)) + ' characters)' if k else 'NOT SET: paste it into .env after GEMINI_API_KEY='}")
    print(f"model: {MODELS[cfg['model']]}   spent: ${s['total_usd']:.4f} of ${cfg['budget_usd']:.2f} budget ({s['calls']} calls)")
    for f in sorted(os.listdir(CHARS)):
        c = load(os.path.join("characters", f))
        state = f"LOCKED {c['voice']}" if c.get("locked") else (f"{len(c['candidates'])} candidate voice(s)" if c["candidates"] else "not started")
        print(f"  {c['name']:9} {c['kind']:8} {c.get('gender') or '?':7} {state}")


def cmd_voices(a):
    q = {"page_size": "100"}
    if a.search:
        q["search"] = a.search
    if a.gender:
        q["gender"] = a.gender
    r = call("GET", "/voices?" + "&".join(f"{k}={urllib.parse.quote(v)}" for k, v in q.items()))
    for v in r.get("voices", []):
        print(f"{v.get('id') or v.get('display_name')}: {v.get('type', '')} {v.get('gender', '')} {v.get('pitch', '')} "
              f"{v.get('persona', '')} {v.get('accent', '')} - {v.get('description', '')}"[:200])
    if r.get("next_page_token"):
        print("(more: narrow it with --search or --gender)")


def cmd_design(a):
    c = character(a.char)
    cfg = load("config.json")
    gender = a.gender or c.get("gender")
    label = a.label or chr(ord("a") + len(c["candidates"]))
    guard(estimate("a short sample sentence for the new voice", "flash"))
    voice = {"model": MODELS["flash"], "type": "prompted", "display_name": f"WW {c['name']} {label}",
             "language_code": cfg["language_code"], "prompted": {"input": a.description}}
    if gender:
        voice["gender"] = gender
    r = call("POST", "/voices", {"store": True, "voice": voice})
    vid = r.get("id") or r.get("name", "").split("/")[-1]
    if not vid:
        sys.exit(f"no voice id in the response: {json.dumps(r)[:600]}")
    secs = 0.0
    raw = find_audio(r.get("sample_audio") or r)
    if raw:
        n = next_no(c)
        fname = f"{n:03d}_design_{label}.wav"
        secs = write_wav(raw, os.path.join(TAKES, c["name"], fname))
        log_take(c, {"no": n, "file": fname, "situation": "design", "title": "Voice design sample", "voice": vid, "style": "",
                     "text": a.description, "model": "flash", "seconds": round(secs, 2), "label": label,
                     "at": datetime.datetime.now().isoformat(timespec="seconds")})
        print(f"  sample -> takes/{c['name']}/{fname} ({secs:.1f} s)")
    charge(audio_cost(secs or 4.0, a.description, "flash"), "voice design (billing not published; priced as its sample)")
    c["candidates"].append({"label": label, "voice": vid, "description": a.description,
                            "created": datetime.date.today().isoformat(),
                            "expire_time": r.get("expire_time") or r.get("expireTime"),  # sources disagree on the TTL: record it
                            "usage": r.get("usage")})  # Google's own token count for the creation
    save_character(c)
    print(f"{c['name']}: candidate '{label}' = {vid}")
    cmd_page(a)


def cmd_say(a):
    c = character(a.char)
    sits = {s["id"]: s for s in situations(c)}
    if a.text:
        sit = {"id": a.situation or "custom", "title": "Custom line", "style": ""}
        text = a.text
    else:
        if a.situation not in sits:
            sys.exit(f"situations for {c['kind']}s: {', '.join(sits)}")
        sit, text = sits[a.situation], sits[a.situation]["text"]
    take(c, sit, current_voice(c, a.voice), a.style, text, a.label, a.model or load("config.json")["model"])
    cmd_page(a)


def cmd_audition(a):
    c = character(a.char)
    voice, model = current_voice(c, a.voice), a.model or load("config.json")["model"]
    sits = [s for s in situations(c) if not a.only or s["id"] in a.only.split(",")]
    total = sum(estimate(fill(s["text"], c), model) for s in sits)
    print(f"{len(sits)} takes, about ${total:.4f} in all")
    guard(total)
    for s in sits:
        take(c, s, voice, a.style, s["text"], a.label, model)
    cmd_page(a)


def cmd_pick(a):
    """Choose one of the character's candidate voices (by label) as the voice to work with."""
    c = character(a.char)
    cand = next((x for x in c["candidates"] if x["label"] == a.label), None)
    if cand is None:
        sys.exit(f"{c['name']} has no candidate '{a.label}'")
    c["voice"], c["voice_description"] = cand["voice"], cand["description"]
    save_character(c)
    print(f"{c['name']}: working voice = candidate {a.label} ({cand['voice']})")


def title(c, sit):
    """The situation title in the character's gender ("Defending himself" / "Defending herself")."""
    t = sit["title"]
    return t.replace("himself", "herself").replace("he saw", "she saw") if c.get("gender") == "female" else t


def folder(c, sit):
    return os.path.join(HERE, "output", c["name"], f"{sit['no']:02d} {sit['group']} - {title(c, sit)}")


def write_folder(c, s, e, voice, desc):
    """output/<char>/<situation>/: this take (copied) and 'How it was made.txt'; anything there before is removed."""
    d = folder(c, s)
    os.makedirs(d, exist_ok=True)
    for f in os.listdir(d):
        os.remove(os.path.join(d, f))
    wav = f"{c['name']} - {title(c, s)}.wav"
    with open(os.path.join(TAKES, c["name"], e["file"]), "rb") as src, open(os.path.join(d, wav), "wb") as dst:
        dst.write(src.read())
    style = e["style"] or ""
    notes = [f"{c['name'].upper()} - {s['group']}: {title(c, s)}", "",
             f"Audio:        {wav} ({e['seconds']} s)",
             f"Model:        {MODELS[e.get('model', 'flash')]}",
             f"Voice:        {voice}",
             f"Voice design: {desc}",
             f"Style:        {style or '(none)'}",
             f"Text:         {e['text']}",
             f"Made:         {e['at']} (take #{e['no']} in takes/{c['name']}/log.jsonl)", "",
             f"Remake (a new take will differ slightly; this exact one is take #{e['no']}):",
             f'  python tts.py scene {c["name"]} {s["id"]} --voice {voice} --style "{style}" --text "{e["text"]}"', "",
             "Use for a new sentence (same voice and delivery; the approved take above is not touched):",
             f'  python tts.py say {c["name"]} {s["id"]} --voice {voice} --style "{style}" --text "your new sentence here"']
    with open(os.path.join(d, "How it was made.txt"), "w", encoding="utf-8") as fh:
        fh.write(chr(10).join(notes) + chr(10))
    c.setdefault("approved", {})[s["id"]] = {"take": e["no"], "style": style, "text": e["text"], "folder": os.path.relpath(d, HERE)}
    save_character(c)
    return d


def cmd_approve(a):
    """Put one exact take (by its number) into its situation folder as the approved version."""
    c = character(a.char)
    sit = next((x for x in situations(c) if x["id"] == a.situation), None)
    if sit is None:
        sys.exit("unknown situation")
    log = [json.loads(l) for l in open(os.path.join(TAKES, c["name"], "log.jsonl"), encoding="utf-8")]
    e = next((x for x in log if x["no"] == a.take), None)
    if e is None:
        sys.exit(f"no take #{a.take} for {c['name']}")
    desc = next((x["description"] for x in c["candidates"] if x["voice"] == e["voice"]), "(ready-made voice)")
    d = write_folder(c, sit, e, e["voice"], desc)
    print(f"{c['name']} / {sit['id']}: take #{a.take} approved -> {os.path.relpath(d, HERE)}")


def cmd_scene(a):
    """Make the take for one or more situations into output/<char>/<situation>/, replacing what was there, with a
    'How it was made.txt' describing exactly this version (only the latest version is kept)."""
    c = character(a.char)
    voice, model = current_voice(c, a.voice), a.model or load("config.json")["model"]
    sits = [s for s in situations(c) if s.get("no") and (a.ids == "all" or s["id"] in a.ids.split(","))]
    if not sits:
        sys.exit("situation ids: " + ", ".join(s["id"] for s in situations(c) if s.get("no")))
    guard(sum(estimate(fill(a.text or s["text"], c), model) for s in sits))
    desc = next((x["description"] for x in c["candidates"] if x["voice"] == voice), c.get("voice_description") or "(ready-made voice)")
    for s in sits:
        e = take(c, s, voice, a.style, a.text or s["text"], None, model)
        d = write_folder(c, s, e, voice, desc)
        print(f"  -> output/{c['name']}/{os.path.basename(d)}/")
    cmd_page(a)


def cmd_voicepick(a):
    """output/<char>/0 Voice pick/: every candidate's design sample, plain line and emotional line, plus a summary."""
    c = character(a.char)
    p = os.path.join(TAKES, c["name"], "log.jsonl")
    log = [json.loads(l) for l in open(p, encoding="utf-8")] if os.path.exists(p) else []
    out = os.path.join(HERE, "output", c["name"], "0 Voice pick")
    os.makedirs(out, exist_ok=True)
    names = {"design": "1 design sample", "intro": "2 plain line", "defend": "3 emotional line",
             "nightfall": "2 nightfall line", "dawn": "3 dawn line"}  # the narrator's two test lines
    lines = [f"{c['name'].upper()} - VOICE PICK", "Each candidate: Google's own design sample, then the same plain line (no style)",
             "and the same emotional line. Pick one (or say what to change).", ""]
    for cand in c["candidates"]:
        lines += [f"CANDIDATE {cand['label']}", f"  voice id:    {cand['voice']}", f"  description: {cand['description']}",
                  f"  expires:     {(cand.get('expire_time') or '?')[:10]}"]
        for t in log:
            if t["voice"] == cand["voice"] and t["situation"] in names:
                fn = f"{cand['label']} - {names[t['situation']]}.wav"
                with open(os.path.join(TAKES, c["name"], t["file"]), "rb") as src, open(os.path.join(out, fn), "wb") as dst:
                    dst.write(src.read())
                lines.append(f"  {fn}: {t['seconds']} s" + ("" if t["situation"] == "design" else f", style \"{t['style']}\", text: {t['text']}"))
        lines.append("")
    with open(os.path.join(out, "Voice pick.txt"), "w", encoding="utf-8") as fh:
        fh.write(chr(10).join(lines))
    print(f"  -> output/{c['name']}/0 Voice pick/")


def cast_overview():
    """output/Cast voices.txt: every locked voice, so a new one can be checked against them."""
    rows = ["CAST VOICES - who already sounds like what (check a new voice against these so no two get confused)", ""]
    for f in sorted(os.listdir(CHARS)):
        c = load(os.path.join("characters", f))
        if c.get("locked"):
            d = next((x["description"] for x in c["candidates"] if x["voice"] == c["voice"]), "")
            rows.append(f"{c['name']:9} {c.get('gender') or '?':7} {c['voice']}  {d}")
    os.makedirs(os.path.join(HERE, "output"), exist_ok=True)
    with open(os.path.join(HERE, "output", "Cast voices.txt"), "w", encoding="utf-8") as fh:
        fh.write(chr(10).join(rows) + chr(10))


def cmd_keep(a):
    c = character(a.char)
    c["voice"], c["locked"] = a.voice, True
    if a.style is not None:
        c["base_style"] = a.style
    c["locked_at"] = datetime.date.today().isoformat()
    save_character(c)
    print(f"{c['name']} is locked: voice {a.voice}" + (f", base style \"{c['base_style']}\"" if c.get("base_style") else ""))
    cast_overview()
    cmd_page(a)


def cmd_page(a=None):
    """listen.html: every character's takes, newest first, with the voice, style and text of each."""
    parts = ["<!doctype html><meta charset='utf-8'><title>Werewolf voices</title><style>"
             "body{font-family:Georgia,serif;background:#14121a;color:#e8e2d6;max-width:980px;margin:24px auto;padding:0 16px}"
             "h2{border-bottom:1px solid #3a3446;padding-bottom:4px;margin-top:36px}.lock{color:#7fd68f}"
             ".t{background:#1e1b26;border-radius:8px;padding:10px 14px;margin:10px 0}.m{color:#a59cb6;font-size:13px}"
             "audio{width:100%;margin-top:6px}</style><h1>Werewolf voices</h1>"]
    for f in sorted(os.listdir(CHARS)):
        c = load(os.path.join("characters", f))
        p = os.path.join(TAKES, c["name"], "log.jsonl")
        takes = [json.loads(l) for l in open(p, encoding="utf-8")] if os.path.exists(p) else []
        if not takes and not c.get("locked"):
            continue
        lock = f" <span class='lock'>locked: {html.escape(c['voice'])}</span>" if c.get("locked") else ""
        parts.append(f"<h2>{html.escape(c['name'])} <span class='m'>({c['kind']})</span>{lock}</h2>")
        for t in reversed(takes):
            parts.append(f"<div class='t'><b>#{t['no']} {html.escape(t['title'])}</b> <span class='m'>voice {html.escape(t['voice'])}"
                         f" &middot; style \"{html.escape(t.get('style') or '')}\" &middot; {t['seconds']} s</span>"
                         f"<div>{html.escape(t['text'])}</div><audio controls preload='none' src='takes/{html.escape(c['name'])}/{html.escape(t['file'])}'></audio></div>")
    with open(os.path.join(HERE, "listen.html"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts))


def main():
    ap = argparse.ArgumentParser(description="Werewolf character voices (Gemini 3.8 TTS)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    p = sub.add_parser("voices"); p.add_argument("--search"); p.add_argument("--gender")
    p = sub.add_parser("design"); p.add_argument("char"); p.add_argument("description"); p.add_argument("--label"); p.add_argument("--gender")
    p = sub.add_parser("say"); p.add_argument("char"); p.add_argument("situation", nargs="?")
    for x in ("--voice", "--style", "--text", "--label", "--model"):
        p.add_argument(x)
    p = sub.add_parser("audition"); p.add_argument("char")
    for x in ("--voice", "--style", "--only", "--label", "--model"):
        p.add_argument(x)
    p = sub.add_parser("keep"); p.add_argument("char"); p.add_argument("--voice", required=True); p.add_argument("--style")
    p = sub.add_parser("pick"); p.add_argument("char"); p.add_argument("label")
    p = sub.add_parser("voicepick"); p.add_argument("char")
    p = sub.add_parser("approve"); p.add_argument("char"); p.add_argument("situation"); p.add_argument("take", type=int)
    p = sub.add_parser("scene"); p.add_argument("char"); p.add_argument("ids", help="situation ids, comma separated, or all")
    for x in ("--voice", "--style", "--text", "--model"):
        p.add_argument(x)
    sub.add_parser("page")
    a = ap.parse_args()
    {"status": cmd_status, "voices": cmd_voices, "design": cmd_design, "say": cmd_say, "audition": cmd_audition,
     "keep": cmd_keep, "page": cmd_page, "pick": cmd_pick, "scene": cmd_scene, "voicepick": cmd_voicepick, "approve": cmd_approve}[a.cmd](a)


if __name__ == "__main__":
    main()
