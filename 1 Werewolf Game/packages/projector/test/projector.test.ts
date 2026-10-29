import { describe, expect, it } from 'vitest';
import { randomBot, simulate, type Game } from '@ww/engine';
import { RulesSchema, layerRules, resolveSentinels, type EngineEvent, type GameConfig, type RoleId, type SeatId } from '@ww/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { project, visibleTo } from '../src/project';
import { reduceView } from '../src/view';
import { describe as describeEvent, describeFor } from '../src/describe';

const ROOT = join(import.meta.dirname, '../../..');
const DEFAULT_RULES = RulesSchema.parse(JSON.parse(readFileSync(join(ROOT, 'config/rules/default.json'), 'utf8')));
const NAMES = ['Alba', 'Bram', 'Cora', 'Dario', 'Elin', 'Fenn', 'Greta', 'Hugo', 'Ines', 'Jonas'];

function cfg(cards: RoleId[], seed = 'proj'): GameConfig {
  const seats = cards.includes('thief') ? cards.length - 2 : cards.length;
  return { seed, seats, cards, rules: resolveSentinels(layerRules(DEFAULT_RULES), seats), names: NAMES, maskNames: [], humanSlots: [] };
}

const play = (cards: RoleId[], seed: string): Game => simulate(cfg(cards, seed), randomBot(seed));

const CLASSIC: RoleId[] = ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'protector', 'villager', 'villager'];
const FULL: RoleId[] = ['werewolf', 'accursed_wolf_father', 'white_werewolf', 'seer', 'witch', 'cupid', 'little_girl', 'piper', 'elder', 'two_sisters'];

describe('Projector visibility (ARCHITECTURE.md §6.1)', () => {
  it('a seat sees public events plus its own, and nothing else', () => {
    const g = play(CLASSIC, 'vis1');
    for (let seat = 1 as SeatId; seat <= g.seats.length; seat++) {
      const mine = project(g.events, { kind: 'seat', seat }, false);
      for (const e of g.events) {
        const shouldSee = e.vis.kind === 'public' || (e.vis.kind === 'seats' && e.vis.seats.includes(seat));
        expect(visibleTo(e, { kind: 'seat', seat }, false)).toBe(shouldSee);
      }
      expect(mine.map((e) => e.vseq)).toEqual(mine.map((_, i) => i + 1)); // contiguous per viewer
      expect(mine.every((e) => e.at.step === undefined)).toBe(true); // night sub-steps are spectator-only
    }
  });

  it('the public view never contains a role before it is revealed, for any game', () => {
    const secrets = ['ROLE_ASSIGNED', 'ROLE_CHANGED', 'SEER_RESULT', 'PACK_INFO', 'COUNCIL_MSG', 'SEAT_THOUGHTS', 'THIEF_OFFER', 'LOVER_INFO', 'CHARMED_LIST', 'INFECTED'];
    for (let i = 0; i < 40; i++) {
      const g = play(i % 2 ? CLASSIC : FULL, `pub-${i}`);
      const pub = project(g.events, { kind: 'public' }, false);
      expect(pub.some((e) => secrets.includes(e.type))).toBe(false);
      expect(pub.every((e) => e.private === undefined)).toBe(true);
    }
  });

  it('a spectator sees only the public view until the lock opens, then everything', () => {
    const g = play(CLASSIC, 'lock');
    expect(project(g.events, { kind: 'spectator' }, false).length).toBe(project(g.events, { kind: 'public' }, false).length);
    expect(project(g.events, { kind: 'spectator' }, true).length).toBe(g.events.length);
  });

  it('every seat view is a subset of the spectator view, and payloads are untouched', () => {
    const g = play(FULL, 'subset');
    const spec = project(g.events, { kind: 'spectator' }, true);
    const seat1 = project(g.events, { kind: 'seat', seat: 1 }, false);
    for (const e of seat1) expect(spec.some((s) => s.type === e.type && JSON.stringify(s.payload) === JSON.stringify(e.payload))).toBe(true);
  });
});

