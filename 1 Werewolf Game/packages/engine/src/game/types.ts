import type {
  Answer,
  AnyDecision,
  DecisionRequest,
  EngineEvent,
  GameConfig,
  Phase,
  RoleId,
  SeatId,
  Team,
} from '@ww/shared';
import type { RngState } from '../rng';

export type DeathCauseTag = 'attack' | 'bbw' | 'white_wolf' | 'poison' | 'knight_curse' | 'heartbreak' | 'hunter' | 'execution';

/** A death cause; poison and Hunter shots remember the actor's team at the moment of the action (§8.3). */
export interface DeathCause {
  tag: DeathCauseTag;
  byTeam?: Team;
}

/** Per-seat state (ruleset §3). */
export interface SeatState {
  seat: SeatId;
  slot: number;
  name: string;
  human: boolean;
  role: RoleId;
  /** Role held after the Thief step (used for reveals). */
  originalRole: RoleId;
  team: Team;
  wolfNature: boolean;
  alive: boolean;
  powersActive: boolean;
  uses: Record<string, number>;
  sheriff: boolean;
  canVote: boolean;
  voteBannedToday: boolean;
  voteBannedNextDay: boolean;
  loverId: SeatId | null;
  charmed: boolean;
  infectedOn: number | null;
  knightCursedAt: number | null;
  roleModel: SeatId | null;
  /** Wild Child converted / Wolf-Hound chose the wolves (Seer role-mode labels). */
  convertedWolf: boolean;
  judgeFlagToday: boolean;
  /** Challenges left this game (ruleset §9.2); kept apart from `uses` so a role change (Thief) never resets it. */
  challengesLeft: number;
  diedOn: { phase: Phase; n: number } | null;
  deathCauses: DeathCause[];
  teamAtDeath: Team | null;
}

export interface GameResult {
  winner: Team | 'draw';
  winners: SeatId[];
  reason: string;
}

/** A pending request before ids are assigned. */
export type RequestDraft = Omit<DecisionRequest, 'requestId' | 'groupId' | 'day' | 'night'>;

/** Supplies answers for a group of requests (replay: recorded answers; direct: callback). */
export interface Asker {
  ask(g: Game, requests: readonly DecisionRequest[]): Answer[];
}

export type TriggerKind = 'sheriff_successor' | 'hunter_shot' | 'wild_child_convert' | 'scapegoat_ruling';

export interface Trigger {
  kind: TriggerKind;
  seat: SeatId;
}

/** Mutable game state used by the script (global state of ruleset §3). Rebuilt on every run. */
export interface Game {
  cfg: GameConfig;
  seats: SeatState[];
  rng: RngState;
  phase: Phase;
  day: number;
  night: number;
  events: EngineEvent[];
  reqSeq: number;
  groupSeq: number;
  lastProtected: SeatId | null;
  packLeader: SeatId | null;
  ravenMark: SeatId | null;
  wolfHasDied: boolean;
  thiefExtras: RoleId[];
  angelRecordedWinner: boolean;
  /** Cupid's seat, once Cupid has acted. */
  cupid: SeatId | null;
  /** The Lovers pair has become cross-team (sticky). */
  loversCrossTeam: boolean;
  cyclesWithoutDeath: number;
  deathThisCycle: boolean;
  triggers: Trigger[];
  /** The Scapegoat was executed on an unresolved tie (enables its ruling trigger). */
  scapegoatTieExecution: SeatId | null;
  result: GameResult | null;
  asker: Asker;
}

export type Resolved = { decision: AnyDecision; fallback: boolean };
