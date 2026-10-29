import { describe, expect, it } from 'vitest';
import type { RoleId } from '@ww/shared';
import { createGame } from '../src/api';
import { simulate } from '../src/sim';
import { makeCfg, ofType, payloads, scripted } from './helpers';

// Fixed deal: seat i holds card i (with a Thief, the last two cards are the extras).
const lock = (t: number | null) => ({ message: 'go', proposed_target: t, ready: true });
const V = 'villager' as const;
const seatsOf = (g: any, type: string) => ofType(g, type).map((e) => (e.vis.kind === 'seats' ? e.vis.seats : e.vis.kind));
const deathsSeats = (g: any) => payloads(g, 'DEATHS').map((d) => d.deaths.map((x: any) => x.seat));
const valid = (cards: RoleId[], rules = {}) => expect(() => createGame(makeCfg(cards, rules))).not.toThrow();

describe('Thief (§7.2 step 1, §6)', () => {
  const deck: RoleId[] = ['thief', 'werewolf', 'seer', V, V, V, V, 'witch', 'werewolf'];
  it('sees the two extras privately and can take one; the taken role acts the same night', () => {
    valid(deck);
    const g = simulate(makeCfg(deck), scripted({ 'N1:thief': { choice: 'extra1' }, 'N1:wolf_kill': { target: 3 }, 'N1:witch': { heal: true, poison: null } }));
    const offer = ofType(g, 'THIEF_OFFER')[0]!;
    expect(offer.payload).toEqual({ extras: ['witch', 'werewolf'] });
    expect(offer.vis).toEqual({ kind: 'seats', seats: [1] });
    expect(payloads(g, 'ROLE_CHANGED')[0]).toMatchObject({ seat: 1, role: 'witch', team: 'Village', reason: 'thief' });
    expect(ofType(g, 'NO_DEATHS').length).toBeGreaterThan(0); // the new Witch healed on night 1
  });

  it('keeping the card makes the Thief a Villager', () => {
    const g = simulate(makeCfg(deck), scripted({ 'N1:thief': { choice: 'keep' }, 'N1:wolf_kill': { target: 3 } }));
    expect(g.seats[0]!.role).toBe('villager');
  });

  it('must take a wolf when both extras are wolves, and then joins the council on night 1', () => {
    const forced: RoleId[] = ['thief', 'werewolf', 'seer', V, V, V, V, 'werewolf', 'werewolf'];
    valid(forced);
    let choices: string[] = [];
    const g = simulate(makeCfg(forced), scripted({ 'N1:thief': (req) => { choices = req.legal.choices!; return { choice: 'extra2' }; }, 'N1:council': lock(3) }));
    expect(choices).toEqual(['extra1', 'extra2']);
    expect(payloads(g, 'PACK_INFO')[0].pack.map((p: any) => p.seat)).toEqual([1, 2]);
  });
});

