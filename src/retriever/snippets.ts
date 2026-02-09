import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Snippet } from '../types.js';
import type { RankedFile } from './ranker.js';

// ---- Constants ----

/** Lines of context to include above/below each symbol range. */
const CONTEXT_LINES = 3;

/** Files with fewer lines than this are included whole. */
const SMALL_FILE_THRESHOLD = 60;

/** Rough token estimate: 1 token per 4 characters. */
const CHARS_PER_TOKEN = 4;

// ---- Helpers ----

interface LineRange {
  start: number; // 1-based inclusive
  end: number;   // 1-based inclusive
}

/**
 * Merge overlapping or adjacent line ranges into non-overlapping ranges.
 * Expects ranges to be 1-based inclusive.
 */
function mergeRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length === 0) return [];

  // Sort by start line
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;

    // Overlapping or adjacent (within 1 line)
    if (current.start <= last.end + 1) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }

  return merged;
}

/**
 * Compute a SHA-256 hash of a text string.
 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Estimate token count from a string (chars / 4).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---- Main export ----

/**
 * Extract code snippets from ranked files, respecting a token budget.
 *
 * For each file (in score order):
 *  - If the file is small (<60 lines), include the entire file.
 *  - If the file has symbols, extract those line ranges with context,
 *    merging overlaps.
 *  - Otherwise include the entire file.
 *  - Stop once the budget is exhausted.
 *
 * @param repoRoot    - Absolute path to the repository root.
 * @param rankedFiles - Files ranked by relevance score.
 * @param budget      - Maximum token budget for all snippets combined.
 * @returns Array of Snippet objects.
 */
export function extractSnippets(
  repoRoot: string,
  rankedFiles: RankedFile[],
  budget: number,
): Snippet[] {
  const snippets: Snippet[] = [];
  let usedTokens = 0;

  for (const ranked of rankedFiles) {
    if (usedTokens >= budget) break;

    // Read file from disk
    let content: string;
    try {
      const absolutePath = join(repoRoot, ranked.path);
      content = readFileSync(absolutePath, 'utf-8');
    } catch {
      // File unreadable (deleted, permission, etc.) -- skip
      continue;
    }

    const lines = content.split('\n');
    const totalLines = lines.length;

    if (totalLines <= SMALL_FILE_THRESHOLD || ranked.symbols.length === 0) {
      // Include whole file
      const tokens = estimateTokens(content);
      if (usedTokens + tokens > budget && snippets.length > 0) {
        // Would exceed budget and we already have some snippets -- stop
        break;
      }

      snippets.push({
        path: ranked.path,
        start: 1,
        end: totalLines,
        sha256: sha256(content),
        text: content,
      });

      usedTokens += tokens;
    } else {
      // Extract symbol ranges with context
      const ranges: LineRange[] = ranked.symbols.map(sym => ({
        start: Math.max(1, sym.start_line - CONTEXT_LINES),
        end: Math.min(totalLines, sym.end_line + CONTEXT_LINES),
      }));

      const merged = mergeRanges(ranges);

      for (const range of merged) {
        if (usedTokens >= budget) break;

        // Extract lines (1-based to 0-based index)
        const slicedLines = lines.slice(range.start - 1, range.end);
        const text = slicedLines.join('\n');
        const tokens = estimateTokens(text);

        if (usedTokens + tokens > budget && snippets.length > 0) {
          // Would exceed budget -- stop
          break;
        }

        snippets.push({
          path: ranked.path,
          start: range.start,
          end: range.end,
          sha256: sha256(text),
          text,
        });

        usedTokens += tokens;
      }
    }
  }

  return snippets;
}
