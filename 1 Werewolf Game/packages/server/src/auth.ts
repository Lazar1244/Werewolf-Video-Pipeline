import { randomUUID, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Store } from '@ww/store';
import type { Principal } from '@ww/shared';

/**
 * Principals and sessions (ARCHITECTURE.md §9.1).
 *
 * The host proves itself once with `HOST_TOKEN` (or automatically from localhost). Each human
 * slot gets a one-time join link; opening it trades the token for an HttpOnly session cookie
 * and burns the token. Only hashes are stored, never the tokens themselves.
 */
export const HOST_COOKIE = 'ww_host';
export const seatCookieName = (gameId: string): string => `ww_seat_${gameId.replace(/[^a-zA-Z0-9]/g, '')}`;
export const spectatorCookieName = (gameId: string): string => `ww_spec_${gameId.replace(/[^a-zA-Z0-9]/g, '')}`;

export const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
export const newToken = (): string => randomBytes(16).toString('hex');
/** Short code a human reads out to the host when they need a new link (§9.1). */
export const newRejoinCode = (): string => randomBytes(4).toString('hex').slice(0, 6).toUpperCase();

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(hash(a));
  const y = Buffer.from(hash(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Sessions of one slot that can still be redeemed or are already in use. */
export function activeSeatSessions(store: Store, gameId: string, slot: number): SessionRow[] {
  return (store.db.prepare('SELECT * FROM sessions WHERE game_id = ? AND slot = ? AND principal = ?').all(gameId, slot, 'seat') as unknown as SessionRow[]).filter((s) => !s.revoked_at);
}

export interface SessionRow {
  id: string;
  game_id: string;
  principal: 'seat' | 'spectator';
  slot: number | null;
  join_token_hash: string | null;
  cookie_hash: string | null;
  rejoin_code_hash: string | null;
  used_at: string | null;
  revoked_at: string | null;
}

export function createSession(store: Store, s: { id: string; gameId: string; principal: 'seat' | 'spectator'; slot: number | null; joinToken: string }): void {
  store.atomic(() => {
    store.db
      .prepare(`INSERT INTO sessions (id, game_id, principal, slot, join_token_hash, rejoin_code_hash, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`)
      .run(s.id, s.gameId, s.principal, s.slot, hash(s.joinToken), new Date().toISOString());
  });
}

/**
 * Trade a one-time join token for a session cookie. The token is burned in the same step.
 *
 * A seat also gets its **rejoin code** here, at first join, so only the player's own device ever
 * sees it (§9.1): the host never does, which is what stops a host who also plays from taking
 * over someone else's disconnected seat while the game is hidden. Only its hash is stored.
 */
export function redeemJoinToken(store: Store, token: string): { session: SessionRow; cookie: string; rejoinCode: string | null } | null {
  return store.atomic(() => {
    const row = store.db.prepare('SELECT * FROM sessions WHERE join_token_hash = ?').get(hash(token)) as SessionRow | undefined;
    if (!row || row.revoked_at) return null;
    const cookie = newToken();
    if (row.principal === 'spectator') {
      // A spectator link is shared: every opening gets its own session and the link stays valid.
      // It only ever shows what a spectator may see.
      const id = randomUUID();
      store.db
        .prepare(`INSERT INTO sessions (id, game_id, principal, slot, join_token_hash, cookie_hash, rejoin_code_hash, created_at, used_at) VALUES (?, ?, 'spectator', NULL, NULL, ?, NULL, ?, ?)`)
        .run(id, row.game_id, hash(cookie), new Date().toISOString(), new Date().toISOString());
      return { session: { ...row, id, cookie_hash: hash(cookie), join_token_hash: null }, cookie, rejoinCode: null };
    }
    const rejoinCode = row.principal === 'seat' ? newRejoinCode() : null;
    store.db
      .prepare('UPDATE sessions SET cookie_hash = ?, join_token_hash = NULL, used_at = ?, rejoin_code_hash = ? WHERE id = ?')
      .run(hash(cookie), new Date().toISOString(), rejoinCode ? hash(rejoinCode) : null, row.id);
    return { session: { ...row, cookie_hash: hash(cookie), join_token_hash: null }, cookie, rejoinCode };
  });
}

export function sessionByCookie(store: Store, gameId: string, cookie: string): SessionRow | undefined {
  const row = store.db.prepare('SELECT * FROM sessions WHERE game_id = ? AND cookie_hash = ?').get(gameId, hash(cookie)) as SessionRow | undefined;
  return row && !row.revoked_at ? row : undefined;
}

/** Whether a join link is still good, without using it (for the "Join" page). */
export function joinTokenUsable(store: Store, token: string, principal: 'seat' | 'spectator'): boolean {
  const row = store.db.prepare('SELECT principal, revoked_at FROM sessions WHERE join_token_hash = ?').get(hash(token)) as { principal: string; revoked_at: string | null } | undefined;
  return !!row && !row.revoked_at && row.principal === principal;
}

/** Whether any of these cookie values is a live session of any game (for the games list). */
export function anyLiveSession(store: Store, cookies: string[]): boolean {
  const stmt = store.db.prepare('SELECT 1 FROM sessions WHERE cookie_hash = ? AND revoked_at IS NULL');
  return cookies.some((c) => !!stmt.get(hash(c)));
}

/** The seat a cookie was issued for, even if that session has since been revoked. */
export function slotOfAnyCookie(store: Store, gameId: string, cookie: string): number | null {
  const row = store.db.prepare(`SELECT slot FROM sessions WHERE game_id = ? AND cookie_hash = ? AND principal = 'seat'`).get(gameId, hash(cookie)) as { slot: number | null } | undefined;
  return row?.slot ?? null;
}

export function revokeSession(store: Store, id: string): void {
  store.atomic(() => {
    store.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  });
}

export function sessionsOfGame(store: Store, gameId: string): SessionRow[] {
  return store.db.prepare('SELECT * FROM sessions WHERE game_id = ?').all(gameId) as unknown as SessionRow[];
}

/** Does this rejoin code belong to that slot? Needed for a reissue while the lock is closed. */
export function rejoinCodeMatches(store: Store, gameId: string, slot: number, code: string): boolean {
  // the code of the device that last joined this seat; a link issued but not yet opened has none
  const row = store.db
    .prepare('SELECT rejoin_code_hash FROM sessions WHERE game_id = ? AND slot = ? AND principal = ? AND used_at IS NOT NULL ORDER BY used_at DESC LIMIT 1')
    .get(gameId, slot, 'seat') as
    | { rejoin_code_hash: string | null }
    | undefined;
  if (!row?.rejoin_code_hash) return false;
  return constantTimeEqual(row.rejoin_code_hash, hash(code.trim().toUpperCase()));
}

export interface HostAuthOptions {
  hostToken: string | null;
  hostFromLocalhost: boolean;
}

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
export const isLocal = (ip: string | undefined): boolean => LOCAL.has((ip ?? '').trim());

/** The host proves itself with the token, or from localhost when `hostFromLocalhost` is on. */
export function checkHostToken(o: HostAuthOptions, presented: string | undefined, ip: string | undefined): boolean {
  if (presented && o.hostToken && constantTimeEqual(presented, o.hostToken)) return true;
  return o.hostFromLocalhost && isLocal(ip) && !presented;
}

/** Whether an Origin header belongs to this server (blocks cross-site WS hijacking and CSRF). */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (curl, the CLI) send no Origin
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const principalOf = (row: SessionRow, seat: number | null, name: string): Principal =>
  row.principal === 'seat' && seat !== null ? { kind: 'seat', seat, slot: row.slot ?? 0, name } : { kind: 'spectator' };
