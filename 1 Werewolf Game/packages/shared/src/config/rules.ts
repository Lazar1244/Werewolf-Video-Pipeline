import { z } from 'zod';

/**
 * Game rules configuration: every switch of WEREWOLF_RULESET.md §14.8 plus the
 * limits of §14.4. `config/rules/default.json` must provide a complete object;
 * compositions and lobbies provide partial overrides (RulesOverride).
 */

const wordLimits = z.strictObject({
  speech: z.int().min(10).max(1000),
  last_words: z.int().min(10).max(1000),
  defence: z.int().min(10).max(1000),
  sheriff_speech: z.int().min(10).max(1000),
  rebuttal: z.int().min(10).max(1000),
  judge_round_speech: z.int().min(10).max(1000),
  channel_message: z.int().min(10).max(1000),
  reasoning: z.int().min(10).max(2000),
  notebook: z.int().min(10).max(2000),
  debrief_comment: z.int().min(10).max(1000),
  debrief_reply: z.int().min(10).max(1000),
  /** The immediate answer to a Challenge. Optional so games frozen before it existed still load (engine default 60). */
  challenge_answer: z.int().min(10).max(1000).optional(),
});

const humanTimeouts = z.strictObject({
  /** speech, rebuttal, defence, last words, sheriff speech, debrief comment */
  long_text_ms: z.int().min(5_000),
  /** council turns and channel messages */
  channel_ms: z.int().min(5_000),
  /** every other decision */
  other_ms: z.int().min(5_000),
});

export const RulesSchema = z.strictObject({
  angel_ends_game: z.boolean(),
  seer_mode: z.enum(['alignment', 'role']),
  reveal_on_death: z.enum(['full', 'team', 'none']),
  night_last_words: z.boolean(),
  /** "auto" = true when N >= 7 (resolved per game). */
  sheriff_enabled: z.union([z.boolean(), z.literal('auto')]),
  lovers_see_role: z.boolean(),
  wolves_may_skip: z.boolean(),
  wolf_council_max_rounds: z.int().min(1).max(6),
  little_girl_catch: z.number().min(0).max(1),
  sister_messages: z.int().min(0).max(5),
  infection_consumed_on_fail: z.boolean(),
  witch_self_heal: z.boolean(),
  protector_self: z.boolean(),
  elder_curse: z.boolean(),
  abstain_blocks_execution: z.boolean(),
  discussion_rounds: z.int().min(1).max(5),
  /**
   * Challenges per player per game (ruleset §9.2): in a discussion speech a player may call out another, who
   * answers at once. Optional so games frozen before it existed still load: missing = 0 (no Challenges), which
   * keeps their replay identical.
   */
  challenges_per_player: z.int().min(0).max(3).optional(),
  /**
   * Owner (2026-10-28): a challenged player who is the very next speaker does not speak twice in a row: the answer
   * stands as their turn (and its lean counts as that turn's). Optional so frozen games replay identically: missing =
   * false (the answer never replaces a turn).
   */
  challenge_answer_is_turn: z.boolean().optional(),
  /**
   * Owner (2026-10-28): a Challenge answer may carry a Challenge of its own (while the player has one left), even
   * back at the challenger. Optional so frozen games replay identically: missing = false.
   */
  challenge_in_answer: z.boolean().optional(),
  /** "N" = number of seats (resolved per game). */
  max_days: z.union([z.int().min(1).max(50), z.literal('N')]),
  stall_cycles: z.int().min(1).max(10),
  transcript_token_budget: z.int().min(2_000),
  dead_human_spectates: z.boolean(),
  debrief_enabled: z.enum(['ask', 'always', 'never']),
  debrief_rounds: z.union([z.literal(1), z.literal(2)]),
  words: wordLimits,
  human_timeouts: humanTimeouts,
});

export type Rules = z.infer<typeof RulesSchema>;

/** Partial override (top-level keys optional, nested objects partial). */
export const RulesOverrideSchema = RulesSchema.extend({
  words: wordLimits.partial(),
  human_timeouts: humanTimeouts.partial(),
}).partial();

export type RulesOverride = z.infer<typeof RulesOverrideSchema>;

/** Rules with per-game sentinels resolved. */
export type ResolvedRules = Omit<Rules, 'sheriff_enabled' | 'max_days'> & {
  sheriff_enabled: boolean;
  max_days: number;
};
