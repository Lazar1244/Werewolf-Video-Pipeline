"""Step 2: turn game.json into episode.json, a flat list of beats the renderer follows.

    python director/episode.py <id8> [--until day1]

A beat is one moment on screen:
    {"kind": "title" | "narration" | "speech" | "thought" | "card" | "tally",
     "shot": {"scene", "camera", "preset", "cast": [{seat, mark, pose, night, sheriff, lean, clawed}], "tokens": {...}},
     "seat": speaker (speech/thought), "text": ..., "duration": seconds, "labels": [seats that get a name label], ...}
Identical shots (same scene, light, cast and camera) render once; speech is timed by word count until TTS exists.
"""
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # this Blender folder ("2 Werewolf Blender")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from names import Names  # noqa: E402
from pronouns import Voiced  # noqa: E402
WOLVES = {"werewolf", "big_bad_wolf", "accursed_wolf_father", "white_werewolf"}
ROLE_NAME = {"werewolf": "a Werewolf", "seer": "the Seer", "witch": "the Witch", "hunter": "the Hunter", "villager": "a Villager", "cupid": "Cupid",
             "protector": "the Protector", "little_girl": "the Little Girl", "elder": "the Elder"}
CAUSE = {"attack": "killed by the pack", "poison": "poisoned by the Witch", "execution": "hanged by the village", "hunter": "shot by the Hunter",
         "heartbreak": "died of a broken heart", "bbw": "killed by the Big Bad Wolf", "white_wolf": "killed by the White Werewolf", "knight_curse": "struck by the Knight's curse"}
SOLO = {"white_werewolf", "thief", "wild_child", "wolf_hound", "piper", "angel"}
VISUAL_ROLE = {"werewolf": "werewolf", "seer": "seer", "witch": "witch", "hunter": "hunter"}  # roles with a built prop; others look plain


def words(t):
    return len(re.findall(r"[\w']+", t))


def trim(text, max_words):
    """Keep whole sentences up to about max_words; mark a cut with an ellipsis."""
    text = " ".join(text.split())
    sents = re.split(r"(?<=[.!?])\s+", text)
    out = []
    for s in sents:
        if out and words(" ".join(out + [s])) > max_words:
            break
        out.append(s)
    res = " ".join(out)
    if words(res) > max_words + 8:  # one very long sentence: cut it
        res = " ".join(res.split()[:max_words]).rstrip(",;:") + "…"
    return res  # whole sentences only, so the text on screen is exactly what the voice says


def pages(text, max_words=32):
    """The whole text in screens of about max_words (owner: full speeches, nothing cut): whole sentences per screen; a
    very long sentence is split at its commas, semicolons or dashes; a short last screen joins the one before."""
    text = " ".join(text.split())
    parts = []
    for s in re.split(r"(?<=[.!?…])\s+", text):
        if words(s) <= max_words + 8:
            parts.append(s)
            continue
        cur = ""
        for c in re.split(r"(?<=[,;:—])\s+", s):
            if cur and words(cur + " " + c) > max_words:
                parts.append(cur)
                cur = c
            else:
                cur = (cur + " " + c).strip()
        if cur:
            parts.append(cur)
    out, cur = [], []
    for s in parts:
        if cur and words(" ".join(cur + [s])) > max_words:
            out.append(" ".join(cur))
            cur = [s]
        else:
            cur.append(s)
    if cur:
        out.append(" ".join(cur))
    if len(out) > 1 and words(out[-1]) < 8 and words(out[-2]) + words(out[-1]) <= max_words + 10:
        out[-2:] = [out[-2] + " " + out[-1]]
    return out


def no_at(t):
    """Owner (2026-10-28): the models write "@Grok"; the "@" is neither read out nor shown: "Grok"."""
    return re.sub(r"@(?=\w)", "", t)


def call_names(seats):
    """What players are called in the video (owner, 2026-10-15): the short model name: "Claude Opus 5.5" -> Opus,
    "GPT-6 Sol" -> Sol, "Gemini 3.1 Pro" -> Gemini, "Grok 4.7" -> Grok. A model on several seats adds the character name."""
    def short(m):
        w = [x for x in m.split() if not re.search(r"\d", x) or x.lower().startswith(("gpt", "o"))]
        if w and w[0].lower() in ("claude", "openai", "anthropic") and len(w) > 1:
            w = w[1:]
        if w and re.match(r"(?i)gpt-?\d", w[0]) and len(w) > 1:
            w = w[1:]
        return w[0] if w else m
    out = {s["seat"]: short(s["model_short"]) for s in seats}
    for seat, n in list(out.items()):
        if sum(1 for v in out.values() if v == n) > 1:
            out[seat] = f"{n} {next(s['name'] for s in seats if s['seat'] == seat)}"
    return out


