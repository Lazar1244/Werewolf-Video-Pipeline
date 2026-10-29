import { createHash } from 'node:crypto';
import { advance, answer as applyAnswer, createGame, lockOpen, validate, type EngineState } from '@ww/engine';
import type { PromptPack } from '@ww/context';
import { BotController, describeDowngrade, LLMController, ProviderAuthError, type SeatDowngrade, type SeatModel } from '@ww/controllers';
import { CostCapReached, CostGuard, Limiter, maxTokensFor, type CallLog, type CatalogEntry, type LLMProvider } from '@ww/llm';
import type { AppConfig, Answer, DecisionRequest, EngineEvent, GameSnapshot, ModelProfile, ResolvedRules, SeatId, SlotId } from '@ww/shared';
import {
  appendEngineEvents,
  abortGame as abortGameRow,
  appendMetaEvent,
  finishLlmCall,
  finishSlots,
  applyDecision,
  bufferDecision,
  insertRequest,
  listBufferedDecisions,
  listDecisions,
  listMetaEvents,
  putSlots,
  pauseGame,
  resumeGame,
  setCostCap,
  setCostSpent,
  setGameStatus,
  setResult,
  startLlmCall,
  type PauseReason,
  type Store,
} from '@ww/store';

/** What a human seat is currently being asked (ARCHITECTURE.md §11.2). */
export interface PendingHuman {
  request: DecisionRequest;
  clientRequestId: string;
  /** Epoch ms, or null while the game is paused (the clock is frozen). */
  deadlineAt: number | null;
  /** Milliseconds left when the clock was frozen. */
  remainingMs: number;
  /** The whole time the request was given. */
  totalMs: number;
  delivered: boolean;
}

export type OrchestratorEvent =
  | { type: 'events'; events: EngineEvent[] }
  | { type: 'request'; seat: SeatId; pending: PendingHuman }
  | { type: 'request_closed'; seat: SeatId; clientRequestId: string }
  | { type: 'status' }
  | { type: 'paused'; reason: PauseReason }
  | { type: 'resumed' }
  | { type: 'aborted' }
  | { type: 'lock_opened' }
  | { type: 'over' };

export interface OrchestratorOptions {
  store: Store;
  gameId: string;
  snapshot: GameSnapshot;
  pack: PromptPack;
  app: AppConfig;
  provider: LLMProvider;
  entries: Map<string, CatalogEntry>;
  /** Profiles the host may remap a seat to (alias → profile), for `remap_seat`. */
  profilesByAlias?: ReadonlyMap<string, SeatModel['profile']>;
  logPrompts?: boolean;
  /** Continue a stored game (rebuilt state, its events and how much it already spent). */
  resume?: { state: EngineState; events: EngineEvent[]; applyOrder: number; spentUsd: number };
  now?: () => number;
}

const HUMAN_LONG = new Set(['speech']);

/**
 * GameOrchestrator (ARCHITECTURE.md §9.3): runs the engine, dispatches each group of requests
 * to its seat's controller, applies the answers in request order and commits every step.
 * It owns time, money, pausing and human deadlines; the engine stays a pure state machine.
 */
export class GameOrchestrator {
  readonly gameId: string;
  readonly snapshot: GameSnapshot;
  private state: EngineState;
  events: EngineEvent[];
  private readonly guard: CostGuard;
  private readonly limiter: Limiter;
  private readonly controller: LLMController;
  private readonly models = new Map<SeatId, SeatModel>();
  private readonly bots = new Map<SeatId, BotController>();
  private readonly humans = new Map<SeatId, SlotId>();
  private readonly pending = new Map<number, PendingHuman & { resolve: (a: Answer) => void; timer?: NodeJS.Timeout }>();
  private readonly listeners = new Set<(e: OrchestratorEvent) => void>();
  private readonly failures = new Map<SeatId, number>();
  private readonly probeAt = new Map<SeatId, number>();
  private readonly disconnected = new Map<SlotId, number>(); // slot → when it went away (epoch ms)
  private readonly away = new Set<SlotId>();
  private readonly awayTimers = new Map<SlotId, NodeJS.Timeout>();
  private readonly graceTimers = new Map<SlotId, NodeJS.Timeout>();
  private applyOrder: number;
  /** Answers that arrived but are not applied yet (persisted as `buffered`, §9.3 step 3). */
  private readonly buffered = new Map<number, Decided>();
  private started = false;
  /** Seats already silently remapped once (§9.5 allows one per game). */
  private readonly remapped = new Set<SeatId>();
  /** A host fallback that must wait for the next Dawn, so night timing reveals nothing (§9.3). */
  private deferredFallback: 'disconnected' | null = null;
  private readonly now: () => number;
  private abort = new AbortController();

  status: 'running' | 'paused' | 'over' | 'aborted' = 'running';
  /** False once the game was aborted (the server is shutting down): stop touching the store. */
  private get writable(): boolean {
    return this.status !== 'aborted';
  }
  pauseReason: PauseReason | null = null;
  /** Where a finished game stands while it waits for, or runs, the debrief (§15b). */
  private stage: 'over_offer' | 'debrief' | null = null;
  lockOpen = false;
  /** A host-safe notice shown to the host (cleared at the next Dawn/Dusk). */
  notice: string | null = null;
  /** What a `provider_failure` pause is about, so the host is told the right fix. */
  pauseDetail: 'model_failed' | 'api_key' | null = null;
  /** A notice held back until the next Dawn/Dusk, so its timing tells the host nothing (§9.5). */
  private heldNotice: string | null = null;

