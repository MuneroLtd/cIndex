import type { RepoRecord } from '../../types.js';
import type { Database } from '../database.js';

/**
 * Repository for the `repos` table.
 */
export class RepoRepository {
  private readonly stmtUpsert;
  private readonly stmtFindByPath;
  private readonly stmtFindById;

  constructor(private readonly database: Database) {
    const db = this.database.db;

    this.stmtUpsert = db.prepare<[string]>(`
      INSERT INTO repos (root_path)
      VALUES (?)
      ON CONFLICT (root_path) DO UPDATE SET
        updated_at = datetime('now')
      RETURNING *
    `);

    this.stmtFindByPath = db.prepare<[string]>(`
      SELECT * FROM repos WHERE root_path = ?
    `);

    this.stmtFindById = db.prepare<[number]>(`
      SELECT * FROM repos WHERE id = ?
    `);
  }

  /** Insert a new repo or touch `updated_at` if it already exists. */
  upsert(rootPath: string): RepoRecord {
    return this.stmtUpsert.get(rootPath) as RepoRecord;
  }

  /** Look up a repo by its filesystem root path. */
  findByPath(rootPath: string): RepoRecord | null {
    return (this.stmtFindByPath.get(rootPath) as RepoRecord) ?? null;
  }

  /** Look up a repo by its primary key. */
  findById(id: number): RepoRecord | null {
    return (this.stmtFindById.get(id) as RepoRecord) ?? null;
  }
}
