import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '@ww/shared';
import {
  MIGRATIONS_DIR,
  appendEngineEvents,
  appendMetaEvent,
  createLobby,
  getGame,
  getPromptPack,
  lastEngineSeq,
  listEngineEvents,
  openStore,
  putPromptPack,
  abortGame,
  pauseGame,
  resumeGame,
  setGameStatus,
  startGame,
  updateLobby,
  type Store,
} from '../src';

const open: Store[] = [];
const temps: string[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});
const track = (s: Store) => (open.push(s), s);
const mem = () => track(openStore(':memory:'));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ww-store-'));
  temps.push(d);
  return d;
};
const migCopy = () => {
  const d = join(tmp(), 'migrations');
  cpSync(MIGRATIONS_DIR, d, { recursive: true });
  return d;
};

const ev = (eseq: number, type = 'TEST'): EngineEvent => ({
  eseq,
  type,
  at: { phase: 'night', day: 0, night: 1 },
  payload: { n: eseq },
  vis: { kind: 'public' },
});

const START = { config: { seats: 7 }, seed: 'seed', engineVersion: 'test', promptPackHash: null };
const newRunningGame = (s: Store, id = 'g1') => {
  createLobby(s, { id, lobby: { slots: [] }, costCapUsd: 2 });
  startGame(s, id, START);
};

