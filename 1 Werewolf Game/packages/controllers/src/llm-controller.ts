import { buildContext, packFile, render, wordingsOf, type CacheMode, type PromptPack, type Wording } from '@ww/context';
import type { ValidationResult } from '@ww/engine';
import {
  buildBody,
  CallFailed,
  callModel,
  DecisionClock,
  defaultSleep,
  downgradeMode,
  extractJson,
  ProviderError,
  type CallLog,
  type CatalogEntry,
  type CostGuard,
  type Limiter,
  type LLMProvider,
  type OutputMode,
} from '@ww/llm';
import type { Answer, ChatMessage, DecisionRequest, EngineEvent, GameSnapshot, ModelProfile, SeatId } from '@ww/shared';

/** The model behind one AI seat (a profile copy from the snapshot plus its catalogue data). */
export interface SeatModel {
  profile: ModelProfile;
  entry: CatalogEntry;
  mode: OutputMode;
  cache: CacheMode;
}

export interface LLMControllerDeps {
  provider: LLMProvider;
  limiter: Limiter;
  guard: CostGuard;
  pack: PromptPack;
  snapshot: GameSnapshot;
  models: ReadonlyMap<SeatId, SeatModel>;
  /** `llm_calls` logging for one decision. */
  log: (req: DecisionRequest) => CallLog;
  /** A per-game downgrade was applied to a seat (logged as the `SEAT_DOWNGRADE` meta event). */
  onDowngrade?: (d: SeatDowngrade) => void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface DecideResult {
  answer: Answer;
  repairUsed: boolean;
  attempts: number;
  /** Why the answer is a no_answer, for logs. */
  problem?: string;
}

/** One per-game downgrade, as stored in the `SEAT_DOWNGRADE` meta event and replayed on resume. */
export type SeatDowngrade = { seat: SeatId; kind: 'mode'; mode: OutputMode } | { seat: SeatId; kind: 'param'; param: string };

export function describeDowngrade(d: SeatDowngrade): string {
  return d.kind === 'mode' ? `output mode → ${d.mode}` : `dropped parameter ${d.param}`;
}

/** A provider refused our key (401/402/403): no seat can play, so the game must stop. */
export class ProviderAuthError extends Error {}

/** Seat-number fields that some models send as strings ("3"). */
const SEAT_FIELDS = ['vote', 'target', 'lean', 'proposed_target', 'poison'];

/** The fields an answer may carry its inner monologue in: the two wordings asked for, then the older name. */
const THOUGHT_FIELDS = ['thoughts', 'inner_voice', 'reasoning'] as const;

/** The answer's inner monologue: the first of those fields that holds some text. */
function thoughtsOf(v: Record<string, unknown>): string | undefined {
  for (const k of THOUGHT_FIELDS) {
    const x = v[k];
    if (typeof x === 'string' && x.trim() !== '') return x;
  }
  return undefined;
}

/**
 * Light, lossless clean-up before validation: nulls for optional fields are removed, numeric
 * strings in seat fields become numbers. Anything else is left for zod and the engine to judge.
 */
export function normalizeDecision(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...v };
  for (const k of ['notebook', 'second_vote']) if (out[k] === null) delete out[k];
  const seatNum = (x: unknown) => (typeof x === 'string' && /^\s*\d{1,2}\s*$/.test(x) ? Number(x) : x);
  for (const k of SEAT_FIELDS) if (k in out) out[k] = seatNum(out[k]);
  if (Array.isArray(out['targets'])) out['targets'] = out['targets'].map(seatNum);
  // the model answers with "thoughts" or "inner_voice" (how it is asked since 2026-10-21); the game keeps it as `reasoning`
  const thoughts = thoughtsOf(out) ?? THOUGHT_FIELDS.map((k) => out[k]).find((x) => typeof x === 'string');
  if (thoughts !== undefined) out['reasoning'] = thoughts;
  delete out['thoughts'];
  delete out['inner_voice'];
  const claim = out['claim'];
  if (claim && typeof claim === 'object' && !Array.isArray(claim) && (claim as Record<string, unknown>)['result'] === null) {
    const { result: _r, ...rest } = claim as Record<string, unknown>;
    out['claim'] = rest;
  }
  return out;
}

/**
 * Sampling parameters the profile sets but the model's catalogue entry does not list. They are never sent: OpenRouter
 * would find no endpoint for the request ("No endpoints found that can handle the requested parameters"), an error
 * that does not name the parameter, so it could not be dropped on the error alone.
 */
export function unsupportedParams(m: SeatModel | undefined): string[] {
  const e = m?.entry;
  if (!m || !e || e.source !== 'catalog' || e.supportedParameters.length === 0) return [];
  return (['temperature', 'top_p'] as const).filter((p) => m.profile.params[p] !== null && !e.supportedParameters.includes(p));
}

/**
 * LLM controller (ARCHITECTURE.md §7): builds the seat's context, calls its model, parses and
 * validates the answer, and runs the single repair call of ruleset §14.5. The result is
 * always an Answer; the engine applies the ruleset fallback for a no_answer.
 */
