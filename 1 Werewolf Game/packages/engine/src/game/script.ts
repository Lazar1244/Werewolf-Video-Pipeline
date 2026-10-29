import { ROLE_IDS, ROLES, type DecisionRequest, type GameConfig, type RoleId, type SeatId } from '@ww/shared';
import { createRng, nextInt, shuffle, type RngState } from '../rng';
import { PUBLIC, SPECTATOR, emit, toSeats } from './core';
import { dawn } from './dawn';
import { debrief } from './debrief';
import { day, dusk } from './day';
import { night } from './night';
import { initialUsesOf } from './roles';
import type { Asker, Game, SeatState } from './types';

/** Thrown by the replay asker when a group still lacks answers. */
export class Suspend {
  constructor(readonly requests: DecisionRequest[]) {}
}

/** Every role of the ruleset §10 catalogue is implemented (M3). */
export const SUPPORTED_ROLES: ReadonlySet<string> = new Set(ROLE_IDS);

/**
 * Deal (ruleset §6 step 2). Without a Thief: shuffle and deal. With a Thief (N+2 cards):
 * the Thief card, the Sister cards and one wolf-nature card (preferring a non-White
 * Werewolf) are always dealt; 2 of the remaining cards become the extras.
 * With `fixedDeal` or `manualDeal` (the host's own deal), seat i gets card i and the last two
 * cards are the extras.
 */
function deal(rng: RngState, cfg: GameConfig): { cards: RoleId[]; extras: RoleId[] } {
  const n = cfg.seats;
  const fixed = cfg.fixedDeal || cfg.manualDeal;
  if (!cfg.cards.includes('thief')) {
    return { cards: fixed ? [...cfg.cards] : shuffle(rng, cfg.cards), extras: [] };
  }
  if (fixed) return { cards: cfg.cards.slice(0, n), extras: cfg.cards.slice(n, n + 2) };
  const rest = [...cfg.cards];
  const mustDeal: RoleId[] = [];
  const take = (pred: (r: RoleId) => boolean) => {
    const i = rest.findIndex(pred);
    if (i >= 0) mustDeal.push(rest.splice(i, 1)[0]!);
  };
  take((r) => r === 'thief');
  while (rest.includes('two_sisters')) take((r) => r === 'two_sisters');
  const wolves = rest.filter((r) => ROLES[r].wolfNature);
  const preferred = wolves.filter((r) => r !== 'white_werewolf');
  const pool = preferred.length ? preferred : wolves;
  if (pool.length) {
    const chosen = pool[nextInt(rng, pool.length)]!;
    take((r) => r === chosen);
  }
  const shuffled = shuffle(rng, rest);
  const extras = shuffled.slice(0, 2);
  mustDeal.push(...shuffled.slice(2));
  return { cards: shuffle(rng, mustDeal), extras };
}

/**
 * Setup (ruleset §6): shuffle slots onto seats, deal cards and names, announce the composition.
 * A host's own deal (`manualDeal`) keeps slot i at seat i with card i; only the names are shuffled.
 */
export function setup(cfg: GameConfig, asker: Asker): Game {
  const rng = createRng(cfg.seed);
  const n = cfg.seats;
  const slots = Array.from({ length: n }, (_, i) => i + 1);
  const seatSlots = cfg.fixedDeal || cfg.manualDeal ? slots : shuffle(rng, slots);
  const { cards, extras } = deal(rng, cfg);
  const names = cfg.fixedDeal ? cfg.names.slice(0, n) : shuffle(rng, cfg.names).slice(0, n);
  const human = new Set(cfg.humanSlots);
  const seats: SeatState[] = seatSlots.map((slot, i) => {
    const role = cards[i]!;
    const meta = ROLES[role];
    return {
      seat: i + 1,
      slot,
      name: names[i]!,
      human: human.has(slot),
      role,
      originalRole: role,
      team: meta.startingTeam === 'Varies' ? 'Village' : meta.startingTeam,
      wolfNature: meta.wolfNature,
      alive: true,
      powersActive: true,
      uses: initialUsesOf(role),
      sheriff: false,
      canVote: true,
      voteBannedToday: false,
      voteBannedNextDay: false,
      loverId: null,
      charmed: false,
      infectedOn: null,
      knightCursedAt: null,
      roleModel: null,
      convertedWolf: false,
      judgeFlagToday: false,
      challengesLeft: cfg.rules.challenges_per_player ?? 0, // missing in games frozen before Challenges: none
      diedOn: null,
      deathCauses: [],
      teamAtDeath: null,
    };
  });
  const g: Game = {
    cfg,
    seats,
    rng,
    phase: 'setup',
    day: 0,
    night: 0,
    events: [],
    reqSeq: 0,
    groupSeq: 0,
    lastProtected: null,
    packLeader: null,
    ravenMark: null,
    wolfHasDied: false,
    thiefExtras: extras,
    angelRecordedWinner: false,
    cupid: null,
    loversCrossTeam: false,
    cyclesWithoutDeath: 0,
    deathThisCycle: false,
    triggers: [],
    scapegoatTieExecution: null,
    result: null,
    asker,
  };
  const composition = [...cfg.cards].sort();
  emit(g, 'GAME_START', { seats: seats.map((s) => ({ seat: s.seat, name: s.name })), composition, extras: extras.length, rules: cfg.rules }, PUBLIC);
  emit(g, 'SEATING', { seats: seats.map((s) => ({ seat: s.seat, slot: s.slot, human: s.human })) }, SPECTATOR);
  for (const s of seats) emit(g, 'ROLE_ASSIGNED', { seat: s.seat, role: s.role, team: s.team }, toSeats([s.seat as SeatId]));
  return g;
}

/** Run the game script until it ends or needs answers it does not have (Suspend). */
export function runScript(cfg: GameConfig, asker: Asker): { game: Game; suspended: DecisionRequest[] | null } {
  const g = setup(cfg, asker);
  try {
    for (;;) {
      g.night++;
      const na = night(g);
      if (dawn(g, na)) break;
      g.day++;
      if (day(g)) break;
      if (dusk(g)) break;
    }
    debrief(g); // ruleset §15b, only when the lobby asked for it
    return { game: g, suspended: null };
  } catch (e) {
    if (e instanceof Suspend) return { game: g, suspended: e.requests };
    throw e;
  }
}
