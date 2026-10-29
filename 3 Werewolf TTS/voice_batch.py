"""Voice a whole episode with as few speech requests as possible (owner, 2026-10-15): each speaker's lines go out
together, several per request, each line its own text part with its own approved style and no pause tags (the
"<long pause>" separator was read out loud). The audio is cut where a Gemini text model says each line starts and ends,
snapped to the nearest silence, and every piece is transcribed and checked against its line. A line that does not match
is made again on its own. Text-model calls have their own daily limit, so only the speech requests count.

    python voice_batch.py <game id> [--fresh]

Lines are batched per speaker AND style (a whisper in the same request bleeds into a plain line). --fresh makes every
line again instead of reusing earlier takes.

Output, as voice_episode.py: FullGameFolder/<game>/voices/beat_###_<speaker>.wav, voices.json (copied to the Blender
game folder) and takes.json (every take ever made; a line already voiced, same speaker and words, is reused).
"""
import base64
import difflib
import json
import os
import re
import shutil
import sys
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PIPE = os.path.dirname(HERE)
sys.path.insert(0, HERE)
os.chdir(HERE)
import night_job as nj  # noqa: E402  (its api() waits out Google's limits)
import tts  # noqa: E402

sys.path.insert(0, os.path.join(PIPE, "2 Werewolf Blender", "director"))
import spoken  # noqa: E402

TEXT_MODEL = "gemini-3.8-flash"  # for timing and checking (not the speech model, so not its request limit)
MAX_LINES, MAX_WORDS = 8, 110  # per speech request
PARALLEL = 3  # speakers voiced at the same time
MATCH = 0.8  # how close a piece's transcript must be to its line (word sequence similarity)
NUM = "zero one two three four five six seven eight nine ten eleven twelve".split()


def save_json(path, data):
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(path + ".tmp", path)


def gemini(parts, json_out=False):
    body = {"contents": [{"parts": parts}], "generationConfig": {"temperature": 0, **({"responseMimeType": "application/json"} if json_out else {})}}
    req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{TEXT_MODEL}:generateContent",
                                 data=json.dumps(body).encode(), headers={"x-goog-api-key": tts.key(), "Content-Type": "application/json"})
    for attempt in range(4):
        try:
            r = json.loads(urllib.request.urlopen(req, timeout=180).read())
            return "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"]).strip()
        except Exception as e:  # a busy text model: wait and try again
            if attempt == 3:
                raise
            nj.note(f"text model: {e}; retrying")
            __import__("time").sleep(20 * (attempt + 1))


def audio_part(path):
    return {"inline_data": {"mime_type": "audio/wav", "data": base64.b64encode(open(path, "rb").read()).decode()}}


def words(t):
    t = t.lower().replace("’", "'")
    t = re.sub(r"\b(\d{1,2})\b", lambda m: NUM[int(m.group(1))] if int(m.group(1)) < len(NUM) else m.group(1), t)
    return re.findall(r"[a-z']+", t)


def matches(heard, line):
    """The piece says its line: close enough word for word, and no spoken tag such as "long pause"."""
    a, b = words(heard), words(line)
    if not b or ("pause" in a and "pause" not in b):
        return False
    return difflib.SequenceMatcher(None, a, b).ratio() >= MATCH


def read(path):
    with wave.open(path, "rb") as w:
        return w.getframerate(), np.frombuffer(w.readframes(w.getnframes()), np.int16)


def silences(samples, sr):
    """(start, end) in seconds of every pause of at least 0.12 s."""
    fr = int(sr * 0.02)
    n = len(samples) // fr
    x = samples[:n * fr].astype(np.float32) / 32768
    rms = np.sqrt((x.reshape(n, fr) ** 2).mean(1))
    quiet = rms < max(0.03 * np.percentile(rms, 95), 1e-4)
    out, i = [], 0
    while i < n:
        if quiet[i]:
            j = i
            while j < n and quiet[j]:
                j += 1
            if j - i >= 6:
                out.append((i * 0.02, j * 0.02))
            i = j
        else:
            i += 1
    return out


def cut_points(path, lines):
    """Where line k ends and line k+1 starts, in seconds: the text model's timing, snapped to the nearest silence."""
    prompt = ("This audio is one speaker reading these lines in order:\n" + "\n".join(f"{i + 1}. {l}" for i, l in enumerate(lines)) +
              "\nFor each line, give the time in seconds (two decimals) where its first word starts and where its last word ends. "
              'Answer only with JSON: [{"line": 1, "start": 0.00, "end": 0.00}, ...]')
    times = json.loads(gemini([audio_part(path), {"text": prompt}], json_out=True))
    times = sorted(times, key=lambda t: t["line"])
    if len(times) != len(lines):
        return None
    sr, samples = read(path)
    gaps = silences(samples, sr)
    cuts, used = [], set()
    for a, b in zip(times, times[1:]):
        mid = (float(a["end"]) + float(b["start"])) / 2
        near = [g for g in gaps if g not in used and abs((g[0] + g[1]) / 2 - mid) < 1.5]
        if not near:
            return None
        g = min(near, key=lambda g: abs((g[0] + g[1]) / 2 - mid))
        used.add(g)
        cuts.append(g)
    if cuts != sorted(cuts):
        return None
    total = len(samples) / sr
    bounds, start = [], 0.0
    for g in cuts:
        bounds.append((start, g[0] + 0.12))
        start = max(0.0, g[1] - 0.12)
    bounds.append((start, total))
    return bounds