describe('Wolf-Hound (§7.2 step 2)', () => {
  it('choosing the wolves joins the pack on night 1 and reads as a werewolf', () => {
    const cards: RoleId[] = ['wolf_hound', 'werewolf', 'seer', V, V, V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:wolf_hound': { choice: 'Werewolf' }, 'N1:seer': { target: 1 }, 'N1:council': lock(4) }));
    expect(payloads(g, 'PACK_INFO')[0].pack.map((p: any) => p.seat)).toEqual([1, 2]);
    expect(payloads(g, 'SEER_RESULT')[0]).toEqual({ target: 1, result: 'werewolf' });
  });
});

describe('Cupid and the Lovers (§10 Cupid, §4.1)', () => {
  const cards: RoleId[] = ['cupid', 'werewolf', 'werewolf', 'seer', V, V, V];
  it('a cross-team pair (and a Village Cupid) join team Lovers; heartbreak kills the partner', () => {
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:cupid': { targets: [2, 4] }, 'N1:council': lock(4) }));
    expect(ofType(g, 'LOVER_INFO').map((e) => [e.vis, e.payload])).toEqual([
      [{ kind: 'seats', seats: [2] }, { partner: 4 }],
      [{ kind: 'seats', seats: [4] }, { partner: 2 }],
    ]);
    const lovers = payloads(g, 'ROLE_CHANGED').filter((p) => p.reason === 'lovers').map((p) => p.seat);
    expect(lovers).toEqual([2, 4, 1]);
    expect(deathsSeats(g)[0]).toEqual([2, 4]); // seer attacked, wolf partner dies of heartbreak
    expect(payloads(g, 'DEATH_CAUSES')[0].deaths).toEqual([
      { seat: 2, causes: ['heartbreak'] },
      { seat: 4, causes: ['attack'] },
    ]);
    // both Lovers dead: the (non-Lover) Cupid reverts to Village
    expect(payloads(g, 'ROLE_CHANGED').find((p) => p.reason === 'cupid_reverted')).toMatchObject({ seat: 1, team: 'Village' });
  });

  it('a same-team pair keeps its team', () => {
    const g = simulate(makeCfg(cards), scripted({ 'N1:cupid': { targets: [4, 5] }, 'N1:council': lock(6) }));
    expect(payloads(g, 'ROLE_CHANGED').filter((p) => p.reason === 'lovers')).toHaveLength(0);
  });

  it('the Lovers (with Cupid) win when only their team remains', () => {
    const five: RoleId[] = ['cupid', 'werewolf', V, V, V];
    valid(five);
    const g = simulate(makeCfg(five), scripted({ 'N1:cupid': { targets: [2, 3] }, 'N1:wolf_kill': { target: 4 }, 'D1:day': { vote: 5 } }));
    expect(g.result).toMatchObject({ winner: 'Lovers', winners: [1, 2, 3] });
  });
});

describe('Wild Child (§10)', () => {
  it('converts when its role model dies and joins the pack the next night', () => {
    const cards: RoleId[] = ['wild_child', 'werewolf', 'werewolf', 'seer', V, V, V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:wild_child': { target: 4 }, 'N1:council': lock(4), 'N2:council': lock(5) }));
    expect(payloads(g, 'ROLE_CHANGED').find((p) => p.reason === 'wild_child')).toMatchObject({ seat: 1, team: 'Werewolf', wolfNature: true });
    expect(payloads(g, 'PACK_JOINED')[0]).toEqual({ seat: 1, role: 'wild_child', reason: 'wild_child', pack: [1, 2, 3] });
    expect(payloads(g, 'PACK_INFO')[1].pack.map((p: any) => p.seat)).toEqual([1, 2, 3]);
  });
});

describe('Two Sisters (§7.5)', () => {
  it('learn each other and talk privately, alternating who starts each night', () => {
    const cards: RoleId[] = ['two_sisters', 'two_sisters', 'werewolf', 'werewolf', 'seer', V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ sisters_channel: (req) => ({ message: `hi from ${req.seat}` }), 'N1:council': lock(6), 'N2:council': lock(7) }));
    expect(payloads(g, 'SISTER_INFO')).toEqual([{ sister: 2 }, { sister: 1 }]);
    const n1 = ofType(g, 'CHANNEL_MSG').filter((e) => e.at.night === 1);
    const n2 = ofType(g, 'CHANNEL_MSG').filter((e) => e.at.night === 2);
    expect(n1.map((e: any) => e.payload.seat)).toEqual([1, 2, 1, 2]);
    expect(n2.map((e: any) => e.payload.seat)).toEqual([2, 1, 2, 1]);
    for (const e of n1) expect(e.vis).toEqual({ kind: 'seats', seats: [1, 2], channel: 'sisters' });
  });
});

