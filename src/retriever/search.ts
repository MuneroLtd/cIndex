import { Database } from '../storage/database.js';
import { SearchRepository } from '../storage/repositories/search-repository.js';
import type { SearchResult } from '../storage/repositories/search-repository.js';

export type { SearchResult };

/**
 * FTS5 special characters that can cause query parse errors.
 * We need to handle these to prevent malformed queries.
 */
const FTS5_SPECIAL_CHARS = /[*"():^{}~\-+<>|@#\\]/g;

/**
 * Sanitize a user-provided query string for safe use with SQLite FTS5.
 *
 * Strategy:
 *  1. Strip characters that are FTS5 operators/syntax.
 *  2. Split into individual terms.
 *  3. Wrap each term in double-quotes so FTS5 treats them as literal tokens.
 *  4. Join with spaces (implicit AND in FTS5).
 *
 * Returns an empty string if the input contains no usable terms.
 */
export function sanitizeFtsQuery(query: string): string {
  // Strip FTS5 special characters
  const stripped = query.replace(FTS5_SPECIAL_CHARS, ' ');

  // Split into terms, filter empties
  const terms = stripped
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 0);

  if (terms.length === 0) {
    return '';
  }

  // Wrap each term in double-quotes for literal matching, join with OR
  return terms.map(t => `"${t}"`).join(' OR ');
}

/**
 * Perform a full-text search against the repo's search index.
 *
 * Sanitizes the query for FTS5 safety and handles query errors
 * gracefully by returning an empty result set.
 *
 * @param db     - Database instance.
 * @param repoId - Repository to search within.
 * @param query  - Raw user query string.
 * @param limit  - Maximum number of results (default 20).
 * @returns Matching search results ordered by relevance.
 */
export function textSearch(
  db: Database,
  repoId: number,
  query: string,
  limit?: number,
): SearchResult[] {
  const sanitized = sanitizeFtsQuery(query);

  if (sanitized.length === 0) {
    return [];
  }

  try {
    const searchRepo = new SearchRepository(db);
    return searchRepo.search(repoId, sanitized, limit ?? 20);
  } catch {
    // FTS5 query errors (malformed MATCH expressions, etc.) -- fail gracefully
    return [];
  }
}
