import type { Answer, AnyDecision, DecisionRequest, EnginePayload, EngineEventType, EngineVisibility, SeatId } from '@ww/shared';
import { DecisionSchemas } from '@ww/shared';
import { cleanAndLimit } from '../text';
import { fallbackDecision } from './fallback';
import { checkLegal } from './legal';
import type { Game, RequestDraft, Resolved, SeatState } from './types';

export const PUBLIC: EngineVisibility = { kind: 'public' };
export const SPECTATOR: EngineVisibility = { kind: 'spectator' };
export const toSeats = (seats: SeatId[], channel?: 'pack' | 'sisters' | 'lovers' | 'charmed'): EngineVisibility =>
  channel ? { kind: 'seats', seats: [...seats].sort((a, b) => a - b), channel } : { kind: 'seats', seats: [...seats].sort((a, b) => a - b) };

/** Emit an engine event; `payload` is type-checked against the event's schema (shared/engine-events.ts). */
export function emit<T extends EngineEventType>(g: Game, type: T, payload: EnginePayload<T>, vis: EngineVisibility): void {
  g.events.push({
    eseq: g.events.length + 1,
    at: { phase: g.phase, day: g.day, night: g.night },
    type,
    // snapshot: an event must never alias mutable game state
    payload: structuredClone(payload),
    vis: structuredClone(vis),
  });
}

export const seatOf = (g: Game, n: SeatId): SeatState => {
  const s = g.seats[n - 1];
  if (!s) throw new Error(`no seat ${n}`);
  return s;
};

export const living = (g: Game): SeatState[] => g.seats.filter((s) => s.alive);

/** The nearest living seat on each side (ruleset §1 "Neighbours"); excludes the seat itself. */
export function livingNeighbours(g: Game, n: SeatId): SeatId[] {
  const count = g.seats.length;
  let left: SeatId | null = null;
  let right: SeatId | null = null;
  for (let i = 1; i < count; i++) {
    const s = g.seats[(n - 1 + i) % count]!;
    if (s.alive) { left = s.seat; break; }
  }
  for (let i = 1; i < count; i++) {
    const s = g.seats[(n - 1 - i + count * 2) % count]!;
    if (s.alive) { right = s.seat; break; }
  }
  return [...new Set([left, right].filter((x): x is SeatId => x !== null && x !== n))];
}
export const livingSeats = (g: Game): SeatId[] => living(g).map((s) => s.seat);

/** Next living seat to the left (higher number, wrapping), starting after `from`. */
export function nextLivingLeft(g: Game, from: SeatId): SeatId | null {
  const n = g.seats.length;
  for (let i = 1; i <= n; i++) {
    const s = g.seats[(from - 1 + i) % n]!;
    if (s.alive) return s.seat;
  }
  return null;
}

/** First living seat at or after `start`, going left. */
export function firstLivingFrom(g: Game, start: SeatId): SeatId | null {
  const n = g.seats.length;
  for (let i = 0; i < n; i++) {
    const s = g.seats[(start - 1 + i) % n]!;
    if (s.alive) return s.seat;
  }
  return null;
}

/** All living seats in speaking order starting at `start` (ruleset §9.2). */
export function orderFrom(g: Game, start: SeatId | null): SeatId[] {
  if (start === null) return [];
  const n = g.seats.length;
  const out: SeatId[] = [];
  for (let i = 0; i < n; i++) {
    const s = g.seats[(start - 1 + i) % n]!;
    if (s.alive) out.push(s.seat);
  }
  return out;
}

/** Today's speaking order (ruleset §9.2). */
export function speakingOrder(g: Game): SeatId[] {
  const sheriff = g.seats.find((s) => s.alive && s.sheriff);
  if (sheriff) return orderFrom(g, nextLivingLeft(g, sheriff.seat));
  const n = g.seats.length;
  return orderFrom(g, firstLivingFrom(g, (((g.day - 1) % n) + n) % n + 1));
}

/**
 * Open one group of requests, obtain answers, and resolve them in canonical order
 * (ARCHITECTURE.md §5.2): real decisions in (night step, seat) order, then fallbacks in the
 * same order (fallbacks may draw from the RNG and see the real decisions of the group).
 * Emits REQUEST_OPENED, then per request in that order: SEAT_THOUGHTS (inner monologue),
 * FALLBACK_USED, REQUEST_CLOSED.
 */
