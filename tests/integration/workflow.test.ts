import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { Database } from '../../src/storage/database.js';
import {
  repoStatus,
  repoIndex,
  repoSearch,
  repoSnippet,
  repoContextGet,
} from '../../src/tools/index.js';

const FIXTURE_REPO = resolve('fixtures/sample-repo');

describe('Integration workflow', () => {
  let db: Database;

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  it('repoStatus returns not_indexed for fresh db', async () => {
    db = new Database();

    const status = await repoStatus(db, FIXTURE_REPO);

    expect(status.status).toBe('not_indexed');
  });

  it('repoIndex(full) succeeds', async () => {
    db = new Database();

    const summary = await repoIndex(db, FIXTURE_REPO, 'full', 0);

    expect(summary).toBeDefined();
    expect(summary.mode).toBe('full');
    expect(summary.filesIndexed).toBeGreaterThan(0);
    expect(summary.symbolCount).toBeGreaterThan(0);
    expect(summary.edgeCount).toBeGreaterThan(0);
  });

  it('repoStatus returns indexed with counts after indexing', async () => {
    db = new Database();

    // Index first
    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    // Check status
    const status = await repoStatus(db, FIXTURE_REPO);

    expect(status.status).toBe('indexed');
    expect(status).toHaveProperty('repoId');
    expect(status).toHaveProperty('rootPath');
    expect(status).toHaveProperty('lastIndexedAt');
    expect(status).toHaveProperty('fileCounts');
    expect(status).toHaveProperty('symbolCount');
    expect(status).toHaveProperty('edgeCount');

    if (status.status === 'indexed') {
      expect(status.fileCounts.total).toBeGreaterThan(0);
      expect(status.symbolCount).toBeGreaterThan(0);
      expect(status.edgeCount).toBeGreaterThan(0);
      expect(status.fileCounts.byLang).toHaveProperty('typescript');
      expect(status.fileCounts.byLang).toHaveProperty('javascript');
    }
  });

  it('repoSearch finds AuthService', async () => {
    db = new Database();

    // Index first
    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    // Search
    const searchResults = await repoSearch(db, FIXTURE_REPO, 'AuthService', 10);

    expect(searchResults).toHaveProperty('results');
    expect(searchResults.results.length).toBeGreaterThan(0);

    const firstResult = searchResults.results[0];
    expect(firstResult).toHaveProperty('type');
    expect(firstResult).toHaveProperty('path');
    expect(firstResult).toHaveProperty('excerpt');
    expect(firstResult.excerpt.toLowerCase()).toContain('authservice');
  });

  it('repoSearch finds UserService', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    const searchResults = await repoSearch(db, FIXTURE_REPO, 'UserService', 10);

    expect(searchResults.results.length).toBeGreaterThan(0);
    expect(searchResults.results[0].excerpt.toLowerCase()).toContain('userservice');
  });

  it('repoSearch finds helper functions', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    const searchResults = await repoSearch(db, FIXTURE_REPO, 'generateId', 10);

    expect(searchResults.results.length).toBeGreaterThan(0);
    expect(searchResults.results.some(r => r.excerpt.toLowerCase().includes('generateid'))).toBe(true);
  });

  it('repoSearch returns empty results for non-existent query', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    const searchResults = await repoSearch(db, FIXTURE_REPO, 'NonExistentSymbolXYZ123', 10);

    expect(searchResults.results).toHaveLength(0);
  });

  it('repoSnippet returns correct code', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    const snippet = await repoSnippet(db, FIXTURE_REPO, 'src/services/auth.ts', 1, 10);

    expect(snippet).toBeDefined();
    expect(snippet.path).toBe('src/services/auth.ts');
    expect(snippet.start_line).toBe(1);
    expect(snippet.end_line).toBe(10);
    expect(snippet.text).toBeDefined();
    expect(snippet.text.length).toBeGreaterThan(0);
    expect(snippet.total_lines).toBeGreaterThan(0);

    // Should contain import statements (first lines of auth.ts)
    expect(snippet.text).toContain('import');
  });

  it('repoSnippet handles line range', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    const snippet = await repoSnippet(db, FIXTURE_REPO, 'src/services/auth.ts', 5, 15);

    expect(snippet.start_line).toBe(5);
    expect(snippet.end_line).toBe(15);
    expect(snippet.text.split('\n').length).toBeLessThanOrEqual(11); // 15 - 5 + 1 = 11 lines max
  });

  it('repoSnippet defaults to full file when no range specified', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    const snippet = await repoSnippet(db, FIXTURE_REPO, 'src/types.ts');

    expect(snippet.start_line).toBe(1);
    expect(snippet.end_line).toBe(snippet.total_lines);
    expect(snippet.text).toContain('export');
  });

  it('repoSnippet rejects path traversal', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    // Attempt path traversal
    await expect(
      repoSnippet(db, FIXTURE_REPO, '../../../etc/passwd')
    ).rejects.toThrow();
  });

  it('repoSnippet rejects absolute paths outside repo', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    await expect(
      repoSnippet(db, FIXTURE_REPO, '/etc/passwd')
    ).rejects.toThrow();
  });

  it('repoSnippet handles non-existent file', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    await expect(
      repoSnippet(db, FIXTURE_REPO, 'src/does-not-exist.ts')
    ).rejects.toThrow();
  });

  it('repoContextGet returns valid context bundle', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    const context = await repoContextGet(
      db,
      FIXTURE_REPO,
      'How does authentication work in this codebase?',
      5000
    );

    // Should not be an error response
    expect(context).not.toHaveProperty('error');

    // Should have context bundle structure
    expect(context).toHaveProperty('focus');
    expect(context).toHaveProperty('snippets');
    expect(context).toHaveProperty('subgraph');
    expect(context).toHaveProperty('notes');

    if ('focus' in context) {
      expect(Array.isArray(context.focus)).toBe(true);
      expect(Array.isArray(context.snippets)).toBe(true);
      expect(Array.isArray(context.notes)).toBe(true);
    }
  });

  it('repoContextGet with hints includes specified paths', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    const context = await repoContextGet(
      db,
      FIXTURE_REPO,
      'Explain the UserService',
      5000,
      { paths: ['src/services/user.ts'] }
    );

    expect(context).not.toHaveProperty('error');

    if ('focus' in context) {
      // Should include the hinted path
      const focusPaths = context.focus.map(f => f.path);
      expect(focusPaths.some(p => p.includes('user.ts'))).toBe(true);
    }
  });

  it('repoContextGet returns error for unindexed repo', async () => {
    db = new Database();

    // Do NOT index the repo
    const context = await repoContextGet(db, FIXTURE_REPO, 'test query', 5000);

    expect(context).toHaveProperty('error');
    expect(context).toHaveProperty('suggestion');

    if ('error' in context) {
      expect(context.error).toContain('not indexed');
      expect(context.suggestion).toBe('repo_index');
    }
  });

  it('complete workflow: status -> index -> search -> snippet -> context', async () => {
    db = new Database();

    // Step 1: Check status (should be not_indexed)
    const initialStatus = await repoStatus(db, FIXTURE_REPO);
    expect(initialStatus.status).toBe('not_indexed');

    // Step 2: Index the repo
    const indexSummary = await repoIndex(db, FIXTURE_REPO, 'full', 0);
    expect(indexSummary.filesIndexed).toBeGreaterThan(0);

    // Step 3: Check status again (should be indexed)
    const afterIndexStatus = await repoStatus(db, FIXTURE_REPO);
    expect(afterIndexStatus.status).toBe('indexed');

    // Step 4: Search for AuthService
    const searchResults = await repoSearch(db, FIXTURE_REPO, 'AuthService', 5);
    expect(searchResults.results.length).toBeGreaterThan(0);

    // Step 5: Get snippet of auth.ts
    const snippet = await repoSnippet(db, FIXTURE_REPO, 'src/services/auth.ts', 1, 30);
    expect(snippet.text).toContain('AuthService');

    // Step 6: Get context for authentication
    const context = await repoContextGet(
      db,
      FIXTURE_REPO,
      'How does authentication work?',
      5000
    );
    expect(context).not.toHaveProperty('error');
  });

  it('incremental index after full index', async () => {
    db = new Database();

    // Full index
    const fullSummary = await repoIndex(db, FIXTURE_REPO, 'full', 0);
    expect(fullSummary.mode).toBe('full');
    expect(fullSummary.filesIndexed).toBeGreaterThan(0);

    // Incremental index (nothing changed)
    const incSummary = await repoIndex(db, FIXTURE_REPO, 'incremental', 0);
    expect(incSummary.mode).toBe('incremental');
    expect(incSummary.filesIndexed).toBe(0); // No changes
    expect(incSummary.filesSkipped).toBe(0); // No files skipped (skipped is for failures, not unchanged)
  });

  it('auto-detects mode when not specified', async () => {
    db = new Database();

    // First index (should auto-detect 'full')
    const firstSummary = await repoIndex(db, FIXTURE_REPO);
    expect(firstSummary.mode).toBe('full');

    // Second index (should auto-detect 'incremental')
    const secondSummary = await repoIndex(db, FIXTURE_REPO);
    expect(secondSummary.mode).toBe('incremental');
  });

  it('search works with complex queries', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    // Multi-word query - FTS5 treats space as AND, so both words must appear
    // LoginRequest should match "login" AND "request"
    const results1 = await repoSearch(db, FIXTURE_REPO, 'LoginRequest', 10);
    expect(results1.results.length).toBeGreaterThan(0);

    // Partial match
    const results2 = await repoSearch(db, FIXTURE_REPO, 'Auth', 10);
    expect(results2.results.length).toBeGreaterThan(0);
  });

  it('handles special characters in search query', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    // Should not throw on special characters
    const results = await repoSearch(db, FIXTURE_REPO, 'function()', 10);
    expect(results).toHaveProperty('results');
    expect(Array.isArray(results.results)).toBe(true);
  });

  it('multiple searches on same database', async () => {
    db = new Database();

    await repoIndex(db, FIXTURE_REPO, 'full', 0);

    // Multiple searches should all work
    const search1 = await repoSearch(db, FIXTURE_REPO, 'AuthService', 5);
    const search2 = await repoSearch(db, FIXTURE_REPO, 'UserService', 5);
    const search3 = await repoSearch(db, FIXTURE_REPO, 'generateId', 5);

    expect(search1.results.length).toBeGreaterThan(0);
    expect(search2.results.length).toBeGreaterThan(0);
    expect(search3.results.length).toBeGreaterThan(0);
  });

  it('validates repository path', async () => {
    db = new Database();

    // Non-existent path should throw
    await expect(
      repoIndex(db, '/does/not/exist/repo', 'full', 0)
    ).rejects.toThrow();
  });

  it('handles relative paths in repo operations', async () => {
    db = new Database();

    // Use relative path (should be converted to absolute)
    const summary = await repoIndex(db, 'fixtures/sample-repo', 'full', 0);
    expect(summary.filesIndexed).toBeGreaterThan(0);

    // Search should work with relative path too
    const results = await repoSearch(db, 'fixtures/sample-repo', 'AuthService', 10);
    expect(results.results.length).toBeGreaterThan(0);
  });
});
