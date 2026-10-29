import type { EnginePayload, EngineEventType, Phase, RoleId, SeatId, Team } from '@ww/shared';
import { ROLES } from '@ww/shared/roles';
import type { ViewEntry } from './project';

/**
 * reduceView (ARCHITECTURE.md §4.4): folds one viewer's entries into the current state
 * that viewer knows. It uses only the entries it is given, so a seat view can never
 * contain what the seat was not told.
 */
export interface SeatPublic {
  seat: SeatId;
  name: string;
  alive: boolean;
  /** Revealed on death (ruleset §8.3): the role (and whether it was infected), a team, or nothing. */
  revealed: { role?: RoleId; team?: Team; infected?: boolean } | null;
  /**
   * The card this viewer has been *told* this seat holds while it is still secret from the
   * table — a spectator's feed once the game is open to them. Never set for a seat's own view,
   * because a seat is never sent another seat's card.
   */
  known?: { role: RoleId; team: Team; infected?: boolean };
  sheriff: boolean;
  /** False once the Village Idiot has been revealed. */
  canVote: boolean;
  /** True when a Scapegoat ruling bars this seat from voting today. */
  voteBanned: boolean;
  /** Marked by the Raven for today's vote (+2). */
  marked: boolean;
}

export interface MyState {
  seat: SeatId;
  name: string;
  role: RoleId;
  team: Team;
  wolfNature: boolean;
  alive: boolean;
  powersActive: boolean;
  infected: boolean;
  lover: { seat: SeatId; role?: RoleId } | null;
  sister: SeatId | null;
  /** Werewolf packmates this seat has been told about (living ones). */
  pack: { seat: SeatId; role: RoleId }[];
  charmed: boolean;
  /** Seats this seat knows are charmed (charmed players and the Piper). */
  charmedKnown: SeatId[];
  /** Witch potions already used. */
  usedHeal: boolean;
  usedPoison: boolean;
}

export interface VoteTable {
  day: number;
  context: string;
  ballots: { voter: SeatId; vote: SeatId | 'abstain'; weight: number }[];
  scores: Record<string, number>;
  abstain: number;
  raven: SeatId | null;
}

export interface DeathRecord {
  seat: SeatId;
  phase: Phase;
  day: number;
  night: number;
  revealed: SeatPublic['revealed'];
}

export interface GameView {
  phase: Phase;
  day: number;
  night: number;
  composition: RoleId[];
  extras: number;
  rules: Record<string, unknown>;
  table: SeatPublic[];
  sheriff: SeatId | null;
  ravenMark: SeatId | null;
  /** Latest bear notice: which day, and whether it growled. */
  bear: { day: number; growls: boolean } | null;
  votes: VoteTable[];
  deaths: DeathRecord[];
  executions: { day: number; seat: SeatId; scapegoat: boolean }[];
  elderCurse: boolean;
  result: { winner: string; winners: SeatId[]; reason: string } | null;
  /** Present for a seat view. */
  me: MyState | null;
}

type P<T extends EngineEventType> = EnginePayload<T>;

