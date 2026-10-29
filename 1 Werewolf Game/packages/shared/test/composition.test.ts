import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_IDS, validateComposition, type RoleId } from '../src';

const v = (seats: number, cards: RoleId[], reveal: 'full' | 'team' | 'none' = 'full') =>
  validateComposition({ seats, cards }, reveal);

describe('role catalogue', () => {
  it('contains the 25 roles of ruleset §10', () => {
    expect(ROLE_IDS).toHaveLength(25);
    for (const id of ROLE_IDS) expect(ROLES[id].id).toBe(id);
  });

  it('marks exactly the four wolf-nature cards', () => {
    expect(ROLE_IDS.filter((id) => ROLES[id].wolfNature).sort()).toEqual(
      ['accursed_wolf_father', 'big_bad_wolf', 'werewolf', 'white_werewolf'].sort(),
    );
  });

  it('marks exactly the six solo/ambiguous cards of §12.1', () => {
    expect(ROLE_IDS.filter((id) => ROLES[id].countsAsSolo).sort()).toEqual(
      ['angel', 'piper', 'thief', 'white_werewolf', 'wild_child', 'wolf_hound'].sort(),
    );
  });
});

describe('ruleset §12.3 presets', () => {
  const presets: [string, number, RoleId[], number][] = [
    ['5', 5, ['werewolf', 'seer', 'villager', 'villager', 'villager'], 4],
    ['6', 6, ['werewolf', 'werewolf', 'seer', 'witch', 'villager', 'villager'], 1],
    ['7', 7, ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager'], 4],
    ['8', 8, ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'protector', 'cupid', 'villager'], 3],
    ['9', 9, ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'protector', 'cupid', 'villager', 'villager'], 4],
    ['10', 10, ['werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'protector', 'little_girl', 'villager', 'villager'], 4],
    ['chaos', 10, ['werewolf', 'accursed_wolf_father', 'seer', 'witch', 'fox', 'knight', 'elder', 'bear_tamer', 'village_idiot', 'piper'], 5],
  ];
  it.each(presets)('preset %s is valid (%i seats, weight %#)', (_name, seats, cards, weight) => {
    const r = v(seats, cards);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.weight).toBe(weight);
    expect(r.warnings).toEqual([]);
  });
});

