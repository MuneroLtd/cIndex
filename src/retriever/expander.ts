import type { NodeType, EdgeRecord } from '../types.js';
import { Database } from '../storage/database.js';
import { EdgeRepository } from '../storage/repositories/edge-repository.js';
import { SymbolRepository } from '../storage/repositories/symbol-repository.js';

// ---- Exported types ----

export interface ExpandedNode {
  type: NodeType;
  id: number;
  /** The file this node belongs to (or IS, if type === 'file'). */
  fileId: number;
  depth: number;
  /** Score that decays with depth: depth 0 = 5, depth 1 = 3, depth 2 = 1. */
  score: number;
}

export interface ExpandedSet {
  nodes: ExpandedNode[];
  edges: EdgeRecord[];
}

// ---- Score decay table ----

const DEPTH_SCORES: Record<number, number> = {
  0: 5,
  1: 3,
  2: 1,
};

function scoreForDepth(depth: number): number {
  return DEPTH_SCORES[depth] ?? 0;
}

// ---- Main export ----

/**
 * Expand a subgraph outward from a set of seed file IDs by following
 * IMPORTS edges. Scores decay with traversal depth.
 *
 * @param db          - Database instance.
 * @param repoId      - Repository to search within.
 * @param seedFileIds - File IDs to start the expansion from.
 * @param maxDepth    - Maximum traversal depth (default 2).
 * @returns All discovered nodes and the edges traversed.
 */
export function expandGraph(
  db: Database,
  repoId: number,
  seedFileIds: number[],
  maxDepth: number = 2,
): ExpandedSet {
  const edgeRepo = new EdgeRepository(db);
  const symbolRepo = new SymbolRepository(db);

  const visitedFiles = new Set<number>();
  const resultNodes: ExpandedNode[] = [];
  const resultEdges: EdgeRecord[] = [];
  const edgeIds = new Set<number>();

  // Queue entries: [fileId, currentDepth]
  const queue: Array<[number, number]> = [];

  // Seed the queue
  for (const fileId of seedFileIds) {
    if (visitedFiles.has(fileId)) continue;
    visitedFiles.add(fileId);
    queue.push([fileId, 0]);

    resultNodes.push({
      type: 'file',
      id: fileId,
      fileId,
      depth: 0,
      score: scoreForDepth(0),
    });
  }

  // BFS expansion
  while (queue.length > 0) {
    const [currentFileId, currentDepth] = queue.shift()!;

    if (currentDepth >= maxDepth) continue;

    // Follow IMPORTS edges outward from this file
    const outEdges = edgeRepo.findBySrc(repoId, 'file', currentFileId);

    for (const edge of outEdges) {
      // Only follow IMPORTS relationships
      if (edge.rel !== 'IMPORTS') continue;

      // Collect the edge
      if (!edgeIds.has(edge.id)) {
        edgeIds.add(edge.id);
        resultEdges.push(edge);
      }

      // Determine the destination file ID
      let dstFileId: number | null = null;

      if (edge.dst_type === 'file') {
        dstFileId = edge.dst_id;
      } else if (edge.dst_type === 'symbol') {
        // Resolve the symbol to its file
        // Look up the symbol to get file_id
        const symbols = symbolRepo.findByFile(repoId, 0); // Can't query by symbol id directly
        // Use a direct DB query approach: the symbol record has file_id
        // We need to find the symbol by its id; use findByName as a fallback
        // Actually, let's query through edges: dst_id is the symbol id
        // We need to get the file_id for this symbol. The symbol repo doesn't
        // have a findById, so we look up outgoing edges from the symbol's file.
        // Instead, let's query the edge's destination more carefully.
        // Since we only care about file-level expansion, we can skip symbol
        // destinations that we can't resolve.
        dstFileId = resolveSymbolToFileId(db, repoId, edge.dst_id);
      } else if (edge.dst_type === 'module') {
        // External modules -- we don't expand into them
        continue;
      }

      if (dstFileId === null) continue;

      if (!visitedFiles.has(dstFileId)) {
        visitedFiles.add(dstFileId);
        const nextDepth = currentDepth + 1;

        resultNodes.push({
          type: 'file',
          id: dstFileId,
          fileId: dstFileId,
          depth: nextDepth,
          score: scoreForDepth(nextDepth),
        });

        queue.push([dstFileId, nextDepth]);
      }
    }

    // Also check IMPORTS edges where symbols of this file are the source
    const fileSymbols = symbolRepo.findByFile(repoId, currentFileId);
    for (const sym of fileSymbols) {
      const symOutEdges = edgeRepo.findBySrc(repoId, 'symbol', sym.id);
      for (const edge of symOutEdges) {
        if (edge.rel !== 'IMPORTS' && edge.rel !== 'REFERENCES') continue;

        if (!edgeIds.has(edge.id)) {
          edgeIds.add(edge.id);
          resultEdges.push(edge);
        }

        let dstFileId: number | null = null;
        if (edge.dst_type === 'file') {
          dstFileId = edge.dst_id;
        } else if (edge.dst_type === 'symbol') {
          dstFileId = resolveSymbolToFileId(db, repoId, edge.dst_id);
        } else {
          continue;
        }

        if (dstFileId === null) continue;

        if (!visitedFiles.has(dstFileId)) {
          visitedFiles.add(dstFileId);
          const nextDepth = currentDepth + 1;

          resultNodes.push({
            type: 'file',
            id: dstFileId,
            fileId: dstFileId,
            depth: nextDepth,
            score: scoreForDepth(nextDepth),
          });

          queue.push([dstFileId, nextDepth]);
        }
      }
    }
  }

  return { nodes: resultNodes, edges: resultEdges };
}

/**
 * Resolve a symbol ID to the file_id it belongs to.
 * Uses a direct SQL query since SymbolRepository lacks a findById method.
 */
function resolveSymbolToFileId(
  db: Database,
  _repoId: number,
  symbolId: number,
): number | null {
  try {
    const row = db.db
      .prepare('SELECT file_id FROM symbols WHERE id = ?')
      .get(symbolId) as { file_id: number } | undefined;
    return row?.file_id ?? null;
  } catch {
    return null;
  }
}
