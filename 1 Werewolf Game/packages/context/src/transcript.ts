import { countWords, ENGINE_CLOSE, ENGINE_OPEN } from '@ww/engine';
import { describe, roleLabel, type NameOf, type ViewEntry } from '@ww/projector';
import type { EnginePayload } from '@ww/shared';
import { estimateTokens } from './budget';

/**
 * L3, the public transcript (ruleset §14.2): a JSON array in time order, numbered by the
 * public sequence `pseq`, so it is byte-identical for every seat at a given moment.
 * The engine sets every field except `text`, `lean` and `claim`; player text is JSON-escaped
 * data, so a player can never forge metadata.
 */
export interface TranscriptItem {
  seq: number;
  day: number;
  phase: string;
  round?: number | null;
  kind: 'speech' | 'rebuttal' | 'defence' | 'last_words' | 'sheriff_speech' | 'challenge_answer' | 'engine';
  speaker?: string;
  text: string;
  lean?: string | null;
  claim?: string | null;
}

const SPEECH_KIND: Record<string, TranscriptItem['kind']> = {
  discussion: 'speech',
  judge_round: 'speech',
  sheriff: 'sheriff_speech',
  rebuttal: 'rebuttal',
  defence: 'defence',
  last_words: 'last_words',
  challenge_answer: 'challenge_answer',
};

/** Protocol entries and hidden-information markers never enter a transcript. */
const SKIP = new Set(['REQUEST_OPENED', 'REQUEST_CLOSED', 'SEAT_THOUGHTS', 'FALLBACK_USED']);

/** The cycle a public entry belongs to: Night k and Dawn k go with Day k. */
export const cycleOf = (e: Pick<ViewEntry, 'at'>): number =>
  Math.max(1, e.at.phase === 'night' || e.at.phase === 'dawn' ? e.at.night : e.at.day);

export function claimText(c: EnginePayload<'SPEECH'>['claim']): string | null {
  if (!c) return null;
  return `self-tagged claim (unverified): ${roleLabel(c.role)}${c.result ? ` — ${c.result}` : ''}`;
}

export function transcriptItems(publicEntries: readonly ViewEntry[], name: NameOf): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const e of publicEntries) {
    if (SKIP.has(e.type)) continue;
    const base = { seq: e.vseq, day: cycleOf(e), phase: e.at.phase };
    if (e.type === 'SPEECH') {
      const p = e.payload as EnginePayload<'SPEECH'>;
      out.push({
        ...base,
        round: p.round,
        kind: SPEECH_KIND[p.context] ?? 'speech',
        speaker: name(p.seat),
        text: p.text,
        lean: p.lean === null ? null : name(p.lean),
        claim: claimText(p.claim),
      });
      continue;
    }
    const text = describe(e, name);
    if (text) out.push({ ...base, kind: 'engine', text: `${ENGINE_OPEN} ${text} ${ENGINE_CLOSE}` });
  }
  return out;
}

/**
 * An engine-built digest of one old day (ruleset §14.2): speakers and word counts, the full
 * engine entries (votes, deaths, reveals) and the self-tagged claims. No LLM summarises anything.
 */
export function digestDay(day: number, items: readonly TranscriptItem[]): TranscriptItem {
  const words = new Map<string, number>();
  const claims: string[] = [];
  const engine: string[] = [];
  for (const it of items) {
    if (it.kind === 'engine') {
      engine.push(it.text.replace(ENGINE_OPEN, '').replace(ENGINE_CLOSE, '').trim());
      continue;
    }
    words.set(it.speaker!, (words.get(it.speaker!) ?? 0) + countWords(it.text));
    if (it.claim) claims.push(`${it.speaker}: ${it.claim}`);
  }
  const speakers = [...words.entries()].map(([s, n]) => `${s} (${n} words)`).join(', ');
  const text = [
    `Digest of day ${day} (older talk is summarised by the engine to save space).`,
    `Speakers: ${speakers || 'none'}.`,
    claims.length ? `Claims: ${claims.join('; ')}.` : 'Claims: none.',
    `Events: ${engine.join(' ')}`,
  ].join(' ');
  return { seq: items[0]?.seq ?? 0, day, phase: 'digest', kind: 'engine', text: `${ENGINE_OPEN} ${text} ${ENGINE_CLOSE}` };
}

export interface TranscriptBlocks {
  /** One JSON text per cycle, oldest first; the last block is the current (open) cycle. */
  blocks: { day: number; text: string; digested: boolean }[];
  tokens: number;
}

/**
 * Split by day and digest the oldest days until the transcript fits `cap`. The depth depends
 * only on the public log and the frozen cap, so it is identical for every seat. The current
 * day is always kept verbatim.
 */
export function buildTranscript(items: readonly TranscriptItem[], cap: number, charsPerToken: number): TranscriptBlocks {
  const days = [...new Set(items.map((i) => i.day))].sort((a, b) => a - b);
  const byDay = new Map(days.map((d) => [d, items.filter((i) => i.day === d)]));
  const render = (digestUpTo: number) =>
    days.map((d) => {
      const digested = d <= digestUpTo;
      const list = digested ? [digestDay(d, byDay.get(d)!)] : byDay.get(d)!;
      return { day: d, text: JSON.stringify(list), digested };
    });
  let digestUpTo = 0;
  let blocks = render(digestUpTo);
  const tokensOf = (b: typeof blocks) => b.reduce((n, x) => n + estimateTokens(x.text, charsPerToken), 0);
  const current = days.at(-1) ?? 0;
  while (tokensOf(blocks) > cap && digestUpTo < current - 1) {
    digestUpTo = days.find((d) => d > digestUpTo)!;
    blocks = render(digestUpTo);
  }
  return { blocks, tokens: tokensOf(blocks) };
}

