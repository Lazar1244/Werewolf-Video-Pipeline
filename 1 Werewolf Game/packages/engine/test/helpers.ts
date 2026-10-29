import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RulesSchema,
  layerRules,
  resolveSentinels,
  type Answer,
  type AnyDecision,
  type DecisionRequest,
  type EngineEvent,
  type GameConfig,
  type RoleId,
  type RulesOverride,
} from '@ww/shared';
import type { Decider } from '../src/sim';
import { advance, answer, createGame, validate, type EngineState, type StepResult } from '../src/api';
import type { Game } from '../src/game/types';

const DEFAULT_RULES = RulesSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, '../../../config/rules/default.json'), 'utf8')));
const NAMES = ['Alba', 'Bram', 'Cora', 'Dario', 'Elin', 'Fenn', 'Greta', 'Hugo', 'Ines', 'Jonas'];

/** A fixed-deal config: seat i holds cards[i-1] and name NAMES[i-1]. */
export function makeCfg(cards: RoleId[], rules: RulesOverride = {}, extra: Partial<GameConfig> = {}): GameConfig {
  return {
    seed: 'test-seed',
    seats: cards.includes('thief') ? cards.length - 2 : cards.length,
    cards,
    rules: resolveSentinels(layerRules(DEFAULT_RULES, rules), cards.includes('thief') ? cards.length - 2 : cards.length),
    names: NAMES,
    maskNames: ['GPT', 'Claude'],
    humanSlots: [],
    fixedDeal: true,
    ...extra,
  };
}

type Choice = AnyDecision | 'no_answer' | ((req: DecisionRequest, g: Readonly<Game>) => AnyDecision | 'no_answer');

/**
 * Scripted decider. Keys are tried most-specific first:
 *   "N1:wolf_kill:2", "N1:wolf_kill", "wolf_kill:2", "wolf_kill"
 * where N<k> is night k (incl. its dawn) and D<k> is day k. Unscripted requests get a
 * neutral default: pass / abstain / no run / no action; mandatory choices get no_answer
 * (the engine's seeded fallback).
 */
export function scripted(plan: Record<string, Choice>): Decider {
  return (req, g) => {
    // night k (and its dawn) has night = day + 1; during day k, night = day
    const when = req.night > req.day ? `N${req.night}` : `D${req.day}`;
    const keys = [`${when}:${req.context}:${req.seat}`, `${when}:${req.context}`, `${req.context}:${req.seat}`, `${req.context}`];
    for (const k of keys) {
      if (k in plan) {
        const c = plan[k]!;
        const d = typeof c === 'function' ? c(req, g) : c;
        return d === 'no_answer' ? { kind: 'no_answer', reason: 'timeout' } : { kind: 'decision', decision: d };
      }
    }
    return defaultAnswer(req);
  };
}

function defaultAnswer(req: DecisionRequest): Answer {
  switch (req.kind) {
    case 'speech':
      return { kind: 'decision', decision: { speech: '(pass)', lean: null, claim: null } };
    case 'vote':
      return { kind: 'decision', decision: { vote: 'abstain' } };
    case 'sheriff_run':
      return { kind: 'decision', decision: { run: false } };
    case 'witch':
      return { kind: 'decision', decision: { heal: false, poison: null } };
    case 'council_turn':
      return { kind: 'decision', decision: { message: '', proposed_target: null, ready: false } };
    case 'target':
      return req.legal.allowNone ? { kind: 'decision', decision: { target: null } } : { kind: 'no_answer', reason: 'timeout' };
    case 'council_ballot':
    case 'choice':
    case 'pair':
      return { kind: 'no_answer', reason: 'timeout' };
    case 'multi':
      return req.context === 'piper' ? { kind: 'decision', decision: { targets: [] } } : { kind: 'no_answer', reason: 'timeout' };
    case 'message':
      return { kind: 'decision', decision: { message: '' } };
  }
}

export const ofType = (g: { events: EngineEvent[] }, type: string) => g.events.filter((e) => e.type === type);
export const payloads = <T = any>(g: { events: EngineEvent[] }, type: string) => ofType(g, type).map((e) => e.payload as T);
export const deadSeats = (g: Game) => g.seats.filter((s) => !s.alive).map((s) => s.seat);

/** Drive a game through the public API (replay mode) with a decider; `onStep` sees every step. */
export function playApi(cfg: GameConfig, decide: Decider, onStep?: (step: StepResult) => void): { events: EngineEvent[]; state: EngineState } {
  let step = advance(createGame(cfg));
  onStep?.(step);
  const events = [...step.events];
  let guard = 0;
  while (step.status === 'awaiting') {
    if (++guard > 10_000) throw new Error('too many steps');
    for (const r of step.open) {
      const a = decide(r, undefined as never);
      const ok = a.kind === 'no_answer' || validate(step.state, r.requestId, a.decision).ok;
      step = answer(step.state, r.requestId, ok ? a : { kind: 'no_answer', reason: 'invalid' });
      onStep?.(step);
      events.push(...step.events);
    }
  }
  return { events, state: step.state };
}
