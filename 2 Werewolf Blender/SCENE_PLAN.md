# Werewolf video scene: plan v0.5 (2026-10-01)

> **v0.5 overrides everything below it.** The v0.3 text further down is kept only as a reference for the edit layer,
> pacing, overlays, sound and platform rules. A critic scored v0.4 at 7.0/10; v0.5 applies its edits and the owner's style
> choice.

## Decisions (owner)

- **Accepted from v0.3:**
  - fire-circle night staging;
  - roles shown to viewers from the start;
  - a 16:9 master;
  - automatic subtitles plus an SRT.
- **Simplified (v0.4):** locations are built once, figures are still (no character animation for now), speech is shown as
  text above the head, and the camera "zooms into" areas.
- **Style (owner's reference image):** an **illustrated, cel-shaded horror village**. Not realistic, not pixel art.
- **Open:** the sound source (needed only for S4).

## Superseded v0.3 parts (do not implement)

| v0.3 | Replaced by |
|---|---|
| §2 look (Don't Starve, toon ramp, mist fog) | "Look" below |
| §1 single keyed camera, per-frame overlay renders, label tracking every 4 frames | Held stills with 2D moves; label positions projected once per still |
| §4 rig, NLA actions, glide/hop, "turn to look" | Posed still figures |
| §5 animated beats (glide to the clearing, card flip, sky time-lapse, crane) | Cuts between stills, plus a few short rendered moves |
| §6 render estimate, §7 milestones B0–B5 | "Rendering" and "Milestones" below |
| §3 one connected set | One scene per location |
| §5 "hanged silhouette" pose | The 3-still execution sequence below. A hanged figure is never shown. |

## Look (built and approved direction, `blender/village/common.py`)

- **Cel shading.** Light is cut into flat bands and keeps its colour (cold moon, warm lanterns, the orange fire).
  Shadows fall to a cool violet. `Standard` view transform, so flat colours stay exactly as designed.
- **Ink outlines:** an inverted hull (Solidify plus a back-face-culled ink material) on every solid object.
- **Shapes:** crooked half-timbered houses with steep gable roofs, cobbles, and chunky low-poly shapes with seeded jitter.
- **Surfaces:** procedural, painted-looking textures in a few stepped tones. No downloads.
- **Night:** a deep teal sky with stars and a moon halo, warm windows and lanterns, and low ground fog in a box volume.
- **Finish** (stills): a soft glow around lights, a vignette, and faint grain. For video, the grain is an animated overlay added in the video editor.

## Locations (one Blender scene each, in `blender/out/village.blend`)

| Scene | What | Marks | Cameras |
|---|---|---|---|
| Square | The meeting circle at the fire (10 log seats), the centre for bodies, the gallows platform, the well, the cart, the houses ring, the forest | Seat_1..10, Body_1..3, Gallows, Crowd_1..10 | Square_Wide, Square_High, Square_Bodies, Square_Gallows, Seat_1..10 |
| Street | The sleeping village: a crooked lane of cottages | Door_1..10, Lane_1..4, Peek | Street_Wide, Street_Door, Street_High |
| Clearing | The wolf council: a moonbeam on a rock, standing stones, bones | Wolf_1..4 | Clearing_Wide, Clearing_Low, Clearing_Rock |
| Room | The night-role room: a candle-lit interior reused by every solo night role | Role, Bed, Door | Room_Wide, Room_Table, Room_Window |

- Dawn and day are **lighting presets** on the same scenes (S2b), not new sets.
- The Little Girl peeks from the corner of a house in the Street, intercut with the Clearing.
- Each night, before the pack council, the wolves leave for the forest (owner, 2026-10-15): one long-lens shot from the
  start of the street. The pack is already at the lane's far end and walks slowly off to the right, one behind the other,
  past the last house into the forest, where the house corner hides them (the spot was found by ray casts from the
  camera); their 3D signs ride along (`walk` clips: plan.py `WALK_PATH`/`WALK_CAMERA`, render_clips.py `walk_keys`).
- Owner, 2026-10-15 (first full game, 3880b590):
  - Full speeches: nothing is cut; a long speech becomes several ~30-word screens in the same shot (`pages` in
    episode.py), with only ~0.25 s between screens of one speech (plan.py `PAD_CONT`/`LEAD_CONT`).
  - Model names everywhere: players are called by the short model name (Opus, Fable, Sol, Astra, Gemini, Grok), in
    speech, narration, cards and tallies; seat numbers in what players say become names first (director/names.py,
    a Gemini text rewrite checked word by word, cached in names.json). Signs and labels show model + role only.
  - No inner monologue for wolves during the pack council; the pack and the Lovers talk in their normal voice
    (only thoughts whisper). "N1"/"D2" are spelled out ("Night 1") so the voice can read them.
  - By day the campfire is out but its embers still glow dim red with a weak red light (lighting.py "embers").
  - An ending card ("THE WEREWOLVES WIN" + who) over the survivors.
- The Lovers' private talk happens in the Room, not by the fire (owner, 2026-10-14): one lover on the Role stool, the
  other on a second stool at the table's right end (added per clip: `room_guest`); their words sit beside the speaker,
  away from the partner.

## Figures (`figures.py`)

- **The base figure:** a hooded cloak, a dark face and two pale eyes. Its seat colour shows on the scarf and the hood rim.
- **Poses:** sit, stand, body (under a shroud, with claw marks when killed by the pack).
- **Role tells (classic set):**
  - Werewolf: at night, ears, red eyes and claws.
  - Seer: a glowing orb.
  - Witch: a hat with a green and a purple potion.
  - Hunter: a crossbow on the back and a feathered cap.
  - Villager: plain.
  - Sheriff: a gold badge.
  - Other roles are added as played modes need them.
- **Moments:**
  - Dawn: shrouded bodies at the centre marks, standing figures turned toward the centre at placement.
  - Vote: one wide still with 2D arrows from each voter to their target.
  - Lovers: a two-shot with a pink thread.
  - Witch: a picture-in-picture of the victim inside the Room.
- **Execution:** three stills only: the condemned under the rope (silhouette) → the crowd, with the rope's shadow → black.

## Speech: text above the head (replaces burned-in subtitles; the SRT stays)

- Each speech is split into pages of 1–2 lines (about 12 words) and revealed with a typewriter effect, in a dark box with a seat-colour edge.
- The box sits above the speaker's head. Its position is projected once per still and moves with the 2D pan/zoom.
- The name label sits over the box. The inner monologue is a dimmed italic box shown *before* the speech.
- At most 3 text elements on screen at once (layout zones as in v0.3).

## Keeping held stills alive

- **Cut rhythm:** a new still every 4–8 s, alternating wide / speaker / reaction. Ken Burns zoom of 8% or less on speech shots.
- **2.5D parallax:** render key stills as 2–3 layers (foreground fog/trees, figures, background).
- **Firelight flicker:** a "bright" and a "dim" render of the same still, cross-faded with a noise curve.
- **Moving layers:** looping fog and ember overlays; red eyes pulse with a 2D glow; animated film grain.

## Rendering (corrected arithmetic)

- **Standard cut:** about 15–20 min = about **150–250 shots averaging 4–6 s**, from about **150 unique stills**.
  - Identical stills, such as the same seat close-up across a day, render once.
  - The cache key is a hash of the set, the placements, the poses, the lighting preset, the camera and the build version.
- **Stills:** about 150 × 2 flicker variants × 5–15 s ≈ **0.5–1.2 h**.
- **True 3D moves:** establishing shots and transitions, kept under 45 s ≈ 1–3 h.
- **Final assembly:** with proxies.
- **Total: about 2–4 h per video.** The first real benchmark is part of S3.

## Milestones

| # | Deliverable | Status |
|---|---|---|
| S1 | Style test of the square at night | **Done:** owner reference applied (`style_toon.py`) |
| S2 | The 4 locations with marks and camera presets; the base figure with poses, seat colours, classic props; preview stills; loaded into the owner's Blender | **Done:** critic 6.0 → 7.5 → 8.2 → 8.7 → **9.1** |
| S2b | Lighting presets night / dawn / day / dusk (`lighting.py`, switchable live) | **Done** (reviewed with S2) |
| S3 | The director (`blender/director/`): **pick a finished game** → `game.json` (read-only export) → `episode.json` (beats: shot + cast + text + seconds) → stills rendered once each (cached) → frames with text (Pillow) → MP4 (Blender's video editor). **First test done (2026-10-01):** game 98d8cba8, Night 1 + Day 1, 55 beats from 27 stills, 5 min 58 s, made in about 3.5 min. Next: the owner's feedback, then the full game | Test delivered |
| S4 | TTS (Gemini), sound and the first public video | |

---

# (v0.3, kept as reference) Werewolf video scene: plan v0.3

Reviewed by an independent critic: v0.1 scored 6/10, v0.2 8.2/10, and **v0.3 9.1/10** (its four small follow-ups are applied). See "Changes" at the end.

**Goal** (owner, 2026-10-01): a Blender scene for recording videos of our AI-vs-AI Werewolf games.
- A stylized (not realistic), dark, creepy village in a forest.
- Cameras that follow night roles, special roles, the day discussion, the vote and the hanging.
- Bodies found in the middle of the village.
- Ten nearly identical figures with small role differences, and each model's name above its head.
- Scene changes and small animations that follow the game.
- TTS (Gemini) comes later and must slot in.

**The game itself is not changed.**

**Tools:**
- Blender 5.2.2 LTS on the owner's PC (RTX 2080 8 GB, 16 GB RAM).
- Driven through Blender Lab's MCP bridge, plus plain `bpy` scripts in this folder, so everything rebuilds from scratch.
- No downloaded assets.

---

## 1. Pipeline (one game → one video)

```
data/wearwolfe.db ─export─▶ games/<id>/game.json ─edit─▶ edit.json ─(TTS later)─▶ audio/*.wav
                                                            │
                     build_scene.py (the set, once) ──▶ direct_game.py ──▶ <id>.blend
                                                            │
                     3D render (PNG frames, cached per shot) + Overlay-scene RGBA frames + audio ──▶ VSE ──▶ MP4 (+ SRT, chapters)
```

- **Export.** A read-only Node script uses the game's own `@ww/store` and the `@ww/projector` spectator projection
  plus `describeFor`. Visibility and wording then match the web UI exactly, and nothing is parsed by hand.
  - It includes the **inner monologue** (`SEAT_THOUGHTS`).
  - It records **role changes** (Thief, Wolf-Hound, Wild Child, infection) with the time they happen.
- **Edit layer.** `edit.json` decides what makes the cut. It is reviewable and editable by the owner, and kept separately so rebuilds
  never lose it.
  - It skips passes and fallbacks.
  - It trims each speech to its key sentences: claims, accusations, @mentions.
  - It picks the monologue lines worth showing.
  - Three cuts: **archive** (everything), **standard** (about 15–20 min), **shorts** (highlights).
  - **Time budget for the standard cut:**

    | Part | Target |
    |---|---|
    | Cast intro | 5 s or less |
    | Night 1 | 90 s or less |
    | Night 2 and later | 45 s or less |
    | Dawn | 20 s or less |
    | Sheriff election | 60 s or less |
    | Discussion | about 4 min per day |
    | Vote and result | 40 s or less |
    | Execution | 20 s or less |
    | Game over | 30 s or less |

  - Every edit pass prints a **duration report** (per phase, and the total against the budget) and keeps trimming until it fits.
  - The 4-minute discussion target leaves about 15–17 s per speaker, monologue included. B0's duration report checks that the heuristic
    trimming reaches it. If not, the optional LLM edit pass moves into B4.
  - Trimmed lines are marked with "…". Model names are shortened through `blender/short_names.json`, never by editing
    `config/models.json`.
  - Version 1 is heuristic and free. An optional LLM pass (a few cents per game, through the existing OpenRouter setup) can come later.
- **Director.** It keys **one render camera** to named shot presets.
  - Hard cuts use constant interpolation; slow eased push-ins run within a shot.
  - The ~25 named cameras stay in the file as presets and viewport bookmarks.
  - No marker-bound camera switching.
- **Text and graphics are never baked into the 3D render.** They live in a separate **Overlay scene** in the same file:
  - an orthographic camera, flat emission meshes and text objects, and a transparent film;
  - fast Workbench or EEVEE rendering, saved as **RGBA PNG frames**;
  - these frames are stacked over the 3D frames in the video editor (VSE).
  - It covers name labels, subtitles, role cards with icons, the night-order HUD, the mini-map, the tally bars, suspicion
    lines and phase titles.
  - The 3D scene is never a live Scene strip.
  - **Label tracking:**
    - The director samples each head's screen position (`world_to_camera_view` on the evaluated scene) every
      4 frames, and on every cut frame.
    - Overlay positions are keyed linearly between samples.
    - A label is hidden when its head is behind the camera, off-screen, or covered by a close-up's lower third.
  - **Layout sheet:**

    | Zone | What goes there |
    |---|---|
    | Bottom centre | Subtitles |
    | Above the subtitles | Monologue |
    | Bottom left | Lower-third name card |
    | Top right | Mini-map |
    | Left edge | Night HUD |
    | Centre | Role cards and the tally |
    | Top centre | Phase titles |

    - **At most 3 text elements on screen at once.**
    - The mini-map hides during role cards and the tally.
    - Claim pop-ups and suspicion lines appear only in the wide circle shot.
  - A typo then costs a quick overlay re-render, not a 3D re-render.
  - It also outputs an **SRT** file and **YouTube chapters** from the phase markers.
- **Hand tweaks** go in `direction_overrides.json` so they survive regeneration.
- **Order:** export → edit → TTS → direct → final render.
  - Previews use estimated timing (words / 2.5 per second).
  - TTS durations reflow the timeline before the final render.

## 2. Look and mood

- **Style:** low-poly, chunky, crooked (Don't Starve / Tim Burton mood, not cute).
  - Flat colours with a soft toon ramp, strong silhouettes and rim light.
  - Bevel and Simple Deform (bend, twist), seeded vertex jitter, vertex-colour AO.
  - Darkness and backlight against the moon hide detail.
- **Palette:** night is cold moonlight blue-grey with an orange fire in the square, and **red is reserved for wolves**. Day is
  desaturated sickly grey-green, never cheerful. Dawn is a pale cold pink.
- **Fog:** a Mist-pass depth fog plus scrolling fog cards, which is cheap. Real volumetrics only for hero moon shots.
  - Fire and lantern flicker use deterministic F-curve noise.

## 3. The set

- **Square:** a circle of 7–10 seats around a fire pit. The **centre** is where bodies lie at dawn.
- **Houses:** 6–8 crooked cottages, fences, barrels and flickering lanterns.
- **Gallows:** on a rise at the square's edge, against the moon.
- **Forest ring** of pines and dead trees, with the **wolf clearing** just inside it (a flat rock, bones) for the pack council.
- A spot behind a cottage for the **Little Girl** to peek from.
- Graveyard: deferred. Role cards and the mini-map keep the record.

## 4. The figures

- **One base figure for everyone:** a hooded cloak, a dark featureless face with two pale eyes, and hands. The cloak covers the feet,
  so figures **glide or hop** with no walk cycle, which is cheaper and creepier.
- **Rig:** one tiny shared armature (root, spine, head, two arms, about 8 bones).
  - Reusable NLA actions: idle, sleep, wake, lean-in, point, collapse.
  - Head look-at and arm point use Damped Track to empties the director moves. One "look target" turns everyone to the centre.
  - Props are parented to bones. No shape keys.
- **Seat colour, big enough for a phone screen:**
  - hood lining, scarf and a floor glow under the seat, in 10 colour-blind-safe colours
  - the same colour is used for that seat's subtitles, mini-map dot and label
- **Names:** short display names (e.g. "Fable 5.1"). If one model fills several seats, the name gets a seat suffix ("Fable · 3").
  - Wide shots: a 2D label over the head with a backplate, at least 28 px.
  - Close-ups: a lower-third name card instead.
- **Roles:**
  - **2D role cards** (icon, name, team colour) are the main signal.
  - **Props** are close-up flavour, and their silhouettes are chosen not to collide:
    - Seer: an orb.
    - Witch: a hat and two vials.
    - Hunter: a crossbow.
    - Villager: plain.
    - Wolves: nothing by day; at night red eyes, ears and claws.
  - Later roles get distinct props: no ear-like horns, no matching collars or crowns.
  - Props swap when a role changes mid-game.
- **States:** speaking (lean plus a seat glow), Sheriff (star badge), Lovers (pink thread), charmed (purple notes).
  - **Dead:** a very faint grey ghost, and the seat glow goes out.

## 5. Staging

Roles are **shown to viewers from the start**: dramatic irony plus the monologue is the hook. A "hidden" mode
(wolves masked as "Wolf A/B/C", props held back until death) is kept for a later whodunit cut.

- **Cast intro (about 5 s hook):** the circle line-up with names and roles: "one of these AIs is lying", or "some of these
  AIs are lying" when there are two or more wolves.
- **Narrator** lines between phases ("The village falls asleep…"), as text now and as TTS later.
- **Night falls:** a sky time-lapse, the fire dies to embers, the fog rises, and everyone at the circle bows their head.
- **Night-order HUD:** a vertical list of the wake order with the current role lit, which teaches the game as it plays.
- **Night roles:**
  - **Night 1** gets the full ceremony: the role wakes under a spotlight and its effect plays.
    - Seer: a beam to the target, and the result flashes over them (red = wolf).
    - Witch: a heal sparkle or a poison mist.
    - Protector: a shield dome.
    - Cupid: a pink thread.
    - Piper: notes.
    - Raven: the crow flies to its mark.
  - **Night 2 on:** a 2–3 s beat per role, longer only when something notable happens: the Seer finds a wolf, a potion is used,
    the Little Girl is caught.
- **The pack:** the wolves rise, eyes red, and glide to the clearing.
  - The council plays there with a low close camera and their whispered messages as subtitles.
  - The victim gets a red mark at the circle.
  - Extras: the Big Bad Wolf's second victim, the White Werewolf turning on a packmate, the Wolf-Father's infection
    (a red-eye flicker on the "survivor"), and the Little Girl peeking (and getting caught).
- **Dawn:** the sky goes pale, and the **bodies lie in the centre** under shrouds with claw marks (no blood).
  - Each role card flips over the body, and everyone turns to look.
  - "No one died" plays as a beat of relief.
  - Bear growl and Raven mark beats as needed. Heartbreak: the pink thread snaps and the lover follows.
- **Private channels:** the Lovers' and Sisters' messages play as a two-shot of the pair, linked by their thread or flower motif,
  with whispered subtitles in a tinted box. They are only shown when the edit layer keeps them.
- **Day 1 Sheriff election:** candidates raise hands in one shot, short campaign excerpts, the ballot, and the badge pinned on.
- **Discussion:** close-up or over-the-shoulder on the speaker, with a subtitle in their seat colour.
  - The **inner monologue** always appears **before** the spoken line (ruleset §14.3) as dimmed, whispered italic text
    ("thinks: …"), at least for wolves and liars.
  - **Claim pop-ups** ("claims SEER") sit next to the true role card.
  - A **suspicion overlay** (from the speech's `lean`) draws a thin line toward the seat they lean against.
  - Cutaways to reactions and the wide circle.
- **Vote:** everyone points **at once** (the ballot is sealed), then a count-up tally overlay (Sheriff ×2, Raven +2).
  Before the vote, **rebuttals** from the accused get a close-up. Then the runoff, the Scapegoat's ruling, the Judge's second
  vote and last words, when they happen.
- **Execution, as a setting:**
  - `gallows` (long-form): the noose only in silhouette against the moon. Cut to the crowd at the drop, with a swaying rope shadow
    and nothing lingering.
  - `banished` (shorts): the condemned glides into the fog, and red eyes close behind them.
  - **Never a noose in a thumbnail.**
- **Special moments:** the Hunter's last bolt crossing the square, the Elder surviving, the Idiot revealed (cap and crowd laugh),
  the Knight's curse, the Angel winning, the Thief's swap, the Wild Child turning.
- **Game over:** the winner card, every role revealed, and a crane pull-back. An outro with stats, plus chapters.
- **Mini-map (on, except during role cards and the tally):** a small circle of seat dots (colour, alive/dead, Sheriff, lovers, today's votes).

## 6. Rendering

- 16:9 master at 1920x1080, **24 fps**, EEVEE with 16–32 samples.
  - Subjects are framed inside a centre vertical-safe zone, so a 9:16 shorts render of highlights can follow later.
- Background renders to PNG sequences, **cached per shot**. Each shot's folder is keyed by a hash of its inputs: the camera keys,
  the figures' actions, the lighting state, the frame range and a **scene build hash** (set, rig and material version), so a
  `build_scene.py` change invalidates old frames. An edit or a TTS change then re-renders only the shots
  it touched. Renders are resumable and crash-safe. Then a fast VSE composite and encode.
- **Motion blur is off**, so a hard cut never smears across two shots.
- **Thumbnail step:** a dedicated shot preset and still render, with wolf eyes in the dark, the model names and large title text.
  It never shows a noose.
- **Benchmark first** (in B1). The critic expects 1.5–4 s per frame, so a standard cut of about 15–20 min may take
  10–30+ h, while the archive cut is much longer. Shorter cuts and simpler shots bring this down.

## 7. Milestones (each reviewed by the critic, then shown to the owner)

| # | Deliverable |
|---|---|
| **B0** | **Greybox animatic** of a real recorded game (Night 1 and Day 1): capsule figures, the 2D overlays, estimated timing, and the edit layer. Tests pacing and the director before any art. |
| **B1** | The set and the look, plus the base figure and the rig. **Stills for the owner to approve the style**, and a render-time benchmark. |
| **B2** | Figures for the classic-7 roles (Werewolf, Seer, Witch, Hunter, Villager), Sheriff badge, ghost state, seat colours. Other roles are added as played modes need them. |
| **B3** | Animation and effects library for those roles, plus the vote, dawn, the `gallows` execution and game-over beats. |
| **B4** | **Internal** cut of one real 7-seat game: the standard cut with overlays, SRT and chapters, and a thumbnail. Silent, or with a simple ambience bed. For checking pacing, not for posting. |
| **B5** | **First public video:** TTS (Gemini; a narrator plus one voice per seat, whose durations drive the timing), ambience, music stingers and ducking. Also the `banished` execution style and the shorts cut. |

## 8. Sound

- **Ambience:** wind, crickets and owls at night, crows by day, the fire crackle.
- **Stingers:** night falls (a howl), a body revealed, the vote result, the game's end.
- **Music:** a low drone bed under discussion.
- **Ducking** under every voice is keyed by the director.
- **Source of the sounds: the owner's decision.** It could be royalty-free files the owner provides, generated sound effects,
  or simple tones synthesized by script.

## 9. Decisions taken (critic's recommendation, pending the owner)

1. Night staging: the table-game circle, plus the forest clearing for the pack.
2. Roles shown to viewers from the start; the hidden mode is kept for later.
3. 16:9 master, framed so 9:16 shorts can be cut later.
4. Subtitles generated automatically in the overlay pass (burned in) plus an SRT.

## Changes

**v0.2 → v0.3:**
- The edit layer gets a time budget and a duration report.
- The Overlay scene method: RGBA frames, label tracking, and off-screen handling.
- A layout sheet with clutter limits.
- Per-shot render caching; motion blur off.
- A thumbnail step.
- The monologue always comes before the speech.
- Staging for the Lovers and Sisters channels; rebuttals.
- Intro wording for two or more wolves.
- `short_names.json`.
- A sound section, with the source of the sounds left to the owner.
- B4 is an internal cut, and B5 is the first public video with TTS. `banished` moves to B5.

**v0.1 → v0.2:**

- Added: the edit layer and three cuts, the inner monologue, the Sheriff election, the Little Girl, infection, channels, role changes,
  duplicate-model names, the narrator, cast intro, night-order HUD, mini-map, tally, claim pop-ups, suspicion line,
  chapters and SRT, the execution setting and thumbnail rule, and the B0 animatic.
- Changed:
  - one keyed camera instead of marker-bound cameras
  - a 2D overlay pass for all text
  - fog cards instead of volumetrics
  - 24 fps, chunked renders and a realistic render estimate
  - bigger seat-colour areas
  - role cards first, with props as flavour
  - export through the game's own projector
  - a reduced role set to start
  - a tiny rig, with gliding instead of a walk cycle
- Deferred: the graveyard, and all roles beyond classic-7.

## S3b — animated pass (owner confirmed 2026-10-01, NOT STARTED)

The owner found the held-still test too static. Confirmed scope (from the owner's list; extras 5a typing text, 5b eye-wake, 5c animated vote were NOT confirmed):
1. **Living figures:** breathing (Body scale), blinking (eyes hidden 2–3 frames), talking nods/tilts on a head pivot (procedural now, voice-driven via Bake Sound to F-Curves later), listeners turn heads to the speaker, prop follow-through (witch hat, hunter feather, wolf ears, scarf, potions bob, orb float/pulse, star glint). Needs pivots in `figures.figure()`: head (neck), hat, each ear, feather, star; store names on root["anim"].
2. **Living world:** fire tongues flicker + rising sparks + light flicker; wind on trees (group each tree under an empty in `kit`), gallows rope/noose pivot sway, lamps flicker; fog drift and stars/clouds driven by a periodic scene attribute `ww_phase`.
3. **Discussion staging:** wide/high 3/4 view of the circle; a real 3D camera move (1.5–2 s, on ones) toward each speaker, hold on a looped medium-wide framing, arc to the next speaker; inner voice = 2D layer dimming the scene except a spotlight on the thinker, edge haze by team (wolves red, village blue, Lovers pink, solo purple; wolf+lover red with pink edge).
4. **Look:** rim light (Layer Weight facing × light) and painterly band edges (noise added before the toon ramp) in `common.toon`.
6. **Speed:** seamless 2 s loops per shot (sine motions with integer cycles; figures on twos via constant keys every 2 frames), moves rendered on ones, text and thought effects as RGBA overlay PNGs on VSE channels, two background Blender renders in parallel.
+ **Night-to-day transition:** one rendered clip (moon sinks, sky/fog/ambient/lights blend via scene attributes, e.g. `ww_daymix`), reused each day.
Renderer change: `render_stills.py` → `render_clips.py` (loop + move clips cached by hash), `compose.py` → overlays only, `encode.py` → image sequences (twos = each file twice) + overlay strips + crossfades.
Estimate: test (Night 1 + Day 1) about 45–60 min; full game 2–4 h.
