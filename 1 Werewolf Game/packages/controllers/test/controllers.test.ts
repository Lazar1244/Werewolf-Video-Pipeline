import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPromptPack, computeBudget, estimateTokens, buildSystemPrompt, makePack } from '@ww/context';
import { advance, answer as engineAnswer, createGame, ENGINE_VERSION, validate, type EngineState } from '@ww/engine';
import { CostCapReached, CostGuard, Limiter, MockProvider, ProviderError, schemaOf, type CatalogEntry, type CompletionRequest, type LLMProvider, type MockBehaviour } from '@ww/llm';
import {
  GameSnapshotSchema,
  RulesSchema,
  layerRules,
  resolveSentinels,
  type DecisionRequest,
  type EngineEvent,
  type GameSnapshot,
  type ModelProfile,
  type RoleId,
  type SeatId,
} from '@ww/shared';
import { describeDowngrade, LLMController, normalizeDecision, ProviderAuthError, unsupportedParams } from '../src/llm-controller';
import { BotController } from '../src/bot-controller';

const ROOT = join(import.meta.dirname, '../../..');
const PACK = loadPromptPack(join(ROOT, 'prompts'));
const DEFAULT_RULES = RulesSchema.parse(JSON.parse(readFileSync(join(ROOT, 'config/rules/default.json'), 'utf8')));
const NAMES = ['Alba', 'Bram', 'Cora', 'Dario', 'Elin', 'Fenn', 'Greta', 'Hugo', 'Ines', 'Jonas'];
const CARDS: RoleId[] = ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager'];

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
  attemptTimeoutMs: 5000,
  maxConcurrency: 4,
  cacheControl: 'auto',
};
const ENTRY: CatalogEntry = {
  id: 'vendor/model-1',
  contextLength: 128_000,
  pricing: { prompt: 1e-6, completion: 4e-6, request: 0, internalReasoning: 0, cacheRead: 0, cacheWrite: 0 },
  supportedParameters: ['structured_outputs', 'temperature'],
  source: 'catalog',
};

function snapshotOf(): GameSnapshot {
  const seats = CARDS.length;
  const rules = resolveSentinels(layerRules(DEFAULT_RULES), seats);
  const l0 = estimateTokens(buildSystemPrompt(PACK, CARDS, 0, rules));
  return GameSnapshotSchema.parse({
    engineVersion: ENGINE_VERSION,
    compositionId: 'test',
    game: { seed: 'ctrl', seats, cards: CARDS, rules, names: NAMES, maskNames: [], humanSlots: [], fixedDeal: true },
    slots: Array.from({ length: seats }, (_, i) => ({ slot: i + 1, controller: 'ai', profile: PROFILE, fallbackAlias: null, humanName: null })),
    budget: computeBudget({ window: 128_000, outputReserve: 700, transcriptTokenBudget: 60_000, l0Tokens: l0 }),
    pinned: { attemptTimeoutMs: 1000, maxOutputTokens: 700 },
    effortShare: { low: 0.2, medium: 0.5, high: 0.8 },
    transportRetries: 1,
    decisionCeilingMs: 5_000,
    costCapUsd: 1,
    promptPackHash: PACK.hash,
  });
}

/** A game paused at its first request, with the log so far. */
function firstRequest(): { state: EngineState; req: DecisionRequest; events: EngineEvent[] } {
  const snap = snapshotOf();
  const step = advance(createGame(snap.game));
  return { state: step.state, req: step.open[0]!, events: step.events };
}

function controllerWith(provider: LLMProvider, over: Partial<ConstructorParameters<typeof LLMController>[0]> = {}) {
  const snapshot = snapshotOf();
  const models = new Map<SeatId, { profile: ModelProfile; entry: CatalogEntry; mode: 'json_schema'; cache: 'none' }>();
  for (let s = 1; s <= snapshot.game.seats; s++) models.set(s as SeatId, { profile: PROFILE, entry: ENTRY, mode: 'json_schema', cache: 'none' });
  return new LLMController({
    provider,
    limiter: new Limiter(4),
    guard: new CostGuard(1),
    pack: PACK,
    snapshot,
    models,
    log: () => ({ sent: () => 1, done: () => undefined }),
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...over,
  });
}