  constructor(private readonly o: OrchestratorOptions) {
    this.gameId = o.gameId;
    this.snapshot = o.snapshot;
    this.now = o.now ?? Date.now;
    this.events = o.resume ? [...o.resume.events] : [];
    this.applyOrder = o.resume?.applyOrder ?? 0;
    this.guard = new CostGuard(o.snapshot.costCapUsd, o.resume?.spentUsd ?? 0);
    this.limiter = new Limiter(o.app.globalConcurrency);
    this.state = o.resume?.state ?? createGame(o.snapshot.game);

    this.controller = new LLMController({
      provider: o.provider,
      limiter: this.limiter,
      guard: this.guard,
      pack: o.pack,
      snapshot: o.snapshot,
      models: this.models,
      log: (req) => this.callLog(req),
      onDowngrade: (d) => {
        appendMetaEvent(o.store, o.gameId, { wallTime: new Date().toISOString(), type: 'SEAT_DOWNGRADE', vis: 'spectator', payload: d });
      },
    });
    const past = listMetaEvents(o.store, o.gameId)
      .filter((m) => m.type === 'SEAT_DOWNGRADE')
      .map((m) => m.payload as SeatDowngrade);
    this.controller.applyDowngrades(past);
    if (o.resume) {
      this.rebuildFailures();
      // answers that arrived but were never applied are already paid for (§9.4 step 3)
      for (const d of listBufferedDecisions(o.store, o.gameId)) {
        const req = this.state.group.find((r) => r.requestId === d.requestId);
        if (req) this.buffered.set(d.requestId, { req, answer: d.answer, source: d.source === 'model' ? 'model' : d.source === 'bot' ? 'bot' : 'human', repairUsed: false });
      }
    }
  }

  // ---- lifecycle ---------------------------------------------------------------

  /**
   * Run the game. The loop lives for the whole game: a pause suspends it (it waits to be woken
   * by `resume()`), it never ends the game (ARCHITECTURE.md §9.3). Call it once per orchestrator;
   * a recovered game is started the same way and simply waits until the host resumes it.
   */
  async run(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.o.resume) {
      const first = advance(this.state);
      this.state = first.state;
      this.commit(first.events, first.open);
    } else {
      // a rebuilt game: re-open whatever it was waiting for, without re-emitting its events
      const again = advance(this.state);
      this.state = again.state;
      this.commit([], again.open);
    }
    this.setupSeats();
    this.refreshLock();
    this.applyBuffered(); // answers that arrived before a pause or a crash are already paid for

