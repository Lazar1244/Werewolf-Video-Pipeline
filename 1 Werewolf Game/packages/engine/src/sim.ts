import type { Answer, AnyDecision, DecisionRequest, GameConfig } from '@ww/shared';
import { chance, createRng, nextInt, pick, type RngState } from './rng';
import { runScript } from './game/script';
import type { Game } from './game/types';

/** Chooses an answer for one request, seeing the (read-only) game. */
export type Decider = (req: DecisionRequest, g: Readonly<Game>) => Answer;

/**
 * Run a whole game in one pass with a synchronous decider (simulations, bots, tests).
 * Produces exactly the same events as the replay path given the same answers.
 */
export function simulate(cfg: GameConfig, decide: Decider): Game {
  const { game, suspended } = runScript(cfg, { ask: (g, reqs) => reqs.map((r) => decide(r, g)) });
  if (suspended) throw new Error('direct simulation cannot suspend');
  return game;
}

export interface RandomBotOptions {
  /** Probability of returning no_answer (exercises fallbacks). */
  noAnswerRate?: number;
  /** Probability of an illegal decision (exercises validation → fallback). */
  invalidRate?: number;
  /**
   * Probability of using an available Challenge in a discussion speech (ruleset §9.2). Off by default, so the
   * random stream (and every seeded test game) stays exactly as it was before Challenges existed.
   */
  challengeRate?: number;
}

/**
 * A random but legal-by-construction bot (wolves never vote for packmates on purpose;
 * otherwise uniform). Deterministic for a given seed.
 */
export function randomBot(seed: string, opts: RandomBotOptions = {}): Decider {
  const rng = createRng(`bot:${seed}`);
  return (req, g) => {
    if (opts.noAnswerRate && chance(rng, opts.noAnswerRate)) return { kind: 'no_answer', reason: 'timeout' };
    if (opts.invalidRate && chance(rng, opts.invalidRate)) return { kind: 'decision', decision: { nonsense: true } };
    return { kind: 'decision', decision: randomDecision(rng, req, g, opts) };
  };
}

function randomDecision(rng: RngState, req: DecisionRequest, g: Readonly<Game>, opts: RandomBotOptions = {}): AnyDecision {
  const L = req.legal;
  const targets = L.targets ?? [];
  const reasoning = `thinking about ${req.context}`;
  const seats = g?.seats;
  const me = req.seat === 0 || !seats ? undefined : seats[req.seat - 1];
  const nonPack = (xs: number[]) => (me?.wolfNature && seats ? xs.filter((x) => !seats[x - 1]!.wolfNature) : xs);
  switch (req.kind) {
    case 'sheriff_run':
      return { reasoning, run: chance(rng, 0.4) };
    case 'speech': {
      const leans = L.leanTargets ?? [];
      const lean = leans.length && chance(rng, 0.7) ? pick(rng, leans) : null;
      const callable = L.challengeTargets ?? [];
      const challenge = opts.challengeRate && callable.length && chance(rng, opts.challengeRate) ? pick(rng, callable) : null;
      return { reasoning, speech: `I suspect ${lean ?? 'nobody'} for now.`, lean, claim: null, ...(challenge ? { challenge } : {}) };
    }
    case 'vote': {
      const pool = nonPack(targets);
      const flag = L.secondVote && chance(rng, 0.3) ? { second_vote: true } : {};
      if (pool.length === 0 || chance(rng, 0.15)) return { reasoning, vote: 'abstain', ...flag };
      return { reasoning, vote: pick(rng, pool), ...flag };
    }
    case 'council_turn': {
      const t = targets.length ? pick(rng, targets) : null;
      return { reasoning, message: `Let's take ${t}.`, proposed_target: t, ready: chance(rng, 0.6) };
    }
    case 'council_ballot':
      if (L.allowNone && chance(rng, 0.1)) return { reasoning, target: null };
      return { reasoning, target: pick(rng, targets) };
    case 'choice':
      return { reasoning, choice: pick(rng, L.choices ?? ['']) };
    case 'pair': {
      const pool = [...targets];
      const a = pool.splice(nextInt(rng, pool.length), 1)[0]!;
      const b = pool[nextInt(rng, pool.length)]!;
      return { reasoning, targets: [a, b] };
    }
    case 'multi': {
      const min = L.min ?? 0;
      const max = Math.min(L.max ?? targets.length, targets.length);
      const k = min + nextInt(rng, max - min + 1);
      const pool = [...targets];
      const picked: number[] = [];
      for (let i = 0; i < k; i++) picked.push(pool.splice(nextInt(rng, pool.length), 1)[0]!);
      return { reasoning, targets: picked };
    }
    case 'message':
      return { reasoning, message: `psst (${req.context})` };
    case 'target':
      if (L.allowNone && (targets.length === 0 || chance(rng, 0.1))) return { reasoning, target: null };
      return { reasoning, target: targets.length ? pick(rng, targets) : null };
    case 'witch': {
      const heal = !!L.canHeal && chance(rng, 0.5);
      const pool = (L.poisonTargets ?? []).filter((t) => !(heal && t === L.healTarget));
      const poison = pool.length && chance(rng, 0.25) ? pool[nextInt(rng, pool.length)]! : null;
      return { reasoning, heal, poison };
    }
  }
}
