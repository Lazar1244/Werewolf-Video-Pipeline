import type { Answer, DecisionRequest } from '@ww/shared';
import type { Store } from './db';

/**
 * M4 repositories: slots, requests, decisions, LLM calls, the model catalogue cache and the
 * game's cost/result columns (ARCHITECTURE.md §10).
 */

export interface SlotRow {
  slot: number;
  seat: number | null;
  displayName: string | null;
  controller: 'ai' | 'human' | 'bot';
  humanName: string | null;
}

export function putSlots(store: Store, gameId: string, slots: readonly SlotRow[]): void {
  store.atomic(() => {
    const ins = store.db.prepare(
      `INSERT INTO slots (game_id, slot, seat, display_name, controller, human_name) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id, slot) DO UPDATE SET seat = excluded.seat, display_name = excluded.display_name,
         controller = excluded.controller, human_name = excluded.human_name`,
    );
    for (const s of slots) ins.run(gameId, s.slot, s.seat, s.displayName, s.controller, s.humanName);
  });
}

export function finishSlots(store: Store, gameId: string, finals: readonly { seat: number; role: string; team: string; won: boolean }[]): void {
  store.atomic(() => {
    const up = store.db.prepare('UPDATE slots SET final_role = ?, final_team = ?, won = ? WHERE game_id = ? AND seat = ?');
    for (const f of finals) up.run(f.role, f.team, f.won ? 1 : 0, gameId, f.seat);
  });
}

