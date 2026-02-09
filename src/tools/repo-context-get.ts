import type { Database } from '../storage/database.js';
import { RepoRepository } from '../storage/repositories/repo-repository.js';
import { Retriever } from '../retriever/retriever.js';
import type { ContextBundle } from '../types.js';
import { validateRepoPath, validateBudget } from './validation.js';

/**
 * Get a context bundle of relevant code for a task.
 *
 * The context bundle includes focus items, code snippets, a subgraph,
 * and notes assembled by the retrieval pipeline.
 *
 * Returns a ContextBundle on success, or an object with an `error`
 * and `suggestion` field if the repository has not been indexed.
 */
export async function repoContextGet(
  db: Database,
  repoPath: string,
  task: string,
  budget?: number,
  hints?: { paths?: string[]; symbols?: string[]; lang?: string },
): Promise<ContextBundle | { error: string; suggestion: string }> {
  const pathResult = validateRepoPath(repoPath);
  if (!pathResult.valid) {
    throw new Error(pathResult.error);
  }

  const repoRepo = new RepoRepository(db);
  const record = repoRepo.findByPath(pathResult.absolutePath);

  if (!record) {
    return {
      error: 'Repository not indexed. Call repo_index first.',
      suggestion: 'repo_index',
    };
  }

  const effectiveBudget = validateBudget(budget);
  const retriever = new Retriever(db);

  return retriever.getContext(
    pathResult.absolutePath,
    record.id,
    task,
    effectiveBudget,
    hints,
  );
}
