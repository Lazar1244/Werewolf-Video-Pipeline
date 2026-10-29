import { describe, expect, it } from 'vitest';
import type { RoleId } from '@ww/shared';
import { randomBot, simulate } from '../src/sim';
import { makeCfg } from './helpers';

/** M2 compositions (ruleset §12.3 presets that only use M2 roles, plus variants). */
const LINEUPS: RoleId[][] = [
  ['werewolf', 'seer', 'villager', 'villager', 'villager'],
  ['werewolf', 'werewolf', 'seer', 'witch', 'villager', 'villager'],
  ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager'],
  ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'protector', 'villager', 'villager'],
  ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'protector', 'villager', 'villager', 'villager'],
  ['werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'protector', 'villager', 'villager', 'villager'],
];

const DYING_ACTIONS = new Set(['hunter_shot', 'sheriff_successor']);
const HIDDEN = new Set([
  'ROLE_ASSIGNED', 'SEATING', 'NIGHT_STEP_START', 'NIGHT_ACTION', 'WITCH_INFO', 'SEER_RESULT', 'PACK_INFO', 'PACK_LEADER',
  'COUNCIL_MSG', 'COUNCIL_BALLOTS', 'COUNCIL_RESULT', 'COUNCIL_SKIPPED', 'SEAT_THOUGHTS', 'DEATH_CAUSES', 'FALLBACK_USED',
  'REQUEST_OPENED', 'REQUEST_CLOSED',
]);

describe('bot simulation: invariants over many random games', () => {
  it('every game terminates legally and consistently', () => {
    const GAMES = 1_800;
    const winners: Record<string, number> = {};
    for (let i = 0; i < GAMES; i++) {
      const cards = LINEUPS[i % LINEUPS.length]!;
      const cfg = makeCfg(cards, {}, { fixedDeal: false, seed: `sim-${i}` });
      const g = simulate(cfg, randomBot(`b${i}`, { noAnswerRate: 0.05, invalidRate: 0.03 }));

      // terminates with a result within the day cap
      expect(g.result, `game ${i}`).not.toBeNull();
      expect(g.day).toBeLessThanOrEqual(cfg.rules.max_days);
      winners[g.result!.winner] = (winners[g.result!.winner] ?? 0) + 1;

      // contiguous event numbering
      g.events.forEach((e, k) => expect(e.eseq).toBe(k + 1));

      // replay the timeline: nobody acts while dead (except dying actions); wolves never target the pack
      const alive = new Set(g.seats.map((s) => s.seat));
      const wolves = new Set(g.seats.filter((s) => s.wolfNature).map((s) => s.seat));
      for (const e of g.events) {
        const p = e.payload as any;
        if (e.type === 'DEATHS') for (const d of p.deaths) alive.delete(d.seat);
        if (e.type === 'REQUEST_OPENED' && p.seat !== 0 && !DYING_ACTIONS.has(p.context)) {
          expect(alive.has(p.seat), `game ${i}: request to dead seat ${p.seat} (${p.context})`).toBe(true);
        }
        if (e.type === 'COUNCIL_RESULT') expect(wolves.has(p.victim)).toBe(false);
        if (e.type === 'SPEECH') expect(alive.has(p.seat) || p.context === 'last_words').toBe(true);
      }

      // the winner is consistent with who is alive
      const living = g.seats.filter((s) => s.alive);
      if (g.result!.winner === 'Village') expect(living.every((s) => s.team === 'Village')).toBe(true);
      if (g.result!.winner === 'Werewolf') expect(living.some((s) => s.team === 'Werewolf')).toBe(true);
      if (g.result!.winner === 'draw') expect(g.result!.winners).toEqual([]);

      // hidden information is never public
      for (const e of g.events) {
        if (HIDDEN.has(e.type)) expect(e.vis.kind, `game ${i}: ${e.type} must not be public`).not.toBe('public');
      }

      // every speech is preceded by its request closing, and by the inner monologue unless a fallback was used
      for (let k = 0; k < g.events.length; k++) {
        const e = g.events[k]!;
        if (e.type !== 'SPEECH') continue;
        const seat = (e.payload as any).seat;
        expect(g.events[k - 1]!.type).toBe('REQUEST_CLOSED');
        const before = g.events[k - 2]!;
        expect(['SEAT_THOUGHTS', 'FALLBACK_USED']).toContain(before.type);
        expect((before.payload as any).seat).toBe(seat);
        if (before.type === 'SEAT_THOUGHTS') expect(before.vis).toEqual({ kind: 'seats', seats: [seat] });
      }
    }
    // both sides can win
    expect(winners.Village ?? 0).toBeGreaterThan(0);
    expect(winners.Werewolf ?? 0).toBeGreaterThan(0);
  }, 120_000);
});
