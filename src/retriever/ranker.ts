import type { SymbolRecord } from '../types.js';
import { Database } from '../storage/database.js';
import { FileRepository } from '../storage/repositories/file-repository.js';
import { SymbolRepository } from '../storage/repositories/symbol-repository.js';
import type { Candidate } from './candidates.js';
import type { ExpandedNode } from './expander.js';

// ---- Exported types ----

export interface RankedFile {
  fileId: number;
  path: string;
  score: number;
  reasons: string[];
  symbols: SymbolRecord[];
}

// ---- Entry point patterns ----

/**
 * Glob-like patterns that identify "entry point" files.
 * Files matching these get a bonus score.
 */
const ENTRY_POINT_PATTERNS: RegExp[] = [
  /\/routes\//,
  /\/controllers\//,
  /\/pages\//,
  /\/app\.[^/]+$/,
  /\/main\.[^/]+$/,
  /\/index\.ts$/,
  /\/index\.tsx$/,
  /\/index\.js$/,
  /\/index\.jsx$/,
];

const ENTRY_POINT_BONUS = 3;

/**
 * Check whether a file path matches one of the known entry-point patterns.
 */
function isEntryPoint(path: string): boolean {
  return ENTRY_POINT_PATTERNS.some(pattern => pattern.test(path));
}

// ---- Main export ----

/**
 * Merge candidate scores with expansion scores, apply bonuses,
 * and produce a ranked list of files with their symbols attached.
 *
 * @param candidates - Candidates from the discovery phase.
 * @param expanded   - Expanded nodes from graph traversal.
 * @param repoId     - Repository ID.
 * @param db         - Database instance.
 * @returns Ranked files sorted by score descending.
 */
export function rankCandidates(
  candidates: Candidate[],
  expanded: ExpandedNode[],
  repoId: number,
  db: Database,
): RankedFile[] {
  const fileRepo = new FileRepository(db);
  const symbolRepo = new SymbolRepository(db);

  // Accumulator: fileId -> { score, reasons, path }
  const scoreMap = new Map<
    number,
    { score: number; reasons: string[]; path: string }
  >();

  // Build file-id-to-path lookup
  const allFiles = fileRepo.findByRepoId(repoId);
  const filePathById = new Map<number, string>();
  for (const f of allFiles) {
    filePathById.set(f.id, f.path);
  }

  // ---- Merge candidate scores ----

  for (const c of candidates) {
    const existing = scoreMap.get(c.fileId);
    const path = c.path || filePathById.get(c.fileId) || '';
    if (existing) {
      existing.score += c.score;
      existing.reasons.push(c.reason);
    } else {
      scoreMap.set(c.fileId, {
        score: c.score,
        reasons: [c.reason],
        path,
      });
    }
  }

  // ---- Merge expansion scores ----

  for (const node of expanded) {
    const fileId = node.fileId;
    const path = filePathById.get(fileId) || '';
    const existing = scoreMap.get(fileId);
    if (existing) {
      existing.score += node.score;
      existing.reasons.push(`graph-expansion depth=${node.depth}`);
    } else {
      scoreMap.set(fileId, {
        score: node.score,
        reasons: [`graph-expansion depth=${node.depth}`],
        path,
      });
    }
  }

  // ---- Apply entry-point bonus ----

  for (const [fileId, entry] of scoreMap) {
    if (isEntryPoint(entry.path)) {
      entry.score += ENTRY_POINT_BONUS;
      entry.reasons.push('entry-point-bonus');
    }
  }

  // ---- Build ranked result with symbols ----

  const ranked: RankedFile[] = [];

  for (const [fileId, entry] of scoreMap) {
    const symbols = symbolRepo.findByFile(repoId, fileId);

    ranked.push({
      fileId,
      path: entry.path,
      score: entry.score,
      reasons: entry.reasons,
      symbols,
    });
  }

  // Sort by score descending
  ranked.sort((a, b) => b.score - a.score);

  return ranked;
}
