import { ProviderError, type CompletionRequest, type CompletionResult, type LLMProvider } from './types';

/**
 * A provider that answers from the request's own JSON schema, for tests and dry runs
 * (`ww play --mock`). It never touches the network.
 */
export type MockBehaviour =
  | 'ok' // a valid answer built from the schema
  | 'malformed' // prose with no JSON
  | 'truncated' // a cut-off JSON object
  | 'illegal' // valid JSON, illegal option
  | 'no_cost' // valid answer, but no usage/cost in the response
  | ProviderError // the attempt fails
  | { text: string }; // exactly this reply

export interface MockOptions {
  seed?: number;
  /** Decides what the n-th call (1-based) does. Default: always 'ok'. */
  plan?: (req: CompletionRequest, n: number) => MockBehaviour;
  /** Simulated latency; the caller's attempt timeout still applies. */
  latencyMs?: number;
  /** Price per call reported as `usage.cost`. */
  costPerCall?: number;
}

export class MockProvider implements LLMProvider {
  calls = 0;
  private rnd: number;
  constructor(private readonly o: MockOptions = {}) {
    this.rnd = o.seed ?? 12345;
  }
  private next(n: number): number {
    this.rnd = (this.rnd * 1103515245 + 12345) & 0x7fffffff;
    return this.rnd % Math.max(1, n);
  }

  async complete(req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    const n = ++this.calls;
    const behaviour = this.o.plan?.(req, n) ?? 'ok';
    if (this.o.latencyMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(finish, this.o.latencyMs);
        function finish() {
          clearTimeout(t);
          signal.removeEventListener('abort', onAbort);
          resolve();
        }
        function onAbort() {
          clearTimeout(t);
          reject(new ProviderError(signal.reason === 'timeout' ? 'timeout' : 'aborted', 'aborted while waiting'));
        }
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (behaviour instanceof ProviderError) throw behaviour;
    const schema = schemaOf(req);
    const answer = schema ? (generate(schema, (k) => this.next(k), '') as Record<string, unknown>) : {};
    let text: string;
    if (typeof behaviour === 'object') text = behaviour.text;
    else if (behaviour === 'malformed') text = 'I think we should wait and see what the others say.';
    else if (behaviour === 'truncated') text = truncate(JSON.stringify(answer));
    else if (behaviour === 'illegal') text = JSON.stringify({ ...answer, ...illegalFields(answer) });
    else text = JSON.stringify(answer);
    const promptTokens = JSON.stringify(req.messages).length / 4;
    const usage = { promptTokens: Math.round(promptTokens), completionTokens: Math.round(text.length / 4), reasoningTokens: 0, cachedTokens: 0 };
    if (behaviour === 'no_cost') return { text, generationId: null, usage: null, cost: null, finishReason: 'stop' };
    return { text, generationId: `gen-${n}`, usage, cost: this.o.costPerCall ?? 0.0005, finishReason: behaviour === 'truncated' ? 'length' : 'stop' };
  }
}

/** A reply cut off mid-object, as a model does when it runs out of output tokens. */
function truncate(json: string): string {
  return json.slice(0, Math.max(1, Math.floor(json.length * 0.6))).replace(/\}+$/, '');
}

/** The schema sent with the request, or the one embedded in the prompt (prompt-only mode). */
export function schemaOf(req: CompletionRequest): Record<string, unknown> | null {
  const rf = req.response_format;
  if (rf && 'json_schema' in rf) return rf.json_schema.schema;
  const text = req.messages
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text).join('\n')))
    .join('\n');
  const marker = text.lastIndexOf('It must match this JSON schema:');
  if (marker < 0) return null;
  const start = text.indexOf('{', marker);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

const SAMPLE_TEXT: Record<string, string> = {
  reasoning: 'I weigh what I know: who spoke when, who voted how, and what serves my side best right now.',
  inner_voice: 'I weigh what I know: who spoke when, who voted how, and what serves my side best right now.',
  thoughts: 'I weigh what I know: who spoke when, who voted how, and what serves my side best right now.',
  notebook: 'Watching the quiet ones. No confirmed information yet.',
  speech: 'I have nothing solid yet, but the silence from some of you is louder than any claim.',
  message: 'Let us take the loudest one tonight.',
  result: 'not a werewolf',
};

/** A valid instance of a strict schema (enums are sampled, so different calls differ). */
export function generate(schema: Record<string, unknown>, rnd: (n: number) => number, key: string): unknown {
  const any = schema['anyOf'] as Record<string, unknown>[] | undefined;
  if (any && any.length) {
    const real = any.filter((s) => s['type'] !== 'null');
    const pick = real.length && rnd(10) > 1 ? real[rnd(real.length)]! : any.find((s) => s['type'] === 'null') ?? real[0]!;
    return generate(pick, rnd, key);
  }
  const en = schema['enum'] as unknown[] | undefined;
  if (en && en.length) return en[rnd(en.length)];
  switch (schema['type']) {
    case 'null':
      return null;
    case 'boolean':
      return rnd(2) === 1;
    case 'integer':
    case 'number':
      return rnd(5) + 1;
    case 'array': {
      const items = (schema['items'] ?? {}) as Record<string, unknown>;
      const pool = (items['enum'] as unknown[] | undefined) ?? [];
      const count = Math.min(2, pool.length);
      return [...pool].slice(0, count);
    }
    case 'object': {
      const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) out[k] = generate(v, rnd, k);
      return out;
    }
    default:
      return SAMPLE_TEXT[key] ?? 'ok';
  }
}

/** Replace option fields with values that are certainly not legal. */
function illegalFields(answer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['vote', 'target', 'lean', 'proposed_target', 'poison']) if (k in answer) out[k] = 99;
  if ('targets' in answer) out['targets'] = [99, 98];
  if ('choice' in answer) out['choice'] = 'not-an-option';
  if (Object.keys(out).length === 0) out['inner_voice'] = 42;
  return out;
}
