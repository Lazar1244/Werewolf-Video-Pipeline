import { describe, expect, it } from 'vitest';
import type { ModelProfile } from '@ww/shared';
import { callModel, CallFailed, DecisionClock, type CallLog, type DoneRecord, type SentRecord } from '../src/call';
import { maxPricing, parseModel, parsePricing, routingCap, type Endpoint, type Pricing } from '../src/catalog';
import { CostCapReached, CostGuard, estimateUsd, reservationUsd } from '../src/cost';
import { Limiter } from '../src/limiter';
import { MockProvider } from '../src/mock';
import { classifyError, parseCompletion, parseRetryAfter } from '../src/openrouter';
import { extractJson, stripReasoning } from '../src/parse';
import { anyOfSchema, buildBody, downgradeMode, maxTokensFor, resolveMode, textEnumSchema } from '../src/request';
import { ProviderError, type CompletionRequest, type CompletionResult, type LLMProvider } from '../src/types';

const PROFILE: ModelProfile = {
  alias: 'test',
  openrouterId: 'vendor/model-1',
  label: 'Test Model',
  enabled: true,
  params: { temperature: 0.8, top_p: null },
  maxOutputTokens: 700,
  reasoning: { enabled: false, style: 'max_tokens', effort: 'low', maxTokens: 2000, exclude: true, mandatory: false },
  structuredOutput: 'auto',
  provider: { order: [], allow_fallbacks: true },
  attemptTimeoutMs: 60_000,
  maxConcurrency: 4,
  cacheControl: 'auto',
};
const PRICING: Pricing = { prompt: 1e-6, completion: 4e-6, request: 0, internalReasoning: 8e-6, cacheRead: 0, cacheWrite: 2e-6 };
const entry = (params: string[] = ['structured_outputs', 'response_format', 'temperature']) => ({
  id: 'vendor/model-1',
  contextLength: 128_000,
  pricing: PRICING,
  supportedParameters: params,
  source: 'catalog' as const,
});

describe('answer parsing (ARCHITECTURE.md §7.4)', () => {
  it('takes the first balanced JSON object, ignoring fences and prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('Sure! Here it is: {"vote": 3, "text": "}"} thanks')).toEqual({ ok: true, value: { vote: 3, text: '}' } });
    expect(extractJson('{ not json } {"ok":true}')).toEqual({ ok: true, value: { ok: true } });
  });

  it('strips reasoning blocks before looking for JSON', () => {
    expect(stripReasoning('<think>plotting</think>{"a":1}')).toBe('{"a":1}');
    expect(extractJson('<think>who to frame?</think>\n{"vote":2}')).toEqual({ ok: true, value: { vote: 2 } });
    expect(extractJson('<thinking>cut off mid thought')).toEqual({ ok: false, error: 'no JSON object found in the answer' });
  });

  it('reports a cut-off object and prose-only answers', () => {
    expect(extractJson('{"reasoning": "I think')).toEqual({ ok: false, error: 'the JSON object is not closed (was the answer cut off?)' });
    expect(extractJson('I vote for Bram.').ok).toBe(false);
    expect(extractJson('x'.repeat(300_000)).ok).toBe(false);
  });
});

