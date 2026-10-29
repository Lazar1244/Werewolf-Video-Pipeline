import { describe, expect, it } from 'vitest';
import { setup } from '../src/game/script';
import { randomBot, simulate } from '../src/sim';
import { makeCfg, payloads } from './helpers';
import type { RoleId } from '@ww/shared';

// A custom game (owner request, 2026-10-26): the host seats the players and deals the cards.
const SEVEN: RoleId[] = ['villager', 'seer', 'werewolf', 'witch', 'villager', 'werewolf', 'hunter'];

describe('the host’s own deal (manualDeal)', () => {
  it('seats slot i at seat i with card i, whatever the seed', () => {
    for (const seed of ['a', 'b', 'c']) {
      const g = simulate(makeCfg(SEVEN, {}, { fixedDeal: false, manualDeal: true, seed }), randomBot(seed));
      expect(g.seats.map((s) => s.originalRole)).toEqual(SEVEN);
      expect(g.seats.map((s) => s.slot)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      // each seat learns its own card privately, as in any game
      const assigned = payloads(g, 'ROLE_ASSIGNED') as { seat: number; role: string }[];
      expect(assigned.map((a) => [a.seat, a.role])).toEqual(SEVEN.map((r, i) => [i + 1, r]));
    }
  });

  it('still shuffles the display names with the seed, and replays exactly', () => {
    const names = (seed: string) => simulate(makeCfg(SEVEN, {}, { fixedDeal: false, manualDeal: true, seed }), randomBot('x')).seats.map((s) => s.name);
    expect(names('s1')).toEqual(names('s1'));
    const seen = new Set(['s1', 's2', 's3', 's4'].map((s) => names(s).join()));
    expect(seen.size).toBeGreaterThan(1);
    const a = simulate(makeCfg(SEVEN, {}, { fixedDeal: false, manualDeal: true, seed: 'r' }), randomBot('r'));
    const b = simulate(makeCfg(SEVEN, {}, { fixedDeal: false, manualDeal: true, seed: 'r' }), randomBot('r'));
    expect(a.events).toEqual(b.events);
  });

  it('announces the composition sorted, so the public list never gives the seat order away', () => {
    const g = simulate(makeCfg(SEVEN, {}, { fixedDeal: false, manualDeal: true }), randomBot('x'));
    expect((payloads(g, 'GAME_START')[0] as { composition: string[] }).composition).toEqual([...SEVEN].sort());
  });

  it('with a Thief, the last two cards are the middle cards', () => {
    const cards: RoleId[] = ['werewolf', 'seer', 'thief', 'villager', 'villager', 'werewolf', 'villager'];
    // the deal itself, before the Thief's night swap changes anything
    const g = setup(makeCfg(cards, {}, { fixedDeal: false, manualDeal: true, seed: 't' }), {} as never);
    expect(g.seats.map((s) => s.role)).toEqual(cards.slice(0, 5));
    expect(g.thiefExtras).toEqual(['werewolf', 'villager']);
  });
});
