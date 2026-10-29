# Launch guide

How to start WearwolfeGame, set up a table, bring people in, and stop it again. Every command runs
from the project folder (`C:\Users\PC\Desktop\WearwolfeGame`) in a terminal.

---

## 1. One-time setup

1. **Node.js 22.13 or newer.** Check with `node --version`.
2. **Install the dependencies:**
   ```bash
   npm install
   ```
3. **Fill in `.env`** (it is in the project folder):
   ```
   OPENROUTER_API_KEY=sk-or-...        your OpenRouter key; every model goes through it
   HOST_TOKEN=<a long random string>   only needed to act as host from another device
   ```
   Replace the current `HOST_TOKEN`. It is only 9 characters, which is too short for a LAN.
   Use 32 or more random characters. You can generate one with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
4. **Build the interface and check everything:**
   ```bash
   npm run build:web
   npm run config:check
   npm run check
   ```
   `check` runs the type checker and the full test suite. It takes about 90 seconds and should end
   with every test passing.

Run `npm run build:web` again whenever the files in `apps/web` change.

---

## 2. Start the server

```bash
npm run ww -- serve
```

The server prints its addresses:

```
Wearwolfe server listening on 0.0.0.0:3000
  http://localhost:3000          ← open this on this PC
  http://192.168.1.31:3000       ← the address other devices use
host access: automatic from this machine
```

The server keeps running until you press **Ctrl+C**. Leave the terminal open while you play.

> **First launch on Windows:** Windows asks whether Node.js may use the network. Allow it on
> **Private networks**, or the other devices will not be able to connect.

To try everything without spending money, add `--mock`. Every seat then answers automatically and
no API calls are made:

```bash
npm run ww -- serve --mock
```

---

## 3. Set up a table (you are the host)

Open **http://localhost:3000** on this PC. You are the host automatically, so you do not need a
password.

1. **Choose a game mode.** The gallery shows every table you can play, from 5 to 10 players.
   Use the **Players** buttons to show only one table size. **Classic tables** are the
   traditional setups and the best start. **Recommended modes** are each built around one idea:
   more clues, more bluffing, or a third side playing for itself. Each card shows the roles in
   play (wolves in red, lone players in purple) and a balance bar. Click a card to choose it. The
   bar at the bottom of the screen shows your choice: choose the **Models** there, then click
   **Create the lobby**.
   - **Models:** pick one of the ready-made groups (each shows its range of output prices), or
     **Free pick** to tick exactly the models you want from all of them. The ticked models fill
     the seats in turn, so one model can play several seats.
   - **Prices:** next to every model is what OpenRouter charges per million tokens read (**in**)
     and written (**out**). These are list prices: some providers of the same model charge
     more, and the cost cap always allows for the highest. The seat dropdowns in the lobby show
     the same prices.
   - **Custom game:** tick **Custom game** under the Models row to choose yourself who sits at
     each seat and which role they get (nothing is dealt at random). Useful for a planned match,
     for example one group of models against another.
2. **Seats:** each seat can be an **AI model** (pick which one), a **Person** (type their name), or a
   **Simple bot**.
   - **Seats and roles** (the first line of the panel): **Dealt at random** shuffles the seats
     and the cards when the game starts. **Custom** shows **Seat 1, Seat 2, ...** in order, each
     with its player and a **role** dropdown. Choosing a role swaps it with the seat that had
     it, so every card of the mode is always dealt exactly once. With a Thief, the **Middle**
     line holds the Thief's two cards; the Thief, both Sisters and at least one wolf must stay
     at seats. Each player still sees only their own role; only you, the host, see them all.
     You can switch between the two at any time before the start.
3. **Day discussion:** choose **1 round** (everyone speaks once before the vote: a shorter,
   cheaper day) or **2 rounds** (everyone speaks twice, so players can answer each other; the
   default).
4. **Cost:** set the cap for this game in dollars. Click **Estimate** for a rough range. The game
   pauses when it reaches the cap. You can raise the cap and continue without losing anything.
5. **Links:** if any seat is a person, click **Create the links**. Each person gets their own
   one-time link. For people who only watch, click **Create a spectator link**: that one can be
   shared with anyone and opened any number of times (also for an all-AI game, and later from
   **More host tools** once the game is running).
6. **Start the game.** If someone has not arrived yet, **Start without N missing players** gives
   their seats to a model instead.

The entry screen also lists **Games on this server**, so you can return to a game after closing the
tab.