export function insertRequest(store: Store, gameId: string, req: DecisionRequest, openedEseq: number, clientId: string): void {
  store.atomic(() => {
    store.db
      .prepare(
        `INSERT OR IGNORE INTO requests (game_id, internal_id, client_id, seat, kind, legal_json, group_id, opened_eseq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(gameId, req.requestId, clientId, req.seat, req.kind, JSON.stringify(req.legal), req.groupId, openedEseq);
  });
}

export type DecisionSource = 'model' | 'human' | 'bot' | 'fallback';

/**
 * Record an answer the moment it arrives (ARCHITECTURE.md §9.3 step 3). It is `buffered` until
 * its whole group is applied, so a crash can never lose (or re-buy) an answer already paid for.
 */
export function bufferDecision(store: Store, gameId: string, d: { requestId: number; seat: number; answer: Answer; source: DecisionSource; repairUsed: boolean }): void {
  store.atomic(() => {
    store.db
      .prepare(
        `INSERT INTO decisions (game_id, internal_id, seat, answer_json, source, repair_used, status)
         VALUES (?, ?, ?, ?, ?, ?, 'buffered')
         ON CONFLICT(game_id, internal_id) DO NOTHING`,
      )
      .run(gameId, d.requestId, d.seat, JSON.stringify(d.answer), d.source, d.repairUsed ? 1 : 0);
    store.db.prepare(`UPDATE requests SET attempt_state = 'answered' WHERE game_id = ? AND internal_id = ?`).run(gameId, d.requestId);
  });
}

/**
 * Mark a buffered answer as applied, in the engine's apply order. Applying the same request
 * twice is refused (the apply order is unique), but a missing row is not an error the caller
 * can recover from mid-transaction, so it is reported as `false`.
 */
export function applyDecision(store: Store, gameId: string, requestId: number, applyOrder: number): boolean {
  return store.atomic(() => {
    const res = store.db
      .prepare(`UPDATE decisions SET status = 'applied', apply_order = ? WHERE game_id = ? AND internal_id = ? AND status = 'buffered'`)
      .run(applyOrder, gameId, requestId);
    return res.changes === 1;
  });
}

export function insertDecision(
  store: Store,
  gameId: string,
  d: { requestId: number; seat: number; answer: Answer; source: DecisionSource; repairUsed: boolean; applyOrder: number },
): void {
  store.atomic(() => {
    bufferDecision(store, gameId, d);
    applyDecision(store, gameId, d.requestId, d.applyOrder);
  });
}

/** Answers that arrived but were not applied yet (a pause, or a crash inside a group). */
export function listBufferedDecisions(store: Store, gameId: string): StoredDecision[] {
  const rows = store.db
    .prepare(`SELECT internal_id, seat, answer_json, source FROM decisions WHERE game_id = ? AND status = 'buffered' ORDER BY internal_id`)
    .all(gameId) as { internal_id: number; seat: number; answer_json: string; source: DecisionSource }[];
  return rows.map((r) => ({ requestId: r.internal_id, seat: r.seat, answer: JSON.parse(r.answer_json) as Answer, source: r.source, applyOrder: 0 }));
}

export interface StoredDecision {
  requestId: number;
  seat: number;
  answer: Answer;
  source: DecisionSource;
  applyOrder: number;
}

/** Applied decisions in apply order: replaying these rebuilds the game exactly. */
export function listDecisions(store: Store, gameId: string): StoredDecision[] {
  const rows = store.db
    .prepare(`SELECT internal_id, seat, answer_json, source, apply_order FROM decisions WHERE game_id = ? AND apply_order IS NOT NULL ORDER BY apply_order`)
    .all(gameId) as { internal_id: number; seat: number; answer_json: string; source: DecisionSource; apply_order: number }[];
  return rows.map((r) => ({ requestId: r.internal_id, seat: r.seat, answer: JSON.parse(r.answer_json) as Answer, source: r.source, applyOrder: r.apply_order }));
}

export interface LlmCallStart {
  gameId: string | null;
  requestId: number | null;
  seat: number | null;
  profileAlias: string;
  openrouterId: string;
  attempt: number;
  purpose: 'initial' | 'repair' | 'probe' | 'ping';
  queueMs: number;
  reservedUsd: number;
  requestJson?: string | null;
}

/** Insert the row before the request goes out (ARCHITECTURE.md §9.4 recovery needs this). */
export function startLlmCall(store: Store, c: LlmCallStart): number {
  return store.atomic(() => {
    const res = store.db
      .prepare(
        `INSERT INTO llm_calls (game_id, internal_id, seat, profile_alias, openrouter_id, attempt, purpose, status, queue_ms, reserved_usd, request_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?)`,
      )
      .run(c.gameId, c.requestId, c.seat, c.profileAlias, c.openrouterId, c.attempt, c.purpose, c.queueMs, c.reservedUsd, c.requestJson ?? null, new Date().toISOString());
    return Number(res.lastInsertRowid);
  });
}

export interface LlmCallEnd {
  status: 'ok' | 'error' | 'timeout' | 'unknown';
  latencyMs: number;
  generationId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  costUsd: number;
  costSource: 'usage' | 'generation' | 'estimate' | 'reserved';
  responseJson?: string | null;
}

export function finishLlmCall(store: Store, id: number, e: LlmCallEnd): void {
  store.atomic(() => {
    store.db
      .prepare(
        `UPDATE llm_calls SET status = ?, latency_ms = ?, generation_id = ?, prompt_tokens = ?, completion_tokens = ?,
           reasoning_tokens = ?, cached_tokens = ?, cost_usd = ?, cost_source = ?, response_json = ? WHERE id = ?`,
      )
      .run(e.status, e.latencyMs, e.generationId, e.promptTokens, e.completionTokens, e.reasoningTokens, e.cachedTokens, e.costUsd, e.costSource, e.responseJson ?? null, id);
  });
}

/** Unfinished calls after a crash: charged their reservation and marked `unknown` (§9.4). */
export function markUnfinishedLlmCalls(store: Store, gameId: string): number {
  return store.atomic(() => {
    const row = store.db.prepare(`SELECT COALESCE(SUM(reserved_usd), 0) AS s FROM llm_calls WHERE game_id = ? AND status = 'sent'`).get(gameId) as { s: number };
    store.db.prepare(`UPDATE llm_calls SET status = 'unknown', cost_usd = reserved_usd, cost_source = 'reserved' WHERE game_id = ? AND status = 'sent'`).run(gameId);
    return row.s;
  });
}

/** Meta events of a game in order (used to rebuild per-seat downgrades on resume, §9.4). */
export function listMetaEvents(store: Store, gameId: string): { mseq: number; type: string; vis: string; payload: unknown; wallTime: string }[] {
  const rows = store.db.prepare('SELECT mseq, type, vis, payload_json, wall_time FROM meta_events WHERE game_id = ? ORDER BY mseq').all(gameId) as {
    mseq: number;
    type: string;
    vis: string;
    payload_json: string;
    wall_time: string;
  }[];
  return rows.map((r) => ({ mseq: r.mseq, type: r.type, vis: r.vis, payload: JSON.parse(r.payload_json), wallTime: r.wall_time }));
}

export function setCostSpent(store: Store, gameId: string, spentUsd: number): void {
  store.atomic(() => {
    store.db.prepare('UPDATE games SET cost_spent_usd = ? WHERE id = ?').run(spentUsd, gameId);
  });
}

export function setCostCap(store: Store, gameId: string, capUsd: number): void {
  store.atomic(() => {
    store.db.prepare('UPDATE games SET cost_cap_usd = ? WHERE id = ?').run(capUsd, gameId);
  });
}

export function setResult(store: Store, gameId: string, winnerTeam: string, endedReason: string, lockOpen: boolean): void {
  store.atomic(() => {
    store.db.prepare('UPDATE games SET winner_team = ?, ended_reason = ?, lock_open = ? WHERE id = ?').run(winnerTeam, endedReason, lockOpen ? 1 : 0, gameId);
  });
}

export function setHasBot(store: Store, gameId: string, hasBot: boolean): void {
  store.atomic(() => {
    store.db.prepare('UPDATE games SET has_bot = ? WHERE id = ?').run(hasBot ? 1 : 0, gameId);
  });
}

/** Model catalogue cache (`GET /models`, plus per-provider endpoint prices). */
export function putCatalogEntry(store: Store, openrouterId: string, data: unknown, endpoints?: unknown): void {
  store.atomic(() => {
    store.db
      .prepare(
        `INSERT INTO model_catalog (openrouter_id, fetched_at, data_json, endpoints_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(openrouter_id) DO UPDATE SET fetched_at = excluded.fetched_at, data_json = excluded.data_json,
           endpoints_json = COALESCE(excluded.endpoints_json, model_catalog.endpoints_json)`,
      )
      .run(openrouterId, new Date().toISOString(), JSON.stringify(data), endpoints === undefined ? null : JSON.stringify(endpoints));
  });
}

export interface CatalogRow {
  openrouterId: string;
  fetchedAt: string;
  data: unknown;
  endpoints: unknown | null;
}

export function getCatalogEntry(store: Store, openrouterId: string): CatalogRow | undefined {
  const row = store.db.prepare('SELECT * FROM model_catalog WHERE openrouter_id = ?').get(openrouterId) as
    | { openrouter_id: string; fetched_at: string; data_json: string; endpoints_json: string | null }
    | undefined;
  if (!row) return undefined;
  return {
    openrouterId: row.openrouter_id,
    fetchedAt: row.fetched_at,
    data: JSON.parse(row.data_json),
    endpoints: row.endpoints_json ? JSON.parse(row.endpoints_json) : null,
  };
}
