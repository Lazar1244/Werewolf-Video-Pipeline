import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { advance, answer as applyAnswer, createGame, ENGINE_VERSION } from '@ww/engine';
import { GameSnapshotSchema, type EngineEvent, type GameSnapshot } from '@ww/shared';
import { createLobby, getGame, getPromptPack, listDecisions, listEngineEvents, markUnfinishedLlmCalls, MIGRATIONS_DIR, openStore, putPromptPack, putSlots, resumeGame, setCostCap, startGame, type Store } from '@ww/store';
import { bold, dim, green, printEvents, red, yellow } from './print';
import { buildGame, loadEnv, resolveCatalog, type Env } from '@ww/server';
import { makePack, type PromptPack } from '@ww/context';
import { runGame } from './runner';
import { modelsCheck } from './models-check';
import { serve } from './serve';

const USAGE = `ww — AI Werewolf command line

  ww play [options]              play one game (models answer through OpenRouter)
    --preset <id>                composition preset (default: classic-7)
    --roster <name>              model roster from rosters.json (default: the first one)
    --models a,b,c               explicit aliases instead of a roster
    --seed <text>                game seed (default: random)
    --cap <usd>                  cost cap for this game (default: app.json defaultCostCapUsd)
    --bots 2,5                   slots played by the built-in bot instead of a model
    --discussion-rounds <1|2>    rounds of talk each day before the vote (default: 2)
    --mock                       dry run: answers are generated from the schema, no API calls
    --quiet                      hide inner monologues and private channels
    --no-channels                hide private channels only
    --offline                    do not fetch the OpenRouter catalogue
    --log-prompts                store full prompts and replies in the database

  ww serve [options]             run the LAN server (lobby, humans, spectators)
    --preset <id>                create a lobby for this composition right away
    --humans 1,2                 lobby slots played by humans (they get join links)
    --roster <name> / --models   models for the other slots
    --cap <usd>                  cost cap for that lobby
    --discussion-rounds <1|2>    rounds of talk each day in that lobby (default: 2)
    --port <n>                   override the port from app.json
    --mock                       seats answer from the schema: no API calls, no cost

  ww resume <gameId> [--cap <usd>]   continue a paused game
  ww replay <gameId> [--verify]      re-run a stored game from its recorded answers
  ww models check [--ping]           validate the model profiles against the catalogue
`;

interface Args {
  cmd: string;
  sub: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const sub: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      const next = argv[i + 1];
      if (inline !== undefined) flags.set(k!, inline);
      else if (next && !next.startsWith('--')) {
        flags.set(k!, next);
        i++;
      } else flags.set(k!, true);
    } else sub.push(a);
  }
  return { cmd: sub[0] ?? '', sub: sub.slice(1), flags };
}

const str = (a: Args, k: string, d: string): string => (typeof a.flags.get(k) === 'string' ? (a.flags.get(k) as string) : d);
const has = (a: Args, k: string): boolean => a.flags.has(k);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  if (!args.cmd || has(args, 'help')) {
    console.log(USAGE);
    return args.cmd ? 0 : 1;
  }
  const env = loadEnv(root);
  for (const w of env.cfg.warnings) console.log(yellow(`[config] ${w}`));
  const store = openStore(join(root, env.cfg.app.dbPath), { migrationsDir: MIGRATIONS_DIR });
  try {
    switch (args.cmd) {
      case 'play':
        return await play(env, store, args);
      case 'resume':
        return await resume(env, store, args);
      case 'replay':
        return replay(env, store, args);
      case 'serve': {
        const humans = str(args, 'humans', '')
          .split(',')
          .map((x) => Number(x.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);
        const rosterName = str(args, 'roster', Object.keys(env.cfg.rosters)[0] ?? '');
        const explicit = str(args, 'models', '');
        const aliases = explicit ? explicit.split(',').map((x) => x.trim()).filter(Boolean) : (env.cfg.rosters[rosterName] ?? []);
        const preset = str(args, 'preset', '');
        const portFlag = Number(str(args, 'port', ''));
        return await serve({
          env,
          store,
          root,
          mock: has(args, 'mock'),
          logPrompts: has(args, 'log-prompts'),
          ...(Number.isFinite(portFlag) && portFlag > 0 ? { port: portFlag } : {}),
          ...(preset ? { lobby: { compositionId: preset, aliases, humanSlots: humans, capUsd: Number(str(args, 'cap', String(env.cfg.app.defaultCostCapUsd))), discussionRounds: discussionRoundsOf(args) } } : {}),
        });
      }
      case 'models':
        return await modelsCheck(env, store, { ping: has(args, 'ping'), offline: has(args, 'offline') });
      default:
        console.log(USAGE);
        return 1;
    }
  } finally {
    store.close();
  }
}

function printOptionsOf(args: Args) {
  return { thoughts: !has(args, 'quiet'), channels: !has(args, 'quiet') && !has(args, 'no-channels') };
}

