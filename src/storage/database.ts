import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

/**
 * Thin wrapper around better-sqlite3 that initialises the schema
 * and exposes helpers used by the repository classes.
 */
export class Database {
  /** Raw better-sqlite3 handle -- used directly by repositories. */
  public readonly db: BetterSqlite3Database;

  /**
   * Open (or create) a SQLite database.
   *
   * @param dbPath - File path, or `:memory:` for an in-memory database (default).
   */
  constructor(dbPath: string = ':memory:') {
    this.db = new BetterSqlite3(dbPath);

    // Performance & safety pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Apply the full schema (all statements are IF NOT EXISTS, so safe to re-run)
    this.db.exec(SCHEMA_SQL);
  }

  /**
   * Execute `fn` inside an immediate transaction.
   * If `fn` throws, the transaction is rolled back and the error is re-thrown.
   */
  transaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
