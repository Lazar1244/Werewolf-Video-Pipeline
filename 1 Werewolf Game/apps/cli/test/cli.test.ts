import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { advance, answer as engineAnswer, createGame, ENGINE_VERSION } from '@ww/engine';
import { MIGRATIONS_DIR, createLobby, getGame, listDecisions, listEngineEvents, openStore, putPromptPack, startGame, type Store } from '@ww/store';
import type { EngineEvent, GameSnapshot } from '@ww/shared';
import { maskNames } from '@ww/engine';
import { buildGame, loadEnv, maskNamesFor } from '@ww/server';
import { runGame } from '../src/runner';

const ROOT = join(import.meta.dirname, '../../..');
const env = loadEnv(ROOT);
const PRINT = { thoughts: false, channels: false };

function memoryStore(): Store {
  return openStore(':memory:', { migrationsDir: MIGRATIONS_DIR });
}

async function playMock(store: Store, opts: { preset?: string; seed?: string; cap?: number; bots?: number[]; discussionRounds?: number } = {}) {
  const built = await buildGame({
    env,
    store,
    compositionId: opts.preset ?? 'classic-7',
    aliases: ['glm-flash', 'deepseek-flash', 'qwen-flash'],
    seed: opts.seed ?? 'cli-test',
    costCapUsd: opts.cap ?? 2,
    botSlots: opts.bots,
    ...(opts.discussionRounds ? { rulesOverride: { discussion_rounds: opts.discussionRounds } } : {}),
    mock: true,
  });
  const gameId = 'game-' + (opts.seed ?? 'cli-test');
  createLobby(store, { id: gameId, lobby: {}, costCapUsd: opts.cap ?? 2 });
  putPromptPack(store, env.pack.hash, env.pack.files);
  startGame(store, gameId, { config: built.snapshot, seed: built.snapshot.game.seed, engineVersion: ENGINE_VERSION, promptPackHash: env.pack.hash });
  const log = console.log;
  console.log = () => undefined; // the runner prints the game; keep the test output clean
  try {
    const res = await runGame({ env, store, gameId, snapshot: built.snapshot, entries: built.entries, pack: env.pack, print: PRINT, mock: true });
    return { gameId, res, snapshot: built.snapshot };
  } finally {
    console.log = log;
  }
}

/** Replay a stored game from its decisions (what `ww replay --verify` does). */
function replay(snapshot: GameSnapshot, decisions: { requestId: number; answer: never }[]): EngineEvent[] {
  let step = advance(createGame(snapshot.game));
  const events = [...step.events];
  for (const d of decisions) {
    if (!step.state.group.some((r) => r.requestId === d.requestId)) continue;
    step = engineAnswer(step.state, d.requestId, d.answer);
    events.push(...step.events);
  }
  return events;
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : val,
  );