export function reduceView(entries: readonly ViewEntry[], seat: SeatId | null = null): GameView {
  const v: GameView = {
    phase: 'setup',
    day: 0,
    night: 0,
    composition: [],
    extras: 0,
    rules: {},
    table: [],
    sheriff: null,
    ravenMark: null,
    bear: null,
    votes: [],
    deaths: [],
    executions: [],
    elderCurse: false,
    result: null,
    me: null,
  };
  let pendingVoters: SeatId[] | null = null;
  const bySeat = (n: SeatId) => v.table[n - 1]!;
  for (const e of entries) {
    v.phase = e.at.phase;
    v.day = e.at.day;
    v.night = e.at.night;
    const me = v.me;
    switch (e.type) {
      case 'GAME_START': {
        const p = e.payload as P<'GAME_START'>;
        v.composition = [...p.composition];
        v.extras = p.extras;
        v.rules = p.rules;
        v.table = p.seats.map((s) => ({ seat: s.seat, name: s.name, alive: true, revealed: null, sheriff: false, canVote: true, voteBanned: false, marked: false }));
        break;
      }
      case 'ROLE_ASSIGNED': {
        const p = e.payload as P<'ROLE_ASSIGNED'>;
        // A viewer with no seat only ever receives this once the game is open to them (§9),
        // so what they were told can be shown on the table instead of only in the log.
        if (seat === null && v.table[p.seat - 1]) bySeat(p.seat).known = { role: p.role, team: p.team };
        if (seat !== null && p.seat === seat) {
          v.me = {
            seat,
            name: bySeat(seat).name,
            role: p.role,
            team: p.team,
            wolfNature: ROLES[p.role].wolfNature,
            alive: true,
            powersActive: true,
            infected: false,
            lover: null,
            sister: null,
            pack: [],
            charmed: false,
            charmedKnown: [],
            usedHeal: false,
            usedPoison: false,
          };
        }
        break;
      }
      case 'ROLE_CHANGED': {
        const p = e.payload as P<'ROLE_CHANGED'>;
        if (seat === null && v.table[p.seat - 1]) {
          const k = bySeat(p.seat).known;
          bySeat(p.seat).known = { role: p.role, team: p.team, ...(k?.infected ? { infected: true } : {}) };
        }
        if (me && p.seat === me.seat) {
          me.role = p.role;
          me.team = p.team;
          me.wolfNature = p.wolfNature;
          if (p.role === 'piper' && p.team !== 'Piper') me.powersActive = false;
        }
        break;
      }
      case 'INFECTED': {
        const p = e.payload as P<'INFECTED'>;
        if (me && p.seat === me.seat) me.infected = true;
        const k = seat === null ? bySeat(p.seat).known : undefined;
        if (k) k.infected = true;
        break;
      }
      case 'PACK_INFO':
        if (me) me.pack = (e.payload as P<'PACK_INFO'>).pack.filter((w) => w.seat !== me.seat).map((w) => ({ ...w }));
        break;
      case 'PACK_JOINED': {
        const p = e.payload as P<'PACK_JOINED'>;
        if (me) {
          if (p.seat !== me.seat && !me.pack.some((w) => w.seat === p.seat)) me.pack.push({ seat: p.seat, role: p.role });
          // the newcomer learns the Pack list (ruleset §4.1)
          if (p.seat === me.seat) for (const s of p.pack) if (s !== me.seat && !me.pack.some((w) => w.seat === s)) me.pack.push({ seat: s, role: 'werewolf' });
          me.pack.sort((a, b) => a.seat - b.seat);
        }
        break;
      }
      case 'LOVER_INFO': {
        const p = e.payload as P<'LOVER_INFO'>;
        if (me) me.lover = p.partnerRole ? { seat: p.partner, role: p.partnerRole } : { seat: p.partner };
        break;
      }
      case 'SISTER_INFO':
        if (me) me.sister = (e.payload as P<'SISTER_INFO'>).sister;
        break;
      case 'CHARMED_LIST': {
        const p = e.payload as P<'CHARMED_LIST'>;
        if (me) {
          me.charmedKnown = [...new Set([...me.charmedKnown, ...p.charmed])].sort((a, b) => a - b);
          if (p.charmed.includes(me.seat)) me.charmed = true;
        }
        break;
      }
      case 'NIGHT_ACTION': {
        const p = e.payload as P<'NIGHT_ACTION'>;
        if (me && p.seat === me.seat) {
          if (p.heal) me.usedHeal = true;
          if (p.poison) me.usedPoison = true;
          if (p.role === 'piper' && p.targets) me.charmedKnown = [...new Set([...me.charmedKnown, ...p.targets])].sort((a, b) => a - b);
        }
        break;
      }
      case 'FOX_RESULT':
        if (me && (e.payload as P<'FOX_RESULT'>).lostPower) me.powersActive = false;
        break;
      case 'ELDER_CURSE':
        v.elderCurse = true;
        if (me && me.team === 'Village') me.powersActive = false;
        break;
      case 'DEATHS':
        for (const d of (e.payload as P<'DEATHS'>).deaths) {
          const s = bySeat(d.seat);
          s.alive = false;
          s.revealed = d.reveal ? { ...d.reveal } : null;
          v.deaths.push({ seat: d.seat, phase: e.at.phase, day: e.at.day, night: e.at.night, revealed: s.revealed });
          if (me) {
            if (d.seat === me.seat) me.alive = false;
            me.pack = me.pack.filter((w) => w.seat !== d.seat);
          }
        }
        break;
      case 'SHERIFF_RESULT':
        setSheriff(v, (e.payload as P<'SHERIFF_RESULT'>).sheriff);
        break;
      case 'SHERIFF_CHANGE':
        setSheriff(v, (e.payload as P<'SHERIFF_CHANGE'>).to);
        break;
      case 'RAVEN_MARK':
        v.ravenMark = (e.payload as P<'RAVEN_MARK'>).seat;
        for (const s of v.table) s.marked = s.seat === v.ravenMark;
        break;
      case 'BEAR':
        v.bear = { day: e.at.day, growls: (e.payload as P<'BEAR'>).growls };
        break;
      case 'IDIOT_REVEALED': {
        const s = bySeat((e.payload as P<'IDIOT_REVEALED'>).seat);
        s.canVote = false;
        s.revealed = { role: 'village_idiot' };
        break;
      }
      case 'SCAPEGOAT_RULING':
        pendingVoters = [...(e.payload as P<'SCAPEGOAT_RULING'>).voters];
        break;
      case 'VOTES': {
        const p = e.payload as P<'VOTES'>;
        v.votes.push({ day: e.at.day, context: p.context, ballots: p.ballots.map((b) => ({ ...b })), scores: { ...p.scores }, abstain: p.abstain, raven: p.raven ?? null });
        break;
      }
      case 'EXECUTION': {
        const p = e.payload as P<'EXECUTION'>;
        v.executions.push({ day: e.at.day, seat: p.seat, scapegoat: p.scapegoat ?? false });
        break;
      }
      case 'PHASE_START': {
        const phase = (e.payload as P<'PHASE_START'>).phase;
        if (phase === 'day') {
          for (const s of v.table) s.voteBanned = pendingVoters !== null && !pendingVoters.includes(s.seat);
          pendingVoters = null;
        }
        if (phase === 'dusk' || phase === 'night') {
          for (const s of v.table) {
            s.voteBanned = false;
            s.marked = false;
          }
          v.ravenMark = null;
        }
        break;
      }
      case 'GAME_OVER': {
        const p = e.payload as P<'GAME_OVER'>;
        v.result = { winner: p.winner, winners: [...p.winners], reason: p.reason };
        break;
      }
      case 'FINAL_REVEAL':
        for (const r of (e.payload as P<'FINAL_REVEAL'>).seats) {
          const s = bySeat(r.seat);
          s.revealed = { role: r.role, team: r.team };
        }
        break;
    }
  }
  return v;
}

function setSheriff(v: GameView, seat: SeatId | null): void {
  v.sheriff = seat;
  for (const s of v.table) s.sheriff = s.seat === seat;
}
