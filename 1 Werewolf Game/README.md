# WearwolfeGame

A game of Werewolf played by AI models through OpenRouter. Humans can take any seat and join from a browser on the same LAN.

| Document | Content |
|---|---|
| [LAUNCH.md](LAUNCH.md) | **How to start the server, set up a table and invite people** |
| [WEREWOLF_RULESET.md](WEREWOLF_RULESET.md) | Game rules (the source of truth) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Technical design |
| [CLAUDE.md](CLAUDE.md) | Project status and working rules |

## Requirements
- Node.js ≥ 22.13. It provides the built-in `node:sqlite` module.
- npm. The `.npmrc` in this repo works around an npm 11.1 install bug.

## Setup
```bash
npm install
# edit .env: OPENROUTER_API_KEY and HOST_TOKEN (a long random string; see LAUNCH.md)
npm run build:web       # builds the browser interface
npm run config:check    # validates every file in config/
npm run check           # typecheck + tests
```

## Configuration (`config/`)

| File | What it controls |
|---|---|
| `models.json` | Model profiles (40, from 15 labs). Each one has a short **alias**, its OpenRouter model id and its settings. The lobby shows each model's price per million input and output tokens, and offers the ready-made groups or a **free pick** of any models. |
| `rosters.json` | Named line-ups of aliases, used to fill lobby slots quickly |
| `rules/default.json` | Every game rule switch and limit (ruleset §14.8 and §14.4) |
| `compositions/*.json` | The game modes the host picks from: classic tables and recommended modes for 5 to 10 seats, each with a description and tags (ruleset §12.3–§12.4). They are checked against the composition rules (§12.1). |
| `app.json` | Server, database, cost cap, concurrency and timeouts |
| `names.json` | Display names given to seats |

To switch models, edit `models.json` or a roster, or choose another alias in the lobby. Run `npm run config:check` afterwards: it prints every problem with its file and JSON path.

## Playing a game (command line)

```bash
npm run ww -- play --preset classic-7 --roster quick-test        # a real game through OpenRouter
npm run ww -- play --preset classic-7 --mock                     # dry run: no API calls, no cost
npm run ww -- models check --ping                                # validate the model profiles
npm run ww -- replay <gameId> --verify                           # re-run a stored game exactly
npm run ww -- resume <gameId> --cap 5                            # continue a game paused by the cost cap
```

Useful `play` options: `--models a,b,c` (instead of a roster), `--seed`, `--cap <usd>`, `--bots 2,5`,
`--quiet` (hide inner monologues), `--log-prompts`. Every game is stored in SQLite, so it can be
replayed or resumed later.

## Playing with other people (LAN)

```bash
npm run ww -- serve --preset classic-7 --humans 1,2 --roster quick-test --cap 2
```

It prints a join link per human seat and a spectator link. Send each
person their own link and open it on their device: the link hands over a session cookie once, and
the interface takes over from there.

**The interface.** Open `http://<this-pc>:3000/` on the host's machine to set up and run a game:
choose the table and the model roster, decide which seats are people, name them, set the cost cap
(with an estimate), hand out the links, and start. During the game that page is the host's control
panel — pause, resume, raise the cap, skip offline players, abort, and offer the debrief at the end.
Players and spectators see the table, the story of the game, and — when it is their turn — one
plain question with the legal options already worked out. On a phone the layout folds into one
column with your turn at the top. The entry screen also lists the games already on this server, so
closing the tab never loses one.

The UI is a static bundle the server serves itself. Rebuild it after changing `apps/web`:

```bash
npm run build:web
```

While any human is still able to act, **no screen** shows roles, thoughts or model names — not even
the host's. That lock lifts when no human can act any more, or when the game ends.

## Packages

| Package | Purpose |
|---|---|
| `@ww/shared` | Role catalogue, config and event schemas (zod), composition validation, rule layering, the frozen game snapshot |
| `@ww/engine` | The rules engine: a deterministic script replayed over recorded answers, all 25 roles, RNG and text utilities |
| `@ww/projector` | Pure per-viewer projection of the event log, and the view state the UI and the AI context read |
| `@ww/context` | Prompt pack loading and the AI context builder (layers L0–L6, token budget, per-request JSON schema) |
| `@ww/llm` | OpenRouter client, model catalogue, structured output, retries and timeouts, CostGuard, concurrency |
| `@ww/controllers` | Turns a decision request into an answer: model call, parse, validate, one repair, fallback |
| `@ww/config` | Loads and validates `config/` and reads `.env` secrets |
| `@ww/store` | SQLite database, migrations and repositories |
| `@ww/server` | Lobby, game orchestrator, REST + WebSocket gateway, sessions, recovery, stats |
| `@ww/client-sdk` | Typed client for the server: the protocol types and the per-scope state reducer the web UI folds messages into |
| `apps/cli` | The `ww` command above |
| `apps/web` | The browser interface: lobby, table, game log, turn panel, notes, host controls |

The interface is a dependency-free bundle (under 60 KB) built by esbuild and served by the server itself.

## Prompts (`prompts/`)

Every prompt is a file: `system.md` (the rules digest), `roles/<id>.md`, `teams/<team>.md`,
`tasks/<context>.md`, `reasoning/{rule,village,wolf,solo}.md` (and `reasoning/thoughts/`, the second wording), `card.md`, `output.md`, `repair.md`.
Edit them freely; each game stores the pack it used by content hash, so a running or replayed game
never changes under your feet.

## Security notes
- The OpenRouter key stays on the server. It is never logged and never sent to browsers.
- The server is meant for a trusted LAN. Do not port-forward it to the internet.
- A host who can open the database or the log files could read hidden game information. Not doing so is an honour rule.
- `--log-prompts` stores full prompts and replies (private information) in the database. It is off by default.
