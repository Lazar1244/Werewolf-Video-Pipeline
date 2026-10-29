# Werewolf Video Pipeline

AI models play Werewolf against each other, and each game becomes a YouTube video for the **Mind Machines** channel ([@MindMachinesPlay](https://www.youtube.com/@MindMachinesPlay)).

Nothing is scripted. Every seat is played by a different AI model. Each model knows only what its role would know, and it argues, lies and votes on its own while writing down its private thoughts. The pipeline then turns the recorded game into an animated, voiced video.

```
play the game  →  export it  →  episode beats  →  voices  →  Blender render  →  sound mix  →  MP4 + Shorts + thumbnails
```

## The parts

### 1 Werewolf Game: the game engine and the AI players
A TypeScript/Node monorepo:
- the deterministic Werewolf engine: 5–10 seats, 25 roles, the Sheriff, votes and runoffs, the wolf council, win checks;
- the AI controllers: every model through OpenRouter, with a per-game cost cap;
- SQLite storage;
- a CLI (`ww play / replay / models check`) and a LAN server with a web UI, so humans can take seats too.

| Read this | For |
|---|---|
| [`1 Werewolf Game/README.md`](1%20Werewolf%20Game/README.md) | Overview and quick start |
| [`1 Werewolf Game/WEREWOLF_RULESET.md`](1%20Werewolf%20Game/WEREWOLF_RULESET.md) | The rules, the single source of truth |
| [`1 Werewolf Game/ARCHITECTURE.md`](1%20Werewolf%20Game/ARCHITECTURE.md) | The technical architecture |
| [`1 Werewolf Game/LAUNCH.md`](1%20Werewolf%20Game/LAUNCH.md) | Running the server and playing over the LAN |
| `1 Werewolf Game/prompts/` | Every prompt the AI players see |

### 2 Werewolf Blender: the video
Blender 5.2 scripts and a Python "director":
- **`village/`** builds a stylized, cel-shaded horror village (square, street, forest clearing, room) and near-identical figures in each model's colour, with role tells.
- **`director/`** reads a finished game, splits it into story beats, and stages each one: speakers, camera moves, captions, lighting, deaths and role badges. It renders the clips in Blender and cuts the MP4 with FFmpeg. One command: `python director/make_video.py <game id>`.
- **`thumbnail/`** and **`profile/`** make the thumbnails, the Shorts covers and the channel art.
- **`sounds/`** holds the CC0 music, ambience and effects, mapped to game moments.

| Read this | For |
|---|---|
| [`2 Werewolf Blender/SCENE_PLAN.md`](2%20Werewolf%20Blender/SCENE_PLAN.md) | The scene, the figures, cameras and the video plan |
| [`2 Werewolf Blender/INTRO_PLAN.md`](2%20Werewolf%20Blender/INTRO_PLAN.md) | The video intro |
| [`2 Werewolf Blender/sounds/SOUNDS.md`](2%20Werewolf%20Blender/sounds/SOUNDS.md) | Which sound plays when, and the sound list |
| [`2 Werewolf Blender/sounds/CREDITS.txt`](2%20Werewolf%20Blender/sounds/CREDITS.txt) | Sound credits |
| [`2 Werewolf Blender/thumbnail/HOW_IT_WAS_MADE.txt`](2%20Werewolf%20Blender/thumbnail/HOW_IT_WAS_MADE.txt) | How each thumbnail was made |
| [`2 Werewolf Blender/thumbnail/logos/SOURCES.txt`](2%20Werewolf%20Blender/thumbnail/logos/SOURCES.txt) | Where the lab logos come from |
| [`2 Werewolf Blender/profile/HOW_IT_WAS_MADE.txt`](2%20Werewolf%20Blender/profile/HOW_IT_WAS_MADE.txt) | The channel profile picture and banner |

### 3 Werewolf TTS: the voices
Gemini TTS gives every AI model a fixed character voice, plus a narrator. Each line is voiced from the game's real words and checked by transcription, and the best take is kept.

| Read this | For |
|---|---|
| [`3 Werewolf TTS/README.md`](3%20Werewolf%20TTS/README.md) | How the voices are made and the workflow |
| [`3 Werewolf TTS/TIPS_AND_TRICKS.txt`](3%20Werewolf%20TTS/TIPS_AND_TRICKS.txt) | Lessons on getting good takes |

## What is not in this repository
Kept locally only:
- finished videos, renders and per-game results;
- the game database;
- voice takes;
- the sound files (re-fetched with `2 Werewolf Blender/sounds/fetch_sounds.py`, then `prep_sounds.py`);
- generated `.blend` files (rebuilt by the scripts);
- API keys.

## Requirements
- Node.js 22.13+
- Python 3
- Blender 5.2
- FFmpeg
- an OpenRouter API key (the AI players)
- a Gemini API key (the voices)

Put the keys in `.env` files, never in the code.
