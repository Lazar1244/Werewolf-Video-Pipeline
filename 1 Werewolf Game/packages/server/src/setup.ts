import { loadConfig, loadSecrets, type LoadedConfig } from '@ww/config';
import { buildSystemPrompt, estimateTokens, computeBudget, loadPromptPack, type PromptPack } from '@ww/context';
import { ENGINE_VERSION } from '@ww/engine';
import { fetchCatalog, fetchEndpoints, maxTokensFor, maxPricing, overrideEntry, parseModel, parsePricing, resolveMode, routingCap, type CatalogEntry } from '@ww/llm';
import { GameSnapshotSchema, layerRules, manualDealProblem, resolveSentinels, type GameSnapshot, type ManualDeal, type ModelProfile, type RoleId, type RulesOverride, type SlotSnapshot } from '@ww/shared';
import { getCatalogEntry, putCatalogEntry, type Store } from '@ww/store';
import { join } from 'node:path';

export interface Paths {
  root: string;
  config: string;
  prompts: string;
}

export const pathsFrom = (root: string): Paths => ({ root, config: join(root, 'config'), prompts: join(root, 'prompts') });

export interface Env {
  paths: Paths;
  cfg: LoadedConfig;
  pack: PromptPack;
  apiKey: string | null;
}

export function loadEnv(root: string): Env {
  const paths = pathsFrom(root);
  return { paths, cfg: loadConfig(paths.config), pack: loadPromptPack(paths.prompts), apiKey: loadSecrets(root).openrouterApiKey };
}

/**
 * Catalogue entries for the profiles in play: fetched from OpenRouter (and cached in SQLite),
 * or read from the cache / the profile's own overrides when offline (ARCHITECTURE.md §7.2).
 */
export async function resolveCatalog(
  env: Env,
  store: Store,
  profiles: readonly ModelProfile[],
  opts: { offline?: boolean; refresh?: boolean; assume?: boolean } = {},
): Promise<{ entries: Map<string, CatalogEntry>; warnings: string[] }> {
  const entries = new Map<string, CatalogEntry>();
  const warnings: string[] = [];
  const wanted = [...new Set(profiles.map((p) => p.openrouterId))];
  const online = !opts.offline && env.apiKey !== null;
  const client = { baseUrl: env.cfg.app.openrouter.baseUrl, apiKey: env.apiKey, fetch: globalThis.fetch as never };

  if (online) {
    try {
      const all = await fetchCatalog(client);
      const byId = new Map(all.map((e) => [e.id, e]));
      for (const id of wanted) {
        const e = byId.get(id);
        if (!e) {
          warnings.push(`model "${id}" is not in the OpenRouter catalogue`);
          continue;
        }
        // the routing ceiling (owner rule 2026-10-21, `routingCap`): never above the maker's own price; the guard
        // reserves at the highest price under it. The cache keeps the list price, the guard price and the ceiling.
        const list = e.pricing;
        const eps = await fetchEndpoints(client, id);
        let cached: { pricing: Record<string, string>; cap: { prompt: number; completion: number } } | undefined;
        if (eps) {
          const r = routingCap(id, list, eps);
          e.pricing = r.pricing;
          e.priceCap = r.cap;
          cached = { pricing: rawPricing({ ...e, pricing: r.pricing }), cap: r.cap };
        } else {
          // the endpoint list could not be fetched: keep the last known ceiling and guard price rather than none
          const old = getCatalogEntry(store, id)?.endpoints as { pricing?: Record<string, unknown>; cap?: { prompt: number; completion: number } } | null | undefined;
          if (old?.cap) {
            e.priceCap = old.cap;
            if (old.pricing) e.pricing = maxPricing([list, parsePricing(old.pricing)]);
            warnings.push(`could not fetch the provider prices of "${id}"; using the cached price ceiling`);
          }
        }
        entries.set(id, e);
        putCatalogEntry(store, id, { id: e.id, context_length: e.contextLength, pricing: rawPricing({ ...e, pricing: list }), supported_parameters: e.supportedParameters }, cached);
      }
    } catch (e) {
      warnings.push(`could not reach the OpenRouter catalogue (${(e as Error).message}); using the cache`);
    }
  } else if (!opts.offline && env.apiKey === null) {
    warnings.push('OPENROUTER_API_KEY is not set; using the cached catalogue');
  }

  for (const p of profiles) {
    if (entries.has(p.openrouterId)) continue;
    const row = getCatalogEntry(store, p.openrouterId);
    if (row) {
      const e = parseModel(row.data);
      // an entry cached before the routing ceiling existed has no `cap`: the old, cautious max over every endpoint
      const cachedEps = row.endpoints as { pricing?: Record<string, unknown>; cap?: { prompt: number; completion: number } } | null;
      if (cachedEps?.pricing) e.pricing = maxPricing([e.pricing, parsePricing(cachedEps.pricing)]);
      if (cachedEps?.cap) e.priceCap = cachedEps.cap;
      entries.set(p.openrouterId, e);
      warnings.push(`using the cached catalogue entry for "${p.openrouterId}" (fetched ${row.fetchedAt})`);
      continue;
    }
    const fallback = overrideEntry(p) ?? (opts.assume ? assumedEntry(p) : null);
    if (!fallback) throw new Error(`no catalogue data for "${p.openrouterId}" and the profile has no contextLength + pricingOverride`);
    entries.set(p.openrouterId, fallback);
    warnings.push(`using the profile's own contextLength and pricing for "${p.openrouterId}" (offline)`);
  }
  return { entries, warnings };
}