    for (;;) {
      if (this.status === 'aborted' || this.status === 'over') return;
      if (this.status === 'paused') {
        await this.waitWhilePaused();
        continue;
      }
      if (this.state.status !== 'awaiting') break;
      const open = [...this.state.group].filter((r) => !(r.requestId in this.state.answers) && !this.buffered.has(r.requestId));
      if (open.length === 0) {
        if (this.applyBuffered()) continue;
        // nothing to ask and nothing to apply: something is wrong, so stop visibly rather than
        // leaving the game quietly stuck
        this.notice = 'the game could not continue and was paused for inspection';
        this.pause('corrupt');
        continue;
      }
      const dispatched = Promise.allSettled(open.map((req) => this.decide(req)));
      // every human request of this group is registered by now, so a fallback the host asked for
      // at night can be applied as soon as the game is out of the night (§9.3)
      this.applyDeferredFallback();
      const settled = await dispatched;
      const errors = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected').map((s) => s.reason as unknown);
      if (!this.writable) return;
      setCostSpent(this.o.store, this.gameId, this.guard.spent);

      const auth = errors.find((e) => e instanceof ProviderAuthError);
      const capped = errors.find((e) => e instanceof CostCapReached);
      const other = errors.find((e) => !(e instanceof ProviderAuthError) && !(e instanceof CostCapReached));
      if (auth) {
        this.notice = 'OpenRouter rejected the API key: check OPENROUTER_API_KEY in .env, restart the server, then press Resume';
        this.pauseDetail = 'api_key';
        this.pause('provider_failure');
        continue;
      }
      if (capped) {
        this.pause('cost_cap'); // the host raises the cap and resumes
        continue;
      }
      if (other) throw other;
      // every answer of the group is in (and persisted): apply them, unless we paused meanwhile
      this.applyBuffered();
      this.refreshLock();
    }
    if (this.state.status === 'over' && this.status === 'running') this.finish();
  }

  /**
   * Apply the answers that are in, in request order, once their whole group is complete and the
   * game is running. Returns true when something was applied.
   */
  private applyBuffered(): boolean {
    if (this.status !== 'running' || !this.writable) return false;
    let applied = false;
    for (;;) {
      const group = this.state.group;
      if (group.length === 0) break;
      const ready = group.every((r) => r.requestId in this.state.answers || this.buffered.has(r.requestId));
      if (!ready) break;
      for (const req of [...group].sort((a, b) => a.requestId - b.requestId)) {
        const d = this.buffered.get(req.requestId);
        if (!d) continue; // already applied in an earlier pass
        this.buffered.delete(req.requestId);
        this.applyOne(d);
        applied = true;
      }
      if (this.state.status !== 'awaiting') break;
    }
    return applied;
  }

  private setupSeats(): void {
    const seating = this.events.find((e) => e.type === 'SEATING');
    if (!seating) return;
    // record which slot ended up in which seat, so results and statistics can be joined later
    const names = new Map(
      ((this.events.find((e) => e.type === 'GAME_START')?.payload as { seats: { seat: SeatId; name: string }[] } | undefined)?.seats ?? []).map((s) => [s.seat, s.name]),
    );
    const seatRows = (seating.payload as { seats: { seat: SeatId; slot: SlotId }[] }).seats.map((s) => {
      const slot = this.snapshot.slots.find((x) => x.slot === s.slot)!;
      return { slot: s.slot, seat: s.seat, displayName: names.get(s.seat) ?? null, controller: slot.controller, humanName: slot.humanName };
    });
    if (this.writable) putSlots(this.o.store, this.gameId, seatRows);
    for (const s of (seating.payload as { seats: { seat: SeatId; slot: SlotId; human: boolean }[] }).seats) {
      const slot = this.snapshot.slots.find((x) => x.slot === s.slot)!;
      if (slot.controller === 'human') this.humans.set(s.seat, s.slot);
      else if (slot.controller === 'ai' && slot.profile) {
        const entry = this.o.entries.get(slot.profile.openrouterId);
        if (!entry) throw new Error(`no catalogue entry for ${slot.profile.openrouterId}`);
        this.models.set(s.seat, { profile: slot.profile, entry, mode: modeOf(slot.profile, entry), cache: cacheOf(slot.profile) });
      } else this.bots.set(s.seat, new BotController(`${this.snapshot.game.seed}:${s.seat}`));
    }
  }

  private finish(): void {
    this.status = 'over';
    this.writeResult();
    this.setStatus('over');
    this.refreshLock();
    this.emit({ type: 'over' });
  }

  /** Record the outcome: cost, winner and the per-seat results (safe to call twice). */
  private writeResult(): void {
    const result = this.state.result;
    if (!result || !this.writable) return;
    setCostSpent(this.o.store, this.gameId, this.guard.spent);
    setResult(this.o.store, this.gameId, result.winner, result.reason, true);
    const reveal = this.events.find((e) => e.type === 'FINAL_REVEAL');
    if (reveal) {
      finishSlots(
        this.o.store,
        this.gameId,
        (reveal.payload as { seats: { seat: number; role: string; team: string }[] }).seats.map((s) => ({ ...s, won: result.winners.includes(s.seat as SeatId) })),
      );
    }
  }

  // ---- decisions ---------------------------------------------------------------

  /** Persist an answer as soon as it arrives, so a pause or a crash can never lose it. */
  private record(d: Decided): Decided {
    if (this.writable && this.status !== 'over' && !this.buffered.has(d.req.requestId)) {
      bufferDecision(this.o.store, this.gameId, {
        requestId: d.req.requestId,
        seat: d.req.seat,
        answer: d.answer,
        source: d.answer.kind === 'no_answer' ? 'fallback' : d.source,
        repairUsed: d.repairUsed,
      });
      this.buffered.set(d.req.requestId, d);
      setCostSpent(this.o.store, this.gameId, this.guard.spent);
    }
    return d;
  }

  private async decide(req: DecisionRequest): Promise<Decided> {
    const seat = req.seat as SeatId;
    if (req.seat === 0) return this.record({ req, answer: await this.hostDecision(req), source: 'human', repairUsed: false });
    if (this.bots.has(seat)) return this.record({ req, answer: this.bots.get(seat)!.decide(req), source: 'bot', repairUsed: false });
    if (this.humans.has(seat)) return this.record({ req, answer: await this.askHuman(req, seat), source: 'human', repairUsed: false });

    const threshold = this.o.app.providerFailureThreshold;
    const failed = (this.failures.get(seat) ?? 0) >= threshold;
    if (failed && this.probeAt.get(seat) === req.night) return this.record({ req, answer: { kind: 'no_answer', reason: 'provider_error' }, source: 'fallback', repairUsed: false });
    if (failed) this.probeAt.set(seat, req.night); // one probe per cycle (§9.5)

    const state = this.state;
    const res = await this.controller.decide(req, this.events, (d) => validate(state, req.requestId, d), this.abort.signal);
    const providerFailed = res.answer.kind === 'no_answer' && (res.answer.reason === 'provider_error' || res.answer.reason === 'timeout');
    this.failures.set(seat, providerFailed ? (this.failures.get(seat) ?? 0) + 1 : 0);
    if (providerFailed && this.failures.get(seat) === threshold) this.autoRemap(seat);
    return this.record({ req, answer: res.answer, source: 'model', repairUsed: res.repairUsed });
  }

  /** The host's own decision (the debrief offer). `debrief_enabled` may answer it for them. */
  private hostDecision(req: DecisionRequest): Promise<Answer> {
    return new Promise<Answer>((resolve) => {
      const pending: PendingHuman & { resolve: (a: Answer) => void; timer?: NodeJS.Timeout } = {
        request: req,
        clientRequestId: this.clientIdOf(req.requestId),
        deadlineAt: this.now() + this.o.app.debriefOfferMs,
        remainingMs: this.o.app.debriefOfferMs,
        totalMs: this.o.app.debriefOfferMs,
        delivered: true,
        resolve,
      };
      pending.timer = setTimeout(() => this.settleHuman(req.requestId, { kind: 'decision', decision: { reasoning: '', choice: 'skip' } }), this.o.app.debriefOfferMs);
      this.pending.set(req.requestId, pending);
      this.setStatus('over_offer');
      appendMetaEvent(this.o.store, this.gameId, { wallTime: new Date().toISOString(), type: 'DEBRIEF_OFFERED', vis: 'host_safe', payload: {} });
      this.emit({ type: 'status' });
    });
  }

  private askHuman(req: DecisionRequest, seat: SeatId): Promise<Answer> {
    const slot = this.humans.get(seat)!;
    return new Promise<Answer>((resolve) => {
      const ms = this.humanTimeoutMs(req);
      const connected = !this.disconnected.has(slot) && !this.away.has(slot);
      // An away seat falls back at once; a disconnected seat's clock starts now (§11.2 pacing).
      if (this.away.has(slot)) {
        resolve({ kind: 'no_answer', reason: 'disconnected' });
        return;
      }
      const pending: PendingHuman & { resolve: (a: Answer) => void; timer?: NodeJS.Timeout } = {
        request: req,
        clientRequestId: this.clientIdOf(req.requestId),
        deadlineAt: this.status === 'paused' ? null : this.now() + ms,
        remainingMs: ms,
        totalMs: ms,
        delivered: connected,
        resolve,
      };
      this.pending.set(req.requestId, pending);
      if (this.status !== 'paused') this.armTimer(req.requestId);
      this.emit({ type: 'request', seat, pending });
    });
  }

  private humanTimeoutMs(req: DecisionRequest): number {
    const t = (this.snapshot.game.rules as ResolvedRules).human_timeouts;
    if (HUMAN_LONG.has(req.kind)) return t.long_text_ms;
    if (req.kind === 'council_turn' || req.kind === 'message') return t.channel_ms;
    return t.other_ms;
  }

  private armTimer(requestId: number): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    p.deadlineAt = this.now() + p.remainingMs;
    p.timer = setTimeout(() => this.settleHuman(requestId, { kind: 'no_answer', reason: 'timeout' }), p.remainingMs);
  }

  private settleHuman(requestId: number, answer: Answer): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    // settled without the player (timeout, host fallback, away): their screen must stop asking.
    // A player's own accepted answer is announced by `decision_accepted` instead.
    if (p.request.seat !== 0 && answer.kind !== 'decision') this.emit({ type: 'request_closed', seat: p.request.seat as SeatId, clientRequestId: p.clientRequestId });
    p.resolve(answer);
  }

  /** A human submission. Accepted submissions are final (§9.3 step 2). */
  submitDecision(seat: SeatId, clientRequestId: string, decision: unknown): { ok: true } | { ok: false; issues: string[] } {
    const entry = [...this.pending.entries()].find(([, p]) => p.clientRequestId === clientRequestId && p.request.seat === seat);
    // one answer for anything that is not this seat's open request: a seat must not be able to
    // probe for other seats' pending requests (that would reveal who holds a night role)
    if (!entry) return { ok: false, issues: ['not_waiting_for_this'] };
    const [requestId, p] = entry;
    void p;
    const v = validate(this.state, requestId, decision);
    if (!v.ok) return { ok: false, issues: v.issues };
    this.settleHuman(requestId, { kind: 'decision', decision: v.decision });
    return { ok: true };
  }

  /** The host answers the debrief offer. */
  answerDebrief(open: boolean): boolean {
    const entry = [...this.pending.entries()].find(([, p]) => p.request.seat === 0);
    if (!entry) return false;
    if (open) this.setStatus('debrief');
    this.settleHuman(entry[0], { kind: 'decision', decision: { reasoning: '', choice: open ? 'open' : 'skip' } });
    this.emit({ type: 'status' }); // the offer is gone: the host's screen must say so now
    return true;
  }

  /** Host-forced fallback for pending human requests (§9.3 "fallback now"). */
  fallbackNow(target: 'disconnected' | 'current_speaker' | 'all_ballots'): { applied: number | null; deferred: boolean; refused?: boolean } {
    const night = this.currentPhase() === 'night';
    // At night, while humans can still act, nothing is applied and no count is shown: the timing
    // alone would tell the host which seats hold night roles (§9.3). Dawn is public: a dying
    // Hunter's shot or a Sheriff's successor can be settled then.
    if (!this.lockOpen && night) {
      if (target !== 'disconnected') return { applied: null, deferred: false, refused: true };
      this.deferredFallback = 'disconnected';
      return { applied: null, deferred: true };
    }
    const candidates = [...this.pending.entries()].filter(([, p]) => p.request.seat !== 0);
    let chosen = candidates.filter(([, p]) => {
      const slot = this.humans.get(p.request.seat as SeatId);
      if (target === 'disconnected') return slot !== undefined && (this.disconnected.has(slot) || this.away.has(slot));
      if (target === 'all_ballots') return p.request.kind === 'vote' || p.request.kind === 'council_ballot';
      // the one public turn in progress: a speech, a candidacy, or a dying action everyone waits on
      return p.request.kind === 'speech' || p.request.kind === 'sheriff_run' || p.request.context === 'hunter_shot' || p.request.context === 'sheriff_successor';
    });
    // "current speaker" is the one public turn in progress, never every pending speech
    if (target === 'current_speaker') chosen = [...chosen].sort((a, b) => a[0] - b[0]).slice(0, 1);
    for (const [id] of chosen) this.settleHuman(id, { kind: 'no_answer', reason: 'forced' });
    return { applied: this.lockOpen ? chosen.length : null, deferred: false };
  }

  /**
   * A fallback the host asked for at night is applied once the game is out of the night (§9.3),
   * against the requests that are open then — never mid-night, where its timing would tell the
   * host which seats hold night roles.
   */
  private applyDeferredFallback(): void {
    if (this.deferredFallback === null) return;
    if (!this.lockOpen && this.state.group.some((r) => r.night > r.day)) return; // still night: wait
    const target = this.deferredFallback;
    this.deferredFallback = null;
    this.fallbackNow(target);
  }

  private applyOne(d: Decided): void {
    if (!this.writable) return; // the server is shutting down: write nothing more
    this.applyOrder++;
    // the answer is already stored (buffered); applying it is one transaction with its events
    let stored = true;
    this.o.store.tx(() => {
      stored = applyDecision(this.o.store, this.gameId, d.req.requestId, this.applyOrder);
      if (!stored) return; // the answer is not on record: do not let the engine run ahead of it
      const step = applyAnswer(this.state, d.req.requestId, d.answer);
      this.state = step.state;
      this.commitInTx(step.events, step.open);
    });
    if (!stored) {
      this.applyOrder--;
      this.notice = 'an answer could not be recorded; the game was paused for inspection';
      this.pause('corrupt');
      return;
    }
    if (this.lastEvents.length) this.emit({ type: 'events', events: this.lastEvents });
    this.lastEvents = [];
  }

  private lastEvents: EngineEvent[] = [];

  private commit(events: readonly EngineEvent[], open: readonly DecisionRequest[]): void {
    if (!this.writable) return;
    if (events.length === 0 && open.length === 0) return;
    this.o.store.tx(() => this.commitInTx(events, open));
    if (this.lastEvents.length) this.emit({ type: 'events', events: this.lastEvents });
    this.lastEvents = [];
  }

  /** The write half of a commit; the caller owns the transaction (§9.3 step 4: one commit). */
  private commitInTx(events: readonly EngineEvent[], open: readonly DecisionRequest[]): void {
    this.events = [...this.events, ...events];
    appendEngineEvents(this.o.store, this.gameId, events);
    for (const r of open) {
      const opened = events.find((e) => e.type === 'REQUEST_OPENED' && (e.payload as { requestId: number }).requestId === r.requestId);
      insertRequest(this.o.store, this.gameId, r, opened?.eseq ?? Math.max(1, this.events.length), this.clientIdOf(r.requestId));
    }
    this.lastEvents = [...this.lastEvents, ...events];
  }

  // ---- host controls ------------------------------------------------------------

  pause(reason: PauseReason): void {
    if (this.status !== 'running' || !this.writable) return;
    this.status = 'paused';
    this.pauseReason = reason;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      if (p.deadlineAt !== null) p.remainingMs = Math.max(0, p.deadlineAt - this.now());
      p.deadlineAt = null;
      p.timer = undefined;
      void id;
    }
    try {
      pauseGame(this.o.store, this.gameId, reason);
    } catch {
      // already paused
    }
    this.emit({ type: 'paused', reason });
  }

  resume(): void {
    if (this.status !== 'paused') return;
    // `corrupt` and `version_mismatch` are terminal: the host can only abort or export (§9.4)
    if (this.pauseReason === 'corrupt' || this.pauseReason === 'version_mismatch') return;
    this.pauseDetail = null;
    this.status = 'running';
    this.pauseReason = null;
    try {
      resumeGame(this.o.store, this.gameId);
    } catch {
      // not paused in the database
    }
    for (const [id] of this.pending) this.armTimer(id);
    this.emit({ type: 'resumed' });
    this.wake();
  }

  /**
   * The host aborts the game (§9.3). A game that already has a result keeps it and ends as
   * `over`; an unfinished one becomes `aborted` and is excluded from statistics.
   */
  abortGame(): 'over' | 'aborted' {
    if (this.status === 'aborted' || this.status === 'over') return this.status === 'over' ? 'over' : 'aborted';
    const finished = this.state.result !== null;
    // The store decides the final status from where the game was (a pause remembers its origin):
    // anything that already had a result ends as `over`, everything else as `aborted`.
    let outcome: 'over' | 'aborted';
    try {
      outcome = abortGameRow(this.o.store, this.gameId);
    } catch {
      outcome = finished ? 'over' : 'aborted';
    }
    // a finished game keeps its result, whether it was running or paused when the host aborted,
    // and it is decided, so it is open to everyone (§15b) — even if the debrief never ran
    if (finished) {
      this.writeResult();
      if (!this.lockOpen && this.writable) this.openLock();
    }
    this.stop();
    this.status = finished ? 'over' : 'aborted';
    if (!finished) this.emit({ type: 'aborted' });
    this.emit({ type: 'status' });
    return outcome;
  }

  /** Quiesce without touching the database (server shutdown). */
  stop(): void {
    this.status = 'aborted';
    this.abort.abort();
    for (const t of this.awayTimers.values()) clearTimeout(t);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.awayTimers.clear();
    this.graceTimers.clear();
    for (const [id, p] of [...this.pending]) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      if (p.request.seat !== 0) this.emit({ type: 'request_closed', seat: p.request.seat as SeatId, clientRequestId: p.clientRequestId });
      p.resolve({ kind: 'no_answer', reason: 'aborted' });
    }
    this.wake();
  }

  raiseCap(capUsd: number): void {
    this.guard.raiseCap(capUsd);
    if (this.writable) setCostCap(this.o.store, this.gameId, capUsd);
  }

  /** Swap a seat's model (host command, or silently for a failed seat while humans play). */
  remapSeat(slot: SlotId, profile: SeatModel['profile'], entry: CatalogEntry, silent = false): boolean {
    const seat = [...this.models.keys()].find((s) => this.snapshot.slots.find((x) => x.slot === slot) && this.seatOfSlot(s) === slot);
    if (seat === undefined) return false;
    this.models.set(seat, { profile, entry, mode: modeOf(profile, entry), cache: cacheOf(profile) });
    this.failures.set(seat, 0);
    this.o.store.atomic(() => {
      this.o.store.db
        .prepare('INSERT OR REPLACE INTO seat_profiles (game_id, seat, from_eseq, profile_json) VALUES (?, ?, ?, ?)')
        .run(this.gameId, seat, this.events.length, JSON.stringify(profile));
      this.o.store.db.prepare('UPDATE games SET has_remap = 1 WHERE id = ?').run(this.gameId);
    });
    appendMetaEvent(this.o.store, this.gameId, { wallTime: new Date().toISOString(), type: 'SEAT_REMAP', vis: 'spectator', payload: { seat, slot, alias: profile.alias, silent } });
    if (silent && !this.lockOpen) {
      this.heldNotice = 'a model was unavailable and was replaced';
    } else {
      this.notice = `slot ${slot} is now played by ${profile.label}`;
      this.emit({ type: 'status' });
    }
    return true;
  }

  /** A seat whose model keeps failing is replaced silently while the lock is closed (§9.5). */
  private autoRemap(seat: SeatId): void {
    if (this.lockOpen) {
      // nobody human can act: the host decides what to do with the failed seat (§9.5), and is
      // told which seat and which model (the game is open, so this is no secret)
      const slot = this.seatOfSlot(seat);
      const who = (this.events.find((e) => e.type === 'GAME_START')?.payload as { seats: { seat: number; name: string }[] } | undefined)?.seats.find((x) => x.seat === seat)?.name ?? `seat ${seat}`;
      const model = this.models.get(seat)?.profile.label ?? 'its model';
      this.notice = `${model}, playing ${who} (slot ${String(slot)}), kept failing: replace it under "More host tools", then press Resume`;
      this.pauseDetail = 'model_failed';
      this.pause('provider_failure');
      return;
    }
    if (this.remapped.has(seat)) return; // one silent remap per seat; after that it is short-circuited
    const slot = this.seatOfSlot(seat);
    const alias = this.snapshot.slots.find((s) => s.slot === slot)?.fallbackAlias ?? null;
    const profile = alias ? this.o.profilesByAlias?.get(alias) : undefined;
    const entry = profile ? this.o.entries.get(profile.openrouterId) : undefined;
    // the fallback comes from today's config: it must still fit the budget this game froze (as a host remap must)
    if (slot !== undefined && profile && entry && remapProblem(profile, entry, this.snapshot) === null) {
      this.remapped.add(seat);
      this.remapSeat(slot, profile, entry, true);
    }
  }

  private seatOfSlot(seat: SeatId): SlotId | undefined {
    const seating = this.events.find((e) => e.type === 'SEATING');
    if (!seating) return undefined;
    return (seating.payload as { seats: { seat: SeatId; slot: SlotId }[] }).seats.find((s) => s.seat === seat)?.slot;
  }

  // ---- connections ---------------------------------------------------------------

  humanConnected(slot: SlotId): void {
    if (!this.writable) return;
    this.disconnected.delete(slot);
    this.away.delete(slot);
    clearTimeout(this.awayTimers.get(slot));
    clearTimeout(this.graceTimers.get(slot));
    this.awayTimers.delete(slot);
    this.graceTimers.delete(slot);
    // a clock frozen while they were away starts again with whatever was left of it
    for (const [id, p] of this.pending) {
      if (this.humans.get(p.request.seat as SeatId) === slot && p.deadlineAt === null && this.status === 'running') this.armTimer(id);
    }
    // the game only stopped because everyone had gone; somebody is back, so carry on
    if (this.status === 'paused' && this.pauseReason === 'humans_disconnected') this.resume();
    appendMetaEvent(this.o.store, this.gameId, { wallTime: new Date().toISOString(), type: 'HUMAN_CONNECTED', vis: 'host_safe', payload: { slot } });
    // a request that opened while they were away is delivered now, which starts its clock
    for (const [id, p] of this.pending) {
      if (this.humans.get(p.request.seat as SeatId) === slot && !p.delivered) {
        p.delivered = true;
        if (this.status === 'running') this.armTimer(id);
      }
    }
    this.emit({ type: 'status' });
  }

  humanDisconnected(slot: SlotId): void {
    if (!this.writable || this.away.has(slot)) return;
    this.disconnected.set(slot, this.now());
    appendMetaEvent(this.o.store, this.gameId, { wallTime: new Date().toISOString(), type: 'HUMAN_DISCONNECTED', vis: 'host_safe', payload: { slot } });
    clearTimeout(this.awayTimers.get(slot));
    clearTimeout(this.graceTimers.get(slot));
    // the clock runs for the grace period, then freezes until they come back (§9.3)
    this.graceTimers.set(
      slot,
      setTimeout(() => this.freezeSeat(slot), this.o.app.disconnectGraceMs),
    );
    this.awayTimers.set(
      slot,
      setTimeout(() => this.markAway(slot), this.o.app.disconnectMaxMs),
    );
    if (this.o.app.pauseOnAllHumansDisconnected && this.humans.size > 0 && [...this.humans.values()].every((s) => this.disconnected.has(s) || this.away.has(s))) {
      this.pause('humans_disconnected');
    }
    this.emit({ type: 'status' });
  }

  /** The grace period ran out while they were away: freeze what is left of their clock. */
  private freezeSeat(slot: SlotId): void {
    for (const [, p] of this.pending) {
      if (this.humans.get(p.request.seat as SeatId) !== slot || p.deadlineAt === null) continue;
      clearTimeout(p.timer);
      p.remainingMs = Math.max(0, p.deadlineAt - this.now());
      p.deadlineAt = null;
      p.timer = undefined;
    }
    this.emit({ type: 'status' });
  }

  /** After `disconnectMaxMs` the seat is "away": its pending and future requests fall back at once. */
  private markAway(slot: SlotId): void {
    this.away.add(slot);
    for (const [id, p] of this.pending) {
      if (this.humans.get(p.request.seat as SeatId) === slot) this.settleHuman(id, { kind: 'no_answer', reason: 'disconnected' });
    }
    this.emit({ type: 'status' });
  }

  get disconnectedSlots(): SlotId[] {
    return [...new Set([...this.disconnected.keys(), ...this.away])].sort((a, b) => a - b);
  }

  // ---- views and plumbing ---------------------------------------------------------

  pendingFor(seat: SeatId): PendingHuman | null {
    for (const p of this.pending.values())
      if (p.request.seat === seat) return { request: p.request, clientRequestId: p.clientRequestId, deadlineAt: p.deadlineAt, remainingMs: p.remainingMs, totalMs: p.totalMs, delivered: p.delivered };
    return null;
  }

  /**
   * At a Dawn or Dusk boundary: the notice from the last phase is retired, and one that was held
   * back (a silent replacement) is published. Called by the gateway when it sees the boundary.
   */
  atBoundary(): void {
    this.notice = this.heldNotice;
    this.heldNotice = null;
  }

  /** The phase the game is in, from the last PHASE_START it emitted. */
  private currentPhase(): string {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.type === 'PHASE_START') return (e.payload as { phase: string }).phase;
    }
    return 'setup';
  }

  /** Which lobby slots are played by people (after a forced start, the missing ones are not). */
  isHumanSlot(slot: SlotId): boolean {
    return this.snapshot.slots.some((s) => s.slot === slot && s.controller === 'human');
  }

  /** The people at the table by slot, with the names the host gave them (host-safe, §9.1). */
  humanSlots(): { slot: SlotId; name: string; connected: boolean }[] {
    const off = new Set(this.disconnectedSlots);
    return this.snapshot.slots.filter((s) => s.controller === 'human').map((s) => ({ slot: s.slot as SlotId, name: s.humanName ?? `Player ${s.slot}`, connected: !off.has(s.slot as SlotId) }));
  }

  /** The status a screen should show: the run loop's, refined by the debrief stage. */
  get displayStatus(): 'running' | 'paused' | 'over_offer' | 'debrief' | 'over' | 'aborted' {
    if (this.status === 'running' && this.stage) return this.stage;
    return this.status;
  }

  /** Which model plays each AI seat right now (after any remap). Humans and bots are absent. */
  seatModels(): { seat: SeatId; slot: SlotId; alias: string; label: string }[] {
    return [...this.models.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seat, m]) => ({ seat, slot: this.seatOfSlot(seat) as SlotId, alias: m.profile.alias, label: m.profile.label }));
  }

  get hostDebriefPending(): boolean {
    return [...this.pending.values()].some((p) => p.request.seat === 0);
  }

  get spentUsd(): number {
    return this.guard.spent;
  }
  get capUsd(): number {
    return this.guard.capUsd;
  }
  get engineState(): EngineState {
    return this.state;
  }

  /** Catalogue data this game holds for a model id (used when the host remaps a seat). */
  entriesOf(openrouterId: string): CatalogEntry | undefined {
    return this.o.entries.get(openrouterId);
  }

  subscribe(fn: (e: OrchestratorEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: OrchestratorEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a broken client must never break the game
      }
    }
  }

  /** Move the stored game status, ignoring a transition the database already made. */
  private setStatus(status: 'over_offer' | 'debrief' | 'over'): void {
    this.stage = status === 'over' ? null : status;
    if (!this.writable) return;
    try {
      setGameStatus(this.o.store, this.gameId, status);
      this.emit({ type: 'status' });
    } catch {
      // the status was already there (or the game was aborted)
    }
  }

  /**
   * The id a browser sees for a question. It must not be the engine's running request number:
   * the gaps between one player's numbers would count the secret night questions asked in
   * between (ARCHITECTURE §4.1). A keyed hash is opaque, yet stable across a crash and recovery,
   * so a half-written answer survives a restart.
   */
  private clientIdOf(requestId: number): string {
    return createHash('sha256').update(`${this.snapshot.game.seed}|${this.gameId}|${requestId}`).digest('base64url').slice(0, 22);
  }

  private refreshLock(): void {
    if (this.lockOpen || !this.writable) return;
    if (!lockOpen(this.state)) return;
    this.openLock();
  }

  /** Open the game to every viewer: stored, logged, and announced (a fresh snapshot follows). */
  private openLock(): void {
    this.lockOpen = true;
    this.o.store.atomic(() => {
      this.o.store.db.prepare('UPDATE games SET lock_open = 1 WHERE id = ?').run(this.gameId);
    });
    appendMetaEvent(this.o.store, this.gameId, { wallTime: new Date().toISOString(), type: 'LOCK_OPENED', vis: 'host_safe', payload: {} });
    this.emit({ type: 'lock_opened' });
  }

  /** Consecutive provider failures per seat, counted from the stored answers (§9.5 recovery). */
  private rebuildFailures(): void {
    for (const d of listDecisions(this.o.store, this.gameId)) {
      if (d.seat === 0) continue;
      const seat = d.seat as SeatId;
      const failed = d.answer.kind === 'no_answer' && (d.answer.reason === 'provider_error' || d.answer.reason === 'timeout');
      this.failures.set(seat, failed ? (this.failures.get(seat) ?? 0) + 1 : 0);
    }
    // a seat that was remapped starts fresh on its new model (§9.5: a remap resets the counter)
    const remapped = this.o.store.db.prepare('SELECT DISTINCT seat FROM seat_profiles WHERE game_id = ?').all(this.gameId) as unknown as { seat: number }[];
    for (const r of remapped) {
      this.failures.set(r.seat as SeatId, 0);
      this.remapped.add(r.seat as SeatId);
    }
  }

  private waiter: (() => void) | null = null;
  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
  private waitWhilePaused(): Promise<void> {
    if (this.status !== 'paused') return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
  }

  private callLog(req: DecisionRequest): CallLog {
    const model = this.models.get(req.seat as SeatId)!;
    const store = this.o.store;
    const logPrompts = this.o.logPrompts ?? false;
    return {
      sent: (r) =>
        !this.writable
          ? 0
          : startLlmCall(store, {
          gameId: this.gameId,
          requestId: req.requestId,
          seat: req.seat,
          profileAlias: model.profile.alias,
          openrouterId: model.profile.openrouterId,
          attempt: Math.min(r.attempt, 20),
          purpose: r.purpose === 'ping' ? 'ping' : r.purpose,
          queueMs: Math.round(r.queueMs),
          reservedUsd: r.reservedUsd,
              requestJson: logPrompts ? JSON.stringify(r.request) : null,
            }),
      done: (id, r) => {
        if (!this.writable || id === 0) return;
        finishLlmCall(store, id, {
          status: r.status,
          latencyMs: Math.round(r.latencyMs),
          generationId: r.generationId,
          promptTokens: r.usage?.promptTokens ?? null,
          completionTokens: r.usage?.completionTokens ?? null,
          reasoningTokens: r.usage?.reasoningTokens ?? null,
          cachedTokens: r.usage?.cachedTokens ?? null,
          costUsd: r.costUsd,
          costSource: r.costSource,
          responseJson: logPrompts ? JSON.stringify({ text: r.responseText, error: r.error }) : null,
        });
      },
    };
  }
}

