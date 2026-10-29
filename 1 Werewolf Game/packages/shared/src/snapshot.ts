import { z } from 'zod';
import { GameConfigSchema } from './gameconfig';
import { ModelProfileSchema } from './config/models';
import { SlotIdSchema } from './events';

/**
 * LLM message format shared by the ContextBuilder and the LLM client (OpenAI-style chat,
 * as OpenRouter accepts it). Content blocks allow Anthropic cache breakpoints (ARCHITECTURE.md §6.2).
 */
export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | TextBlock[];
}

/** Token budget, frozen per game (ARCHITECTURE.md §6.2). */
export const BudgetSchema = z.strictObject({
  window: z.int().min(1),
  outputReserve: z.int().min(1),
  inputBudget: z.int().min(1),
  l0Tokens: z.int().min(0),
  l1Cap: z.int(),
  l2Cap: z.int(),
  l3Cap: z.int(),
  l4Cap: z.int(),
  l5Cap: z.int(),
  l6Cap: z.int(),
  charsPerToken: z.number().positive(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const SlotSnapshotSchema = z.strictObject({
  slot: SlotIdSchema,
  controller: z.enum(['ai', 'human', 'bot']),
  /** A copy of the model profile (ai slots). Later edits to models.json never affect a running game. */
  profile: ModelProfileSchema.nullable(),
  fallbackAlias: z.string().nullable(),
  humanName: z.string().nullable(),
});
export type SlotSnapshot = z.infer<typeof SlotSnapshotSchema>;

/**
 * The frozen snapshot of a game (ARCHITECTURE.md §8), stored in `games.config_json`.
 * `game` is exactly what the engine receives.
 */
export const GameSnapshotSchema = z.strictObject({
  engineVersion: z.string(),
  compositionId: z.string().nullable(),
  game: GameConfigSchema,
  slots: z.array(SlotSnapshotSchema).min(5).max(10),
  budget: BudgetSchema,
  /** Pinned per game to the maximum across the game's profiles (ruleset principle 6). */
  pinned: z.strictObject({ attemptTimeoutMs: z.int(), maxOutputTokens: z.int() }),
  effortShare: z.strictObject({ low: z.number(), medium: z.number(), high: z.number() }),
  transportRetries: z.int().min(0),
  decisionCeilingMs: z.int().min(1),
  costCapUsd: z.number().positive(),
  promptPackHash: z.string(),
});
export type GameSnapshot = z.infer<typeof GameSnapshotSchema>;