describe('migrations', () => {
  it('creates every table of ARCHITECTURE.md §10', () => {
    const s = mem();
    const tables = (s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of [
      'games', 'slots', 'sessions', 'seat_profiles', 'engine_events', 'meta_events', 'requests', 'decisions',
      'llm_calls', 'human_submissions', 'human_notes', 'prompt_packs', 'model_catalog', 'schema_migrations',
    ]) expect(tables).toContain(t);
  });

  it('is idempotent across reopen and uses WAL on disk', () => {
    const file = join(tmp(), 'db', 'w.db');
    const a = openStore(file);
    const mode = (a.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    a.close();
    const b = track(openStore(file));
    expect(mode).toBe('wal');
    expect((b.db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c).toBe(1);
  });

  it('refuses a migration edited after it was applied', () => {
    const migDir = migCopy();
    const file = join(tmp(), 'x.db');
    openStore(file, { migrationsDir: migDir }).close();
    writeFileSync(join(migDir, '001_init.sql'), readFileSync(join(migDir, '001_init.sql'), 'utf8') + '\n-- edited\n');
    expect(() => openStore(file, { migrationsDir: migDir })).toThrow(/checksum mismatch/);
  });

  it('ignores a BOM and CRLF line endings when checksumming', () => {
    const migDir = migCopy();
    const file = join(tmp(), 'x.db');
    openStore(file, { migrationsDir: migDir }).close();
    const sql = readFileSync(join(migDir, '001_init.sql'), 'utf8');
    writeFileSync(join(migDir, '001_init.sql'), '\uFEFF' + sql.replace(/\r?\n/g, '\r\n'));
    track(openStore(file, { migrationsDir: migDir }));
  });

  it('refuses a database that is ahead of the code', () => {
    const migDir = migCopy();
    const file = join(tmp(), 'x.db');
    writeFileSync(join(migDir, '002_extra.sql'), 'CREATE TABLE extra (x INTEGER);');
    openStore(file, { migrationsDir: migDir }).close();
    rmSync(join(migDir, '002_extra.sql'));
    expect(() => openStore(file, { migrationsDir: migDir })).toThrow(/newer than this code/);
  });

  it('refuses a renamed migration', () => {
    const migDir = migCopy();
    const file = join(tmp(), 'x.db');
    writeFileSync(join(migDir, '002_extra.sql'), 'CREATE TABLE extra (x INTEGER);');
    openStore(file, { migrationsDir: migDir }).close();
    rmSync(join(migDir, '002_extra.sql'));
    writeFileSync(join(migDir, '002_other.sql'), 'CREATE TABLE extra (x INTEGER);');
    expect(() => openStore(file, { migrationsDir: migDir })).toThrow(/renamed/);
  });

  it('refuses numbering gaps and badly named .sql files', () => {
    const a = migCopy();
    writeFileSync(join(a, '003_later.sql'), 'SELECT 1;');
    expect(() => openStore(':memory:', { migrationsDir: a })).toThrow(/numbering gap/);
    const b = migCopy();
    writeFileSync(join(b, 'fix-stuff.sql'), 'SELECT 1;');
    expect(() => openStore(':memory:', { migrationsDir: b })).toThrow(/invalid migration file name/);
  });
});

describe('transactions', () => {
  it('rolls back the whole transaction on error', () => {
    const s = mem();
    newRunningGame(s);
    expect(() =>
      s.tx(() => {
        appendEngineEvents(s, 'g1', [ev(1), ev(2)]);
        pauseGame(s, 'g1', 'host');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(lastEngineSeq(s, 'g1')).toBe(0);
    expect(getGame(s, 'g1')!.status).toBe('running');
  });

  it('rejects nested transactions and stays usable', () => {
    const s = mem();
    expect(() => s.tx(() => s.tx(() => 1))).toThrow(/not re-entrant/);
    expect(s.tx(() => 2)).toBe(2);
    expect(s.inTransaction).toBe(false);
  });

  it('nested atomic() rolls back only its own writes (savepoint)', () => {
    const s = mem();
    newRunningGame(s);
    s.tx(() => {
      appendEngineEvents(s, 'g1', [ev(1)]);
      try {
        s.atomic(() => {
          appendEngineEvents(s, 'g1', [ev(2)]);
          throw new Error('inner');
        });
      } catch {
        // caller recovers and continues
      }
      appendEngineEvents(s, 'g1', [ev(2, 'AGAIN')]);
    });
    expect(listEngineEvents(s, 'g1').map((e) => e.type)).toEqual(['TEST', 'AGAIN']);
  });

  it('refuses to commit when SQLite aborted the transaction inside a nested block', () => {
    const s = mem();
    createLobby(s, { id: 'dup', lobby: {}, costCapUsd: 1 });
    expect(() =>
      s.tx(() => {
        createLobby(s, { id: 'before', lobby: {}, costCapUsd: 1 });
        try {
          s.atomic(() => {
            // OR ROLLBACK makes SQLite abort the WHOLE transaction on the PK conflict
            s.db.prepare("INSERT OR ROLLBACK INTO games (id, created_at, status, lobby_json, cost_cap_usd) VALUES ('dup', 'x', 'lobby', '{}', 1)").run();
          });
        } catch {
          // the caller swallows the inner error and keeps writing
        }
        createLobby(s, { id: 'after', lobby: {}, costCapUsd: 1 });
      }),
    ).toThrow(/aborted by SQLite/);
    expect(getGame(s, 'before')).toBeUndefined();
    expect(getGame(s, 'after')).toBeUndefined();
    expect(s.inTransaction).toBe(false);
    expect(s.tx(() => 7)).toBe(7); // usable again, poison cleared
  });

  it('refuses further repository writes after a swallowed self-abort in a plain tx()', () => {
    const s = mem();
    createLobby(s, { id: 'dup', lobby: {}, costCapUsd: 1 });
    expect(() =>
      s.tx(() => {
        createLobby(s, { id: 'before', lobby: {}, costCapUsd: 1 });
        try {
          s.db.prepare("INSERT OR ROLLBACK INTO games (id, created_at, status, lobby_json, cost_cap_usd) VALUES ('dup', 'x', 'lobby', '{}', 1)").run();
        } catch {
          // swallowed directly in the tx body (no atomic boundary)
        }
        createLobby(s, { id: 'after', lobby: {}, costCapUsd: 1 }); // must not autocommit
      }),
    ).toThrow(/aborted by SQLite/);
    expect(getGame(s, 'before')).toBeUndefined();
    expect(getGame(s, 'after')).toBeUndefined();
    expect(s.tx(() => 1)).toBe(1);
  });

  it('BEGIN-probe path: a lost transaction plus a foreign lock (BUSY) poisons and refuses the write', () => {
    const file = join(tmp(), 'probe.db');
    const s = track(openStore(file));
    s.db.exec('PRAGMA busy_timeout = 0');
    // force the pre-22.16 probe path even on newer Node versions
    Object.defineProperty(s.db, 'isTransaction', { value: undefined, configurable: true });
    createLobby(s, { id: 'dup', lobby: {}, costCapUsd: 1 });
    const other = new DatabaseSync(file);
    try {
      expect(() =>
        s.tx(() => {
          try {
            s.db.prepare("INSERT OR ROLLBACK INTO games (id, created_at, status, lobby_json, cost_cap_usd) VALUES ('dup', 'x', 'lobby', '{}', 1)").run();
          } catch {
            // swallowed: SQLite has dropped the transaction
          }
          other.exec('BEGIN IMMEDIATE'); // another process now holds the write lock
          try {
            createLobby(s, { id: 'after', lobby: {}, costCapUsd: 1 });
          } finally {
            other.exec('ROLLBACK');
          }
        }),
      ).toThrow(/busy|locked/i);
    } finally {
      other.close();
    }
    expect(getGame(s, 'after')).toBeUndefined();
    expect(s.tx(() => 5)).toBe(5);
  });

  it('decisions must reference an existing request', () => {
    const s = mem();
    newRunningGame(s);
    const insDecision = () =>
      s.db
        .prepare("INSERT INTO decisions (game_id, internal_id, seat, answer_json, source, status) VALUES ('g1', 1, 1, '{}', 'model', 'buffered')")
        .run();
    expect(insDecision).toThrow(/FOREIGN KEY/);
    s.db
      .prepare(
        "INSERT INTO requests (game_id, internal_id, client_id, seat, kind, legal_json, group_id, opened_eseq) VALUES ('g1', 1, 'c1', 1, 'vote', '{}', 1, 1)",
      )
      .run();
    insDecision();
  });

  it('CHECK constraints guard ranges on the other tables', () => {
    const s = mem();
    newRunningGame(s);
    const run = (sql: string) => () => s.db.prepare(sql).run();
    expect(run("INSERT INTO slots (game_id, slot, controller) VALUES ('g1', 11, 'ai')")).toThrow(/CHECK/);
    expect(run("INSERT INTO slots (game_id, slot, seat, controller, won) VALUES ('g1', 1, 1, 'ai', 2)")).toThrow(/CHECK/);
    expect(run("INSERT INTO engine_events (game_id, eseq, type, vis_json, payload_json, at_json) VALUES ('g1', 0, 't', '{}', '{}', '{}')")).toThrow(/CHECK/);
    expect(run("INSERT INTO decisions (game_id, internal_id, seat, answer_json, source, repair_used, status) VALUES ('g1', 1, 1, '{}', 'model', 3, 'buffered')")).toThrow(/CHECK/);
    expect(
      run("INSERT INTO llm_calls (profile_alias, openrouter_id, attempt, purpose, status, reserved_usd, created_at) VALUES ('a', 'x/y', 1, 'ping', 'ok', -1, 'now')"),
    ).toThrow(/CHECK/);
    expect(
      run("INSERT INTO llm_calls (profile_alias, openrouter_id, attempt, purpose, status, reserved_usd, latency_ms, created_at) VALUES ('a', 'x/y', 1, 'ping', 'ok', 0, -5, 'now')"),
    ).toThrow(/CHECK/);
    expect(
      run("INSERT INTO llm_calls (profile_alias, openrouter_id, attempt, purpose, status, reserved_usd, created_at) VALUES ('a', 'x/y', 99, 'ping', 'ok', 0, 'now')"),
    ).toThrow(/CHECK/);
  });

  it('a second handle on the same file sees the applied migrations', () => {
    const file = join(tmp(), 'two.db');
    const a = track(openStore(file));
    const b = track(openStore(file));
    expect((b.db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c).toBe(1);
    expect(a.path).toBe(b.path);
  });

  it('atomic() joins an open transaction or opens its own', () => {
    const s = mem();
    expect(s.atomic(() => s.inTransaction)).toBe(true);
    expect(s.tx(() => s.atomic(() => 3))).toBe(3);
  });

  it('stays usable after BEGIN itself fails (e.g. SQLITE_BUSY)', () => {
    const file = join(tmp(), 'busy.db');
    const s = track(openStore(file));
    s.db.exec('PRAGMA busy_timeout = 0');
    const other = new DatabaseSync(file);
    try {
      other.exec('BEGIN IMMEDIATE');
      expect(() => s.tx(() => 1)).toThrow(/locked|busy/i);
      other.exec('ROLLBACK');
    } finally {
      other.close();
    }
    expect(s.inTransaction).toBe(false);
    expect(s.tx(() => 42)).toBe(42);
  });
});

describe('repositories', () => {
  it('creates a lobby without a frozen config, then starts it', () => {
    const s = mem();
    createLobby(s, { id: 'g1', lobby: { slots: [1, 2] }, costCapUsd: 2 });
    expect(getGame(s, 'g1')).toMatchObject({ status: 'lobby', config_json: null, seed: null, cost_cap_usd: 2 });
    updateLobby(s, 'g1', { slots: [1, 2, 3] }, 3);
    expect(JSON.parse(getGame(s, 'g1')!.lobby_json!)).toEqual({ slots: [1, 2, 3] });
    expect(getGame(s, 'g1')!.cost_cap_usd).toBe(3);
    startGame(s, 'g1', START);
    const g = getGame(s, 'g1')!;
    expect(g).toMatchObject({ status: 'running', seed: 'seed', engine_version: 'test' });
    expect(g.started_at).not.toBeNull();
    expect(JSON.parse(g.config_json!)).toEqual({ seats: 7 });
    expect(() => startGame(s, 'g1', START)).toThrow(/already started/);
    expect(() => updateLobby(s, 'g1', {})).toThrow(/already started/);
  });

  it('CHECK constraints guard lobby drafts and pause bookkeeping', () => {
    const s = mem();
    createLobby(s, { id: 'g1', lobby: {}, costCapUsd: 2 });
    const upd = (sql: string) => () => s.db.prepare(sql).run();
    expect(upd("UPDATE games SET status = 'running' WHERE id = 'g1'")).toThrow(/CHECK/);
    expect(upd("UPDATE games SET status = 'bogus'")).toThrow(/CHECK/);
    expect(upd("UPDATE games SET config_json = '{}' WHERE id = 'g1'")).toThrow(/CHECK/); // a lobby has no frozen config
    expect(upd("UPDATE games SET lobby_json = NULL WHERE id = 'g1'")).toThrow(/CHECK/);
    expect(upd("UPDATE games SET pause_reason = 'x' WHERE id = 'g1'")).toThrow(/CHECK/);
    newRunningGame(s, 'g2');
    expect(upd("UPDATE games SET status = 'paused' WHERE id = 'g2'")).toThrow(/CHECK/); // no reason / origin
    expect(upd("UPDATE games SET status = 'paused', pause_reason = 'x', paused_from = 'over' WHERE id = 'g2'")).toThrow(/CHECK/);
  });

  it('a lobby can be aborted before it starts', () => {
    const s = mem();
    createLobby(s, { id: 'g1', lobby: {}, costCapUsd: 2 });
    expect(abortGame(s, 'g1')).toBe('aborted');
    expect(getGame(s, 'g1')!.status).toBe('aborted');
  });

  it('progress transitions follow STATUS_TRANSITIONS', () => {
    const s = mem();
    newRunningGame(s);
    expect(() => setGameStatus(s, 'g1', 'debrief')).toThrow(/illegal status transition running → debrief/);
    expect(() => setGameStatus(s, 'g1', 'paused')).toThrow(/illegal/);
    expect(() => setGameStatus(s, 'g1', 'aborted')).toThrow(/illegal/);
    setGameStatus(s, 'g1', 'over_offer');
    setGameStatus(s, 'g1', 'debrief');
    setGameStatus(s, 'g1', 'over');
    expect(() => setGameStatus(s, 'g1', 'running')).toThrow(/illegal/);
    expect(() => setGameStatus(s, 'nope', 'over')).toThrow(/not found/);
  });

  it('pause remembers its origin, can be re-paused with a new reason, and resumes there', () => {
    const s = mem();
    newRunningGame(s);
    pauseGame(s, 'g1', 'host');
    expect(getGame(s, 'g1')).toMatchObject({ status: 'paused', pause_reason: 'host', paused_from: 'running' });
    pauseGame(s, 'g1', 'recovered'); // paused -> paused (recovery, ARCHITECTURE §9.4)
    expect(getGame(s, 'g1')).toMatchObject({ status: 'paused', pause_reason: 'recovered', paused_from: 'running' });
    expect(resumeGame(s, 'g1')).toBe('running');
    expect(getGame(s, 'g1')).toMatchObject({ status: 'running', pause_reason: null, paused_from: null });
    expect(() => resumeGame(s, 'g1')).toThrow(/not paused/);
    expect(() => pauseGame(s, 'g1', '' as never)).toThrow(/unknown pause reason/);
    setGameStatus(s, 'g1', 'over_offer');
    setGameStatus(s, 'g1', 'debrief');
    pauseGame(s, 'g1', 'recovered');
    expect(resumeGame(s, 'g1')).toBe('debrief');
    setGameStatus(s, 'g1', 'over');
    expect(() => pauseGame(s, 'g1', 'host')).toThrow(/cannot pause/);
  });

  it('terminal pause reasons can only be aborted', () => {
    const s = mem();
    newRunningGame(s);
    pauseGame(s, 'g1', 'version_mismatch');
    expect(() => pauseGame(s, 'g1', 'recovered')).toThrow(/terminal reason/);
    expect(() => resumeGame(s, 'g1')).toThrow(/terminal reason/);
    expect(abortGame(s, 'g1')).toBe('aborted');
    expect(() => pauseGame(s, 'g1', 'nonsense' as never)).toThrow(/unknown pause reason/);
  });

  it('CHECK constraints guard numeric ranges and flags', () => {
    const s = mem();
    expect(() => createLobby(s, { id: 'neg', lobby: {}, costCapUsd: -5 })).toThrow(/CHECK/);
    newRunningGame(s);
    const upd = (sql: string) => () => s.db.prepare(sql).run();
    expect(upd("UPDATE games SET has_bot = 2 WHERE id = 'g1'")).toThrow(/CHECK/);
    expect(upd("UPDATE games SET lock_open = -1 WHERE id = 'g1'")).toThrow(/CHECK/);
    expect(upd("UPDATE games SET cost_spent_usd = -0.01 WHERE id = 'g1'")).toThrow(/CHECK/);
    expect(upd("UPDATE games SET status = 'paused', paused_from = 'running', pause_reason = 'whatever' WHERE id = 'g1'")).toThrow(/CHECK/);
  });

  it('abort keeps an existing result (debrief / over_offer, also when paused from there)', () => {
    const s = mem();
    newRunningGame(s, 'a');
    setGameStatus(s, 'a', 'over_offer');
    setGameStatus(s, 'a', 'debrief');
    pauseGame(s, 'a', 'recovered');
    expect(abortGame(s, 'a')).toBe('over');
    expect(getGame(s, 'a')).toMatchObject({ status: 'over', pause_reason: null, paused_from: null });

    newRunningGame(s, 'b');
    setGameStatus(s, 'b', 'over_offer');
    expect(abortGame(s, 'b')).toBe('over');

    newRunningGame(s, 'c');
    pauseGame(s, 'c', 'cost_cap');
    expect(abortGame(s, 'c')).toBe('aborted');
    expect(() => abortGame(s, 'c')).toThrow(/cannot abort/);
  });

  it('tx rejects promise-like callbacks', () => {
    const s = mem();
    expect(() => s.tx(() => ({ then() {} }))).toThrow(/synchronous/);
    expect(s.tx(() => 1)).toBe(1);
  });

  it('appends contiguous engine events and rejects gaps without partial writes', () => {
    const s = mem();
    newRunningGame(s);
    appendEngineEvents(s, 'g1', [ev(1), ev(2)]);
    appendEngineEvents(s, 'g1', [ev(3)]);
    expect(lastEngineSeq(s, 'g1')).toBe(3);
    expect(() => appendEngineEvents(s, 'g1', [ev(4), ev(6)])).toThrow(/expected eseq 5/);
    expect(lastEngineSeq(s, 'g1')).toBe(3); // ev(4) was not written
    expect(listEngineEvents(s, 'g1', 2).map((e) => e.eseq)).toEqual([2, 3]);
    expect(listEngineEvents(s, 'g1')[0]).toEqual(ev(1));
  });

  it('numbers meta events per game', () => {
    const s = mem();
    newRunningGame(s, 'a');
    newRunningGame(s, 'b');
    const base = { wallTime: new Date().toISOString(), type: 'GAME_PAUSED' as const, payload: {}, vis: 'host_safe' as const };
    expect(appendMetaEvent(s, 'a', base)).toBe(1);
    expect(appendMetaEvent(s, 'a', base)).toBe(2);
    expect(appendMetaEvent(s, 'b', base)).toBe(1);
  });

  it('enforces one slot per table seat', () => {
    const s = mem();
    newRunningGame(s);
    const ins = s.db.prepare("INSERT INTO slots (game_id, slot, seat, controller) VALUES ('g1', ?, ?, 'ai')");
    ins.run(1, 3);
    ins.run(2, null);
    ins.run(3, null);
    expect(() => ins.run(4, 3)).toThrow();
  });

  it('stores prompt packs by content hash idempotently', () => {
    const s = mem();
    putPromptPack(s, 'h1', { system: 'x' });
    putPromptPack(s, 'h1', { system: 'different' });
    expect(getPromptPack(s, 'h1')).toEqual({ system: 'x' });
    expect(getPromptPack(s, 'missing')).toBeUndefined();
  });

  it('cascades deletes from games', () => {
    const s = mem();
    newRunningGame(s);
    appendEngineEvents(s, 'g1', [ev(1)]);
    s.db.prepare("DELETE FROM games WHERE id = 'g1'").run();
    expect(lastEngineSeq(s, 'g1')).toBe(0);
  });
});
