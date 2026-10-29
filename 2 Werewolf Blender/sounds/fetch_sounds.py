"""Download the sounds listed in library.json into sounds/_source/ (owner approval first: see SOUNDS.md).

    python sounds/fetch_sounds.py [--optional]

Already downloaded files are skipped. Optional sounds (e.g. the village-win ending music) only with --optional.
Every source is CC0; the page each one came from is in library.json and CREDITS.txt.
"""
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    lib = json.load(open(os.path.join(HERE, "library.json"), encoding="utf-8"))
    os.makedirs(os.path.join(HERE, "_source"), exist_ok=True)
    got = 0
    for sid, s in lib.items():
        if s.get("optional") and "--optional" not in sys.argv:
            continue
        path = os.path.join(HERE, s["raw"])
        if os.path.exists(path) and os.path.getsize(path) > 0:
            continue
        req = urllib.request.Request(s["source"], headers={"User-Agent": "Mozilla/5.0 (werewolf video pipeline)"})
        for attempt in range(3):
            try:
                data = urllib.request.urlopen(req, timeout=120).read()
                break
            except Exception as e:  # a busy site: wait and try again
                print(f"{sid}: {e}; retrying")
                time.sleep(15 * (attempt + 1))
        else:
            print(f"{sid}: FAILED")
            continue
        with open(path + ".part", "wb") as f:
            f.write(data)
        os.replace(path + ".part", path)
        got += 1
        print(f"{sid}: {len(data) / 1e6:.1f} MB  {s['title']}")
        time.sleep(2)
    with open(os.path.join(HERE, "CREDITS.txt"), "w", encoding="utf-8") as f:
        f.write("Sounds used in the Werewolf videos. All are CC0 (public domain); credit is given as a courtesy.\n\n")
        for sid, s in lib.items():
            f.write(f"{sid}  {s['title']}  {s['page']}\n")
    print(f"{got} downloaded; CREDITS.txt written")


if __name__ == "__main__":
    main()
