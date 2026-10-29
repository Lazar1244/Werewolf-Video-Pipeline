"""Pronouns follow the VOICE (owner, 2026-10-22): each model speaks with its own character voice in every video
(voice_cast.json), which may not match the gender of the character name it had in the game. So, in what players say
and think, he/she/him/her/his/hers/himself/herself that refer to a player are made to match that player's voice, and a
player never talks about themselves in the third person ("Fable is the Hunter", said by Fable -> "I am the Hunter").

A Gemini text model rewrites the line; the result is then checked word by word: only pronouns, first-person words,
the speaker's own name and a few verb forms ("is" -> "am") may change. Otherwise the line stays exactly as the model
wrote it. Results are cached in games/<id8>/pronouns.json, so a rebuilt episode gives the same text without new calls.

    Voiced(players, cache_path)(speaker, text) -> text      players: call name -> "he" or "she"
"""
import difflib
import json
import os
import re
import time
import urllib.request

from names import TEXT_MODEL, _key

PRONOUNS = {"he", "she", "him", "her", "his", "hers", "himself", "herself", "he's", "she's", "he'd", "she'd", "he'll", "she'll"}
FIRST = {"i", "me", "my", "mine", "myself", "i'm", "i've", "i'd", "i'll"}
VERBS = {"is", "am", "was", "has", "have", "does", "do", "isn't", "aren't", "wasn't", "hasn't", "haven't", "doesn't", "don't", "'s"}
NEEDS = re.compile(r"(?i)\b(he|she|him|her|his|hers|himself|herself)\b")


class Voiced:
    def __init__(self, players, cache_path):
        self.players = dict(players)  # call name -> "he" / "she"
        self.path = cache_path
        self.cache = json.load(open(cache_path, encoding="utf-8")) if os.path.exists(cache_path) else {}

    def _save(self):
        with open(self.path + ".tmp", "w", encoding="utf-8") as f:
            json.dump(self.cache, f, indent=1, ensure_ascii=False)
        os.replace(self.path + ".tmp", self.path)

    @staticmethod
    def _words(t):
        return re.findall(r"[a-z0-9']+", t.lower().replace(chr(0x2019), "'"))

    def _ok(self, before, after, speaker):
        """Only pronouns, first-person words, the speaker's own name and a few verb forms changed."""
        allowed = PRONOUNS | FIRST | VERBS | {speaker.lower(), speaker.lower() + "'s"}
        a, b = self._words(before), self._words(after)
        for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
            if op != "equal" and not set(a[i1:i2] + b[j1:j2]) <= allowed:
                return False
        return True

    def __call__(self, speaker, text):
        if not NEEDS.search(text) and not re.search(rf"\b{re.escape(speaker)}\b", text):
            return text
        key = f"{speaker}|{text}"
        if key in self.cache:
            return self.cache[key]
        table = ", ".join(f"{n} ({'she/her' if g == 'she' else 'he/him'})" for n, g in sorted(self.players.items()))
        prompt = (f"Players in a game and the pronouns to use for each: {table}.\n"
                  f"The line below was said (or thought) by {speaker}. Fix it with the smallest possible edits:\n"
                  "1. Every he/she/him/her/his/hers/himself/herself that refers to one of these players must use that player's "
                  "pronouns from the list. Pronouns about anyone else stay as they are.\n"
                  f"2. If {speaker} refers to themselves by their own name, use I/me/my/myself instead, and fix the verb "
                  f"(\"{speaker} is\" -> \"I am\").\n"
                  "Change nothing else: same words, same order, same punctuation. If nothing needs fixing, return the line "
                  "unchanged. Answer with the line only.\n\nLine: " + text)
        body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0}}
        out = ""
        for attempt in range(4):
            try:
                req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{TEXT_MODEL}:generateContent",
                                             data=json.dumps(body).encode(), headers={"x-goog-api-key": _key(), "Content-Type": "application/json"})
                r = json.loads(urllib.request.urlopen(req, timeout=120).read())
                out = "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"]).strip()
                break
            except Exception as e:  # busy (per-minute limit): wait and retry; anything else: keep the line as written
                if "429" in str(e) and attempt < 3:
                    time.sleep(20 * (attempt + 1))
                    continue
                print(f"[pronouns] text model unavailable ({e}); line kept as written")
                break
        if out.lower().startswith("line:"):
            out = out[5:].strip()
        if not out or not self._ok(text, out, speaker):
            if out:
                a, b = self._words(text), self._words(out)
                bad = [(a[i1:i2], b[j1:j2]) for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes() if op != "equal"]
                print(f"[pronouns] rejected, kept as written: {text[:60]!r}: {bad}")
            out = text
        self.cache[key] = out
        self._save()
        return out
