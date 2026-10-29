import type { EngineEvent, MetaEvent } from '@ww/shared';
import type { Store } from './db';

/**
 * M1 repositories: the building blocks later milestones compose inside one
 * transaction per engine step (ARCHITECTURE.md §9.3). Everything is synchronous.
 */

export type GameStatus = 'lobby' | 'running' | 'paused' | 'over_offer' | 'debrief' | 'over' | 'aborted';

export interface GameRow {
  id: string;
  created_at: string;
  status: GameStatus;
  pause_reason: PauseReason | null;
  paused_from: 'running' | 'over_offer' | 'debrief' | null;
  lobby_json: string | null;
  /** Null while status = 'lobby'. */
  config_json: string | null;
  seed: string | null;
  engine_version: string | null;
  started_at: string | null;
  prompt_pack_hash: string | null;
  winner_team: string | null;
  ended_reason: string | null;
  cost_spent_usd: number;
  cost_cap_usd: number;
  has_bot: number;
  has_remap: number;
  lock_open: number;
}

export interface NewLobby {
  id: string;
  /** Editable lobby draft (slots, composition, overrides). */
  lobby: unknown;
  costCapUsd: number;
}

/** Create a lobby row (status 'lobby', no frozen config yet). */
export function createLobby(store: Store, l: NewLobby): void {
  store.atomic(() => {
    store.db
      .prepare(`INSERT INTO games (id, created_at, status, lobby_json, cost_cap_usd) VALUES (?, ?, 'lobby', ?, ?)`)
      .run(l.id, new Date().toISOString(), JSON.stringify(l.lobby), l.costCapUsd);
  });
}

export function updateLobby(store: Store, id: string, lobby: unknown, costCapUsd?: number): void {
  store.atomic(() => {
    const res = store.db
      .prepare(`UPDATE games SET lobby_json = ?, cost_cap_usd = COALESCE(?, cost_cap_usd) WHERE id = ? AND status = 'lobby'`)
      .run(JSON.stringify(lobby), costCapUsd ?? null, id);
    if (res.changes !== 1) throw new Error(`lobby ${id} not found or already started`);
  });
}

export interface GameStart {
  config: unknown;
  seed: string;
  engineVersion: string;
  promptPackHash: string | null;
}

/** Freeze the config snapshot and move the lobby to 'running' (ARCHITECTURE.md §8, frozen snapshot). */
export function startGame(store: Store, id: string, s: GameStart): void {
  store.atomic(() => {
    const res = store.db
      .prepare(
        `UPDATE games SET status = 'running', config_json = ?, seed = ?, engine_version = ?, prompt_pack_hash = ?, started_at = ?
         WHERE id = ? AND status = 'lobby'`,
      )
      .run(JSON.stringify(s.config), s.seed, s.engineVersion, s.promptPackHash, new Date().toISOString(), id);
    if (res.changes !== 1) throw new Error(`lobby ${id} not found or already started`);
  });
}

export function getGame(store: Store, id: string): GameRow | undefined {
  return store.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
}

/**
 * Game status lifecycle (ARCHITECTURE.md §9.3/§9.4):
 * - lobby → running only through startGame()
 * - plain progress moves via setGameStatus(): running → over_offer | over, over_offer → debrief | over, debrief → over
 * - pauses via pauseGame()/resumeGame(): a pause remembers the status it came from (paused_from)
 *   and may be re-paused with a new reason (e.g. recovery re-pausing an already paused game)
 * - aborts via abortGame(): a game that already has a result (over_offer / debrief, directly or
 *   paused from there) ends as 'over' and keeps its result; otherwise it becomes 'aborted'
 */
export const STATUS_TRANSITIONS: Readonly<Partial<Record<GameStatus, readonly GameStatus[]>>> = {
  running: ['over_offer', 'over'],
  over_offer: ['debrief', 'over'],
  debrief: ['over'],
};

type PausableStatus = 'running' | 'over_offer' | 'debrief';
const PAUSABLE: readonly GameStatus[] = ['running', 'over_offer', 'debrief'];

interface StatusRow {
  status: GameStatus;
  paused_from: PausableStatus | null;
  pause_reason: PauseReason | null;
}

function currentStatus(store: Store, id: string): StatusRow {
  const row = store.db.prepare('SELECT status, paused_from, pause_reason FROM games WHERE id = ?').get(id) as StatusRow | undefined;
  if (!row) throw new Error(`game ${id} not found`);
  return row;
}

/** Progress moves only (see STATUS_TRANSITIONS). Use pauseGame/resumeGame/abortGame/startGame for the rest. */
export function setGameStatus(store: Store, id: string, status: GameStatus): void {
  store.atomic(() => {
    const cur = currentStatus(store, id);
    if (!(STATUS_TRANSITIONS[cur.status] ?? []).includes(status)) {
      throw new Error(`illegal status transition ${cur.status} → ${status} for game ${id}`);
    }
    store.db.prepare('UPDATE games SET status = ? WHERE id = ?').run(status, id);
  });
}

/** Pause reasons (ARCHITECTURE.md §9.3 / §9.4). */
export const PAUSE_REASONS = [
  'host',
  'cost_cap',
  'provider_failure',
  'humans_disconnected',
  'recovered',
  'version_mismatch',
  'corrupt',
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];
/** Pauses that can only end in an abort: never resumed, never overwritten. */
export const TERMINAL_PAUSE_REASONS: readonly PauseReason[] = ['version_mismatch', 'corrupt'];

