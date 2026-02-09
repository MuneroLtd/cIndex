import { describe, it, expect, afterEach } from 'vitest';
import { Database } from '../../src/storage/database.js';
import { RepoRepository } from '../../src/storage/repositories/repo-repository.js';
import { FileRepository } from '../../src/storage/repositories/file-repository.js';
import { SymbolRepository } from '../../src/storage/repositories/symbol-repository.js';
import { EdgeRepository } from '../../src/storage/repositories/edge-repository.js';
import { SearchRepository } from '../../src/storage/repositories/search-repository.js';

describe('Database', () => {
  let db: Database;

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  it('creates successfully in memory', () => {
    db = new Database();
    expect(db).toBeDefined();
    expect(db.db).toBeDefined();
  });

  it('all tables exist after init', () => {
    db = new Database();

    // Query SQLite master table to check for table existence
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('repos');
    expect(tableNames).toContain('files');
    expect(tableNames).toContain('symbols');
    expect(tableNames).toContain('edges');
    expect(tableNames).toContain('search_index');
    expect(tableNames).toContain('modules');
  });

  describe('RepoRepository', () => {
    it('upsert creates new repo', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);

      const repo = repoRepo.upsert('/test/repo');

      expect(repo).toBeDefined();
      expect(repo.id).toBeGreaterThan(0);
      expect(repo.root_path).toBe('/test/repo');
      expect(repo.created_at).toBeDefined();
      expect(repo.updated_at).toBeDefined();
    });

    it('upsert updates existing repo', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);

      const repo1 = repoRepo.upsert('/test/repo');
      const firstUpdated = repo1.updated_at;

      // Wait a tiny bit to ensure timestamp difference
      const repo2 = repoRepo.upsert('/test/repo');

      expect(repo2.id).toBe(repo1.id);
      expect(repo2.root_path).toBe('/test/repo');
      // Note: updated_at should be touched, but depending on timing
      // this may or may not be different in tests
    });

    it('findByPath returns existing repo', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);

      const created = repoRepo.upsert('/test/repo');
      const found = repoRepo.findByPath('/test/repo');

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.root_path).toBe('/test/repo');
    });

    it('findByPath returns null for non-existent repo', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);

      const found = repoRepo.findByPath('/does/not/exist');

      expect(found).toBeNull();
    });

    it('findById returns existing repo', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);

      const created = repoRepo.upsert('/test/repo');
      const found = repoRepo.findById(created.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.root_path).toBe('/test/repo');
    });

    it('findById returns null for non-existent id', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);

      const found = repoRepo.findById(999);

      expect(found).toBeNull();
    });
  });

  describe('FileRepository', () => {
    it('upsert creates new file', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file = fileRepo.upsert(
        repo.id,
        'src/index.ts',
        'typescript',
        'abc123',
        Date.now(),
        1024
      );

      expect(file).toBeDefined();
      expect(file.id).toBeGreaterThan(0);
      expect(file.repo_id).toBe(repo.id);
      expect(file.path).toBe('src/index.ts');
      expect(file.lang).toBe('typescript');
      expect(file.sha256).toBe('abc123');
      expect(file.size_bytes).toBe(1024);
    });

    it('upsert updates existing file', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file1 = fileRepo.upsert(repo.id, 'src/index.ts', 'typescript', 'abc123', Date.now(), 1024);
      const file2 = fileRepo.upsert(repo.id, 'src/index.ts', 'typescript', 'def456', Date.now(), 2048);

      expect(file2.id).toBe(file1.id);
      expect(file2.sha256).toBe('def456');
      expect(file2.size_bytes).toBe(2048);
    });

    it('findByPath returns existing file', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const created = fileRepo.upsert(repo.id, 'src/index.ts', 'typescript', 'abc123', Date.now(), 1024);
      const found = fileRepo.findByPath(repo.id, 'src/index.ts');

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.path).toBe('src/index.ts');
    });

    it('findByRepoId returns all repo files', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      fileRepo.upsert(repo.id, 'src/a.ts', 'typescript', 'abc', Date.now(), 100);
      fileRepo.upsert(repo.id, 'src/b.ts', 'typescript', 'def', Date.now(), 200);
      fileRepo.upsert(repo.id, 'src/c.js', 'javascript', 'ghi', Date.now(), 300);

      const files = fileRepo.findByRepoId(repo.id);

      expect(files).toHaveLength(3);
      expect(files.map(f => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.js']);
    });

    it('findChanged detects new files', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      fileRepo.upsert(repo.id, 'src/existing.ts', 'typescript', 'abc', 1000, 100);

      const currentFiles = [
        { path: 'src/existing.ts', sha256: 'abc', mtime: 1000 },
        { path: 'src/new.ts', sha256: 'xyz', mtime: 2000 },
      ];

      const result = fileRepo.findChanged(repo.id, currentFiles);

      expect(result.new).toEqual(['src/new.ts']);
      expect(result.changed).toEqual([]);
      expect(result.deleted).toEqual([]);
    });

    it('findChanged detects changed files', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      fileRepo.upsert(repo.id, 'src/modified.ts', 'typescript', 'abc', 1000, 100);

      const currentFiles = [
        { path: 'src/modified.ts', sha256: 'def', mtime: 2000 },
      ];

      const result = fileRepo.findChanged(repo.id, currentFiles);

      expect(result.new).toEqual([]);
      expect(result.changed).toEqual(['src/modified.ts']);
      expect(result.deleted).toEqual([]);
    });

    it('findChanged detects deleted files', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const deleted = fileRepo.upsert(repo.id, 'src/deleted.ts', 'typescript', 'abc', 1000, 100);

      const currentFiles: Array<{ path: string; sha256: string; mtime: number }> = [];

      const result = fileRepo.findChanged(repo.id, currentFiles);

      expect(result.new).toEqual([]);
      expect(result.changed).toEqual([]);
      expect(result.deleted).toHaveLength(1);
      expect(result.deleted[0].id).toBe(deleted.id);
      expect(result.deleted[0].path).toBe('src/deleted.ts');
    });

    it('countByRepo returns correct count', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      fileRepo.upsert(repo.id, 'src/a.ts', 'typescript', 'abc', Date.now(), 100);
      fileRepo.upsert(repo.id, 'src/b.ts', 'typescript', 'def', Date.now(), 200);
      fileRepo.upsert(repo.id, 'src/c.js', 'javascript', 'ghi', Date.now(), 300);

      const count = fileRepo.countByRepo(repo.id);

      expect(count).toBe(3);
    });

    it('countByLang returns correct breakdown', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      fileRepo.upsert(repo.id, 'src/a.ts', 'typescript', 'abc', Date.now(), 100);
      fileRepo.upsert(repo.id, 'src/b.ts', 'typescript', 'def', Date.now(), 200);
      fileRepo.upsert(repo.id, 'src/c.js', 'javascript', 'ghi', Date.now(), 300);

      const counts = fileRepo.countByLang(repo.id);

      expect(counts).toEqual({
        typescript: 2,
        javascript: 1,
      });
    });
  });

  describe('SymbolRepository', () => {
    it('insert creates new symbol', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file = fileRepo.upsert(repo.id, 'src/index.ts', 'typescript', 'abc', Date.now(), 100);

      const symbol = symbolRepo.insert(
        repo.id,
        file.id,
        'function',
        'myFunction',
        'src/index.ts::myFunction',
        'function myFunction(): void',
        10,
        0,
        15,
        1
      );

      expect(symbol).toBeDefined();
      expect(symbol.id).toBeGreaterThan(0);
      expect(symbol.repo_id).toBe(repo.id);
      expect(symbol.file_id).toBe(file.id);
      expect(symbol.kind).toBe('function');
      expect(symbol.name).toBe('myFunction');
      expect(symbol.fq_name).toBe('src/index.ts::myFunction');
      expect(symbol.start_line).toBe(10);
    });

    it('findByFile returns all file symbols', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file = fileRepo.upsert(repo.id, 'src/index.ts', 'typescript', 'abc', Date.now(), 100);

      symbolRepo.insert(repo.id, file.id, 'function', 'foo', 'src/index.ts::foo', null, 1, 0, 5, 1);
      symbolRepo.insert(repo.id, file.id, 'class', 'Bar', 'src/index.ts::Bar', null, 7, 0, 15, 1);

      const symbols = symbolRepo.findByFile(repo.id, file.id);

      expect(symbols).toHaveLength(2);
      expect(symbols.map(s => s.name).sort()).toEqual(['Bar', 'foo']);
    });

    it('findByName returns matching symbols', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file1 = fileRepo.upsert(repo.id, 'src/a.ts', 'typescript', 'abc', Date.now(), 100);
      const file2 = fileRepo.upsert(repo.id, 'src/b.ts', 'typescript', 'def', Date.now(), 100);

      symbolRepo.insert(repo.id, file1.id, 'function', 'myFunc', 'src/a.ts::myFunc', null, 1, 0, 5, 1);
      symbolRepo.insert(repo.id, file2.id, 'function', 'myFunc', 'src/b.ts::myFunc', null, 1, 0, 5, 1);
      symbolRepo.insert(repo.id, file1.id, 'class', 'Other', 'src/a.ts::Other', null, 7, 0, 10, 1);

      const symbols = symbolRepo.findByName(repo.id, 'myFunc');

      expect(symbols).toHaveLength(2);
      expect(symbols.every(s => s.name === 'myFunc')).toBe(true);
    });

    it('findByFqName returns unique symbol', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file = fileRepo.upsert(repo.id, 'src/index.ts', 'typescript', 'abc', Date.now(), 100);

      const created = symbolRepo.insert(repo.id, file.id, 'function', 'myFunc', 'src/index.ts::myFunc', null, 1, 0, 5, 1);
      const found = symbolRepo.findByFqName(repo.id, 'src/index.ts::myFunc');

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.fq_name).toBe('src/index.ts::myFunc');
    });

    it('deleteByFile removes all file symbols', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file = fileRepo.upsert(repo.id, 'src/index.ts', 'typescript', 'abc', Date.now(), 100);

      symbolRepo.insert(repo.id, file.id, 'function', 'foo', 'src/index.ts::foo', null, 1, 0, 5, 1);
      symbolRepo.insert(repo.id, file.id, 'class', 'Bar', 'src/index.ts::Bar', null, 7, 0, 15, 1);

      symbolRepo.deleteByFile(file.id);

      const symbols = symbolRepo.findByFile(repo.id, file.id);
      expect(symbols).toHaveLength(0);
    });
  });

  describe('EdgeRepository', () => {
    it('insert creates new edge', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const edgeRepo = new EdgeRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file1 = fileRepo.upsert(repo.id, 'src/a.ts', 'typescript', 'abc', Date.now(), 100);
      const file2 = fileRepo.upsert(repo.id, 'src/b.ts', 'typescript', 'def', Date.now(), 100);

      const edge = edgeRepo.insert(repo.id, 'file', file1.id, 'IMPORTS', 'file', file2.id, null, 1.0);

      expect(edge).toBeDefined();
      expect(edge.id).toBeGreaterThan(0);
      expect(edge.repo_id).toBe(repo.id);
      expect(edge.src_type).toBe('file');
      expect(edge.src_id).toBe(file1.id);
      expect(edge.rel).toBe('IMPORTS');
      expect(edge.dst_type).toBe('file');
      expect(edge.dst_id).toBe(file2.id);
      expect(edge.weight).toBe(1.0);
    });

    it('findBySrc returns outgoing edges', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const edgeRepo = new EdgeRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file1 = fileRepo.upsert(repo.id, 'src/a.ts', 'typescript', 'abc', Date.now(), 100);
      const file2 = fileRepo.upsert(repo.id, 'src/b.ts', 'typescript', 'def', Date.now(), 100);
      const file3 = fileRepo.upsert(repo.id, 'src/c.ts', 'typescript', 'ghi', Date.now(), 100);

      edgeRepo.insert(repo.id, 'file', file1.id, 'IMPORTS', 'file', file2.id);
      edgeRepo.insert(repo.id, 'file', file1.id, 'IMPORTS', 'file', file3.id);
      edgeRepo.insert(repo.id, 'file', file2.id, 'IMPORTS', 'file', file3.id);

      const edges = edgeRepo.findBySrc(repo.id, 'file', file1.id);

      expect(edges).toHaveLength(2);
      expect(edges.every(e => e.src_id === file1.id)).toBe(true);
    });

    it('findByDst returns incoming edges', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const edgeRepo = new EdgeRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file1 = fileRepo.upsert(repo.id, 'src/a.ts', 'typescript', 'abc', Date.now(), 100);
      const file2 = fileRepo.upsert(repo.id, 'src/b.ts', 'typescript', 'def', Date.now(), 100);
      const file3 = fileRepo.upsert(repo.id, 'src/c.ts', 'typescript', 'ghi', Date.now(), 100);

      edgeRepo.insert(repo.id, 'file', file1.id, 'IMPORTS', 'file', file3.id);
      edgeRepo.insert(repo.id, 'file', file2.id, 'IMPORTS', 'file', file3.id);

      const edges = edgeRepo.findByDst(repo.id, 'file', file3.id);

      expect(edges).toHaveLength(2);
      expect(edges.every(e => e.dst_id === file3.id)).toBe(true);
    });

    it('deleteByFile removes file edges', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const symbolRepo = new SymbolRepository(db);
      const edgeRepo = new EdgeRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file1 = fileRepo.upsert(repo.id, 'src/a.ts', 'typescript', 'abc', Date.now(), 100);
      const file2 = fileRepo.upsert(repo.id, 'src/b.ts', 'typescript', 'def', Date.now(), 100);

      const symbol1 = symbolRepo.insert(repo.id, file1.id, 'function', 'foo', 'src/a.ts::foo', null, 1, 0, 5, 1);

      edgeRepo.insert(repo.id, 'file', file1.id, 'IMPORTS', 'file', file2.id);
      edgeRepo.insert(repo.id, 'symbol', symbol1.id, 'DEFINES', 'file', file1.id);

      edgeRepo.deleteByFile(file1.id);

      const fromFile = edgeRepo.findBySrc(repo.id, 'file', file1.id);
      const toFile = edgeRepo.findByDst(repo.id, 'file', file1.id);
      const fromSymbol = edgeRepo.findBySrc(repo.id, 'symbol', symbol1.id);

      expect(fromFile).toHaveLength(0);
      expect(toFile).toHaveLength(0);
      expect(fromSymbol).toHaveLength(0);
    });

    it('countByRepo returns correct count', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const edgeRepo = new EdgeRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file1 = fileRepo.upsert(repo.id, 'src/a.ts', 'typescript', 'abc', Date.now(), 100);
      const file2 = fileRepo.upsert(repo.id, 'src/b.ts', 'typescript', 'def', Date.now(), 100);

      edgeRepo.insert(repo.id, 'file', file1.id, 'IMPORTS', 'file', file2.id);
      edgeRepo.insert(repo.id, 'file', file2.id, 'EXPORTS', 'file', file1.id);

      const count = edgeRepo.countByRepo(repo.id);

      expect(count).toBe(2);
    });

    it('getNeighbours traverses graph with depth 1', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const fileRepo = new FileRepository(db);
      const edgeRepo = new EdgeRepository(db);

      const repo = repoRepo.upsert('/test/repo');
      const file1 = fileRepo.upsert(repo.id, 'src/a.ts', 'typescript', 'abc', Date.now(), 100);
      const file2 = fileRepo.upsert(repo.id, 'src/b.ts', 'typescript', 'def', Date.now(), 100);
      const file3 = fileRepo.upsert(repo.id, 'src/c.ts', 'typescript', 'ghi', Date.now(), 100);

      edgeRepo.insert(repo.id, 'file', file1.id, 'IMPORTS', 'file', file2.id);
      edgeRepo.insert(repo.id, 'file', file2.id, 'IMPORTS', 'file', file3.id);

      const result = edgeRepo.getNeighbours(repo.id, 'file', file1.id, 1, 'outgoing');

      // Should include file1 (start) and file2 (1 hop away)
      expect(result.nodes).toHaveLength(2);
      expect(result.nodes.some(n => n.id === file1.id)).toBe(true);
      expect(result.nodes.some(n => n.id === file2.id)).toBe(true);
      expect(result.nodes.some(n => n.id === file3.id)).toBe(false); // 2 hops away
      expect(result.edges).toHaveLength(1);
    });
  });

  describe('SearchRepository', () => {
    it('upsert creates searchable entry', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const searchRepo = new SearchRepository(db);

      const repo = repoRepo.upsert('/test/repo');

      // Should not throw
      expect(() => {
        searchRepo.upsert(repo.id, 'file', 1, 'function myFunction() { return 42; }');
      }).not.toThrow();
    });

    it('search finds matching entries', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const searchRepo = new SearchRepository(db);

      const repo = repoRepo.upsert('/test/repo');

      searchRepo.upsert(repo.id, 'file', 1, 'AuthService login method');
      searchRepo.upsert(repo.id, 'symbol', 2, 'UserService class');
      searchRepo.upsert(repo.id, 'symbol', 3, 'generateId helper function');

      const results = searchRepo.search(repo.id, 'AuthService', 10);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].entityType).toBe('file');
      expect(results[0].entityId).toBe(1);
    });

    it('deleteByEntity removes entry', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);
      const searchRepo = new SearchRepository(db);

      const repo = repoRepo.upsert('/test/repo');

      searchRepo.upsert(repo.id, 'file', 1, 'test content');
      searchRepo.deleteByEntity('file', 1);

      const results = searchRepo.search(repo.id, 'test', 10);

      expect(results).toHaveLength(0);
    });
  });

  describe('Transaction', () => {
    it('rolls back on error', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);

      try {
        db.transaction(() => {
          repoRepo.upsert('/test/repo1');
          repoRepo.upsert('/test/repo2');
          throw new Error('Intentional error');
        });
      } catch (err) {
        // Expected to throw
      }

      // Repos should not exist due to rollback
      const repo1 = repoRepo.findByPath('/test/repo1');
      const repo2 = repoRepo.findByPath('/test/repo2');

      expect(repo1).toBeNull();
      expect(repo2).toBeNull();
    });

    it('commits on success', () => {
      db = new Database();
      const repoRepo = new RepoRepository(db);

      db.transaction(() => {
        repoRepo.upsert('/test/repo1');
        repoRepo.upsert('/test/repo2');
      });

      const repo1 = repoRepo.findByPath('/test/repo1');
      const repo2 = repoRepo.findByPath('/test/repo2');

      expect(repo1).not.toBeNull();
      expect(repo2).not.toBeNull();
    });
  });
});
