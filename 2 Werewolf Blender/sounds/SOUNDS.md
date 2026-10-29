# Sounds for the Werewolf videos

This folder holds the music and sound effects for the game videos. This file says what each one is, where it comes
from, and how and where it is used. Keep it up to date with every correction or confirmation from the owner (see
"Change log" at the end).

**Status: v5.1 (2026-10-16), final review 9.0/10.**
- The owner approved the download; all 23 files are in `_source/` (M6 only when a game needs it).
- They are prepared in `music/` and `sfx/`.
- First video with sound: `FullGameFolder/3880b590/3880b590 full game - with sound.mp4`.
- Reviews: 6.5 → 7.8 → 8.2 → 8.8 / 10; the v3 to v5 fixes are below.

## Rules

- **Licence: CC0 only** (public domain): free to use in posted videos, no credit required, commercial use allowed.
  Every page was opened and its licence checked (2026-10-16, and again by the reviewer). `CREDITS.txt` (written by
  `fetch_sounds.py`) lists every source as a courtesy.
- Freesound sounds come as the site's HQ preview (128 kbps MP3); OpenGameArt music as the author's file.
- The voices always win: everything else ducks while someone speaks.

## The pipeline (all files in this folder unless noted)

1. `library.json`: every sound id: its source URL and page, the layer it belongs to, the excerpt to use
   (`start` in seconds, or `"auto"` = the loudest stretch of `length` seconds), its fade-out, and what it is for.