/**
 * Stand-in entry for a dry run (`--mock`), where no real model is called. The prices are
 * typical cheap-model rates, so the cost cap still behaves as it would in a real game.
 */
function assumedEntry(p: ModelProfile): CatalogEntry {
  return {
    id: p.openrouterId,
    contextLength: 128_000,
    pricing: { prompt: 0.3e-6, completion: 1.2e-6, request: 0, internalReasoning: 1.2e-6, cacheRead: 0.03e-6, cacheWrite: 0.375e-6 },
    supportedParameters: ['structured_outputs', 'response_format', 'temperature', 'top_p', 'reasoning'],
    source: 'override',
  };
}

const rawPricing = (e: CatalogEntry) => ({
  prompt: String(e.pricing.prompt),
  completion: String(e.pricing.completion),
  request: String(e.pricing.request),
  internal_reasoning: String(e.pricing.internalReasoning),
  input_cache_read: String(e.pricing.cacheRead),
  input_cache_write: String(e.pricing.cacheWrite),
});

export interface BuildGameInput {
  env: Env;
  store: Store;
  compositionId: string;
  aliases: string[];
  seed: string;
  costCapUsd: number;
  botSlots?: number[];
  /** One alias per slot (null = not played by a model); overrides the round-robin `aliases`. */
  perSlotAliases?: (string | null)[];
  /** Slots played by humans (they drive the spectator lock). */
  humanSlots?: number[];
  humanNames?: Record<number, string>;
  /** Offer the post-game debrief (ruleset §15b). */
  debrief?: boolean;
  /** Lobby-level rule overrides, layered on top of the composition's (ARCHITECTURE.md §8). */
  rulesOverride?: RulesOverride;
  /** A custom game: the host's seats and cards (slot i at seat i with roles[i]; the Thief's extras last). */
  manualDeal?: ManualDeal;
  offline?: boolean;
  /** Dry run: assume a generous window and zero price when the catalogue is unavailable. */
  mock?: boolean;
}

export interface BuiltGame {
  snapshot: GameSnapshot;
  profiles: Map<number, ModelProfile>;
  entries: Map<string, CatalogEntry>;
  warnings: string[];
}