**Hosting from another device** (a laptop on the same network): open the server's address there
and enter the `HOST_TOKEN` from `.env` under **Are you the host?**. That browser is then the host.

| Players | Classic tables | Recommended modes |
|---|---|---|
| 5 | Classic 5 | Fox Hunt, Night Potions |
| 6 | Classic 6 | Guardians, Idiot's Gambit |
| 7 | Classic 7 (the usual first game) | Lovers' Night, The Pied Piper, Sisters' Watch |
| 8 | Classic 8 | Big Bad Wolf, Signs and Omens, Double-Cross |
| 9 | Classic 9 | The Thief's Game, Angel's Bet, Court Day |
| 10 | Classic 10 | Chaos 10, Full Moon, The White Wolf, Free-for-All |

The modes are files in `config/compositions/`. The rules they follow are in
`WEREWOLF_RULESET.md` §12.

There are 57 models to choose from (56 enabled), from 20 labs, from under $0.20 to $50 per million
output tokens. The cheapest are Mercury, DeepSeek V4 Flash, MiMo Flash, Ling Flash and the Llamas.
The top models are GPT-6 Astra, Claude Fable 5.1, GPT-5.5 and Claude Opus 5.5. Added on 2026-10-26:
the newest Chinese models (DeepSeek V4.1 Flash 1017 and V4 Pro 0813, Kimi K3.1 Pro, Qwen 3.8 Max
Prime, GLM 5.3 Prime, MiniMax M3.1 Flash, StepFun Step 5, Tencent Hunyuan 4, ByteDance Seed 2.1
Turbo, Ling 3.1 Flash) and the big new ones from other labs (GPT-6.1 Sol and Terra, Claude Sonnet
5.5 and Haiku 5.5, Gemini 4 Argon, Meta Muse Wonder, Mistral Large 4). Many models have passed
`npm run ww -- models check` but have not played a game yet. Before seating one in a real game,
`npm run ww -- models check --ping` sends each model one tiny message, which costs a few cents in
total.

| Model line-up | Models |
|---|---|
| `quick-test` | 5 cheap, fast models (good for a first game) |
| `budget` | 6 models |
| `cheap-mixed` | 9 models from different providers |
| `china-top` | 7 Chinese flagships: DeepSeek V4 Pro, Kimi K3.1 Pro, Qwen 3.8 Max Prime, GLM 5.3 Prime, Seed 2.1 Turbo, Hunyuan 4, Step 5 |
| `usa-top` | 7 US flagships: GPT-6.1 Sol, Claude Sonnet 5.5, Gemini 4 Argon, Grok 4.7, Muse Wonder, Claude Opus 5.5, GPT-6.1 Terra |

Line-ups and models are defined in `config/rosters.json` and `config/models.json`.

---

## 4. Bring people in over the LAN

