# Intro plan (v6: the owner's version, 2026-10-19)

The first ~30 seconds of every game video. Goal: stop the scroll in the first 3 seconds with something only this
channel has (an AI lying while its inner voice says the opposite), introduce the six AIs, explain the roles fast,
state the stakes, and go.

**Voice:** the new intro Host (energetic, younger). Candidates: `3 Werewolf TTS/output/Host/0 Voice pick/`. The
cold open uses the game's own character voice (the wolf's normal voice, then its whispered thought).

**Picture:** cuts of 0.4–3 s between the intro stages in `out/intro.blend` (`village/intro_stages.py`) and shots from
the game. On-screen words are three at most, big and bold. Each stage has its own key colour, flashed
full-frame for 1 frame on the cut into it. There are 2-frame whip pans between stages and eased pushes on every shot.

**Sound:** hybrid trap/orchestral at 130–140 bpm, cut on the beat and ducked under the voice:
- A sub-drop and a heartbeat on the cold open.
- A whoosh into each stage, and a signature sound per role: growl (Werewolf), crystal shimmer (Seer), bubble and
  glass clink (Witch), crowd murmur and gavel (Villager).
- A riser through the montage, one beat of silence, then "Let's play.", an impact and the howl.

## Script and shot list (the owner's version: only the intro's own stages, nothing that spoils the game)

Every line is the Host (voice E, "high-energy video host, punchy and fast"). The cuts follow the real voice.

| # | Shot | Host says | On screen |
|---|---|---|---|
| 1 | Lineup_Wide: the spotlights snap on one by one, with a push in | "I made the six smartest AIs compete in a game of Werewolf." | each model's name sign |
| 2 | Roll-call: one close-up per name, in the spoken order (Fable, Opus, Sol, Astra, Gemini, Grok) | "Two Claudes. Two GPTs. Gemini... and Grok." | the full model name in its seat colour |
| 3 | Lineup_Wide: every figure's eyes flash red in turn (no one singled out), a heartbeat | "Two of them are secretly werewolves. The other four have to find them." | — |
| 4 | WEREWOLF: Werewolf_Hero, then Werewolf_Eyes. A howl | "Werewolves kill at night... and lie all day." | **WEREWOLF** · KILLS AT NIGHT |
| 5 | SEER: Seer_Hero, then Seer_Reveal (the red wolf in the orb). Sparkle | "The Seer gets one look into a soul. Wolf... or not?" | **SEER** · SEES ONE TRUTH |
| 6 | WITCH: Witch_Save (the green flask), then Witch_Kill (the skull flask). A cork, a pour | "The Witch: one potion saves... one kills." | **WITCH** · SAVE OR KILL |
| 7 | VILLAGER: Villager_Wide (the wolf's shadow slides in), then Villager_Hero. A murmur | "Everyone else? Just their voice... and their vote." | **VILLAGER** · VOTE THEM OUT |
| 8 | Lineup_Low, then Werewolf_Wide | "Catch both wolves, the village wins. Let the wolves match the village... wolves win." | — |
| 9 | The title over Werewolf_Hero. An impact and the howl | "Who's lying? Who survives? Let the game begin." | **WEREWOLF** / AI EDITION |

## Change log

- 2026-10-19: draft v1 (45 s). The independent hook review scored it 6/10.
- 2026-10-19: draft v2:
  - Cut to about 30 s.
  - The cold open is the game's own lie and inner voice.
  - The roll-call is "Two Claudes. Two GPTs. Gemini... and Grok." (names people know).
  - The rules are folded into the role lines. The win condition reads "vote out both wolves / the wolves catch up in
    numbers".
  - "Four innocents" replaces "four villagers"; "six of these AIs" replaces "the smartest".
  - Captions are three words at most.
  - Stage changes:
    - The Werewolf is menacing.
    - The Seer has a wolf reveal in the orb.
    - The Witch shows two hero potions.
    - The Villager is at night, with a wolf shadow.
    - The Lineup has a backdrop and spotlight snaps.
  - Sound plan added.
- 2026-10-19: hook review of v2 scored 7.5/10. Draft v3:
  - Cold open: a CLAUDE FABLE name tag and a "SECRETLY A WEREWOLF" caption.
  - Open loop: "the other one is hiding among these six" ... "Can they catch Fable in time?"
  - The roll-call close-ups follow the spoken order.
  - The stakes line is shorter.
  - The title sits over Werewolf_Hero.
  - Timing follows the real voice.
- 2026-10-19: hook review of v3 scored 8.5/10. Draft v4:
  - "Two wolves. Four innocents." is cut (it repeated shot 3).
  - "hiding among the other five".
  - The whisper is trimmed (still the model's own words).
  - "Let the wolves match the village".
  - Stage fixes:
    - the green flask is readable whole;
    - a bone skull in a darker purple;
    - the window off the shadow wolf's snout;
    - the lineup close-ups are darker.
  - Next: an animatic in voice E's chosen style, timed to the real read, then the review that decides 9+.
- 2026-10-19: the owner approved Option A: the cold open, then "The six smartest AIs in the world... going head to head
  in a game of Werewolf.", the roll-call, "Two of them are secretly werewolves. You just met one. The other is hiding
  among the other five.", the four roles, the stakes, and "Can they catch Fable in time? Let's play."
  - Host voice: E, in the style of "E - 1 hook host - take 1" ("high-energy video host, punchy and fast"), locked as
    Host.
  - First full render: `FullGameFolder/3880b590/3880b590 intro.mp4` (49.5 s).

## How the intro is built (as of the first render)

1. `python "3 Werewolf TTS/intro_voice.py" <id8>`:
   - the host lines go out in one request, cut and checked by transcript;
   - the cold open is the wolf's own voice;
   - writes `FullGameFolder/<id8>/intro_voices.json`.
2. `python director/intro.py <id8>`: the shot list (`games/<id8>/intro/intro_plan.json`), timed to the voices:
   - the cold open and the stakes montage reuse the game's own rendered frames;
   - the roll-call cuts follow the spoken order;
   - each role gets two cuts.
3. `blender --background out/intro.blend --python director/render_intro.py -- <id8>`: the stage shots:
   - an eased dolly on each shot;
   - idle life and flicker;
   - the spotlights snap on, the red eyes flash in turn, and the wolf's shadow slides in;
   - the glow pass.
4. `python director/intro_overlays.py <id8>`:
   - the name tag;
   - the typing speech and thought boxes;
   - the red haze with SECRETLY A WEREWOLF;
   - the names, the role words with their captions, and the title.
5. `blender --background --factory-startup --python director/encode_intro.py -- <id8>`:
   - the cut and the voices;
   - impacts on the cuts, the role signatures (howl, sparkle, cork, murmur) and the final howl;
   - a heartbeat under the cold open, and the M4 music bed from the lineup on.
- 2026-10-19: the owner's changes after the first render:
  - The intro opens on "I made the six smartest AIs compete in a game of Werewolf."
  - No cold open and no game footage: nothing that spoils the game, since it is a short one.
  - "Two of them are secretly werewolves. The other four have to find them."
  - The stakes play over the intro's own stages.
  - It ends on "Who's lying? Who survives? Let the game begin." (no "Can they catch Fable", no "Let's play").
  - Runtime 39.4 s.
