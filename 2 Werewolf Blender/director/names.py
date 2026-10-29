"""Players by name, not by seat (owner, 2026-10-15): the models often say "seat 3", "Seat 4's" or just "between 2 and 3".
For the video (text on screen and the voice), each line with a seat reference is rewritten by a Gemini text model
with the seat -> name map, then checked word by word: apart from the seat references (and a "the" or a comma), nothing
may change. If the check fails, only the explicit "seat N" forms are replaced by a plain rule. Results are cached in
games/<id8>/names.json, so a rebuilt episode gives the same text without new calls.

    named(text) -> text with names
"""
import json
import os
import re
import time
import urllib.request

PIPE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TEXT_MODEL = "gemini-3.8-flash"
NUM = "zero one two three four five six seven eight nine ten".split()


def _key():
    env = os.path.join(PIPE, "3 Werewolf TTS", ".env")
    for line in open(env, encoding="utf-8").read().splitlines():
        if "=" in line and not line.startswith("#") and "KEY" in line.split("=", 1)[0]:
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("no Google API key in '3 Werewolf TTS/.env'")


class Names:
    def __init__(self, seats, cache_path):
        self.seats = {int(k): v for k, v in seats.items()}  # seat -> name
        self.path = cache_path
        self.cache = json.load(open(cache_path, encoding="utf-8")) if os.path.exists(cache_path) else {}

    def _save(self):
        with open(self.path + ".tmp", "w", encoding="utf-8") as f:
            json.dump(self.cache, f, indent=1, ensure_ascii=False)
        os.replace(self.path + ".tmp", self.path)

    def _plain(self, text):
        """The safe fallback: only "seat N", "Seat N's" and lists after "seats" ("seats 3 and 6", "seats 2, 3 and 4") become names."""
        def names(m):
            return re.sub(r"\d{1,2}", lambda n: self.seats.get(int(n.group(0)), n.group(0)), m.group(1))
        return re.sub(r"\b[Ss]eats? (\d{1,2}(?:(?:, | and | or )\d{1,2})*)\b", names, text)

    def _ok(self, before, after):
        """Nothing but seat references changed: drop seat words, numbers, names, "the" and compare the rest."""
        names = {n.lower() for n in self.seats.values()}

        def rest(t):
            out = []
            for w in re.findall(r"[A-Za-z0-9']+", t.lower()):
                base = w[:-2] if w.endswith("'s") else w
                if base in names or base in ("seat", "seats", "the") or base.isdigit() or base in NUM:
                    continue
                out.append(w)
            return out
        # numbers that are not players (night 1, day 2, round 1, N1, 2v2) must all still be there
        keep = re.findall(r"(?i)\b(?:night|day|round|n|d)\s?\d+\b|\b\d+v\d+\b", before)
        return rest(before) == rest(after) and all(k in after for k in keep) and not re.search(r"\b[Ss]eats? \d", after)

    def tidy(self, text):
        """What a seat number next to its name leaves behind: "Dario, Dario" / "Viggo (Viggo)" -> one name; a list
        written "2,3,4" becomes "Nico, Mila, Viggo"."""
        for n in self.seats.values():
            text = re.sub(rf"\b{n}(?:, | \(){n}\)?", n, text)
        names = "|".join(self.seats.values())
        return re.sub(rf"\b({names}),(?=({names})\b)", r"\1, ", text)

    def __call__(self, text):
        if not re.search(r"\d|\b[Ss]eats?\b", text):
            return text
        if text in self.cache:
            return self.tidy(self.cache[text])
        table = ", ".join(f"seat {s} = {n}" for s, n in sorted(self.seats.items()))
        prompt = (f"Players in a game sit in numbered seats: {table}.\nIn the line below, replace every reference to a player by "
                  "seat number with that player's name: \"seat 3\" -> the name, \"seat 4's\" -> \"Name's\", and bare numbers that "
                  "clearly mean a player (\"asked 2 for a read\", \"between 2 and 3\", \"3's objection\", \"Witch 4\"). Leave numbers "
                  "that are not players unchanged (night 1, day 2, two wolves, 2v2, round 1). Change nothing else: same words, "
                  "same punctuation. Answer with the line only.\n\nLine: " + text)
        body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0}}
        out = ""
        for attempt in range(4):
            try:
                req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{TEXT_MODEL}:generateContent",
                                             data=json.dumps(body).encode(), headers={"x-goog-api-key": _key(), "Content-Type": "application/json"})
                r = json.loads(urllib.request.urlopen(req, timeout=120).read())
                out = "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"]).strip()
                break
            except Exception as e:  # busy (per-minute limit): wait and retry; anything else: the plain rule
                if "429" in str(e) and attempt < 3:
                    time.sleep(20 * (attempt + 1))
                    continue
                print(f"[names] text model unavailable ({e}); plain replacement")
                break
        if not out or not self._ok(text, out):
            out = self._plain(text)
        self.cache[text] = out
        self._save()
        return self.tidy(out)
