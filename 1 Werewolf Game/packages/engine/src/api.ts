import {
  AnswerSchema,
  DecisionSchemas,
  GameConfigSchema,
  validateComposition,
  type Answer,
  type AnyDecision,
  type DecisionRequest,
  type EngineEvent,
  type GameConfig,
} from '@ww/shared';
import { checkLegal } from './game/legal';
import { SUPPORTED_ROLES, Suspend, runScript } from './game/script';
import type { Asker, GameResult } from './game/types';

/**
 * Public engine API (ARCHITECTURE.md §5.1).
 *
 * Implementation note (ARCHITECTURE v1.8): the engine is a deterministic *script* that is
 * re-executed over the recorded answers. The serialisable state is just the frozen config
 * plus the answer log — which is exactly what replay and crash recovery need. A group of
 * requests is applied only when all its answers are present (answers are buffered).
 */
export interface EngineState {
  cfg: GameConfig;
  /** Answers by requestId (JSON-serialisable). */
  answers: Record<number, Answer>;
  /** Number of engine events already handed out. */
  emitted: number;
  /** The group currently waiting for answers (empty when over). */
  group: DecisionRequest[];
  status: 'awaiting' | 'over';
  result: GameResult | null;
  /** Seats played by humans, those still alive, and those with a queued/open dying action (spectator lock). */
  humanSeats: number[];
  humansAlive: number[];
  humansPending: number[];
  /** False until the first advance(). */
  started: boolean;
}

export interface StepResult {
  state: EngineState;
  /** New engine events since the previous call. */
  events: EngineEvent[];
  /** Requests still waiting for an answer. */
  open: DecisionRequest[];
  status: 'awaiting' | 'over';
}

export class EngineConfigError extends Error {}

export function createGame(input: GameConfig): EngineState {
  const parsed = GameConfigSchema.safeParse(input);
  if (!parsed.success) throw new EngineConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const cfg = parsed.data;
  const report = validateComposition({ seats: cfg.seats, cards: cfg.cards }, cfg.rules.reveal_on_death);
  if (!report.ok) throw new EngineConfigError(report.errors.join('; '));
  const unsupported = [...new Set(cfg.cards.filter((c) => !SUPPORTED_ROLES.has(c)))];
  if (unsupported.length) throw new EngineConfigError(`roles not implemented yet: ${unsupported.join(', ')}`);
  if (cfg.names.length < cfg.seats) throw new EngineConfigError('not enough display names');
  if (cfg.humanSlots.some((s) => s > cfg.seats)) throw new EngineConfigError('human slot out of range');
  if (new Set(cfg.humanSlots).size !== cfg.humanSlots.length) throw new EngineConfigError('duplicate human slot');
  if (new Set(cfg.names.map((n) => n.toLowerCase())).size !== cfg.names.length) throw new EngineConfigError('duplicate display names');
  return { cfg, answers: {}, emitted: 0, group: [], status: 'awaiting', result: null, humanSeats: [], humansAlive: [], humansPending: [], started: false };
}

class ReplayAsker implements Asker {
  constructor(private readonly answers: Record<number, Answer>) {}
  ask(_g: unknown, reqs: readonly DecisionRequest[]): Answer[] {
    if (reqs.some((r) => !(r.requestId in this.answers))) throw new Suspend([...reqs]);
    return reqs.map((r) => this.answers[r.requestId]!);
  }
}

function rerun(state: EngineState): StepResult {
  const { game, suspended } = runScript(state.cfg, new ReplayAsker(state.answers));
  const events = game.events.slice(state.emitted);
  const group = suspended ?? [];
  const next: EngineState = {
    ...state,
    emitted: game.events.length,
    group,
    status: suspended ? 'awaiting' : 'over',
    result: game.result,
    humanSeats: game.seats.filter((s) => s.human).map((s) => s.seat),
    humansAlive: game.seats.filter((s) => s.human && s.alive).map((s) => s.seat),
    humansPending: [...new Set([...game.triggers.map((t) => t.seat), ...group.map((r) => r.seat as number)])].filter((n) =>
      game.seats.some((s) => s.seat === n && s.human),
    ),
    started: true,
  };
  return { state: next, events, open: group.filter((r) => !(r.requestId in state.answers)), status: next.status };
}

/** Run until the game needs answers or ends. Idempotent. */
export function advance(state: EngineState): StepResult {
  return rerun(state);
}

export type ValidationResult = { ok: true; decision: AnyDecision } | { ok: false; issues: string[] };

/** Pure check of a decision for an open request; never changes state. */
export function validate(state: EngineState, requestId: number, decision: unknown): ValidationResult {
  const req = state.group.find((r) => r.requestId === requestId);
  if (!req) return { ok: false, issues: [`request ${requestId} is not open`] };
  if (requestId in state.answers) return { ok: false, issues: [`request ${requestId} is already answered`] };
  const parsed = DecisionSchemas[req.kind].safeParse(decision);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const issues = checkLegal(req, parsed.data as AnyDecision);
  return issues.length ? { ok: false, issues } : { ok: true, decision: parsed.data as AnyDecision };
}

/**
 * Record an answer. Decisions must have passed validate(); no_answer triggers the ruleset
 * fallback. Nothing is applied (and no events are produced) until the whole group is answered.
 */
export function answer(state: EngineState, requestId: number, ans: Answer): StepResult {
  const shape = AnswerSchema.safeParse(ans);
  if (!shape.success) throw new Error(`malformed answer for request ${requestId}`);
  const req = state.group.find((r) => r.requestId === requestId);
  if (!req) throw new Error(`request ${requestId} is not open`);
  if (requestId in state.answers) throw new Error(`request ${requestId} is already answered`);
  if (ans.kind === 'decision') {
    const v = validate(state, requestId, ans.decision);
    if (!v.ok) throw new Error(`invalid decision for request ${requestId}: ${v.issues.join('; ')}`);
  }
  const answers = { ...state.answers, [requestId]: ans };
  const buffered: EngineState = { ...state, answers };
  const complete = state.group.every((r) => r.requestId in answers);
  if (!complete) {
    return { state: buffered, events: [], open: state.group.filter((r) => !(r.requestId in answers)), status: 'awaiting' };
  }
  return rerun(buffered);
}

/**
 * Spectator lock (ARCHITECTURE.md §9.1): open once the game is over, or when every human
 * seat is dead and has no pending (dying) action.
 */
export function lockOpen(state: EngineState): boolean {
  // Decided is decided: the debrief (ruleset §15b) runs after GAME_OVER, and "after GAME_OVER all
  // roles, teams and model names are shown to everyone", so it must not keep the game hidden.
  if (state.status === 'over' || !!state.result) return true;
  if (state.cfg.humanSlots.length === 0) return true;
  if (!state.started || !state.cfg.rules.dead_human_spectates) return false;
  return state.humansAlive.length === 0 && state.humansPending.length === 0;
}
