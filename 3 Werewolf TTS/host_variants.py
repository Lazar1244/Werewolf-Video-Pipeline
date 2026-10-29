"""Style variants for the chosen intro host voice (owner, 2026-10-19: candidate E). The whole host part of the intro
script (INTRO_PLAN.md, draft v3) is read in several styles, two takes each, so the delivery can be chosen by ear.
Output: output/Host/1 Style variants/ (E - <n><take> <style>.wav and Style variants.txt). Google's limits are waited out.

    python host_variants.py [<candidate label>]
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.chdir(HERE)
import night_job as nj  # noqa: E402
import tts  # noqa: E402

SCRIPT = ("That's one wolf. The other one is hiding among these six. "
          "Two Claudes. Two GPTs. Gemini... and Grok. "
          "Werewolves kill at night... and lie all day. "
          "The Seer gets one look into a soul. Wolf... or not? "
          "The Witch: one potion saves... one kills. "
          "Everyone else? Just their voice... and their vote. "
          "Catch both wolves, the village wins. Let them match your numbers... wolves win. "
          "Two wolves. Four innocents. Can they catch Fable in time? Let's play.")
STYLES = [
    ("1 hook host", "high-energy video host, punchy and fast"),
    ("2 trailer", "hyped movie-trailer narrator, building intensity"),
    ("3 dark", "dark and dramatic, low and gripping"),
    ("4 playful", "excited and playful, grinning"),
    ("5 suspense", "hushed suspense, then explosive"),
    ("6 rapid-fire", "rapid-fire sports commentator energy"),
    ("7 smirk", "mysterious storyteller with a smirk"),
    ("8 urgent", "urgent and breathless, high stakes"),
]
TAKES = 2


def main(label="E"):
    c = tts.character("Host")
    cand = next(x for x in c["candidates"] if x["label"] == label)
    out = os.path.join("output", "Host", "1 Style variants")
    os.makedirs(out, exist_ok=True)
    model = tts.load("config.json")["model"]
    for name, style in STYLES:
        for t in range(TAKES):
            path = os.path.join(out, f"{label} - {name} - take {t + 1}.wav")
            if os.path.exists(path):
                continue

            def go():
                tts.guard(tts.estimate(SCRIPT, model))
                raw = tts.speak(SCRIPT, cand["voice"], style, model)
                secs = tts.write_wav(raw, path)
                tts.charge(tts.audio_cost(secs, SCRIPT, model), f"Host {label} style {name} take {t + 1}")
                return secs
            try:
                secs = nj.api(go)
                nj.note(f"Host {label}: {name} take {t + 1}, {secs:.1f} s")
            except BaseException as e:
                nj.note(f"Host {label}: {name} take {t + 1} failed ({str(e)[:120]})")
    with open(os.path.join(out, "Style variants.txt"), "w", encoding="utf-8") as f:
        f.write(f"Intro host, candidate {label} ({cand['voice']}): {cand['description']}\n")
        f.write(f"Every file reads the same text (the host part of INTRO_PLAN.md draft v3):\n{SCRIPT}\n\n")
        for name, style in STYLES:
            f.write(f"{name}: style \"{style}\" (2 takes: every generation differs a little)\n")
    nj.note(f"Host {label}: style variants ready in output/Host/1 Style variants/")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "E")
