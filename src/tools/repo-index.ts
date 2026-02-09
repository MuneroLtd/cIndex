import type { Database } from '../storage/database.js';
import { RepoRepository } from '../storage/repositories/repo-repository.js';
import { Indexer } from '../indexer/indexer.js';
import type { IndexMode, IndexLevel, IndexSummary } from '../types.js';
import { validateRepoPath } from './validation.js';

/**
 * Index a repository to build the code graph.
 *
 * If `mode` is not specified, it defaults to 'incremental' when the repo
 * has been previously indexed, or 'full' for a first-time index.
 *
 * @param db       - The Database instance.
 * @param repoPath - Path to the repository root.
 * @param mode     - 'full' or 'incremental'. Auto-detected if omitted.
 * @param level    - Index depth (0 = structure, 1 = detail). Defaults to 0.
 * @returns Summary statistics of the indexing run.
 */
export async function repoIndex(
  db: Database,
  repoPath: string,
  mode?: string,
  level?: number,
): Promise<IndexSummary> {
  const pathResult = validateRepoPath(repoPath);
  if (!pathResult.valid) {
    throw new Error(pathResult.error);
  }

  // Determine mode: auto-detect based on whether repo is already indexed
  let effectiveMode: IndexMode;
  if (mode === 'full' || mode === 'incremental') {
    effectiveMode = mode;
  } else {
    const repoRepo = new RepoRepository(db);
    const existing = repoRepo.findByPath(pathResult.absolutePath);
    effectiveMode = existing ? 'incremental' : 'full';
  }

  // Default level to 0
  const effectiveLevel: IndexLevel = (level === 1 ? 1 : 0);

  const indexer = new Indexer(db);
  return indexer.indexRepo(pathResult.absolutePath, effectiveMode, effectiveLevel);
}
