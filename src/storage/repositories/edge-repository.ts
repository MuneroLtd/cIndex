import type { EdgeRecord, NodeType } from '../../types.js';
import type { Database } from '../database.js';

/**
 * Repository for the `edges` table.
 */
export class EdgeRepository {
  private readonly stmtInsert;
  private readonly stmtFindBySrc;
  private readonly stmtFindByDst;
  private readonly stmtFindByRel;
  private readonly stmtDeleteByNodeSrc;
  private readonly stmtDeleteByNodeDst;
  private readonly stmtDeleteByFileSrc;
  private readonly stmtDeleteByFileDst;
  private readonly stmtDeleteBySymbolsOfFile;
  private readonly stmtCountByRepo;

  constructor(private readonly database: Database) {
    const db = this.database.db;

    this.stmtInsert = db.prepare<[number, string, number, string, string, number, string | null, number]>(`
      INSERT INTO edges (repo_id, src_type, src_id, rel, dst_type, dst_id, meta_json, weight)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    this.stmtFindBySrc = db.prepare<[number, string, number]>(`
      SELECT * FROM edges WHERE repo_id = ? AND src_type = ? AND src_id = ?
    `);

    this.stmtFindByDst = db.prepare<[number, string, number]>(`
      SELECT * FROM edges WHERE repo_id = ? AND dst_type = ? AND dst_id = ?
    `);

    this.stmtFindByRel = db.prepare<[number, string]>(`
      SELECT * FROM edges WHERE repo_id = ? AND rel = ?
    `);

    this.stmtDeleteByNodeSrc = db.prepare<[string, number]>(`
      DELETE FROM edges WHERE src_type = ? AND src_id = ?
    `);

    this.stmtDeleteByNodeDst = db.prepare<[string, number]>(`
      DELETE FROM edges WHERE dst_type = ? AND dst_id = ?
    `);

    // Edges where the file itself is src or dst
    this.stmtDeleteByFileSrc = db.prepare<[number]>(`
      DELETE FROM edges WHERE src_type = 'file' AND src_id = ?
    `);

    this.stmtDeleteByFileDst = db.prepare<[number]>(`
      DELETE FROM edges WHERE dst_type = 'file' AND dst_id = ?
    `);

    // Edges where a symbol belonging to the file is src or dst
    this.stmtDeleteBySymbolsOfFile = db.prepare<[number, number]>(`
      DELETE FROM edges
      WHERE (src_type = 'symbol' AND src_id IN (SELECT id FROM symbols WHERE file_id = ?))
         OR (dst_type = 'symbol' AND dst_id IN (SELECT id FROM symbols WHERE file_id = ?))
    `);

    this.stmtCountByRepo = db.prepare<[number]>(`
      SELECT COUNT(*) AS cnt FROM edges WHERE repo_id = ?
    `);
  }

  /** Insert a new edge and return the resulting record. */
  insert(
    repoId: number,
    srcType: string,
    srcId: number,
    rel: string,
    dstType: string,
    dstId: number,
    metaJson: string | null = null,
    weight: number = 1.0,
  ): EdgeRecord {
    return this.stmtInsert.get(repoId, srcType, srcId, rel, dstType, dstId, metaJson, weight) as EdgeRecord;
  }

  /** Find all edges originating from a given node. */
  findBySrc(repoId: number, srcType: string, srcId: number): EdgeRecord[] {
    return this.stmtFindBySrc.all(repoId, srcType, srcId) as EdgeRecord[];
  }

  /** Find all edges pointing to a given node. */
  findByDst(repoId: number, dstType: string, dstId: number): EdgeRecord[] {
    return this.stmtFindByDst.all(repoId, dstType, dstId) as EdgeRecord[];
  }

  /** Find all edges of a given relationship type within a repo. */
  findByRel(repoId: number, rel: string): EdgeRecord[] {
    return this.stmtFindByRel.all(repoId, rel) as EdgeRecord[];
  }

  /** Delete every edge where the given node appears as source or destination. */
  deleteByNode(nodeType: string, nodeId: number): void {
    this.stmtDeleteByNodeSrc.run(nodeType, nodeId);
    this.stmtDeleteByNodeDst.run(nodeType, nodeId);
  }

  /**
   * Delete all edges related to a file: edges where the file is a direct
   * participant AND edges involving any symbol that belongs to the file.
   */
  deleteByFile(fileId: number): void {
    this.stmtDeleteByFileSrc.run(fileId);
    this.stmtDeleteByFileDst.run(fileId);
    this.stmtDeleteBySymbolsOfFile.run(fileId, fileId);
  }

  /** Total edge count for a repo. */
  countByRepo(repoId: number): number {
    const row = this.stmtCountByRepo.get(repoId) as { cnt: number };
    return row.cnt;
  }

  /**
   * BFS/DFS neighbour traversal from a starting node.
   *
   * @param repoId   - Restrict to edges within this repo.
   * @param nodeType - Starting node type.
   * @param nodeId   - Starting node id.
   * @param depth    - How many hops to traverse (default 1).
   * @param direction - "outgoing" follows src->dst, "incoming" follows dst->src,
   *                    "both" follows in both directions.
   * @returns Unique nodes and all traversed edges.
   */
  getNeighbours(
    repoId: number,
    nodeType: NodeType,
    nodeId: number,
    depth: number = 1,
    direction: 'outgoing' | 'incoming' | 'both' = 'both',
  ): { nodes: Array<{ type: NodeType; id: number }>; edges: EdgeRecord[] } {
    const visited = new Set<string>();
    const resultNodes: Array<{ type: NodeType; id: number }> = [];
    const resultEdges: EdgeRecord[] = [];
    const edgeIds = new Set<number>();

    // Queue entries: [nodeType, nodeId, currentDepth]
    const queue: Array<[NodeType, number, number]> = [[nodeType, nodeId, 0]];
    const nodeKey = (t: string, id: number) => `${t}:${id}`;

    visited.add(nodeKey(nodeType, nodeId));
    resultNodes.push({ type: nodeType, id: nodeId });

    while (queue.length > 0) {
      const [curType, curId, curDepth] = queue.shift()!;
      if (curDepth >= depth) continue;

      const edges: EdgeRecord[] = [];

      if (direction === 'outgoing' || direction === 'both') {
        edges.push(...this.findBySrc(repoId, curType, curId));
      }
      if (direction === 'incoming' || direction === 'both') {
        edges.push(...this.findByDst(repoId, curType, curId));
      }

      for (const edge of edges) {
        if (!edgeIds.has(edge.id)) {
          edgeIds.add(edge.id);
          resultEdges.push(edge);
        }

        // Determine the "other" end of the edge
        let otherType: NodeType;
        let otherId: number;

        if (edge.src_type === curType && edge.src_id === curId) {
          otherType = edge.dst_type;
          otherId = edge.dst_id;
        } else {
          otherType = edge.src_type;
          otherId = edge.src_id;
        }

        const key = nodeKey(otherType, otherId);
        if (!visited.has(key)) {
          visited.add(key);
          resultNodes.push({ type: otherType, id: otherId });
          queue.push([otherType, otherId, curDepth + 1]);
        }
      }
    }

    return { nodes: resultNodes, edges: resultEdges };
  }
}
