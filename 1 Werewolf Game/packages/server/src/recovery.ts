import { advance, answer as applyAnswer, createGame, ENGINE_VERSION, type EngineState } from '@ww/engine';
import { GameSnapshotSchema, type EngineEvent, type GameSnapshot } from '@ww/shared';
import { listDecisions, listEngineEvents, markUnfinishedLlmCalls, pauseGame, type Store } from '@ww/store';

/**
 * Crash recovery (ARCHITECTURE.md §9.4): a game that was running when the server stopped is
 * rebuilt from its recorded answers, its unfinished calls are charged, and it comes back
 * paused so a crash loop cannot burn money. The host resumes it.
 */
export interface RecoveredGame {
  gameId: string;
  /** The snapshot with the *current* cost cap (the host may have raised it since the start). */
  snapshot: GameSnapshot;
  state: EngineState;
  events: EngineEvent[];
  applyOrder: number;
  spentUsd: number;
  /** Set when the game cannot be resumed here (engine mismatch or a corrupt log). */
  problem: 'version_mismatch' | 'corrupt' | null;
}

interface Row {
  id: string;
  status: string;
  config_json: string | null;
  cost_spent_usd: number;
  cost_cap_usd: number;
}

export function recoverableGames(store: Store): string[] {
  const rows = store.db.prepare(`SELECT id FROM games WHERE status IN ('running','paused','over_offer','debrief')`).all() as { id: string }[];
  return rows.map((r) => r.id);
}

export function recoverGame(store: Store, gameId: string): RecoveredGame {
  const row = store.db.prepare('SELECT id, status, config_json, cost_spent_usd, cost_cap_usd FROM games WHERE id = ?').get(gameId) as Row | undefined;
  if (!row?.config_json) throw new Error(`game ${gameId} cannot be recovered (it never started)`);
  const frozen = GameSnapshotSchema.parse(JSON.parse(row.config_json));
  // the row carries the live cap: a cap the host raised before the crash must not be lost
  const snapshot: GameSnapshot = { ...frozen, costCapUsd: row.cost_cap_usd };
  const base = { gameId, snapshot, spentUsd: row.cost_spent_usd };

  if (snapshot.engineVersion !== ENGINE_VERSION) {
    pauseGame(store, gameId, 'version_mismatch');
    return { ...base, state: createGame(snapshot.game), events: [], applyOrder: 0, problem: 'version_mismatch' };
  }

  // 1. calls that never reported back are charged their reservation (§9.4 step 4)
  const charged = markUnfinishedLlmCalls(store, gameId);

  // 2. rebuild from the applied decisions
  const decisions = listDecisions(store, gameId);
  let step = advance(createGame(snapshot.game));
  const events: EngineEvent[] = [...step.events];
  for (const d of decisions) {
    if (!step.state.group.some((r) => r.requestId === d.requestId)) continue;
    step = applyAnswer(step.state, d.requestId, d.answer);
    events.push(...step.events);
  }

  // 3. the stored events must be a prefix of the rebuilt ones
  const stored = listEngineEvents(store, gameId);
  const prefixOk = stored.length <= events.length && stored.every((e, i) => canonical(e) === canonical(events[i]));
  if (!prefixOk) {
    pauseGame(store, gameId, 'corrupt');
    return { ...base, state: step.state, events, applyOrder: decisions.length, spentUsd: row.cost_spent_usd + charged, problem: 'corrupt' };
  }

  pauseGame(store, gameId, 'recovered');
  return { ...base, state: step.state, events, applyOrder: decisions.length, spentUsd: row.cost_spent_usd + charged, problem: null };
}

/** Stable JSON so a database round-trip (which may reorder keys) still compares equal. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : val,
  );
}

/**
 * Per-model statistics (ARCHITECTURE.md §10 `model_stats`): only games that are over or whose
 * lock is open, never games with a bot seat. A seat that was remapped mid-game counts for the
 * profile that actually answered, because `llm_calls` records the alias per call.
 */
export interface ModelStats {
  alias: string;
  games: number;
  seats: number;
  wins: number;
  winRate: number;
  calls: number;
  fallbackRate: number;
  repairRate: number;
  avgLatencyMs: number;
  costUsd: number;
}

