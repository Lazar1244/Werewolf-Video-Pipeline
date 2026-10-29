import type { ModelProfile } from '@ww/shared';

/** Prices in USD per token (OpenRouter publishes strings per token). */
export interface Pricing {
  prompt: number;
  completion: number;
  request: number;
  internalReasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What the game needs to know about one model (ARCHITECTURE.md §7.2). */
export interface CatalogEntry {
  id: string;
  contextLength: number;
  /** Maximum prices across the endpoints the profile may route to (or the model's list price). */
  pricing: Pricing;
  /**
   * The routing price ceiling (USD per token; owner rule 2026-10-21, see `routingCap`): sent as OpenRouter's
   * `provider.max_price`, so a request never lands on a premium tier above the maker's own price. Absent when unknown
   * (offline, or a cache entry from before the rule): then no ceiling is sent and `pricing` is the max over all endpoints.
   */
  priceCap?: { prompt: number; completion: number };
  supportedParameters: string[];
  /** 'catalog' = fetched from OpenRouter; 'override' = from the profile (offline). */
  source: 'catalog' | 'override';
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function parsePricing(p: Record<string, unknown> | undefined): Pricing {
  return {
    prompt: num(p?.['prompt']),
    completion: num(p?.['completion']),
    request: num(p?.['request']),
    internalReasoning: num(p?.['internal_reasoning']),
    cacheRead: num(p?.['input_cache_read']),
    cacheWrite: num(p?.['input_cache_write']),
  };
}

export function maxPricing(list: readonly Pricing[]): Pricing {
  const out: Pricing = { prompt: 0, completion: 0, request: 0, internalReasoning: 0, cacheRead: 0, cacheWrite: 0 };
  for (const p of list) for (const k of Object.keys(out) as (keyof Pricing)[]) out[k] = Math.max(out[k], p[k]);
  return out;
}

/** One raw `/models` entry → CatalogEntry (throws on a malformed entry). */
export function parseModel(raw: unknown): CatalogEntry {
  const m = raw as { id?: unknown; context_length?: unknown; pricing?: Record<string, unknown>; supported_parameters?: unknown };
  if (typeof m?.id !== 'string') throw new Error('catalogue entry without an id');
  return {
    id: m.id,
    contextLength: num(m.context_length),
    pricing: parsePricing(m.pricing),
    supportedParameters: Array.isArray(m.supported_parameters) ? m.supported_parameters.filter((x): x is string => typeof x === 'string') : [],
    source: 'catalog',
  };
}

/** Offline entry from a profile's own `contextLength` + `pricingOverride` (ARCHITECTURE.md §7.2). */
export function overrideEntry(p: ModelProfile): CatalogEntry | null {
  if (!p.contextLength || !p.pricingOverride) return null;
  return {
    id: p.openrouterId,
    contextLength: p.contextLength,
    pricing: { prompt: p.pricingOverride.promptPerMTok / 1e6, completion: p.pricingOverride.completionPerMTok / 1e6, request: 0, internalReasoning: 0, cacheRead: 0, cacheWrite: 0 },
    supportedParameters: [],
    source: 'override',
  };
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface CatalogClientOptions {
  baseUrl: string;
  apiKey: string | null;
  fetch: FetchLike;
  timeoutMs?: number;
}

async function getJson(o: CatalogClientOptions, path: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 30_000);
  try {
    const headers: Record<string, string> = {};
    if (o.apiKey) headers['Authorization'] = `Bearer ${o.apiKey}`;
    const res = await o.fetch(`${o.baseUrl}${path}`, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${path} failed with HTTP ${res.status}`);
    return JSON.parse(await res.text()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** `GET /models`: the whole catalogue. */
export async function fetchCatalog(o: CatalogClientOptions): Promise<CatalogEntry[]> {
  const body = (await getJson(o, '/models')) as { data?: unknown[] };
  if (!Array.isArray(body?.data)) throw new Error('unexpected /models response');
  const out: CatalogEntry[] = [];
  for (const m of body.data) {
    try {
      out.push(parseModel(m));
    } catch {
      // skip malformed entries
    }
  }
  return out;
}

/** One provider endpoint of a model (`GET /models/{id}/endpoints`). */
export interface Endpoint {
  provider: string;
  tag: string;
  pricing: Pricing;
}

/** `GET /models/{id}/endpoints`: every provider endpoint with its price. Null when the call fails. */
export async function fetchEndpoints(o: CatalogClientOptions, id: string): Promise<Endpoint[] | null> {
  try {
    const body = (await getJson(o, `/models/${id}/endpoints`)) as {
      data?: { endpoints?: { provider_name?: unknown; tag?: unknown; pricing?: Record<string, unknown> }[] };
    };
    const eps = body?.data?.endpoints;
    if (!Array.isArray(eps) || eps.length === 0) return null;
    return eps.map((e) => ({ provider: String(e.provider_name ?? ''), tag: String(e.tag ?? ''), pricing: parsePricing(e.pricing) }));
  } catch {
    return null;
  }
}

/** The company that makes each model family, as OpenRouter names it among a model's providers. */
const MAKERS: Record<string, string[]> = {
  openai: ['openai'],
  anthropic: ['anthropic'],
  google: ['google'],
  'x-ai': ['xai'],
  mistralai: ['mistral'],
  qwen: ['alibaba'],
  'z-ai': ['z.ai', 'z-ai'],
  moonshotai: ['moonshot'],
  minimax: ['minimax'],
  xiaomi: ['xiaomi'],
  deepseek: ['deepseek'],
  'meta-llama': ['meta'],
  cohere: ['cohere'],
  nvidia: ['nvidia'],
  tencent: ['tencent'],
  stepfun: ['stepfun'],
  inception: ['inception'],
  nousresearch: ['nous'],
};

const fits = (p: Pricing, cap: { prompt: number; completion: number }) => p.prompt <= cap.prompt * (1 + 1e-9) && p.completion <= cap.completion * (1 + 1e-9);
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(a, b, 1e-12);

/**
 * The routing price ceiling (owner rule, 2026-10-21): never pay more than the model's maker charges itself; cheaper
 * endpoints are welcome (OpenRouter's default routing already favours them, weighted by price).
 * 1. The maker hosts the model at its list price (every closed model: OpenAI, Anthropic, Google, xAI, ...): the
 *    ceiling is that price, so premium tiers ("fast", "ultrafast", "priority") and reseller surcharges are never used.
 * 2. The maker hosts it at another price (open-weight models whose list price is a cheaper host): the maker's price.
 * 3. The maker does not host it: the lowest ceiling that still leaves 3 endpoints (or all of them), so a game is not
 *    left with a single host that may be down.
 * Returns the ceiling and the guard's pricing: the maximum over the list price and every endpoint under the ceiling.
 */
export function routingCap(id: string, list: Pricing, eps: readonly Endpoint[]): { cap: { prompt: number; completion: number }; pricing: Pricing } {
  const names = MAKERS[id.split('/')[0] ?? ''] ?? [];
  const maker = eps.filter((e) => names.some((n) => e.provider.toLowerCase().startsWith(n)));
  let cap: { prompt: number; completion: number };
  if (maker.some((e) => same(e.pricing.prompt, list.prompt) && same(e.pricing.completion, list.completion))) {
    cap = { prompt: list.prompt, completion: list.completion };
  } else if (maker.length) {
    const own = [...maker].sort((a, b) => a.pricing.completion - b.pricing.completion || a.pricing.prompt - b.pricing.prompt)[0]!;
    cap = { prompt: Math.max(own.pricing.prompt, list.prompt), completion: Math.max(own.pricing.completion, list.completion) };
  } else {
    const cheapest = [...eps].sort((a, b) => a.pricing.prompt + a.pricing.completion - (b.pricing.prompt + b.pricing.completion)).slice(0, 3);
    cap = {
      prompt: Math.max(list.prompt, ...cheapest.map((e) => e.pricing.prompt)),
      completion: Math.max(list.completion, ...cheapest.map((e) => e.pricing.completion)),
    };
  }
  return { cap, pricing: maxPricing([list, ...eps.filter((e) => fits(e.pricing, cap)).map((e) => e.pricing)]) };
}