describe('CLI game runner (M4 end to end)', () => {
  it('plays a whole game against the mock provider and stores it', async () => {
    const store = memoryStore();
    try {
      const { gameId, res } = await playMock(store, { seed: 'e2e-1' });
      expect(res.status).toBe('over');
      expect(res.state.result).not.toBeNull();

      const row = getGame(store, gameId)!;
      expect(row.status).toBe('over');
      expect(row.winner_team).toBe(res.state.result!.winner);
      expect(row.cost_spent_usd).toBeGreaterThan(0);
      expect(row.cost_spent_usd).toBeLessThanOrEqual(row.cost_cap_usd);

      const events = listEngineEvents(store, gameId);
      expect(events.length).toBeGreaterThan(50);
      expect(events.map((e) => e.eseq)).toEqual(events.map((_, i) => i + 1));
      expect(events.at(-1)!.type).toBe('FINAL_REVEAL');

      // every request got exactly one decision, in apply order
      const decisions = listDecisions(store, gameId);
      expect(decisions.length).toBeGreaterThan(20);
      expect(decisions.map((d) => d.applyOrder)).toEqual(decisions.map((_, i) => i + 1));
      const requests = store.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE game_id = ?').get(gameId) as { n: number };
      expect(requests.n).toBe(decisions.length);

      // one llm_calls row per call, all finished, cost accounted
      const calls = store.db.prepare(`SELECT status, cost_usd, prompt_tokens FROM llm_calls WHERE game_id = ?`).all(gameId) as { status: string; cost_usd: number }[];
      expect(calls.length).toBeGreaterThanOrEqual(decisions.length);
      expect(calls.every((c) => c.status !== 'sent')).toBe(true);
      expect(calls.reduce((a, c) => a + c.cost_usd, 0)).toBeCloseTo(row.cost_spent_usd, 6);
    } finally {
      store.close();
    }
  }, 120_000);

  it('replays a stored game to exactly the same events', async () => {
    const store = memoryStore();
    try {
      const { gameId, snapshot } = await playMock(store, { seed: 'e2e-2' });
      const stored = listEngineEvents(store, gameId);
      const again = replay(snapshot, listDecisions(store, gameId) as never[]);
      expect(canonical(again)).toBe(canonical(stored));
    } finally {
      store.close();
    }
  }, 120_000);

  it('pauses instead of overspending when the cost cap is reached', async () => {
    const store = memoryStore();
    try {
      // the cap covers a few worst-case reservations (the flash models reserve 3400 output tokens since 2026-10-22,
      // their thinking budget) but not the whole game; it pauses inside the wolves' sealed ballot, where one wolf's
      // answer is already paid and the other's cannot be reserved
      const { gameId, res } = await playMock(store, { seed: 'e2e-3', cap: 0.012 });
      expect(res.status).toBe('paused');
      expect(res.pauseReason).toBe('cost_cap');
      const row = getGame(store, gameId)!;
      expect(row.status).toBe('paused');
      expect(row.pause_reason).toBe('cost_cap');
      expect(row.cost_spent_usd).toBeLessThanOrEqual(0.012);
      // every call that was paid for kept its answer: no completed call is thrown away. An answer of a group that
      // is not complete yet (a sealed ballot) is kept as a buffered decision and applied on resume, so count both.
      const decisions = listDecisions(store, gameId);
      expect(decisions.length).toBeGreaterThan(0);
      const paid = store.db
        .prepare(`SELECT DISTINCT internal_id FROM llm_calls WHERE game_id = ? AND status = 'ok' AND internal_id IS NOT NULL`)
        .all(gameId) as { internal_id: number }[];
      const kept = store.db.prepare(`SELECT internal_id FROM decisions WHERE game_id = ?`).all(gameId) as { internal_id: number }[];
      const answered = new Set(kept.map((d) => d.internal_id));
      expect(paid.filter((c) => !answered.has(c.internal_id))).toEqual([]);
      expect(kept.length).toBeGreaterThan(decisions.length); // this cap does pause with a buffered answer
      // and the game can be picked up again from those decisions
      const snapshot = JSON.parse(getGame(store, gameId)!.config_json!) as GameSnapshot;
      expect(replay(snapshot, decisions as never[]).length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  }, 120_000);

  it('mixes bot seats with model seats', async () => {
    const store = memoryStore();
    try {
      const { gameId, res, snapshot } = await playMock(store, { seed: 'e2e-4', bots: [1, 2] });
      expect(res.status).toBe('over');
      expect(snapshot.slots.filter((s) => s.controller === 'bot')).toHaveLength(2);
      const sources = store.db.prepare('SELECT DISTINCT source FROM decisions WHERE game_id = ?').all(gameId) as { source: string }[];
      expect(sources.map((s) => s.source).sort()).toContain('bot');
    } finally {
      store.close();
    }
  }, 120_000);

  it('plays one round of day talk when the game is set to 1, and two by default', async () => {
    const rounds = async (seed: string, discussionRounds?: number) => {
      const store = memoryStore();
      try {
        const { gameId, res, snapshot } = await playMock(store, { seed, ...(discussionRounds ? { discussionRounds } : {}) });
        expect(res.status).toBe('over');
        const talk = listEngineEvents(store, gameId).filter((e) => e.type === 'SPEECH' && (e.payload as { context?: string }).context === 'discussion');
        expect(talk.length).toBeGreaterThan(0);
        return { setting: snapshot.game.rules.discussion_rounds, seen: [...new Set(talk.map((e) => (e.payload as { round: number }).round))].sort() };
      } finally {
        store.close();
      }
    };
    expect(await rounds('e2e-rounds-1', 1)).toEqual({ setting: 1, seen: [1] });
    expect(await rounds('e2e-rounds-2')).toEqual({ setting: 2, seen: [1, 2] });
  }, 240_000);
});

describe('game setup', () => {
  it('freezes a snapshot with a token budget that fits the smallest model window', async () => {
    const store = memoryStore();
    try {
      const built = await buildGame({ env, store, compositionId: 'classic-9', aliases: ['glm-flash'], seed: 's', costCapUsd: 1, mock: true });
      const b = built.snapshot.budget;
      expect(b.inputBudget).toBe(b.window - b.outputReserve - 1000);
      expect(b.l0Tokens + b.l1Cap + b.l2Cap + b.l3Cap + b.l4Cap + b.l5Cap + b.l6Cap).toBeLessThanOrEqual(b.inputBudget);
      expect(built.snapshot.game.cards).toHaveLength(9);
      expect(built.snapshot.engineVersion).toBe(ENGINE_VERSION);
    } finally {
      store.close();
    }
  });

  it('masks model and provider names, but never ordinary words', () => {
    const names = maskNamesFor([
      { openrouterId: 'anthropic/claude-haiku-4.5', label: 'Anthropic Claude Haiku 4.5' } as never,
      { openrouterId: 'z-ai/glm-5.3-flash', label: 'Z.ai GLM 5.3 Flash' } as never,
      { openrouterId: 'mistralai/mistral-small-2603', label: 'Mistral Small (2603)' } as never,
      { openrouterId: 'meta-llama/llama-4-maverick', label: 'Meta Llama 4 Maverick' } as never,
    ]);
    expect(names).toContain('anthropic');
    expect(names).toContain('Claude');
    expect(names).toContain('glm');
    expect(names).toContain('OpenRouter');
    // words a player might honestly use must survive (ruleset §14.6 masks brands, not vocabulary)
    for (const ordinary of ['small', 'Small', 'flash', 'Flash', 'Meta', 'meta', 'light', 'max']) expect(names).not.toContain(ordinary);
    const speech = maskNames('I have a small doubt: a flash of insight told me to watch the quiet one.', names);
    expect(speech).toBe('I have a small doubt: a flash of insight told me to watch the quiet one.');
    expect(maskNames('Claude told me nothing.', names)).toBe('[redacted] told me nothing.');
  });

  it('the 2026-10-26 models: brands are masked, the everyday words in their names are not', () => {
    const names = maskNamesFor([
      { openrouterId: 'stepfun/step-5-preview', label: 'StepFun Step 5 Preview' } as never,
      { openrouterId: 'bytedance-seed/seed-2-1-turbo', label: 'ByteDance Seed 2.1 Turbo' } as never,
      { openrouterId: 'z-ai/glm-5.3-prime', label: 'Z.ai GLM 5.3 Prime' } as never,
      { openrouterId: 'meta/muse-wonder', label: 'Meta Muse Wonder' } as never,
      { openrouterId: 'moonshotai/kimi-k3.1-pro', label: 'Moonshot Kimi K3.1 Pro' } as never,
    ]);
    for (const brand of ['StepFun', 'ByteDance', 'Kimi', 'Moonshot']) expect(names).toContain(brand);
    for (const ordinary of ['step', 'Step', 'seed', 'Seed', 'prime', 'Prime', 'wonder', 'Wonder']) expect(names).not.toContain(ordinary);
    const speech = 'I wonder about our prime suspect: one step at a time, a seed of doubt.';
    expect(maskNames(speech, names)).toBe(speech);
  });
});