export class LLMController {
  private readonly downgrades = new Map<SeatId, { mode?: OutputMode; dropped: string[] }>();
  /** The wording each model (by profile alias) last answered; kept in memory only, relearnt after recovery. */
  private readonly wordings = new Map<string, Wording>();
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly d: LLMControllerDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? defaultSleep;
    this.random = d.random ?? Math.random;
  }

  /** Re-apply downgrades discovered earlier (rebuilt from the SEAT_DOWNGRADE meta events). */
  applyDowngrades(list: readonly SeatDowngrade[]): void {
    for (const d of list) {
      const dg = this.downgradesOf(d.seat);
      if (d.kind === 'mode') dg.mode = d.mode;
      else if (!dg.dropped.includes(d.param)) dg.dropped.push(d.param);
    }
  }

  /** Per-game downgrades recorded so far (rebuilt from meta events on recovery). */
  downgradesOf(seat: SeatId): { mode?: OutputMode; dropped: string[] } {
    let dg = this.downgrades.get(seat);
    if (!dg) {
      dg = { dropped: unsupportedParams(this.d.models.get(seat)) };
      this.downgrades.set(seat, dg);
    }
    return dg;
  }

  async decide(req: DecisionRequest, events: readonly EngineEvent[], validate: (decision: unknown) => ValidationResult, signal: AbortSignal): Promise<DecideResult> {
    if (req.seat === 0) throw new Error('host requests are not answered by a model');
    const seat = req.seat as SeatId;
    const m = this.d.models.get(seat);
    if (!m) throw new Error(`seat ${seat} has no model`);
    const snap = this.d.snapshot;
    const build = (w: Wording) => buildContext({ pack: this.d.pack, game: snap.game, budget: snap.budget, events, request: req, cache: m.cache, wording: w });
    let wording = this.wordings.get(m.profile.alias) ?? wordingsOf(this.d.pack)[0]!;
    let ctx = build(wording);
    let promptTokensEst = Object.values(ctx.tokens).reduce((a, b) => a + b, 0);
    const dg = this.downgradesOf(seat);
    const clock = new DecisionClock(snap.decisionCeilingMs, this.now);
    const log = this.d.log(req);

    const onUnsupported = (e: ProviderError): boolean => {
      const param = e.opts.param;
      if (param === 'response_format') {
        const next = downgradeMode(dg.mode ?? m.mode);
        if (!next) return false;
        dg.mode = next;
        this.d.onDowngrade?.({ seat, kind: 'mode', mode: next });
        return true;
      }
      if (param && ['temperature', 'top_p', 'reasoning'].includes(param) && !dg.dropped.includes(param)) {
        dg.dropped.push(param);
        this.d.onDowngrade?.({ seat, kind: 'param', param });
        return true;
      }
      return false;
    };

    let attempts = 0;
    const call = async (messages: ChatMessage[], purpose: 'initial' | 'repair', fraction: number) => {
      const out = await callModel({
        provider: this.d.provider,
        limiter: this.d.limiter,
        alias: m.profile.alias,
        maxConcurrency: m.profile.maxConcurrency,
        guard: this.d.guard,
        pricing: m.entry.pricing,
        promptTokensEst: promptTokensEst + (messages.length > 2 ? 1500 : 0),
        body: () =>
          buildBody({
            profile: m.profile,
            messages,
            schema: ctx.schema,
            mode: dg.mode ?? m.mode,
            pinnedOutput: snap.pinned.maxOutputTokens,
            priceCap: m.entry.priceCap,
            effortShare: snap.effortShare,
            dropped: dg.dropped,
          }),
        onUnsupported,
        attemptTimeoutMs: snap.pinned.attemptTimeoutMs,
        transportRetries: snap.transportRetries,
        clock,
        ceilingFraction: fraction,
        purpose,
        firstAttempt: attempts + 1,
        signal,
        log,
        now: this.now,
        sleep: this.sleep,
        random: this.random,
      });
      attempts += out.attempts;
      return out.result;
    };

    /**
     * A refusal (finish reason `content_filter`, e.g. Anthropic's "duplicating model outputs" block, 2026-10-21) is
     * sent again, up to twice, at no cost (a refused request is not billed); these retries take the place of the
     * decision's one repair:
     * - in the strict schema mode, the seat steps down to json_object for the rest of the game, like an unsupported
     *   `response_format`, and the same request is sent in that mode;
     * - if that is refused too (or the mode was not strict), the request is rebuilt with the pack's other wording of
     *   the inner monologue (`Wording`), and the model keeps that wording once it is answered.
     */
    const refusedThenRetry = async (r: { text: string; finishReason: string | null }): Promise<{ text: string; retried: boolean; refused: boolean }> => {
      let retried = false;
      if (r.finishReason === 'content_filter' && (dg.mode ?? m.mode) === 'json_schema') {
        dg.mode = 'json_object';
        this.d.onDowngrade?.({ seat, kind: 'mode', mode: 'json_object' });
        r = await call(ctx.messages, 'repair', 1);
        retried = true;
      }
      const other = wordingsOf(this.d.pack).find((w) => w !== wording);
      if (r.finishReason === 'content_filter' && other) {
        wording = other;
        ctx = build(other);
        promptTokensEst = Object.values(ctx.tokens).reduce((a, b) => a + b, 0);
        r = await call(ctx.messages, 'repair', 1);
        retried = true;
        if (r.finishReason !== 'content_filter') this.wordings.set(m.profile.alias, other);
      }
      return { text: r.text, retried, refused: r.finishReason === 'content_filter' };
    };

    const noAnswer = (reason: 'timeout' | 'invalid' | 'provider_error' | 'aborted', problem: string, repairUsed: boolean): DecideResult => ({
      answer: { kind: 'no_answer', reason },
      repairUsed,
      attempts,
      problem,
    });
    const failure = (e: unknown, repairUsed: boolean): DecideResult => {
      if (!(e instanceof CallFailed)) throw e; // CostCapReached and programming errors go up
      attempts += e.attempts;
      if (e.error.kind === 'auth') throw new ProviderAuthError(e.message);
      if (e.error.kind === 'aborted') return noAnswer('aborted', e.message, repairUsed);
      return noAnswer(e.error.kind === 'timeout' ? 'timeout' : 'provider_error', e.message, repairUsed);
    };

    // 1. initial call (at most 60% of the ceiling); if every transport attempt fails, one fresh call
    let initial: { text: string; finishReason: string | null };
    try {
      initial = await call(ctx.messages, 'initial', 0.6);
    } catch (e) {
      if (!(e instanceof CallFailed) || !e.error.retryable) return failure(e, false);
      attempts += e.attempts;
      const retry: ChatMessage[] = [...ctx.messages, { role: 'user', content: packFile(this.d.pack, 'retry.md').trim() }];
      let fresh: { text: string; finishReason: string | null };
      try {
        fresh = await call(retry, 'repair', 1);
      } catch (e2) {
        return failure(e2, true);
      }
      if (fresh.finishReason === 'content_filter') return noAnswer('provider_error', 'the model refused the request (content_filter)', true);
      return this.judge(fresh.text, wording, validate, attempts, true, () => Promise.resolve(null));
    }
    // a refusal is retried (see above); a failure of such a retry ends the decision, its repair spent
    let text: string;
    let retried: boolean;
    try {
      const first = await refusedThenRetry(initial);
      if (first.refused) return noAnswer('provider_error', 'the model refused the request (content_filter)', first.retried);
      text = first.text;
      retried = first.retried;
    } catch (e) {
      return failure(e, true);
    }

    // 2. parse and validate; on failure, one repair call with the issues and the legal options
    // (after a refusal retry the decision has used its one repair already)
    return this.judge(text, wording, validate, attempts, retried, retried ? () => Promise.resolve(null) : async (issues) => {
      const repair: ChatMessage[] = [
        ...ctx.messages,
        { role: 'assistant', content: text.slice(0, 8000) || '(no answer)' }, // an empty assistant turn is rejected by some providers
        { role: 'user', content: `${render(packFile(this.d.pack, 'repair.md'), { issues }).trim()}\n\n${ctx.options}` },
      ];
      try {
        return { text: (await call(repair, 'repair', 1)).text };
      } catch (e) {
        return { failed: failure(e, true) };
      }
    });
  }

  private async judge(
    text: string,
    wording: Wording,
    validate: (decision: unknown) => ValidationResult,
    attempts: number,
    repairUsed: boolean,
    repair: (issues: string) => Promise<{ text: string } | { failed: DecideResult } | null>,
  ): Promise<DecideResult> {
    const check = (t: string): { ok: true; decision: unknown } | { ok: false; issues: string } => {
      const parsed = extractJson(t);
      if (!parsed.ok) return { ok: false, issues: parsed.error };
      // The inner monologue is part of the contract (ruleset §14.3), so a missing one is repaired.
      if (thoughtsOf(parsed.value) === undefined) return { ok: false, issues: `"${wording}" is required: write it first` };
      const v = validate(normalizeDecision(parsed.value));
      return v.ok ? { ok: true, decision: v.decision } : { ok: false, issues: v.issues.join('; ') };
    };
    const first = check(text);
    if (first.ok) return { answer: { kind: 'decision', decision: first.decision }, repairUsed, attempts };
    const r = await repair(first.issues);
    if (r === null) return { answer: { kind: 'no_answer', reason: 'invalid' }, repairUsed, attempts, problem: first.issues };
    if ('failed' in r) return r.failed;
    const second = check(r.text);
    if (second.ok) return { answer: { kind: 'decision', decision: second.decision }, repairUsed: true, attempts };
    return { answer: { kind: 'no_answer', reason: 'invalid' }, repairUsed: true, attempts, problem: second.issues };
  }
}
