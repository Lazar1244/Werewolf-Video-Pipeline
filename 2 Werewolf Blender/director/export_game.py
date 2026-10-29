"""Step 1: export a finished game (read-only) to games/<id8>/game.json.

    python director/export_game.py [--list] [<game id or prefix>]

The database is opened read-only; the game itself is never changed. A finished game's whole log is spectator-visible,
so every event is exported (except the request bookkeeping). Each seat gets its character name, the model that
played it (and a short display name), its starting and final role.
"""
import json
import os
import sqlite3
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # this Blender folder ("2 Werewolf Blender")
DB = os.path.join(os.path.dirname(BASE), "1 Werewolf Game", "data", "wearwolfe.db")  # the game's database, read only
OUT = os.path.join(BASE, "games")
SKIP = {"REQUEST_OPENED", "REQUEST_CLOSED"}
VENDORS = ("OpenAI", "Google", "Anthropic", "Meta", "Z.ai", "Xiaomi", "Mistral", "xAI", "Moonshot", "Tencent", "StepFun",
           "Inception", "NVIDIA", "Cohere", "Nous")


def short_model(label):
    """'OpenAI GPT-5.6 Luna' -> 'GPT-5.6 Luna' (overrides in blender/short_names.json)."""
    overrides = {}
    path = os.path.join(BASE, "short_names.json")
    if os.path.exists(path):
        overrides = json.load(open(path, encoding="utf-8"))
    if label in overrides:
        return overrides[label]
    first, _, rest = label.partition(" ")
    return rest if first in VENDORS and rest else label


def connect():
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def list_games(c):
    rows = c.execute("select id, created_at, status, winner_team, cost_spent_usd, lobby_json from games where status = 'over' order by created_at desc").fetchall()
    for gid, created, status, winner, cost, lobby in rows:
        n = len(json.loads(lobby or "{}").get("slots", []))
        print(f"{gid[:8]}  {created[:16].replace('T', ' ')}  {n} players  winner: {winner or '?':10}  ${cost or 0:.2f}")
    return rows


def export(c, prefix):
    gid, created, cfg_json, winner = c.execute("select id, created_at, config_json, winner_team from games where id like ? and status = 'over'", (prefix + "%",)).fetchone()
    cfg = json.loads(cfg_json)
    labels = {s["slot"]: (s["profile"] or {}).get("label") for s in cfg["slots"]}
    events = []
    for eseq, typ, payload, at in c.execute("select eseq, type, payload_json, at_json from engine_events where game_id = ? order by eseq", (gid,)):
        if typ not in SKIP:
            events.append({"i": eseq, "type": typ, "at": json.loads(at), "payload": json.loads(payload)})
    start_roles = {e["payload"]["seat"]: e["payload"]["role"] for e in events if e["type"] == "ROLE_ASSIGNED"}
    seats = []
    for slot, seat, name, controller, human_name, frole, fteam in c.execute(
            "select slot, seat, display_name, controller, human_name, final_role, final_team from slots where game_id = ? order by seat", (gid,)):
        label = labels.get(slot) if controller == "ai" else f"Human ({human_name or 'player'})"
        seats.append({"seat": seat, "name": name, "model": label, "model_short": short_model(label) if controller == "ai" else (human_name or "Human"),
                      "human": controller != "ai", "role": start_roles.get(seat, frole), "final_role": frole, "final_team": fteam})
    game = {"id": gid, "created": created, "composition": cfg.get("compositionId"), "winner": winner, "seats": seats, "events": events}
    d = os.path.join(OUT, gid[:8])
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "game.json"), "w", encoding="utf-8") as f:
        json.dump(game, f, ensure_ascii=False, indent=1)
    print(f"exported {gid[:8]}: {len(seats)} seats, {len(events)} events -> {os.path.join(d, 'game.json')}")
    return game


if __name__ == "__main__":
    con = connect()
    if len(sys.argv) < 2 or sys.argv[1] == "--list":
        list_games(con)
    else:
        export(con, sys.argv[1])
