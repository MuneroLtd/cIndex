import type { Database } from '../database.js';

/** A single search result row. */
export interface SearchResult {
  entityType: string;
  entityId: number;
  text: string;
  rank: number;
}

/**
 * Repository for the FTS5 `search_index` virtual table.
 */
export class SearchRepository {
  private readonly stmtDelete;
  private readonly stmtDeleteByRepo;
  private readonly stmtSearch;

  constructor(private readonly database: Database) {
    const db = this.database.db;

    // FTS5 tables do not support UPSERT, so we delete-then-insert.
    this.stmtDelete = db.prepare<[string, number]>(`
      DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?
    `);

    this.stmtDeleteByRepo = db.prepare<[number]>(`
      DELETE FROM search_index WHERE repo_id = ?
    `);

    // FTS5 MATCH with bm25() ranking. Lower rank = better match.
    this.stmtSearch = db.prepare<[number, string, number]>(`
      SELECT
        entity_type AS entityType,
        entity_id   AS entityId,
        text,
        rank
      FROM search_index
      WHERE repo_id = ? AND search_index MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
  }

  /**
   * Insert or replace a searchable text entry for a given entity.
   * Because FTS5 has no native upsert we delete first then insert.
   */
  upsert(repoId: number, entityType: string, entityId: number, text: string): void {
    const db = this.database.db;
    this.stmtDelete.run(entityType, entityId);
    db.prepare(`
      INSERT INTO search_index (repo_id, entity_type, entity_id, text)
      VALUES (?, ?, ?, ?)
    `).run(repoId, entityType, entityId, text);
  }

  /** Remove the search entry for a specific entity. */
  deleteByEntity(entityType: string, entityId: number): void {
    this.stmtDelete.run(entityType, entityId);
  }

  /** Remove all search entries for a repo (used when re-indexing from scratch). */
  deleteByRepo(repoId: number): void {
    this.stmtDeleteByRepo.run(repoId);
  }

  /**
   * Full-text search within a repo.
   *
   * @param repoId - Restrict results to this repo.
   * @param query  - FTS5 query string (supports AND, OR, NOT, prefix*).
   * @param limit  - Maximum results (default 20).
   * @returns Matching entries ordered by relevance (best first).
   */
  search(repoId: number, query: string, limit: number = 20): SearchResult[] {
    return this.stmtSearch.all(repoId, query, limit) as SearchResult[];
  }
}
