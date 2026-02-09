import type { FileRecord } from '../../types.js';
import type { Database } from '../database.js';

/**
 * Repository for the `files` table.
 */
export class FileRepository {
  private readonly stmtUpsert;
  private readonly stmtFindByPath;
  private readonly stmtFindByRepoId;
  private readonly stmtDeleteByPath;
  private readonly stmtCountByRepo;
  private readonly stmtCountByLang;

  constructor(private readonly database: Database) {
    const db = this.database.db;

    this.stmtUpsert = db.prepare<[number, string, string, string, number, number]>(`
      INSERT INTO files (repo_id, path, lang, sha256, mtime, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (repo_id, path) DO UPDATE SET
        lang            = excluded.lang,
        sha256          = excluded.sha256,
        mtime           = excluded.mtime,
        size_bytes      = excluded.size_bytes,
        last_indexed_at = datetime('now')
      RETURNING *
    `);

    this.stmtFindByPath = db.prepare<[number, string]>(`
      SELECT * FROM files WHERE repo_id = ? AND path = ?
    `);

    this.stmtFindByRepoId = db.prepare<[number]>(`
      SELECT * FROM files WHERE repo_id = ?
    `);

    this.stmtDeleteByPath = db.prepare<[number, string]>(`
      DELETE FROM files WHERE repo_id = ? AND path = ?
    `);

    this.stmtCountByRepo = db.prepare<[number]>(`
      SELECT COUNT(*) AS cnt FROM files WHERE repo_id = ?
    `);

    this.stmtCountByLang = db.prepare<[number]>(`
      SELECT lang, COUNT(*) AS cnt FROM files WHERE repo_id = ? GROUP BY lang
    `);
  }

  /** Insert or update a file record, returning the resulting row. */
  upsert(
    repoId: number,
    path: string,
    lang: string,
    sha256: string,
    mtime: number,
    sizeBytes: number,
  ): FileRecord {
    return this.stmtUpsert.get(repoId, path, lang, sha256, mtime, sizeBytes) as FileRecord;
  }

  /** Find a single file by repo + relative path. */
  findByPath(repoId: number, path: string): FileRecord | null {
    return (this.stmtFindByPath.get(repoId, path) as FileRecord) ?? null;
  }

  /** Return every file belonging to a repo. */
  findByRepoId(repoId: number): FileRecord[] {
    return this.stmtFindByRepoId.all(repoId) as FileRecord[];
  }

  /**
   * Compare a list of currently-discovered files against what is stored
   * in the database and return three buckets:
   *
   * - `new`     -- paths that exist on disk but not in the DB
   * - `changed` -- paths that exist in both but whose sha256 or mtime differs
   * - `deleted` -- FileRecords that are in the DB but not on disk
   */
  findChanged(
    repoId: number,
    currentFiles: Array<{ path: string; sha256: string; mtime: number }>,
  ): { new: string[]; changed: string[]; deleted: FileRecord[] } {
    const stored = this.findByRepoId(repoId);
    const storedMap = new Map<string, FileRecord>();
    for (const f of stored) {
      storedMap.set(f.path, f);
    }

    const currentPaths = new Set<string>();
    const newFiles: string[] = [];
    const changedFiles: string[] = [];

    for (const cf of currentFiles) {
      currentPaths.add(cf.path);
      const existing = storedMap.get(cf.path);
      if (!existing) {
        newFiles.push(cf.path);
      } else if (existing.sha256 !== cf.sha256 || existing.mtime !== cf.mtime) {
        changedFiles.push(cf.path);
      }
    }

    const deletedFiles: FileRecord[] = [];
    for (const f of stored) {
      if (!currentPaths.has(f.path)) {
        deletedFiles.push(f);
      }
    }

    return { new: newFiles, changed: changedFiles, deleted: deletedFiles };
  }

  /** Remove a file (and cascade-delete its symbols via FK). */
  deleteByPath(repoId: number, path: string): void {
    this.stmtDeleteByPath.run(repoId, path);
  }

  /** Total number of indexed files for a repo. */
  countByRepo(repoId: number): number {
    const row = this.stmtCountByRepo.get(repoId) as { cnt: number };
    return row.cnt;
  }

  /** File counts grouped by language for a repo. */
  countByLang(repoId: number): Record<string, number> {
    const rows = this.stmtCountByLang.all(repoId) as Array<{ lang: string; cnt: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.lang] = row.cnt;
    }
    return result;
  }
}
