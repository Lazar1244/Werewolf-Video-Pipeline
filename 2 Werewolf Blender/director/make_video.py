"""One command for a game video: export → episode → plan → clips (parallel) → overlays → MP4.

    python director/make_video.py --list
    python director/make_video.py <game id or prefix> [--until night2] [--parts 2] [--hd]

`--until` names the phase where the video stops ("night2" = Night 1 + Day 1, the test sequence); without it, the
whole game. `--hd` (Game 2 onward): 1920x1080 pictures and the best encode (default 1280x720). The game's database is only read. Clips render in background Blender processes (`--parts` of them at
once; the owner's open Blender is untouched) and are cached, so re-running after an edit only redoes what changed.
"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)  # this Blender folder ("2 Werewolf Blender")
BLENDER = r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
SETS = os.path.join(BASE, "out", "village.blend")
ENV = {**os.environ, "PYTHONIOENCODING": "utf-8"}


def run(cmd, show=("[", "Traceback", "Error:")):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=ENV)
    for line in (p.stdout + p.stderr).splitlines():
        if line.startswith(show) and "Shadow buffer" not in line:
            print("  " + line)
    if p.returncode != 0:
        sys.exit(f"step failed: {' '.join(cmd[:4])}")


def main():
    if len(sys.argv) < 2 or sys.argv[1] == "--list":
        run([sys.executable, os.path.join(HERE, "export_game.py"), "--list"], show=("",))
        return
    prefix = sys.argv[1]
    until = ["--until", sys.argv[sys.argv.index("--until") + 1]] if "--until" in sys.argv else []
    parts = int(sys.argv[sys.argv.index("--parts") + 1]) if "--parts" in sys.argv else 2
    hd = "--hd" in sys.argv
    size = ["--size", "1920x1080"] if hd else []
    t0 = time.time()
    run([sys.executable, os.path.join(HERE, "export_game.py"), prefix], show=("exported",))
    gid = next(d for d in os.listdir(os.path.join(BASE, "games")) if d.startswith(prefix[:8]))
    run([sys.executable, os.path.join(HERE, "episode.py"), gid, *until], show=("episode",))
    run([sys.executable, os.path.join(HERE, "plan.py"), gid])
    procs = [subprocess.Popen([BLENDER, "--background", SETS, "--python", os.path.join(HERE, "render_clips.py"), "--", gid, "--part", str(i), "--parts", str(parts), *size],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", env=ENV) for i in range(parts)]
    for i, p in enumerate(procs):
        out, _ = p.communicate()
        for line in out.splitlines():
            if line.startswith(("[clips", "Traceback", "Error:")) and "Shadow" not in line:
                print("  " + line)
        if p.returncode != 0:
            sys.exit(f"clip render part {i} failed")
    run([sys.executable, os.path.join(HERE, "overlays.py"), gid])
    run([BLENDER, "--background", "--factory-startup", "--python", os.path.join(HERE, "encode_clips.py"), "--", gid, *(["--best"] if hd else [])])
    print(f"done in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
