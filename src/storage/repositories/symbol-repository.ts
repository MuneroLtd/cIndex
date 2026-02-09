import type { SymbolRecord } from '../../types.js';
import type { Database } from '../database.js';

/**
 * Repository for the `symbols` table.
 */
export class SymbolRepository {
  private readonly stmtInsert;
  private readonly stmtFindByFile;
  private readonly stmtFindByName;
  private readonly stmtFindByFqName;
  private readonly stmtDeleteByFile;
  private readonly stmtCountByRepo;

  constructor(private readonly database: Database) {
    const db = this.database.db;

    this.stmtInsert = db.prepare<
      [number, number, string, string, string, string | null, number, number, number, number]
    >(`
      INSERT INTO symbols (repo_id, file_id, kind, name, fq_name, signature, start_line, start_col, end_line, end_col)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    this.stmtFindByFile = db.prepare<[number, number]>(`
      SELECT * FROM symbols WHERE repo_id = ? AND file_id = ?
    `);

    this.stmtFindByName = db.prepare<[number, string]>(`
      SELECT * FROM symbols WHERE repo_id = ? AND name = ?
    `);

    this.stmtFindByFqName = db.prepare<[number, string]>(`
      SELECT * FROM symbols WHERE repo_id = ? AND fq_name = ?
    `);

    this.stmtDeleteByFile = db.prepare<[number]>(`
      DELETE FROM symbols WHERE file_id = ?
    `);

    this.stmtCountByRepo = db.prepare<[number]>(`
      SELECT COUNT(*) AS cnt FROM symbols WHERE repo_id = ?
    `);
  }

  /** Insert a new symbol and return the resulting record. */
  insert(
    repoId: number,
    fileId: number,
    kind: string,
    name: string,
    fqName: string,
    signature: string | null,
    startLine: number,
    startCol: number,
    endLine: number,
    endCol: number,
  ): SymbolRecord {
    return this.stmtInsert.get(
      repoId,
      fileId,
      kind,
      name,
      fqName,
      signature,
      startLine,
      startCol,
      endLine,
      endCol,
    ) as SymbolRecord;
  }

  /** All symbols defined in a given file. */
  findByFile(repoId: number, fileId: number): SymbolRecord[] {
    return this.stmtFindByFile.all(repoId, fileId) as SymbolRecord[];
  }

  /** Find symbols by short name (may return multiple across files). */
  findByName(repoId: number, name: string): SymbolRecord[] {
    return this.stmtFindByName.all(repoId, name) as SymbolRecord[];
  }

  /** Find a symbol by its fully-qualified name (expected to be unique per repo). */
  findByFqName(repoId: number, fqName: string): SymbolRecord | null {
    return (this.stmtFindByFqName.get(repoId, fqName) as SymbolRecord) ?? null;
  }

  /** Remove all symbols belonging to a file (used before re-indexing a file). */
  deleteByFile(fileId: number): void {
    this.stmtDeleteByFile.run(fileId);
  }

  /** Total symbol count for a repo. */
  countByRepo(repoId: number): number {
    const row = this.stmtCountByRepo.get(repoId) as { cnt: number };
    return row.cnt;
  }
}