describe('reduceView (the UI and context state)', () => {
  it('tracks a seat: its role, pack, deaths and the public table', () => {
    const g = play(CLASSIC, 'red1');
    const wolf = g.seats.find((s) => s.role === 'werewolf')!.seat as SeatId;
    const v = reduceView(project(g.events, { kind: 'seat', seat: wolf }, false), wolf);
    expect(v.me!.role).toBe('werewolf');
    expect(v.me!.team).toBe('Werewolf');
    expect(v.me!.wolfNature).toBe(true);
    expect(v.me!.pack.every((p) => g.seats[p.seat - 1]!.wolfNature)).toBe(true);
    expect(v.table).toHaveLength(g.seats.length);
    // the table matches the real game for everything that was revealed publicly
    for (const s of g.seats) expect(v.table[s.seat - 1]!.alive).toBe(s.alive);
    expect(v.result?.winner).toBe(g.result!.winner);
  });

  it('a Villager learns no other role except through public reveals', () => {
    const g = play(CLASSIC, 'red2');
    const villager = g.seats.find((s) => s.role === 'villager')!.seat as SeatId;
    // stop before the end-of-game reveal, which shows every role to everyone
    const untilEnd = g.events.slice(0, g.events.findIndex((e) => e.type === 'GAME_OVER'));
    const v = reduceView(project(untilEnd, { kind: 'seat', seat: villager }, false), villager);
    expect(v.me!.pack).toEqual([]);
    for (const t of v.table) {
      if (t.seat === villager || !t.revealed) continue;
      // living players are only ever revealed by the Village Idiot rule
      expect(g.seats[t.seat - 1]!.alive ? t.revealed.role : 'village_idiot').toBe('village_idiot');
    }
  });

  it('the Witch view records which potions are gone', () => {
    const g = simulate(cfg(CLASSIC, 'witch'), (req, game) => {
      if (req.kind === 'witch') return { kind: 'decision', decision: { heal: req.legal.canHeal === true, poison: null } };
      return randomBot('w')(req, game);
    });
    const witch = g.seats.find((s) => s.role === 'witch')!.seat as SeatId;
    const v = reduceView(project(g.events, { kind: 'seat', seat: witch }, false), witch);
    expect(v.me!.usedHeal).toBe(true);
  });
});

describe('describe()', () => {
  it('gives text for every public event type of a full game', () => {
    const g = play(FULL, 'desc');
    const name = (n: number) => NAMES[n - 1]!;
    const pub = project(g.events, { kind: 'public' }, false);
    const kinds = new Set(pub.map((e) => e.type));
    for (const e of pub) {
      const text = describeEvent(e as unknown as EngineEvent, name);
      if (['REQUEST_OPENED', 'REQUEST_CLOSED', 'SPEECH', 'DAY_SUMMARY', 'SHERIFF_CANDIDACY'].includes(e.type)) continue;
      expect(text, `${e.type} has no text`).toBeTruthy();
    }
    expect(kinds.has('PHASE_START')).toBe(true);
  });
});