FILLERS = {  # what a silent player says instead of a blank (owner, 2026-10-14)
    "sheriff": ["I'm not running. Let someone else carry the star.", "Not for me this time. I'll vote, that's all."],
    "last_words": ["I have nothing more to say.", "...Just get it over with."],
    "challenge_answer": ["I won't dignify that with an answer.", "I have nothing to say to that."],
    "default": ["I don't feel like talking right now.", "Nothing to add. I'll listen.", "I'll stay quiet this round.",
                "Not much to say yet. Go on."],
}


def filler_line(context, seat, n):
    """The n-th filler of this seat: each player rotates through the lines instead of repeating one."""
    pool = FILLERS.get(context, FILLERS["default"])
    return pool[(seat + n) % len(pool)]


class Director:
    def __init__(self, game, named=None, gender=None, voiced=None):
        self.g = game
        self.named = named or (lambda t: t)  # seat numbers -> names in what players say (names.py)
        self.gender = gender or {}  # seat -> "he" / "she": the gender of the model's VOICE (owner, 2026-10-22)
        self.voiced = voiced or (lambda call, t: t)  # pronouns by voice, no third-person self-reference (pronouns.py)
        self.calls = call_names(game["seats"])  # seat -> short model name, what everyone is called in the video
        chars = {s["name"]: self.calls[s["seat"]] for s in game["seats"]}
        self.char_re = re.compile(r"\b(" + "|".join(map(re.escape, chars)) + r")\b")
        abbrev = {"N": "Night", "D": "Day"}  # "N1"/"D2" (players' shorthand) cannot be read aloud: spelled out
        self.to_calls = lambda t: re.sub(r"\b([ND])(\d{1,2})\b", lambda m: f"{abbrev[m.group(1)]} {m.group(2)}",
                                         self.char_re.sub(lambda m: chars[m.group(1)], t))
        self.seats = {s["seat"]: s for s in game["seats"]}
        self.alive = set(self.seats)
        self.sheriff = None
        self.beats = []
        self.phase = ("setup", 0)
        self.pending_thought = {}  # seat -> (context, reasoning)
        self.bodies = []
        self.fillers = {}  # seat -> how many filler lines it has had (to rotate them)
        self.failed = {}  # seat -> the decision its model could not answer (FALLBACK_USED): shown as it happened

    # ---------------- shots
    def vis_role(self, seat):
        return VISUAL_ROLE.get(self.seats[seat]["role"], "villager")

    def member(self, seat, mark, pose, night, lean=0.0, clawed=False):
        return {"seat": seat, "role": self.vis_role(seat), "mark": mark, "pose": pose, "night": night, "sheriff": seat == self.sheriff, "lean": lean, "clawed": clawed}

    def circle(self, preset, night_form):
        return [self.member(s, f"Seat_{s}", "sit", night_form) for s in sorted(self.alive)]

    def shot(self, scene, camera, preset, cast, tokens=None):
        return {"scene": scene, "camera": camera, "preset": preset, "cast": cast, "tokens": tokens or {}}

    def add(self, kind, shot, duration, **kw):
        ph, n = self.phase
        badge = {"night": f"Night {n}", "dawn": f"Dawn {n}", "day": f"Day {n}", "dusk": f"Dusk {n}"}.get(ph, "")
        b = {"kind": kind, "shot": shot, "duration": round(duration, 2), "phase": badge, **kw}
        self.beats.append(b)
        return b

    def next_filler(self, seat):
        self.fillers[seat] = self.fillers.get(seat, -1) + 1
        return self.fillers[seat]

    def name(self, seat):
        return self.calls[seat]

    # ---------------- beat helpers
    def title(self, text, sub, shot):
        self.add("title", shot, 2.8, text=text, sub=sub)

    def narrate(self, text, shot, labels=(), duration=3.4):
        self.add("narration", shot, duration + 0.8, text=text, labels=list(labels))  # +0.8 s: the caption types itself out

    def team(self, seat):
        s = self.seats[seat]
        return {"wolf": s["role"] in WOLVES, "lovers": bool(s.get("lover")), "solo": s["role"] in SOLO}

    def thought(self, seat, text, shot):
        if self.seats[seat]["role"] == "villager":  # owner: inner voice only for the special roles
            return
        t = trim(no_at(self.voiced(self.name(seat), self.to_calls(self.named(text)))), 18)
        self.add("thought", shot, max(3.2, words(t) / 3.2 + 1.7), seat=seat, text=t, labels=[seat], team=self.team(seat),
                 anim={"speaker": seat, "mode": "think"})

    def speech(self, seat, text, shot, context="", filler=False, round_no=None):
        thought = self.pending_thought.pop(seat, None)
        # owner: no inner monologue while the wolves talk among themselves, nor on the gallows (last words)
        if thought and context not in ("council", "last words"):
            self.thought(seat, thought, shot)
        screens = pages(no_at(self.voiced(self.name(seat), self.to_calls(self.named(text)))))  # owner: the whole speech, screen by screen in the same shot (nothing cut any more)
        for k, t in enumerate(screens):
            self.add("speech", shot, max(3.4, min(12.5, words(t) / 2.7 + 2.2)), seat=seat, text=t, labels=[seat], context=context,
                     anim={"speaker": seat, "mode": "talk"}, page=k + 1, pages=len(screens), **({"filler": True} if filler else {}),
                     **({"round": round_no} if round_no else {}))  # the discussion round: the sound gets tenser in round 2

    # ---------------- the walk
    def run(self, until):
        ev = self.g["events"]
        i = 0
        while i < len(ev):
            e = ev[i]
            t, p, at = e["type"], e["payload"], e["at"]
            if t == "PHASE_START":
                ph = p["phase"]
                n = p.get("night") or p.get("day") or at.get("night") or at.get("day")
                if until and f"{ph}{n}" == until:
                    break
                self.phase = (ph, n)
                if ph == "night":
                    self.title(f"NIGHT {n}", "The village falls asleep…", self.shot("Square", "Square_Wide", "night", self.circle("night", True)))
                elif ph == "day":  # the light turns from dawn to day as the title says the village wakes (owner: not before)
                    self.add("transition", self.shot("Square", "Square_Wide", "day", self.circle("day", False)), 4.0,
                             text=f"DAY {n}", sub="The village wakes", labels=[], **{"from": "dawn"})
            elif t == "SEAT_THOUGHTS":
                r = p.get("reasoning", "")
                if not re.search(r"(?i)(?<![a-z])(engine|transcript|requestid|json|prompt)(?![a-z])", r):  # thoughts about the machinery, not the game
                    self.pending_thought[p["seat"]] = r
            elif t == "NIGHT_ACTION":
                self.night_action(p)
            elif t == "CHANNEL_MSG" and p.get("message"):
                if p.get("channel", "lovers") == "lovers":  # owner: the Lovers meet in private, in the Room, not by the fire
                    pair = sorted(s for s in self.alive if self.seats[s].get("lover"))
                    cast = [self.member(s, mk, "sit", True) for s, mk in zip(pair, ("Role", "Guest"))]
                    shot = self.shot("Room", "Room_Wide", "night", cast)
                else:
                    shot = self.shot("Square", f"circle:{p['seat']}", "night", self.circle("night", True))
                self.speech(p["seat"], p["message"], shot, context="lovers")
            elif t == "LOVER_INFO":
                pass
            elif t == "SEER_RESULT":
                seer = next(s for s in self.alive if self.seats[s]["role"] == "seer")
                res = "A WEREWOLF!" if p["result"] != "not_werewolf" else "not a wolf."
                shot = self.shot("Room", "Room_Table", "night", [self.member(seer, "Role", "sit", True)])
                if seer in self.pending_thought:
                    self.thought(seer, self.pending_thought.pop(seer), shot)
                self.narrate(f"The Seer looks into {self.name(p['target'])}'s soul… {res}", shot, labels=[seer])
            elif t == "NIGHT_STEP_START" and p["role"] == "pack":
                self.pack_council(ev, i)
            elif t == "COUNCIL_MSG":
                wolves = [s for s in sorted(self.alive) if self.seats[s]["role"] in WOLVES]
                cast = [self.member(s, f"Wolf_{k + 2}", "stand", True) for k, s in enumerate(wolves[:3])]
                shot = self.shot("Clearing", "Clearing_Rock", "night", cast)
                if p.get("message"):
                    self.speech(p["seat"], p["message"], shot, context="council")
                else:  # a silent wolf: a short agreement with the proposal on the table, so the pack never goes quiet
                    start = max((k for k in range(i) if ev[k]["type"] in ("PHASE_START", "NIGHT_STEP_START")), default=0)
                    prop = next((x["payload"].get("proposed_target") for x in reversed(ev[start:i]) if x["type"] == "COUNCIL_MSG"
                                 and x["payload"].get("proposed_target") and x["payload"]["seat"] != p["seat"]), None)
                    n = self.next_filler(p["seat"])
                    if prop:
                        line = [f"Agreed. {self.name(prop)} it is.", f"Yes. {self.name(prop)}, tonight.", f"Fine by me. {self.name(prop)}."][n % 3]
                    else:
                        line = ["Agreed. I'll follow your lead.", "Your call. I'm with you.", "Fine. Lead the way."][n % 3]
                    self.speech(p["seat"], line, shot, context="council", filler=True)
            elif t == "COUNCIL_RESULT":
                v = p["victim"]
                wolves = [s for s in sorted(self.alive) if self.seats[s]["role"] in WOLVES]
                cast = [self.member(s, f"Wolf_{k + 2}", "stand", True) for k, s in enumerate(wolves[:3])]
                self.narrate(f"The pack has chosen: {self.name(v)}.", self.shot("Clearing", "Clearing_Low", "night", cast), labels=wolves)
                door = [self.member(wolves[0], f"Door_{v}", "stand", True)] + ([self.member(wolves[1], "Lane_2", "stand", True)] if len(wolves) > 1 else [])
                self.narrate(f"Claws scratch at {self.name(v)}'s door…", self.shot("Street", f"Street_Door_{v}", "night", door, {f"Door_Token_{v}": v}), labels=[v], duration=3.0)
            elif t == "WITCH_INFO":
                witch = next((s for s in self.alive if self.seats[s]["role"] == "witch"), None)
                if witch:
                    act = next((x["payload"] for x in ev[i:i + 8] if x["type"] == "NIGHT_ACTION" and x["payload"].get("role") == "witch"), {})
                    obj = {"he": "him", "she": "her"}.get(self.gender.get(p.get("attacked")), "them")
                    self_ = "herself" if self.gender.get(witch, "she") == "she" else "himself"
                    if act.get("heal"):
                        what = f"saves {self_}" if p.get("attacked") == witch else f"saves {obj}"
                    else:
                        what = f"poisons {self.name(act['poison'])}" if act.get("poison") else "does nothing"
                    who = f"the Witch {self_}" if p.get("attacked") == witch else f"{self.name(p['attacked'])}" if p.get("attacked") else "no one"
                    she = {"he": "he"}.get(self.gender.get(witch), "she")
                    self.narrate(f"The Witch wakes. The wolves marked {who}… {she} {what}.", self.shot("Room", "Room_Wide", "night", [self.member(witch, "Role", "sit", True)]), labels=[witch])
            elif t == "DEATHS":
                self.deaths(ev, i, p)
            elif t == "NO_DEATHS":
                self.narrate("Dawn breaks… and everyone is still alive.", self.shot("Square", "Square_Wide", "dawn", self.stand_ring()), labels=sorted(self.alive))
            elif t == "SHERIFF_CANDIDACY":
                pass
            elif t == "FALLBACK_USED":
                # owner (2026-10-22): no hiding mistakes. A model whose answer failed gets no invented line: the narrator
                # says what happened (the speech below, or the vote in tally())
                self.failed[p["seat"]] = p.get("context")
            elif t == "SPEECH" and p["text"].strip() == "(pass)" and self.failed.get(p["seat"]) == p["context"]:
                del self.failed[p["seat"]]
                self.pending_thought.pop(p["seat"], None)
                s = p["seat"]
                self.narrate(f"{self.name(s)}'s answer never came through. The game skips the turn.",
                             self.shot("Square", f"circle:{s}", "day", self.circle("day", False)), labels=[s], duration=3.0)
            elif t == "SPEECH":
                if p["text"].strip() == "(pass)":
                    p = {**p, "text": filler_line(p["context"], p["seat"], self.next_filler(p["seat"])), "filler": True}
                if True:
                    if p["context"] == "last_words":
                        cast = [self.member(p["seat"], "Gallows", "stand", False)]
                        self.speech(p["seat"], p["text"], self.shot("Square", "Square_Gallows", "dusk", cast), context="last words", filler=p.get("filler", False))
                    else:
                        if p["context"] == "sheriff" and not any(b.get("context") == "sheriff" for b in self.beats):
                            runners = [x["payload"]["seat"] for x in ev if x["type"] == "SHERIFF_CANDIDACY" and x["payload"].get("run") and x["at"].get("day") == self.phase[1]]
                            self.narrate("Who will be Sheriff? Running: " + ", ".join(self.name(s) for s in runners) + ".",
                                         self.shot("Square", "Square_High", "day", self.circle("day", False)), labels=runners)
                        self.speech(p["seat"], p["text"], self.shot("Square", f"circle:{p['seat']}", "day", self.circle("day", False)), context=p["context"],
                                    filler=p.get("filler", False), round_no=p.get("round"))
            elif t == "CHALLENGE":  # owner (2026-10-22): no announcement; a challenge and its answer are ordinary day talk
                pass
            elif t == "VOTES":
                self.tally(p)
            elif t == "HUNTER_SHOT":  # the Hunter's last shot, right after their own death card
                h, v = p["hunter"], p["target"]
                shot = self.shot("Square", "Square_Crowd", "dusk", [self.member(h, "Gallows", "stand", False)] +
                                 [self.member(x, f"Crowd_{k + 1}", "stand", False) for k, x in enumerate(sorted(self.alive))])
                if h in self.pending_thought:  # the choice of target (not the last words, which have no inner voice)
                    self.thought(h, self.pending_thought.pop(h), shot)
                self.narrate(f"{self.name(h)} was the Hunter… and fires one last shot. At {self.name(v)}!", shot, labels=[h, v])
            elif t == "SHERIFF_CHANGE" and p.get("to"):
                self.sheriff = p["to"]
                state = "day" if self.phase[0] == "day" else "dawn"
                self.narrate(f"{self.name(p['from'])} hands the Sheriff's badge to {self.name(p['to'])}.",
                             self.shot("Square", f"circle:{p['to']}", state, self.circle(state, False)), labels=[p["to"]], duration=3.0)
            elif t == "SHERIFF_RESULT":
                self.sheriff = p["sheriff"]
                self.narrate(f"{self.name(p['sheriff'])} is the new Sheriff.", self.shot("Square", f"circle:{p['sheriff']}", "day", self.circle("day", False)), labels=[p["sheriff"]])
            elif t == "EXECUTION":
                s = p["seat"]
                crowd = [self.member(x, f"Crowd_{k + 1}", "stand", False) for k, x in enumerate(sorted(self.alive - {s}))]
                gal = [self.member(s, "Gallows", "stand", False)]
                self.narrate(f"The village has decided. {self.name(s)} climbs the gallows.", self.shot("Square", "Square_Crowd", "dusk", gal + crowd), labels=[s])
            elif t == "NO_EXECUTION":
                self.narrate("No one is executed today.", self.shot("Square", "Square_Wide", "day", self.circle("day", False)))
            elif t == "GAME_OVER":  # the ending card over the survivors (a full game has one; --until videos stop earlier)
                self.ending(p)
                break
            i += 1
        return self.beats

    def night_action(self, p):
        role, seat = p["role"], p["seat"]
        if role == "cupid":
            a, b = p["targets"]
            for s in (a, b):
                self.seats[s]["lover"] = True
            shot = self.shot("Room", "Room_Table", "night", [self.member(seat, "Role", "sit", True)])
            if seat in self.pending_thought:
                self.thought(seat, self.pending_thought.pop(seat), shot)
            self.narrate(f"Cupid wakes and binds two hearts: {self.name(a)} and {self.name(b)}. If one dies, so does the other.", shot, labels=[seat], duration=4.2)
        elif role == "protector":
            shot = self.shot("Room", "Room_Wide", "night", [self.member(seat, "Role", "sit", True)])
            if seat in self.pending_thought:
                self.thought(seat, self.pending_thought.pop(seat), shot)
            who = "themselves" if p.get("target") == seat else self.name(p["target"]) if p.get("target") else "no one"
            self.narrate(f"The Protector stands guard over {who}.", shot, labels=[seat])

    def ending(self, p):
        team = {"Werewolf": "THE WEREWOLVES WIN", "Village": "THE VILLAGE WINS", "Lovers": "THE LOVERS WIN"}.get(p["winner"], f"{p['winner'].upper()} WINS")
        names = [self.name(s) for s in p.get("winners", [])]
        who = " and ".join(names) if len(names) < 3 else ", ".join(names[:-1]) + " and " + names[-1]
        sub = {"parity": f"{who} now match the village in number." if who else "The wolves now match the village in number."}.get(
            p.get("reason"), f"Victory for {who}." if who else "")
        self.title(team, sub, self.shot("Square", "Square_Wide", "dawn", self.stand_ring()))
        self.beats[-1]["tail"] = 7.0  # s held after the line, so the ending music and the howl can finish (sounds/SOUNDS.md)

    def pack_council(self, ev, i):
        wolves = [s for s in sorted(self.alive) if self.seats[s]["role"] in WOLVES]
        # owner: first the wolves, far down the street, walk away into the forest (seen from the street's start)
        walkers = wolves[:3]
        street = self.shot("Street", "walk:" + ",".join(map(str, walkers)), "night", [self.member(s, "Lane_4", "stand", True) for s in walkers])
        text = ("The village sleeps… but the pack slips out, one by one, toward the forest." if self.phase[1] == 1
                else "Once again, the pack slips out of the sleeping village.")
        self.add("narration", street, 6.5, text=text, labels=walkers, walk={"seats": walkers})
        cast = [self.member(s, f"Wolf_{k + 2}", "stand", True) for k, s in enumerate(wolves[:3])]
        self.narrate("Deep in the forest, the pack gathers.", self.shot("Clearing", "Clearing_Wide", "night", cast), labels=wolves)

    def stand_ring(self):
        return [self.member(s, f"Stand_{s}", "stand", False) for s in sorted(self.alive)] + self.bodies

    def deaths(self, ev, i, p):
        causes = next((x["payload"] for x in ev[i:i + 3] if x["type"] == "DEATH_CAUSES"), {"deaths": []})
        cmap = {d["seat"]: d["causes"] for d in causes["deaths"]}
        dawn = self.phase[0] in ("night", "dawn")
        for d in p["deaths"]:
            self.alive.discard(d["seat"])
        if dawn:
            self.bodies = [self.member(d["seat"], f"Body_{k + 1}", "body", False, clawed="attack" in cmap.get(d["seat"], [])) for k, d in enumerate(p["deaths"][:3])]
            self.narrate("Dawn. A cry rises from the square…", self.shot("Square", "Square_Wide", "dawn", self.stand_ring()), labels=[])
            for d in p["deaths"]:
                s = d["seat"]
                self.add("card", self.shot("Square", "Square_Bodies", "dawn", self.stand_ring()), 3.8, seat=s, name=self.name(s),
                         role=ROLE_NAME.get((d.get("reveal") or {}).get("role", ""), "?"), cause=" and ".join(CAUSE.get(c, c) for c in cmap.get(s, [])), labels=[])
            self.bodies = []
        else:
            for d in p["deaths"]:
                s = d["seat"]
                self.add("card", self.shot("Square", "Square_Gallows", "dusk", []), 3.8, seat=s, name=self.name(s),
                         role=ROLE_NAME.get((d.get("reveal") or {}).get("role", ""), "?"), cause=" and ".join(CAUSE.get(c, c) for c in cmap.get(s, [])), labels=[])

    def tally(self, p):
        # owner (2026-10-16): the vote is not instant any more. Seen from above, each voter in turn says their vote,
        # then the tally. The engine's ballots are sealed and revealed together; this is the video's staging of them.
        sheriff = p["context"] == "sheriff"
        top = self.shot("Square", "vote_top:" + ",".join(map(str, sorted(self.alive))), "day", self.circle("day", False))
        for b in p["ballots"]:
            v = b["voter"]
            self.pending_thought.pop(v, None)  # a voter's thought about the ballot would surface later in the wrong scene
            if b["vote"] == "abstain" and self.failed.get(v) == ("sheriff" if sheriff else "day"):
                del self.failed[v]  # the model's answer failed: the engine's fallback, said by the narrator, not by them
                self.add("narration", top, 3.4, text=f"{self.name(v)}'s vote never came through. It counts as no vote.", labels=[v])
                continue
            if b["vote"] == "abstain":
                text = "I abstain."
            else:  # a player never names themselves (owner, 2026-10-22): a vote for oneself is "myself"
                who = "myself" if b["vote"] == v else self.name(b["vote"])
                text = f"For Sheriff, I vote for {who}." if sheriff and who == "myself" else f"For Sheriff, I vote {who}." if sheriff else f"I vote for {who}."
            self.add("speech", top, 2.4, seat=v, text=text, labels=[v], context="vote", anim={"speaker": v, "mode": "talk"})
        counts = {}
        for b in p["ballots"]:
            if b["vote"] != "abstain":
                counts[b["vote"]] = counts.get(b["vote"], 0) + b.get("weight", 1)
        rows = sorted(counts.items(), key=lambda kv: -kv[1])
        abst = sum(1 for b in p["ballots"] if b["vote"] == "abstain")
        title = "Vote for Sheriff" if p["context"] == "sheriff" else "The village votes"
        self.add("tally", self.shot("Square", "Square_High", "day", self.circle("day", False)), 5.2, title=title,
                 rows=[{"seat": s, "name": self.name(s), "votes": n} for s, n in rows], abstain=abst,
                 ballots=[{"voter": b["voter"], "vote": b["vote"], "weight": b.get("weight", 1)} for b in p["ballots"]], labels=[])


