import type { RoleId } from '@ww/shared';
import type { Game, SeatState, TriggerKind } from './types';

/**
 * Role behaviour registry (ARCHITECTURE.md §5.4, as implemented in v1.8).
 *
 * The core script owns the cross-cutting algorithms (absorption order, death batches,
 * FIFO trigger queue, tally, win table, parity). Roles plug in at these named call sites;
 * night actions are step providers in night.ts (NIGHT_STEPS).
 */
export interface RoleBehavior {
  /** Initial ability uses (setup, and when a Thief takes the card). */
  initialUses?: () => Record<string, number>;
  /** Triggers enqueued when this seat dies while powered (death batch step 5). */
  deathTriggers?: (g: Game, s: SeatState) => TriggerKind[];
  /** True when this living, powered, Village-team seat can still turn a parity situation (§4.3). */
  blocksParity?: (g: Game, s: SeatState) => boolean;
}

export const ROLE_BEHAVIOR: Partial<Record<RoleId, RoleBehavior>> = {
  witch: {
    initialUses: () => ({ heal: 1, poison: 1 }),
    blocksParity: (_g, s) => (s.uses.poison ?? 0) > 0,
  },
  hunter: {
    deathTriggers: () => ['hunter_shot'],
    blocksParity: () => true,
  },
  raven: { blocksParity: () => true },
  stuttering_judge: {
    initialUses: () => ({ judge: 1 }),
    blocksParity: (_g, s) => (s.uses.judge ?? 0) > 0,
  },
  elder: { initialUses: () => ({ elder_life: 1 }) },
  village_idiot: { initialUses: () => ({ idiot_immunity: 1 }) },
  accursed_wolf_father: { initialUses: () => ({ infect: 1 }) },
};

export const behaviorOf = (role: RoleId): RoleBehavior => ROLE_BEHAVIOR[role] ?? {};
export const initialUsesOf = (role: RoleId): Record<string, number> => behaviorOf(role).initialUses?.() ?? {};

/** Title modules work like roles but attach to any seat. */
export const SHERIFF_TITLE = {
  /** Vote weight in execution ballots (§9.1). */
  voteWeight: (s: SeatState) => (s.sheriff ? 2 : 1),
  deathTriggers: (s: SeatState): TriggerKind[] => (s.sheriff ? ['sheriff_successor'] : []),
  blocksParity: (s: SeatState) => s.sheriff && s.team === 'Village',
};

/** A living seat holding `role` whose powers are active. */
export const powered = (g: Game, role: RoleId): SeatState | undefined => g.seats.find((s) => s.alive && s.role === role && s.powersActive);