export function ask(g: Game, drafts: RequestDraft[]): Resolved[] {
  if (drafts.length === 0) return [];
  const groupId = ++g.groupSeq;
  const reqs: DecisionRequest[] = drafts.map((d) => ({ ...d, requestId: ++g.reqSeq, groupId, day: g.day, night: g.night }));
  for (const r of reqs) {
    emit(g, 'REQUEST_OPENED', { requestId: r.requestId, seat: r.seat, kind: r.kind, context: r.context }, r.seat === 0 ? PUBLIC : toSeats([r.seat]));
  }
  const answers = g.asker.ask(g, reqs);

  // canonical order: night step, then seat (ARCHITECTURE.md §5.2)
  const idx = reqs
    .map((_, i) => i)
    .sort((a, b) => (reqs[a]!.step ?? 0) - (reqs[b]!.step ?? 0) || (reqs[a]!.seat as number) - (reqs[b]!.seat as number));
  const out: (Resolved | undefined)[] = new Array(reqs.length);
  const reasons: (string | undefined)[] = new Array(reqs.length);
  // pass 1: real decisions
  for (const i of idx) {
    const d = acceptAnswer(g, reqs[i]!, answers[i]);
    if (d.ok) out[i] = { decision: d.decision, fallback: false };
    else reasons[i] = d.reason;
  }
  // pass 2: fallbacks (may use RNG; see the group's real decisions)
  const real = out.filter((x): x is Resolved => !!x).map((x) => x.decision);
  for (const i of idx) {
    if (!out[i]) out[i] = { decision: fallbackDecision(g, reqs[i]!, real), fallback: true };
  }
  for (const i of idx) {
    const r = reqs[i]!;
    const res = out[i]!;
    const vis = r.seat === 0 ? PUBLIC : toSeats([r.seat]);
    const d = res.decision as { reasoning?: string; notebook?: string };
    if (!res.fallback && r.seat !== 0 && (d.reasoning || d.notebook !== undefined)) {
      emit(g, 'SEAT_THOUGHTS', { seat: r.seat, requestId: r.requestId, context: r.context, reasoning: d.reasoning ?? '', notebook: d.notebook ?? null }, vis);
    }
    if (res.fallback) emit(g, 'FALLBACK_USED', { seat: r.seat, requestId: r.requestId, context: r.context, reason: reasons[i] ?? 'invalid' }, SPECTATOR);
    emit(g, 'REQUEST_CLOSED', { requestId: r.requestId, seat: r.seat }, vis);
  }
  return out as Resolved[];
}

/** Validate an answer (defensive: replayed answers were validated at submission) and clean its text. */
function acceptAnswer(g: Game, req: DecisionRequest, ans: Answer | undefined): { ok: true; decision: AnyDecision } | { ok: false; reason: string } {
  if (!ans) return { ok: false, reason: 'timeout' };
  if (ans.kind === 'no_answer') return { ok: false, reason: ans.reason };
  const parsed = DecisionSchemas[req.kind].safeParse(ans.decision);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const issues = checkLegal(req, parsed.data as AnyDecision);
  if (issues.length) return { ok: false, reason: 'invalid' };
  return { ok: true, decision: cleanDecision(g, req, parsed.data as AnyDecision) };
}

/** Word limit for the free-text part of a role claim (e.g. "Bram is a werewolf"). */
const CLAIM_RESULT_WORDS = 30;

/** Sanitise and word-limit all player-authored text (ruleset §14.4, §14.6). */
function cleanDecision(g: Game, req: DecisionRequest, d: AnyDecision): AnyDecision {
  const w = g.cfg.rules.words;
  const opts = { maskNames: g.cfg.maskNames };
  const out = { ...d } as Record<string, unknown>;
  if (typeof out.reasoning === 'string') out.reasoning = cleanAndLimit(out.reasoning, w.reasoning, opts).text;
  if (typeof out.notebook === 'string') out.notebook = cleanAndLimit(out.notebook, w.notebook, opts).text;
  if (typeof out.speech === 'string') out.speech = cleanAndLimit(out.speech, req.words ?? w.speech, opts).text || '(pass)';
  if (typeof out.message === 'string') out.message = cleanAndLimit(out.message, req.words ?? w.channel_message, opts).text;
  const claim = out.claim as { role: string; result?: string } | null | undefined;
  if (claim && typeof claim.result === 'string') out.claim = { ...claim, result: cleanAndLimit(claim.result, CLAIM_RESULT_WORDS, opts).text };
  // Humans have no inner monologue (ruleset §14.3): ignore those fields if a client sends them.
  if (req.seat !== 0 && g.seats[req.seat - 1]?.human) {
    delete out.reasoning;
    delete out.notebook;
  }
  return out as AnyDecision;
}