/** Freeze one game: rules, cards, slots, profile copies and the token budget (ARCHITECTURE.md §8). */
export async function buildGame(i: BuildGameInput): Promise<BuiltGame> {
  const { env } = i;
  const comp = env.cfg.compositions.get(i.compositionId);
  if (!comp) throw new Error(`unknown composition "${i.compositionId}" (have: ${[...env.cfg.compositions.keys()].join(', ')})`);
  const seats = comp.seats;
  const bots = new Set(i.botSlots ?? []);
  const humans = new Set(i.humanSlots ?? []);
  const slotAliases: (string | null)[] = [];
  for (let s = 1; s <= seats; s++) {
    if (bots.has(s) || humans.has(s)) slotAliases.push(null);
    else if (i.perSlotAliases) slotAliases.push(i.perSlotAliases[s - 1] ?? null);
    else slotAliases.push(i.aliases[(s - 1) % i.aliases.length]!);
  }

  const profilesBySlot = new Map<number, ModelProfile>();
  for (const [idx, alias] of slotAliases.entries()) {
    if (alias === null) continue;
    const p = env.cfg.profilesByAlias.get(alias);
    if (!p) throw new Error(`unknown model alias "${alias}"`);
    if (!p.enabled) throw new Error(`model "${alias}" is disabled in models.json`);
    profilesBySlot.set(idx + 1, p);
  }
  const used = [...new Set(profilesBySlot.values())];
  if (used.length === 0) throw new Error('at least one slot must be played by a model');
  // A seat may later be remapped to its fallback alias, so the frozen budget must fit those too
  // (ARCHITECTURE.md §6.2, §9.5).
  const fallback = env.cfg.app.defaultFallbackAlias ? env.cfg.profilesByAlias.get(env.cfg.app.defaultFallbackAlias) : undefined;
  const forBudget = [...new Set([...used, ...(fallback && fallback.enabled ? [fallback] : [])])];
  const { entries, warnings } = await resolveCatalog(env, i.store, forBudget, { offline: i.offline || i.mock, assume: i.mock });

  const rules = resolveSentinels(layerRules(env.cfg.rules, comp.ruleOverrides, i.rulesOverride), seats);
  if (i.manualDeal) {
    const problem = manualDealProblem(comp.cards, seats, i.manualDeal);
    if (problem) throw new Error(`the host's deal does not fit "${comp.id}": ${problem}`);
  }
  // a host's deal freezes the cards in seat order (the engine then deals them as they stand)
  const cards = (i.manualDeal ? [...i.manualDeal.roles, ...(i.manualDeal.extras ?? [])] : comp.cards) as RoleId[];
  const pinnedOutput = Math.max(...forBudget.map((p) => p.maxOutputTokens));
  const share = env.cfg.app.effortShare;
  const outputReserve = Math.max(...forBudget.map((p) => maxTokensFor(p, pinnedOutput, share)));
  const window = Math.min(...forBudget.map((p) => entries.get(p.openrouterId)!.contextLength));
  if (window < env.cfg.app.minContextTokens) {
    const small = forBudget.find((p) => entries.get(p.openrouterId)!.contextLength === window)!;
    throw new Error(`model "${small.alias}" has a context window of ${window} tokens, below minContextTokens (${env.cfg.app.minContextTokens})`);
  }
  const l0Tokens = estimateTokens(buildSystemPrompt(env.pack, cards, cards.length - seats, rules));
  const budget = computeBudget({ window, outputReserve, transcriptTokenBudget: rules.transcript_token_budget, l0Tokens });

  const slots: SlotSnapshot[] = slotAliases.map((alias, idx) => {
    const slot = idx + 1;
    const controller = humans.has(slot) ? ('human' as const) : alias === null ? ('bot' as const) : ('ai' as const);
    return {
      slot,
      controller,
      profile: controller === 'ai' ? structuredClone(profilesBySlot.get(slot)!) : null,
      fallbackAlias: controller === 'ai' && fallback?.enabled ? fallback.alias : null,
      humanName: controller === 'human' ? (i.humanNames?.[slot] ?? `seat ${slot}`) : null,
    };
  });

  const snapshot: GameSnapshot = GameSnapshotSchema.parse({
    engineVersion: ENGINE_VERSION,
    compositionId: comp.id,
    game: {
      seed: i.seed,
      seats,
      cards,
      rules,
      names: env.cfg.names,
      maskNames: maskNamesFor(forBudget),
      humanSlots: [...humans].sort((a, b) => a - b),
      ...(i.debrief ? { debrief: true } : {}),
      ...(i.manualDeal ? { manualDeal: true } : {}),
    },
    slots,
    budget,
    pinned: { attemptTimeoutMs: Math.max(...used.map((p) => p.attemptTimeoutMs)), maxOutputTokens: pinnedOutput },
    effortShare: share,
    transportRetries: env.cfg.app.transportRetries,
    decisionCeilingMs: env.cfg.app.decisionCeilingMs,
    costCapUsd: i.costCapUsd,
    promptPackHash: env.pack.hash,
  });
  return { snapshot, profiles: profilesBySlot, entries, warnings };
}

/**
 * Model and provider names to mask in player text (ruleset §14.6). Frozen into the config at
 * game start, so replay is unaffected by later catalogue edits.
 *
 * Only distinctive brand words are masked: the full label, the OpenRouter id, its vendor and
 * the model's family name. Size and variant words ("flash", "small", "mini"…) are ordinary
 * English and would otherwise be redacted out of every speech.
 */
const GENERIC_MODEL_WORDS = new Set([
  'flash', 'small', 'mini', 'micro', 'nano', 'large', 'turbo', 'instruct', 'chat', 'preview', 'pro', 'max', 'lite',
  'plus', 'base', 'ultra', 'air', 'beta', 'alpha', 'free', 'fast', 'light', 'meta', 'coder', 'thinking', 'reasoner',
  'reasoning', 'vision', 'audio', 'next', 'open', 'model', 'text', 'omni', 'high', 'low', 'medium', 'exp', 'latest',
  // 2026-10-26 models: everyday words in their names ("prime suspect", "I wonder", "step aside", "seed of doubt")
  'prime', 'wonder', 'step', 'seed',
]);

export function maskNamesFor(profiles: readonly ModelProfile[]): string[] {
  const out = new Set<string>(['OpenRouter']);
  const add = (word: string) => {
    const w = word.trim();
    if (w.length >= 3 && !/^[\d.]+$/.test(w) && !GENERIC_MODEL_WORDS.has(w.toLowerCase())) out.add(w);
  };
  for (const p of profiles) {
    add(p.label);
    add(p.openrouterId);
    const [vendor = '', model = ''] = p.openrouterId.split('/');
    add(vendor);
    add(model);
    // the family name: the part before the first version marker ("claude-haiku-4.5" -> "claude")
    const family = model.split(/[-.]/)[0] ?? '';
    add(family.replace(/[\d.]+$/, ''));
    for (const word of p.label.split(/[\s\-.]+/)) add(word);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Output mode per seat, resolved once per game. */
export function modeFor(profile: ModelProfile, entry: CatalogEntry | undefined): ReturnType<typeof resolveMode> {
  return resolveMode(profile, entry ?? null);
}