describe('request building (ARCHITECTURE.md §7.1)', () => {
  it('resolves the output mode from the catalogue and steps down on demand', () => {
    expect(resolveMode(PROFILE, entry())).toBe('json_schema');
    expect(resolveMode(PROFILE, entry(['response_format']))).toBe('json_object');
    expect(resolveMode(PROFILE, entry([]))).toBe('prompt_only');
    expect(resolveMode({ ...PROFILE, structuredOutput: 'json_object' }, entry())).toBe('json_object');
    expect(resolveMode(PROFILE, null)).toBe('prompt_only');
    expect(downgradeMode('json_schema')).toBe('json_object');
    expect(downgradeMode('prompt_only')).toBe(null);
  });

  it('budgets reasoning tokens per style', () => {
    const share = { low: 0.2, medium: 0.5, high: 0.8 };
    expect(maxTokensFor(PROFILE, 700, share)).toBe(700); // reasoning off
    const budgeted = { ...PROFILE, reasoning: { ...PROFILE.reasoning, enabled: true } };
    expect(maxTokensFor(budgeted, 700, share)).toBe(2700);
    const effort = { ...PROFILE, reasoning: { ...PROFILE.reasoning, enabled: true, style: 'effort' as const, effort: 'medium' as const } };
    expect(maxTokensFor(effort, 700, share)).toBe(1400);
    // a model that always reasons is budgeted even when "disabled"
    const mandatory = { ...PROFILE, reasoning: { ...PROFILE.reasoning, mandatory: true } };
    expect(maxTokensFor(mandatory, 700, share)).toBe(2700);
  });

  it('builds a strict json_schema body, and drops parameters that were downgraded', () => {
    const schema = { type: 'object' };
    const body = buildBody({ profile: PROFILE, messages: [], schema, mode: 'json_schema', pinnedOutput: 700, effortShare: { low: 0.2, medium: 0.5, high: 0.8 } });
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'decision', strict: true, schema } });
    expect(body.provider?.require_parameters).toBe(true);
    expect(body.temperature).toBe(0.8);
    expect(body.usage).toEqual({ include: true });
    const dropped = buildBody({ profile: PROFILE, messages: [], schema, mode: 'prompt_only', pinnedOutput: 700, effortShare: { low: 0.2, medium: 0.5, high: 0.8 }, dropped: ['temperature'] });
    expect(dropped.response_format).toBeUndefined();
    expect(dropped.temperature).toBeUndefined();
  });
});

