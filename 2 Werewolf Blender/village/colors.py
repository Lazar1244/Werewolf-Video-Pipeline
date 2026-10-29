"""Model colours (owner, 2026-10-27): every model keeps one colour in every video, like its voice. Pure Python (no bpy),
shared by the Blender scripts (common.py) and the text layer (director/compose.py).

Game 2 (06ce0859) is the reference: each of its models keeps the colour of the seat it had there. A model new to the
videos gets a colour no model has yet (never red: red is the wolves'). The map is ../model_colors.json; Game 1
(3880b590) keeps its own seat colours, exactly as it was published.

    from colors import SEAT_COLORS, use_game
    use_game("c0416225")    # SEAT_COLORS[seat - 1] is now that seat's MODEL colour (the list is changed in place)
"""
import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # "2 Werewolf Blender"
MAP = os.path.join(BASE, "model_colors.json")
PALETTE = {
    # the original seat colours 1..10
    "amber": (1.0, 0.76, 0.12), "sky blue": (0.38, 0.76, 1.0), "green": (0.12, 0.82, 0.32), "magenta": (0.95, 0.28, 0.78),
    "white": (0.95, 0.95, 0.95), "cyan": (0.05, 0.88, 0.82), "violet": (0.62, 0.42, 1.0), "lime": (0.74, 0.96, 0.18),
    "orange": (1.0, 0.45, 0.05), "royal blue": (0.18, 0.36, 1.0),
    # added 2026-10-27 for the models beyond ten
    "peach": (1.0, 0.68, 0.50), "mint": (0.58, 1.0, 0.78), "lilac": (0.86, 0.72, 1.0), "sand": (0.86, 0.72, 0.46),
}
SEAT_ORDER = ["amber", "sky blue", "green", "magenta", "white", "cyan", "violet", "lime", "orange", "royal blue"]
DEFAULT = [PALETTE[n] for n in SEAT_ORDER]
SEAT_COLORS = list(DEFAULT)  # changed in place by use_game(), so every module that imported it sees the game's colours


def _episode_seats(gid):
    path = os.path.join(BASE, "games", gid[:8], "episode.json")
    if not os.path.exists(path):
        return None
    return {s["seat"]: s["model_short"] for s in json.load(open(path, encoding="utf-8"))["seats"]}


def use_game(gid):
    """Give each seat of this game its model's colour (a model not in the map yet gets the first unused colour, saved
    to the map). Returns the colours by seat name, for the log."""
    SEAT_COLORS[:] = DEFAULT
    m = json.load(open(MAP, encoding="utf-8"))
    if gid[:8] in m.get("_seat_colours_games", []):  # Game 1: its own seat colours, as published
        return {}
    seats = _episode_seats(gid)
    if not seats:
        return {}
    colours = m["colours"]
    changed = False
    for seat, model in sorted(seats.items()):
        if model not in colours:
            free = [n for n in PALETTE if n not in colours.values()]
            if not free:
                raise ValueError("no unused colour left in colors.PALETTE: add one (never red)")
            colours[model] = free[0]
            changed = True
            print(f"[colours] {model} is new to the videos: colour {free[0]}")
    if changed:
        open(MAP, "w", encoding="utf-8").write(json.dumps(m, indent=1, ensure_ascii=False))
    for seat, model in seats.items():
        if 1 <= seat <= len(SEAT_COLORS):
            SEAT_COLORS[seat - 1] = PALETTE[colours[model]]
    return {seat: colours[model] for seat, model in seats.items()}


def signature():
    """A short key of the current colours for render caches: empty for the original seat colours (Games 1 and 2 keep
    their cached clips), else a fingerprint, so a colour change re-renders."""
    if SEAT_COLORS == DEFAULT:
        return ""
    return "-c" + "".join(f"{round(c * 99):02d}" for rgb in SEAT_COLORS for c in rgb)[:40]
