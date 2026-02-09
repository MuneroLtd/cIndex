import type { Database } from '../storage/database.js';
import { RepoRepository } from '../storage/repositories/repo-repository.js';
import { FileRepository } from '../storage/repositories/file-repository.js';
import { SymbolRepository } from '../storage/repositories/symbol-repository.js';
import { EdgeRepository } from '../storage/repositories/edge-repository.js';
import type { RepoStatus } from '../types.js';
import { validateRepoPath } from './validation.js';

/**
 * Get the indexing status of a repository.
 *
 * Returns `{ status: 'not_indexed' }` if the repo has never been indexed,
 * or a full status object with file/symbol/edge counts if it has.
 */
export async function repoStatus(
  db: Database,
  repoPath: string,
): Promise<RepoStatus> {
  const pathResult = validateRepoPath(repoPath);
  if (!pathResult.valid) {
    throw new Error(pathResult.error);
  }

  const repoRepo = new RepoRepository(db);
  const record = repoRepo.findByPath(pathResult.absolutePath);

  if (!record) {
    return { status: 'not_indexed' };
  }

  const fileRepo = new FileRepository(db);
  const symbolRepo = new SymbolRepository(db);
  const edgeRepo = new EdgeRepository(db);

  const totalFiles = fileRepo.countByRepo(record.id);
  const byLang = fileRepo.countByLang(record.id);
  const symbolCount = symbolRepo.countByRepo(record.id);
  const edgeCount = edgeRepo.countByRepo(record.id);

  return {
    status: 'indexed',
    repoId: record.id,
    rootPath: record.root_path,
    lastIndexedAt: record.updated_at,
    fileCounts: { total: totalFiles, byLang },
    symbolCount,
    edgeCount,
  };
}
