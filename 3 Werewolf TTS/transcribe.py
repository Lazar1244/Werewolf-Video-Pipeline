"""Check what a take really says, with a Gemini text model (its own request limit, not the speech model's).

    python transcribe.py <wav> [<wav> ...]
"""
import base64
import json
import sys
import urllib.request

import tts

MODEL = "gemini-3.8-flash"
PROMPT = ("Transcribe this audio exactly, word for word, including any words that sound like stage directions or tags "
          "(for example 'long pause'). Output only the transcript.")


def transcribe(path):
    data = base64.b64encode(open(path, "rb").read()).decode()
    body = {"contents": [{"parts": [{"inline_data": {"mime_type": "audio/wav", "data": data}}, {"text": PROMPT}]}],
            "generationConfig": {"temperature": 0}}
    req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
                                 data=json.dumps(body).encode(), headers={"x-goog-api-key": tts.key(), "Content-Type": "application/json"})
    r = json.loads(urllib.request.urlopen(req, timeout=120).read())
    return "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"]).strip()


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(p, "->", transcribe(p))
