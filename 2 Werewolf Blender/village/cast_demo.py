"""A sample 10-seat cast placed on the empty sets, for preview stills and for looking around in Blender.

It places figures exactly as the director will: through `use_scene`, the marks, `figure()` and the door tokens.
Variants (one moment each):
    night      everyone seated at the fire, wolves in their night form; the pack at the clearing; wolves at a door;
               the Little Girl peeking; the Seer in the night-role room
    dawn       survivors standing in the ring, a body by the fire
    day        the discussion: everyone seated, day form
    execution  the condemned on the gallows, the others in the crowd
"""
import bpy

from common import use_scene
from figures import figure, seat_mat

ROLES = {1: "villager", 2: "hunter", 3: "werewolf", 4: "villager", 5: "witch", 6: "seer", 7: "villager", 8: "werewolf", 9: "villager", 10: "villager"}
SHERIFF = 4
DEAD = 10       # killed by the pack last night
CONDEMNED = 8   # voted out today


def clear(sc):
    for o in [o for o in sc.objects if o.get("demo")]:
        bpy.data.objects.remove(o, do_unlink=True)


def _put(M, sc, mark_name, seat, pose, night, clawed=False):
    m = sc.objects[f"Mark_{mark_name}"]
    root, _ = figure(M, f"P{seat}", tuple(m.location), m["facing_yaw"], seat, ROLES[seat], pose=pose, night=night, sheriff=(seat == SHERIFF), clawed=clawed, lean=m.get("lean", 0.0))
    for o in [root, *root.children_recursive]:
        o["demo"] = True  # tagged for clear(); figure parts keep their own names (Scarf, HoodRim ...)
    return root


def populate(M, variant):
    if "Square" in bpy.data.scenes:
        sc = use_scene("Square")
        clear(sc)
        alive = [s for s in ROLES if s != DEAD]
        if variant == "night":
            for s in alive:
                _put(M, sc, f"Seat_{s}", s, "sit", True)
        elif variant == "day":
            for s in alive:
                _put(M, sc, f"Seat_{s}", s, "sit", False)
        elif variant == "dawn":
            for s in alive:
                _put(M, sc, f"Stand_{s}", s, "stand", False)
        elif variant == "execution":
            _put(M, sc, "Gallows", CONDEMNED, "stand", False)
            for k, s in enumerate([s for s in alive if s != CONDEMNED]):
                _put(M, sc, f"Crowd_{k + 1}", s, "stand", False)
        if variant in ("night", "dawn", "day"):
            _put(M, sc, "Body_2", DEAD, "body", False, clawed=True)
    if variant == "night":
        if "Street" in bpy.data.scenes:
            sc = use_scene("Street")
            clear(sc)
            _put(M, sc, "Lane_2", 3, "stand", True)
            _put(M, sc, "Door_5", 8, "stand", True)
            _put(M, sc, "Peek", 9, "stand", True)
            token = sc.objects["Door_Token_5"]  # house 5 belongs to the victim: paint its token
            token.material_slots[0].link = "OBJECT"
            token.material_slots[0].material = seat_mat(DEAD)
            token["demo_token"] = True
        if "Clearing" in bpy.data.scenes:
            sc = use_scene("Clearing")
            clear(sc)
            _put(M, sc, "Wolf_2", 3, "stand", True)
            _put(M, sc, "Wolf_3", 8, "stand", True)
        if "Room" in bpy.data.scenes:
            sc = use_scene("Room")
            clear(sc)
            _put(M, sc, "Role", 6, "sit", True)
            _put(M, sc, "Bed", 7, "sleep", True)