def voice_cast(seats):
    """seat -> the character voice of its model (BASE/voice_cast.json, owner 2026-10-22: a model keeps its voice in every
    video). A model new to the videos gets its seat's own voice, or the first unused locked voice if another model has
    that one, and is written to the cast file so it keeps it."""
    path = os.path.join(BASE, "voice_cast.json")
    cast = json.load(open(path, encoding="utf-8"))
    pool = json.load(open(os.path.join(os.path.dirname(BASE), "3 Werewolf TTS", "config.json"), encoding="utf-8"))["cast_names"]
    out, added = {}, False
    for s in seats:
        model = s["model_short"]
        if model not in cast:
            taken = {v for k, v in cast.items() if not k.startswith("_")}
            cast[model] = s["name"] if s["name"] not in taken else next(n for n in pool if n not in taken)
            added = True
            print(f"[voice] {model} is new to the videos: voice {cast[model]}")
        out[s["seat"]] = cast[model]
    if added:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cast, f, ensure_ascii=False, indent=1)
    return out


def main():
    gid = sys.argv[1]
    until = sys.argv[sys.argv.index("--until") + 1] if "--until" in sys.argv else None
    # --until names the phase where the episode stops, e.g. "night2" = everything up to the end of day 1
    d = os.path.join(BASE, "games", gid)
    game = json.load(open(os.path.join(d, "game.json"), encoding="utf-8"))
    names = Names({s["seat"]: s["name"] for s in game["seats"]}, os.path.join(d, "names.json"))
    calls = call_names(game["seats"])
    voices = voice_cast([s for s in game["seats"] if not s.get("human")])
    chars = os.path.join(os.path.dirname(BASE), "3 Werewolf TTS", "characters")
    gender = {seat: "she" if json.load(open(os.path.join(chars, f"{v}.json"), encoding="utf-8")).get("gender") == "female" else "he"
              for seat, v in voices.items()}
    voiced = Voiced({calls[s]: g for s, g in gender.items()}, os.path.join(d, "pronouns.json"))
    beats = Director(game, names, gender, voiced).run(until)
    ep = {"game": game["id"], "seats": [{**x, "call": calls[x["seat"]], **({"voice": voices[x["seat"]]} if x["seat"] in voices else {})}
                                        for x in game["seats"]], "beats": beats,
          "length_s": round(sum(b["duration"] for b in beats), 1), "shots": len({json.dumps(b["shot"], sort_keys=True) for b in beats})}
    with open(os.path.join(d, "episode.json"), "w", encoding="utf-8") as f:
        json.dump(ep, f, ensure_ascii=False, indent=1)
    kinds = {}
    for b in beats:
        kinds[b["kind"]] = kinds.get(b["kind"], 0) + 1
    print(f"episode {gid}: {len(beats)} beats, {ep['shots']} unique stills, {ep['length_s']} s; {kinds}")


if __name__ == "__main__":
    main()
