import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** Default migrations shipped with this package. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface Store {
  readonly db: DatabaseSync;
  readonly path: string;
  /** True while a `tx()` callback is running. */
  readonly inTransaction: boolean;
  /** Run `fn` in one transaction (BEGIN IMMEDIATE … COMMIT / ROLLBACK). Not re-entrant. */
  tx<T>(fn: () => T): T;
  /**
   * Run `fn` atomically: in a savepoint inside the current transaction if there is one,
   * else in a new transaction. Every repository write goes through atomic(), which also
   * verifies the surrounding transaction is still alive.
   *
   * Rule: never swallow SQLite errors inside tx()/atomic() and keep writing with raw
   * statements — only writes made through atomic() are protected against a transaction
   * that SQLite aborted on its own.
   */
  atomic<T>(fn: () => T): T;
  close(): void;
}

export interface OpenStoreOptions {
  migrationsDir?: string;
}

/** Open (or create) the SQLite database, set pragmas and apply pending migrations. */
export function openStore(path: string, opts: OpenStoreOptions = {}): Store {
  const inMemory = path === ':memory:';
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  let depth = 0;
  /**
   * Set when SQLite aborted the whole transaction on its own inside a nested block
   * (OR ROLLBACK conflict, RAISE(ROLLBACK), I/O error…). The outer tx() then refuses
   * to commit, even if the caller swallowed the inner error.
   */
  let poisoned = false;

  /**
   * Inside tx(): make sure SQLite has not silently dropped the transaction (it does so on
   * OR ROLLBACK conflicts, RAISE(ROLLBACK) and I/O errors; if the caller swallowed that
   * error, later statements would autocommit). BEGIN fails while a transaction is active,
   * so a successful BEGIN proves it was lost: the new transaction keeps later writes
   * uncommitted, and the poison makes tx() roll everything back.
   */
  function assertTransactionAlive(): void {
    if (poisoned) throw new Error('transaction was aborted by SQLite; refusing to write');
    // Node >= 22.16 exposes the real state; older versions use the BEGIN probe.
    const state = (db as unknown as { isTransaction?: unknown }).isTransaction;
    if (state === true) return;
    if (state !== false) {
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch (e) {
        if (/within a transaction/i.test(String((e as Error).message))) return; // still inside the transaction: good
        // SQLite checks for an active transaction before taking any lock, so any other error
        // (e.g. SQLITE_BUSY) means the transaction is already gone: poison and refuse.
        poisoned = true;
        throw e;
      }
    } else {
      poisoned = true;
      db.exec('BEGIN IMMEDIATE'); // keep later writes uncommitted until tx() rolls back
    }
    poisoned = true;
    throw new Error('transaction was aborted by SQLite (an earlier error was swallowed); refusing to write');
  }

  const store: Store = {
    db,
    path,
    get inTransaction() {
      return depth > 0;
    },
    tx<T>(fn: () => T): T {
      if (depth > 0) throw new Error('Store.tx is not re-entrant');
      depth++;
      try {
        db.exec('BEGIN IMMEDIATE');
        let out: T;
        try {
          out = fn();
          if (typeof (out as { then?: unknown } | null)?.then === 'function') {
            throw new Error('Store.tx callback must be synchronous');
          }
          if (poisoned) throw new Error('transaction was aborted by SQLite inside a nested atomic block; nothing was committed');
          db.exec('COMMIT');
        } catch (e) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // keep the original error; a failed ROLLBACK means SQLite already rolled back
          }
          throw e;
        }
        return out;
      } finally {
        depth--;
        poisoned = false;
      }
    },
    atomic<T>(fn: () => T): T {
      if (depth === 0) return store.tx(fn);
      assertTransactionAlive();
      // Nested: a savepoint makes the inner block all-or-nothing even if the caller catches its error.
      const sp = `ww_sp_${depth}`;
      depth++;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        const out = fn();
        db.exec(`RELEASE ${sp}`);
        return out;
      } catch (e) {
        try {
          db.exec(`ROLLBACK TO ${sp}`);
          db.exec(`RELEASE ${sp}`);
        } catch {
          // The savepoint is gone: SQLite rolled back the entire transaction itself.
          // Re-open one so later writes stay uncommitted, and poison it so tx() rolls back.
          poisoned = true;
          try {
            db.exec('BEGIN IMMEDIATE');
          } catch {
            // a transaction is still active
          }
        }
        throw e;
      } finally {
        depth--;
      }
    },
    close() {
      db.close();
    },
  };

  try {
    // busy_timeout first, so even the WAL switch waits for another process instead of failing.
    db.exec('PRAGMA busy_timeout = 5000;');
    if (!inMemory) db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
    migrate(store, opts.migrationsDir ?? MIGRATIONS_DIR);
  } catch (e) {
    db.close(); // never leak an open handle (locks the file on Windows)
    throw e;
  }
  return store;
}

export interface MigrationResult {
  applied: string[];
  current: number;
}

const MIGRATION_NAME_RE = /^\d{3}_[a-z0-9_]+\.sql$/;

/**
 * Apply numbered `NNN_name.sql` files in order, each in its own transaction.
 * Errors on: badly named .sql files, numbering gaps, a database that is ahead of
 * the code, a renamed migration, or a migration edited after being applied.
 */
export function migrate(store: Store, dir: string): MigrationResult {
  const { db } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const sqlFiles = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql'));
  const badName = sqlFiles.find((f) => !MIGRATION_NAME_RE.test(f));
  if (badName) throw new Error(`invalid migration file name "${badName}" (expected NNN_lower_snake.sql)`);
  const files = sqlFiles.sort();
  files.forEach((f, i) => {
    const v = Number(f.slice(0, 3));
    if (v !== i + 1) throw new Error(`migration numbering gap: expected ${String(i + 1).padStart(3, '0')}_*.sql, found ${f}`);
  });

  const appliedRows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as {
    version: number;
    name: string;
    checksum: string;
  }[];
  const maxApplied = appliedRows.at(-1)?.version ?? 0;
  if (maxApplied > files.length) {
    throw new Error(`database schema version ${maxApplied} is newer than this code (knows ${files.length}); refusing to open`);
  }
  const applied = new Map(appliedRows.map((r) => [r.version, r]));
  const newlyApplied: string[] = [];

  for (const f of files) {
    const version = Number(f.slice(0, 3));
    const sql = readFileSync(join(dir, f), 'utf8').replace(/^\uFEFF/, '');
    const checksum = fnv1a(sql.replace(/\r\n/g, '\n'));
    const prev = applied.get(version);
    if (prev) {
      if (prev.name !== f) throw new Error(`migration ${version} was renamed ("${prev.name}" → "${f}")`);
      if (prev.checksum !== checksum) throw new Error(`migration ${f} was modified after being applied (checksum mismatch)`);
      continue;
    }
    // BEGIN IMMEDIATE takes the write lock; re-check inside it so a second process
    // opening the same database concurrently skips what the first one applied.
    const didApply = store.tx(() => {
      const now = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(version) as { checksum: string } | undefined;
      if (now) {
        if (now.checksum !== checksum) throw new Error(`migration ${f} was modified after being applied (checksum mismatch)`);
        return false;
      }
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
        version,
        f,
        checksum,
        new Date().toISOString(),
      );
      return true;
    });
    if (didApply) newlyApplied.push(f);
  }
  return { applied: newlyApplied, current: files.length };
}

/** Small stable checksum (FNV-1a 32-bit, hex). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
