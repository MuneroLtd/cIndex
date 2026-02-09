import type { ModuleRecord } from '../../types.js';
import type { Database } from '../database.js';

/**
 * Repository for the `modules` table.
 */
export class ModuleRepository {
  private readonly stmtUpsert;
  private readonly stmtFindByName;

  constructor(private readonly database: Database) {
    const db = this.database.db;

    this.stmtUpsert = db.prepare<[number, string, string | null, string]>(`
      INSERT INTO modules (repo_id, name, version, manifest_path)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (repo_id, name) DO UPDATE SET
        version       = excluded.version,
        manifest_path = excluded.manifest_path
      RETURNING *
    `);

    this.stmtFindByName = db.prepare<[number, string]>(`
      SELECT * FROM modules WHERE repo_id = ? AND name = ?
    `);
  }

  /** Insert a new module or update version/manifest if it already exists. */
  upsert(repoId: number, name: string, version: string | null, manifestPath: string): ModuleRecord {
    return this.stmtUpsert.get(repoId, name, version, manifestPath) as ModuleRecord;
  }

  /** Find a module by name within a repo. */
  findByName(repoId: number, name: string): ModuleRecord | null {
    return (this.stmtFindByName.get(repoId, name) as ModuleRecord) ?? null;
  }
}
