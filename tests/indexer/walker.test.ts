import { describe, it, expect } from 'vitest';
import { walkRepo } from '../../src/indexer/walker.js';
import { resolve } from 'node:path';

const FIXTURE_REPO = resolve('fixtures/sample-repo');

describe('Walker', () => {
  it('discovers all TS/JS files in fixture repo', async () => {
    const files = await walkRepo(FIXTURE_REPO);

    // The fixture has 10 TS files and 1 JS file = 11 total
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.length).toBeLessThanOrEqual(12); // Allow some flexibility

    // Verify we have a mix of TypeScript and JavaScript
    const tsFiles = files.filter(f => f.lang === 'typescript');
    const jsFiles = files.filter(f => f.lang === 'javascript');

    expect(tsFiles.length).toBeGreaterThan(0);
    expect(jsFiles.length).toBeGreaterThan(0);
  });

  it('ignores node_modules', async () => {
    const files = await walkRepo(FIXTURE_REPO);

    // Should not include any files from node_modules
    const nodeModulesFiles = files.filter(f => f.path.includes('node_modules'));

    expect(nodeModulesFiles).toHaveLength(0);
  });

  it('respects .gitignore', async () => {
    const files = await walkRepo(FIXTURE_REPO);

    // Should not include files from common ignored directories
    const ignoredDirs = ['dist', 'build', '.next', 'coverage'];

    for (const dir of ignoredDirs) {
      const filesInDir = files.filter(f => f.path.includes(dir));
      expect(filesInDir).toHaveLength(0);
    }
  });

  it('returns correct language detection', async () => {
    const files = await walkRepo(FIXTURE_REPO);

    // Verify TypeScript files
    const tsFiles = files.filter(f => f.path.endsWith('.ts'));
    expect(tsFiles.every(f => f.lang === 'typescript')).toBe(true);

    // Verify JavaScript files
    const jsFiles = files.filter(f => f.path.endsWith('.js') || f.path.endsWith('.cjs') || f.path.endsWith('.mjs'));
    expect(jsFiles.every(f => f.lang === 'javascript')).toBe(true);
  });

  it('returns correct relative paths', async () => {
    const files = await walkRepo(FIXTURE_REPO);

    // All paths should be relative to repo root (not absolute)
    expect(files.every(f => !f.path.startsWith('/'))).toBe(true);

    // All paths should start with 'src/'
    expect(files.every(f => f.path.startsWith('src/'))).toBe(true);

    // Absolute paths should be under the fixture repo
    expect(files.every(f => f.absolutePath.startsWith(FIXTURE_REPO))).toBe(true);
  });

  it('includes expected fixture files', async () => {
    const files = await walkRepo(FIXTURE_REPO);
    const paths = files.map(f => f.path);

    // Check for key fixture files
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/types.ts');
    expect(paths).toContain('src/services/auth.ts');
    expect(paths).toContain('src/services/user.ts');
    expect(paths).toContain('src/services/index.ts');
    expect(paths).toContain('src/models/user.ts');
    expect(paths).toContain('src/models/session.ts');
    expect(paths).toContain('src/controllers/auth-controller.ts');
    expect(paths).toContain('src/utils/helpers.ts');
    expect(paths).toContain('src/legacy/old-module.js');
  });

  it('includes file metadata', async () => {
    const files = await walkRepo(FIXTURE_REPO);

    for (const file of files) {
      // Each file should have required metadata
      expect(file.path).toBeDefined();
      expect(typeof file.path).toBe('string');

      expect(file.absolutePath).toBeDefined();
      expect(typeof file.absolutePath).toBe('string');

      expect(file.lang).toBeDefined();
      expect(['typescript', 'javascript']).toContain(file.lang);

      expect(file.mtime).toBeDefined();
      expect(typeof file.mtime).toBe('number');
      expect(file.mtime).toBeGreaterThan(0);

      expect(file.size).toBeDefined();
      expect(typeof file.size).toBe('number');
      expect(file.size).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not include lock files', async () => {
    const files = await walkRepo(FIXTURE_REPO);

    const lockFiles = files.filter(f =>
      f.path.endsWith('.lock') ||
      f.path.includes('package-lock.json') ||
      f.path.includes('yarn.lock')
    );

    expect(lockFiles).toHaveLength(0);
  });

  it('does not include minified files', async () => {
    const files = await walkRepo(FIXTURE_REPO);

    const minifiedFiles = files.filter(f =>
      f.path.endsWith('.min.js') ||
      f.path.endsWith('.min.css')
    );

    expect(minifiedFiles).toHaveLength(0);
  });

  it('does not include map files', async () => {
    const files = await walkRepo(FIXTURE_REPO);

    const mapFiles = files.filter(f => f.path.endsWith('.map'));

    expect(mapFiles).toHaveLength(0);
  });

  it('handles empty directories gracefully', async () => {
    // Test with fixture repo - should not throw even if some dirs are empty
    const files = await walkRepo(FIXTURE_REPO);

    expect(files).toBeDefined();
    expect(Array.isArray(files)).toBe(true);
  });
});
