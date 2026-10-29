import { z } from 'zod';
import { ROLE_IDS } from './roles';
import { RulesSchema } from './config/rules';
import { SlotIdSchema } from './events';

/** Rules after per-game sentinel resolution ("auto" / "N"). */
export const ResolvedRulesSchema = RulesSchema.extend({
  sheriff_enabled: z.boolean(),
  max_days: z.int().min(1).max(50),
});

/**
 * The engine's input for one game (a subset of the frozen snapshot, ARCHITECTURE.md §8).
 * The orchestrator builds it from config files + lobby at game start.
 */
export const GameConfigSchema = z.strictObject({
  seed: z.string().min(1),
  seats: z.int().min(5).max(10),
  cards: z.array(z.enum(ROLE_IDS)).min(5),
  rules: ResolvedRulesSchema,
  /** Display-name pool (at least `seats` names). */
  names: z.array(z.string().min(1)).min(5),
  /** Model/provider names masked in player text (ruleset §14.6). */
  maskNames: z.array(z.string()),
  /** Lobby slots played by humans (drives the spectator lock). */
  humanSlots: z.array(SlotIdSchema),
  /**
   * Offer the post-game debrief (ruleset §15b) once the game is over. The host must still
   * accept it unless `rules.debrief_enabled` is "always"; "never" skips it entirely.
   */
  debrief: z.boolean().optional(),
  /**
   * Testing / replay only: no shuffle. Slot i sits at seat i, gets card i and name i.
   * Never set by the orchestrator for real games.
   */
  fixedDeal: z.boolean().optional(),
  /**
   * The host's own deal (a custom game, owner request 2026-10-26): slot i sits at seat i and gets
   * card i, as the host assigned them in the lobby (with a Thief, the last two cards are the
   * extras). Unlike `fixedDeal` the display names are still shuffled with the seed.
   */
  manualDeal: z.boolean().optional(),
});

export type GameConfig = z.infer<typeof GameConfigSchema>;