/** `--discussion-rounds`: 1 or 2 rounds of talk each day (absent: the rules file decides). */
function discussionRoundsOf(args: Args): number | undefined {
  const raw = str(args, 'discussion-rounds', '');
  if (!raw) return undefined;
  const n = Number(raw);
  if (n !== 1 && n !== 2) throw new Error('--discussion-rounds must be 1 or 2');
  return n;
}

async function play(env: Env, store: Store, args: Args): Promise<number> {
  const rosterName = str(args, 'roster', Object.keys(env.cfg.rosters)[0] ?? '');
  const explicit = str(args, 'models', '');
  const aliases = explicit ? explicit.split(',').map((s) => s.trim()).filter(Boolean) : (env.cfg.rosters[rosterName] ?? []);
  if (aliases.length === 0) throw new Error(`no models: pass --models a,b or a --roster from rosters.json (${Object.keys(env.cfg.rosters).join(', ')})`);
  const seed = str(args, 'seed', randomUUID().slice(0, 8));
  const capUsd = Number(str(args, 'cap', String(env.cfg.app.defaultCostCapUsd)));
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error('--cap must be a positive number of dollars');
  const bots = str(args, 'bots', '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  const rounds = discussionRoundsOf(args);
  const built = await buildGame({
    env,
    store,
    compositionId: str(args, 'preset', 'classic-7'),
    aliases,
    seed,
    costCapUsd: capUsd,
    botSlots: bots,
    ...(rounds !== undefined ? { rulesOverride: { discussion_rounds: rounds } } : {}),
    offline: has(args, 'offline'),
    mock: has(args, 'mock'),
  });
  for (const w of built.warnings) console.log(yellow(`[models] ${w}`));

  const gameId = randomUUID();
  createLobby(store, { id: gameId, lobby: { compositionId: built.snapshot.compositionId, aliases, bots }, costCapUsd: capUsd });
  putPromptPack(store, env.pack.hash, env.pack.files);
  startGame(store, gameId, { config: built.snapshot, seed, engineVersion: ENGINE_VERSION, promptPackHash: env.pack.hash });
  putSlots(
    store,
    gameId,
    built.snapshot.slots.map((s) => ({ slot: s.slot, seat: null, displayName: null, controller: s.controller, humanName: s.humanName })),
  );

  console.log(bold(`\nGame ${gameId}`));
  console.log(dim(`preset ${built.snapshot.compositionId} · seed ${seed} · cap $${capUsd.toFixed(2)} · models: ${aliases.join(', ')}${has(args, 'mock') ? ' · MOCK (no API calls)' : ''}`));
  const res = await runGame({
    env,
    store,
    gameId,
    snapshot: built.snapshot,
    entries: built.entries,
    pack: env.pack,
    print: printOptionsOf(args),
    mock: has(args, 'mock'),
    logPrompts: has(args, 'log-prompts') || env.cfg.app.logPrompts,
  });
  if (res.status === 'paused') {
    console.log(yellow(`Resume with: npm run ww -- resume ${gameId} --cap <higher amount>`));
    return 3;
  }
  // slot → seat mapping, now that the game is over
  const seating = listEngineEvents(store, gameId).find((e) => e.type === 'SEATING');
  if (seating) {
    const names = new Map((listEngineEvents(store, gameId).find((e) => e.type === 'GAME_START')!.payload as { seats: { seat: number; name: string }[] }).seats.map((s) => [s.seat, s.name]));
    putSlots(
      store,
      gameId,
      (seating.payload as { seats: { seat: number; slot: number }[] }).seats.map((s) => {
        const slot = built.snapshot.slots.find((x) => x.slot === s.slot)!;
        return { slot: s.slot, seat: s.seat, displayName: names.get(s.seat) ?? null, controller: slot.controller, humanName: slot.humanName };
      }),
    );
    console.log(dim('\nSeats: ' + (seating.payload as { seats: { seat: number; slot: number }[] }).seats.map((s) => `${names.get(s.seat)} = ${built.snapshot.slots.find((x) => x.slot === s.slot)!.profile?.label ?? 'bot'}`).join(', ')));
  }
  return 0;
}

/** Rebuild a stored game's state from its recorded answers (ARCHITECTURE.md §9.4 step 2). */
function rebuild(snapshot: GameSnapshot, decisions: { requestId: number; answer: import('@ww/shared').Answer }[]) {
  let step = advance(createGame(snapshot.game));
  const events: EngineEvent[] = [...step.events];
  for (const d of decisions) {
    if (!step.state.group.some((r) => r.requestId === d.requestId)) continue;
    step = applyAnswer(step.state, d.requestId, d.answer);
    events.push(...step.events);
  }
  return { step, events };
}

function loadSnapshot(store: Store, gameId: string): GameSnapshot {
  const row = getGame(store, gameId);
  if (!row) throw new Error(`game ${gameId} not found`);
  if (!row.config_json) throw new Error(`game ${gameId} never started`);
  const snap = GameSnapshotSchema.parse(JSON.parse(row.config_json));
  if (snap.engineVersion !== ENGINE_VERSION) throw new Error(`game ${gameId} was played with engine ${snap.engineVersion}, this is ${ENGINE_VERSION}`);
  return snap;
}

async function resume(env: Env, store: Store, args: Args): Promise<number> {
  const gameId = args.sub[0];
  if (!gameId) throw new Error('usage: ww resume <gameId> [--cap <usd>]');
  const row = getGame(store, gameId)!;
  const snapshot = loadSnapshot(store, gameId);
  const charged = markUnfinishedLlmCalls(store, gameId); // calls that never reported back are charged (§9.4)
  const capFlag = str(args, 'cap', '');
  let cap = row.cost_cap_usd;
  if (capFlag) {
    cap = Number(capFlag);
    if (!Number.isFinite(cap) || cap <= row.cost_cap_usd) throw new Error(`--cap must be higher than the current cap ($${row.cost_cap_usd})`);
    setCostCap(store, gameId, cap);
  }
  const decisions = listDecisions(store, gameId);
  const { step, events } = rebuild(snapshot, decisions);
  const stored = listEngineEvents(store, gameId);
  if (stored.length > events.length) throw new Error(`stored events (${stored.length}) do not match the rebuilt game (${events.length}): the database may be corrupt`);
  // A running game always uses the prompt pack it started with, whatever is on disk (§6.2).
  const pack = storedPack(store, snapshot, env);
  if (row.status === 'paused') resumeGame(store, gameId);
  console.log(bold(`Resuming ${gameId}`));
  console.log(dim(`${decisions.length} decisions replayed · spent $${row.cost_spent_usd.toFixed(4)}${charged ? ` (+$${charged.toFixed(4)} charged for unfinished calls)` : ''} · cap $${cap.toFixed(2)}`));
  const res = await runGame({
    env,
    store,
    gameId,
    snapshot: { ...snapshot, costCapUsd: cap },
    entries: (await buildEntries(env, store, snapshot, has(args, 'offline'), has(args, 'mock'))).entries,
    pack,
    print: printOptionsOf(args),
    mock: has(args, 'mock'),
    resumeFrom: { state: step.state, events, applyOrder: decisions.length, spentUsd: row.cost_spent_usd + charged },
    logPrompts: has(args, 'log-prompts') || env.cfg.app.logPrompts,
  });
  if (res.status === 'paused') {
    console.log(yellow(`Resume with: npm run ww -- resume ${gameId} --cap <higher amount>`));
    return 3;
  }
  return 0;
}

function buildEntries(env: Env, store: Store, snapshot: GameSnapshot, offline: boolean, mock: boolean) {
  const profiles = snapshot.slots.map((s) => s.profile).filter((p): p is NonNullable<typeof p> => p !== null);
  return resolveCatalog(env, store, profiles, { offline: offline || mock, assume: mock });
}

/** The pack this game started with, by content hash; falls back to disk with a warning. */
function storedPack(store: Store, snapshot: GameSnapshot, env: Env): PromptPack {
  const files = getPromptPack(store, snapshot.promptPackHash) as Record<string, string> | undefined;
  if (files) return makePack(files);
  if (env.pack.hash !== snapshot.promptPackHash) {
    console.log(yellow(`[prompts] this game's prompt pack (${snapshot.promptPackHash}) is not in the database; using the current one on disk instead`));
  }
  return env.pack;
}

/** Stable JSON: object keys sorted at every level. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
      : val,
  );
}

function replay(env: Env, store: Store, args: Args): number {
  const gameId = args.sub[0];
  if (!gameId) throw new Error('usage: ww replay <gameId> [--verify]');
  const snapshot = loadSnapshot(store, gameId);
  const decisions = listDecisions(store, gameId);
  const { step, events } = rebuild(snapshot, decisions);
  const stored = listEngineEvents(store, gameId);
  const names = (events.find((e) => e.type === 'GAME_START')?.payload as { seats: { seat: number; name: string }[] } | undefined)?.seats.map((s) => s.name) ?? [];
  if (has(args, 'verify')) {
    // The database round-trip may reorder JSON keys, so compare canonically.
    if (canonical(stored) !== canonical(events)) {
      console.log(red(`replay mismatch: ${stored.length} stored events vs ${events.length} replayed`));
      const i = events.findIndex((e, k) => canonical(e) !== canonical(stored[k]));
      if (i >= 0) console.log(red(`first difference at event ${i + 1}: ${canonical(events[i])}\nstored: ${canonical(stored[i])}`));
      return 2;
    }
    console.log(green(`replay matches: ${events.length} events reproduced exactly (engine ${ENGINE_VERSION}).`));
    return 0;
  }
  printEvents(events, (n) => names[n - 1] ?? `seat ${n}`, printOptionsOf(args));
  console.log(dim(`\n${step.status === 'over' ? 'game over' : 'game unfinished'} · ${decisions.length} decisions`));
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error(red(`\nError: ${(e as Error).message}`));
    process.exitCode = 1;
  });
