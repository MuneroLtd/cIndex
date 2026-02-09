import { readFileSync } from 'node:fs';

import type { Database } from '../storage/database.js';
import { validateRepoPath, validateFilePath } from './validation.js';

/** Maximum number of lines a single snippet request may return. */
const MAX_SNIPPET_LINES = 500;

/** Shape of the snippet result returned to the caller. */
export interface SnippetResult {
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  text: string;
}

/**
 * Read a code snippet from a file within the repository.
 *
 * The file is read from disk (not from the database). Path traversal
 * is prevented by validating the file path is within the repo root.
 *
 * @param db        - The Database instance (used only for consistency; not queried).
 * @param repoPath  - Absolute path to the repository root.
 * @param filePath  - Relative (to repo root) or absolute path to the file.
 * @param startLine - 1-based start line (inclusive). Defaults to 1.
 * @param endLine   - 1-based end line (inclusive). Defaults to last line or start+MAX_SNIPPET_LINES.
 */
export async function repoSnippet(
  _db: Database,
  repoPath: string,
  filePath: string,
  startLine?: number,
  endLine?: number,
): Promise<SnippetResult> {
  // Validate repo path
  const repoResult = validateRepoPath(repoPath);
  if (!repoResult.valid) {
    throw new Error(repoResult.error);
  }

  // Validate file path (with path traversal protection)
  const fileResult = validateFilePath(filePath, repoResult.absolutePath);
  if (!fileResult.valid) {
    throw new Error(fileResult.error);
  }

  // Read the file from disk
  let content: string;
  try {
    content = readFileSync(fileResult.absolutePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read file: ${msg}`);
  }

  const allLines = content.split('\n');
  const totalLines = allLines.length;

  // Resolve line range (1-based, inclusive)
  let start = startLine ?? 1;
  let end = endLine ?? totalLines;

  // Clamp to valid range
  start = Math.max(1, Math.min(start, totalLines));
  end = Math.max(start, Math.min(end, totalLines));

  // Enforce max snippet size
  if (end - start + 1 > MAX_SNIPPET_LINES) {
    end = start + MAX_SNIPPET_LINES - 1;
  }

  // Extract lines (convert from 1-based to 0-based)
  const selectedLines = allLines.slice(start - 1, end);
  const text = selectedLines.join('\n');

  // Compute the relative path for the result
  const relativePath = fileResult.absolutePath.startsWith(repoResult.absolutePath)
    ? fileResult.absolutePath.slice(repoResult.absolutePath.length).replace(/^\//, '')
    : filePath;

  return {
    path: relativePath,
    start_line: start,
    end_line: end,
    total_lines: totalLines,
    text,
  };
}
