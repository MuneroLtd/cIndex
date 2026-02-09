// Node types in the repo graph
export type NodeType = "file" | "symbol" | "module";

// Edge relationship types
export type EdgeRel =
  | "IMPORTS"
  | "EXPORTS"
  | "DEFINES"
  | "REFERENCES"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "TESTS";

// Symbol kinds
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "enum"
  | "method"
  | "property"
  | "namespace";

// Language identifiers
export type Language = "typescript" | "javascript";

// Indexing modes
export type IndexMode = "full" | "incremental";
export type IndexLevel = 0 | 1;

// --- Database Records ---

export interface RepoRecord {
  id: number;
  root_path: string;
  created_at: string;
  updated_at: string;
}

export interface FileRecord {
  id: number;
  repo_id: number;
  path: string;
  lang: Language;
  sha256: string;
  mtime: number;
  size_bytes: number;
  last_indexed_at: string;
}

export interface SymbolRecord {
  id: number;
  repo_id: number;
  file_id: number;
  kind: SymbolKind;
  name: string;
  fq_name: string;
  signature: string | null;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
}

export interface ModuleRecord {
  id: number;
  repo_id: number;
  name: string;
  version: string | null;
  manifest_path: string;
}

export interface EdgeRecord {
  id: number;
  repo_id: number;
  src_type: NodeType;
  src_id: number;
  rel: EdgeRel;
  dst_type: NodeType;
  dst_id: number;
  meta_json: string | null;
  weight: number;
  created_at: string;
}

export interface SearchEntry {
  id: number;
  repo_id: number;
  entity_type: NodeType;
  entity_id: number;
  text: string;
}

// --- Parser Output ---

export interface ParsedImport {
  source: string; // the import path string
  names: string[]; // imported names (empty for side-effect/namespace)
  isDefault: boolean;
  isNamespace: boolean;
  isTypeOnly: boolean;
  isDynamic: boolean;
}

export interface ParsedExport {
  name: string;
  isDefault: boolean;
  isReExport: boolean;
  source: string | null; // non-null for re-exports
}

export interface ParsedSymbol {
  kind: SymbolKind;
  name: string;
  signature: string | null;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  extends: string | null;
  implements: string[];
}

export interface ParseResult {
  imports: ParsedImport[];
  exports: ParsedExport[];
  symbols: ParsedSymbol[];
}

// --- File Discovery ---

export interface DiscoveredFile {
  path: string; // relative to repo root
  absolutePath: string;
  lang: Language;
  mtime: number;
  size: number;
}

// --- Index Results ---

export interface IndexSummary {
  repoId: number;
  mode: IndexMode;
  level: IndexLevel;
  filesIndexed: number;
  filesSkipped: number;
  filesDeleted: number;
  symbolCount: number;
  edgeCount: number;
  durationMs: number;
  warnings: string[];
}

export interface RepoStatus {
  status: "not_indexed" | "indexed";
  repoId?: number;
  rootPath?: string;
  lastIndexedAt?: string;
  fileCounts?: { total: number; byLang: Record<string, number> };
  symbolCount?: number;
  edgeCount?: number;
}

// --- Context Bundle (spec format) ---

export interface FocusItem {
  type: NodeType;
  id: string;
  path?: string;
  fq_name?: string;
  reason: string;
}

export interface Snippet {
  path: string;
  start: number;
  end: number;
  sha256: string;
  text: string;
}

export interface SubgraphNode {
  type: NodeType;
  id: string;
  path?: string;
  name?: string;
}

export interface SubgraphEdge {
  src: string;
  rel: EdgeRel;
  dst: string;
}

export interface Subgraph {
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
}

export interface ContextBundle {
  repo: { root: string; rev: string | null };
  intent: string;
  focus: FocusItem[];
  snippets: Snippet[];
  subgraph: Subgraph;
  notes: string[];
  limits: { budget: number; used_estimate: number };
}

// --- Tool Inputs ---

export interface RepoStatusInput {
  repo_path: string;
}

export interface RepoIndexInput {
  repo_path: string;
  mode?: IndexMode;
  level?: IndexLevel;
}

export interface RepoSearchInput {
  repo_path: string;
  query: string;
  limit?: number;
}

export interface RepoSnippetInput {
  repo_path: string;
  file_path: string;
  start_line?: number;
  end_line?: number;
}

export interface RepoContextGetInput {
  repo_path: string;
  task: string;
  budget?: number;
  hints?: {
    paths?: string[];
    symbols?: string[];
    lang?: string;
  };
}
