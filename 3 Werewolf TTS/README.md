# Werewolf TTS

The voices of the video characters: the 20 player names of the game plus the Narrator. They're made with Google's Gemini 3.8 Flash TTS, one character at a time.

## Setup (once)
Open `.env` in this folder, paste your Google AI Studio key after `GEMINI_API_KEY=`, and save. Then check:

```
python tts.py status
```

## How a character is made
1. **Design** a voice from a description. This saves a first sample take.
   `python tts.py design Ines "A sharp-witted woman in her thirties, low and smoky voice, quick and sly"`
2. **Audition** the character in every game situation (see `situations.json`), or test one situation:
   `python tts.py audition Ines`
   `python tts.py say Ines whisper --style "barely a whisper, trembling"`
3. **Listen** in `listen.html`: every take with its voice, style and text, newest first.
4. Repeat with new descriptions or styles until the character is nailed, then **lock** it:
   `python tts.py keep Ines --voice voice_xxx --style "slightly husky"`

Ready-made voices can be tried too: `python tts.py voices`, then `--voice Kore`.

## Files
| File | What it is |
|---|---|
| `tts.py` | The voice tool (plain Python, nothing to install) |
| `.env` | Your key (stays on this PC) |
| `config.json` | Model (`flash` or `lite`), language, and the **budget**: calls that would pass it are refused |
| `situations.json` | The test moments (player and narrator), editable |
| `characters/` | One file per character: candidate voices, and the locked voice once chosen |
| `takes/` | Every generated take (WAV) and its log, per character |
| `spend.json` | What has been spent so far (estimated from the audio length) |
| `listen.html` | The listening page |

Prices (until 2026-12-31): Flash TTS $9 per 1M audio tokens, which is about 1.7 cents a minute. A take of one line costs about $0.001–0.003.

## Decisions (owner)
- 2026-10-08: stay with **Google Gemini 3.8 Flash TTS** through our own Google key (prepay credits, AI Studio).
  - Tier 1 allows 100 requests a day, resetting at 00:00 UTC (02:00 summer time in Europe). 2026-10-22: the owner moved to the PAID Tier 1 and the 100-a-day cap seems to be gone (CONFIRMED 2026-10-23: Game 2's whole episode in one run, no 429).
  - 2026-10-22: budget raised from $4 to $10 (owner), for Game 2 (about 24 min of speech + the new intro lines).
  - OpenRouter cannot use designed voices (tested, see `../4 OpenRouter TTS test`).
  - ElevenLabs was considered: no daily cap, sound effects included. It was declined for now because 21 voices need its Creator plan (30 slots) on a monthly subscription.
- Voices are made the tips way (see `TIPS_AND_TRICKS.txt`). The owner preferred it in a blind test.
