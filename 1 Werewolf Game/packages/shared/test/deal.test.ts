import { describe, expect, it } from 'vitest';
import { assignProblem, assignRole, manualDealFrom, manualDealProblem, type Deal } from '../src/deal';
import type { RoleId } from '../src/roles';

// A custom game (owner request, 2026-10-26): the host seats the players and deals the cards.
const SEVEN: RoleId[] = ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager'];
const THIEF9: RoleId[] = ['thief', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'cupid', 'little_girl', 'villager', 'villager', 'villager'];

const sorted = (d: Deal) => [...d.roles, ...(d.extras ?? [])].sort();

describe('the starting deal of a custom game', () => {
  it('is the mode cards in their listed order, with no middle cards without a Thief', () => {
    expect(manualDealFrom(SEVEN, 7)).toEqual({ roles: SEVEN });
    expect(manualDealProblem(SEVEN, 7, manualDealFrom(SEVEN, 7))).toBeNull();
  });

  it('with a Thief, keeps the Thief, the Sisters and a wolf at seats and two cards in the middle', () => {
    const d = manualDealFrom(THIEF9, 9);
    expect(d.roles).toHaveLength(9);
    expect(d.extras).toHaveLength(2);
    expect(manualDealProblem(THIEF9, 9, d)).toBeNull();
    // the wolves listed last would otherwise end up in the middle
    const late: RoleId[] = ['thief', 'seer', 'witch', 'hunter', 'villager', 'villager', 'two_sisters', 'two_sisters', 'villager', 'werewolf', 'werewolf'];
    const d2 = manualDealFrom(late, 9);
    expect(manualDealProblem(late, 9, d2)).toBeNull();
    expect(d2.roles).toContain('thief');
    expect(d2.roles.filter((r) => r === 'two_sisters')).toHaveLength(2);
    expect(d2.roles).toContain('werewolf');
  });
});

describe('checking a host deal against the mode', () => {
  it('needs one card per seat and exactly the mode cards', () => {
    expect(manualDealProblem(SEVEN, 7, { roles: SEVEN.slice(0, 6) })).toMatch(/7 seats, but 6/);
    expect(manualDealProblem(SEVEN, 7, { roles: [...SEVEN.slice(0, 6), 'werewolf'] })).toMatch(/2 Werewolf card\(s\), but 3/);
    expect(manualDealProblem(SEVEN, 7, { roles: [...SEVEN.slice(0, 6), 'fox'] })).toMatch(/0 Fox card/); // role names, not ids
    expect(manualDealProblem(SEVEN, 7, { roles: SEVEN, extras: ['villager', 'villager'] })).toMatch(/no cards left in the middle/);
  });

  it('with a Thief, needs the two middle cards and never sets aside the Thief, a Sister or every wolf', () => {
    const d = manualDealFrom(THIEF9, 9);
    expect(manualDealProblem(THIEF9, 9, { roles: d.roles })).toMatch(/exactly two cards stay in the middle/);
    const thiefOut = assignRole(d, d.roles.length, 'thief'); // the Thief swapped into the middle
    expect(manualDealProblem(THIEF9, 9, thiefOut)).toMatch(/Thief must sit at a seat/);
    const noWolves: Deal = { roles: THIEF9.filter((r) => r !== 'werewolf'), extras: ['werewolf', 'werewolf'] };
    expect(manualDealProblem(THIEF9, 9, noWolves)).toBe('at least one Werewolf must sit at a seat'); // no White Werewolf in this mode: no mention of one
    const sisters: RoleId[] = ['thief', 'werewolf', 'seer', 'two_sisters', 'two_sisters', 'villager', 'villager', 'villager'];
    expect(manualDealProblem(sisters, 6, { roles: ['thief', 'werewolf', 'seer', 'villager', 'villager', 'villager'], extras: ['two_sisters', 'two_sisters'] })).toMatch(/Sisters/);
  });
});

describe('the White Werewolf alone is not a pack (ruleset §6 step 2.2)', () => {
  // passes §12.1: a Thief deck with a White Werewolf and a plain Werewolf, 8 seats
  const WHITE: RoleId[] = ['thief', 'werewolf', 'white_werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager', 'villager'];

  it('refuses a deal whose only seated wolf is the White Werewolf', () => {
    const bad: Deal = { roles: ['thief', 'white_werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'], extras: ['werewolf', 'villager'] };
    expect(manualDealProblem(WHITE, 8, bad)).toMatch(/wolf of the pack \(not only the White Werewolf\)/);
    const good: Deal = { roles: ['thief', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'], extras: ['white_werewolf', 'villager'] };
    expect(manualDealProblem(WHITE, 8, good)).toBeNull();
  });

  it('starts the deal with a pack wolf at a seat even when the White Werewolf is listed first', () => {
    const whiteFirst: RoleId[] = ['white_werewolf', 'thief', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager', 'villager', 'werewolf'];
    const d = manualDealFrom(whiteFirst, 8);
    expect(d.roles).toContain('werewolf');
    expect(manualDealProblem(whiteFirst, 8, d)).toBeNull();
  });
});

describe('choosing a role swaps it, so the deal always stays the mode cards', () => {
  it('swaps with the first other place that holds the role', () => {
    const d = manualDealFrom(SEVEN, 7);
    const e = assignRole(d, 6, 'seer'); // seat 7 (a villager) becomes the Seer; seat 3 takes the villager card
    expect(e.roles[6]).toBe('seer');
    expect(e.roles[2]).toBe('villager');
    expect(sorted(e)).toEqual([...SEVEN].sort());
    expect(manualDealProblem(SEVEN, 7, e)).toBeNull();
  });

  it('works across the seats and the Thief middle cards', () => {
    const d = manualDealFrom(THIEF9, 9);
    const e = assignRole(d, 9, 'seer'); // the first middle card becomes the Seer
    expect(e.extras![0]).toBe('seer');
    expect(sorted(e)).toEqual([...THIEF9].sort());
    expect(e.roles).toHaveLength(9);
  });

  it('says in advance which choices would make the deal unplayable', () => {
    const d = manualDealFrom(THIEF9, 9);
    expect(assignProblem(THIEF9, 9, d, 9, 'thief')).toMatch(/Thief must sit at a seat/); // the Thief into the middle
    expect(assignProblem(THIEF9, 9, d, 9, 'seer')).toBeNull();
    expect(assignProblem(THIEF9, 9, d, 0, 'thief')).toBeNull(); // already there: nothing changes
  });

  it('leaves the deal alone for the same role, a foreign role or a place out of range', () => {
    const d = manualDealFrom(SEVEN, 7);
    expect(assignRole(d, 0, 'werewolf')).toBe(d);
    expect(assignRole(d, 0, 'fox')).toBe(d);
    expect(assignRole(d, 9, 'seer')).toBe(d);
  });
});