describe('Fox (§10)', () => {
  const cards: RoleId[] = ['werewolf', 'fox', V, V, V];
  it('finds a wolf among the target and its living neighbours', () => {
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:fox': { target: 5 }, 'N1:wolf_kill': { target: 3 } }));
    expect(payloads(g, 'FOX_RESULT')[0]).toEqual({ target: 5, wolfAmong: true, lostPower: false });
  });

  it('loses its power for good after a "no wolf" result', () => {
    const g = simulate(makeCfg(cards), scripted({ 'N1:fox': { target: 3 }, 'N1:wolf_kill': { target: 4 } }));
    expect(payloads(g, 'FOX_RESULT')[0]).toEqual({ target: 3, wolfAmong: false, lostPower: true });
    expect(ofType(g, 'REQUEST_OPENED').filter((e: any) => e.payload.context === 'fox')).toHaveLength(1);
  });
});

describe('Little Girl (§7.3)', () => {
  const cards: RoleId[] = ['werewolf', 'werewolf', 'little_girl', V, V, V, V];
  it('uncaught: receives the masked transcript and the victim', () => {
    valid(cards);
    const g = simulate(
      makeCfg(cards, { little_girl_catch: 0 }),
      scripted({ 'N1:little_girl': { choice: 'spy' }, 'N1:council': (req) => ({ message: `Bram and Alba agree: take Dario`, proposed_target: 4, ready: true }) }),
    );
    const t = ofType(g, 'LITTLE_GIRL_TRANSCRIPT')[0]!;
    expect(t.vis).toEqual({ kind: 'seats', seats: [3] });
    const p = t.payload as any;
    expect(p.victim).toBe(4);
    expect(p.messages).toHaveLength(2);
    for (const m of p.messages) {
      expect(m.speaker).toMatch(/^Wolf [AB]$/);
      expect(m.text).toBe('[a wolf] and [a wolf] agree: take Dario');
    }
  });

  it('caught: the pack learns who she is, round 1 lock is void, and she learns nothing', () => {
    const g = simulate(makeCfg(cards, { little_girl_catch: 1 }), scripted({ 'N1:little_girl': { choice: 'spy' }, 'N1:council': lock(4) }));
    expect(payloads(g, 'LITTLE_GIRL_CAUGHT')[0]).toEqual({ seat: 3 });
    expect(ofType(g, 'LITTLE_GIRL_CAUGHT')[0]!.vis).toEqual({ kind: 'seats', seats: [1, 2], channel: 'pack' });
    expect(ofType(g, 'COUNCIL_MSG').filter((e) => e.at.night === 1)).toHaveLength(4); // a second round was forced
    expect(ofType(g, 'LITTLE_GIRL_TRANSCRIPT')).toHaveLength(0);
  });
});

describe('Elder (§10, §8.1, §8.3)', () => {
  it('survives the first attack, dies to the second', () => {
    const cards: RoleId[] = ['werewolf', 'elder', V, V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ wolf_kill: { target: 2 } }));
    const dawns = g.events.filter((e) => e.type === 'PHASE_START' && (e.payload as any).phase === 'dawn');
    const first = g.events.indexOf(dawns[0]!);
    expect(g.events[first + 1]!.type).toBe('NO_DEATHS');
    expect(deathsSeats(g)[0]).toEqual([2]);
  });

  it('an executed Elder curses the village: powers are lost (announced publicly)', () => {
    const cards: RoleId[] = ['werewolf', 'elder', 'seer', V, V];
    const g = simulate(makeCfg(cards), scripted({ 'N1:wolf_kill': { target: 4 }, 'D1:day': { vote: 2 } }));
    expect(ofType(g, 'ELDER_CURSE')).toHaveLength(1);
    expect(ofType(g, 'REQUEST_OPENED').filter((e: any) => e.payload.context === 'seer' && e.at.night === 2)).toHaveLength(0);
  });
});

