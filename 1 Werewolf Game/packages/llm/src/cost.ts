import type { Pricing } from './catalog';
import type { Usage } from './types';

/**
 * Worst-case price of one attempt (ARCHITECTURE.md §7.5): the estimated prompt at the higher
 * of the prompt and cache-write prices, plus every output token (visible and reasoning) at the
 * higher of the completion and internal-reasoning prices, plus the per-request fee.
 */
export function reservationUsd(pricing: Pricing, promptTokensEst: number, maxTokens: number): number {
  return (
    promptTokensEst * Math.max(pricing.prompt, pricing.cacheWrite) +
    maxTokens * Math.max(pricing.completion, pricing.internalReasoning) +
    pricing.request
  );
}

/** Cost estimate from token usage when neither `usage.cost` nor `/generation` gave one. */
export function estimateUsd(pricing: Pricing, u: Usage): number {
  const uncached = Math.max(0, u.promptTokens - u.cachedTokens);
  return uncached * pricing.prompt + u.cachedTokens * (pricing.cacheRead || pricing.prompt) + u.completionTokens * pricing.completion + pricing.request;
}

export class CostCapReached extends Error {
  constructor(readonly needed: number, readonly spent: number, readonly reserved: number, readonly cap: number) {
    super(`cost cap reached: $${(spent + reserved).toFixed(4)} spent or reserved, $${needed.toFixed(4)} more needed, cap $${cap.toFixed(2)}`);
    this.name = 'CostCapReached';
  }
}

export interface Reservation {
  readonly id: number;
  readonly amount: number;
}

export type CostSource = 'usage' | 'generation' | 'estimate' | 'reserved';

/**
 * Per-game ledger: `spent` (actual) + `reserved` (in flight). A call is only issued if its
 * reservation fits under the cap; the check and the reservation are one synchronous step.
 */
export class CostGuard {
  private reservedById = new Map<number, number>();
  private nextId = 1;
  private warned = false;

  constructor(
    private cap: number,
    private spentUsd = 0,
    private readonly onWarn?: (spent: number, cap: number) => void,
  ) {}

  get spent(): number {
    return this.spentUsd;
  }
  get reserved(): number {
    let r = 0;
    for (const v of this.reservedById.values()) r += v;
    return r;
  }
  get capUsd(): number {
    return this.cap;
  }

  /** Reserve `amount` or throw CostCapReached (the game then pauses with reason `cost_cap`). */
  reserve(amount: number): Reservation {
    const reserved = this.reserved;
    if (this.spentUsd + reserved + amount > this.cap) throw new CostCapReached(amount, this.spentUsd, reserved, this.cap);
    const id = this.nextId++;
    this.reservedById.set(id, amount);
    return { id, amount };
  }

  /**
   * Release a reservation and book the real cost. `actual = null` (timed out, aborted, or no
   * cost and no generation id) charges the full reservation, since the provider may still bill it.
   */
  settle(r: Reservation, actual: number | null): number {
    if (!this.reservedById.has(r.id)) throw new Error(`reservation ${r.id} was already settled`);
    this.reservedById.delete(r.id);
    const charged = actual ?? r.amount;
    this.spentUsd += charged;
    if (!this.warned && this.spentUsd >= 0.8 * this.cap) {
      this.warned = true;
      this.onWarn?.(this.spentUsd, this.cap);
    }
    return charged;
  }

  /** The host raises the cap (then resumes). */
  raiseCap(cap: number): void {
    if (cap < this.cap) throw new Error('the cost cap can only be raised');
    this.cap = cap;
    if (this.spentUsd < 0.8 * cap) this.warned = false;
  }
}
