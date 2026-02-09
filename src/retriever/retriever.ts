import type {
  ContextBundle,
  FocusItem,
  Snippet,
  Subgraph,
  SubgraphNode,
  SubgraphEdge,
  EdgeRecord,
  NodeType,
} from '../types.js';
import { Database } from '../storage/database.js';
import { FileRepository } from '../storage/repositories/file-repository.js';
import { discoverCandidates } from './candidates.js';
import type { Candidate } from './candidates.js';
import { expandGraph } from './expander.js';
import { rankCandidates } from './ranker.js';
import type { RankedFile } from './ranker.js';
import { extractSnippets } from './snippets.js';

// ---- Constants ----

const DEFAULT_BUDGET = 8000;
const MAX_SEED_FILES = 5;
const MAX_FOCUS_ITEMS = 10;
const INTENT_MAX_CHARS = 100;

// ---- Main class ----

/**
 * Orchestrates the full retrieval pipeline: candidate discovery,
 * graph expansion, ranking, snippet extraction, and context assembly.
 */
export class Retriever {
  constructor(private readonly database: Database) {}

  /**
   * Build a ContextBundle for a given task against an indexed repository.
   *
   * Pipeline:
   *  1. Discover candidates from the task text and optional hints.
   *  2. Expand the graph outward from the top candidate files.
   *  3. Rank all files by merged scores.
   *  4. Extract code snippets within a token budget.
   *  5. Build focus items, subgraph, and assemble the bundle.
   *
   * @param repoRoot - Absolute path to the repository root on disk.
   * @param repoId   - Repository ID in the database.
   * @param task     - Natural-language task description.
   * @param budget   - Token budget for snippets (default 8000).
   * @param hints    - Optional hints (paths, symbols, lang).
   * @returns A fully-assembled ContextBundle.
   */
  async getContext(
    repoRoot: string,
    repoId: number,
    task: string,
    budget?: number,
    hints?: { paths?: string[]; symbols?: string[]; lang?: string },
  ): Promise<ContextBundle> {
    const effectiveBudget = budget ?? DEFAULT_BUDGET;
    const notes: string[] = [];

    // ---- 1. Discover candidates ----

    const { candidates } = discoverCandidates(
      this.database,
      repoId,
      task,
      hints,
    );

    if (candidates.length === 0) {
      notes.push('No candidates found for the given task.');
    }

    // ---- 2. Collect seed file IDs from top candidates ----

    const seedFileIds = candidates
      .slice(0, MAX_SEED_FILES)
      .map(c => c.fileId);

    // ---- 3. Expand the graph ----

    const expanded = expandGraph(this.database, repoId, seedFileIds);

    // ---- 4. Rank all candidates ----

    const rankedFiles = rankCandidates(
      candidates,
      expanded.nodes,
      repoId,
      this.database,
    );

    // ---- 5. Extract snippets ----

    const snippets: Snippet[] = extractSnippets(
      repoRoot,
      rankedFiles,
      effectiveBudget,
    );

    // ---- 6. Build focus items ----

    const focus = buildFocusItems(rankedFiles, candidates);

    // ---- 7. Build subgraph ----

    const selectedFileIds = new Set(
      rankedFiles.slice(0, MAX_FOCUS_ITEMS).map(r => r.fileId),
    );
    const subgraph = buildSubgraph(
      expanded.edges,
      selectedFileIds,
      rankedFiles,
      this.database,
      repoId,
    );

    // ---- 8. Infer intent ----

    const intent = inferIntent(task);

    // ---- 9. Estimate tokens used ----

    const usedEstimate = snippets.reduce(
      (sum, s) => sum + Math.ceil(s.text.length / 4),
      0,
    );

    // ---- 10. Assemble the ContextBundle ----

    return {
      repo: { root: repoRoot, rev: null },
      intent,
      focus,
      snippets,
      subgraph,
      notes,
      limits: {
        budget: effectiveBudget,
        used_estimate: usedEstimate,
      },
    };
  }
}

// ---- Helper functions ----

/**
 * Build focus items from the top-ranked files and their candidate reasons.
 */