def tighten(path, keep=0.1):
    """Silence at the start and end of a take cut to `keep` seconds (owner: shorter pauses between one character's lines)."""
    sr, x = read(path)
    gaps = silences(x, sr)
    a = gaps[0][1] if gaps and gaps[0][0] == 0 else 0.0
    b = gaps[-1][0] if gaps and gaps[-1][1] >= len(x) / sr - 0.03 else len(x) / sr
    a, b = max(0.0, a - keep), min(len(x) / sr, b + keep)
    return write_piece(x, sr, a, b, path)


def write_piece(samples, sr, a, b, path):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(samples[int(a * sr):int(b * sr)].tobytes())
    return (int(b * sr) - int(a * sr)) / sr


class Voicer:
    def __init__(self, gid):
        self.gid = gid
        self.gdir = os.path.join(PIPE, "2 Werewolf Blender", "games", gid)
        self.ep = json.load(open(os.path.join(self.gdir, "episode.json"), encoding="utf-8"))
        self.seats = {s["seat"]: s for s in self.ep["seats"]}
        self.out = os.path.join(PIPE, "FullGameFolder", gid)
        self.vdir = os.path.join(self.out, "voices")
        self.bdir = os.path.join(self.vdir, "_batches")
        os.makedirs(self.bdir, exist_ok=True)
        self.man_path, self.pool_path = os.path.join(self.out, "voices.json"), os.path.join(self.out, "takes.json")
        self.pool = json.load(open(self.pool_path, encoding="utf-8")) if os.path.exists(self.pool_path) else []
        self.model = tts.load("config.json")["model"]
        self.lock = __import__("threading").Lock()
        self.requests = 0
        self.fresh = False
        self.run_id = __import__("datetime").datetime.now().strftime("%Y%m%d_%H%M%S")

    def have(self):
        """Takes to reuse, by speaker and words; with --fresh only the takes made in this run count."""
        return {(e["speaker"], e["text"]): e for e in self.pool if os.path.exists(e["file"]) and (not self.fresh or e.get("run") == self.run_id)}

    def add(self, e):
        with self.lock:
            self.pool.append(e)
            save_json(self.pool_path, self.pool)

    def style(self, speaker, sit):
        c = tts.character(speaker)
        return c["approved"][sit]["style"], c["voice"]

    def speech(self, texts_styles, voice, path):
        """One speech request (Google's limits are waited out by night_job.api)."""
        content = []
        for text, style in texts_styles:
            part = {"type": "text", "text": text}
            if style:
                part["annotations"] = [{"type": "speech_metadata", "style": style}]
            content.append(part)
        body = {"model": tts.MODELS[self.model], "input": [{"type": "user_input", "content": content}],
                "response_format": {"type": "audio", "mime_type": "audio/wav", "sample_rate": 24000},
                "generation_config": {"speech_config": [{"voice": voice}]}, "stream": False}

        def go():
            with self.lock:
                tts.guard(sum(tts.estimate(t, self.model) for t, _ in texts_styles))
            raw = tts.find_audio(tts.call("POST", "/interactions", body))
            if not raw:
                raise RuntimeError("no audio in the response")
            secs = tts.write_wav(raw, path)
            with self.lock:
                tts.charge(tts.audio_cost(secs, " ".join(t for t, _ in texts_styles), self.model), f"episode {self.gid}: {len(texts_styles)} line(s)")
                self.requests += 1
            return secs
        return nj.api(go)

    def entry(self, i, speaker, sit, style, voice, text, file, secs, batch=None):
        return {"file": file, "seconds": round(secs, 2), "speaker": speaker, "voice": voice, "situation": sit, "style": style,
                "text": text, "kind": self.ep["beats"][i]["kind"], "run": self.run_id, **({"batch": batch} if batch else {})}

    def fname(self, i, speaker):
        f = os.path.join(self.vdir, f"beat_{i:03d}_{speaker}.wav")
        n = 1
        while os.path.exists(f):  # never overwrite another line's take
            n += 1
            f = os.path.join(self.vdir, f"beat_{i:03d}_{speaker}_{n}.wav")
        return f

    def single(self, i, speaker, sit, text):
        style, voice = self.style(speaker, sit)
        f = self.fname(i, speaker)
        self.speech([(text, style)], voice, f)
        secs = tighten(f)
        try:
            heard = gemini([audio_part(f), {"text": "Transcribe this audio exactly, word for word. Output only the transcript."}])
        except BaseException as e:  # Game 3 beat 134: the check came back empty every time; the take is kept, as for a differing transcript
            heard = f"no transcript: {str(e)[:60]}"
        ok = matches(heard, text)
        nj.note(f"{self.gid} beat {i} {speaker}: single take {secs:.1f} s{'' if ok else ' (transcript differs: ' + heard[:80] + ')'}")
        self.add(self.entry(i, speaker, sit, style, voice, text, f, secs))

    def batch(self, speaker, chunk):
        """chunk: [(beat index, situation, text)] of one speaker -> lines that still need a take of their own."""
        voice = tts.character(speaker)["voice"]
        ts = [(text, self.style(speaker, sit)[0]) for _, sit, text in chunk]
        if len(chunk) == 1:
            self.single(chunk[0][0], speaker, chunk[0][1], chunk[0][2])
            return []
        whole = os.path.join(self.bdir, f"{speaker}_{chunk[0][0]:03d}-{chunk[-1][0]:03d}.wav")
        self.speech(ts, voice, whole)
        bounds = cut_points(whole, [t for _, _, t in chunk])
        if not bounds:
            nj.note(f"{self.gid} {speaker}: could not place the cuts in {os.path.basename(whole)}; those lines go one by one")
            return chunk
        sr, samples = read(whole)
        retry = []
        for (i, sit, text), (a, b), (_, style) in zip(chunk, bounds, ts):
            f = self.fname(i, speaker)
            write_piece(samples, sr, a, b, f)
            secs = tighten(f)
            heard = gemini([audio_part(f), {"text": "Transcribe this audio exactly, word for word, including any words that sound like "
                                                    "tags or stage directions. Output only the transcript."}])
            if matches(heard, text):
                self.add(self.entry(i, speaker, sit, style, voice, text, f, secs, batch=os.path.basename(whole)))
            else:
                os.remove(f)
                nj.note(f"{self.gid} beat {i} {speaker}: piece did not match its line (heard: {heard[:90]}); redo alone")
                retry.append((i, sit, text))
        nj.note(f"{self.gid} {speaker}: {len(chunk) - len(retry)} of {len(chunk)} lines from one request")
        return retry

    def run(self):
        have = self.have()
        todo = {}
        for i, b in enumerate(self.ep["beats"]):
            speaker, sit, text = spoken.line(b, self.seats)
            if (speaker, text) not in have:
                todo.setdefault(speaker, []).append((i, sit, text))
        chunks = []
        groups = {}
        for speaker, lines in todo.items():  # one style per request: a whisper must not bleed into a plain line
            for ln in lines:
                groups.setdefault((speaker, self.style(speaker, ln[1])[0]), []).append(ln)
        for (speaker, _), lines in groups.items():
            cur, w = [], 0
            for ln in lines:
                n = len(ln[2].split())
                if cur and (len(cur) >= MAX_LINES or w + n > MAX_WORDS):
                    chunks.append((speaker, cur))
                    cur, w = [], 0
                cur.append(ln)
                w += n
            if cur:
                chunks.append((speaker, cur))
        nj.note(f"voice batch {self.gid}: {sum(len(v) for v in todo.values())} lines to voice in {len(chunks)} requests")
        def safe_batch(c):
            try:
                return self.batch(*c)
            except BaseException as e:  # a refused or broken request: those lines go one by one
                nj.note(f"{self.gid} {c[0]}: batch failed ({str(e)[:120]}); lines go one by one")
                return c[1]

        with ThreadPoolExecutor(PARALLEL) as ex:
            retry = [ln + (speaker,) for (speaker, _), left in zip(chunks, ex.map(safe_batch, chunks)) for ln in left]
        for i, sit, text, speaker in retry:
            try:
                self.single(i, speaker, sit, text)
            except BaseException as e:
                nj.note(f"{self.gid} beat {i} {speaker}: FAILED ({str(e)[:160]})")
        have = self.have()
        man = {}
        for i, b in enumerate(self.ep["beats"]):
            speaker, _, text = spoken.line(b, self.seats)
            if (speaker, text) in have:
                man[str(i)] = have[(speaker, text)]
        save_json(self.man_path, man)
        shutil.copy(self.man_path, os.path.join(self.gdir, "voices.json"))
        nj.note(f"voice batch {self.gid}: {len(man)} of {len(self.ep['beats'])} beats voiced, {self.requests} speech requests")


if __name__ == "__main__":
    v = Voicer(sys.argv[1])
    v.fresh = "--fresh" in sys.argv  # owner: every line made again, none reused (one consistent generation)
    v.run()
