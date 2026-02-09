import { existsSync, statSync } from 'node:fs';
import { resolve, normalize, isAbsolute } from 'node:path';

/**
 * Validate that a repository path exists and is a directory.
 * Returns the resolved absolute path on success.
 */
export function validateRepoPath(
  repoPath: string,
): { valid: true; absolutePath: string } | { valid: false; error: string } {
  const abs = isAbsolute(repoPath) ? repoPath : resolve(repoPath);
  if (!existsSync(abs)) {
    return { valid: false, error: `Path does not exist: ${abs}` };
  }
  if (!statSync(abs).isDirectory()) {
    return { valid: false, error: `Path is not a directory: ${abs}` };
  }
  return { valid: true, absolutePath: abs };
}

/**
 * Validate a file path within a repository root.
 * Ensures the path does not escape the repo root (path traversal protection).
 */
export function validateFilePath(
  filePath: string,
  repoRoot: string,
): { valid: true; absolutePath: string } | { valid: false; error: string } {
  const abs = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
  const normalized = normalize(abs);
  const normalizedRoot = normalize(repoRoot);
  if (!normalized.startsWith(normalizedRoot)) {
    return { valid: false, error: 'Path traversal detected' };
  }
  if (!existsSync(normalized)) {
    return { valid: false, error: `File not found: ${filePath}` };
  }
  return { valid: true, absolutePath: normalized };
}

/**
 * Clamp a token budget to a safe range [100, 50000], defaulting to 8000.
 */
export function validateBudget(budget?: number): number {
  if (budget === undefined) return 8000;
  return Math.max(100, Math.min(50000, Math.floor(budget)));
}

/**
 * Clamp a search result limit to [1, 100], defaulting to 20.
 */
export function validateLimit(limit?: number): number {
  if (limit === undefined) return 20;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}
