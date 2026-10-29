import type { Pricing } from './catalog';
import { estimateUsd, reservationUsd, type CostGuard, type CostSource } from './cost';
import type { Limiter } from './limiter';
import { ProviderError, type CompletionRequest, type CompletionResult, type LLMProvider, type Usage } from './types';

/**
 * The decision ceiling (ARCHITECTURE.md §7.3): one hard limit per decision, measured from the
 * first slot acquisition. Queue time before that never counts.
 */
export class DecisionClock {
  private start: number | null = null;
  constructor(
    readonly ceilingMs: number,
    private readonly now: () => number,
  ) {}
  mark(): void {
    if (this.start === null) this.start = this.now();
  }
  /** Absolute deadline for a share of the ceiling (the initial call may use 60%). */
  deadline(fraction: number): number {
    return this.start === null ? Number.POSITIVE_INFINITY : this.start + fraction * this.ceilingMs;
  }
}

export interface SentRecord {
  attempt: number;
  purpose: 'initial' | 'repair' | 'ping';
  request: CompletionRequest;
  reservedUsd: number;
  queueMs: number;
}

export interface DoneRecord {
  status: 'ok' | 'error' | 'timeout';
  latencyMs: number;
  generationId: string | null;
  usage: Usage | null;
  costUsd: number;
  costSource: CostSource;
  error?: string;
  responseText?: string;
}

/** The `llm_calls` hook: a row is written with status `sent` before the request goes out. */
export interface CallLog {
  sent(r: SentRecord): number;
  done(id: number, r: DoneRecord): void;
}

export interface CallOptions {
  provider: LLMProvider;
  limiter: Limiter;
  alias: string;
  maxConcurrency: number;
  guard: CostGuard;
  pricing: Pricing;
  promptTokensEst: number;
  /** Builds the request; called per attempt, so a downgrade takes effect on the retry. */
  body: () => CompletionRequest;
  /** Apply a downgrade for an unsupported parameter; true = retry once (not a transport retry). */
  onUnsupported: (e: ProviderError) => boolean;
  attemptTimeoutMs: number;
  transportRetries: number;
  clock: DecisionClock;
  /** Share of the decision ceiling this call may use up to (0.6 initial, 1.0 repair). */
  ceilingFraction: number;
  purpose: SentRecord['purpose'];
  /** Numbering continues across the calls of one decision. */
  firstAttempt: number;
  signal: AbortSignal;
  log: CallLog;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => number;
}

export interface CallOutcome {
  result: CompletionResult;
  attempts: number;
}

export class CallFailed extends Error {
  constructor(
    readonly error: ProviderError,
    readonly attempts: number,
  ) {
    super(error.message);
    this.name = 'CallFailed';
  }
}

export const MAX_RETRY_AFTER_MS = 20_000;

/**
 * One call with its transport attempts (ARCHITECTURE.md §7.3): each attempt holds a slot, has
 * its own timeout and its own cost reservation; 429/5xx/network errors and timeouts are retried
 * with exponential backoff and jitter (honouring Retry-After up to 20 s).
 */
export async function callModel(o: CallOptions): Promise<CallOutcome> {
  let failures = 0;
  let downgradeUsed = false;
  let attempt = o.firstAttempt - 1;
  for (;;) {
    if (o.signal.aborted) throw new CallFailed(new ProviderError('aborted', 'aborted'), attempt - o.firstAttempt + 1);
    attempt++;
    const q0 = o.now();
    const release = await o.limiter.acquire(o.alias, o.maxConcurrency);
    const queueMs = o.now() - q0;
    o.clock.mark();
    const deadline = o.clock.deadline(o.ceilingFraction);
    const remaining = deadline - o.now();
    if (remaining <= 0) {
      release();
      throw new CallFailed(new ProviderError('timeout', 'decision time limit reached'), attempt - o.firstAttempt);
    }
    const body = o.body();
    let reservation;
    try {
      reservation = o.guard.reserve(reservationUsd(o.pricing, o.promptTokensEst, body.max_tokens));
    } catch (e) {
      release();
      throw e; // CostCapReached: the caller pauses the game
    }
    const logId = o.log.sent({ attempt, purpose: o.purpose, request: body, reservedUsd: reservation.amount, queueMs });
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort('aborted');
    o.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort('timeout'), Math.min(o.attemptTimeoutMs, remaining));
    const t0 = o.now();
    let result: CompletionResult | null = null;
    let error: ProviderError | null = null;
    try {
      result = await o.provider.complete(body, ctrl.signal);
    } catch (e) {
      error = e instanceof ProviderError ? e : new ProviderError('network', (e as Error).message);
      if (ctrl.signal.aborted && error.kind !== 'aborted' && ctrl.signal.reason === 'timeout') error = new ProviderError('timeout', 'attempt timed out');
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      release();
    }
    const latencyMs = o.now() - t0;

    if (result) {
      let cost: number | null = result.cost;
      let source: CostSource = 'usage';
      // A request refused before any output (content_filter, no usage, no text) is not billed by OpenRouter; charging
      // its reservation would count up to the full worst case of a call that cost nothing. Its generation record has
      // no cost either, so it is not looked up (that lookup waits and retries for seconds).
      if (cost === null && result.finishReason === 'content_filter' && !result.usage && result.text === '') {
        cost = 0;
        source = 'estimate';
      }
      if (cost === null && result.generationId && o.provider.generationCost) {
        cost = await o.provider.generationCost(result.generationId, o.signal);
        source = 'generation';
      }
      if (cost === null && result.usage) {
        cost = estimateUsd(o.pricing, result.usage);
        source = 'estimate';
      }
      if (cost === null) source = 'reserved';
      const charged = o.guard.settle(reservation, cost);
      o.log.done(logId, { status: 'ok', latencyMs, generationId: result.generationId, usage: result.usage, costUsd: charged, costSource: source, responseText: result.text });
      return { result, attempts: attempt - o.firstAttempt + 1 };
    }

    const err = error!;
    const charged = o.guard.settle(reservation, null);
    o.log.done(logId, { status: err.kind === 'timeout' ? 'timeout' : 'error', latencyMs, generationId: null, usage: null, costUsd: charged, costSource: 'reserved', error: err.message });
    if (err.kind === 'unsupported' && !downgradeUsed && o.onUnsupported(err)) {
      downgradeUsed = true;
      continue;
    }
    if (!err.retryable) throw new CallFailed(err, attempt - o.firstAttempt + 1);
    failures++;
    if (failures > o.transportRetries) throw new CallFailed(err, attempt - o.firstAttempt + 1);
    const base = err.opts.retryAfterMs !== undefined ? Math.min(err.opts.retryAfterMs, MAX_RETRY_AFTER_MS) : Math.min(1000 * 2 ** (failures - 1), 8000) * (0.5 + 0.5 * o.random());
    if (o.now() + base >= deadline) throw new CallFailed(err, attempt - o.firstAttempt + 1);
    await o.sleep(base, o.signal);
  }
}

export const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