2. `python sounds/fetch_sounds.py`: downloads the sources into `_source/` (skips what is there), writes `CREDITS.txt`.
3. `blender --background --factory-startup --python sounds/prep_sounds.py` makes the finished files in `music/` and `sfx/`:
   - Everything is resampled to 48 kHz (band-limited, by FFT), so one video frame is exactly 2000 samples.
   - Only the codec's digital silence is trimmed; a numeric excerpt start counts from the file's own start.
   - Excerpts are cut.
   - Embers: high-pass at 400 Hz, a gentle expander (ratio 1.5, at most -14 dB), and pops capped at -22 dBFS.
     The result is a quiet bed (about -45 dBFS) with soft, sparse ticks: a burned-out fire.
   - The crowd murmur is low-passed so its words cannot be made out.
   - Loudness per layer, as RMS of the audible part (gated 40 dB under the file's own loud moments). Transients are
     soft-limited at -1 dBFS (embers: -22) instead of turning the whole file down:
     - music -30 dBFS;
     - ambience -34;
     - effects -21;
     - the heartbeat -27.
   - Effects get their fade-out.
   - Loops:
     - Ambience loops get a 2 s equal-power crossfade.
     - Music M1, M2, M3 and M5 are authored loops: no crossfade. M4 is not, so it gets a 4 s crossfade.
     - The heartbeat loops on whole beats (its period is measured: 2.54 s), starting in the quiet between two beats,
       with 8 ms fades at the seam.
     - The dawn chorus is capped at -14 dBFS peak.
     - M4 starts 20 s into its file, so its crossfade seam falls in the rebuttal, not in the vote.
     - The howl starts at its first breath (a 0.3 s fade-in); the drum roll builds over 2 s.
     - Every loop is stretched by a hair so it ends exactly on a frame, so the repeats join without a click.
   - The voices measure about -20.5 dBFS. Between lines the music sits about 10 dB under them; under a voice about
     14-16 dB under (the round-2 drone about 20 dB).
4. `python director/sound.py <id8>`: the cue sheet for a game (`games/<id8>/sound_cues.json`), by the rules below.
5. `director/encode_clips.py` lays the cues under the picture: music on channels 9-10, ambience 11-16, effects 17+.
   - **Cross-fades:** equal-power, 1.5 s, starting at the beat where the music changes (never before it).
   - **One envelope per strip:** the equal-power fade multiplied by the ducking, with linear keys, so a change under
     dialogue never swells.
   - **Ducking:** applies to everything under the voices. Voices less than 1.5 s apart count as one, so the ducking
     holds through continuous dialogue. It ducks in over 0.3 s and comes back over 0.8 s. The effect pre-rolls
     (1.25 s or more after a pause) fall outside the ducking, so effects and the music between scenes play in full.
   - **Levels while ducked:** music 0.6, ambience 0.65, heartbeat 0.75, effects 0.8 of their normal level.
   - **Pre-roll:** effect-led beats play their effect first; the narrator waits 1.0-1.2 s (`lead_of` in sound.py,
     used by plan.py). That covers the NIGHT title, the door, the pack's choice, the dawn cry, the death cards, the
     verdict and the ending.

## What plays when

**Music** (one track per stretch of the story; a track keeps one level within a stretch, so it never restarts):

| Stretch | Music |
|---|---|
| NIGHT title until the pack gathers (night roles, the street walk) | M1 night theme |
| From the pack's gathering in the forest until dawn (council, the choice, the door, the Witch) | M2 horror loop |
| Dawn discovery (the cry, the death cards) | **no music**: birds and the gasp only |
| DAY title, Sheriff election, discussion **round 1** | M3 calm lute, low (0.8) |
| Discussion **round 2**: the first 60 s (every day has its own rest) | **no music**, ambience only (a rest) |
| Round 2 after the rest, until 90 s before the day's rebuttal or vote | M1 at half level: a low drone while suspicion builds |
| The last 90 s before the rebuttal, rebuttals, **the vote**, the tally | M4 tension, low (0.8) |
| The verdict, last words at the gallows, the gallows death card | M5 somber |
| Ending: the wolves win | M2 (the card holds 7 s so it can finish) |
| Ending: the village or another side wins | M6 orchestral ending |
| Any inner monologue | keeps the music of the scene it sits in |

**Ambience:**

| Where | Bed (and second bed) |
|---|---|
| The village at night (square) | A1 night: crickets |
| Night roles in the Room (indoors) | A1 at half level |
| The street (the pack walking out, the door) | A5 wind, with A1 at 0.6 |
| The forest (the pack council) | A2 crickets and a tawny owl |
| Dawn, and the dawn-to-day change | A3 dawn chorus |
| **The day** (discussion, vote) | **A4 burned-out campfire: only sparse pops + A5 gentle breeze (0.7)** |
| The gallows (dusk), the ending | A5 wind |
| Heartbeat | S15, one continuous strip under the whole vote, and under the wolves' inner monologues (levelled like an effect, so it carries on phones) |

**Effects:**

| Moment | Effect |
|---|---|
| NIGHT n title | S1 one clear wolf howl |
| The Seer looks into someone's soul | S12 sparkle |
| The Witch wakes | S13 cork pulled from a vial, then S14 the potion poured |
| The pack walks out (street) | S2 distant pack howling near the end of the shot |
| "The pack has chosen: X" | S16 low impact |
| "Claws scratch at X's door" | S6 claws scratching a wooden door |
| "Dawn. A cry rises from the square" | S9 small crowd gasps |
| Any death card | S16 low impact + S8 one bell toll |
| "Everyone is still alive" | nothing extra: the dawn birds carry it (the bell means death) |
| The tally, when a hanging follows | S17 drum roll building under the card, ending on the verdict |
| The tally, otherwise | S16 low impact |
| "X climbs the gallows" (the verdict) | S16 low impact + S10 crowd murmur (muffled, at 0.3) |
| Last words (first screen) | S11 the rope creaking over the beam |
| The wolves win | S1 howl, then S2 the pack howling |
| The village / others win | S8 bell |

## Files

Music (OpenGameArt, all CC0):

| ID | Track | Author | File, size | Page |
|---|---|---|---|---|
| M1 | Garg Oilers (suspense atmosphere loop) | iamoneabe | gargoilers_0.mp3, 2.4 MB | https://opengameart.org/content/garg-oilers |
| M2 | Horror Loop | TinyWorlds | horror_music.zip, 2.8 MB | https://opengameart.org/content/horror-loop |
| M3 | Medieval: The Bard's Tale (loop version) | RandomMind | Loop_The_Bards_Tale.wav, 10.2 MB | https://opengameart.org/content/medieval-the-bards-tale |
| M4 | Tension and Distress | allen yatsura | aflicao.wav, 10.7 MB | https://opengameart.org/content/tension-and-distress |
| M5 | Remembrance loop | beardalaxy | remembrance_in_game.ogg, 0.4 MB | https://opengameart.org/content/remembrance-loop |
| M6 | Ending Scene (orchestral) | nene | ending_scene_orchestral.wav, 25.8 MB, **only when a game needs it** | https://opengameart.org/content/ending-scene |

Ambience and effects (Freesound, all CC0, HQ preview MP3, about 16 KB per second):

| ID | Sound | Author | Length (excerpt used) | Page |
|---|---|---|---|---|
| A1 | Rural summer night | AnthonyRamirez | 2:05 (loop) | https://freesound.org/people/AnthonyRamirez/sounds/425425/ |
| A2 | Crickets and tawny owl | raoul_slayer | 2:20 (loop) | https://freesound.org/people/raoul_slayer/sounds/203598/ |
| A3 | Dawn chorus | Synge101 | 1:36 (loop) | https://freesound.org/people/Synge101/sounds/611453/ |
| A4 | Campfire 02 (seamless loop; high-passed + expanded to sparse ember pops) | HECKFRICKER | 4:27 (loop) | https://freesound.org/people/HECKFRICKER/sounds/729396/ |
| A5 | A gentle breeze, wind 3 | mario1298 | 2:05 (loop) | https://freesound.org/people/mario1298/sounds/181252/ |
| S1 | Solitary wolf howl, very clear | betchkal | 0:55 (the clearest 8 s) | https://freesound.org/people/betchkal/sounds/500646/ |
| S2 | Adult and young wolves howling far away | Sacha.Julien | 0:04 | https://freesound.org/people/Sacha.Julien/sounds/753896/ |
| S6 | Scratching the door | adaws05 | 0:30 (3.5 s) | https://freesound.org/people/adaws05/sounds/786915/ |
| S8 | TollBell (one large bell struck) | daytripper | 0:08 (5 s, fading out so it never runs into the next howl) | https://freesound.org/people/daytripper/sounds/73678/ |
| S9 | Gasps, small crowd | dreamstobecome | 0:20 (3 s) | https://freesound.org/people/dreamstobecome/sounds/439258/ |
| S10 | Small crowd walla (murmur) | IENBA | 0:28 (8 s) | https://freesound.org/people/IENBA/sounds/653920/ |
| S11 | Hemp rope creaks (over a wooden beam) | 6polnic | 2:50 (6 s) | https://freesound.org/people/6polnic/sounds/231438/ |
| S12 | Sparkling twinkle | newlocknew | 0:30 (2.5 s) | https://freesound.org/people/newlocknew/sounds/825544/ |
| S13 | Squeaky cork pull | Kinoton | 0:04 | https://freesound.org/people/Kinoton/sounds/347353/ |
| S14 | Pour | euphorix | 0:08 (2.5 s) | https://freesound.org/people/euphorix/sounds/474245/ |
| S15 | Slow heartbeat | mezcel (edit of daandraait, CC0) | 0:15 (loop) | https://freesound.org/people/mezcel/sounds/390425/ |
| S16 | Low impact | AudioPapkin | 0:05 | https://freesound.org/people/AudioPapkin/sounds/430978/ |
| S17 | Snare drum roll | jormac326 | 0:41 (5 s) | https://freesound.org/people/jormac326/sounds/847781/ |

Download now: about 27 MB of music (M6 only when a game needs it: +25.8 MB) and about 21 MB of ambience and effects.

## Other moments that will need sounds later (not in this game)

- Hunter's last shot: a crossbow release and thud.
- Sheriff elected: a short fanfare or a bell.
- Cupid binding the Lovers: a soft harp or chime.
- Little Girl peeking in the Street: careful footsteps, a held breath.
- No execution today: the crowd disperses (murmur), wind.

## Change log

- 2026-10-16: proposal v1 written (owner: music per event, a wolf howl at night, door scratches, wind and a quiet
  campfire during the day discussion, tense and calm moments).
- 2026-10-16: independent review 6.5/10. Fixes in v2:
  - Day treatment:
    - The day embers are a long seamless loop, low-passed, plus a gentle breeze.
    - Round 1 calm, a 60 s rest, then tension in round 2.
    - Music changes cross-fade at the beat.
  - Replaced sounds:
    - Low impact, not the riser.
    - A single bell toll.
    - The hemp rope creak.
    - A crowd murmur.
    - A cork and a pour for the Witch.
  - No bell when nobody died.
  - Pack and night music:
    - One pack track from the forest to dawn.
    - A 7 s tail on the ending card.
    - A drum roll that lands on the verdict.
  - Mix:
    - The heartbeat is one strip under the whole vote, and only under wolves' thoughts.
    - Loudness is levelled per layer, and loops are baked seamless.
    - The ducking holds through dialogue, and effects are ducked too.
- 2026-10-16: the owner approved the download; all 23 files are fetched (52 MB) and `CREDITS.txt` is written.
- 2026-10-16: second review 7.8/10. Fixes in v3:
  - Mix:
    - Fades and ducking are one envelope, so there is no swell at changes under dialogue.
    - 48 kHz, with frame-exact loops (no seam clicks).
    - No crossfade on the music and heartbeat loops.
    - Ducking merged gaps under 3 s (superseded in v4: 1.5 s), and effects duck only to 0.8.
  - The embers are high-passed and expanded (not low-passed).
  - Effect pre-roll before the narrator.
  - Music:
    - A drone in round 2 before the last 90 s of tension.
    - The rest resets every day.
  - Levels:
    - The heartbeat is louder.
    - The murmur is muffled and lowered.
    - The bell is 5 s.
- 2026-10-16: third review 8.2/10. Fixes in v4:
  - The embers are a quiet bed with sparse ticks: a gentle expander and pops capped at -22 dBFS.
  - Ducking: voices merge only when under 1.5 s apart (25 ranges instead of one), so the pre-rolls are unducked.
    Music under a voice sits at 0.6.
  - M4 gets a 4 s crossfade.
  - Loudness is gated relative to each file, with transients soft-limited (the rope, sparkle and pour now reach
    their level).
  - The howl starts at its onset with a 0.3 s fade-in.
  - The heartbeat loops on whole beats.
  - The drum roll fades in over 2 s.
  - The resampling is band-limited.
- 2026-10-16: fourth review 8.8/10. Fixes in v5:
  - The heartbeat loop starts between beats, with 8 ms seam fades (no double beat or click).
  - The dawn chorus is capped at -14 dBFS.
  - M4 starts 20 s into its file, so its seam leaves the vote.
  - Stale lines in this file corrected.
- 2026-10-16: final review 9.0/10 (passes the gate). v5.1: M4 is made seamless first and then rotated, so its single
  crossfade falls in the rebuttal (10:04) and nothing joins in the vote.
- 2026-10-22 (Game 2, owner): the vote's drum roll (S17) is to be REPLACED ("not good"). Game 2 also needs sounds for
  the Hunter's last shot, the Sheriff elected, a Challenge, the Sheriff's badge handover, and the intro (whooshes
  between the best-moment clips, a spotlight click). Downloads approved. 20 CC0 candidates (Freesound HQ previews,
  3.3 MB, each checked CC0 on its own page) are in candidates/ with candidates/listen.html and candidates.json;
  WAITING for the owner's picks. Then: the picks go into library.json (new IDs), prep_sounds.py, this file's tables
  and sound.py; the candidates not picked are deleted (owner rule: no superseded files kept).
- 2026-10-22 (owner): the Challenge is ordinary day talk in the video, so it needs no sound: its 3 candidates were
  deleted (17 candidates left).
- 2026-10-23: IDs reserved for the owner's picks (director/sound.py already cues them; until prepared they are
  skipped): S18 the vote's build before a hanging (replaces the S17 drum roll, which is no longer used), S19 the
  Hunter's crossbow (on "...fires one last shot"), S20 Sheriff elected, S21 the Sheriff's badge handed on. The
  intro's whoosh and spotlight picks replace the S16 stand-ins in director/intro.py (HIT/WHOOSH).
- 2026-10-23 (Game 2: the village wins): M6 "Ending Scene (orchestral)" by nene (OpenGameArt, CC0, 25.8 MB) downloaded
  with fetch_sounds.py --optional (owner's download OK, 2026-10-22) and prepared (142.3 s, -30 dBFS) for the
  village-win ending.

**Owner note (2026-10-29):** S16 is too loud on cuts. From the next video on, every S16 gain is x0.6 (40% quieter). Game 3 is left as posted.