describe('the schema for Claude models', () => {
  // Anthropic rejects a type list next to an enum ("Enum value 1 does not match declared type ['integer', 'null']")
  const schema = {
    type: 'object',
    properties: {
      notebook: { type: ['string', 'null'], description: 'notes' },
      target: { type: ['integer', 'null'], enum: [1, 3, null] },
      vote: { type: ['integer', 'string'], enum: [2, 4, 'abstain'] },
      claim: { type: ['object', 'null'], properties: { role: { type: 'string' } }, required: ['role'], additionalProperties: false },
    },
    required: ['notebook', 'target', 'vote', 'claim'],
    additionalProperties: false,
  };

  it('turns every type list into anyOf branches, each with its own enum values', () => {
    const p = (anyOfSchema(schema) as { properties: Record<string, unknown> }).properties;
    expect(p['notebook']).toEqual({ description: 'notes', anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(p['target']).toEqual({ anyOf: [{ type: 'integer', enum: [1, 3] }, { type: 'null' }] });
    expect(p['vote']).toEqual({ anyOf: [{ type: 'integer', enum: [2, 4] }, { type: 'string', enum: ['abstain'] }] });
    expect(p['claim']).toEqual({ anyOf: [{ type: 'object', properties: { role: { type: 'string' } }, required: ['role'], additionalProperties: false }, { type: 'null' }] });
  });

  it('is sent only to Anthropic models; every other model keeps the original schema', () => {
    const share = { low: 0.2, medium: 0.5, high: 0.8 };
    const claude = buildBody({ profile: { ...PROFILE, openrouterId: 'anthropic/claude-x' }, messages: [], schema, mode: 'json_schema', pinnedOutput: 700, effortShare: share });
    const other = buildBody({ profile: PROFILE, messages: [], schema, mode: 'json_schema', pinnedOutput: 700, effortShare: share });
    const sent = (b: CompletionRequest) => (b.response_format as { json_schema: { schema: unknown } }).json_schema.schema;
    expect(sent(claude)).toEqual(anyOfSchema(schema));
    expect(sent(other)).toBe(schema);
  });

  it('gives Google models an all-text enum where numbers and text are mixed (Gemini rejects the mix)', () => {
    const p = (textEnumSchema(schema) as { properties: Record<string, unknown> }).properties;
    // the vote: exactly the shape a live Gemini 3.1 Pro probe accepted (2026-10-21)
    expect(p['vote']).toEqual({ type: 'string', enum: ['2', '4', 'abstain'] });
    expect(textEnumSchema({ type: ['integer', 'string', 'null'], enum: [1, 'abstain', null] })).toEqual({ type: ['string', 'null'], enum: ['1', 'abstain', null] });
    expect(textEnumSchema({ type: ['integer', 'string'], enum: ['abstain'] })).toEqual({ type: 'string', enum: ['abstain'] });
    expect(textEnumSchema({ type: 'string', enum: ['seer', 'witch'] })).toEqual({ type: 'string', enum: ['seer', 'witch'] });
    // everything else is unchanged
    expect(p['target']).toEqual(schema.properties.target);
    expect(p['notebook']).toEqual(schema.properties.notebook);
    expect(p['claim']).toEqual(schema.properties.claim);
    const share = { low: 0.2, medium: 0.5, high: 0.8 };
    const gemini = buildBody({ profile: { ...PROFILE, openrouterId: 'google/gemini-x' }, messages: [], schema, mode: 'json_schema', pinnedOutput: 700, effortShare: share });
    expect((gemini.response_format as { json_schema: { schema: unknown } }).json_schema.schema).toEqual(textEnumSchema(schema));
  });
});

describe('OpenRouter responses and errors (ARCHITECTURE.md §7.3)', () => {
  it('reads text, usage and cost from a completion', () => {
    const r = parseCompletion({
      id: 'gen-1',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.002, completion_tokens_details: { reasoning_tokens: 5 }, prompt_tokens_details: { cached_tokens: 60 } },
    });
    expect(r).toEqual({ text: '{"ok":true}', generationId: 'gen-1', usage: { promptTokens: 100, completionTokens: 20, reasoningTokens: 5, cachedTokens: 60 }, cost: 0.002, finishReason: 'stop' });
  });

  it('classifies HTTP failures', () => {
    const req = { provider: { require_parameters: true, allow_fallbacks: true } } as CompletionRequest;
    expect(classifyError(429, { error: { message: 'slow down' } }, '', '3', req).kind).toBe('rate_limit');
    expect(classifyError(429, null, '', '3', req).opts.retryAfterMs).toBe(3000);
    expect(classifyError(503, null, 'busy', null, req).kind).toBe('server');
    expect(classifyError(401, null, 'bad key', null, req).kind).toBe('auth');
    expect(classifyError(404, { error: { message: 'No endpoints found matching your data policy' } }, '', null, req)).toMatchObject({ kind: 'unsupported', opts: { param: 'response_format' } });
    expect(classifyError(400, { error: { message: 'temperature is not supported by this model' } }, '', null, req)).toMatchObject({ kind: 'unsupported', opts: { param: 'temperature' } });
    expect(classifyError(400, { error: { message: 'json_schema is unsupported' } }, '', null, req).opts.param).toBe('response_format');
    expect(classifyError(400, { error: { message: 'messages must not be empty' } }, '', null, req).kind).toBe('bad_request');
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('CostGuard (ARCHITECTURE.md §7.5)', () => {
  it('reserves the worst case and books the real cost', () => {
    expect(reservationUsd(PRICING, 10_000, 2_700)).toBeCloseTo(10_000 * 2e-6 + 2_700 * 8e-6, 10);
    const g = new CostGuard(1);
    const r = g.reserve(0.2);
    expect(g.reserved).toBe(0.2);
    expect(g.settle(r, 0.05)).toBe(0.05);
    expect(g.spent).toBe(0.05);
    expect(g.reserved).toBe(0);
  });

  it('charges the full reservation when the real cost is unknown', () => {
    const g = new CostGuard(1);
    expect(g.settle(g.reserve(0.3), null)).toBe(0.3);
    expect(g.spent).toBe(0.3);
  });

  it('refuses a call that would cross the cap, and warns at 80%', () => {
    const warns: number[] = [];
    const g = new CostGuard(1, 0, (spent) => warns.push(spent));
    g.settle(g.reserve(0.85), 0.85);
    expect(warns).toHaveLength(1);
    const r = g.reserve(0.1);
    expect(() => g.reserve(0.1)).toThrow(CostCapReached);
    g.settle(r, 0.1);
    g.raiseCap(2);
    expect(() => g.reserve(0.5)).not.toThrow();
  });

  it('estimates from usage when the provider reports no cost', () => {
    expect(estimateUsd(PRICING, { promptTokens: 1000, completionTokens: 100, reasoningTokens: 0, cachedTokens: 0 })).toBeCloseTo(1000 * 1e-6 + 100 * 4e-6, 10);
  });

  it('parses catalogue prices and takes the maximum across endpoints', () => {
    const e = parseModel({ id: 'a/b', context_length: 1000, pricing: { prompt: '0.000001', completion: '0.000004' }, supported_parameters: ['temperature'] });
    expect(e.contextLength).toBe(1000);
    expect(e.pricing.prompt).toBe(1e-6);
    expect(maxPricing([parsePricing({ prompt: '1' }), parsePricing({ prompt: '2', completion: '3' })])).toMatchObject({ prompt: 2, completion: 3 });
  });
});

describe('Limiter', () => {
  it('never runs more calls at once than the pools allow', async () => {
    const limiter = new Limiter(2);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const release = await limiter.acquire('a', 4);
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        release();
      }),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});

/* ---- callModel ------------------------------------------------------------------ */

const noopLog: CallLog = { sent: () => 1, done: () => undefined };
const recordingLog = (): CallLog & { sent_: SentRecord[]; done_: DoneRecord[] } => {
  const sent_: SentRecord[] = [];
  const done_: DoneRecord[] = [];
  return { sent_, done_, sent: (r) => sent_.push(r), done: (_id, r) => void done_.push(r) };
};

function callOptions(provider: LLMProvider, over: Partial<Parameters<typeof callModel>[0]> = {}) {
  return {
    provider,
    limiter: new Limiter(4),
    alias: 'test',
    maxConcurrency: 4,
    guard: new CostGuard(1),
    pricing: PRICING,
    promptTokensEst: 1000,
    body: () => buildBody({ profile: PROFILE, messages: [], schema: {}, mode: 'json_schema', pinnedOutput: 700, effortShare: { low: 0.2, medium: 0.5, high: 0.8 } }),
    onUnsupported: () => false,
    attemptTimeoutMs: 50,
    transportRetries: 2,
    clock: new DecisionClock(10_000, Date.now),
    ceilingFraction: 1,
    purpose: 'initial' as const,
    firstAttempt: 1,
    signal: new AbortController().signal,
    log: noopLog,
    now: Date.now,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
    random: () => 0.5,
    ...over,
  };
}

class ScriptedProvider implements LLMProvider {
  calls = 0;
  constructor(private readonly steps: (CompletionResult | ProviderError | 'hang')[]) {}
  async complete(_req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    const step = this.steps[Math.min(this.calls++, this.steps.length - 1)]!;
    if (step === 'hang') {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new ProviderError(signal.reason === 'timeout' ? 'timeout' : 'aborted', 'aborted')), { once: true });
      });
    }
    if (step instanceof ProviderError) throw step;
    return step;
  }
}

const ok = (text = '{"ok":true}', cost: number | null = 0.001): CompletionResult => ({ text, generationId: 'g1', usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, cachedTokens: 0 }, cost, finishReason: 'stop' });

