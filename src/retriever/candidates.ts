import type { NodeType, FileRecord, SymbolRecord } from '../types.js';
import { Database } from '../storage/database.js';
import { FileRepository } from '../storage/repositories/file-repository.js';
import { SymbolRepository } from '../storage/repositories/symbol-repository.js';
import { textSearch } from './search.js';

// ---- Exported types ----

export interface Candidate {
  type: NodeType;
  id: number;
  fileId: number;
  path: string;
  score: number;
  reason: string;
}

export interface CandidateSet {
  candidates: Candidate[];
}

// ---- Stopwords for text search ----

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'this', 'that',
  'with', 'they', 'from', 'will', 'what', 'when', 'make', 'like', 'time',
  'just', 'know', 'take', 'come', 'could', 'than', 'look', 'only', 'into',
  'over', 'such', 'also', 'some', 'more', 'very', 'does', 'then', 'them',
  'would', 'about', 'which', 'there', 'their', 'should', 'each', 'file',
  'code', 'function', 'import', 'export', 'const', 'class', 'type', 'interface',
  'return', 'async', 'await', 'void', 'null', 'undefined', 'true', 'false',
  'need', 'want', 'find', 'show', 'help', 'using', 'where', 'how',
]);

// ---- Regex patterns ----

/** Matches path-like strings containing / and a .ts/.js/.tsx/.jsx extension. */
const PATH_PATTERN = /(?:[\w./-]+\/[\w./-]*\.(?:ts|js|tsx|jsx)\b)/g;

/** Matches CamelCase words (at least 2 uppercase transitions). */
const CAMEL_CASE_PATTERN = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;

// ---- Helper functions ----

/**
 * Extract significant words from text for full-text search.
 * Filters out stopwords, short words, and noise.
 */
function extractSignificantWords(text: string): string[] {
  const words = text
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 3 && !STOPWORDS.has(w));

  // Deduplicate
  return [...new Set(words)];
}

/**
 * Create a file-level candidate from a FileRecord.
 */
function fileCandidateFromRecord(
  file: FileRecord,
  score: number,
  reason: string,
): Candidate {
  return {
    type: 'file' as NodeType,
    id: file.id,
    fileId: file.id,
    path: file.path,
    score,
    reason,
  };
}

/**
 * Create a candidate from a SymbolRecord, mapping it to its file.
 */
function symbolCandidate(
  symbol: SymbolRecord,
  filePath: string,
  score: number,
  reason: string,
): Candidate {
  return {
    type: 'symbol' as NodeType,
    id: symbol.id,
    fileId: symbol.file_id,
    path: filePath,
    score,
    reason,
  };
}

// ---- Main export ----

/**
 * Discover candidate files and symbols relevant to a given task description.
 *
 * Uses multiple strategies (hints, path extraction, symbol extraction,
 * full-text search) and deduplicates by file_id, keeping the highest score.
 *
 * @param db     - Database instance.
 * @param repoId - Repository to search within.
 * @param task   - Natural-language task description.
 * @param hints  - Optional hints: explicit paths, symbol names, language filter.
 * @returns A CandidateSet of deduplicated candidates sorted by score.
 */
export function discoverCandidates(
  db: Database,
  repoId: number,
  task: string,
  hints?: { paths?: string[]; symbols?: string[]; lang?: string },
): CandidateSet {
  const fileRepo = new FileRepository(db);
  const symbolRepo = new SymbolRepository(db);
  const raw: Candidate[] = [];

  // Build a path-to-file cache for resolving symbols to file paths
  const allFiles = fileRepo.findByRepoId(repoId);
  const fileById = new Map<number, FileRecord>();
  for (const f of allFiles) {
    fileById.set(f.id, f);
  }

  // ---- 1. Hints processing ----

  if (hints?.paths) {
    for (const hintPath of hints.paths) {
      const file = fileRepo.findByPath(repoId, hintPath);
      if (file) {
        raw.push(fileCandidateFromRecord(file, 10, `hint:path "${hintPath}"`));
      }
    }
  }

  if (hints?.symbols) {
    for (const hintSym of hints.symbols) {
      const matches = symbolRepo.findByName(repoId, hintSym);
      for (const sym of matches) {
        const file = fileById.get(sym.file_id);
        if (file) {
          raw.push(symbolCandidate(sym, file.path, 10, `hint:symbol "${hintSym}"`));
        }
      }
    }
  }

  // ---- 2. Path extraction from task text ----

  const pathMatches = task.match(PATH_PATTERN);
  if (pathMatches) {
    for (const pathStr of pathMatches) {
      // Try exact match first
      let file = fileRepo.findByPath(repoId, pathStr);
      if (!file) {
        // Try without leading ./
        const cleaned = pathStr.replace(/^\.\//, '');
        file = fileRepo.findByPath(repoId, cleaned);
      }
      if (file) {
        raw.push(fileCandidateFromRecord(file, 8, `path-in-task "${pathStr}"`));
      }
    }
  }

  // ---- 3. Symbol extraction (CamelCase words) ----

  const camelMatches = task.match(CAMEL_CASE_PATTERN);
  if (camelMatches) {
    const seen = new Set<string>();
    for (const name of camelMatches) {
      if (seen.has(name)) continue;
      seen.add(name);

      const symbols = symbolRepo.findByName(repoId, name);
      for (const sym of symbols) {
        const file = fileById.get(sym.file_id);
        if (file) {
          raw.push(symbolCandidate(sym, file.path, 6, `camelcase-match "${name}"`));
        }
      }
    }
  }

  // ---- 4. Text search via FTS5 ----

  const significantWords = extractSignificantWords(task);
  if (significantWords.length > 0) {
    const searchQuery = significantWords.join(' ');
    const results = textSearch(db, repoId, searchQuery, 20);

    for (const result of results) {
      // Map the search result back to a file
      if (result.entityType === 'file') {
        const file = fileById.get(result.entityId);
        if (file) {
          // FTS5 rank is negative (more negative = better); normalise to positive score
          const ftsScore = Math.max(1, Math.min(5, 3 + result.rank));
          raw.push(fileCandidateFromRecord(file, ftsScore, `fts-match`));
        }
      } else if (result.entityType === 'symbol') {
        // Find which file this symbol belongs to
        const allSyms = symbolRepo.findByName(repoId, result.text.split(/\s+/)[0] ?? '');
        for (const sym of allSyms) {
          if (sym.id === result.entityId) {
            const file = fileById.get(sym.file_id);
            if (file) {
              const ftsScore = Math.max(1, Math.min(5, 3 + result.rank));
              raw.push(symbolCandidate(sym, file.path, ftsScore, `fts-match`));
            }
            break;
          }
        }
      }
    }
  }

  // ---- 5. Deduplicate by fileId, keep highest score ----

  const deduped = new Map<number, Candidate>();
  for (const c of raw) {
    const existing = deduped.get(c.fileId);
    if (!existing || c.score > existing.score) {
      // If there is an existing entry with a different reason, merge reasons
      if (existing && c.score === existing.score) {
        c.reason = `${existing.reason}; ${c.reason}`;
      }
      deduped.set(c.fileId, c);
    }
  }

  // Sort by score descending
  const candidates = [...deduped.values()].sort((a, b) => b.score - a.score);

  return { candidates };
}