const signal = () => new AbortController().signal;

/** How a request asks for the inner monologue (the first field of its schema) and in which output mode. */
const asked = (r: CompletionRequest): string => `${r.response_format?.type}/${Object.keys((schemaOf(r)?.['properties'] ?? {}) as object)[0]}`;
const systemText = (r: CompletionRequest): string => {
  const c = r.messages[0]!.content;
  return typeof c === 'string' ? c : c.map((b) => b.text).join('');
};
const REFUSED = { text: '', generationId: null, usage: null, cost: null, finishReason: 'content_filter' } as const;

describe('LLMController (ARCHITECTURE.md §7, ruleset §14.5)', () => {
  it('turns a model answer into a validated decision', async () => {
    const { state, req, events } = firstRequest();
    const c = controllerWith(new MockProvider({ seed: 5 }));
    const res = await c.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(res.answer.kind).toBe('decision');
    expect(res.repairUsed).toBe(false);
    expect(validate(state, req.requestId, (res.answer as { decision: unknown }).decision).ok).toBe(true);
  });

  it('repairs one malformed answer and accepts the second', async () => {
    const { state, req, events } = firstRequest();
    const plan = (_r: unknown, n: number): MockBehaviour => (n === 1 ? 'malformed' : 'ok');
    const provider = new MockProvider({ seed: 5, plan });
    const c = controllerWith(provider);
    const res = await c.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(provider.calls).toBe(2);
    expect(res.answer.kind).toBe('decision');
    expect(res.repairUsed).toBe(true);
  });

  it('asks again when the model skips its inner monologue (ruleset §14.3)', async () => {
    const { state, req, events } = firstRequest();
    let n = 0;
    const provider: LLMProvider = {
      complete: async (r, sig) => {
        const real = await new MockProvider({ seed: 9 }).complete(r, sig);
        if (++n > 1) return real;
        const withoutReasoning = { ...(JSON.parse(real.text) as Record<string, unknown>), inner_voice: '' }; // asked as "inner_voice" since 2026-10-21
        return { ...real, text: JSON.stringify(withoutReasoning) };
      },
    };
    const res = await controllerWith(provider).decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(n).toBe(2);
    expect(res.answer.kind).toBe('decision');
    expect((res.answer as { decision: { reasoning?: string } }).decision.reasoning).toBeTruthy();
  });

  it(`stores the model's "thoughts" or "inner_voice" as the inner monologue, and still accepts the old "reasoning" field`, () => {
    expect(normalizeDecision({ thoughts: 'Bram is too quiet.', vote: 2 })).toEqual({ reasoning: 'Bram is too quiet.', vote: 2 });
    expect(normalizeDecision({ inner_voice: 'Bram is too quiet.', vote: 2 })).toEqual({ reasoning: 'Bram is too quiet.', vote: 2 });
    expect(normalizeDecision({ reasoning: 'old name', vote: 2 })).toEqual({ reasoning: 'old name', vote: 2 });
    // the field with text wins over an empty one, whichever comes first
    expect(normalizeDecision({ inner_voice: 'real', reasoning: '', vote: 2 })).toEqual({ reasoning: 'real', vote: 2 });
    expect(normalizeDecision({ thoughts: ' ', inner_voice: 'real', vote: 2 })).toEqual({ reasoning: 'real', vote: 2 });
  });

  it('gives up with no_answer{invalid} when the repair also fails', async () => {
    const { state, req, events } = firstRequest();
    const provider = new MockProvider({ seed: 5, plan: () => 'illegal' });
    const c = controllerWith(provider);
    const res = await c.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(provider.calls).toBe(2);
    expect(res.answer).toEqual({ kind: 'no_answer', reason: 'invalid' });
    expect(res.problem).toBeTruthy();
  });

  it('makes one fresh call when every transport attempt of the first call fails', async () => {
    const { state, req, events } = firstRequest();
    let calls = 0;
    const provider: LLMProvider = {
      complete: async (r, s) => {
        calls++;
        if (calls <= 2) throw new ProviderError('server', '503');
        return new MockProvider({ seed: 2 }).complete(r, s);
      },
    };
    const c = controllerWith(provider);
    const res = await c.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(calls).toBe(3); // 1 initial + 1 transport retry, then the fresh call
    expect(res.answer.kind).toBe('decision');
  });

  it('reports a timeout as no_answer{timeout} and a dead provider as provider_error', async () => {
    const { state, req, events } = firstRequest();
    const timeouts = controllerWith({ complete: () => Promise.reject(new ProviderError('timeout', 'attempt timed out')) });
    const t = await timeouts.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(t.answer).toEqual({ kind: 'no_answer', reason: 'timeout' });

    const broken = controllerWith({ complete: () => Promise.reject(new ProviderError('bad_request', 'nope')) });
    const b = await broken.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(b.answer).toEqual({ kind: 'no_answer', reason: 'provider_error' });
  });

  it('raises an auth failure instead of playing on', async () => {
    const { state, req, events } = firstRequest();
    const c = controllerWith({ complete: () => Promise.reject(new ProviderError('auth', 'HTTP 401: bad key')) });
    await expect(c.decide(req, events, (d) => validate(state, req.requestId, d), signal())).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('downgrades the output mode once when the provider rejects it, and remembers it', async () => {
    const { state, req, events } = firstRequest();
    const seen: (string | undefined)[] = [];
    let n = 0;
    const provider: LLMProvider = {
      complete: async (r, s) => {
        seen.push(r.response_format?.type);
        if (++n === 1) throw new ProviderError('unsupported', '400', { param: 'response_format' });
        return new MockProvider({ seed: 1 }).complete(r, s);
      },
    };
    const downgrades: string[] = [];
    const c = controllerWith(provider, { onDowngrade: (d) => downgrades.push(describeDowngrade(d)) });
    const res = await c.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(res.answer.kind).toBe('decision');
    expect(seen).toEqual(['json_schema', 'json_object']);
    expect(downgrades).toEqual(['output mode → json_object']);
    expect(c.downgradesOf(req.seat as SeatId).mode).toBe('json_object');
  });

  it('steps down to plain JSON when the model refuses schema mode (content_filter), retries, and remembers it', async () => {
    // Anthropic (2026-10-21) blocks our strict json_schema requests for its top models with an empty refusal
    const { state, req, events } = firstRequest();
    const seen: (string | undefined)[] = [];
    const provider: LLMProvider = {
      complete: async (r, s) => {
        seen.push(r.response_format?.type);
        if (r.response_format?.type === 'json_schema') return { text: '', generationId: null, usage: null, cost: null, finishReason: 'content_filter' };
        return new MockProvider({ seed: 1 }).complete(r, s);
      },
    };
    const downgrades: string[] = [];
    const c = controllerWith(provider, { onDowngrade: (d) => downgrades.push(describeDowngrade(d)) });
    const res = await c.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(res.answer.kind).toBe('decision');
    expect(seen).toEqual(['json_schema', 'json_object']);
    expect(downgrades).toEqual(['output mode → json_object']);
    // the next request for this seat goes straight to plain JSON: no second refusal
    await c.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(seen).toEqual(['json_schema', 'json_object', 'json_object']);
  });

  it('a model that refuses everything gets one step down and one try in the other wording, then no_answer', async () => {
    const { state, req, events } = firstRequest();
    const seen: string[] = [];
    const provider: LLMProvider = {
      complete: async (r) => {
        seen.push(asked(r));
        return REFUSED;
      },
    };
    const downgrades: string[] = [];
    const c = controllerWith(provider, { onDowngrade: (d) => downgrades.push(describeDowngrade(d)) });
    const res = await c.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(res.answer).toEqual({ kind: 'no_answer', reason: 'provider_error' });
    expect(res.repairUsed).toBe(true);
    expect(seen).toEqual(['json_schema/inner_voice', 'json_object/inner_voice', 'json_object/thoughts']); // no extra repair
    // already in json_object: no further step down; the seat keeps its wording (neither was answered)
    const again = await c.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(again.answer).toEqual({ kind: 'no_answer', reason: 'provider_error' });
    expect(seen.slice(3)).toEqual(['json_object/inner_voice', 'json_object/thoughts']);
    expect(downgrades).toEqual(['output mode → json_object']);
  });

  it('switches a seat to the other wording when its model refuses the first, and keeps it (Claude Fable, 2026-10-21)', async () => {
    const { state, req, events } = firstRequest();
    const seen: string[] = [];
    let thoughtsSystem = '';
    const provider: LLMProvider = {
      complete: async (r, s) => {
        seen.push(asked(r));
        if (asked(r).endsWith('/inner_voice')) return REFUSED;
        thoughtsSystem = systemText(r);
        return new MockProvider({ seed: 1 }).complete(r, s);
      },
    };
    const c = controllerWith(provider);
    const res = await c.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(res.answer.kind).toBe('decision');
    expect((res.answer as { decision: { reasoning?: string } }).decision.reasoning).toBeTruthy();
    expect(seen).toEqual(['json_schema/inner_voice', 'json_object/inner_voice', 'json_object/thoughts']);
    // the whole request uses the second wording: system prompt, guidance and schema
    expect(thoughtsSystem).toContain('"thoughts" comes first');
    expect(thoughtsSystem).not.toContain('inner_voice');
    // the next decision of this seat starts in that wording, with no refusal and its repair still free
    const next = await c.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(next.answer.kind).toBe('decision');
    expect(next.repairUsed).toBe(false);
    expect(seen.slice(3)).toEqual(['json_object/thoughts']);
    // the wording belongs to the model: another seat it plays starts in it too (its mode is still its own)
    const other = (req.seat === 1 ? 2 : 1) as SeatId;
    await c.decide({ ...req, seat: other }, events, () => ({ ok: true, decision: {} as never }), signal());
    expect(seen.slice(4)).toEqual(['json_schema/thoughts']);
  });

  it('a pack frozen before the two wordings has no other wording to try: a refusal there ends the decision', async () => {
    const { state, req, events } = firstRequest();
    const files = { ...PACK.files };
    for (const k of Object.keys(files)) if (k.startsWith('reasoning/thoughts/') || k === 'reasoning/rule.md') delete files[k];
    // as stored for games before 2026-10-21: the one wording written into system.md and output.md
    files['system.md'] = files['system.md']!.replace('{{thoughts_rule}}', `- "reasoning" comes first.`).replace('{{thoughts_field}}', 'reasoning');
    files['output.md'] = files['output.md']!.replace('{{thoughts_field}}', 'reasoning');
    const old = makePack(files);
    const seen: string[] = [];
    const provider: LLMProvider = {
      complete: async (r) => {
        seen.push(asked(r));
        return REFUSED;
      },
    };
    const res = await controllerWith(provider, { pack: old }).decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(res.answer).toEqual({ kind: 'no_answer', reason: 'provider_error' });
    expect(seen).toEqual(['json_schema/reasoning', 'json_object/reasoning']); // its own wording only, no switch
  });

  it('a failed refusal retry ends the decision with its repair spent (no fresh-call retry on top)', async () => {
    const { state, req, events } = firstRequest();
    const seen: string[] = [];
    const provider: LLMProvider = {
      complete: async (r) => {
        seen.push(asked(r));
        if (seen.length === 1) return REFUSED;
        throw new ProviderError('bad_request', '400');
      },
    };
    const res = await controllerWith(provider).decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(res.answer).toEqual({ kind: 'no_answer', reason: 'provider_error' });
    expect(res.repairUsed).toBe(true);
    expect(seen).toEqual(['json_schema/inner_voice', 'json_object/inner_voice']);
  });

  it('after a refusal retry, an invalid answer gets no second repair (one repair per decision)', async () => {
    const { state, req, events } = firstRequest();
    const seen: (string | undefined)[] = [];
    const provider: LLMProvider = {
      complete: async (r) => {
        seen.push(r.response_format?.type);
        if (r.response_format?.type === 'json_schema') return { text: '', generationId: null, usage: null, cost: null, finishReason: 'content_filter' };
        return { text: 'not json at all', generationId: null, usage: null, cost: null, finishReason: 'stop' };
      },
    };
    const c = controllerWith(provider);
    const res = await c.decide(req, events, (d) => validate(state, req.requestId, d), signal());
    expect(res.answer).toEqual({ kind: 'no_answer', reason: 'invalid' });
    expect(res.repairUsed).toBe(true);
    expect(seen).toEqual(['json_schema', 'json_object']);
  });

  it('lets a cost-cap stop reach the caller (the game pauses)', async () => {
    const { state, req, events } = firstRequest();
    const c = controllerWith(new MockProvider({ seed: 1 }), { guard: new CostGuard(1e-9) });
    await expect(c.decide(req, events, (d) => validate(state, req.requestId, d), signal())).rejects.toBeInstanceOf(CostCapReached);
  });

  it('never sends another seat’s secrets in the prompt', async () => {
    const { state, req, events } = firstRequest();
    let prompt = '';
    const provider: LLMProvider = {
      complete: async (r, s) => {
        prompt = JSON.stringify(r.messages);
        return new MockProvider({ seed: 1 }).complete(r, s);
      },
    };
    await controllerWith(provider).decide(req, events, (d) => validate(state, req.requestId, d), signal());
    const roleLines = prompt.split('You are the').length - 1;
    expect(roleLines).toBeLessThanOrEqual(1); // only this seat's own role card
  });
});

describe('unsupportedParams', () => {
  it('leaves out a sampling parameter the model no longer lists, from the very first call', () => {
    // Claude Opus 5.5 dropped temperature: sending it made OpenRouter answer "No endpoints found that can handle the
    // requested parameters", which names no parameter, so the game blamed the output mode instead
    const noTemp = { ...ENTRY, supportedParameters: ['structured_outputs', 'response_format', 'reasoning'] };
    expect(unsupportedParams({ profile: PROFILE, entry: noTemp, mode: 'json_schema', cache: 'none' })).toEqual(['temperature']);
    expect(unsupportedParams({ profile: PROFILE, entry: ENTRY, mode: 'json_schema', cache: 'none' })).toEqual([]);
    expect(unsupportedParams({ profile: { ...PROFILE, params: { temperature: null, top_p: null } }, entry: noTemp, mode: 'json_schema', cache: 'none' })).toEqual([]);
    // no catalogue data (offline, or an empty list): nothing is assumed
    expect(unsupportedParams({ profile: PROFILE, entry: { ...noTemp, source: 'override' }, mode: 'json_schema', cache: 'none' })).toEqual([]);
    expect(unsupportedParams({ profile: PROFILE, entry: { ...noTemp, supportedParameters: [] }, mode: 'json_schema', cache: 'none' })).toEqual([]);
  });

  it('the controller starts each seat with those parameters dropped', () => {
    const noTemp = { ...ENTRY, supportedParameters: ['structured_outputs', 'response_format'] };
    const ctl = new LLMController({ models: new Map([[1 as SeatId, { profile: PROFILE, entry: noTemp, mode: 'json_schema' as const, cache: 'none' as const }]]) } as never);
    expect(ctl.downgradesOf(1 as SeatId).dropped).toEqual(['temperature']);
  });
});

describe('normalizeDecision', () => {
  it('drops nulls for optional fields and accepts seat numbers sent as strings', () => {
    expect(normalizeDecision({ reasoning: 'x', notebook: null, vote: '3', second_vote: null })).toEqual({ reasoning: 'x', vote: 3 });
    expect(normalizeDecision({ targets: ['2', 4] })).toEqual({ targets: [2, 4] });
    expect(normalizeDecision({ claim: { role: 'seer', result: null } })).toEqual({ claim: { role: 'seer' } });
    expect(normalizeDecision({ vote: 'abstain' })).toEqual({ vote: 'abstain' });
  });
});

describe('BotController', () => {
  it('answers every request legally', () => {
    const snap = snapshotOf();
    const bot = new BotController('bot-seed');
    let step = advance(createGame(snap.game));
    let guard = 0;
    while (step.status === 'awaiting' && guard++ < 500) {
      const req = step.open[0]!;
      const a = bot.decide(req);
      expect(a.kind).toBe('decision');
      expect(validate(step.state, req.requestId, (a as { decision: unknown }).decision).ok).toBe(true);
      step = engineAnswer(step.state, req.requestId, a);
    }
    expect(step.status).toBe('over');
  });
});