describe('callModel: retries, timeouts and accounting', () => {
  it('retries a 429 with Retry-After and succeeds', async () => {
    const p = new ScriptedProvider([new ProviderError('rate_limit', '429', { retryAfterMs: 1 }), ok()]);
    const log = recordingLog();
    const out = await callModel(callOptions(p, { log }));
    expect(out.attempts).toBe(2);
    expect(log.done_.map((d) => d.status)).toEqual(['error', 'ok']);
    expect(log.done_[1]!.costSource).toBe('usage');
  });

  it('gives up after the transport retries and reports the last error', async () => {
    const p = new ScriptedProvider([new ProviderError('server', '503')]);
    await expect(callModel(callOptions(p, { transportRetries: 1 }))).rejects.toBeInstanceOf(CallFailed);
    expect(p.calls).toBe(2);
  });

  it('does not retry a non-retryable error', async () => {
    const p = new ScriptedProvider([new ProviderError('bad_request', '400')]);
    await expect(callModel(callOptions(p))).rejects.toBeInstanceOf(CallFailed);
    expect(p.calls).toBe(1);
  });

  it('times out a slow attempt and charges the reservation', async () => {
    const p = new ScriptedProvider(['hang', ok()]);
    const guard = new CostGuard(1);
    const out = await callModel(callOptions(p, { guard, attemptTimeoutMs: 20 }));
    expect(out.attempts).toBe(2);
    expect(guard.spent).toBeGreaterThan(0.001); // the timed-out attempt was charged its reservation
  });

  it('stops at the decision ceiling', async () => {
    const p = new ScriptedProvider(['hang']);
    const clock = new DecisionClock(60, Date.now);
    await expect(callModel(callOptions(p, { clock, attemptTimeoutMs: 20, transportRetries: 9 }))).rejects.toMatchObject({ error: { kind: 'timeout' } });
  });

  it('applies one downgrade for an unsupported parameter without spending a retry', async () => {
    const p = new ScriptedProvider([new ProviderError('unsupported', '400', { param: 'response_format' }), ok()]);
    let downgraded = 0;
    const out = await callModel(
      callOptions(p, {
        onUnsupported: () => {
          downgraded++;
          return true;
        },
      }),
    );
    expect(downgraded).toBe(1);
    expect(out.attempts).toBe(2);
  });

  it('falls back to /generation, then to an estimate, for the cost', async () => {
    const withGeneration: LLMProvider = {
      complete: async () => ok('{"a":1}', null),
      generationCost: async () => 0.004,
    };
    const guard = new CostGuard(1);
    const log = recordingLog();
    await callModel(callOptions(withGeneration, { guard, log }));
    expect(log.done_[0]!.costSource).toBe('generation');
    expect(guard.spent).toBe(0.004);

    const noGeneration: LLMProvider = { complete: async () => ok('{"a":1}', null) };
    const log2 = recordingLog();
    const guard2 = new CostGuard(1);
    await callModel(callOptions(noGeneration, { guard: guard2, log: log2 }));
    expect(log2.done_[0]!.costSource).toBe('estimate');
    expect(guard2.spent).toBeCloseTo(estimateUsd(PRICING, { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, cachedTokens: 0 }), 10);
  });

  it('charges nothing for a request refused before any output (content_filter, no usage)', async () => {
    const refused: LLMProvider = {
      complete: async () => ({ text: '', generationId: 'gen-r', usage: null, cost: null, finishReason: 'content_filter' }),
      generationCost: async () => null,
    };
    const guard = new CostGuard(1);
    const log = recordingLog();
    await callModel(callOptions(refused, { guard, log }));
    expect(guard.spent).toBe(0);
    expect(guard.reserved).toBe(0);
    expect(log.done_[0]!.costUsd).toBe(0);
    // a refusal that reports usage is charged as usual
    const billed: LLMProvider = { complete: async () => ({ ...ok('', null), finishReason: 'content_filter' }) };
    const guard2 = new CostGuard(1);
    await callModel(callOptions(billed, { guard: guard2 }));
    expect(guard2.spent).toBeGreaterThan(0);
  });

  it('stops before the call when the cost cap is reached', async () => {
    const guard = new CostGuard(0.000001);
    await expect(callModel(callOptions(new ScriptedProvider([ok()]), { guard }))).rejects.toBeInstanceOf(CostCapReached);
  });

  it('writes the llm_calls row before the request goes out', async () => {
    const log = recordingLog();
    const p: LLMProvider = {
      complete: async () => {
        expect(log.sent_).toHaveLength(1); // already logged as "sent"
        expect(log.done_).toHaveLength(0);
        return ok();
      },
    };
    await callModel(callOptions(p, { log }));
    expect(log.done_).toHaveLength(1);
  });
});