/** Pause a running / over_offer / debrief game, or change the reason of an existing pause. */
export function pauseGame(store: Store, id: string, reason: PauseReason): void {
  if (!PAUSE_REASONS.includes(reason)) throw new Error(`unknown pause reason "${String(reason)}"`);
  store.atomic(() => {
    const cur = currentStatus(store, id);
    if (cur.status === 'paused') {
      if (cur.pause_reason && TERMINAL_PAUSE_REASONS.includes(cur.pause_reason)) {
        throw new Error(`game ${id} is paused with terminal reason "${cur.pause_reason}"; it can only be aborted`);
      }
      store.db.prepare('UPDATE games SET pause_reason = ? WHERE id = ?').run(reason, id);
      return;
    }
    if (!PAUSABLE.includes(cur.status)) throw new Error(`cannot pause a game in status ${cur.status}`);
    store.db
      .prepare("UPDATE games SET status = 'paused', pause_reason = ?, paused_from = ? WHERE id = ?")
      .run(reason, cur.status, id);
  });
}

/** Resume a paused game into the status it was paused from. Returns that status. */
export function resumeGame(store: Store, id: string): PausableStatus {
  return store.atomic(() => {
    const cur = currentStatus(store, id);
    if (cur.status !== 'paused' || !cur.paused_from) throw new Error(`game ${id} is not paused`);
    if (cur.pause_reason && TERMINAL_PAUSE_REASONS.includes(cur.pause_reason)) {
      throw new Error(`game ${id} is paused with terminal reason "${cur.pause_reason}"; it can only be aborted`);
    }
    store.db
      .prepare('UPDATE games SET status = paused_from, pause_reason = NULL, paused_from = NULL WHERE id = ?')
      .run(id);
    return cur.paused_from;
  });
}

/** Abort a game. Returns the final status: 'over' when a result already exists, else 'aborted'. */
export function abortGame(store: Store, id: string): 'over' | 'aborted' {
  return store.atomic(() => {
    const cur = currentStatus(store, id);
    const origin = cur.status === 'paused' ? cur.paused_from : cur.status;
    let final: 'over' | 'aborted';
    if (origin === 'over_offer' || origin === 'debrief') final = 'over';
    else if (origin === 'lobby' || origin === 'running') final = 'aborted';
    else throw new Error(`cannot abort a game in status ${cur.status}`);
    store.db
      .prepare('UPDATE games SET status = ?, pause_reason = NULL, paused_from = NULL WHERE id = ?')
      .run(final, id);
    return final;
  });
}

/**
 * Append engine events atomically; `eseq` must continue the stored sequence without gaps.
 * The whole batch is validated before anything is written.
 */
export function appendEngineEvents(store: Store, gameId: string, events: readonly EngineEvent[]): void {
  if (events.length === 0) return;
  store.atomic(() => {
    const last = lastEngineSeq(store, gameId);
    events.forEach((e, i) => {
      const expected = last + 1 + i;
      if (e.eseq !== expected) throw new Error(`engine event gap: expected eseq ${expected}, got ${e.eseq}`);
    });
    const ins = store.db.prepare(
      'INSERT INTO engine_events (game_id, eseq, type, vis_json, payload_json, at_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const e of events) {
      ins.run(gameId, e.eseq, e.type, JSON.stringify(e.vis), JSON.stringify(e.payload), JSON.stringify(e.at));
    }
  });
}

export function lastEngineSeq(store: Store, gameId: string): number {
  const row = store.db.prepare('SELECT MAX(eseq) AS m FROM engine_events WHERE game_id = ?').get(gameId) as { m: number | null };
  return row.m ?? 0;
}

export function listEngineEvents(store: Store, gameId: string, fromEseq = 1): EngineEvent[] {
  const rows = store.db
    .prepare('SELECT eseq, type, vis_json, payload_json, at_json FROM engine_events WHERE game_id = ? AND eseq >= ? ORDER BY eseq')
    .all(gameId, fromEseq) as { eseq: number; type: string; vis_json: string; payload_json: string; at_json: string }[];
  return rows.map((r) => ({
    eseq: r.eseq,
    type: r.type,
    vis: JSON.parse(r.vis_json),
    payload: JSON.parse(r.payload_json),
    at: JSON.parse(r.at_json),
  }));
}

export function appendMetaEvent(store: Store, gameId: string, e: Omit<MetaEvent, 'mseq'>): number {
  return store.atomic(() => {
    const row = store.db.prepare('SELECT MAX(mseq) AS m FROM meta_events WHERE game_id = ?').get(gameId) as { m: number | null };
    const mseq = (row.m ?? 0) + 1;
    store.db
      .prepare('INSERT INTO meta_events (game_id, mseq, wall_time, type, vis, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(gameId, mseq, e.wallTime, e.type, e.vis, JSON.stringify(e.payload));
    return mseq;
  });
}

/** Store a prompt pack by content hash (idempotent). */
export function putPromptPack(store: Store, hash: string, content: unknown): void {
  store.atomic(() => {
    store.db
      .prepare('INSERT OR IGNORE INTO prompt_packs (hash, content_json, created_at) VALUES (?, ?, ?)')
      .run(hash, JSON.stringify(content), new Date().toISOString());
  });
}

export function getPromptPack(store: Store, hash: string): unknown | undefined {
  const row = store.db.prepare('SELECT content_json FROM prompt_packs WHERE hash = ?').get(hash) as { content_json: string } | undefined;
  return row ? JSON.parse(row.content_json) : undefined;
}