describe('describeFor(): a private notice re-told for another reader', () => {
  const name = (n: number) => NAMES[n - 1]!;
  const at = { phase: 'night' as const, day: 1, night: 1 };
  const entry = (type: string, payload: unknown, seats: SeatId[]) => ({ vseq: 1, at, type: type as never, payload, private: true, seats });

  /** One of every notice written in the second person, told about seat 3 (Cora). */
  const NOTICES: [string, unknown][] = [
    ['ROLE_ASSIGNED', { seat: 3, role: 'seer', team: 'Village' }],
    ['ROLE_CHANGED', { seat: 3, role: 'werewolf', team: 'Werewolf', wolfNature: true, reason: 'wolf_hound' }],
    ['PACK_INFO', { pack: [{ seat: 1, role: 'werewolf' }] }],
    ['SEER_RESULT', { target: 1, result: 'werewolf' }],
    ['FOX_RESULT', { target: 1, wolfAmong: false, lostPower: true }],
    ['WITCH_INFO', { attacked: 2 }],
    ['LOVER_INFO', { partner: 4, partnerRole: 'witch' }],
    ['SISTER_INFO', { sister: 5 }],
    ['INFECTED', { seat: 3 }],
    ['NIGHT_ACTION', { role: 'seer', seat: 3, target: 1 }],
    ['LITTLE_GIRL_TRANSCRIPT', { messages: [{ speaker: 'wolf', text: 'take Elin' }], victim: 5 }],
    ['THIEF_OFFER', { extras: ['villager', 'witch'] }],
  ];

  it('never leaves the second person in a notice about somebody else', () => {
    for (const [type, payload] of NOTICES) {
      const e = entry(type, payload, [3 as SeatId]);
      const told = describeFor(e, name, null, e.seats);
      expect(told, type).toBeTruthy();
      expect(told!, type).not.toMatch(/\b[Yy]ou\b|\b[Yy]our\b/);
    }
  });

  it('leaves the reader their own notice exactly as it was written to them', () => {
    for (const [type, payload] of NOTICES) {
      const e = entry(type, payload, [3 as SeatId]);
      expect(describeFor(e, name, 3 as SeatId, e.seats), type).toBe(describeEvent(e, name));
    }
  });

  it('names the player a re-told notice belongs to', () => {
    const e = entry('SEER_RESULT', { target: 1, result: 'not_werewolf' }, [3 as SeatId]);
    expect(describeFor(e, name, null, e.seats)).toBe(`${NAMES[2]!}'s vision: ${NAMES[0]!} is not a werewolf.`);
    const love = entry('LOVER_INFO', { partner: 4 }, [3 as SeatId]);
    expect(describeFor(love, name, null, love.seats)).toContain(`Cupid made ${NAMES[2]!} fall in love with ${NAMES[3]!}`);
  });

  /** The recipients come from the entry, because most payloads do not say who was told. */
  it('carries the real recipients rather than guessing them from the payload', () => {
    const g = play(FULL, 'tell1');
    const seer = g.seats.find((x) => x.role === 'seer')!.seat as SeatId;
    const result = project(g.events, { kind: 'spectator' }, true).find((e) => e.type === 'SEER_RESULT');
    expect(result?.payload).not.toHaveProperty('seat'); // nothing in the payload identifies the Seer
    expect(result?.seats).toEqual([seer]);
    expect(describeFor(result!, name, null, result!.seats)).toContain(`${name(seer)}'s vision`);
  });

  it('holds for every private notice a real game produces', () => {
    for (const seed of ['tell1', 'tell2', 'tell3']) {
      const g = play(FULL, seed);
      for (const e of project(g.events, { kind: 'spectator' }, true)) {
        if (!e.private) continue;
        const told = describeFor(e, name, null, e.seats);
        if (told === null) continue;
        expect(told, `${e.type}: ${told}`).not.toMatch(/\b[Yy]ou\b|\b[Yy]our\b/);
      }
    }
  });

  it('a notice to a whole channel is told about the group, and left alone for a member', () => {
    const g = play(FULL, 'tell1');
    const packInfo = project(g.events, { kind: 'spectator' }, true).find((e) => e.type === 'PACK_INFO')!;
    expect(describeFor(packInfo, name, null, packInfo.seats)).toMatch(/^The pack: /);
    expect(describeFor(packInfo, name, packInfo.seats![0]!, packInfo.seats)).toMatch(/^Your pack: /);
  });
});

describe('a spectator reads the table, not only the log', () => {
  it('knows each seat\u2019s card once the game is open to them, and a seat never does', () => {
    const g = play(CLASSIC, 'spec1');
    const spec = reduceView(project(g.events, { kind: 'spectator' }, true), null);
    for (const s of g.seats) expect(spec.table[s.seat - 1]!.known?.role, `seat ${s.seat}`).toBe(s.role);

    const seat = 1 as SeatId;
    const mine = reduceView(project(g.events, { kind: 'seat', seat }, false), seat);
    for (const p of mine.table) if (p.seat !== seat) expect(p.known).toBeUndefined();
  });

  it('shows nothing extra while the lock is closed', () => {
    const g = play(CLASSIC, 'spec1');
    const closed = reduceView(project(g.events, { kind: 'spectator' }, false), null);
    for (const p of closed.table) expect(p.known).toBeUndefined();
  });
});