describe('MockProvider', () => {
  it('answers with a valid instance of the request schema', async () => {
    const schema = {
      type: 'object',
      properties: {
        reasoning: { type: 'string' },
        notebook: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        vote: { anyOf: [{ type: 'integer', enum: [1, 2, 3] }, { type: 'string', enum: ['abstain'] }] },
      },
      required: ['reasoning', 'notebook', 'vote'],
      additionalProperties: false,
    };
    const m = new MockProvider({ seed: 3 });
    const body = buildBody({ profile: PROFILE, messages: [], schema, mode: 'json_schema', pinnedOutput: 700, effortShare: { low: 0.2, medium: 0.5, high: 0.8 } });
    const res = await m.complete(body, new AbortController().signal);
    const parsed = extractJson(res.text);
    expect(parsed.ok).toBe(true);
    const v = (parsed as { value: Record<string, unknown> }).value;
    expect(typeof v['reasoning']).toBe('string');
    expect([1, 2, 3, 'abstain']).toContain(v['vote']);
  });

  it('can simulate malformed, illegal and failing answers', async () => {
    const plans: ('malformed' | 'illegal' | 'truncated')[] = ['malformed', 'illegal', 'truncated'];
    for (const plan of plans) {
      const m = new MockProvider({ plan: () => plan });
      const schema = { type: 'object', properties: { vote: { type: 'integer', enum: [1] } }, required: ['vote'], additionalProperties: false };
      const body = buildBody({ profile: PROFILE, messages: [], schema, mode: 'json_schema', pinnedOutput: 700, effortShare: { low: 0.2, medium: 0.5, high: 0.8 } });
      const res = await m.complete(body, new AbortController().signal);
      const parsed = extractJson(res.text);
      if (plan === 'illegal') expect((parsed as { value: Record<string, unknown> }).value['vote']).toBe(99);
      else expect(parsed.ok).toBe(false);
    }
  });
});