describe('§12.1 hard rules', () => {
  it('rejects a wrong card count', () => {
    expect(v(6, ['werewolf', 'seer', 'villager', 'villager', 'villager']).errors.join()).toMatch(/card count must be 6/);
  });

  it('expects N+2 cards with a Thief', () => {
    const ok = v(5, ['thief', 'werewolf', 'seer', 'villager', 'villager', 'villager', 'villager']);
    expect(ok.errors).toEqual([]);
    expect(v(5, ['thief', 'werewolf', 'seer', 'villager', 'villager']).errors.join()).toMatch(/7 \(5 seats \+ 2 Thief extras\)/);
  });

  it('enforces the wolf-nature range', () => {
    expect(v(6, ['seer', 'witch', 'villager', 'villager', 'villager', 'villager']).errors.join()).toMatch(/wolf-nature/);
    expect(v(6, ['werewolf', 'werewolf', 'werewolf', 'seer', 'villager', 'villager']).errors.join()).toMatch(/between 1 and 2/);
  });

  it('requires another wolf beside the White Werewolf', () => {
    expect(v(5, ['white_werewolf', 'seer', 'villager', 'villager', 'villager']).errors.join()).toMatch(/White Werewolf/);
  });

  it('enforces uniqueness and the Two Sisters pair', () => {
    expect(v(6, ['werewolf', 'seer', 'seer', 'villager', 'villager', 'villager']).errors.join()).toMatch(/Seer is unique/);
    expect(v(6, ['werewolf', 'two_sisters', 'villager', 'villager', 'villager', 'villager']).errors.join()).toMatch(/Two Sisters/);
    expect(v(6, ['werewolf', 'two_sisters', 'two_sisters', 'seer', 'villager', 'villager']).errors).toEqual([]);
  });

  it('limits solo cards (2 for N<=8, 3 for N>=9)', () => {
    const three: RoleId[] = ['werewolf', 'werewolf', 'piper', 'angel', 'wild_child', 'seer', 'villager', 'villager'];
    expect(v(8, three).errors.join()).toMatch(/at most 2 solo/);
    const nine: RoleId[] = ['werewolf', 'werewolf', 'piper', 'angel', 'wild_child', 'seer', 'witch', 'villager', 'villager'];
    expect(v(9, nine).errors.join()).not.toMatch(/solo/);
  });

  it('requires full reveal for the Bear Tamer', () => {
    const cards: RoleId[] = ['werewolf', 'bear_tamer', 'seer', 'villager', 'villager'];
    expect(v(5, cards, 'full').errors).toEqual([]);
    expect(v(5, cards, 'team').errors.join()).toMatch(/Bear Tamer/);
  });

  it('requires at least 2 wolves at N=10', () => {
    const cards: RoleId[] = ['werewolf', 'seer', 'witch', 'hunter', 'protector', 'villager', 'villager', 'villager', 'villager', 'villager'];
    expect(v(10, cards).errors.join()).toMatch(/between 2 and 4/);
  });

  describe('Thief decks (N+2 cards)', () => {
    it('counts wolves over the whole deck, against the N-based range', () => {
      // 5 seats: range 1..2; three wolf cards in a 7-card deck is too many
      const deck: RoleId[] = ['thief', 'werewolf', 'werewolf', 'werewolf', 'seer', 'villager', 'villager'];
      expect(v(5, deck).errors.join()).toMatch(/between 1 and 2/);
    });

    it('counts the Thief toward the solo limit', () => {
      const atLimit: RoleId[] = ['thief', 'piper', 'werewolf', 'seer', 'villager', 'villager', 'villager'];
      expect(v(5, atLimit).errors).toEqual([]);
      const over: RoleId[] = ['thief', 'piper', 'angel', 'werewolf', 'seer', 'villager', 'villager'];
      expect(v(5, over).errors.join()).toMatch(/at most 2 solo/);
    });

    it('accepts a Thief with a White Werewolf and another wolf', () => {
      const deck: RoleId[] = ['thief', 'white_werewolf', 'werewolf', 'seer', 'witch', 'villager', 'villager', 'villager', 'villager'];
      expect(v(7, deck).errors).toEqual([]);
    });

    it('reports the in-play weight range instead of the deck total', () => {
      const deck: RoleId[] = ['thief', 'werewolf', 'seer', 'villager', 'villager', 'villager', 'villager'];
      const r = v(5, deck);
      expect(r.weight).toBe(4); // -1 -6 +7 +4
      // Thief and the only werewolf are always dealt; extras come from {seer, villager x4}:
      // max removes two villagers (2) -> 2; min removes seer + villager (8) -> -4
      expect(r.weightRange).toEqual({ min: -4, max: 2 });
      expect(r.warnings).toEqual([]);
    });

    it('never sets aside the only team-Werewolf card, even with a White Werewolf', () => {
      const deck: RoleId[] = ['thief', 'white_werewolf', 'werewolf', 'seer', 'witch', 'villager', 'villager', 'villager', 'villager'];
      const r = v(7, deck);
      // total -1-5-6+7+4+4 = 3; extras from {white_werewolf, seer, witch, villager x4}
      // max removes white_werewolf + villager (-4) -> 7; min removes seer + witch (11) -> -8
      expect(r.weightRange).toEqual({ min: -8, max: 7 });
    });
  });

  it('warns (does not fail) outside the balance band', () => {
    const r = v(6, ['werewolf', 'seer', 'witch', 'hunter', 'protector', 'villager']);
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/balance weight/);
  });
});