export function modelStats(store: Store): ModelStats[] {
  const rows = store.db
    .prepare(
      `SELECT c.profile_alias AS alias,
              COUNT(DISTINCT c.game_id) AS games,
              COUNT(*) AS calls,
              COALESCE(SUM(c.cost_usd), 0) AS cost,
              COALESCE(AVG(c.latency_ms), 0) AS latency,
              COALESCE(SUM(CASE WHEN c.purpose = 'repair' THEN 1 ELSE 0 END), 0) AS repairs
         FROM llm_calls c JOIN games g ON g.id = c.game_id
        WHERE g.has_bot = 0 AND (g.status = 'over' OR g.lock_open = 1) AND c.purpose IN ('initial','repair')
        GROUP BY c.profile_alias`,
    )
    .all() as unknown as { alias: string; games: number; calls: number; cost: number; latency: number; repairs: number }[];

  // seats and wins come from the slots table (the seat's profile at the start of the game)
  const seatRows = store.db
    .prepare(
      `SELECT COALESCE(json_extract(g.config_json, '$.slots[' || (s.slot - 1) || '].profile.alias'), 'unknown') AS alias,
              s.won AS won, s.game_id AS game
         FROM slots s JOIN games g ON g.id = s.game_id
        WHERE g.has_bot = 0 AND (g.status = 'over' OR g.lock_open = 1) AND s.seat IS NOT NULL`,
    )
    .all() as unknown as { alias: string; won: number | null; game: string }[];

  // fallbacks are decisions the engine had to answer itself for that seat
  const fallbackRows = store.db
    .prepare(
      `SELECT COALESCE(json_extract(g.config_json, '$.slots[' || (sl.slot - 1) || '].profile.alias'), 'unknown') AS alias,
              SUM(CASE WHEN d.source = 'fallback' THEN 1 ELSE 0 END) AS fallbacks, COUNT(*) AS decisions
         FROM decisions d
         JOIN games g ON g.id = d.game_id
         JOIN slots sl ON sl.game_id = d.game_id AND sl.seat = d.seat
        WHERE g.has_bot = 0 AND (g.status = 'over' OR g.lock_open = 1) AND sl.controller = 'ai'
        GROUP BY alias`,
    )
    .all() as unknown as { alias: string; fallbacks: number; decisions: number }[];

  const out = new Map<string, ModelStats>();
  const get = (alias: string) => {
    const e = out.get(alias) ?? { alias, games: 0, seats: 0, wins: 0, winRate: 0, calls: 0, fallbackRate: 0, repairRate: 0, avgLatencyMs: 0, costUsd: 0 };
    out.set(alias, e);
    return e;
  };
  for (const r of rows) {
    const e = get(r.alias);
    e.games = r.games;
    e.calls = r.calls;
    e.costUsd = r.cost;
    e.avgLatencyMs = Math.round(r.latency);
    e.repairRate = r.calls ? r.repairs / r.calls : 0;
  }
  for (const r of seatRows) {
    const e = get(r.alias);
    e.seats++;
    e.wins += r.won ? 1 : 0;
    e.winRate = e.seats ? e.wins / e.seats : 0;
    if (e.games === 0) e.games = new Set(seatRows.filter((x) => x.alias === r.alias).map((x) => x.game)).size;
  }
  for (const r of fallbackRows) {
    const e = get(r.alias);
    e.fallbackRate = r.decisions ? r.fallbacks / r.decisions : 0;
  }
  return [...out.values()].sort((a, b) => b.seats - a.seats);
}

export function roleStats(store: Store): { role: string; games: number; wins: number; winRate: number }[] {
  const rows = store.db
    .prepare(
      `SELECT s.final_role AS role, s.won AS won FROM slots s JOIN games g ON g.id = s.game_id
        WHERE g.has_bot = 0 AND (g.status = 'over' OR g.lock_open = 1) AND s.final_role IS NOT NULL`,
    )
    .all() as unknown as { role: string; won: number | null }[];
  const out = new Map<string, { role: string; games: number; wins: number; winRate: number }>();
  for (const r of rows) {
    const e = out.get(r.role) ?? { role: r.role, games: 0, wins: 0, winRate: 0 };
    e.games++;
    e.wins += r.won ? 1 : 0;
    e.winRate = e.wins / e.games;
    out.set(r.role, e);
  }
  return [...out.values()].sort((a, b) => b.games - a.games);
}