describe("routing price ceiling (owner rule 2026-10-21: never above the maker's own price)", () => {
  // prices per million tokens, shaped like the live OpenRouter endpoints on 2026-10-21
  const M = 1e-6;
  const price = (inp: number, out: number): Pricing => ({ prompt: inp * M, completion: out * M, request: 0, internalReasoning: 0, cacheRead: 0, cacheWrite: 0 });
  const ep = (provider: string, tag: string, inp: number, out: number): Endpoint => ({ provider, tag, pricing: price(inp, out) });
  const perM = (c: { prompt: number; completion: number }) => [Math.round(c.prompt / M * 1000) / 1000, Math.round(c.completion / M * 1000) / 1000];

  it('GPT-6 Astra: the maker price ($10/$50); flex is fine, fast/ultrafast and reseller surcharges are not', () => {
    const eps = [ep('OpenAI', 'openai/flex', 5, 25), ep('Azure', 'azure', 10, 50), ep('OpenAI', 'openai', 10, 50), ep('Amazon Bedrock', 'amazon-bedrock/us-west-2', 11, 55),
      ep('OpenAI', 'openai/fast', 20, 100), ep('OpenAI', 'openai/ultrafast', 60, 300)];
    const r = routingCap('openai/gpt-6-astra', price(10, 50), eps);
    expect(perM(r.cap)).toEqual([10, 50]);
    expect(perM(r.pricing)).toEqual([10, 50]); // the guard reserves $50/M, not $300/M
  });

  it('Claude Opus: its own "fast" tier and the +10% regional resellers are excluded', () => {
    const eps = [ep('Anthropic', 'anthropic', 4, 20), ep('Anthropic', 'anthropic/fast', 8, 40), ep('Google', 'google-vertex/us', 4.4, 22), ep('Amazon Bedrock', 'amazon-bedrock/us-east-1', 4.4, 22)];
    expect(perM(routingCap('anthropic/claude-opus-5.5', price(4, 20), eps).cap)).toEqual([4, 20]);
  });

  it(`Grok: xAI's list price; its "priority" tier is excluded`, () => {
    const eps = [ep('xAI', 'xai', 2, 6), ep('xAI', 'xai/zdr/us', 2.2, 6.6), ep('xAI', 'xai/priority', 4, 12)];
    expect(perM(routingCap('x-ai/grok-4.7', price(2, 6), eps).cap)).toEqual([2, 6]);
  });

  it("an open model whose list price is a cheaper host: the maker's own price (GLM 5.3: Z.AI $1.4/$4.4)", () => {
    const eps = [ep('Wafer', 'wafer/fp4', 0.179, 1.4), ep('Novita', 'novita/fp8', 0.63, 1.98), ep('Z.AI', 'z-ai/fp8', 1.4, 4.4), ep('Alibaba', 'alibaba/prime', 2.8, 8.8)];
    const r = routingCap('z-ai/glm-5.3', price(0.079, 1.4), eps);
    expect(perM(r.cap)).toEqual([1.4, 4.4]);
    expect(perM(r.pricing)).toEqual([1.4, 4.4]); // Alibaba "prime" at $2.8/$8.8 is above the ceiling
  });

  it('a model its maker does not host: the lowest ceiling that still leaves 3 hosts', () => {
    const eps = [ep('Baidu', 'baidu/fp8', 0.433, 0.865), ep('Parasail', 'parasail/fp8', 0.45, 3.48), ep('Relace', 'relace/fp4', 0.9, 1.5), ep('Cloudflare', 'cloudflare', 1.15, 2.55)];
    const r = routingCap('deepseek/deepseek-v4-pro', price(0.431, 0.862), eps);
    expect(perM(r.cap)).toEqual([1.15, 2.55]); // the 3 cheapest by in + out: Baidu, Relace, Cloudflare; Parasail's $3.48 output is over
    expect(eps.filter((e) => e.pricing.prompt <= r.cap.prompt && e.pricing.completion <= r.cap.completion)).toHaveLength(3);
  });

  it('the request carries the ceiling as max_price in USD per million tokens, without float dust', () => {
    const body = buildBody({ profile: PROFILE, messages: [], schema: {}, mode: 'json_object', pinnedOutput: 700, effortShare: { low: 0.2, medium: 0.5, high: 0.8 }, priceCap: { prompt: 10 * M, completion: 50 * M } });
    const mp = body.provider!.max_price!; // a hair high (1e-7 relative), never below the endpoint price
    expect(mp.prompt).toBeGreaterThanOrEqual(10);
    expect(mp.prompt).toBeLessThan(10.0001);
    expect(mp.completion).toBeGreaterThanOrEqual(50);
    expect(mp.completion).toBeLessThan(50.0001);
    // a per-token price that does not survive the trip exactly (Gemini 3.8 Flash $0.825/M) still arrives at or above it
    const flash = buildBody({ profile: PROFILE, messages: [], schema: {}, mode: 'json_object', pinnedOutput: 700, effortShare: { low: 0.2, medium: 0.5, high: 0.8 }, priceCap: { prompt: 0.000000825, completion: 0.000004125 } });
    expect(flash.provider!.max_price!.prompt).toBeGreaterThanOrEqual(0.825);
    expect(flash.provider!.max_price!.completion).toBeGreaterThanOrEqual(4.125);
    const none = buildBody({ profile: PROFILE, messages: [], schema: {}, mode: 'json_object', pinnedOutput: 700, effortShare: { low: 0.2, medium: 0.5, high: 0.8 } });
    expect(none.provider?.max_price).toBeUndefined();
  });

  it('a 404 from the price ceiling is a bad_request, never an output-mode downgrade', () => {
    const req = { model: 'x', messages: [], max_tokens: 10, usage: { include: true }, provider: { allow_fallbacks: true, require_parameters: true, max_price: { prompt: 1, completion: 1 } } } as CompletionRequest;
    const e = classifyError(404, { error: { message: 'No endpoints found that satisfy the max price for this request' } }, '', null, req);
    expect(e.kind).toBe('bad_request');
    const mode = classifyError(404, { error: { message: 'No endpoints found that can handle the requested parameters' } }, '', null, req);
    expect(mode.kind).toBe('unsupported');
  });
});