- Every device must be on the **same network** as this PC (the same Wi-Fi or router).
- Send each person **their own** link. Opening it shows a **Join the game** button: pressing it
  uses the link (a chat app's link preview does not), and that device is remembered.
- If someone already joined and you create links again, they get no new link: their seat stays
  theirs. To move a player to another device, press **Replace link** next to their name.
  If the link says `localhost`, replace `localhost` with the address the server printed, for
  example `http://192.168.1.31:3000/join/…`.
- When a player opens their link, they see a private **rejoin code** on their own screen. You
  never see it. Tell them to write it down.
- If a player loses their device, open **More host tools** in the host panel and click **New link**
  for them. While the game is still hidden, you need the rejoin code they read out to you. This way
  nobody, including the host, can take over someone else's seat.
- Share a **spectator** link with anyone who only wants to watch. Several people can use the same one.

**What people see:** a player sees the table, the story of the game, their own card and private
notes. When it is their turn, the panel at the top asks a single plain question, with a timer bar
and a word counter. On a phone the page becomes one column, with the turn panel first.
In a discussion speech, a player who still has their **Challenge** (one per game) sees a "Challenge someone?" row:
picking a player calls them out, and that player must answer right after the speech ("You have been challenged!").

**Hidden information:** while any human can still act, **no screen shows roles, private thoughts
or model names**, including the host's screen. Everything is revealed once no human can act any
more, or when the game ends.

---

## 5. Watching an all-AI game

Set every seat to **AI model** and start. With no humans at the table there is nothing to hide, so
the host and spectators see everything from the first turn:

- each seat's card on the table (the wolves are marked),
- the pack's private council at night,
- every player's private reasoning before they speak or act,
- every vote, death and role reveal as it happens,
- which model plays each seat, written under its name.

A 7-seat game with `quick-test` has cost about **$0.07**.

---

## 6. During the game (host controls)

| Button | What it does |
|---|---|
| **Pause / Resume** | Stops the game and freezes every human timer. Resume continues from the same point. |
| **Raise the cost cap** | Use this when the game pauses on the cap. Nothing is lost. |
| **Skip offline players** | Fills in the default answer for anyone who is disconnected. |
| **Settle the current turn** | Fills in the default answer for a player who is holding up the day. |
| **Settle every open vote** | Closes every open ballot with the default answer. |
| **Abort** | Ends the game. A finished game keeps its result, and an unfinished one is discarded. Everyone is told. |
| **More host tools** | Make a new link for a player who lost their device, or replace the model playing a seat (for example when a model keeps failing). |
| **All games** (top right) | Back to the list of games and **New game**. |

When your own seat dies, a big red **You died** screen tells you how and when, and which card you
held. At first a night death just says "found dead at dawn". Once the game opens to you (after the
last human is out), it names the killer, for example "killed by the werewolves". If you still
have a last action (a Hunter's shot), its button takes you straight to it. Once you close it, it
does not come back on that device.

At the end the host can open an optional **debrief**: every player, dead ones included, writes one
comment about the game. It is only for fun.

---

## 7. Stopping and coming back

- **Stop the server:** press **Ctrl+C** in its terminal.
- **Everything is saved** in `data/wearwolfe.db` after every decision.
- **Start again** with `npm run ww -- serve`. Any game that was running comes back **paused**. The
  terminal prints lines like `[recovery] <id> is paused and waiting for you to resume it`. Open
  http://localhost:3000, click the game under **Games on this server**, and press **Resume**
  (it is in the host panel on the right, or at the top on a narrow screen).
- Players reopen the same address and reconnect automatically.

---

## 8. Command-line options

You can play a whole AI game in the terminal without opening the browser:

```bash
npm run ww -- play --preset classic-7 --roster quick-test          # real game, live log in the terminal
npm run ww -- play --preset classic-7 --roster quick-test --mock   # free dry run
npm run ww -- play --preset classic-7 --roster quick-test --discussion-rounds 1   # one round of talk each day
npm run ww -- resume <gameId> --cap 5                              # continue a paused game
npm run ww -- replay <gameId> --verify                             # re-run a stored game exactly
npm run ww -- models check --ping                                  # test each model with one tiny call
```

A resumed game keeps the prompts it started with. Games paused before 2026-10-21 ask their models for a
"reasoning" field, which Claude Opus 5.5 refuses (and Fable refuses their strict schema mode), so their Claude seats
will mostly fall back to the engine's choices; newer games switch wording automatically after a refusal.
Games started before 2026-10-22 also keep their old model settings: their DeepSeek, Qwen, GLM and MiMo "flash" seats
can run out of room while thinking on long days and give no answer (the engine then plays for them).

`serve` can also create a lobby straight away and print the links:

```bash
npm run ww -- serve --preset classic-7 --humans 1,2 --roster quick-test --cap 2
```

| `serve` option | Meaning |
|---|---|
| `--preset <id>` | create a lobby with this table right away |
| `--humans 1,2` | these seats are people (they get join links) |
| `--roster <name>` | the model line-up for the other seats |
| `--cap <usd>` | the cost cap for that lobby |
| `--discussion-rounds <1\|2>` | rounds of talk each day (default 2) |
| `--port <n>` | use another port instead of 3000 |
| `--mock` | no API calls and no cost |

---

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| Other devices cannot open the page | Use the `192.168.x.x` address, not `localhost`. Check that they are on the same network. Allow Node.js through the Windows firewall on Private networks. |
| "The web interface is not built yet" | `npm run build:web` |
| A player sees "This link no longer works" | Each link works only once, and theirs was already used, perhaps on another device. Before the start, press **Replace link** next to their name in the lobby. During the game, make them a new one under **More host tools**, with their rejoin code. |
| Links point to an address phones cannot open | The PC has several network adapters (WSL, Docker, a VPN) and the wrong one was picked. Set `"publicHost": "192.168.x.x:3000"` in `config/app.json` to your Wi-Fi address and restart the server. |
| A game says "not running on this server" | It could not be brought back after a restart. You can look at it or abort it, but not continue it. |
| A player sees "your seat was given to a model" | The game was started without them (or you set their seat back to a model), so a model plays it. They can watch with a spectator link. |
| A player sees "your seat was moved to another device" | You made them a new link. The old device no longer works; they use the new link. |
| "too many wrong rejoin codes" | Five wrong codes for one seat lock its new links for ten minutes, so nobody can guess a code. Check the code on the player's own screen and try again later. |
| The cost estimate looks high | Before a model has played here it is priced from its list price, which runs high. After a game or two the estimate uses what the calls really cost. |
| The game paused on its own | Look at the chip at the top. **cost cap** means raise the cap. **humans disconnected** means the game resumes when a player returns. **recovered** means press Resume. |
| A model keeps failing | After repeated failures the server swaps that seat to a fallback model (`defaultFallbackAlias` in `config/app.json`). To drop the model for good, set `"enabled": false` for it in `config/models.json`. |
| Port 3000 is already in use | `npm run ww -- serve --port 3001`, or stop the other server. |
| Something looks wrong after changing config | `npm run config:check` lists every problem with its file and location. |

---

## Before a real game: checklist

- [ ] `OPENROUTER_API_KEY` is set in `.env`
- [ ] `HOST_TOKEN` is a long random string
- [ ] `npm run build:web` has been run since the last change to `apps/web`
- [ ] `npm run check` passes
- [ ] You tried the whole flow once with `--mock`
- [ ] The cost cap is set to an amount you are comfortable with

---

## Every time you play (after the setup is done)

Sections 1 to 9 are needed once. After that, starting a game night is always the same.

**1. Start the server.** Open a terminal in the project folder
(`C:\Users\PC\Desktop\WearwolfeGame`) and run:

```bash
npm run ww -- serve
```

Leave that terminal open for the whole session.

**2. Open the game on this PC:** **http://localhost:3000**. You are the host automatically.

**3. Pick up an old game or start a new one.**
- To continue a game, click it under **Games on this server**. A game that was running when the
  server stopped comes back paused: press **Resume** in the host panel.
- To start a new one, choose a game mode in the gallery (filter by the number of players), pick a
  **Models** line-up, then click **Create the lobby**.

**4. Set up the table.** For each seat, choose **AI model**, **Person** (type their name) or
**Simple bot**. Set the cost cap. **Estimate** shows roughly what it will cost.

**5. Invite people** (only if some seats are people).
- Click **Create the links** and send each person their own link. They open it on their device
  and press **Join the game**. Their seat shows "connected" when they are in.
- For people who only watch, click **Create a spectator link**. One link works for everyone.

**6. Click Start the game.** If someone is missing, **Start without N missing players** gives
their seats to a model.

**7. Play.**
- The host panel has **Pause**, **Resume**, **Raise the cost cap**, and the other controls in
  section 6.
- The game ends by itself. Every card and every model is revealed at the end. You can then open
  the optional **debrief**.

**8. When you are done,** press **Ctrl+C** in the server terminal. Everything is already saved.
Next time, start again from step 1.

Only if the code changed since last time (for example after an update), first run:

```bash
npm run build:web
```

To try things out without spending anything, start the server with
`npm run ww -- serve --mock` in step 1.

---

## After turning the PC back on

There is nothing to install or rebuild again. It takes two commands in a terminal, then the
browser.

**1. Open a terminal.** Press the Windows key, type **PowerShell**, and press Enter.

**2. Go to the project folder:**

```bash
cd C:\Users\PC\Desktop\WearwolfeGame
```

**3. Start the server:**

```bash
npm run ww -- serve
```

Wait until it prints something like:

```
Wearwolfe server listening on 0.0.0.0:3000
  http://localhost:3000
  http://192.168.1.31:3000
```

Leave this window open the whole time you play. Closing it stops the game.

**4. Open the game.** Go to **http://localhost:3000** in your browser. You are the host
automatically.

- To continue a game you were playing before the PC turned off, click it under
  **Games on this server**. It comes back paused: press **Resume** in the host panel.
- To start a new game, pick a mode in the gallery, choose the models, and click
  **Create the lobby**.

**5. Friends on phones or laptops** use the second address the server printed (the
`192.168.…:3000` one), not `localhost`. The join links you create already use that address.

**6. When you are done,** click the terminal window and press **Ctrl+C**. Everything is saved
automatically.

To try it without spending any OpenRouter credit, use this in step 3 instead:

```bash
npm run ww -- serve --mock
```

