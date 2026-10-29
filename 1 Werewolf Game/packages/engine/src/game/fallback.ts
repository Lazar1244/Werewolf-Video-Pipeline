import type { AnyDecision, DecisionRequest, SeatId } from '@ww/shared';
import { pick, shuffle } from '../rng';
import type { Game } from './types';

/**
 * Fallback for a missing/invalid answer (ruleset §13). Called in canonical order after all
 * real decisions of the group; `real` holds those decisions (council ballot plurality).
 */
export function fallbackDecision(g: Game, req: DecisionRequest, real: readonly AnyDecision[]): AnyDecision {
  const targets = req.legal.targets ?? [];
  switch (req.kind) {
    case 'sheriff_run':
      return { run: false };
    case 'speech':
      return { speech: '(pass)', lean: null, claim: null, challenge: null };
    case 'vote':
      return { vote: 'abstain' };
    case 'council_turn':
      return { message: '', proposed_target: null, ready: false };
    case 'witch':
      return { heal: false, poison: null };
    case 'message':
      return { message: '' };
    case 'council_ballot': {
      // plurality of the real ballots (a "skip" ballot counts as its own option), else seeded random
      const counts = new Map<SeatId | null, number>();
      for (const d of real) {
        const t = (d as { target?: unknown }).target;
        if ((typeof t === 'number' && targets.includes(t)) || (t === null && req.legal.allowNone)) {
          counts.set(t as SeatId | null, (counts.get(t as SeatId | null) ?? 0) + 1);
        }
      }
      if (counts.size > 0) {
        const max = Math.max(...counts.values());
        const top = [...counts.entries()].filter(([, c]) => c === max).map(([t]) => t);
        const sorted = top.sort((a, b) => (a ?? 0) - (b ?? 0));
        return { target: sorted.length === 1 ? sorted[0]! : pick(g.rng, sorted) };
      }
      return { target: pick(g.rng, targets) };
    }
    case 'target':
      // mandatory choices without a meaningful "none" use a seeded random legal target
      if (!req.legal.allowNone && ['wolf_kill', 'pack_tiebreak', 'wild_child'].includes(req.context) && targets.length > 0) {
        return { target: pick(g.rng, targets) };
      }
      return { target: null };
    case 'choice': {
      const choices = req.legal.choices ?? [];
      switch (req.context) {
        case 'thief':
          // keep; if forced (both extras are wolves), a seeded pick among them
          return { choice: choices.includes('keep') ? 'keep' : pick(g.rng, choices) };
        case 'wolf_hound':
          return { choice: pick(g.rng, choices) };
        case 'little_girl':
          return { choice: 'sleep' };
        case 'wolf_father':
          return { choice: 'kill' };
        default:
          return { choice: choices[0] ?? '' };
      }
    }
    case 'pair': {
      const [a, b] = shuffle(g.rng, targets);
      return { targets: [a!, b!] };
    }
    case 'multi':
      // Piper: charm nobody. Scapegoat ruling: nobody is banned (everyone may vote).
      return { targets: req.context === 'scapegoat_ruling' ? [...targets] : [] };
  }
}
