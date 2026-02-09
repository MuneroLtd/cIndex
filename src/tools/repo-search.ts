import type { Database } from '../storage/database.js';
import { RepoRepository } from '../storage/repositories/repo-repository.js';
import { FileRepository } from '../storage/repositories/file-repository.js';
import { SearchRepository } from '../storage/repositories/search-repository.js';
import type { SearchResult } from '../storage/repositories/search-repository.js';
import type { SymbolRecord, FileRecord } from '../types.js';
import { validateRepoPath, validateLimit } from './validation.js';

/** Shape of enriched search results returned to the caller. */
export interface SearchResultItem {
  type: string;
  path: string;
  name?: string;
  line?: number;
  excerpt: string;
  score: number;
}

/**
 * Search the indexed codebase for files and symbols matching a query.
 *
 * Uses the FTS5 search index for full-text matching. Each result is
 * enriched with the file path and, for symbols, the name and line number.
 */
export async function repoSearch(
  db: Database,
  repoPath: string,
  query: string,
  limit?: number,
): Promise<{ results: SearchResultItem[] }> {
  const pathResult = validateRepoPath(repoPath);
  if (!pathResult.valid) {
    throw new Error(pathResult.error);
  }

  const repoRepo = new RepoRepository(db);
  const record = repoRepo.findByPath(pathResult.absolutePath);
  if (!record) {
    throw new Error(
      'Repository not indexed. Call repo_index first.',
    );
  }

  const effectiveLimit = validateLimit(limit);
  const searchRepo = new SearchRepository(db);

  // Sanitize the query for FTS5: wrap tokens in double quotes to avoid
  // syntax errors from special characters, then join with spaces (implicit AND).
  const sanitized = sanitizeFtsQuery(query);

  let rawResults: SearchResult[];
  try {
    rawResults = searchRepo.search(record.id, sanitized, effectiveLimit);
  } catch {
    // If sanitized query still fails (edge case), try a prefix search
    // on the first token as a fallback.
    const fallback = query.trim().split(/\s+/)[0];
    if (!fallback) {
      return { results: [] };
    }
    try {
      rawResults = searchRepo.search(record.id, `"${fallback}"*`, effectiveLimit);
    } catch {
      return { results: [] };
    }
  }

  // Enrich results
  const fileRepo = new FileRepository(db);
  const results: SearchResultItem[] = [];

  // Prepare a statement for looking up symbols by ID (not exposed by SymbolRepository)
  const symbolStmt = db.db.prepare<[number]>(
    'SELECT * FROM symbols WHERE id = ?',
  );

  for (const raw of rawResults) {
    if (raw.entityType === 'file') {
      const file = findFileById(db, record.id, raw.entityId);
      results.push({
        type: 'file',
        path: file?.path ?? `file:${raw.entityId}`,
        excerpt: raw.text,
        score: raw.rank,
      });
    } else if (raw.entityType === 'symbol') {
      const symbol = symbolStmt.get(raw.entityId) as SymbolRecord | undefined;
      if (symbol) {
        const file = findFileById(db, record.id, symbol.file_id);
        results.push({
          type: 'symbol',
          path: file?.path ?? `file:${symbol.file_id}`,
          name: symbol.name,
          line: symbol.start_line,
          excerpt: raw.text,
          score: raw.rank,
        });
      } else {
        results.push({
          type: 'symbol',
          path: 'unknown',
          excerpt: raw.text,
          score: raw.rank,
        });
      }
    }
  }

  return { results };
}

/**
 * Look up a file record by its primary key ID.
 *
 * FileRepository does not expose findById, so we use a direct query.
 */
function findFileById(
  db: Database,
  _repoId: number,
  fileId: number,
): FileRecord | null {
  const stmt = db.db.prepare<[number]>('SELECT * FROM files WHERE id = ?');
  return (stmt.get(fileId) as FileRecord) ?? null;
}

/**
 * Sanitize a user-provided query for FTS5.
 *
 * FTS5 has its own query syntax. We wrap each token in double quotes
 * to treat special characters as literals. Tokens joined by spaces
 * form an implicit AND query.
 */
function sanitizeFtsQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}
