/**
 * Answer parser (ARCHITECTURE.md §7.4): drop reasoning blocks and code fences, then take the
 * first balanced JSON object that parses. Linear in the input length.
 */
export type ParseResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

const MAX_INPUT = 200_000;

export function stripReasoning(text: string): string {
  // closed <think>…</think> blocks, then an unclosed leading one (a truncated reasoning prefix)
  let out = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const open = out.search(/<think(?:ing)?>/i);
  if (open >= 0 && out.slice(open).indexOf('{') < 0) out = out.slice(0, open);
  return out;
}

export function extractJson(raw: string): ParseResult {
  if (raw.length > MAX_INPUT) return { ok: false, error: 'answer is too long' };
  const text = stripReasoning(raw).replace(/```(?:json)?/gi, '');
  let from = 0;
  for (let tries = 0; tries < 20; tries++) {
    const start = text.indexOf('{', from);
    if (start < 0) break;
    const end = balancedEnd(text, start);
    if (end < 0) return { ok: false, error: 'the JSON object is not closed (was the answer cut off?)' };
    try {
      const v = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
    } catch {
      // try the next object
    }
    from = start + 1;
  }
  return { ok: false, error: 'no JSON object found in the answer' };
}

/** Index of the brace closing the object that starts at `start`, honouring strings; -1 if unclosed. */
function balancedEnd(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}
