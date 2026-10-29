import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Byte-order mark, written as a code point so no invisible character sits in the source. */
const BOM = String.fromCharCode(0xfeff);

/**
 * Prompt pack (ARCHITECTURE.md §6.2 "Prompts are data"): every file under `prompts/`,
 * keyed by its relative path with forward slashes. Stored by content hash per game, so a
 * running or resumed game always uses its own pack, whatever is on disk.
 */
export interface PromptPack {
  files: Record<string, string>;
  hash: string;
}

export class PromptPackError extends Error {}

/** Files every pack must contain (role and task files are checked when used). */
const REQUIRED = ['system.md', 'card.md', 'output.md', 'repair.md', 'retry.md', 'reasoning/village.md', 'reasoning/wolf.md', 'reasoning/solo.md', 'tasks/debrief_comment.md', 'tasks/debrief_reply.md'];

export function loadPromptPack(dir: string): PromptPack {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.md')) files[relative(dir, p).split(sep).join('/')] = stripBom(readFileSync(p, 'utf8')).replace(/\r\n/g, '\n');
    }
  };
  walk(dir);
  return makePack(files);
}

const stripBom = (s: string): string => (s.startsWith(BOM) ? s.slice(1) : s);

export function makePack(files: Record<string, string>): PromptPack {
  const missing = REQUIRED.filter((f) => !(f in files));
  if (missing.length) throw new PromptPackError(`prompt pack is missing: ${missing.join(', ')}`);
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]!]));
  return { files: sorted, hash: createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 32) };
}

export function packFile(pack: PromptPack, path: string): string {
  const f = pack.files[path];
  if (f === undefined) throw new PromptPackError(`prompt pack has no ${path}`);
  return f;
}

/**
 * `{{name}}` substitution. Unknown placeholders are an error (a typo in a prompt must not
 * silently reach a model). Values are inserted verbatim, never re-scanned.
 */
export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new PromptPackError(`unknown placeholder {{${k}}}`);
    return String(vars[k]);
  });
}
