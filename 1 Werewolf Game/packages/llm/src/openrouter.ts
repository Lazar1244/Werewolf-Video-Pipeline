import type { FetchLike } from './catalog';
import { ProviderError, type CompletionRequest, type CompletionResult, type LLMProvider, type Usage } from './types';

export interface OpenRouterOptions {
  baseUrl: string;
  apiKey: string;
  referer?: string | null;
  title?: string | null;
  fetch: FetchLike;
  /** Waits between `/generation` look-ups (default 1 s). */
  generationRetryMs?: number;
}

/** Parameters a 400 error may name; the client then drops or downgrades them (ARCHITECTURE.md §7.3). */
const KNOWN_PARAMS = ['response_format', 'json_schema', 'structured_outputs', 'temperature', 'top_p', 'reasoning'];

/**
 * OpenRouter chat completions (ARCHITECTURE.md §7.3). One call = one HTTP attempt; retries,
 * timeouts and cost accounting are the caller's job (see `call.ts`). The key stays in this
 * object and is never logged.
 */
export class OpenRouterClient implements LLMProvider {
  constructor(private readonly o: OpenRouterOptions) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${this.o.apiKey}` };
    if (this.o.referer) h['HTTP-Referer'] = this.o.referer;
    if (this.o.title) h['X-Title'] = this.o.title;
    return h;
  }

  async complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.o.fetch(`${this.o.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(req), signal });
    } catch (e) {
      if (signal.aborted) throw new ProviderError(signal.reason === 'timeout' ? 'timeout' : 'aborted', 'request aborted');
      throw new ProviderError('network', `network error: ${(e as Error).message}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      if (signal.aborted) throw new ProviderError(signal.reason === 'timeout' ? 'timeout' : 'aborted', 'request aborted');
      throw new ProviderError('network', `network error while reading the response: ${(e as Error).message}`);
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // non-JSON body (e.g. a proxy error page)
    }
    if (!res.ok) throw classifyError(res.status, body, text, res.headers.get('retry-after'), req);
    // OpenRouter can report a mid-stream/provider error inside a 200 body.
    if (body && typeof body['error'] === 'object' && body['error'] !== null) {
      const err = body['error'] as { code?: unknown };
      throw classifyError(typeof err.code === 'number' ? err.code : 502, body, text, null, req);
    }
    if (!body) throw new ProviderError('server', 'the provider returned a non-JSON response');
    return parseCompletion(body);
  }

  async generationCost(id: string, signal: AbortSignal): Promise<number | null> {
    const wait = this.o.generationRetryMs ?? 1000;
    for (let i = 0; i < 3; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, wait));
      if (signal.aborted) return null;
      try {
        const res = await this.o.fetch(`${this.o.baseUrl}/generation?id=${encodeURIComponent(id)}`, { headers: this.headers(), signal });
        if (!res.ok) continue;
        const body = JSON.parse(await res.text()) as { data?: { total_cost?: unknown } };
        const c = body?.data?.total_cost;
        if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return c;
      } catch {
        // try again
      }
    }
    return null;
  }
}

export function parseCompletion(body: Record<string, unknown>): CompletionResult {
  const choices = body['choices'] as { message?: { content?: unknown }; finish_reason?: unknown }[] | undefined;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('') : '';
  const u = body['usage'] as Record<string, unknown> | undefined;
  let usage: Usage | null = null;
  let cost: number | null = null;
  if (u && typeof u === 'object') {
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    usage = {
      promptTokens: n(u['prompt_tokens']),
      completionTokens: n(u['completion_tokens']),
      reasoningTokens: n((u['completion_tokens_details'] as Record<string, unknown> | undefined)?.['reasoning_tokens']),
      cachedTokens: n((u['prompt_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens']),
    };
    if (typeof u['cost'] === 'number' && Number.isFinite(u['cost']) && u['cost'] >= 0) cost = u['cost'];
  }
  return {
    text,
    generationId: typeof body['id'] === 'string' ? body['id'] : null,
    usage,
    cost,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
  };
}

export function classifyError(status: number, body: Record<string, unknown> | null, raw: string, retryAfter: string | null, req: CompletionRequest): ProviderError {
  const err = (body?.['error'] ?? {}) as { message?: unknown; metadata?: unknown };
  const message = typeof err.message === 'string' ? err.message : raw.slice(0, 300);
  const retryAfterMs = parseRetryAfter(retryAfter);
  const opts = { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  if (status === 401 || status === 402 || status === 403) return new ProviderError('auth', `HTTP ${status}: ${message}`, opts);
  if (status === 429) return new ProviderError('rate_limit', `HTTP 429: ${message}`, opts);
  if (status === 408 || status >= 500) return new ProviderError('server', `HTTP ${status}: ${message}`, opts);
  // the routing price ceiling found no endpoint ("...satisfy the max price..."): not an output-mode problem
  if (status === 404 && /max price/i.test(message)) return new ProviderError('bad_request', `HTTP 404: ${message}`, opts);
  if (status === 404 && /no endpoints found/i.test(message) && req.provider?.require_parameters) {
    return new ProviderError('unsupported', `HTTP 404: ${message}`, { ...opts, param: 'response_format' });
  }
  if (status === 400) {
    const lower = `${message} ${JSON.stringify(err.metadata ?? '')}`.toLowerCase();
    const param = KNOWN_PARAMS.find((p) => lower.includes(p));
    if (param && /support|unsupported|not allowed|invalid|unknown|unrecognized/.test(lower)) {
      const normal = param === 'json_schema' || param === 'structured_outputs' ? 'response_format' : param;
      return new ProviderError('unsupported', `HTTP 400: ${message}`, { ...opts, param: normal });
    }
  }
  return new ProviderError('bad_request', `HTTP ${status}: ${message}`, opts);
}

/** `Retry-After` in seconds or as an HTTP date; capped at 20 s by the caller. */
export function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}
