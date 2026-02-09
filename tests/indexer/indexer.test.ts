import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { Database } from '../../src/storage/database.js';
import { Indexer } from '../../src/indexer/indexer.js';
import {
  RepoRepository,
  FileRepository,
  SymbolRepository,
  EdgeRepository,
  SearchRepository,
} from '../../src/storage/index.js';

const FIXTURE_REPO = resolve('fixtures/sample-repo');

describe('Indexer', () => {
  let db: Database;

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  describe('Full index', () => {
    it('produces correct file count', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      const summary = await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      // Fixture has 10 TS files + 1 JS file = 11 total
      expect(summary.filesIndexed).toBeGreaterThanOrEqual(10);
      expect(summary.filesIndexed).toBeLessThanOrEqual(12);
      expect(summary.filesSkipped).toBe(0);
      expect(summary.filesDeleted).toBe(0);
    });

    it('produces symbols', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      const summary = await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      // Should have extracted symbols (classes, functions, interfaces, etc.)
      expect(summary.symbolCount).toBeGreaterThan(20);

      // Verify some symbols exist in the database
      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      const symbolRepo = new SymbolRepository(db);
      const symbolCount = symbolRepo.countByRepo(repo!.id);
      expect(symbolCount).toBeGreaterThan(20);
    });

    it('produces edges', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      const summary = await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      // Should have created edges (imports, defines, exports, etc.)
      expect(summary.edgeCount).toBeGreaterThan(0);

      // Verify edges exist in the database
      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      const edgeRepo = new EdgeRepository(db);
      const edgeCount = edgeRepo.countByRepo(repo!.id);
      expect(edgeCount).toBeGreaterThan(0);
    });

    it('creates import edges from auth.ts to models/user.ts', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      // Find the auth.ts and user.ts files
      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      const fileRepo = new FileRepository(db);
      const authFile = fileRepo.findByPath(repo!.id, 'src/services/auth.ts');
      const userModelFile = fileRepo.findByPath(repo!.id, 'src/models/user.ts');

      expect(authFile).not.toBeNull();
      expect(userModelFile).not.toBeNull();

      // Check for import edge from auth.ts to user.ts
      const edgeRepo = new EdgeRepository(db);
      const edges = edgeRepo.findBySrc(repo!.id, 'file', authFile!.id);

      const importToUser = edges.find(e =>
        e.rel === 'IMPORTS' && e.dst_type === 'file' && e.dst_id === userModelFile!.id
      );

      expect(importToUser).toBeDefined();
    });

    it('creates import edges from auth-controller.ts', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      const fileRepo = new FileRepository(db);
      const controllerFile = fileRepo.findByPath(repo!.id, 'src/controllers/auth-controller.ts');

      expect(controllerFile).not.toBeNull();

      // Check that auth-controller.ts has some import edges
      const edgeRepo = new EdgeRepository(db);
      const edges = edgeRepo.findBySrc(repo!.id, 'file', controllerFile!.id);
      const importEdges = edges.filter(e => e.rel === 'IMPORTS' && e.dst_type === 'file');

      // Should have at least 1 import edge (could be to services/index.ts, services/auth.ts, or types.ts)
      expect(importEdges.length).toBeGreaterThan(0);
    });

    it('populates search index', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      // Search for "AuthService"
      const searchRepo = new SearchRepository(db);
      const results = searchRepo.search(repo!.id, 'AuthService', 10);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].text.toLowerCase()).toContain('authservice');
    });

    it('handles symbols with extends and implements', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      // Find UserModel which extends BaseModel
      const symbolRepo = new SymbolRepository(db);
      const userModels = symbolRepo.findByName(repo!.id, 'UserModel');

      expect(userModels.length).toBeGreaterThan(0);

      // Should have recorded the extends relationship
      const edgeRepo = new EdgeRepository(db);
      const extendsEdges = edgeRepo.findByRel(repo!.id, 'EXTENDS');

      expect(extendsEdges.length).toBeGreaterThan(0);
    });
  });

  describe('Incremental index', () => {
    it('detects no changes when nothing changed', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      // First full index
      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      // Second incremental index immediately after
      const summary = await indexer.indexRepo(FIXTURE_REPO, 'incremental', 0);

      // Should detect no changes
      expect(summary.filesIndexed).toBe(0);
      // filesSkipped is only for files that couldn't be indexed, not for unchanged files
      // When nothing changed, filesIndexed + filesSkipped + filesDeleted should be 0
      expect(summary.filesSkipped).toBe(0);
      expect(summary.filesDeleted).toBe(0);
    });

    it('preserves existing data on incremental update', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      // Full index
      const fullSummary = await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      // Incremental index
      const incSummary = await indexer.indexRepo(FIXTURE_REPO, 'incremental', 0);

      // Data should remain consistent
      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      const fileRepo = new FileRepository(db);
      const fileCount = fileRepo.countByRepo(repo!.id);

      // File count should match the initial indexing
      expect(fileCount).toBe(fullSummary.filesIndexed);
    });
  });

  describe('Symbol extraction', () => {
    it('extracts AuthService class', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      const symbolRepo = new SymbolRepository(db);
      const authServices = symbolRepo.findByName(repo!.id, 'AuthService');

      expect(authServices.length).toBeGreaterThan(0);
      expect(authServices[0].kind).toBe('class');
      expect(authServices[0].name).toBe('AuthService');
    });

    it('extracts UserService class', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      const symbolRepo = new SymbolRepository(db);
      const userServices = symbolRepo.findByName(repo!.id, 'UserService');

      expect(userServices.length).toBeGreaterThan(0);
      expect(userServices[0].kind).toBe('class');
    });

    it('extracts interface declarations', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      const symbolRepo = new SymbolRepository(db);
      const symbols = db.db
        .prepare('SELECT * FROM symbols WHERE repo_id = ? AND kind = ?')
        .all(repo!.id, 'interface') as any[];

      // Should have at least User, LoginRequest, LoginResponse, Session
      expect(symbols.length).toBeGreaterThanOrEqual(3);
    });

    it('extracts function declarations', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      // Find generateId helper function
      const symbolRepo = new SymbolRepository(db);
      const generateIds = symbolRepo.findByName(repo!.id, 'generateId');

      expect(generateIds.length).toBeGreaterThan(0);
      expect(generateIds[0].kind).toBe('function');
    });

    it('extracts variable/constant declarations', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      // Should find constants like APP_NAME, MAX_SESSION_AGE
      const symbolRepo = new SymbolRepository(db);
      const appNames = symbolRepo.findByName(repo!.id, 'APP_NAME');

      expect(appNames.length).toBeGreaterThan(0);
      expect(appNames[0].kind).toBe('variable');
    });
  });

  describe('JavaScript support', () => {
    it('indexes CommonJS file', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      const fileRepo = new FileRepository(db);
      const legacyFile = fileRepo.findByPath(repo!.id, 'src/legacy/old-module.js');

      expect(legacyFile).not.toBeNull();
      expect(legacyFile?.lang).toBe('javascript');

      // Should have extracted symbols from the JS file
      const symbolRepo = new SymbolRepository(db);
      const symbols = symbolRepo.findByFile(repo!.id, legacyFile!.id);

      expect(symbols.length).toBeGreaterThan(0);
      expect(symbols.some(s => s.name === 'legacyLogin' || s.name === 'legacyLogout')).toBe(true);
    });

    it('extracts require() imports', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      const fileRepo = new FileRepository(db);
      const legacyFile = fileRepo.findByPath(repo!.id, 'src/legacy/old-module.js');
      const helpersFile = fileRepo.findByPath(repo!.id, 'src/utils/helpers.ts');

      expect(legacyFile).not.toBeNull();
      expect(helpersFile).not.toBeNull();

      // Check for import edge from legacy file to helpers
      const edgeRepo = new EdgeRepository(db);
      const edges = edgeRepo.findBySrc(repo!.id, 'file', legacyFile!.id);

      const importToHelpers = edges.find(e =>
        e.rel === 'IMPORTS' && e.dst_type === 'file' && e.dst_id === helpersFile!.id
      );

      expect(importToHelpers).toBeDefined();
    });
  });

  describe('Language breakdown', () => {
    it('reports correct language counts', async () => {
      db = new Database();
      const indexer = new Indexer(db);

      await indexer.indexRepo(FIXTURE_REPO, 'full', 0);

      const repoRepo = new RepoRepository(db);
      const repo = repoRepo.findByPath(FIXTURE_REPO);
      expect(repo).not.toBeNull();

      const fileRepo = new FileRepository(db);
      const byLang = fileRepo.countByLang(repo!.id);

      expect(byLang.typescript).toBeGreaterThan(0);
      expect(byLang.javascript).toBeGreaterThan(0);
      expect(byLang.typescript).toBeGreaterThan(byLang.javascript); // More TS than JS in fixture
    });
  });
});
