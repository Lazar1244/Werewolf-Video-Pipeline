import { project, reduceView, type NameOf } from '@ww/projector';
import type { Budget, ChatMessage, DecisionRequest, EngineEvent, GameConfig, SeatId, TextBlock } from '@ww/shared';
import { estimateTokens } from './budget';
import { notebookOf, optionsText, privateLog, publicState, roleCard, taskKey, taskVars } from './layers';
import { packFile, render, type PromptPack } from './pack';
import { requestSchema, type JsonSchema, type Wording } from './schema';
import { buildSystemPrompt, wordingDir, wordingsOf } from './system';
import { buildTranscript, transcriptItems } from './transcript';

export type CacheMode = 'anthropic' | 'none';

export interface ContextInput {
  pack: PromptPack;
  game: GameConfig;
  budget: Budget;
  /** The full engine log so far; it is projected here, so the context only ever holds what this seat may see. */
  events: readonly EngineEvent[];
  request: DecisionRequest;
  cache: CacheMode;
  /** How the inner monologue is asked for (default: the pack's first wording; the controller switches after a refusal). */
  wording?: Wording;
}

export interface BuiltContext {
  messages: ChatMessage[];
  schema: JsonSchema;
  /** The enumerated legal options (repeated in a repair message). */
  options: string;
  /** Estimated tokens per layer (diagnostics and budget tests). */
  tokens: Record<'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6', number>;
}

export class ContextBudgetError extends Error {}

const systemCache = new Map<string, string>();

/** L0 for a game (memoised: it is constant for the whole game). */
export function systemPromptFor(pack: PromptPack, game: GameConfig, wording: Wording = wordingsOf(pack)[0]!): string {
  const extras = game.cards.length - game.seats;
  const key = `${pack.hash}|${JSON.stringify(game.cards)}|${JSON.stringify(game.rules)}|${extras}|${wording}`;
  let s = systemCache.get(key);
  if (s === undefined) {
    s = buildSystemPrompt(pack, game.cards, extras, game.rules, wording);
    systemCache.set(key, s);
  }
  return s;
}

/**
 * Build the messages for one decision (ARCHITECTURE.md §6.2), in cache-friendly order:
 * system L0, then L3 (one block per day), L2, L1, L4, L5, L6.
 */
export function buildContext(input: ContextInput): BuiltContext {
  const { pack, game, budget, events, request: req } = input;
  const wording = input.wording ?? wordingsOf(pack)[0]!;
  if (req.seat === 0) throw new Error('host requests have no AI context');
  const seat = req.seat as SeatId;
  const cpt = budget.charsPerToken;
  const seatEntries = project(events, { kind: 'seat', seat }, false);
  const publicEntries = project(events, { kind: 'public' }, false);
  const view = reduceView(seatEntries, seat);
  if (!view.me) throw new Error(`seat ${seat} has no role yet`);
  const name: NameOf = (n) => view.table[n - 1]?.name ?? `seat ${n}`;

  const cap = (text: string, tokens: number) => (estimateTokens(text, cpt) <= tokens ? text : `${text.slice(0, Math.max(1, Math.floor(tokens * cpt) - 4))} ...`);
  const L0 = systemPromptFor(pack, game, wording);
  const items = transcriptItems(publicEntries, name);
  const L1 = cap(roleCard(pack, view, game.rules, name), budget.l1Cap);
  const notebook = notebookOf(seatEntries, seat, game.rules.words.notebook);
  const L5 = cap(notebook ?? '(empty)', budget.l5Cap);

  const schema = requestSchema(req, wording);
  const reasoningFile = view.me.team === 'Village' ? 'village' : view.me.team === 'Werewolf' || view.me.wolfNature ? 'wolf' : 'solo';
  const key = taskKey(req);
  const options = optionsText(req, name);
  // L6 is never truncated: it ends with the JSON schema, and cutting that off would guarantee an
  // invalid answer. It is short by construction (task, options, guidance, schema); the layers
  // below give way instead.
  const L6 = [
    `# Your task (${phaseLabel(req)})`,
    render(packFile(pack, `tasks/${key}.md`), taskVars(req, game.rules, seatEntries, name)).trim(),
    options,
    packFile(pack, `${wordingDir(wording)}/${reasoningFile}.md`).trim(),
    render(packFile(pack, 'output.md'), {
      schema: JSON.stringify(schema),
      reasoning_words: game.rules.words.reasoning,
      notebook_words: game.rules.words.notebook,
      thoughts_field: wording,
    }).trim(),
  ]
    .filter(Boolean)
    .join('\n\n');

  // L2, L3 and L4 give way so the whole context always fits: the fixed layers (L0, L1, L5, L6)
  // are capped above, and whatever room is left is shared out here.
  const fixed = estimateTokens(L0, cpt) + estimateTokens(L1, cpt) + estimateTokens(L5, cpt) + estimateTokens(L6, cpt);
  const room = budget.inputBudget - fixed;
  const L2 = publicState(view, Math.max(200, Math.min(budget.l2Cap, Math.floor(room * 0.25))), cpt);
  const afterL2 = room - estimateTokens(L2, cpt);
  const L4 = privateLog(seatEntries, name, Math.max(200, Math.min(budget.l4Cap, Math.floor(afterL2 * 0.35))), cpt);
  const transcript = buildTranscript(items, Math.max(500, Math.min(budget.l3Cap, afterL2 - estimateTokens(L4, cpt))), cpt);

  const tokens = {
    L0: estimateTokens(L0, cpt),
    L1: estimateTokens(L1, cpt),
    L2: estimateTokens(L2, cpt),
    L3: transcript.tokens,
    L4: estimateTokens(L4, cpt),
    L5: estimateTokens(L5, cpt),
    L6: estimateTokens(L6, cpt),
  };
  // Every layer has a hard cap, so the sum stays within the input budget by construction; assert it.
  const total = Object.values(tokens).reduce((a, b) => a + b, 0);
  if (total > budget.inputBudget) throw new ContextBudgetError(`context of ${total} tokens exceeds the input budget ${budget.inputBudget}`);

  const blocks: TextBlock[] = [];
  const lastClosed = transcript.blocks.length - 2; // the last *closed* day gets the second cache breakpoint
  transcript.blocks.forEach((b, i) => {
    const block: TextBlock = { type: 'text', text: `# Public transcript, day ${b.day}${b.digested ? ' (digest)' : ''}\n${b.text}` };
    if (input.cache === 'anthropic' && i === lastClosed) block.cache_control = { type: 'ephemeral' };
    blocks.push(block);
  });
  blocks.push({ type: 'text', text: `# Public state\n${L2}` });
  blocks.push({ type: 'text', text: L1 });
  blocks.push({ type: 'text', text: `# Your private log (only you know this)\n${L4}` });
  blocks.push({ type: 'text', text: `# Your notebook (your own notes from earlier)\n${L5}` });
  blocks.push({ type: 'text', text: L6 });

  const system: ChatMessage =
    input.cache === 'anthropic' ? { role: 'system', content: [{ type: 'text', text: L0, cache_control: { type: 'ephemeral' } }] } : { role: 'system', content: L0 };
  const user: ChatMessage = input.cache === 'anthropic' ? { role: 'user', content: blocks } : { role: 'user', content: blocks.map((b) => b.text).join('\n\n') };
  return { messages: [system, user], schema, options, tokens };
}

function phaseLabel(req: DecisionRequest): string {
  return req.night > req.day ? `Night ${req.night}` : `Day ${req.day}`;
}
