# AI Werewolf — Technical Architecture v2.6

This document is the companion to `WEREWOLF_RULESET.md` (v1.12), which is the single source of truth for game rules. This document defines **how** the system is built. Where the two disagree on game behaviour, the ruleset wins.

**Changelog v2.5 → v2.6** (2026-10-26: the custom game)
- A **custom game** (ruleset §6, the host's own deal): the lobby draft's optional `manualDeal {roles, extras?}` gives each slot its card; slot *i* sits at seat *i*. `@ww/shared/deal` (no zod, also in the browser bundle) holds `manualDealFrom`, `manualDealProblem` and `assignRole` (a role change swaps with the place that held it, so the deal stays exactly the mode's cards). `buildGame` freezes the cards in seat order and sets `GameConfig.manualDeal`; the engine then keeps the seats and cards as they stand and shuffles only the names (§9.2).

**Changelog v2.6, models (2026-10-26)**
- **17 more model profiles** (57 in total, 56 enabled, 20 labs): the newest Chinese models (DeepSeek V4.1 Flash 1017, DeepSeek V4 Pro 0813, Kimi K3.1 Pro, Qwen 3.8 Max Prime, GLM 5.3 Prime, MiniMax M3.1 Flash, StepFun Step 5 Preview, Tencent Hunyuan 4 Preview, ByteDance Seed 2.1 Turbo, inclusionAI Ling 3.1 Flash) and the big new ones of other labs (GPT-6.1 Sol and Terra, Claude Sonnet 5.5 and Haiku 5.5, Gemini 4 Argon, Meta Muse Wonder, Mistral Large 4). Each follows the earlier lessons:
  - open-weight models: `max_tokens` style, `mandatory` reasoning, a 2000-token budget (the 2026-10-22 empty-answer fix, §7.1);
  - closed big-lab models: `effort` style like their siblings;
  - Claude: `json_object` from the start;
  - Gemini: `mandatory`, with its text-enum fix automatic;
  - no temperature where the model has none.
- Stored `llm_calls` confirm the rule: every cut-off answer came from a `max_tokens`-style profile with no thinking budget; no `effort`-style model was cut off. The three untested open-weight siblings with that setup (qwen-plus, kimi-k2-6, mimo-pro) got the same fix.
- Rosters `china-top` and `usa-top` (seven flagships each).
- `maskNamesFor` keeps four more everyday words unmasked (`prime`, `wonder`, `step`, `seed`: they come from the new model names, and masking would blank "prime suspect" or "I wonder").
- All 57 pass `ww models check`; none of the new ones has played yet (`--ping` first).

**Changelog v2.4 → v2.5** (2026-10-21: plainer AI talk, the Challenge, Claude refusals, price ceiling)
- Plain-language and talk-like-a-player prompt sections; the Challenge (ruleset §9.2); doubled human timers.
- Claude Opus 5.5 / Fable 5.1 refusals (`content_filter`): json_object profiles, a step-down from json_schema, and the inner monologue asked for in one of two tested wordings (`inner_voice`, `thoughts`) with a switch after a refusal (§7.3 notes). Refused calls are charged $0.
- Routing price ceiling: no model is routed above its maker's own price (`provider.max_price`).
- Gemini votes: an enum mixing numbers and text is sent to `google/` models as all text (§7.3 notes).
- 2026-10-22: the four flash models that think by default (deepseek-flash, qwen-flash, glm-flash, mimo-flash) are marked mandatory reasoning with a 2000-token budget (§7.1 "Mandatory reasoning"); the silent fallback remap now checks the game's frozen context window and output reserve, like the host's remap (`remapProblem` in `orchestrator.ts`).

**Changelog v2.3 → v2.4** (models: a wider choice, a free pick, and prices)
- **30 more model profiles** in `config/models.json` (40 in total, 39 enabled, 15 labs, from budget to flagship). Each is chosen from OpenRouter's catalogue with JSON output support and at least 32k context; its settings follow what the model supports (temperature, effort-style reasoning), Anthropic models use `cacheControl: "anthropic"`, and the Gemini Pro profile is marked `mandatory` reasoning. All pass `ww models check`; none has played yet, so each profile's notes say to run `ww models check --ping` first.
- **`GET /api/models` carries prices**: `inPerM` / `outPerM`, dollars per million input and output tokens. They come from OpenRouter's catalogue list (one request, kept for six hours; models not yet cached are saved to the catalogue cache), or in a dry run and offline from that cache or the profile's `pricingOverride`; an unknown price is `null`, never a guess. These are list prices; the cost cap keeps reserving the highest endpoint price (§7.5).
- **The lobby's model choice**: the ready-made groups (each with its range of output prices) plus **Free pick**, a list of every enabled model, cheapest first, with its price, where the host ticks the models that fill the seats in turn. `LobbyHandlers.create` now takes the aliases. The per-seat dropdowns and the host's "replace the model" tool show the same prices.

**Changelog v2.2 → v2.3** (M7 part 1: game modes)
- **The host picks a game mode from a gallery** instead of a preset dropdown. `config/compositions/*.json` now carry `category` (`classic` / `recommended` / `custom`), a `description` and `tags`. The seven classic tables keep their ids, so `ww play --preset` is unchanged; sixteen recommended modes are added (ruleset §12.4).
- **`GET /api/compositions`** returns, for each mode, its category, description, tags, and its §12.2 balance (`weight`, or `weightRange` with a Thief, and the band), computed by the same `validateComposition` the config loader uses.
- **`apps/web/src/views/modes.ts`**: the gallery (a seat-count filter, then "Classic tables", "Recommended modes" and — for later — "Your modes"), each mode a card with its tags, description, role chips (counted and coloured by side: wolves, loners, village) and a balance meter (the band shaded, the weight marked; the words say "leans", since the weights are starting estimates). The lobby editor shows the chosen mode the same way. Cards are buttons, from the keyboard too.
- **Tests**: `tests/modes.test.ts` checks every shipped mode — legal (§12.1), in the balance band, described and tagged, a classic and a recommended mode at every size 5–10, the classic tables exactly as §12.3 lists them, nothing claiming popularity — and plays each one to an end twelve times with valid events. `apps/web/test/modes.test.ts` covers the gallery: grouping, the filter keeping the choice consistent, picking by click and keyboard, the role chips and the balance wording.
- **Review fixes (M7 part 1).**
  - **Idiot's Gambit reworked.** At 6 seats nothing blocked the wolves' win by numbers, so the village lost on Day 1 and the Idiot and Scapegoat hardly mattered. It is now Werewolf ×2, Seer, Village Idiot, Raven and Hunter (+2): the Raven loads nearly every vote, and the Hunter blocks the early numbers win.
  - **Descriptions match the rules**: Cupid joins cross-team Lovers; the Sisters vouch for each other, not for the village; the Scapegoat dies on a tie that survives the runoff; Fox Hunt can end with nobody standing; the White Werewolf modes say that the pack must unmask its traitor. Double-Cross is tagged "twists", not "solo". Chaos 10 moves to the recommended group.
  - **The create bar sticks to the bottom of the screen** under the gallery, so on a phone it is right there after a pick. **Keyboard focus survives a pick**, and a card is announced with its description and balance (`aria-labelledby` / `aria-describedby`).
  - **Tests**: every recommended mode's key mechanic must happen, and both the village and the wolves must win now and then, over 100 bot games; the `/api/compositions` payload is checked. The modes that lean in bot play are flagged as calibration candidates (ruleset §12.4).
- **Next (M7 part 2):** a custom mode builder, whose modes are saved to `config/compositions` and appear under "Your modes" (owner decision).

**Changelog v2.1 → v2.2** (M6 web UI)
- **`apps/web`** is the browser interface: plain TypeScript bundled by esbuild (`build.mjs`) into `apps/web/dist`, which the gateway serves as static files. No framework, no runtime dependency — the bundle is the `client-sdk` reducer plus five view modules.
- **One state, one render.** `src/app.ts` holds `AppState` (the `client-sdk` `ClientState`, the answer being written, validation issues, notes) and a pure `reduce(state, message)`. `src/main.ts` owns the single socket and calls `render()` after every message; every view is a pure `render(element, state, handlers)`. What is on screen is therefore exactly the projection the server sent — the browser never derives hidden information.
- **Views** (`src/views/`): `table.ts` (seats, deaths, the Sheriff badge, and the seat picker when a target is wanted), `log.ts` (the story: phase separators, speeches with their suspicion and claim, pack and lover channels, thoughts), `turn.ts` (one question per decision kind, the word counter, the deadline bar, `canSubmit` / `buildDecision`), `side.ts` (your card, your notes, host controls) and `lobby.ts` (table and roster choice, seat controllers, cost cap and estimate, join links, start).
- **`describeFor`** (in `projector`) re-tells a private notice for a reader who is not its owner, so a spectator reads "Alba is the Werewolf" and "Mila's vision: Fenn is not a werewolf" where Alba and Mila read "You are…" and "Your vision…". The recipients come from the entry itself (`ViewEntry.seats`, filled from `vis.seats`), because most payloads do not say who was told; a notice addressed to a whole channel is told about the group ("The pack: …"), and a notice addressed to the reader is left exactly as they should read it. Carrying the recipient list leaks nothing: an entry only reaches a seat that is on that list, and the others are then its channel, whose members already know each other.
- **The turn panel is rebuilt only when the request or the draft answer changes**, so typing is never interrupted; a new request flashes the panel and sets the tab title to "Your turn".
- **A spectator reads the table, not only the log.** `reduceView` records `ROLE_ASSIGNED` / `ROLE_CHANGED` into `table[].known` when the viewer has no seat — which can only happen on a feed that already contains those entries, i.e. a spectator's once the game is open to them. A seat's own view never has `known` for anyone else, because a seat is never sent another seat's card.
- **Layout**: three columns on a wide screen. At ≤1100px the columns dissolve (`display: contents`) and the panels are ordered one by one: *your turn → the table → the story → your card → your notes → host controls*, so a phone shows what you have to do, then what is happening. A further pass at ≤640px. Checked by hand at 375×812 (no horizontal overflow).
- **The bundle carries no zod**: `ROLES` is imported from `@ww/shared/roles`, a published subpath of the leaf module, so the browser ships about 58 KB instead of 502 KB. The word counter comes the same way, from the engine's import-free `@ww/engine/text` (re-exported by `projector`), so the limit a player sees is the one the engine applies. The dependency test accepts a subpath a package publishes in its own `exports` map and still rejects any other deep import.
- **The host's entry screen lists the games already on this server** (`GET /api/games`), so closing the tab does not lose a game; a game is also addressable as `/?game=<id>` and remembered in `localStorage`.
- **Review fixes (M6).**
  - **Answers the player writes are protected.** The word counter is updated from the `oninput` handler (the panel itself must not be rebuilt while typing, or the caret moves), and an over-long answer cannot be sent — the engine would silently cut the end off it. A re-delivered `decision_request` with the same id no longer wipes a half-written answer, which is what makes the pause fix below safe.
  - **A pause no longer leaves a lying countdown.** The gateway re-delivers each open request when the clock freezes and again when it is re-armed, so the deadline the browser holds is the one the server is running.
  - **An abandoned game is announced to everyone**, not only to the host: the orchestrator emits `aborted`, the gateway broadcasts it, and the client drops the pending question and says the game is over.
  - **"Skip" answers with nothing** instead of sending whatever was half-chosen, and is only offered where an empty answer is legal (an optional `target` without `allowNone` is not skippable).
  - **The lobby draft goes to the host alone.** It names the models and the people, so `lobby_state` now carries it only on the host's socket (§9.1).
  - **Errors and dead ends are visible**: a server `error` message is shown as a dismissible banner, a socket closed with 1008 stops the retry loop and explains that the link belongs to someone else, other closes back off up to 15 s, and a heartbeat `ping` detects a half-open socket.
  - A human speech may carry a **role claim**, chosen from the cards in play, exactly as a model's answer can (§9.2). The host can also apply the `current_speaker` and `all_ballots` fallbacks, not only `disconnected`.
  - Smaller ones: the "nobody" button is only pre-selected once the player has actually chosen, notes are marked saved only when they reached the socket, the tab title stops shouting "Your turn" when the turn passes, the timer keeps its scale after a reconnect, and the log is rebuilt only when entries change.
- **Review fixes (M6 round 2).** The second review drove the real flows in a browser and found what hand-made test messages could not:
  - **The links button works.** The browser sent `Content-Type: application/json` on a POST with no body, which Fastify refuses. REST now goes through `client-sdk`'s `request()`, which sends the header only with a body, and reports the server's own words (a schema error is turned into `field: problem` by the gateway, not raw JSON).
  - **A device that connects during a pause knows it.** `paused` is derived from `hello.status`/`pauseReason` and from `host_status`, and the gateway sends `host_status` to a host socket on connect and on resync. After a reload, a reconnect or a crash recovery, the host gets **Resume**, not a Pause button that does nothing.
  - **The host's cost is refreshed at every Dawn and Dusk** (§9.1). While the game is hidden, the host is shown what had been spent at the last boundary, rounded — never a mid-night figure, even on connect.
  - **The lobby draft reaches the host alone** in every message, including the first one a socket gets on connect (the first-message path had been missed; the test now checks every message).
  - **A closed request is withdrawn.** When a human's request is settled without them (timeout, host fallback, away), the new `decision_closed` message clears the question; an answer that arrives late (`not_waiting_for_this`) does the same instead of showing a raw code.
  - **Rejoin codes follow §9.1.** A seat's code is made when its link is redeemed and handed to that browser in the redirect's URL fragment (never sent back to a server); only its hash is stored. The host's links, `ww serve` and a reissue no longer show any code. A reissue checks the code of the device that last joined the seat.
  - **Models are revealed once the game is open** (§15b): `hello.models` (seat → alias and label) is sent only while the lock is open, and the table shows each seat's model. At `GAME_OVER` everyone gets a fresh snapshot.
  - **A player whose game has opened reads the whole game.** A seat socket also holds the spectator principal once the lock is open (`dead_human_spectates`); the client reads the story from that feed and keeps the player's own card from their seat feed.
  - **A game that is not running here any more is shown read-only** from its stored log (finished, aborted, or not recovered, with pause reason `not_loaded`), instead of a lobby editor; a game that could not be recovered can still be aborted. The host has an **All games** button, and opening `/` shows the games list rather than reopening the last game.
  - **Answers are safe.** Send stays disabled until the player has actually chosen (a Seer pressing Send early no longer gives up the night); an answer that could not be sent because the socket was down is kept and can be sent again, and a snapshot that still carries the same open request re-enables Send.
  - **Nothing a player types is wiped.** The notes box is built once; the lobby and host panels are rebuilt only when their data changed, and then through `preserveEdits`, which puts back an input being edited, with its caret.
  - **The countdown uses the time left** (`remainingMs`), measured on the device, so a phone with a wrong clock counts down correctly; the seconds are written on the bar (a phone has no hover).
  - **Host tools**: reissue a player's link (with their rejoin code while hidden) and replace the model on a seat, in the host panel. The status shows `over_offer` and `debrief` (`displayStatus`) instead of "running".
  - Also: the debrief form no longer asks for a suspect or a claim; the Thief's choices name the cards; the story shows death causes, default answers used, a Hunter who did not shoot, a skipped council and the debrief opening; the heartbeat closes a socket that has heard nothing for 45 s; seats used as buttons work from the keyboard; `GameClient` (unused) was removed from `client-sdk`.
- **Review fixes (M6 round 3).**
  - **A forced start shuts the missing player out.** The seat sessions of every slot converted to a model are revoked at start, and a seat cookie only counts while the frozen snapshot (`slots.controller`) still says that slot is human. The old link returns 404, and a surviving cookie is refused with 1008 "the game started without you, so your seat was given to a model" — before, it opened the model's private screen.
  - **Every host command gets an answer** (`command_result{cmd, ok, message}`), in words. A game that is not live here (`not_loaded`, `corrupt`, `version_mismatch`) can be aborted over the socket as well as over REST.
  - **The host tools use live data.** `host_status.humans` lists the people by lobby slot and name, with their connection (host-safe: a slot is not a seat), which also names who is offline. Replacing a model is offered only once the game is open — the only time the server allows it — listing each seat by player name with its current model from `hello.models` (which now carries the slot). The tools' dropdowns keep the host's choice across rebuilds.
  - **The debrief offer leaves the screen when answered**: `answerDebrief` reports the new status after settling the offer.
  - **A silent model replacement is announced at the next Dawn/Dusk** (§9.5), not when it happens, and each notice is retired at the following boundary.
  - **The host's hidden cost is computed from the store**: the cost of every call made for a request opened before the last Dawn/Dusk. It is right after a crash and in the games list, where the rounded running total had shown mid-night spending.
  - **Raising the cap resumes only a game the cap had paused**; a host pause stays a pause.
  - **`decision_closed` means "settled without you"** only: a player's own accepted answer gets `decision_accepted` alone, so the panel shows "Sent". Stopping a game closes every open human question.
  - **The host can sign in from another device** (`POST /api/host/login` with HOST_TOKEN sets the HttpOnly host cookie), offered on the page a device without a game lands on.
  - **Links use the LAN address** when the host opened the page as `localhost`.
  - **The cost estimate is calibrated**: only model seats are counted, and a model that has played before is priced from the median of its real past calls; the lobby says which basis it used.
  - Smaller: the offline banner goes when the connection is back (and its text is removed, not just hidden); the Witch cannot pick the player she heals as her poison target; refusals name players instead of seat numbers; the Sheriff runoff has its own question; an empty pack message reads cleanly; a default answer says why (offline, skipped by the host, timed out…); the games list shows the table and the date; the lobby editor links back to all games.
- **Review fixes (M6 round 4).**
  - **A seat is granted only to a slot that is a person's now.** `principalsFor` and the start loop check the frozen snapshot (`isHumanSlot`); before the start, `slotIsHuman` reads the draft. A lobby edit that hands a slot to a model revokes that slot's sessions and closes its socket (1008 "the host gave your seat to a model"), and the start closes any socket on a slot that went to a model. Before, a player whose slot was switched to AI kept receiving that AI seat's private feed.
  - **Seat links are issued only in the lobby.** After the start, `/links` is refused; a seat changes hands only through `reissue-link`, which needs the rejoin code while the game is hidden (and now locks after five wrong codes). A reissued seat's old device is told why it was shut out.
  - **Spectator links are shareable**: redeeming one creates a new spectator session each time and leaves the link valid; `POST /api/games/:id/spectator-link` gives one at any time (also for an all-AI game, and after the start), without touching the seat links.
  - **The cards in play are shown** above the table, and the story starts with the game's opening line (players and cards), which had been skipped.
  - **"Settle the current turn" reports what happened**: refused (in words, `ok: false`) at night while hidden, "done" by day while hidden (no count), a count once open. It judges the phase from the game's own `PHASE_START`, so Dawn is public, and it settles a pending Hunter shot or Sheriff successor as well as a speech.
  - **Games reopened after a restart are complete**: seats, names and models are read from the stored events, so a player of a finished game gets their own card back and everyone sees the models.
  - **The games list needs a live session**, not just a cookie with the right name. The server pings every socket and closes one that stops answering (a phone that left the network no longer stays "connected").
  - The cost estimate learns only from games that are open or over (a hidden game's calls stay private). A request carries its full clock (`totalMs`), so the countdown keeps its scale after a reload. A host who is not playing gets the host controls first on a phone.
  - Smaller: a wrong host token is reported on the sign-in form; a question settled without the player is explained; a dead player with a last action is told so on their card; the table does not offer the Witch the player she heals as a poison target; while nobody is asked anything, the story says what the table is doing (never who acts); a lobby can be discarded; the timer label stays inside the panel.
- **Review fixes (M6 round 5).**
  - **"New links" never makes a second path onto a joined seat.** A slot whose player has already opened their link is skipped (reported as `joined`); to move that player to another device the host uses **Replace link**, which revokes every earlier session of the seat and closes its socket. Before, re-sending the whole list gave two devices the same seat once the game started.
  - **Players who are absent after a restart count as offline**, so the away fallback, "Skip offline players" and the all-offline pause work on a recovered game.
  - **A reissue request is validated** (integer slot, 6-hex code), so a different spelling of a slot is no way round the five-try lockout. The lockout lives in memory; the host could reset it by restarting, which is the same honour rule as reading the database (§9.1).
  - **Notes are capped at 4,000 characters** (`NOTES_MAX_CHARS`) on both sides — well under the 16 KB socket limit in any script — and a 1009 close no longer makes the client loop re-sending them.
  - **A model replacement refreshes every screen** (a fresh snapshot with the new model), and the result names the player.
  - **A provider pause says what it is about** (`host_status.pauseDetail`): the failing model with the player and slot it plays (§9.5), or a refused API key with the right fix.
  - **After the game is decided the host panel offers only the debrief and "End"**, not game controls or host tools.
  - **A stale host cookie never locks the owner out of their own PC**: an explicit token must match, but a cookie that no longer matches falls back to the localhost rule.
  - **Links use a real adapter**: a private address on a non-virtual adapter (WSL, Hyper-V, Docker and VPN adapters are passed over), or `app.publicHost` when set.
  - **Opening a link no longer uses it**: a browser gets a Join page, and only the button (a POST) redeems the link, so a messenger's link preview cannot burn a seat.
  - **The games list is the host's** only. A `resumed` message carries the status the game went back to, so a resume during the debrief no longer shows "running".
  - Smaller: a pass reads "passes without a word"; a claim reads "claims to be the Seer"; the card no longer claims a dead player has a last action during the debrief; the tab says "Your turn" after a reload with a question open; the estimate is cleared when the seats change; revoked links leave the list; the lobby preselects Classic 7 with the quick-test models; a command's result fades after a few seconds; an abort no longer leaves a "settled without you" note.
- **Review fixes (M6 round 6).**
  - **A decided game is open at once.** The engine's `lockOpen` is true as soon as the game has a result, so the reveal (§15b) comes at GAME_OVER, not after the debrief; ending the game from the debrief offer also opens it. Before, a game with a living human stayed hidden through the whole debrief, or until a restart if the host ended it there.
  - **Question ids are opaque.** A browser's `clientRequestId` is a keyed hash (the game's secret seed, the game id and the request number), stable across a recovery; and the browser feeds (`viewFor`) drop `REQUEST_OPENED`/`REQUEST_CLOSED` and the request number on `SEAT_THOUGHTS`/`FALLBACK_USED`. Before, the gaps between one player's question numbers counted the secret night questions (§4.1).
  - **Re-making links is never a surprise**: the host's lobby knows which links are out and not yet opened (`openLinks`), and "New links" asks first. A reissue is refused for a seat that went to a model. A link withdrawn in the lobby gets its own refusal message.
  - **A socket gets no entries before its snapshot**, so a browser never builds a view without knowing its seat.
  - Smaller: a "settled without you" note stays until the player has answered the next question; on a narrow screen a new question scrolls into view (unless the player is writing notes); the seats used as buttons and the checkboxes have spoken names.
- **Tests**: `apps/web/test/main.test.ts` runs the real `main.ts` against a fake socket and a fake server — the links request, Resume after a reload, Abort and its answer, the offline banner across a reconnect, a refused seat, the rejoin code in the fragment. `apps/web/test/real-games.test.ts` plays real engine games, projects them for each viewer with the server's own `viewFor`, renders them, and checks at several points of each game that no player and no host ever sees another seat's card or thoughts — and that a spectator of an open game does, so the check can fail. It also passes every decision the turn panel builds through the engine's `DecisionSchemas`. `apps/web/test/ui.test.ts` (24) drives the client with real server messages under happy-dom and asserts what reaches the DOM — above all that another seat's role never does, for a seat, a spectator and the host. `packages/projector/test` covers the re-told notices (one per private event type, plus every one a real game produces) and what a spectator may know. `packages/server/test/orchestration.test.ts` covers the re-delivered request, the broadcast abort and the host-only lobby draft.

**Changelog v2.0 → v2.1** (M5 server)
- **`@ww/server`** holds the whole live game: `auth.ts` (host token / localhost, one-time join links, cookie sessions, rejoin codes, Origin checks), `lobby.ts` (draft, validation, links, cost estimate, start conditions), `orchestrator.ts` (§9.3), `views.ts` (§9.1 projections and the host-safe cost), `recovery.ts` (§9.4 plus the stats queries) and `gateway.ts` (Fastify REST + WebSocket).
- **One game loop.** `GameOrchestrator` replaced the M4 CLI runner; `ww play` now drives the same class, so humans, bots and models go through one code path.
- **Human seats** (ruleset §15): a request to a human opens a `decision_request` on its socket with a deadline from `rules.human_timeouts`; the answer is validated by the engine and is final. Pausing freezes every human clock and re-arms it on resume. A disconnected seat keeps its clock until `disconnectMaxMs`, then becomes **away** and falls back at once. `pauseOnAllHumansDisconnected` pauses the game when the last human drops.
- **Lobby sockets.** A room exists from the first connection, so humans join the lobby *before* the game starts; `POST /start` uses those connections for its "all humans present" check, and a forced start converts the missing seats to models (or bots) and logs `FORCED_START`.
- **Debrief** (ruleset §15b) is implemented in the engine (`game/debrief.ts`) and gated by `GameConfig.debrief`, which the lobby sets. At Over the engine asks the host (seat 0); the game sits in `over_offer` until the host answers (or `debriefOfferMs` passes, which declines). Round 1 is one parallel group, so nobody writes with another comment in view. The two new prompt files are `tasks/debrief_comment.md` and `tasks/debrief_reply.md`.
- **Recovery** (§9.4): at start-up `recoverAll()` rebuilds every unfinished game from its `decisions`, charges the calls that never reported back, asserts the stored events are a prefix of the rebuild (otherwise `corrupt`), checks the engine version (otherwise `version_mismatch`) and brings the game back **paused** with reason `recovered`.
- **Seat↔slot mapping** is written to `slots` as soon as the game starts, which is what the results and the `model_stats` / `role_stats` queries join on.
- **Link reissue**: `POST /api/games/:id/reissue-link` revokes the old session and issues a new one; while the spectator lock is closed it requires that seat's rejoin code, so the host alone cannot take over a live seat. Every reissue is logged as `LINK_REISSUED`.
- **`ww serve`** starts the LAN server, optionally creates a lobby, and prints the join links and the spectator link (since M6 the rejoin codes appear only on each player's own screen).
- **`@ww/client-sdk`** carries the typed protocol, a `ClientState` reducer (`applyMessage`, with resync on a `vseq` gap) and, since M6, the REST helper `request()`.
- **Review fixes (M5 round 1).**
  - **The run loop survives a pause.** It waits inside the loop and is woken by `resume()`; a pause no longer ends the game. This is what makes the cost cap, a host pause and recovery resumable at all. (`ww play` still exits on a pause, by choice: it races the loop and stops, and the game is continued with `ww resume`.)
  - **Answers are persisted the moment they arrive** as `decisions.status = 'buffered'` (§9.3 step 3) and are only applied when their whole group is complete and the game is running. A pause therefore applies nothing, and a crash inside a group never re-buys an answer that was already paid for. Applying a decision and committing its events is one transaction.
  - **Recovery now runs the game**: `recoverAll()` resolves the catalogue for the stored profiles, starts the orchestrator (paused, reason `recovered`) and re-loads any buffered answers; `ww serve` calls it at start-up.
  - **Abort is persisted** and keeps a finished game's result: aborting the debrief offer ends the game as `over` with its winner, an unfinished game becomes `aborted` (and is not resurrected on the next start). Server shutdown uses `stop()`, which quiesces without touching the database.
  - **`fallback_now`** applies nothing at night while the lock is closed and never returns a count then; a "disconnected" request made at night is applied at the next Dawn. "Current speaker" settles one turn, not every pending speech.
  - **One silent remap per seat** (§9.5); after that the seat stays short-circuited with a probe each night. A host remap resolves the catalogue for any enabled profile and checks the frozen window and output reserve.
  - **`disconnectGraceMs`** is honoured: a human's clock runs for the grace period, then freezes until they reconnect.
  - Reads need a principal (`GET /api/games`, `/debrief`), an unheld `?scope=` is rejected, sockets are rate-limited, `raise-cap` is persisted, failure counts are rebuilt from the stored decisions, a seat can no longer probe for another seat's pending request, a new set of links revokes the unused old ones, and a live seat is only reissued while it is disconnected.
  - **`client-sdk` keeps one feed per scope**, so host-player mode no longer mixes the host and seat streams.
- **Review fixes (M5 round 2).** Aborting a game that already has a result now records that result whether the game was running or paused (a recovered game is always paused, so this was the case that could never be cleared). The deferred night fallback is applied once the next group has been dispatched and the game is out of the night, instead of against an empty pending map. A cap the host raised survives a crash (recovery reads the live `games.cost_cap_usd`, not the frozen one). A remapped seat starts its failure count fresh after recovery. An unexpected stall pauses the game (`corrupt`) instead of quietly ending the loop. The lobby's `rulesOverride` now reaches the game (§8 layering), and the tests for the frozen clock, the disconnect grace/away path and the deferred fallback assert what they are named for.
- **Review fixes (M5 round 3).** `applyOne` checks that the answer was really marked applied and pauses (`corrupt`) rather than letting the engine run ahead of the stored decisions; a `corrupt` or `version_mismatch` pause is terminal in the orchestrator too, not only in the store; an answer arriving after the game is over is not recorded; a bad `rulesOverride` is refused by the lobby (400) instead of failing at start; `model_stats` now reports what §10 asks for (games, seats, wins, calls, fallback rate, repair rate, average latency, cost).
- **Not yet implemented** (still open after M6): `revealDelayMs` pacing of public entries, and `human_submissions` / `requests.delivered_at` logging. A human's clock therefore starts when the request **opens**, not when it is delivered (§11.2).

**Changelog v1.9 → v2.0** (M4 context and LLM)
- **`@ww/projector`** implements §6.1: `project(events, viewer, lockOpen)` with per-viewer `vseq`, `reduceView` (the state a viewer knows, used by both the UI and the ContextBuilder) and `describe()`, the plain-English text for engine entries, shared by AI transcripts and the CLI log.
- **`@ww/context`** implements §6.2. Layers L0–L6 are built from the seat's own projection only, so a context can never contain what the seat was not told. Notes on the implementation:
  - **L0** is the rules digest for this composition (role and team files chosen from the cards in play), memoised per game and identical for every seat.
  - **L3** is built from the *public* projection, one JSON block per day, digested oldest-first when over `l3Cap`; the current day is never digested.
  - **L5** is not stored separately: the seat's latest `notebook` comes from its own `SEAT_THOUGHTS`, so it replays for free.
  - **L6** carries the task text, the enumerated legal options, the monologue guidance (wolf / solo / village) and the per-request JSON schema.
  - The builder asserts the total against `inputBudget` instead of looping.
- **Own night actions are now visible to the actor.** `NIGHT_ACTION` was spectator-only, which meant a seat could not see what it had done. It is now addressed to the acting seat (spectators still see everything).
- **Talk requests carry `round` / `maxRounds`**, so a prompt can say "round 2 of 3" without the builder re-deriving it.
- **`@ww/llm`** implements §7: the OpenRouter client (error classification, `usage.cost` → `/generation` → estimate), the catalogue with per-endpoint maximum prices, structured-output modes with downgrades, `callModel` (attempt timeouts, transport retries with backoff and `Retry-After`, the decision ceiling split 60/40 between the initial and repair calls), the `CostGuard` ledger and the concurrency limiter. `MockProvider` answers from the request's own schema, which powers the tests and `ww play --mock`.
- **`@ww/controllers`** turns a request into an answer: build context → call → parse → validate → one repair call → `no_answer` (the engine then applies the ruleset fallback). It also holds the per-game, per-seat downgrades.
- **`apps/cli`** (`ww`): `play`, `resume`, `replay --verify` and `models check --ping`. The runner is the M4 subset of §9.3: dispatch a group in parallel, apply answers in request order, persist events, requests, decisions and `llm_calls` per step, and pause on the cost cap. Server, humans and the debrief stay in M5.
- **Frozen snapshot** (`GameSnapshotSchema` in `shared`): engine config, slot profile copies, token budget, pinned `attemptTimeoutMs` / `maxOutputTokens`, effort shares, transport retries, decision ceiling, cost cap and prompt-pack hash. It is stored in `games.config_json` and is what `resume` and `replay` read.
- **Store**: new repositories for slots, requests, decisions, `llm_calls` (a row is written with status `sent` before each request), the catalogue cache and the game's cost/result columns.
- **Review fixes (M4 round 1).**
  - A group is awaited with `allSettled`, so a cost-cap stop keeps every answer that was already paid for; only the missing requests are re-issued on resume.
  - `resume` loads the game's **stored** prompt pack by hash and replays its `SEAT_DOWNGRADE` meta events, which the controller now emits.
  - The CLI carries a light version of §9.5: after `providerFailureThreshold` consecutive `provider_error`/`timeout` decisions a seat is short-circuited to an immediate fallback and retried once per night, so one dead endpoint cannot drain the budget or the clock.
  - Name masking (ruleset §14.6) masks brand words only (label, id, vendor, family). Size and variant words ("flash", "small", "mini"…) are ordinary English and are never masked.
  - Every context layer now has a hard cap: L1/L5/L6 are truncated, and L2/L3/L4 share whatever room is left, so a context cannot exceed the input budget.
  - `maxOutputTokens` is 1400 in the shipped profiles: reasoning (150 words) + notebook (250) + a 120-word speech needs roughly 800 tokens, and a truncated answer would cost a repair call.
  - `effort`-style profiles always send an effort level ("disabled" = low, ARCHITECTURE §7.1), so a reasoning-by-default model cannot eat the answer budget.
  - The frozen window, output reserve and pinned values also cover the fallback profiles a seat could be remapped to.
  - The per-request schema uses nullable types with `null` inside the enum, as §7.4 specifies.
  - A model answer without its inner monologue is repaired rather than accepted (ruleset §14.3).
- **Review fixes (M4 round 2).** L6 is never truncated (it ends with the JSON schema); `SEAT_DOWNGRADE` carries a structured payload that `resume` replays through `LLMController.applyDowngrades`; the provider-failure count is rebuilt from the stored answers on resume (§9.5); ping calls are logged in `llm_calls` and report a mode that `models.json` should pin; old ability results are compacted to their first sentence before anything is dropped.

**Changelog v1.8 → v1.9** (M3 full catalogue)
- **Typed engine events.** `packages/shared/src/engine-events.ts` has one strict zod schema per engine event type (`EngineEventPayloads`), plus `checkEngineEvent(e)`. The engine's `emit<T>()` is typed against it, so a payload that does not match its schema fails to compile. This replaces the `shared/events/*.ts` plan in §4.2. `DECISION_APPLIED` is not used: the public part of a decision is its own event (`SPEECH`, `VOTES`, `NIGHT_ACTION` and so on).
- **`emit` snapshots** the payload and visibility with `structuredClone`, so later mutation of game state can never rewrite a logged event. This fixed a real bug where the Thief offer changed after the swap.
- **All 25 roles are implemented**, and `SUPPORTED_ROLES` is the full catalogue. The §5.4 hooks live at these call sites instead of a generic hook table:
  - `game/teams.ts`: `changeTeam`, `infect` and `evaluateLovers` (Lovers conversion, Cupid reversion, Piper losing power).
  - `game/dawn.ts`: the absorption order (Protector, then the Elder's life, then heal), infection, Knight curse, Raven mark and Bear notice.
  - `game/deaths.ts`: heartbreak closure, Elder curse, and four trigger kinds (Sheriff successor, Hunter shot, Scapegoat ruling, Wild Child conversion).
  - `game/day.ts`: vote bans, Raven +2, Idiot immunity, Scapegoat tie-death and the Judge's second vote.
  - `game/script.ts`: the constructive Thief deal.
- **New decision kinds:** `choice` (thief / wolf_hound / little_girl / wolf_father), `pair` (cupid), `multi` (piper / scapegoat_ruling), `message` (lovers / sisters channel). `vote` gains the Judge's `second_vote` flag. `council_ballot.target` may be `null` when `wolves_may_skip` is on. Null is one more option: a unanimous null proposal locks it early, and in the final ballot it takes part in the plurality and the leader's tie-break like a target. A winning null gives `COUNCIL_RESULT {victim: null}`. `COUNCIL_SKIPPED` is only for a night with no legal victim.
- **Fuzzing:** `packages/engine/test/fuzz.test.ts` plays 10,000 games over random valid compositions of the whole catalogue with bots that also time out and answer invalidly. It checks every event against its schema, hidden-info visibility, no requests to dead seats except dying actions, the monologue-before-speech order, termination, and that the winner matches who is alive. A second test checks that replay equals direct simulation over full-catalogue games.

**Changelog v1.7 → v1.8** (M2 engine core)
- **Engine as a replayed script.** The engine is written as a plain, deterministic game script: setup, then night, dawn, day and dusk in a loop.
  - It asks for decisions through an `Asker`.
  - **Replay mode:** the API re-runs the script over the recorded answers. When a group of requests still lacks answers, the script suspends. So the engine state is just `(frozen config, answer log)`, which is exactly what replay and crash recovery need (§5.6, §9.4).
  - **Direct mode:** `simulate()` runs a whole game in one pass with a synchronous decider, for bots and simulations. It produces byte-identical events, and a test checks this.
  - A rerun costs O(game length) per completed group, which is negligible at 5–10 seats.
- **Request IDs and group IDs** come from counters inside the script, so they are deterministic.
- **Roles plug in at named call sites** (this replaces the §5.3 "cursor / enter(state)" description; the script's call stack is the cursor):
  - `packages/engine/src/game/roles.ts`: the `ROLE_BEHAVIOR` registry (`initialUses`, `deathTriggers`, `blocksParity`) and the `SHERIFF_TITLE` module (`voteWeight`, `deathTriggers`, `blocksParity`).
  - `packages/engine/src/game/night.ts`: `NIGHT_STEPS` providers ordered by ruleset §7.2 step number. Consecutive active steps sharing a `band` form one parallel group, resolved in (step, seat) order.
  - The remaining §5.4 hooks (absorbAttack, onExecutionTarget, unresolvedTie, scoreBonus, ballotFlags, afterFirstExecution, dawnPublicNotice, onTeamChange, duskTransition, detectionLabel, deckConstruction) are added in M3 at the call sites marked `M3:` in the code.
- **Spectator lock** also counts dying actions still queued for a dead human (the trigger queue), and it stays closed until the first `advance()`.
- **Inner monologue** (ruleset §14.3, owner request): the `reasoning` field is the first field of every AI decision. When the group closes it is emitted as `SEAT_THOUGHTS` (visible to that seat and to spectators), just before the resulting public event (`SPEECH`, votes and so on). The UI shows "what they thought" and then "what they said". In M4, the prompt will ask wolves to plan their deception in it.
- **Decision kinds:** `sheriff_run`, `speech` (context: discussion / sheriff / rebuttal / defence / last_words), `vote` (day / runoff / sheriff / sheriff_runoff), `council_turn`, `council_ballot`, `target` (protector / seer / wolf_kill / hunter_shot / sheriff_successor / pack_tiebreak), `witch`. M3 adds more.

**Changelog v1.6 → v1.7** (implementation decisions made during M1)
- New package `@ww/config`: a Node-only loader and validator for `config/`, shared by server and CLI. It depends only on `shared`.
- SQLite runs through Node's built-in `node:sqlite` (`DatabaseSync`) instead of `better-sqlite3`, so there is no native build on Windows.
- Runtime is Node ≥ 22.13 (the owner's machine runs 23.6). TypeScript 7, Vitest 4.
- **Browser-safe packages** (`shared`, `engine`, `projector`, `client-sdk`) may not use Node built-ins or Node globals.
  - The architecture test enforces this. It scans every import form, deep imports and relative imports that leave their package.
  - A second typecheck (`tsconfig.browser.json`) compiles these packages without Node types.
- **Schema (§10).**
  - A `games` row starts as a lobby, with a `lobby_json` draft and no frozen config.
  - A CHECK constraint requires `config_json`, `seed`, `engine_version` and `started_at` once the game leaves the lobby.
  - `slots` gains `final_role`, `final_team` and `won`, plus a unique `(game_id, seat)` index.
  - A new `sessions` table (§9.1) stores only hashes of tokens and codes.
  - The `model_stats` and `role_stats` views are defined in M4/M5, once the config snapshot shape is fixed.
- **Sanitiser (§5.5):** NFKC normalisation; Unicode line separators become newlines; every Cc/Cf character is stripped except `\n`, `\t`, and a ZWJ between two emoji. Bracket look-alikes are folded. Spoofed authority tags are stripped: the list is system/engine/admin/assistant/developer/narrator/moderator/game master, deliberately not host/tool/gm, to avoid removing normal speech. A tag with a body of up to 300 chars is removed whole; a longer or unclosed tag loses its head. Role prefixes and chat tokens are stripped too, and stripping repeats until the text stops changing. Name masking is longest-first and spacing-tolerant. A test requires non-printing characters in source to be written as escapes.
- **Config layering (§8):** there is no separate "code defaults" layer. `rules/default.json` must be complete, and the server refuses to start if a key is missing.
- **Thief balance:** the composition report gives the in-play weight as a range over every legal pair of set-aside cards. The Thief and Sister cards are never set aside, and one team-Werewolf card always stays in play.
- **Game status lifecycle** (`@ww/store`):
  - Progress moves use `setGameStatus`: running → over_offer | over, over_offer → debrief | over, debrief → over.
  - `pauseGame` records `paused_from`, and pausing an already paused game only changes the reason (recovery re-pause, §9.4). `resumeGame` returns to `paused_from`.
  - `abortGame` ends a game that already has a result (over_offer or debrief, directly or paused from there) as `over`, keeping the result. Any other game becomes `aborted`, and a lobby can be aborted before it starts.
  - CHECK constraints enforce the lobby draft rules and the pause bookkeeping.
- **Store:**
  - A nested `atomic()` uses a SAVEPOINT. Every repository write goes through `atomic()`, which first checks that the surrounding transaction is still alive. It uses `db.isTransaction` on Node ≥ 22.16; otherwise it probes with `BEGIN`, which fails with "within a transaction" while one is active. Any other probe error, such as BUSY, refuses the write.
  - If SQLite aborted the transaction itself (OR ROLLBACK, I/O error), the transaction is poisoned: the write is refused and the outer `tx()` rolls back.
  - Rule: never swallow SQLite errors inside `tx()` and keep writing with raw statements; only writes made through `atomic()` are protected.
  - `busy_timeout` is set before the switch to WAL.
  - Pause reasons are a closed list, backed by a CHECK constraint. `version_mismatch` and `corrupt` are terminal: they can only be aborted.
  - Numeric range CHECKs apply across all tables: cost, flags, seat and slot ranges, and sequence numbers.
  - A re-pause overwrites the stored reason; the full pause history lives in the `GAME_PAUSED` meta events (M5).
- **Sanitiser cost:**
  - Raw input is capped by default at 16 000 characters.
  - Every pass is linear:
    - The decoration before a role word (any length of markdown, bullets, dashes, arrows, quotes or emoji) is matched atomically, using a lookahead capture plus back-reference, so it never backtracks.
    - List-marker alternatives never overlap.
    - A chain of role prefixes is removed in one match.
    - Empty `[]`/`<>` pairs are removed in one stack-based pass.
  - Leading and trailing spaces are trimmed on every pass, so the output is idempotent; a test checks this.
  - After 256 passes the input is treated as adversarial and all tag syntax (`[ ] < > |`) is dropped.
  - Spaces and tabs collapse to one space, and newline runs to at most two, before and during every pass. Tags cannot span a line break.
  - A stress test combines the maximum 256 passes with each costly input shape, including repeated list markers, and requires under 1 s; the worst case measured under 300 ms on the owner's PC. Every `Default_Ignorable_Code_Point` is stripped too, keeping VS16 only after an emoji or inside a keycap sequence, and ZWJ only between emoji. Role prefixes are recognised behind simple markdown, list numbering, bullets and dashes. Mask names get the same NFKC normalisation as the text, and name parts match with any or no separator (whitespace, `\p{Pd}` dashes, underscore, dot, middle dot, slash, minus sign). A stripped tag also takes a trailing ":" with it. Empty `[]` and `<>` pairs are removed inside the stripping loop, so splitting a tag with them cannot re-form it; the accepted trade-off is that a literal `[ ]` or `<>` in speech disappears. List markers are limited to numbers, a single letter or roman numerals. All exotic horizontal whitespace (U+1680, U+2000–U+200A, U+3000, U+2800 and others) becomes a plain space before tag detection. Authority words also match with an `_suffix` or digits (`SYSTEM_PROMPT`, `SYSTEM2`) but not as the start of a longer word (`[Systemic]` is kept). Also stripped: `</ system>`, role prefixes with up to three extra words and an optional (qualifier) or [qualifier] (`SYSTEM NOTICE (automated):`), prefixes behind emoji, arrows or curly quotes, `(SYSTEM):`, and the Llama-style `[INST]` and `<<SYS>>` tokens. `SYSTEM2FA` is kept, because digits only count as a suffix when nothing follows them. Accepted trade-offs (covered by tests): `Assistant Coach: hi` loses its prefix, and a bracketed aside that starts with an authority word is removed whole. **Out of scope** (documented by a test): letters from other scripts that look like Latin ones (homoglyphs); the injection policy in the prompt covers what the sanitiser cannot.
- **`@ww/context` may depend on `@ww/config`**, for loading prompt packs.

**Changelog v1.5 → v1.6** (applies the v1.5 review, which scored 9.0/10)
- Rejoin code always required.
- `forced` no-answer reason.
- Immediate-fallback list completed.
- Night fallbacks deferred to boundaries.
- Effort + mandatory reasoning.
- Frozen snapshot fields listed.
- L5 token cap and final truncation steps.
- Per-kind human timeouts.
- 80% warning deferred to a boundary.
- Remap limits.
- Stale text fixed.

**Changelog v1.4 → v1.5** (from independent review, 9.0/10)
- Fixed per-layer caps, so L3 never depends on any seat's private data.
- Console cost and the lobby estimate are host-safe.
- A fallback alias is required when humans play.
- Rejoin codes.
- Ruleset v1.7 alignment.
- Meta visibility defined.
- `Addressee` typing.
- Clocks for disconnected humans.
- Candidacy fallback.
- Effort reservation.
- Failure counter reset.
- Final submissions.
- Stale text fixed.

**Changelog v1.3 → v1.4** (from independent review, 8.9/10)
- No human counts at night.
- Stats and logs are host-safe.
- Day fallback is identified by display name and limited to public turns.
- A whole-context token budget, plus a debrief budget.
- Pricing per provider.
- Reasoning params stated per model family.
- Answers that arrive during a pause are buffered.
- Debrief fallbacks and recovery.
- Probe calls defined.
- Fallback-sees-fallback rule.
- Join-link reissue restricted.
- Per-game uniform timeouts and limits.
- Stale text fixed.

**Changelog v1.2 → v1.3** (from independent review, 8.7/10)
- At most one in-flight dispatch per request.
- Host controls are safe while humans are still playing.
- One timeout ceiling, measured from slot acquisition.
- Night sub-steps are spectator-only events.
- `answer()` emits nothing until its group closes.
- Remap targets must have a large enough context window.
- Debrief viewer defined.
- A seat that has failed is short-circuited.
- Away state for disconnected humans.
- Cache-write pricing.
- Downgrades rebuilt on recovery.
- `projector` split into its own package.
- `Origin` checks.
- Debrief crash handling.
- Minor fixes.

**Changelog v1.1 → v1.2** (from independent review, 8.2/10)
- Each seat can now read its own thoughts and notebook.
- A public counter (`pseq`) numbers the transcript.
- One transaction per engine step, and recovery checks a prefix of the events.
- The host's debrief choice is an engine input, and the engine allocates request IDs.
- Remap is safe in host-player mode, and hung providers now count as failures.
- A disconnected human is capped by `disconnectMaxMs`.
- Timed-out calls are charged their full reservation.
- Mandatory-reasoning models are handled.
- Events are emitted in seat order.
- One lock predicate.
- Caching breakpoints per day.
- `auto`/`N` config sentinels.
- Timeout-then-repair semantics.
- Persisted repair state.
- Pacing-aware human deadlines.
- Night sub-steps are hidden from players.
- 404 no-endpoint downgrades.
- Dual-principal sockets.

**Changelog v1.0 → v1.1** (from independent review, 7.3/10)
- Views are numbered per viewer, and request IDs are opaque.
- Visibility is an explicit list of recipient seats.
- Host-player mode.
- The event log is split into an engine stream and a meta stream.
- Parallel decision groups are applied in a fixed order.
- Sheriff candidacy is sequential.
- Each attempt has its own timeout, and the clock starts when a concurrency slot is acquired.
- One digest threshold per game.
- Night-step providers and a full list of role hooks.
- Crash, pause and resume are fully specified.
- OpenRouter corrections: reasoning budget, strict schemas, price reservation.
- A seat's model can be swapped mid-game if its provider fails.
- Cache-friendly prompt order.
- Cookie sessions for joining.
- UI contract completed (§11).

**Owner decisions (2026-09-21)**
- TypeScript on Node.js, end to end.
- The server runs on the owner's PC. Humans join from browsers on the same LAN.
- SQLite storage.
- All LLM access goes through **OpenRouter** with a single API key.
- A configurable per-game **cost cap**.
- Everything is modular and config-driven. Models can be switched easily.
- The web UI comes later. This step delivers a clean backend plus a typed API/protocol for the UI.

**Settings scope.** Every game setting lives in validated config files and can be overridden per lobby through the API. The planned UI only shows the lobby essentials: preset, slots, model per slot, human toggle and cost cap. Nothing prevents exposing more later.

---

## 1. Goals and non-goals

| Goals | Non-goals (v1) |
|---|---|
| A deterministic, fully tested rules engine that implements the ruleset exactly | Internet hosting, user accounts |
| Plug-in roles and night steps | Mobile apps |
| Any OpenRouter model on any seat, switched from config or the lobby | Non-OpenRouter providers (there is an adapter slot, but only OpenRouter is built) |
| 0…N human seats over the LAN, with strict per-seat information isolation, including a host who also plays | Exposure to the internet |
| Exact replay, crash recovery, per-model statistics | Learning between games |
| A typed real-time protocol that any web UI can consume | The UI itself (next steps) |

---

## 2. System overview

```
                         ┌──────────────────────────── Node.js server process ───────────────────────────┐
 Browser (host)  ◄─WS──► │  Gateway (HTTP + WebSocket, cookie sessions)                                  │
 Browser (human) ◄─WS──► │     │  principals: host / seat / spectator  (a person can be host+seat)       │
 Browser (spect.)◄─WS──► │     ▼                                                                         │
                         │  LobbyService ──► GameOrchestrator (1 per running game)                       │
                         │                     │        ▲                                                 │
                         │        DecisionRequest│        │Answer                                          │
                         │                     ▼        │                                                 │
                         │     ┌──────── Controllers (1 per seat) ────────┐                              │
                         │     │ LLMController   HumanController   BotController                        │
                         │     │   │ ContextBuilder ◄── Projector ◄── engine_events                      │
                         │     │   ▼                                                                    │
                         │     │ OpenRouterClient ──► CostGuard                                         │
                         │     └───────────────────────────────────────────┘                             │
                         │                     │                                                          │
                         │                 Engine (pure, deterministic, no I/O)                          │
                         │                     │                                                          │
                         │                 Store (SQLite): engine_events, meta_events, decisions, …      │
                         └──────────────────────────────────────────────────────────────────────────────┘
                                                            │ HTTPS
                                                            ▼
                                                    openrouter.ai/api/v1
```

**Core idea**
- The **Engine** is a pure state machine. It emits **DecisionRequests**, consumes **Answers**, and records every rule-level fact as an **engine event**.
- The **Orchestrator** handles time, money, networking and pausing. It records its own facts as **meta events**.
- Engine events alone reproduce the game **byte-exactly**.
- UIs, AI contexts, replays and stats are all **projections**.

---

## 3. Repository layout (npm workspaces monorepo)

```
WearwolfeGame/
├─ WEREWOLF_RULESET.md · ARCHITECTURE.md · CLAUDE.md
├─ .env.example                 # OPENROUTER_API_KEY=, HOST_TOKEN=
├─ config/
│  ├─ app.json                  # server, db, cost, concurrency, logging
│  ├─ models.json               # model profiles (aliases → OpenRouter ids + params)
│  ├─ rosters.json              # named model sets for quick slot filling
│  ├─ rules/default.json        # every ruleset §14.8 key + §14.4 limits
│  ├─ compositions/*.json       # role presets
│  └─ names.json                # display-name pool (≥ 10)
├─ prompts/                     # prompt pack: system.md, roles/<id>.md, tasks/<kind>.md
├─ packages/
│  ├─ shared/        # zod schemas + inferred types (config, events, requests, answers, protocol, views)
│  ├─ engine/        # pure rules engine, step providers, role plugins, text utils (word count, sanitise)
│  ├─ projector/     # pure Projector + reduceView (shared by server, ContextBuilder and browser)
│  ├─ context/       # ContextBuilder (LLM messages) + prompt-pack loading (server only)
│  ├─ llm/           # LLMProvider interface, OpenRouter provider, catalogue, CostGuard
│  ├─ controllers/   # LLM / Human / Bot
│  ├─ config/        # Node-only loader/validator for config/ + .env secrets
│  ├─ store/         # SQLite (node:sqlite) + migrations + repositories
│  ├─ server/        # Orchestrator, LobbyService, Gateway (REST + WS), auth
│  └─ client-sdk/    # typed REST/WS client + reduceView (for the UI)
├─ apps/cli/  ·  apps/web/   # the browser interface (M6): esbuild bundle served by the gateway
└─ tests/
```

**Dependency rule** (acyclic, enforced by lint):

```
shared ◄ engine ◄ projector ◄ context ◄ controllers ◄ server ◄ cli   (context may also use config)
shared ◄ config ◄ llm ◄ controllers
shared ◄ config ◄ server, cli
shared ◄ store ◄ server
shared ◄ engine (types + the pure lockOpen function) ◄ projector ◄ client-sdk ◄ web   (web also uses projector directly)
```

The Projector is pure, so the browser runs the same code.

| Concern | Choice |
|---|---|
| Runtime | Node ≥ 22.13 (major version recorded in `engineVersion` from M2 on), TypeScript 7 strict |
| Schemas | zod, plus a strict-JSON-Schema emitter (§7.4) |
| HTTP/WS | Fastify + `@fastify/websocket` + `@fastify/cookie` |
| DB | built-in `node:sqlite` (`DatabaseSync`, synchronous), WAL mode |
| RNG | `xoshiro128**` with state stored inside the engine state |
| Tests | Vitest 4, plus an architecture test (dependency rule, browser safety) |
| Logs | pino (secrets redacted) |

---

## 4. `shared` — contracts

Every schema is defined with zod, and the TS types are inferred from the schemas.

### 4.1 Identifiers

| Id | Meaning |
|---|---|
| `SlotId` | A lobby slot (1…N). It is what the host configures. |
| `SeatId` | A table seat (1…N) after the seeded shuffle. |
| `Addressee` | `SeatId \| 0`. The value 0 is the **host pseudo-addressee**, used only for host decision requests. It is never a table seat. `REQUEST_OPENED` for addressee 0 has `vis: public` (the debrief offer happens after the game is over, when everything is public anyway). |
| `internalRequestId` | A server-only sequential id. |
| `clientRequestId` | An opaque random 128-bit token handed to clients. The server keeps the mapping. |

**Slots are not seats.** The host sets up slots: a model or a human per slot. At game start the engine shuffles slots onto table seats with the seed and deals display names (ruleset §2). Nobody, including the host, learns which display name belongs to which slot until the spectator lock opens. **Exception, a custom game (v2.6, §9.2):** slot *i* sits at seat *i* with the card the host gave it, so the host knows every seat's role (the names are still shuffled).

### 4.2 Events: two streams
```ts
EngineEvent = { eseq: number;                 // contiguous per game, engine-generated
                at: {phase, day, night, step?};
                type: EngineEventType; payload: Payload<type>;
                vis: { kind:'public' } | { kind:'seats'; seats: SeatId[]; channel?: ChannelLabel } | { kind:'spectator' } }
MetaEvent   = { mseq: number; wallTime: string; type: MetaEventType; payload; vis: MetaVisibility }
```
- **Recipients are resolved by the engine at emit time.** The engine writes the exact recipient list, `seats:[…]`, using the ruleset's own membership definitions:
  - Pack = the council participants at that moment;
  - Lovers = the two Lover seats;
  - Sisters = both Sisters;
  - charmed = the living charmed players at step 18;
  - private notices = the one seat they are for.

  `channel` is only a label for the UI (`'pack'|'sisters'|'lovers'|'charmed'`). The Projector has **no** time-dependent membership logic.
- **Little Girl.** The masked transcript copy is a separate event with `seats:[littleGirl]` and pre-masked text (ruleset §7.3). The Pack's copy is its own event.
- **Spectator-only data.** The public part of each decision the engine applies is its own event (`SPEECH`, `VOTES`, `NIGHT_ACTION` and so on), with the visibility the rules dictate. The engine also emits `SEAT_THOUGHTS{seat, requestId, context, reasoning, notebook}` with `vis: seats:[self]`. Only the seat itself sees them, plus spectators once the lock opens (spectators see every event). The ContextBuilder therefore reads L5 and the debrief reads "its own reasoning and notebook" through the normal projection. The thoughts replay exactly, because they are part of the stored answer. The UI does not display a seat's own `SEAT_THOUGHTS` entries to human seats, which never produce any.

**Engine event types:** everything in ruleset §16, plus `DEBRIEF_COMMENT` (added with the debrief in M5). `SEAT_THOUGHTS`, `REQUEST_OPENED`, `REQUEST_CLOSED` and `NIGHT_STEP_START` (spectator-only) are listed there too. Each type has its own zod payload schema in `shared/src/engine-events.ts` (`EngineEventPayloads`), which the UI imports.

**Meta event types:**

| Type | Purpose |
|---|---|
| `GAME_PAUSED{reason}` / `GAME_RESUMED` | pause state |
| `COST_UPDATE` | cost tracking |
| `SEAT_REMAP` | a seat's model was swapped (§9.5) |
| `SEAT_DOWNGRADE` | an unsupported parameter was dropped for a seat for this game (§7.3) |
| `FORCED_START` | the host started without all humans connected |
| `HUMAN_CONNECTED` / `HUMAN_DISCONNECTED` | connection status |
| `LOCK_OPENED` | the spectator lock opened |
| `DEBRIEF_OFFERED` / `DEBRIEF_ACCEPTED` / `DEBRIEF_DECLINED` | debrief flow |
| `ENGINE_ERROR` | an engine error |
| `LINK_REISSUED` | the host reissued a human's join link |

`MetaVisibility = 'host_safe' | 'host_full' | 'spectator'`. `host_safe` events reach the host at any time. `host_full` events reach the host only when `lockOpen`. `spectator` events reach spectators only when `lockOpen`.

| Visibility | Events |
|---|---|
| `host_safe` | `GAME_PAUSED`/`GAME_RESUMED` (reason only), `LOCK_OPENED`, `DEBRIEF_*`, `HUMAN_CONNECTED`/`HUMAN_DISCONNECTED` (by slot), `LINK_REISSUED`, `ENGINE_ERROR` |
| `host_full` | `COST_UPDATE` (per call; boundary-rounded copies are generated for `host_safe`), `FORCED_START` details |
| `spectator` | `SEAT_REMAP`, `SEAT_DOWNGRADE` |

Meta events are never replayed and never enter AI contexts.

### 4.3 Requests and answers
```ts
DecisionRequest = { internalRequestId; seat: Addressee; kind: DecisionKind; legal: LegalOptions;
                    limits: { words?: number }; group: GroupId /* always set; a lone request is a group of one */; optional: boolean;
                    channel?: ChannelLabel }
Answer = { kind:'decision'; decision: Decision<kind> }                   // validated
       | { kind:'no_answer'; reason:'timeout'|'invalid'|'provider_error'|'disconnected'|'aborted'|'forced' }
// 'forced' = the host applied a fallback. It never counts toward provider failure.
// Any in-flight AI call for that request is aborted and charged its reservation.
```
- `Decision<kind>` covers the fields of ruleset §13. AI decisions also carry `reasoning` and `notebook`.
- Human decisions carry neither. Human private notes live in `human_notes` (§10), outside the engine.
- The engine maps `no_answer` to the ruleset §13 fallback, whatever the reason.
- **Challenge (ruleset §9.2, 2026-10-21).** A discussion `speech` may carry `challenge: seat|null`; `legal.challengeTargets` is present only while the speaker has one left (`SeatState.challengesLeft`, kept apart from `uses` so a Thief swap never resets it). The engine emits `CHALLENGE {seat, target, round}` and asks the target for a `challenge_answer` speech (`words.challenge_answer`, 60). An unusable value is ignored, never rejected (the schema's `.catch(null)` and the engine's check), so it never costs a retry. `rules.challenges_per_player` and `words.challenge_answer` are **optional** in the schema: a game frozen before them loads, gets 0 Challenges and replays identically, so `ENGINE_VERSION` is unchanged. AI side: the `challenge` field is in the request schema only when offered; `{{challenge_rule}}` (system prompt), `{{challenge_hint}}` (discussion task) and `tasks/challenge_answer.md` (`{{challenger}}`). The random bot challenges only with the opt-in `challengeRate` (the fuzz uses 0.3), so seeded test games are unchanged. **2026-10-28 (owner):** `rules.challenge_answer_is_turn` (optional, default true in `config/rules/default.json`, missing = false so frozen games replay identically): a challenged player who is the very next speaker is skipped in `day()`, the answer's lean standing in for that turn's. The prompts were deliberately left as they were (owner: "dont change prompts"). Same day, `rules.challenge_in_answer` (optional, default true, missing = false): `speak()` offers `challengeTargets` in a `challenge_answer` too, `challenge()` follows the chain and returns its last answer; `day()` skips a turn only when it comes right after that seat's own answer (`justAnswered`: nobody spoke in between), so nobody speaks twice in a row and no other turn is lost. (A first version skipped every answerer who was up next; with long chains that could wrap round the order and put the last answerer's own turn right after its answer, which the fuzz, run with 1-3 Challenges per player, caught.) The only prompt change, approved by the owner: `tasks/challenge_answer.md` ends with the existing `{{challenge_hint}}`. The web turn panel and the request schema follow `legal.challengeTargets`, so they needed no change. The web turn panel shows a "Challenge someone?" row; the video pipeline (`2 Werewolf Blender/director/episode.py`) ignores `CHALLENGE` (owner, 2026-10-22: no announcement) and plays the answer as ordinary day talk.

### 4.4 Views (the UI contract)
```ts
SeatView      = { viewer:{seat}; me: {seat, name, role, team, wolfNature, powers, uses, lover?, charmed, canVote, notesAllowed};
                  table: SeatPublic[]  /* name, alive, revealedRole?, sheriff, canVote, voteBanned, marked */;
                  phase; day; night; composition; timeline: ViewEntry[]; pending?: ClientDecisionRequest;
                  channels: Record<ChannelLabel, ViewEntry[]>; privateLog: ViewEntry[]; result?: GameResult }
PublicView    = SeatView minus `me`, `channels`, `privateLog`, `pending`
SpectatorView = everything: all seats' roles, teams and thoughts, the night detail, slot→seat→model mapping
ViewEntry     = { vseq: number; pseq?: number; type; payload }
// vseq = per-viewer contiguous counter; pseq = position in the PUBLIC stream (present on public entries only, identical for every viewer); eseq never exposed
```

---

## 5. `engine` — deterministic rules core

### 5.1 API
> Implemented as a replayed deterministic script (see changelog v1.8): `createGame`, `advance`, `validate`, `answer` and `lockOpen` are in `packages/engine/src/api.ts`, and `simulate` / `randomBot` are in `sim.ts`.

```ts
createGame(cfg: GameConfig): EngineState                          // cfg includes the seed; validates config + composition
advance(s): StepResult                                              // re-runs the script over recorded answers
validate(s, requestId, decision): ValidationResult                  // pure; no state change
answer(s, requestId, ans: Answer): StepResult                       // buffers only: events=[] until the group closes;
                                                                      // on close: re-run applies it in canonical order
lockOpen(s): boolean                                                // spectator lock (§9.1)
StepResult = { state; events: EngineEvent[]; open: DecisionRequest[]; status: 'awaiting'|'over' }
EngineState = { cfg, answers: Record<requestId, Answer>, emitted, group, status, result, humanSeats, humansAlive, humansPending, started }
```
- **Purity.** The engine never reads a clock, never does I/O, and never uses randomness except the RNG stored in its state.
- **Rejected submissions have no effect.** Answers that fail `validate` never reach `answer()`, never change state and are never stored in `decisions`. They are logged in `llm_calls` or `human_submissions`.
- **The engine allocates all IDs.** `internalRequestId` and `groupId` come from counters kept inside the engine state, so replay reproduces them. The engine emits `REQUEST_OPENED` and `REQUEST_CLOSED` with `vis: seats:[seat]`, never public. Spectators see them after the lock opens. **The single exception** is addressee 0 (host requests, post-game only), which uses `vis: public`. Those requests take no `pseq` (the Projector skips `REQUEST_*` when numbering) and never enter any context.
- **Host inputs are engine inputs.** Any host choice that changes engine events is a `DecisionRequest` addressed to the pseudo-seat `host` (seat 0), and it is stored in `decisions` like every other answer. Today the only one is `debrief_accept` (accept/decline). Replay therefore reproduces the debrief exactly. Pause, abort, cap and remap never change engine events, so they stay meta.

### 5.2 Groups and canonical application order (determinism)
- Every request belongs to a group. A lone request forms a group of one.
- `answer()` **buffers** the answer. When every request in the group has an answer, the engine applies them all in **canonical order**:
  1. all `decision` answers, in ascending seat order (for night steps: step order, then seat);
  2. then all `no_answer` answers in ascending seat order. Their fallbacks draw from the RNG. A fallback that depends on others (council ballot plurality) sees **only real `decision` answers**, never other fallbacks' results. If there are none, it uses the seeded random rule.
- **Event emission is independent of answer type.** After a group is applied, its public events (for example `VOTE_CAST`) are emitted in ascending **seat order**, whether each seat answered or fell back. The event order never reveals who timed out.
- Arrival order therefore never affects state, events or RNG use.

**Groups**

| Group | Contents |
|---|---|
| **Parallel** | day ballot, runoff ballot, Sheriff ballot, council ballot; night steps 7–10 (Protector, Seer, Fox, Little Girl), which don't read each other; debrief round 1 |
| **Sequential** (one request per group, in order) | speeches, rebuttals, defences, last words, council turns, channel messages, **Sheriff candidacy** (ruleset §9.1, speaking order), night steps 1–6 and 11–17, dying actions, debrief round 2 |

`decisions.apply_order` (§10) records the canonical order that was used.

### 5.3 Phase machine
```
Setup → Night(k){ step providers by order } → Dawn(k){ attacks→knight→curse→bans(5b)→batch→queue→public notices→private notices(8)→winCheck }
      → Day(k){ sheriff?(Day 1 only) → discussion(r) → rebuttal → ballot → runoff? → execution → winCheck → judgeVote? }
      → Dusk(k){ angel, clears, stall, winCheck, summary, termination } → … → Over → DebriefOffer → Debrief?
```
- Implemented as a plain script (`game/script.ts` → `night.ts`, `day.ts`, `deaths.ts`, `win.ts`). The script's call stack plays the role of the cursor. Any state is resumable, because `(config, answers)` fully determines the re-run.

### 5.4 Step providers and role plugins
**Night step providers.** Anything that can act at night registers a provider:

```ts
interface NightStepProvider {
  order: number;                       // ruleset §7.2 step number (unique; registry test)
  parallelBand?: string;               // consecutive active providers sharing a band open ONE parallel group
                                       // (band "n7_10" = Protector, Seer, Fox, Little Girl)
  id: string;                          // 'thief','cupid','lovers_intro','pack_council','charmed_reveal',…
  isActive(s: EngineState): boolean;   // e.g. Wolf-Father: alive && uses.infect>0 && V!=null
                                       //      BBW: alive && powers && !wolf_has_died
                                       //      Sisters: both alive && powered
                                       //      Charmed reveal: piper alive && powered && team==='Piper'
  run(s): StepResult;                  // may open requests / sub-conversations
}
```
Non-role steps are providers too: Lovers intro (4), pack council (11) and Charmed reveal (18).

**Role plugins:**
```ts
interface RoleDefinition {
  id; startingTeam; wolfNature; unique; weight; cardCount?: 1|2; initialUses?;
  nightSteps?: NightStepProvider[];
  hooks?: Partial<RoleHooks>;
  prompt: { explainKey };
}
```

`RoleHooks` lists the complete set of extension points. **Everything else is core** (the win table, parity, absorption order, batch closure, FIFO queue, tally). Lovers re-evaluation is implemented by the Cupid plugin through `afterBatch` and `onTeamChange`.

| Hook | Call site | Used by |
|---|---|---|
| `absorbAttack(s, target, attack)` | Dawn §8.1, after the Protector check | Elder |
| `onPlacedAttackDeath(s, victim, attack)` | Dawn §8.2 steps 1–2 | Knight curse placement (evaluated after step 4) |
| `curseContribution(batch)` | batch step 3 | Elder |
| `deathTriggers(s, seat, batch)` | batch step 5 enqueue | Hunter, Scapegoat ruling |
| `onModelDeath(s, deadSeat)` | batch step 5 enqueue | Wild Child |
| `onExecutionTarget(s, seat)` | execution step 1 | Village Idiot |
| `unresolvedTie(s)` | runoff tie | Scapegoat |
| `voteWeight(s, voter)` | tally | Sheriff title |
| `scoreBonus(s, candidate, ballotKind)` | tally | Raven |
| `ballotFlags(s, voter)` | ballot schema | Stuttering Judge (`second_vote`) |
| `afterFirstExecution(s)` | Day flow injection | Stuttering Judge |
| `dawnPublicNotice(s)` | Dawn step 7 | Bear Tamer, Raven |
| `parityBlocker(s)` | §4.3 | Witch poison, Hunter, Raven, Sheriff, Judge, Knight curse pending |
| `onTeamChange(s, seat, change)` | after any team change | Cupid (re-evaluation), Piper (power off) |
| `afterBatch(s, batch)` | batch step 5 enqueue | Cupid (re-evaluation, and reversion when both Lovers are dead) |
| `duskTransition(s)` | Dusk step 1 | Angel |
| `detectionLabel(s, target, mode)` | Seer/Fox result | infected, Wild Child, Wolf-Hound labels |
| `deckConstruction(cards, rng)` | Setup | Thief (constructive deal, ruleset §6) |

- The **Sheriff** is a title module that uses the same hooks.
- **Registry tests** check:
  - every ruleset §10 role is registered;
  - the weights match ruleset §12;
  - each step order is unique;
  - each hook call site in the core is covered by at least one scenario test.

### 5.5 Text utilities (deterministic)
- **Word counting:** the words are the matches of `/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu`. Truncation keeps the text up to the end of word *n* and appends "…".
- **Sanitisation** (ruleset §14.6) runs in the engine when the decision is applied, so the stored events contain only clean text. It uses NFKC normalisation, strips invisible `Cc`/`Cf` characters (keeping ZWJ), folds bracket look-alikes, and strips spoofed tags, role prefixes and chat tokens until the text stops changing. It then masks model names longest-first.
- Both algorithms are part of `engineVersion`. Unicode tables are pinned by the Node major version.

### 5.6 Determinism and replay
- **Game identity** = `(engineVersion, GameConfig, seed, decisions ordered by apply_order)`.
- **Replay** feeds the stored answers group by group, and must reproduce `engine_events` byte for byte. A CI test checks this on the simulation corpus.
- `meta_events` are excluded from replay.

---

## 6. `projector` and `context`: Projector and ContextBuilder

### 6.1 Projector
`project(engineEvents, viewer, lockOpen, frozenConfig) → View` is pure and shared with the browser. The frozen config supplies the slot→seat→model mapping for spectators. `reduceView` lives in `projector`, and `client-sdk` re-exports it.

| Viewer | Receives |
|---|---|
| seat | `public` events, plus events whose `seats` list contains that seat |
| public | `public` events only |
| spectator | every event, but only when `lockOpen`; before that it gets the public view |

- **Per-viewer sequence.** Each viewer's entries are numbered with a contiguous `vseq`. Clients never see `eseq`, so gaps can't reveal hidden activity.
- The spectator view adds the slot→seat→model mapping from the frozen config once the lock opens.
- **Night granularity** (ruleset §7.1). The engine emits exactly **one public** `PHASE_START{night:k}` per night. Night sub-step markers (`NIGHT_STEP_START`) are emitted with `vis: spectator`, so they consume no `pseq` and cannot leak through public numbering. In seat views, `at.step` is removed from every entry. Seat-addressed night entries (Seer results, channels) keep only `{night:k}`.

### 6.2 ContextBuilder (ruleset §14.2 layers, cache-friendly order)
Messages are built in this order:

| # | Layer | Contents | Stability |
|---|---|---|---|
| 1 | `system`: L0 | Rules digest for this composition, truth/injection/output policy | **Identical for every seat** (no name in it), constant all game |
| 2 | L3 | Public transcript (JSON array numbered by **`pseq`**: speaker, text, lean, claim, engine entries) | Append-only and byte-identical for every seat at a given moment |
| 3 | L2 | Public state (JSON) | Changes per call |
| 4 | L1 | Role card, **including the seat's display name** | Changes per call |
| 5 | L4 | Private log | Changes per call |
| 6 | L5 | Notebook | Changes per call |
| 7 | L6 | Task: the kind, the legal options as an enumerated list, limits, remaining rounds, a JSON-only instruction containing the word "JSON", and the schema | Changes per call |

**Caching.**
- L0 + L3 form the longest stable prefix, identical across all seats.
- L3 is sent as **one content block per day**. Blocks for finished days never change.
- For providers that need explicit breakpoints (Anthropic models via OpenRouter), the builder adds `cache_control: {type:'ephemeral'}` in two places: on L0, and on the **last closed day's** L3 block. That uses 2 of the 4 allowed breakpoints.
- Others cache automatically or not at all. Correctness never depends on caching.

**Token budget (per game, not per model; whole context).**
- **Window.** At game creation: `window = min contextLength over the game's profiles (incl. fallback aliases)`, `outputReserve = max over profiles of max_tokens` (visible + reasoning), and `inputBudget = window − outputReserve − 1 000` (safety margin). All three are frozen into the config.
- **Per-layer caps.**

  | Layer | Cap |
  |---|---|
  | L0 | measured when the pack loads; must be ≤ 15% of `inputBudget`, or the lobby rejects the game |
  | L5 | ≤ 250 words (rule), budgeted as a fixed 500 tokens |
  | L6 | ≤ 1 500 tokens |
  | L1 | ≤ 800 tokens (fixed) |
  | L2 | ≤ 10% of `inputBudget` (hard) |
  | L4 | ≤ 15% of `inputBudget` (hard) |
  | L3 | `L3cap = min(rules.transcript_token_budget, inputBudget − L0 − L1cap − L2cap − L4cap − L5cap − L6cap)`, a single **fixed number per game**, computed from caps only and frozen into the config |

  Estimates use one fixed conservative ratio of 3.0 chars/token for every seat.
- **Compression order** when a layer is over its cap:
  - **L3:** replace the oldest days with the engine digest. This is applied to **every** seat for the same days, so transcripts stay identical (ruleset principle 0.6). If the last two days alone still exceed the cap, the older of the two is digested as well. The current day is always kept verbatim.
  - **L2:** past vote tables older than 2 days collapse to "day d: X executed (votes a–b)". If L2 is still over its cap, the oldest collapsed lines are dropped (the dead/alive list and revealed roles are always kept).
  - **L4:** channel and council transcripts older than 2 nights are digested to their final outcome (target chosen, messages count). If the layer is still over its hard cap, ability results older than 2 nights take a compact form (`N3 Seer: Bram=wolf`). After that, the oldest digested entries are dropped until it fits.
  - L2 and L4 compression is **per seat and local**. It never affects any other seat's context.
- **No cross-seat coupling.** How deep L3 is digested depends **only** on the public log and the frozen `L3cap`, so it is identical for every seat and reveals nothing. Because every layer has a hard cap, the sum of the caps is at most `inputBudget` by construction. The builder only **asserts** this (a test-time and runtime invariant) and never loops.
- **Debrief context.** It has the same `inputBudget`, filled in this order until full:
  1. roles and result;
  2. night actions, compact form, oldest dropped first;
  3. own thoughts, most recent kept first;
  4. the transcript, digested oldest-first.

  Every step truncates deterministically.
- The lobby rejects any profile whose `contextLength` is below `app.json.minContextTokens` (default 32 000).

**Prompts are data.** The prompt pack is stored **by content** in `prompt_packs`, keyed by hash, when a game starts. A running or resumed game always uses its own stored pack, whatever is on disk.

**Anonymity.** No model or provider names appear in any context. The list of names to mask in player text (ruleset §14.6) is frozen into `GameConfig` at game start, not read from the live catalogue, so replay is unaffected.

**L4 sources.** L4 holds seat-addressed events of these types:
- ability results;
- channel and council messages;
- private notices (infection, conversion, Lovers, charm, catch);
- `SEAT_THOUGHTS` is **not** in L4, because it feeds L5 only.

`REQUEST_*`, `FALLBACK_USED` and meta events never enter any context.

**Debrief context** (ruleset §15b). The Projector has a viewer `{kind:'debrief', seat}`: every engine event, minus `SEAT_THOUGHTS` whose seat is not self, minus `REQUEST_*`. Its messages, in order:
1. `system`: the debrief template (fun, reflective, at most 120 words, JSON `{comment}`).
2. The final result and every role and team.
3. The full public transcript (L3 format).
4. The night-actions log.
5. The seat's own thoughts across the game.
6. The task.

---

## 7. `llm` — OpenRouter integration and model switching

### 7.1 Model profiles (`config/models.json`)
```jsonc
{ "profiles": [ {
  "alias": "sonnet",                              // used by slots, rosters, CLI
  "openrouterId": "anthropic/claude-sonnet-5",    // exact OpenRouter slug
  "label": "Claude Sonnet 5",
  "enabled": true,
  "params": { "temperature": 0.8, "top_p": null },
  "maxOutputTokens": 700,                         // visible output budget (JSON answer)
  "reasoning": { "enabled": false, "style": "max_tokens", "effort": "low", "maxTokens": 2000, "exclude": true, "mandatory": false },
  "structuredOutput": "auto",                     // auto | json_schema | json_object | prompt_only
  "provider": { "order": [], "allow_fallbacks": true },
  "attemptTimeoutMs": 60000,                      // default only; pinned per game (§7.1)
  "maxConcurrency": 4,
  "cacheControl": "auto"                          // auto | anthropic | none
} ] }
```
- **Reasoning models.**
  - The profile field `reasoning.style` (`"max_tokens"` | `"effort"`) sets what is sent. The default comes from the profile, and the examples in `models.json` document it per family:
    - Anthropic, Gemini and Qwen-style models use `max_tokens`.
    - OpenAI o-series and GPT-5-style models use `effort`.
  - With `style = max_tokens`, the request sends `reasoning: {max_tokens: reasoning.maxTokens, exclude}` and `max_tokens = maxOutputTokens + reasoning.maxTokens`, so the answer keeps its own `maxOutputTokens`.
  - With `style = effort`, OpenRouter derives the reasoning share from `max_tokens`, so the answer is **not** guaranteed room. The request therefore sets `max_tokens = maxOutputTokens / (1 − effortShare)`, where `effortShare` is 0.8 for high, 0.5 for medium and 0.2 for low. A truncated answer still goes through the normal repair.
  - `exclude` hides the reasoning text, but it is **still billed**, and CostGuard reserves for it.
- **Mandatory reasoning.** Some models always reason. (2026-10-22: gemini-pro, and deepseek-flash, qwen-flash, glm-flash and mimo-flash, which think by default: with no budget sent and 1400 output tokens, their thinking used the whole output on long Day 2 prompts and the answer came back empty or cut off; stored games had 88 such calls. They now send `reasoning.max_tokens` 2000, `max_tokens` 3400. A sign of a missing flag: `completion_tokens` = `reasoning_tokens` = `max_tokens` in `llm_calls`.) A profile marks this with `"reasoning": {"mandatory": true, …}` (profile field only). For `style = max_tokens` models, the reasoning budget is **always** added to `max_tokens` and to the cost reservation, even when reasoning is "disabled". For `style = effort` models, the derived `max_tokens` already covers everything (nothing is added on top), and "disabled" means `effort: low`. The parser also strips `<think>…</think>` blocks and any reasoning prefix before looking for the JSON.
- **Same treatment (ruleset principle 6).** `attemptTimeoutMs` and `maxOutputTokens` in a profile are only defaults. At game start, the orchestrator **pins one value per game** for every seat: the maximum across the game's profiles. `reasoning`, `temperature` and provider routing stay per profile, because they are part of what "a model" is.
- **Rosters** (`rosters.json`) are named alias lists. The lobby can fill slots from a roster in order, shuffled, or round-robin.
- **Hot reload.** The registry and rosters are re-read on file change. Lobbies see the changes at once. A running game keeps the **profile copies** in its frozen config.

### 7.2 Catalogue
- `GET /models` is cached in the `model_catalog` table with a timestamp. It fills in `contextLength`, `pricing` (prompt, completion, per-request, `internal_reasoning`, cache read/write) and `supported_parameters`.
- **Per-provider prices** come from `GET /models/{id}/endpoints`, cached the same way. The CostGuard uses the **maximum** across the endpoints the profile may route to.
- **Routing price ceiling (owner rule, 2026-10-21).** A model is never routed above its maker's own price: `routingCap` (`packages/llm/src/catalog.ts`) sets `CatalogEntry.priceCap`, sent on every request as OpenRouter's `provider.max_price` (USD per million tokens; a request no endpoint can satisfy gets a 404 "No endpoints found that satisfy the max price"). (1) The maker hosts the model at its list price (every closed model) → that price, so premium tiers ("fast", "ultrafast", "priority") and resellers priced above the maker are never used (a reseller at the maker's own list price stays allowed); (2) the maker hosts it at another price (open-weight models whose list price is a cheaper host) → the maker's price; (3) the maker does not host it → the component-wise maximum of the 3 cheapest endpoints (by input + output price), so at least 3 endpoints stay usable (they may belong to the same company, and a premium tier priced inside that maximum is allowed). A 404 "satisfy the max price" is a `bad_request`, never an output-mode downgrade. If the endpoint list cannot be fetched, the cached ceiling is used. The guard's pricing is the maximum under the ceiling, so reservations are realistic (GPT-6 Astra: $50/M output instead of its "ultrafast" tier's $300/M). Cheaper endpoints stay allowed; OpenRouter's default routing already favours them. The cache keeps the list price, the guard price and the ceiling; an entry cached before this rule has no ceiling and keeps the old maximum over every endpoint.
- "Mandatory reasoning" is a **profile field only**, because the catalogue does not expose it.
- **Refresh:** at startup, and on demand with `ww models check`.
- **Offline:**
  - With a stale cache, it is used and a warning is shown.
  - With no cache, a profile may still run if it declares `contextLength` and `pricingOverride` itself. `structuredOutput: auto` then resolves to `prompt_only`.

### 7.3 OpenRouterClient (implements `LLMProvider`)
- **Newest Claude models (2026-10-15).** Claude Opus 5.5 and Fable 5.1 broke in a real game; three things are handled now:
  - **Unsupported sampling parameters are never sent.** A profile's `temperature`/`top_p` that the catalogue entry does not list is dropped from the first call (`unsupportedParams` in `llm-controller.ts`). OpenRouter answers such a request with "No endpoints found that can handle the requested parameters", which names no parameter, so dropping it only after the error did not work.
  - **Claude gets the schema in `anyOf` form.** Anthropic's structured outputs reject a type list next to an enum (`type: ["integer","null"]` with `enum: [1,3,null]`). For `anthropic/` models every type list becomes `anyOf` branches with their own enum values (`anyOfSchema` in `request.ts`); other models keep the original schema.
  - **Gemini gets all-text vote options (2026-10-21).** Google's structured outputs reject an enum that mixes numbers and text ("Request contains an invalid argument"), so every Gemini vote (`enum: [1, 3, "abstain"]`) failed and fell back to the engine. For `google/` models such an enum is sent as text (`"1"`, `"3"`, `"abstain"`; `textEnumSchema` in `request.ts`); `normalizeDecision` turns seat numbers written as text back into numbers. Checked live: the failed vote, rebuilt, is answered. (The schema printed in the prompt still shows numbers; the enforced one wins, and both answers are accepted.)
  - **Claude Opus 5.5 and Fable 5.1 refuse strict json_schema (2026-10-21).** Anthropic now blocks our schema-forced requests for these two models with finish reason `content_filter` ("reverse engineering or duplicating model outputs"), with old and new prompts alike; a tiny schema, `json_object` mode and no `response_format` all pass; Haiku 4.5 and Sonnet 5 are unaffected. Their profiles use `structuredOutput: "json_object"` (every answer is still validated against the schema and repaired). Safety net in `llm-controller.ts`: a `content_filter` refusal **in json_schema mode** steps the seat down to json_object (a `SEAT_DOWNGRADE`, like an unsupported `response_format`) and the request is sent once more in that mode; that retry is the decision's one repair (ruleset §14.5). (Superseded the same day: a further refusal is now retried in the other wording, see below, and a refused call is charged $0.) Evaluator 9.1/10; its points applied.
  - **`inner_voice` instead of `reasoning` (2026-10-21).** Claude Opus 5.5 refused every request (in every output mode) while the prompt asked for a `reasoning` field; bisection on real requests showed the field name, and for wolves the instruction to write a plan, were the trigger. The models are now asked for `inner_voice` (the owner's idea and game-only definition: the character's inner voice about the game, shown to viewers as part of the story; `schema.ts`, `prompts/output.md`, `prompts/system.md`, `prompts/reasoning/*.md`), and the role guidance describes how the character plays rather than a plan to write. `normalizeDecision` stores it as `reasoning` (SEAT_THOUGHTS, the video pipeline and replays unchanged) and still accepts `reasoning`.
  - **Two wordings with a refusal fallback (2026-10-21).** Claude Fable 5.1 then refused every `inner_voice` request, while Opus refuses some `thoughts` ones, so one wording cannot serve both. The pack holds `prompts/reasoning/*.md` (`inner_voice`) and `prompts/reasoning/thoughts/*.md` (`thoughts`), each with a `rule.md` line for the system prompt (`{{thoughts_rule}}`, `{{thoughts_field}}` in `system.md` and `output.md`); `buildContext({ wording })` builds one consistently (system prompt, guidance, schema field). `LLMController`: a `content_filter` refusal first steps json_schema down to json_object (as before), then rebuilds the request in the other wording and sends it once more; the model (profile alias) keeps the answered wording for all its seats (in memory; relearnt after recovery at the cost of one free refusal). These refusal retries (at most two) take the place of the decision's one repair; a failure of one ends the decision with the repair spent. A step-down is kept even when the wording was the real trigger (json_object works for every model). Packs frozen before this (stored per game, used on resume) have one wording, written into their own `system.md` and `output.md`: `wordingsOf` reads it ("reasoning", or "inner_voice" that morning) so the schema field matches the text. The field description is the same in both wordings: it is part of the texts that passed live tests. `callModel` charges $0 for a refusal with no usage and no text, before any generation lookup (OpenRouter does not bill it and its generation record has no cost); charging the reservation made refusals eat the cost cap.
  - **Plain language (owner, 2026-10-21).** The models used jargon viewers don't know ("mislynch", "town read", "parity"). `prompts/system.md` now has a short "Plain language" section: everything players write (speeches, pack messages, last words and `reasoning`, which the videos voice) in plain, everyday English, with examples. It changes the prompt pack's hash: new games use it, and a game resumed with `ww resume` keeps its stored pack. (Server crash recovery, `recoverAll` in `packages/server/src/gateway.ts`, still uses the pack on disk, as it did before; recovered games just get the plainer wording.) A second section, "Talk like a player, not an analyst", asks for direct accusations, defences and pointed questions, natural feelings, and talk about people and behaviour rather than mechanics (it deliberately says nothing about naming or addressing players: an earlier naming instruction coincided with Claude refusals). `prompts/tasks/discussion.md` recommends speeches of about half the word limit; the limit itself (`words.speech`, 120) is unchanged, so longer speeches are still allowed.
  - **The prompt no longer calls `reasoning` a private inner monologue.** The newest Claude models block a prompt that asks for a hidden stream of private thoughts (an empty answer with finish reason `content_filter`, before any token is written). The field and what it does are unchanged: it comes first, other players never see it and viewers read it after the game (`prompts/system.md`, `prompts/reasoning/*.md`, the schema description).
- It sends `POST {baseUrl}/chat/completions` with `Authorization: Bearer $OPENROUTER_API_KEY`, the optional `HTTP-Referer`/`X-Title` headers, and the body field `usage: {include: true}`.
- **Cost:**
  - read `usage.cost` from the response;
  - if missing, `GET /generation?id=` (up to 3 tries, 1 s apart);
  - if still missing, estimate from the catalogue price with the highest-priced provider.

  The row records which source was used.
- **Timeouts:**
  - Each **attempt** gets its own timeout (`attemptTimeoutMs`, enforced with `AbortController`).
  - The clock starts **after the concurrency slot is acquired**. Time spent in the queue is logged separately and never counts against the model.
  - A decision may take at most `1 + transportRetries` transport attempts for the initial call, and the same again for the repair call (ruleset §14.5).
  - **Timeout semantics.** An attempt timeout counts as a **transport failure**, so it uses up one of the transport retries. The next attempt is the same call again.
  - If **every** transport attempt of the initial call fails (timeout or provider error), the ruleset §14.5 **repair** step runs as one fresh call. It uses the same context plus the note "Your previous answer was not received. Answer now." It has its own transport attempts.
  - **Ceiling.** Every decision has one hard ceiling, `decisionCeilingMs` (default 300 s). It is measured from the **first slot acquisition**. Time spent waiting in the queue before that never counts, and neither does queue time between attempts.
  - The natural maximum of `2 × (1 + transportRetries) × attemptTimeoutMs + backoff` is **clipped** by that ceiling.
  - **Budget split.** The initial call may use at most 60% of the ceiling, and whatever remains is guaranteed to the repair call.
  - When the ceiling is hit, the answer is `no_answer{timeout}`.
  - Timeouts caused **only** by the server's own queue are impossible by construction, because queue time is excluded.
- **Transport retries** (`app.json.transportRetries`, default 2) apply to 429, 5xx and network errors. They use exponential backoff with jitter, and `Retry-After` is honoured up to 20 s.
- **Unsupported parameter** (a 400 naming a parameter, or a **404 "no endpoints found"** caused by `require_parameters`). The client steps down the structured-output modes (`json_schema` → `json_object` → `prompt_only`), or drops the named parameter, and retries once. It records a **per-game downgrade** in memory and in the `SEAT_DOWNGRADE` meta event. Every later call for that seat applies the downgrade. The frozen snapshot is never mutated.
- **Logging:** the `llm_calls` row is **inserted with status `sent` before the request goes out** (§9.4), and updated on completion.
- **The key stays on the server.** It lives only in env vars, is redacted from logs, and is never sent to clients.

### 7.4 Structured output and parsing
- For every request, the builder derives a **per-request strict schema** from the decision's zod schema:
  - legal targets become `enum`s;
  - every property is listed in `required`;
  - optional fields become `type: [T, "null"]`. For enum fields, `null` is also added **inside** the `enum` list;
  - `additionalProperties: false`;
  - no unsupported keywords (`minLength` etc. are enforced by zod after the call instead).
- **Mode resolution:**
  - **auto:** `json_schema` (strict) if the catalogue lists `structured_outputs`; else `json_object` if it lists `response_format`; else `prompt_only`. The L6 task always includes the schema and the word "JSON".
  - A `provider.require_parameters: true` flag is added when `json_schema` is used, so OpenRouter only routes to providers that honour it.
- **Parser:** take the first balanced JSON object in the reply (after stripping code fences), then validate with zod, then run `engine.validate`.
- **Failure:** one repair call. It sends the invalid answer and the issues back to the model, together with the legal options. If that also fails, the answer is `no_answer{invalid}`.
- **Over-limit text** is truncated by the engine and is not an error.

### 7.5 CostGuard
- **Per-game ledger:** `spent` (actual) + `reserved` (in flight).
- **Reservation per call** = `promptTokensEst × max(promptPrice, cacheWritePrice) + maxOutputTokens × maxCompletionPrice + reasoning.maxTokens × max(maxCompletionPrice, internalReasoningPrice) + perRequestFee`. Maximum prices are taken across the model's providers.
- **Reasoning budget.** Anthropic and Gemini models get an explicit `reasoning.max_tokens`. With `effort`-style models, OpenRouter derives the reasoning budget from `max_tokens`, so the reservation is `max_tokens × max(completionPrice, internalReasoningPrice)` for the whole output. `outputReserve` (§6.2) is computed **after** per-game pinning of `maxOutputTokens` (§7.1).
- **Check:** before issuing a call, if `spent + reserved + reservation > cap`, the call is **not issued** and the game enters **pause** (§9.3, reason `cost_cap`). The check and the reservation are made atomically, which is trivial in single-threaded Node.
- When a call completes with a known cost, its reservation is released and the actual cost is added. Any attempt that **timed out, was aborted, or has no cost and no generation ID** is charged its **full reservation**, because the provider may still bill it upstream. The `cost_source` for those is `reserved`.
- `ww stats reconcile` optionally re-queries `/generation` for rows that have a generation ID, and corrects `spent` after the fact.
- A **warning** fires at 80%. While the lock is closed it is delivered at the next Dawn or Dusk boundary, like the other cost figures.
- **The host can:** raise the cap and resume, or abort the game.
- **Pre-flight estimate** in the lobby: a range based on calls per phase (ruleset §16), token averages from past games (the `llm_calls` history for each profile, with defaults when there is none) and catalogue prices.

---

## 8. Configuration

| File | Content |
|---|---|
| `app.json` | `port`, `bindAddress` (LAN), `hostFromLocalhost`, `dbPath`, `disconnectMaxMs`, `decisionCeilingMs`, `defaultFallbackAlias`, `defaultCostCapUsd`, `globalConcurrency`, `transportRetries`, `minContextTokens`, `logPrompts`, `revealDelayMs`, `providerFailureThreshold` (§9.5), `pauseOnAllHumansDisconnected`, `disconnectGraceMs`, `debriefOfferMs`, `effortShare` (`{low:0.2, medium:0.5, high:0.8}`), `openrouter.{baseUrl, referer, title}` |
| `rules/default.json` | every ruleset §14.8 key, plus the §14.4 limits. Values that depend on the table size use sentinels, resolved after layering once N is known: `"sheriff_enabled": "auto"` (true if N ≥ 7), `"max_days": "N"`. |
| `compositions/*.json` | `{id, label, seats, cards, ruleOverrides?}`, validated against ruleset §12.1 at load time |
| `models.json`, `rosters.json` | §7.1 |
| `names.json` | the display-name pool |

- **Layering:** `rules/default.json` (must be complete; there is no separate code-defaults layer) `< composition.ruleOverrides < lobby overrides`. After layering, the whole config is validated again, including cross-field rules (slots = composition size, Bear Tamer ⇒ `reveal=full`, contextLength ≥ minimum).
- **Startup validation.** An invalid file stops the server, and the error names the exact JSON path.
- **Frozen snapshot at game start:** stored in `games.config_json`. It contains the resolved rules, the composition, slots (controller type, a profile **copy**, `fallbackAlias` copy, human name), the budget values `window`, `outputReserve`, `inputBudget` and `L3cap`, the pinned `attemptTimeoutMs` and `maxOutputTokens`, `effortShare`, the name-mask list, `promptPackHash`, `engineVersion` and `seed`.

---

## 9. `server` — lobby, orchestrator, gateway

### 9.1 Principals and sessions
- **Host.** Proves itself once with `HOST_TOKEN` from `.env`, or automatically from localhost if `app.json.hostFromLocalhost` is true.
- **Seat.** Each human slot has a **one-time join link** (`/join/<random 128-bit token>`). Opening it trades the token for an **HttpOnly, SameSite=Strict session cookie** bound to that slot, and the token is burned. The host can revoke a seat session and reissue a link **only while that slot is disconnected**. At first join, each human sees a private 6-character **rejoin code**. While the lock is closed and the game has **any** human seat, a reissue **always** requires that code, which the human gives to the host. The server cannot know whether the host also plays on another device. A human who lost the code stays **away** (immediate fallbacks) until the lock opens. The reissue is announced to the slot's previous session if it ever reconnects, and logged as a `LINK_REISSUED` meta event.
- **Spectator.** Uses a spectator link, which gives a cookie session.
- The WebSocket authenticates with that cookie, never with a query-string token.
- **Origin check.** The WS upgrade and every mutating REST call require an `Origin` header matching the server's own host:port. This blocks cross-site WebSocket hijacking and CSRF.
- One browser may hold **host + seat** at the same time. That is **host-player mode**.
  - They are separate cookies: `ww_host`, and `ww_seat_<gameId>`.
  - A single WS connection authenticates with every cookie it carries, and becomes a **multi-principal socket**.
  - Each server→client message is tagged `scope: 'host'|'seat'|'spectator'`.
  - Each client→server message must name its scope. `submit_decision` and `notes_update` require `seat`; `host_command` requires `host`. A message whose scope is not held by the socket is rejected.
- The LAN is plain HTTP. The README states the trust assumption and offers an optional self-signed HTTPS mode. The server binds to the LAN only, and the README warns against port-forwarding.

**Host-player mode and hidden information.** While `!lockOpen`, the host gets **host-safe** data:

| Data | Host-safe behaviour |
|---|---|
| Cost | Shown only at the Dawn and Dusk boundaries, rounded to 5% of the cap. Pause notices are immediate. |
| Game list and summary | No slot→seat→model mapping, no roles, no per-seat costs |
| Lobby after start | Shows slots, not seats. The seat mapping is hidden. |
| `GET events?view=spectator`, `llm_calls` bodies, SEAT_THOUGHTS | 403 until the lock opens |

Every REST handler and WS channel checks the **same** `canSeeHidden(game)` function, and it is covered by tests.

**Other channels that could leak to a host-player:**
- **Stats** (§11.1) aggregate only finished or lock-open games. The `ww stats` CLI follows the same rule.
- **Console logs** at info level are host-safe while any running game's lock is closed. They contain game ids, public phase changes (one line per Night, no sub-steps) and errors without seat, kind or profile. **Cost appears only at Dawn and Dusk, rounded to 5% of the cap**, the same rule as `host_status`. Full detail (seat, kind, profile, latency, per-call cost) goes to `logs/detail-<gameId>.log`.
- **The lobby pre-flight estimate** uses token averages from `llm_calls` of games that are `over` or have their lock open, the same rule as stats.
- **Test:** every read path derived from `llm_calls`, `requests`, `decisions` or the detail logs goes through `canSeeHidden` or the finished-games filter. A registry of data sources is checked by a test.
- Direct inspection of the DB or log files by the host is an **honour rule**, and the README says so.

**Spectator lock** (ruleset §15): a single pure predicate, `lockOpen(state)`, lives in the engine package (it also counts dying actions still queued for a dead human):

`lockOpen = gameOver || (cfg.dead_human_spectates && no human seat is alive && no human dying action is pending)`

With zero human seats, it is true from the start. Once true it **never closes**: the orchestrator latches it in `games.lock_open`.
- **Host-safe mode** is exactly `!lockOpen`.
- `canSeeHidden(game) = lockOpen`. It is the same for every principal. A seat principal additionally sees its own seat view.
- **REST scope.** Endpoints marked "any" require an authenticated principal (host, seat or spectator cookie). `GET /api/games/:id/view?scope=seat|spectator|public|host`, where `host` gives the host-safe public view plus the host status picks which of the caller's principals to use. If that scope isn't held, the request is rejected.
- When it opens, the orchestrator emits `LOCK_OPENED`. Every connected client then receives a new `hello` snapshot.
- Before the lock opens, a dead human sees the public view plus their own seat's history.

### 9.2 LobbyService
- A lobby covers: composition, slot list (`ai{alias}` / `human{name}` / `bot`), roster fill, rule overrides, cost cap, pre-flight estimate.
- **Custom game (v2.6, ruleset §6 "the host's own deal"):** `manualDeal {roles, extras?}` in the draft (`null` = dealt at random). `POST /api/lobbies {manual: true}` starts it from the mode's cards (with a Thief, the Thief, the Sisters and one wolf first, so the extras are legal). Every create and patch checks it with `manualDealProblem`: exactly the composition's cards, one per slot, two extras with a Thief, and the Thief, both Sisters and a wolf never among the extras. Changing the composition restarts the deal from the new mode. At start, `buildGame` freezes `cards` in slot order (extras last) and `game.manualDeal: true`; the engine's setup then seats slot *i* at seat *i* with card *i* and shuffles only the names. The public `GAME_START` composition stays sorted, and the draft (models, people and now roles) is sent to the host's socket only.
- **Lobby WS channel:** `lobby_state`, `slot_updated`, `human_joined{slot}`, `human_left{slot}`, `estimate`.
- **Start conditions:**
  - All human slots must be connected.
  - The host can **force-start** instead. Each unconnected human slot then becomes an AI profile chosen by the host (default: the lobby's first AI alias) or a bot.
  - A forced start is logged as `FORCED_START`. `games.has_bot` is set only if at least one slot actually became a bot. Games with any bot seat are excluded from model statistics.

### 9.3 GameOrchestrator
**Loop (per game):**
1. `advance()` runs. `REQUEST_OPENED` is emitted **by the engine**. Before the commit in step 4, the orchestrator allocates a `clientRequestId` for each new request, so it is written in the same transaction.
2. **Dispatch.** A request is dispatched only if it has **no `decisions` row and no live in-flight call**. The orchestrator keeps an in-memory `inFlight: Map<internalRequestId, AbortController>`. That guarantees at most one live dispatch per request at a time.
   - An answer that arrives for a request which already has a decision row is **dropped** as a late duplicate. It is still logged in `llm_calls`.
   - A human's accepted submission is acknowledged with the WS message `decision_accepted{clientRequestId}`. **Accepted submissions are final.** Later submissions for the same request are rejected with `decision_error{reason:'already_answered'}`.
3. Each answer is persisted in `decisions` **on arrival** (status `buffered`), then passed to `answer()`. **During a pause**, arriving AI answers and accepted human submissions are persisted as `buffered` but are **not** passed to `answer()`. On resume they are fed in, in canonical order, before any dispatch. Humans may submit during a pause; the submission is validated and acknowledged as usual.
4. **When the group closes,** one SQLite transaction commits all of the following:
   - the group application (`apply_order`);
   - the `advance()` run up to the next awaiting state;
   - **every** resulting engine event;
   - the new `requests` rows.

   Nothing else writes engine events. The very first `advance()` after game start is committed in one transaction, in the same way.
5. After the commit, the Projector pushes each new view entry to connected clients.

**Pause (reasons: `host`, `cost_cap`, `provider_failure`, `humans_disconnected`, `recovered`, `version_mismatch`, `corrupt`):**
- No new controller call is issued.
- In-flight AI calls are allowed to finish. Their answers are buffered and persisted.
- Human timers freeze, and their deadlines are extended by the length of the pause.
- The engine state is not touched.

**Resume** re-dispatches only requests that have **no decision row and no live in-flight call**. Calls started before the pause are never duplicated. It picks up from the persisted `attempt_state`: a request that was waiting for repair gets its repair call, which includes `last_invalid_json`. The same applies after crash recovery. An answer that arrives during a pause and needs repair is recorded as `attempt_state = repair`, and its repair call is issued on resume.

**Abort** sets the status to `aborted`. The game gets no result and is excluded from stats. `no_answer{aborted}` is never applied.
- Aborting **during a debrief** only ends the debrief. The game keeps status `over` and its result.

**Human disconnect:**
- The seat's timer keeps running for `disconnectGraceMs`, then freezes. After `disconnectMaxMs` of disconnection (default 5 min), the pending request is answered `no_answer{disconnected}`, which triggers the ruleset fallback. Later requests for that seat get normal deadlines. They fall back on timeout if the human is still away.
- **Away state.** After `disconnectMaxMs`, the seat is marked **away**. Every request to an away seat falls back **immediately** until the human reconnects. There is no further freezing.
- **"Fallback now" (host).** While the lock is **open**, the host can apply it to any pending human request. While the lock is **closed**, the host sees **no count and no identities at night** (only "night in progress"). During the Day, the host sees only the public current-turn information that every player sees. The only actions offered are:
  - "fallback for all **disconnected** humans' pending requests". **At night, this is applied at the next Dawn boundary**, never mid-night, so the timing can't reveal who had a night action.
  - during the **Day**, for **sequential public turns** (speech, rebuttal, defence, last words, dying action, Sheriff candidacy): "fallback current speaker", identified by **display name**, which is already public. There is never a slot number.
  - For sealed ballots: only "fallback **all** pending ballots". Who has not yet voted is never shown.
  - Dawn dying actions (a Hunter shot, Sheriff successor after a night death) count as public turns too.

**Cases where the fallback applies immediately, with no repair step** (ruleset §13 defers to this list):
1. seats marked away;
2. seats whose model provider has failed and have been short-circuited (§9.5);
3. host-forced fallbacks (`forced`);
4. a human request that reaches its deadline (humans may resubmit invalid answers until then, and get no repair after it);
5. the `no_answer{disconnected}` issued when `disconnectMaxMs` expires.
- If **all** humans are disconnected and `pauseOnAllHumansDisconnected` is set, the game pauses.
- On reconnect, the client gets a `hello` snapshot, including the current `pending` request.

**Debrief (ruleset §15b):**
1. At Over, the engine opens a `debrief_accept` request for the host (seat 0). The orchestrator emits `DEBRIEF_OFFERED` for the UI.
2. The host answers.
3. If the host accepts, the engine runs the debrief phase: round 1 as a parallel group, round 2 sequential. `debrief_enabled = always|never` answers the request automatically, with the automatic answer stored.
4. **Fallbacks.**
   - `debrief_accept` has a deadline of `debriefOfferMs` (default 10 min), with fallback **decline**.
   - A debrief comment has the normal decision deadlines; a human gets 360 s. Its fallback is **skip**, meaning no comment.
   - These rows extend the ruleset §13 mapping.
5. **Recovery.** A game with a pending `debrief_accept` stays in `status = over_offer` and is recovered like a running game.

### 9.4 Crash recovery
On startup, for every game in `running`, `paused`, `over_offer` or `debrief` status:
1. **Engine version check.** If `engineVersion` is not the running one, the game stays `paused{reason:'version_mismatch'}`. The host can only abort it, or export it for replay with the matching version.
2. **Rebuild the state** by replaying `decisions` that have an `apply_order`, using the frozen config (the engine never reads prompts; the stored prompt pack is loaded only for re-dispatching AI calls). Assert that the stored `engine_events` are a **prefix** of the rebuilt ones. They are normally equal, because every step is committed in one transaction. Persist any missing tail. A mismatch means corruption: the game goes to `paused{reason:'corrupt'}`.
3. **Re-buffer answers** from `decisions` with status `buffered` (arrived but not yet applied). They are **not** re-requested or paid for again.
4. **Unfinished LLM calls.** Rows in `llm_calls` with status `sent` and no completion are marked `unknown`. Their **reserved cost is charged** to `spent`, so the cap never under-counts. The request is issued again **only if** it has no `decisions` row. It continues from its persisted `attempt_state`.
4b. **Downgrades.** Per-game downgrades are rebuilt from the `SEAT_DOWNGRADE` meta events, and remaps from `seat_profiles`.
5. **Human requests** are reissued with a **fresh full deadline**.
6. The game resumes in `paused{reason:'recovered'}`. The host resumes it, so a crash loop can't burn money.

### 9.5 Provider failure: remapping a seat's model
A seat has **failed** after `providerFailureThreshold` consecutive decisions (default 3) whose final result was `no_answer` because of `provider_error` **or `timeout`**, meaning every transport attempt failed.

**When the lock is open** (no human can act, or the game is over):
- the game pauses (`provider_failure`);
- the host sees the **slot** and its alias;
- the host can remap the slot to another enabled profile, or resume unchanged.

**When the lock is closed** (humans still playing): a pause would reveal a seat's night activity and the slot→seat mapping.
- If the slot has a `fallbackAlias` (a per-slot lobby setting; defaults to `app.json.defaultFallbackAlias`), the orchestrator **auto-remaps silently** between decisions.
- **With any human seat in the game, lobby validation requires a resolvable `fallbackAlias` for every AI slot.** A failed seat is therefore always remapped silently, and the only notice is a boundary-time "a model was unavailable and was replaced" (no slot, no seat).
- With no human seats, the lock is open from the start, so the first branch applies.
- Failed decisions in the meantime use the ruleset fallbacks, as usual.

**Once a seat has failed** and has not been remapped yet, the orchestrator **short-circuits** every later request for that seat to an immediate `no_answer{provider_error}`, with no calls and no waiting. **Probe.** At each Dawn, the failed seat's **next real decision** is attempted normally (with a normal reservation and the normal context) instead of being short-circuited. Success resets the failure counter; failure keeps the seat failed. A **remap also resets** the counter. When rebuilding after a crash, failures are counted from the `no_answer.reason` inside `decisions.answer_json` (`provider_error`/`timeout`), not from `source`.

**Recovery.** The failure counter is rebuilt from `no_answer.reason` in `decisions.answer_json`, counting only decisions after the seat's latest `seat_profiles.from_eseq`. The away state is rebuilt from the `HUMAN_*` meta events. The decision ceiling of a re-dispatched request starts again at its new slot acquisition.

**Remap limits.**
- A seat is silently remapped **at most once** per game. If it fails again on its fallback profile, it is short-circuited and probed (above).
- `POST remap-seat` is rejected while the lock is closed.
- Force-started AI slots must also have a resolvable `fallbackAlias`, checked when the start happens.

**Remap targets** (including `fallbackAlias`) must have `contextLength ≥ window` and `max_tokens ≤ outputReserve` (both frozen, §6.2). This is checked when the lobby is validated and again at remap time. Profiles that fail the check are not offered.

Every remap emits a `SEAT_REMAP` meta event with `vis: spectator`. The host-safe notice ("a model was unavailable and was replaced", with no slot and no seat) is shown only at a Dawn or Dusk boundary, never mid-night. The new profile copy is stored in `seat_profiles` with an effective `eseq`.

A remapped game is flagged `has_remap`. Stats count the seat under both profiles, split by `eseq`. This does **not** affect determinism: replay uses stored answers, not models.

---

## 10. `store` — SQLite schema

The database runs in WAL mode with numbered migrations. Every group application, together with its events, is written in **one transaction**.

| Table | Key columns |
|---|---|
| `games` | `id`, `created_at`, `status` (lobby/running/paused/over_offer/debrief/over/aborted), `pause_reason` (one of the §9.3 pause reasons), `lobby_json`, `config_json`, `seed`, `engine_version` and `started_at` (these four are null only for a lobby, or a lobby aborted before it started; enforced by CHECK constraints), `paused_from` (set exactly while paused), `prompt_pack_hash`, `winner_team`, `ended_reason`, `cost_spent_usd`, `cost_cap_usd`, `has_bot`, `has_remap`, `lock_open` |
| `slots` | `game_id`, `slot`, `seat` (unique per game), `display_name`, `controller`, `human_name`, `final_role`, `final_team`, `won` |
| `sessions` | `id`, `game_id`, `principal` (seat/spectator), `slot`, `join_token_hash`, `cookie_hash`, `rejoin_code_hash`, `created_at`, `used_at`, `revoked_at`. Only hashes are stored. |
| `seat_profiles` | `game_id`, `seat`, `from_eseq`, `profile_json` |
| `engine_events` | `game_id`, `eseq`, `type`, `vis_json`, `payload_json`, `at_json` |
| `meta_events` | `game_id`, `mseq`, `wall_time`, `type`, `vis` (host_safe/host_full/spectator), `payload_json` |
| `requests` | `game_id`, `internal_id`, `client_id`, `seat`, `kind`, `legal_json`, `group_id`, `opened_eseq`, `deadline_at?`, `delivered_at?`, `attempt_state` (initial/repair/answered), `last_invalid_json?` |
| `decisions` | `game_id`, `internal_id`, `seat`, `answer_json`, `source` (model/human/bot/fallback), `repair_used`, `status` (buffered/applied), `apply_order?` |
| `llm_calls` | `id`, `game_id`, `internal_id`, `seat`, `profile_alias`, `openrouter_id`, `generation_id`, `attempt`, `purpose` (initial/repair), `status` (sent/ok/error/timeout/unknown), `queue_ms`, `latency_ms`, `prompt_tokens`, `completion_tokens`, `reasoning_tokens`, `cached_tokens`, `cost_usd`, `cost_source`, `reserved_usd`, `request_json?`, `response_json?` |
| `human_submissions` | `game_id`, `internal_id`, `seat`, `payload_json`, `accepted`, `issues_json` |
| `human_notes` | `game_id`, `seat`, `text` |
| `prompt_packs` | `hash`, `content_json` |
| `model_catalog` | `openrouter_id`, `fetched_at`, `data_json` |

**Views** (defined in M4/M5, once the config snapshot shape is fixed):
- `model_stats`: per profile — games, wins by team, fallback rate, repair rate, average cost and latency. Games flagged `has_bot` are excluded, and remapped seats are split by `eseq`.
- `role_stats`: win rate per role and composition, for ruleset §12.2 calibration.

`request_json` and `response_json` (`logPrompts`) contain private contexts. They are served only through lock-checked routes.

---

## 11. API and real-time protocol (UI contract)

All message shapes are zod schemas in `shared`, wrapped by `client-sdk`, which re-exports `reduceView(view, entries)` from `projector`.

### 11.1 REST

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/models`, `/api/rosters`, `/api/compositions`, `/api/rules/default` | host | lobby options |
| POST | `/api/lobbies` · GET/PATCH `/api/lobbies/:id` | host | create / read / edit a lobby |
| GET | `/api/lobbies/:id/estimate` | host | cost pre-flight |
| POST | `/api/lobbies/:id/links` | host | issue the human links (lobby only; a player who has already joined gets no new link, see `joined`) |
| POST | `/api/lobbies/:id/replace-link` | host | in the lobby, give one player a new link and shut out the device that joined with the old one |
| POST | `/api/lobbies/:id/discard` | host | throw away a lobby that never started |
| POST | `/api/lobbies/:id/start` | host | start the game (`force` flag, remap choices) |
| POST | `/api/games/:id/spectator-link` | host | a shareable spectator link, at any time; it never touches the seat links |
| POST | `/api/games/:id/reissue-link` | host | a new link for a player who lost theirs (their rejoin code while hidden; 5 wrong codes lock the seat's reissues for 10 minutes) |
| POST | `/api/games/:id/{pause,resume,abort,raise-cap,remap-seat,debrief,fallback-now}` | host | host commands |
| POST | `/api/host/login` | anyone with HOST_TOKEN | sets the HttpOnly host cookie, for hosting from another device |
| GET | `/api/games` | host | the host's list of games, host-safe (§9.1) |
| GET | `/api/games/:id/view` | principal | the caller's own projected view (replay/reload) |
| GET | `/api/games/:id/debrief` | any, after Over | debrief comments |
| GET | `/api/stats/models`, `/api/stats/roles` | host | stats. Only games that are `over`, or have their lock open, are aggregated. `has_bot` games are excluded. |
| GET | `/join/:token`, `/spectate/:token` | — | a browser gets a "Join" page (the link is not used yet, so a chat app's link preview cannot burn it); a client that does not ask for HTML is let straight in |
| POST | `/join/:token`, `/spectate/:token` | — | the Join button: exchanges the link for a session cookie and redirects (303) into the game |

### 11.2 WebSocket `/ws` (cookie-authenticated)

**Server → client:**

| Message | Purpose |
|---|---|
| `hello{principal, status, pauseReason?, view, lastVseq, notes?, pending?, models?}` (the seat's `human_notes` for human seats) | a full projected snapshot, sent on connect, on `LOCK_OPENED`, at game over and on resync. `models` (seat → model) only while the lock is open. |
| `entries{fromVseq, entries[]}` | contiguous per viewer. A gap means the client asks for `resync`. |
| `decision_request{clientRequestId, kind, legal, limits, deadlineAt, remainingMs, channel?}` | sent to a human seat; re-sent when a pause freezes or re-arms its clock |
| `decision_error{clientRequestId, issues}` | an invalid human submission; resubmitting is allowed until the deadline |
| `decision_closed{clientRequestId}` | the request was settled without this player (timeout, host fallback, away, the game stopped); an accepted answer gets `decision_accepted` instead |
| `command_result{cmd, ok, message}` | the outcome of a host command, in words, to the host who sent it |
| `paused{reason}` · `resumed` · `lock_opened` · `game_over` · `aborted` | game status |
| `host_status{status, pauseReason, pauseDetail?, disconnectedSlots, humans?, costUsd, costCapUsd, lockOpen, debriefPending, notice?}` | host-safe per §9.1, sent on connect and at every Dawn/Dusk as well as on status changes; the cost is the figure at the last Dawn/Dusk while the lock is closed. Game summaries also hide `has_remap`, `has_bot` and per-seat data until the lock opens. There is no pending-request information at night. `disconnectedSlots` lists lobby **slots**: connection status is not secret, and slots don't map to seats. |
| `lobby_*` | lobby channel messages (§9.2) |

**Client → server:**

| Message | Sent by |
|---|---|
| `submit_decision{clientRequestId, decision}` | human seat |
| `notes_update{text}` | human seat |
| `host_command{…}` | host |
| `resync` | any client |
| `ping` | any client |

**Limits.** Incoming messages are capped at 16 KB and rate-limited per socket. Speech text is also limited by words in the engine.

**Human timeouts per decision kind** (defaults; configurable in `rules/default.json`):

  | Decision kind | Timeout |
  |---|---|
  | speech, rebuttal, defence, last words, Sheriff speech, debrief comment | 360 s |
  | council turn, channel message | 180 s |
  | every other decision (ballots, candidacy, night actions, dying actions, rulings) | 180 s |

**Pacing (not implemented yet).** `revealDelayMs` is meant to space out *public* entries for watchability; it is display-only and would never change the game. Until it exists, the points below describe the intended behaviour, and a human's deadline starts when the request opens.
- A `decision_request` is queued behind that client's paced entries, so it never arrives before the events it depends on.
- The human's deadline starts when the request is **delivered** (`requests.delivered_at`), not when it is opened. For a seat that is **disconnected** when the request opens, every clock (grace, freeze, `disconnectMaxMs`, deadline) starts at **open** time instead.
- AI requests are unaffected, because AIs read the log directly.

---

## 12. `apps/cli`

| Command | Purpose |
|---|---|
| `ww play --preset 7 --roster mixed --seed abc` | a headless game, with the public log printed live |
| `ww batch --games 50 --preset 8 --roster X --concurrency 3 --cap 5 --total-cap 100` | calibration and stats runs |
| `ww replay <gameId> [--verify]` | re-run a stored game and check it reproduces exactly |
| `ww stats models\|roles` | print stats |
| `ww models check [--ping]` | validate profiles against the catalogue; `--ping` sends one tiny call per profile |

### 12.1 `apps/web` — the browser interface

A dependency-free TypeScript bundle (`npm run build:web` → `apps/web/dist`) that the gateway serves from `/`. It imports `@ww/client-sdk` and `@ww/projector` only, so it cannot reach the engine, the store or any secret.

| File | Role |
|---|---|
| `src/app.ts` | `AppState` + the pure `reduce(state, ServerMessage)`; the draft answer and its validation issues live here |
| `src/main.ts` | the one socket, the REST calls, the shell (top bar, three columns) and `render()` |
| `src/dom.ts` | `h()` / `replace()` — twenty lines instead of a framework |
| `src/views/table.ts` | the seats, the deaths, the Sheriff badge, and the picker while a target is wanted |
| `src/views/log.ts` | the story of the game, phase by phase |
| `src/views/turn.ts` | one plain question per decision kind, the word count, the deadline bar, `buildDecision` |
| `src/views/side.ts` | your card, your notes, the host's controls and the debrief offer |
| `src/views/lobby.ts` | the host's lobby and everyone else's waiting room |

Rules it follows: it renders only what arrived in its own scope's feed; it never asks for another scope; an answer is sent once and the panel then waits for `decision_accepted` or `decision_error`; a `vseq` gap triggers a resync rather than a guess.

---

## 13. Testing strategy

| Area | Tests |
|---|---|
| Engine rules | A scenario suite with at least one test per ruleset section, plus every edge case the reviewers traced. Every hook call site is covered. |
| Engine invariants | 10,000+ bot games across the presets and random valid compositions. Checks: every game terminates; no illegal action; the winner is consistent with the win table; no RNG use depends on arrival order (the answer order is shuffled on purpose). |
| Determinism | Replay equality; the serialise → resume round-trip; recovery with a kill at random points. |
| Isolation | For every event type × viewer, assert visibility. A property test checks that no seat view contains hidden roles before the reveal. Views are contiguous per viewer (`vseq`). The host-player mode matrix and lock monotonicity are tested. |
| Context | Snapshot tests per decision kind. Injection tests with fake engine or transcript markers. Checks that L0 is identical across seats and that transcripts are identical across seats. |
| LLM | A mock provider covering: malformed, slow, 429, 400-unsupported, missing cost, and reasoning overflow. Cost-cap races with a parallel group. |
| Server | Cookie join flow, reconnect/resync, pause/resume timers, forced start, remap, debrief gating. |
| Web UI | The client reducer and every view under happy-dom, driven by real server messages: what renders for a seat, a spectator and the host, the question asked for each decision kind, and the decision each draft builds. |

---

## 14. Extensibility cookbook

| I want to… | Do this |
|---|---|
| Switch the model for a slot | Pick another alias in the lobby (`PATCH /api/lobbies/:id`) |
| Add or tune a model | Edit `models.json` (it hot-reloads), then run `ww models check` |
| Build a quick line-up | Add a roster to `rosters.json` |
| Change game rules or limits | Edit `rules/default.json`, or use a lobby override |
| Add a preset | Add a file to `config/compositions/` |
| Add a role | `engine/roles/<id>.ts`, `prompts/roles/<id>.md`, a weight, and scenario tests. A new hook needs a core change with its own tests. |
| Tune prompts | Edit `/prompts`. The new pack is stored by content per game, so results can be compared. |
| Use another gateway | Implement `LLMProvider` |
| Build the UI | Use `client-sdk` only |

---

## 15. Milestones (each gated by owner confirmation)

| # | Milestone | Scope |
|---|---|---|
| M1 | Foundations | Monorepo, `shared` schemas, config loader and validation, RNG, text utils, `store` + migrations |
| M2 | Engine core | Phase machine, groups, core roles (Villager, Werewolf, Seer, Witch, Hunter, Protector, Sheriff), votes, scenario tests, bot simulation |
| M3 | Full catalogue | The remaining roles and step providers, the full scenario suite, 10k fuzzing, replay CI |
| M4 | Context and LLM | Projector, ContextBuilder, prompt pack v1, OpenRouter client, CostGuard, LLMController, mock tests, then the **first real AI-vs-AI game via the CLI** |
| M5 | Server | Orchestrator, sessions and host-player mode, lobby, WS/REST, humans on the LAN, recovery, remap, debrief |
| M6 | Web UI | `apps/web`: lobby, table, log, turn panel, host controls, debrief; served by the gateway |
