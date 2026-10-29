import type { ChatMessage, ModelProfile } from '@ww/shared';
import type { CatalogEntry } from './catalog';
import type { CompletionRequest } from './types';

export type OutputMode = 'json_schema' | 'json_object' | 'prompt_only';
export type EffortShare = { low: number; medium: number; high: number };

/** Structured-output mode (ARCHITECTURE.md §7.4), before any per-game downgrade. */
export function resolveMode(profile: ModelProfile, entry: CatalogEntry | null): OutputMode {
  if (profile.structuredOutput !== 'auto') return profile.structuredOutput;
  if (!entry || entry.source !== 'catalog') return 'prompt_only';
  if (entry.supportedParameters.includes('structured_outputs')) return 'json_schema';
  if (entry.supportedParameters.includes('response_format')) return 'json_object';
  return 'prompt_only';
}

const MODES: OutputMode[] = ['json_schema', 'json_object', 'prompt_only'];

/** The next weaker mode, or null when already at `prompt_only`. */
export function downgradeMode(m: OutputMode): OutputMode | null {
  return MODES[MODES.indexOf(m) + 1] ?? null;
}

/**
 * Whether reasoning tokens are requested/budgeted. `effort`-style models always get an
 * effort level, because "disabled" means `effort: low` for them (ARCHITECTURE.md §7.1):
 * the provider would otherwise reason at its own default inside our flat `max_tokens`.
 */
const reasons = (p: ModelProfile) => p.reasoning.enabled || p.reasoning.mandatory || p.reasoning.style === 'effort';

/**
 * `max_tokens` sent for this profile (ARCHITECTURE.md §7.1): the pinned visible budget, plus the
 * reasoning budget (`max_tokens` style), or scaled so the answer keeps its share (`effort` style).
 */
export function maxTokensFor(p: ModelProfile, pinnedOutput: number, share: EffortShare): number {
  if (!reasons(p)) return pinnedOutput;
  if (p.reasoning.style === 'max_tokens') return pinnedOutput + p.reasoning.maxTokens;
  const effort = p.reasoning.enabled ? p.reasoning.effort : 'low';
  return Math.ceil(pinnedOutput / (1 - share[effort]));
}

/** Per-game, per-seat downgrades (ARCHITECTURE.md §7.3): a weaker output mode and dropped parameters. */
export interface Downgrades {
  mode?: OutputMode;
  dropped: string[];
}

export interface BodyInput {
  profile: ModelProfile;
  messages: ChatMessage[];
  schema: Record<string, unknown>;
  mode: OutputMode;
  pinnedOutput: number;
  effortShare: EffortShare;
  dropped?: readonly string[];
  /** The model's routing ceiling (CatalogEntry.priceCap, USD per token), sent as `provider.max_price`. */
  priceCap?: { prompt: number; completion: number } | undefined;
}

/**
 * USD per token -> USD per million tokens, a hair high (1e-7 relative, then 9 significant digits), so an endpoint
 * priced exactly at the ceiling is never dropped by float rounding on either side (0.825 must not arrive as 0.82499...).
 */
const perMillion = (x: number) => Number((x * 1e6 * (1 + 1e-7)).toPrecision(9));

/**
 * The strict schema rewritten for Anthropic's structured outputs, which reject a type list next to an enum
 * ("Enum value 1 does not match declared type ['integer', 'null']"): every `type: [A, B]` becomes `anyOf` with one branch
 * per type, each keeping only its own enum values and the other keywords. Same meaning; other providers keep the original.
 */
export function anyOfSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(anyOfSchema);
  if (!s || typeof s !== 'object') return s;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) o[k] = anyOfSchema(v);
  if (!Array.isArray(o['type'])) return o;
  const { type, enum: values, description, ...rest } = o as { type: string[]; enum?: unknown[]; description?: unknown } & Record<string, unknown>;
  const fits = (t: string, v: unknown) =>
    t === 'null' ? v === null : t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' : t === 'string' ? typeof v === 'string' : t === 'boolean' ? typeof v === 'boolean' : false;
  const branches = type.map((t) => {
    if (t === 'null') return { type: 'null' };
    const b: Record<string, unknown> = { type: t, ...(t === 'object' || t === 'array' ? rest : {}) };
    if (values) b['enum'] = values.filter((v) => fits(t, v));
    return b;
  });
  return { ...(description !== undefined ? { description } : {}), anyOf: branches };
}

/**
 * The strict schema rewritten for Google's structured outputs (Gemini), which reject an enum that mixes numbers and
 * text with "Request contains an invalid argument" (2026-10-21: every Gemini vote, `enum: [1, 3, "abstain"]`, failed).
 * Such an enum becomes all text (`"1"`, `"3"`, `"abstain"`, keeping null); the controller turns a seat number written
 * as text back into a number. Other enums are unchanged.
 */
export function textEnumSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(textEnumSchema);
  if (!s || typeof s !== 'object') return s;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) o[k] = textEnumSchema(v);
  const values = o['enum'];
  if (!Array.isArray(values) || !values.some((v) => typeof v === 'string')) return o;
  // mixed values, or text values under a type list (a vote whose only option left is "abstain")
  if (!values.some((v) => typeof v === 'number') && !Array.isArray(o['type'])) return o;
  return { ...o, type: values.includes(null) ? ['string', 'null'] : 'string', enum: values.map((v) => (typeof v === 'number' ? String(v) : v)) };
}

export function buildBody(i: BodyInput): CompletionRequest {
  const p = i.profile;
  const dropped = new Set(i.dropped ?? []);
  const body: CompletionRequest = {
    model: p.openrouterId,
    messages: i.messages,
    max_tokens: maxTokensFor(p, i.pinnedOutput, i.effortShare),
    usage: { include: true },
  };
  if (p.params.temperature !== null && !dropped.has('temperature')) body.temperature = p.params.temperature;
  if (p.params.top_p !== null && !dropped.has('top_p')) body.top_p = p.params.top_p;
  if (reasons(p) && !dropped.has('reasoning')) {
    body.reasoning =
      p.reasoning.style === 'max_tokens'
        ? { max_tokens: p.reasoning.maxTokens, exclude: p.reasoning.exclude }
        : { effort: p.reasoning.enabled ? p.reasoning.effort : 'low', exclude: p.reasoning.exclude };
  }
  const provider: NonNullable<CompletionRequest['provider']> = { allow_fallbacks: p.provider.allow_fallbacks };
  if (p.provider.order.length) provider.order = [...p.provider.order];
  if (i.priceCap) provider.max_price = { prompt: perMillion(i.priceCap.prompt), completion: perMillion(i.priceCap.completion) };
  if (i.mode === 'json_schema') {
    const schema = p.openrouterId.startsWith('anthropic/')
      ? (anyOfSchema(i.schema) as Record<string, unknown>)
      : p.openrouterId.startsWith('google/')
        ? (textEnumSchema(i.schema) as Record<string, unknown>)
        : i.schema;
    body.response_format = { type: 'json_schema', json_schema: { name: 'decision', strict: true, schema } };
    provider.require_parameters = true;
  } else if (i.mode === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  body.provider = provider;
  return body;
}
