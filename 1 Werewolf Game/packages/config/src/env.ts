import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Secrets read from the environment and/or `.env` (never logged, never sent to clients). */
export interface Secrets {
  openrouterApiKey: string | null;
  hostToken: string | null;
}

/** Minimum HOST_TOKEN length before `config:check` warns (the server listens on the LAN). */
export const MIN_HOST_TOKEN_LENGTH = 24;

/**
 * Minimal .env parser: `KEY=VALUE` lines, optional `export ` prefix, `#` comments
 * (whole-line, or inline after whitespace for unquoted values), optional quotes.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.indexOf(q, 1) > 0) {
      value = value.slice(1, value.indexOf(q, 1)); // first closing quote; anything after it (e.g. a comment) is ignored
    } else if (q === '"' || q === "'") {
      value = value.slice(1).trim(); // unterminated quote: drop the opening quote
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Real environment variables take precedence over `.env`, but an empty value
 * counts as "not set" in both places.
 */
export function loadSecrets(rootDir: string, env: NodeJS.ProcessEnv = process.env): Secrets {
  const file = join(rootDir, '.env');
  const fromFile = existsSync(file) ? parseDotEnv(readFileSync(file, 'utf8')) : {};
  const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  const get = (k: string) => nonEmpty(env[k]) ?? nonEmpty(fromFile[k]);
  return { openrouterApiKey: get('OPENROUTER_API_KEY'), hostToken: get('HOST_TOKEN') };
}

/** For logs/diagnostics: never reveal a secret, only whether it is set. */
export function describeSecret(v: string | null): string {
  return v ? `set (${v.length} chars)` : 'not set';
}

/** Non-fatal warnings about secrets, for `config:check` and server start-up. */
export function secretWarnings(s: Secrets): string[] {
  const w: string[] = [];
  if (!s.hostToken) w.push('HOST_TOKEN is not set (required before the server milestone M5)');
  else if (s.hostToken.length < MIN_HOST_TOKEN_LENGTH) {
    w.push(`HOST_TOKEN is shorter than ${MIN_HOST_TOKEN_LENGTH} characters; use a long random string (the server listens on the LAN)`);
  }
  if (!s.openrouterApiKey) w.push('OPENROUTER_API_KEY is not set (required from milestone M4)');
  return w;
}