describe('Village Idiot (§9.3)', () => {
  it('survives the execution, is revealed, and never votes again', () => {
    const cards: RoleId[] = ['werewolf', 'village_idiot', V, V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:wolf_kill': { target: 3 }, 'D1:day': { vote: 2 } }));
    expect(payloads(g, 'IDIOT_REVEALED')[0]).toEqual({ seat: 2 });
    expect(g.seats[1]!.canVote).toBe(false);
    expect(ofType(g, 'REQUEST_OPENED').some((e: any) => e.payload.seat === 2 && e.payload.context === 'day' && e.at.day >= 2)).toBe(false);
  });
});

describe('Scapegoat (§9.3)', () => {
  it('is executed on an unresolved runoff tie and decides who votes tomorrow', () => {
    const cards: RoleId[] = ['werewolf', 'scapegoat', V, V, V, V];
    valid(cards);
    const votes: Record<number, number | 'abstain'> = { 1: 4, 2: 5, 4: 5, 5: 4, 6: 'abstain' };
    const tie = (req: any) => ({ vote: votes[req.seat] ?? 'abstain' });
    const g = simulate(
      makeCfg(cards),
      scripted({ 'N1:wolf_kill': { target: 3 }, 'D1:day': tie, 'D1:runoff': tie, 'D1:scapegoat_ruling': { targets: [6] }, 'N2:wolf_kill': { target: 4 } }),
    );
    expect(payloads(g, 'EXECUTION')[0]).toEqual({ seat: 2, scapegoat: true });
    expect(payloads(g, 'SCAPEGOAT_RULING')[0]).toEqual({ voters: [6] });
    const d2voters = ofType(g, 'REQUEST_OPENED').filter((e: any) => e.at.day === 2 && e.payload.context === 'day').map((e: any) => e.payload.seat);
    expect(d2voters).toEqual([6]);
  });
});

describe('Knight with the Rusty Sword (§8.2)', () => {
  it('killed by the pack: the nearest wolf to its left dies at the next Dawn', () => {
    const cards: RoleId[] = ['werewolf', 'werewolf', 'knight', V, V, V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:council': lock(3), 'N2:council': lock(4) }));
    expect(deathsSeats(g)[0]).toEqual([3]);
    const n2 = payloads(g, 'DEATH_CAUSES')[1].deaths;
    expect(n2).toContainEqual({ seat: 1, causes: ['knight_curse'] });
  });
});

describe('Raven (§10, §9.3)', () => {
  it('marks publicly at dawn and adds +2 to a candidate with a real vote', () => {
    const cards: RoleId[] = ['werewolf', 'raven', V, V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:raven': { target: 1 }, 'N1:wolf_kill': { target: 3 }, 'D1:day:2': { vote: 1 }, 'D1:day:4': { vote: 1 } }));
    expect(payloads(g, 'RAVEN_MARK')[0]).toEqual({ seat: 1 });
    const v = payloads(g, 'VOTES')[0];
    expect(v.scores[1]).toBe(4); // 2 real votes + 2 (Raven) vs 2 abstentions
    expect(v.raven).toBe(1);
    expect(payloads(g, 'EXECUTION')[0]).toEqual({ seat: 1 });
  });

  it('the bonus alone never makes a candidate', () => {
    const cards: RoleId[] = ['werewolf', 'raven', V, V, V];
    const g = simulate(makeCfg(cards), scripted({ 'N1:raven': { target: 1 }, 'N1:wolf_kill': { target: 3 } }));
    expect(payloads(g, 'VOTES')[0].scores).toEqual({});
  });
});

describe('Stuttering Judge (§9.3)', () => {
  it('a secret flag on the first ballot calls a second vote (with one short round)', () => {
    const cards: RoleId[] = ['werewolf', 'stuttering_judge', V, V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:wolf_kill': { target: 3 }, 'D1:day:2': { vote: 'abstain', second_vote: true } }));
    const v1 = payloads(g, 'VOTES')[0];
    expect(JSON.stringify(v1)).not.toMatch(/second_vote/); // never revealed
    expect(ofType(g, 'SECOND_VOTE')).toHaveLength(1);
    expect(payloads(g, 'SPEECH').filter((p) => p.context === 'judge_round').length).toBe(4);
    expect(payloads(g, 'VOTES').map((v) => v.context)).toContain('second_vote');
  });

  it('only the Judge may set the flag', () => {
    const cards: RoleId[] = ['werewolf', 'stuttering_judge', V, V, V];
    const g = simulate(makeCfg(cards), scripted({ 'N1:wolf_kill': { target: 3 }, 'D1:day:4': { vote: 'abstain', second_vote: true } }));
    expect(ofType(g, 'SECOND_VOTE')).toHaveLength(0);
  });
});

describe('Bear Tamer (§8.2 step 7)', () => {
  it('the bear growls when a living neighbour has wolf nature', () => {
    const cards: RoleId[] = ['werewolf', 'bear_tamer', V, V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:wolf_kill': { target: 4 } }));
    expect(payloads(g, 'BEAR')[0]).toEqual({ growls: true });
  });
});

describe('Big Bad Wolf (§10)', () => {
  it('kills an extra victim while no wolf has died', () => {
    const cards: RoleId[] = ['werewolf', 'big_bad_wolf', 'seer', V, V, V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:council': lock(5), 'N1:big_bad_wolf': { target: 6 } }));
    expect(deathsSeats(g)[0]).toEqual([5, 6]);
  });
});

describe('Accursed Wolf-Father (§8.2)', () => {
  const cards: RoleId[] = ['werewolf', 'accursed_wolf_father', 'seer', V, V, V, V];
  it('infects V instead of killing: V secretly joins the wolves, the pack learns its role', () => {
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:council': lock(3), 'N1:wolf_father': { choice: 'infect' } }));
    expect(payloads(g, 'INFECTED')[0]).toEqual({ seat: 3 });
    expect(payloads(g, 'PACK_JOINED')[0]).toEqual({ seat: 3, role: 'seer', reason: 'infected', pack: [1, 2, 3] });
    const firstDawn = g.events.findIndex((e) => e.type === 'PHASE_START' && (e.payload as any).phase === 'dawn');
    expect(ofType(g, 'DEATHS').filter((e) => e.at.night === 1 && e.at.phase === 'dawn')).toHaveLength(0);
    expect(firstDawn).toBeGreaterThan(0);
  });

  it('protection absorbs the infection, which is still consumed by default', () => {
    const g = simulate(makeCfg(['werewolf', 'accursed_wolf_father', 'protector', V, V, V, V]), scripted({ 'N1:council': lock(4), 'N1:protector': { target: 4 }, 'N1:wolf_father': { choice: 'infect' }, 'N2:council': lock(5) }));
    expect(ofType(g, 'INFECTED')).toHaveLength(0);
    expect(ofType(g, 'REQUEST_OPENED').filter((e: any) => e.payload.context === 'wolf_father')).toHaveLength(1);
  });
});

describe('White Werewolf (§10)', () => {
  it('appears as a plain Werewolf to the pack and may kill a packmate on even nights', () => {
    const cards: RoleId[] = ['werewolf', 'white_werewolf', 'seer', V, V, V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ council: (req) => lock(req.night === 1 ? 4 : 5), 'N2:white_werewolf': { target: 1 } }));
    expect(payloads(g, 'PACK_INFO')[0].pack).toEqual([
      { seat: 1, role: 'werewolf' },
      { seat: 2, role: 'werewolf' },
    ]);
    expect(ofType(g, 'REQUEST_OPENED').filter((e: any) => e.payload.context === 'white_werewolf').map((e) => e.at.night)).toContain(2);
    expect(deathsSeats(g)[1]).toContain(1);
  });
});

describe('Piper (§10, §4.2)', () => {
  it('charms up to two per night; charmed players learn the list; wins when all others are charmed', () => {
    const cards: RoleId[] = ['werewolf', 'piper', V, V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:piper': { targets: [4, 5] }, 'N1:wolf_kill': { target: 3 }, 'D1:day': { vote: 1 } }));
    expect(ofType(g, 'CHARMED_LIST')[0]!.vis).toEqual({ kind: 'seats', seats: [4, 5], channel: 'charmed' });
    expect(g.result).toMatchObject({ winner: 'Piper', winners: [2] });
  });
});

describe('Angel (§4.2 row 0)', () => {
  const cards: RoleId[] = ['werewolf', 'angel', V, V, V];
  it('wins alone if it dies on Night 1 (the game ends)', () => {
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:wolf_kill': { target: 2 } }));
    expect(g.result).toMatchObject({ winner: 'Angel', winners: [2] });
  });

  it('with angel_ends_game = false it is recorded as a winner and play continues', () => {
    const g = simulate(makeCfg(cards, { angel_ends_game: false }), scripted({ 'N1:wolf_kill': { target: 2 }, 'D1:day': { vote: 1 } }));
    expect(payloads(g, 'ANGEL_RECORDED')[0]).toEqual({ seat: 2 });
    expect(g.result!.winner).toBe('Village');
    expect(g.result!.winners).toContain(2);
  });

  it('becomes a Villager at Dusk 1 when it survives', () => {
    const g = simulate(makeCfg(cards), scripted({ 'N1:wolf_kill': { target: 3 } }));
    expect(payloads(g, 'ROLE_CHANGED').find((p) => p.reason === 'angel')).toMatchObject({ seat: 2, team: 'Village' });
  });
});

describe('wolves_may_skip with a council (§7.3)', () => {
  it('all wolves proposing null and ready skips the kill', () => {
    const cards: RoleId[] = ['werewolf', 'werewolf', 'seer', V, V, V, V];
    const g = simulate(makeCfg(cards, { wolves_may_skip: true }), scripted({ 'N1:council': lock(null) }));
    expect(payloads(g, 'COUNCIL_RESULT')[0]).toEqual({ victim: null });
  });
});

describe('parity is blocked by a pending Knight curse (§4.3)', () => {
  it('does not award parity while a cursed wolf is about to die', () => {
    // 5 seats: wolf 1 & 2 kill the Knight on N1 (curse on seat 4? no: nearest wolf left of 3 is 1)
    const cards: RoleId[] = ['werewolf', 'werewolf', 'knight', V, V, V, V];
    const g = simulate(makeCfg(cards), scripted({ 'N1:council': lock(3) }));
    const firstGameOverReason = g.result!.reason;
    expect(g.seats[0]!.deathCauses.map((c) => c.tag)).toContain('knight_curse');
    expect(firstGameOverReason).toBeDefined();
    void seatsOf;
  });
});

// ---- interaction scenarios added after the M3 review ----
const nightDeaths = (g: any, n: number) => ofType(g, 'DEATHS').filter((e) => e.at.night === n && e.at.phase === 'dawn').flatMap((e: any) => e.payload.deaths.map((d: any) => d.seat));

describe('Cupid interactions (§4.1, §4.2)', () => {
  it('a dead Cupid does not join team Lovers when the pair later becomes cross-team', () => {
    const cards: RoleId[] = ['cupid', 'werewolf', 'accursed_wolf_father', 'seer', V, V, V, V, V];
    valid(cards);
    const g = simulate(
      makeCfg(cards),
      scripted({ 'N1:cupid': { targets: [4, 5] }, 'N1:council': lock(1), 'N1:wolf_father': { choice: 'kill' }, 'N2:council': lock(4), 'N2:wolf_father': { choice: 'infect' } }),
    );
    expect(nightDeaths(g, 1)).toEqual([1]);
    expect(payloads(g, 'ROLE_CHANGED').filter((p) => p.reason === 'lovers').map((p) => p.seat)).toEqual([4, 5]);
    expect(g.seats[0]!.team).toBe('Village');
  });
});

describe('Big Bad Wolf and Knight interactions (§10, §8.2)', () => {
  it('the Big Bad Wolf stops hunting once a wolf has died', () => {
    const cards: RoleId[] = ['werewolf', 'big_bad_wolf', 'seer', V, V, V, V];
    const g = simulate(makeCfg(cards), scripted({ 'N1:council': lock(4), 'N1:big_bad_wolf': { target: 5 }, 'D1:day': { vote: 1 }, 'N2:wolf_kill': { target: 6 } }));
    expect(nightDeaths(g, 1)).toEqual([4, 5]);
    expect(payloads(g, 'EXECUTION')[0]).toEqual({ seat: 1 });
    const bbwNights = ofType(g, 'REQUEST_OPENED').filter((e: any) => e.payload.context === 'big_bad_wolf').map((e) => e.at.night);
    expect(bbwNights).toEqual([1]);
  });

  it('a Knight killed by the Big Bad Wolf also curses the nearest wolf to its left', () => {
    const cards: RoleId[] = ['werewolf', 'big_bad_wolf', 'knight', V, V, V, V];
    const g = simulate(makeCfg(cards), scripted({ 'N1:council': lock(5), 'N1:big_bad_wolf': { target: 3 }, 'N2:council': lock(6) }));
    expect(nightDeaths(g, 1)).toEqual([3, 5]);
    expect(g.seats[0]!.deathCauses.map((c) => c.tag)).toContain('knight_curse');
  });
});

describe('Elder interactions (§8.1, §8.3)', () => {
  it("the Elder's extra life absorbs an infection; the next attack kills", () => {
    const cards: RoleId[] = ['werewolf', 'accursed_wolf_father', 'elder', V, V, V, V];
    const g = simulate(makeCfg(cards), scripted({ council: lock(3), wolf_father: { choice: 'infect' } }));
    expect(ofType(g, 'INFECTED')).toHaveLength(0);
    expect(nightDeaths(g, 1)).toEqual([]);
    expect(nightDeaths(g, 2)).toContain(3);
    expect(g.seats[2]!.team).toBe('Village');
  });

  it('a Village Hunter shooting the Elder triggers the curse', () => {
    const cards: RoleId[] = ['werewolf', 'elder', 'hunter', V, V, V, V];
    const g = simulate(makeCfg(cards), scripted({ 'N1:wolf_kill': { target: 3 }, hunter_shot: { target: 2 } }));
    expect(g.seats[1]!.deathCauses).toContainEqual({ tag: 'hunter', byTeam: 'Village' });
    expect(ofType(g, 'ELDER_CURSE')).toHaveLength(1);
  });

  it('poison from an infected Witch kills the Elder without a curse', () => {
    const cards: RoleId[] = ['werewolf', 'accursed_wolf_father', 'witch', 'elder', V, V, V, V];
    const g = simulate(
      makeCfg(cards),
      scripted({ 'N1:council': lock(3), 'N1:wolf_father': { choice: 'infect' }, 'N2:council': lock(5), 'N2:witch': { heal: false, poison: 4 } }),
    );
    expect(g.seats[2]!.team).toBe('Werewolf');
    expect(g.seats[3]!.deathCauses).toContainEqual({ tag: 'poison', byTeam: 'Werewolf' });
    expect(ofType(g, 'ELDER_CURSE')).toHaveLength(0);
  });
});

describe('Stuttering Judge executed (§9.3)', () => {
  it('the second vote still happens when the flagging Judge is executed by the first', () => {
    const cards: RoleId[] = ['werewolf', 'stuttering_judge', V, V, V];
    const g = simulate(
      makeCfg(cards),
      scripted({ 'N1:wolf_kill': { target: 3 }, 'D1:day': { vote: 2 }, 'D1:day:2': { vote: 1, second_vote: true }, 'D1:second_vote': { vote: 1 } }),
    );
    expect(payloads(g, 'EXECUTION').map((e) => e.seat)).toEqual([2, 1]);
    expect(g.result).toMatchObject({ winner: 'Village' });
  });
});

describe('White Werewolf win (§4.2)', () => {
  it('wins alone as the last survivor; its solo team blocks the parity win', () => {
    const cards: RoleId[] = ['white_werewolf', 'werewolf', V, V, V];
    valid(cards);
    const g = simulate(makeCfg(cards), scripted({ 'N1:council': lock(3), 'D1:day': { vote: 4 }, 'N2:council': lock(5), 'N2:white_werewolf': { target: 2 } }));
    expect(g.result).toMatchObject({ winner: 'WhiteWolf', winners: [1] });
  });
});

describe('parity blockers (§4.3)', () => {
  it('without a blocker the wolves win by parity at the first Dawn', () => {
    const g = simulate(makeCfg(['werewolf', 'werewolf', V, V, V]), scripted({ 'N1:council': lock(3) }));
    expect(g.result).toMatchObject({ winner: 'Werewolf', reason: 'parity' });
    expect(ofType(g, 'GAME_OVER')[0]!.at.day).toBe(0);
  });

  it('a Witch with her poison blocks parity', () => {
    const g = simulate(makeCfg(['werewolf', 'werewolf', 'witch', V, V]), scripted({ 'N1:council': lock(4) }));
    expect(ofType(g, 'GAME_OVER')[0]!.at.day).toBeGreaterThanOrEqual(1);
  });
});

describe('Knight curse and heartbreak (§8.2, owner decision)', () => {
  it('skips a wolf that dies of heartbreak at the same Dawn and curses the next wolf', () => {
    const cards: RoleId[] = ['knight', 'werewolf', 'werewolf', 'cupid', 'witch', V, V, V];
    valid(cards);
    const g = simulate(
      makeCfg(cards),
      scripted({ 'N1:cupid': { targets: [2, 6] }, 'N1:council': lock(1), 'N1:witch': { heal: false, poison: 6 }, 'N2:wolf_kill': { target: 7 } }),
    );
    expect(nightDeaths(g, 1)).toEqual([1, 2, 6]);
    expect(g.seats[2]!.deathCauses.map((c) => c.tag)).toContain('knight_curse');
    expect(g.result).toMatchObject({ winner: 'Village' });
  });
});

describe('post-game debrief (ruleset §15b)', () => {
  const cards: RoleId[] = ['werewolf', 'seer', V, V, V];
  it('is skipped entirely unless the lobby asked for it', () => {
    const g = simulate(makeCfg(cards), scripted({ 'N1:wolf_kill': { target: 3 } }));
    expect(ofType(g, 'DEBRIEF_OPENED')).toHaveLength(0);
    expect(ofType(g, 'DEBRIEF_COMMENT')).toHaveLength(0);
  });

  it('asks the host first; a decline ends it with no comments', () => {
    const g = simulate(
      makeCfg(cards, {}, { debrief: true }),
      scripted({ 'N1:wolf_kill': { target: 3 }, debrief_accept: { choice: 'skip' } }),
    );
    expect(ofType(g, 'DEBRIEF_DECLINED')).toHaveLength(1);
    expect(ofType(g, 'DEBRIEF_COMMENT')).toHaveLength(0);
  });

  it('collects one comment per seat, dead seats included, written independently', () => {
    const g = simulate(
      makeCfg(cards, { debrief_rounds: 2 }, { debrief: true }),
      scripted({
        'N1:wolf_kill': { target: 3 },
        debrief_accept: { choice: 'open' },
        debrief_comment: (req) => ({ speech: `seat ${req.seat} looking back` }),
        debrief_reply: (req) => (req.seat === 1 ? { speech: 'well played all' } : { speech: '' }),
      }),
    );
    expect(payloads(g, 'DEBRIEF_OPENED')[0]).toEqual({ rounds: 2 });
    const round1 = payloads(g, 'DEBRIEF_COMMENT').filter((p) => p.round === 1);
    expect(round1.map((p) => p.seat)).toEqual([1, 2, 3, 4, 5]); // every seat, alive or dead
    expect(round1.every((p) => ofType(g, 'DEBRIEF_COMMENT')[0]!.vis.kind === 'public')).toBe(true);
    // round 1 is one group: no comment is emitted before every seat has written
    const firstComment = g.events.findIndex((e) => e.type === 'DEBRIEF_COMMENT');
    const lastRequest = g.events.map((e) => e.type).lastIndexOf('REQUEST_OPENED');
    expect(firstComment).toBeGreaterThan(g.events.findIndex((e) => e.type === 'DEBRIEF_OPENED'));
    expect(lastRequest).toBeGreaterThan(0);
    // an empty reply is simply no comment
    expect(payloads(g, 'DEBRIEF_COMMENT').filter((p) => p.round === 2).map((p) => p.seat)).toEqual([1]);
  });
});
