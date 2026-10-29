import type { Budget } from '@ww/shared';

/** One fixed, conservative ratio for every seat (ARCHITECTURE.md §6.2). */
export const CHARS_PER_TOKEN = 3.0;

export const estimateTokens = (text: string, charsPerToken = CHARS_PER_TOKEN): number => Math.ceil(text.length / charsPerToken);

export class BudgetError extends Error {}

/** Fixed layer caps (tokens). */
export const L1_CAP = 800;
export const L5_CAP = 500;
export const L6_CAP = 1500;
const SAFETY = 1000;
/** Below this the transcript cannot hold even one day; the lobby rejects the game. */
export const MIN_L3_CAP = 4000;

/**
 * The per-game token budget (ARCHITECTURE.md §6.2), computed from caps only and frozen
 * into the snapshot. `window` = the smallest context length among the game's profiles,
 * `outputReserve` = the largest `max_tokens` any of them will be sent.
 */
export function computeBudget(input: { window: number; outputReserve: number; transcriptTokenBudget: number; l0Tokens: number }): Budget {
  const inputBudget = input.window - input.outputReserve - SAFETY;
  if (inputBudget <= 0) throw new BudgetError(`context window ${input.window} is too small for an output reserve of ${input.outputReserve}`);
  if (input.l0Tokens > 0.15 * inputBudget) throw new BudgetError(`the system prompt (${input.l0Tokens} tokens) exceeds 15% of the input budget (${inputBudget})`);
  const l2Cap = Math.floor(0.1 * inputBudget);
  const l4Cap = Math.floor(0.15 * inputBudget);
  const l3Cap = Math.min(input.transcriptTokenBudget, inputBudget - input.l0Tokens - L1_CAP - l2Cap - l4Cap - L5_CAP - L6_CAP);
  if (l3Cap < MIN_L3_CAP) throw new BudgetError(`the transcript budget (${l3Cap} tokens) is too small; use models with a larger context window`);
  return {
    window: input.window,
    outputReserve: input.outputReserve,
    inputBudget,
    l0Tokens: input.l0Tokens,
    l1Cap: L1_CAP,
    l2Cap,
    l3Cap,
    l4Cap,
    l5Cap: L5_CAP,
    l6Cap: L6_CAP,
    charsPerToken: CHARS_PER_TOKEN,
  };
}
