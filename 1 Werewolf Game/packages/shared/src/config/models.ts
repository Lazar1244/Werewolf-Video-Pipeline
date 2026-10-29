import { z } from 'zod';

/** `config/models.json` — model profiles (ARCHITECTURE.md §7.1). */

export const AliasSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'alias must be lowercase letters, digits or dashes (max 40)');

export const ModelProfileSchema = z.strictObject({
  alias: AliasSchema,
  /** Exact OpenRouter model slug, e.g. "deepseek/deepseek-v4.1-flash". */
  openrouterId: z.string().regex(/^[a-z0-9._~-]+\/[a-z0-9._:-]+$/i, 'expected "provider/model" slug'),
  label: z.string().min(1),
  enabled: z.boolean(),
  params: z.strictObject({
    temperature: z.number().min(0).max(2).nullable(),
    top_p: z.number().gt(0).max(1).nullable(),
  }),
  /** Visible output budget (the JSON answer). Pinned per game to the max across seats. */
  maxOutputTokens: z.int().min(100).max(32_000),
  reasoning: z.strictObject({
    enabled: z.boolean(),
    /** How reasoning is requested: explicit token budget, or effort level. */
    style: z.enum(['max_tokens', 'effort']),
    effort: z.enum(['low', 'medium', 'high']),
    maxTokens: z.int().min(0).max(64_000),
    exclude: z.boolean(),
    /** Model always reasons, even when "disabled" (profile field only). */
    mandatory: z.boolean(),
  }),
  structuredOutput: z.enum(['auto', 'json_schema', 'json_object', 'prompt_only']),
  provider: z.strictObject({
    order: z.array(z.string()),
    allow_fallbacks: z.boolean(),
  }),
  /** Default only; pinned per game to the max across seats. */
  attemptTimeoutMs: z.int().min(5_000),
  maxConcurrency: z.int().min(1).max(32),
  cacheControl: z.enum(['auto', 'anthropic', 'none']),
  /** Optional overrides used when the OpenRouter catalogue is unavailable. */
  contextLength: z.int().min(1_000).optional(),
  pricingOverride: z
    .strictObject({
      promptPerMTok: z.number().min(0),
      completionPerMTok: z.number().min(0),
    })
    .optional(),
  notes: z.string().optional(),
});

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ModelsFileSchema = z.strictObject({
  profiles: z.array(ModelProfileSchema).min(1),
});

export type ModelsFile = z.infer<typeof ModelsFileSchema>;

/** `config/rosters.json` — named alias lists for quick slot filling. */
export const RostersFileSchema = z.strictObject({
  rosters: z.record(AliasSchema, z.array(AliasSchema).min(1).max(10)),
});

export type RostersFile = z.infer<typeof RostersFileSchema>;