function buildFocusItems(
  rankedFiles: RankedFile[],
  candidates: Candidate[],
): FocusItem[] {
  const items: FocusItem[] = [];

  // Build a map of fileId to candidate reasons
  const reasonsByFile = new Map<number, string[]>();
  for (const c of candidates) {
    const existing = reasonsByFile.get(c.fileId);
    if (existing) {
      existing.push(c.reason);
    } else {
      reasonsByFile.set(c.fileId, [c.reason]);
    }
  }

  for (const ranked of rankedFiles.slice(0, MAX_FOCUS_ITEMS)) {
    const reasons = reasonsByFile.get(ranked.fileId) ?? ranked.reasons;
    const reason = reasons.slice(0, 3).join('; ');

    items.push({
      type: 'file' as NodeType,
      id: String(ranked.fileId),
      path: ranked.path,
      reason,
    });

    // Also add top symbols within the file as focus items
    for (const sym of ranked.symbols.slice(0, 3)) {
      items.push({
        type: 'symbol' as NodeType,
        id: String(sym.id),
        path: ranked.path,
        fq_name: sym.fq_name,
        reason: `${sym.kind} in focused file`,
      });
    }
  }

  return items;
}

/**
 * Build a subgraph containing only edges between selected files.
 */
function buildSubgraph(
  allEdges: EdgeRecord[],
  selectedFileIds: Set<number>,
  rankedFiles: RankedFile[],
  db: Database,
  repoId: number,
): Subgraph {
  const nodes: SubgraphNode[] = [];
  const edges: SubgraphEdge[] = [];
  const addedNodeKeys = new Set<string>();

  // Build file path lookup from ranked files
  const filePathById = new Map<number, string>();
  for (const r of rankedFiles) {
    filePathById.set(r.fileId, r.path);
  }

  // If we don't have a path, try the DB
  const fileRepo = new FileRepository(db);

  function ensureNode(type: NodeType, id: number): string {
    const key = `${type}:${id}`;
    if (!addedNodeKeys.has(key)) {
      addedNodeKeys.add(key);
      const node: SubgraphNode = { type, id: String(id) };

      if (type === 'file') {
        let path = filePathById.get(id);
        if (!path) {
          const files = fileRepo.findByRepoId(repoId);
          const file = files.find(f => f.id === id);
          if (file) path = file.path;
        }
        if (path) node.path = path;
      }

      nodes.push(node);
    }
    return key;
  }

  // Collect symbol-to-file mapping for filtering
  const symbolToFile = new Map<number, number>();
  for (const ranked of rankedFiles) {
    for (const sym of ranked.symbols) {
      symbolToFile.set(sym.id, ranked.fileId);
    }
  }

  for (const edge of allEdges) {
    // Determine which files are involved in this edge
    let srcFileId: number | null = null;
    let dstFileId: number | null = null;

    if (edge.src_type === 'file') {
      srcFileId = edge.src_id;
    } else if (edge.src_type === 'symbol') {
      srcFileId = symbolToFile.get(edge.src_id) ?? null;
    }

    if (edge.dst_type === 'file') {
      dstFileId = edge.dst_id;
    } else if (edge.dst_type === 'symbol') {
      dstFileId = symbolToFile.get(edge.dst_id) ?? null;
    }

    // Include edge if at least one end is in the selected files
    const srcInScope =
      srcFileId !== null && selectedFileIds.has(srcFileId);
    const dstInScope =
      dstFileId !== null && selectedFileIds.has(dstFileId);

    if (srcInScope || dstInScope) {
      ensureNode(edge.src_type, edge.src_id);
      ensureNode(edge.dst_type, edge.dst_id);

      edges.push({
        src: `${edge.src_type}:${edge.src_id}`,
        rel: edge.rel,
        dst: `${edge.dst_type}:${edge.dst_id}`,
      });
    }
  }

  return { nodes, edges };
}

/**
 * Infer a brief intent string from the task text.
 * Truncates to INTENT_MAX_CHARS and cleans up.
 */
function inferIntent(task: string): string {
  const cleaned = task.trim().replace(/\s+/g, ' ');
  if (cleaned.length <= INTENT_MAX_CHARS) {
    return cleaned;
  }
  return cleaned.slice(0, INTENT_MAX_CHARS).trimEnd() + '...';
}