interface Decided {
  req: DecisionRequest;
  answer: Answer;
  source: 'model' | 'bot' | 'human' | 'fallback';
  repairUsed: boolean;
}

const modeOf = (profile: SeatModel['profile'], entry: CatalogEntry): SeatModel['mode'] =>
  profile.structuredOutput !== 'auto'
    ? profile.structuredOutput
    : entry.source !== 'catalog'
      ? 'prompt_only'
      : entry.supportedParameters.includes('structured_outputs')
        ? 'json_schema'
        : entry.supportedParameters.includes('response_format')
          ? 'json_object'
          : 'prompt_only';

const cacheOf = (profile: SeatModel['profile']): SeatModel['cache'] =>
  profile.cacheControl === 'anthropic' || (profile.cacheControl === 'auto' && profile.openrouterId.startsWith('anthropic/')) ? 'anthropic' : 'none';

/**
 * Why a model cannot take over a seat of this running game, or null if it can: the game froze its context window and
 * its output reserve at the start (ARCHITECTURE.md §6.3), so the new model must fit both. Used by the host's remap and
 * by the silent fallback remap (whose profile comes from the config as it is now, which may have changed since).
 */
export function remapProblem(profile: ModelProfile, entry: CatalogEntry, snapshot: GameSnapshot): string | null {
  const budget = snapshot.budget;
  if (entry.contextLength < budget.window) return `"${profile.alias}" has a smaller context window (${entry.contextLength}) than this game needs (${budget.window})`;
  const maxTokens = maxTokensFor(profile, snapshot.pinned.maxOutputTokens, snapshot.effortShare);
  if (maxTokens > budget.outputReserve) return `"${profile.alias}" would need ${maxTokens} output tokens, more than this game reserved (${budget.outputReserve})`;
  return null;
}
