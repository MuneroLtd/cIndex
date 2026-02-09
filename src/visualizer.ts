#!/usr/bin/env tsx
/**
 * cindex graph visualizer
 *
 * Generates a self-contained HTML file with an interactive D3.js
 * force-directed graph of the indexed codebase, then opens it
 * in the default browser.
 *
 * Usage:
 *   tsx src/visualizer.ts [repo-path] [--no-open]
 *   npm run visualize -- [repo-path] [--no-open]
 */

import { Database } from './storage/database.js';
import { RepoRepository, FileRepository, SymbolRepository, EdgeRepository } from './storage/index.js';
import { resolve, join, basename, dirname } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import type { FileRecord, SymbolRecord, EdgeRecord, EdgeRel, SymbolKind } from './types.js';

// ---------------------------------------------------------------------------
// Types for the graph data structure embedded in HTML
// ---------------------------------------------------------------------------

interface GraphNode {
  id: string;
  label: string;
  group: 'file' | 'class' | 'interface' | 'enum';
  fullPath?: string;
  lang?: string;
  kind?: string;
  sizeBytes?: number;
  startLine?: number;
  endLine?: number;
  filePath?: string;
  connections: number;
}

interface GraphLink {
  source: string;
  target: string;
  rel: EdgeRel;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  stats: {
    files: number;
    symbols: number;
    edges: number;
    classes: number;
    interfaces: number;
    enums: number;
  };
  repoPath: string;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');
const filteredArgs = args.filter((a) => a !== '--no-open');
const repoPath = resolve(filteredArgs[0] ?? process.cwd());

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

// Try local .cindex/cindex.db first, then global ~/.cindex/cindex.db
import { homedir } from 'node:os';

const localDb = join(repoPath, '.cindex', 'cindex.db');
const globalDb = process.env.CINDEX_DB_PATH || join(homedir(), '.cindex', 'cindex.db');
const dbPath = existsSync(localDb) ? localDb : globalDb;
const cindexDir = join(repoPath, '.cindex');

if (!existsSync(dbPath)) {
  console.error(`No cindex database found at ${localDb} or ${globalDb}`);
  console.error(`Run repo_index to index this repository first.`);
  process.exit(1);
}

const database = new Database(dbPath);
const repos = new RepoRepository(database);
const files = new FileRepository(database);
const edges = new EdgeRepository(database);

// We need raw queries for symbols (all at once by repo_id)
const db = database.db;

// ---------------------------------------------------------------------------
// Query the repo
// ---------------------------------------------------------------------------

const repo = repos.findByPath(repoPath);
if (!repo) {
  console.error(`Repository not found for path: ${repoPath}`);
  console.error(`Run "cindex" to index this repository first.`);
  database.close();
  process.exit(1);
}

const repoId = repo.id;

console.log(`Building graph for: ${repoPath}`);

// Get all files
const allFiles: FileRecord[] = files.findByRepoId(repoId);

// Get all symbols via raw query
const allSymbols: SymbolRecord[] = db
  .prepare('SELECT * FROM symbols WHERE repo_id = ?')
  .all(repoId) as SymbolRecord[];

// Get all edges via raw query
const allEdges: EdgeRecord[] = db
  .prepare('SELECT * FROM edges WHERE repo_id = ?')
  .all(repoId) as EdgeRecord[];

console.log(`  Files: ${allFiles.length}`);
console.log(`  Symbols: ${allSymbols.length}`);
console.log(`  Edges: ${allEdges.length}`);

// ---------------------------------------------------------------------------
// Build the graph data
// ---------------------------------------------------------------------------

// Build lookup maps
const fileMap = new Map<number, FileRecord>();
for (const f of allFiles) {
  fileMap.set(f.id, f);
}

const symbolMap = new Map<number, SymbolRecord>();
for (const s of allSymbols) {
  symbolMap.set(s.id, s);
}

// Filter symbols to only class, interface, enum
const includedSymbolKinds = new Set<SymbolKind>(['class', 'interface', 'enum']);
const includedSymbols = allSymbols.filter((s) => includedSymbolKinds.has(s.kind as SymbolKind));
const includedSymbolIds = new Set(includedSymbols.map((s) => s.id));

// Build node ID sets for quick membership checks
const fileNodeIds = new Set(allFiles.map((f) => `file:${f.id}`));
const symbolNodeIds = new Set(includedSymbols.map((s) => `symbol:${s.id}`));

// Filter edges: only IMPORTS between files, EXTENDS and IMPLEMENTS between symbols
const includedEdgeRels = new Set<EdgeRel>(['IMPORTS', 'EXTENDS', 'IMPLEMENTS']);
const filteredEdges = allEdges.filter((e) => {
  if (!includedEdgeRels.has(e.rel as EdgeRel)) return false;

  if (e.rel === 'IMPORTS') {
    // Only file-to-file imports
    return e.src_type === 'file' && e.dst_type === 'file';
  }

  if (e.rel === 'EXTENDS' || e.rel === 'IMPLEMENTS') {
    // Only between included symbols
    if (e.src_type === 'symbol' && e.dst_type === 'symbol') {
      return includedSymbolIds.has(e.src_id) && includedSymbolIds.has(e.dst_id);
    }
    return false;
  }

  return false;
});

// Count connections per node
const connectionCount = new Map<string, number>();
for (const e of filteredEdges) {
  const srcKey =
    e.src_type === 'file' ? `file:${e.src_id}` : `symbol:${e.src_id}`;
  const dstKey =
    e.dst_type === 'file' ? `file:${e.dst_id}` : `symbol:${e.dst_id}`;
  connectionCount.set(srcKey, (connectionCount.get(srcKey) ?? 0) + 1);
  connectionCount.set(dstKey, (connectionCount.get(dstKey) ?? 0) + 1);
}

// Helper: short label for a file (last 2 path segments)
function shortPath(fullPath: string): string {
  const parts = fullPath.split('/');
  if (parts.length <= 2) return fullPath;
  return parts.slice(-2).join('/');
}

// Build nodes
const nodes: GraphNode[] = [];

// Only include files that have at least one connection
const connectedFileIds = new Set<number>();
for (const e of filteredEdges) {
  if (e.src_type === 'file') connectedFileIds.add(e.src_id);
  if (e.dst_type === 'file') connectedFileIds.add(e.dst_id);
}

for (const f of allFiles) {
  if (!connectedFileIds.has(f.id)) continue;
  const nodeId = `file:${f.id}`;
  nodes.push({
    id: nodeId,
    label: shortPath(f.path),
    group: 'file',
    fullPath: f.path,
    lang: f.lang,
    sizeBytes: f.size_bytes,
    connections: connectionCount.get(nodeId) ?? 0,
  });
}

// Only include symbols that have at least one connection or are in included kinds
const connectedSymbolIds = new Set<number>();
for (const e of filteredEdges) {
  if (e.src_type === 'symbol') connectedSymbolIds.add(e.src_id);
  if (e.dst_type === 'symbol') connectedSymbolIds.add(e.dst_id);
}

for (const s of includedSymbols) {
  const nodeId = `symbol:${s.id}`;
  const file = fileMap.get(s.file_id);
  nodes.push({
    id: nodeId,
    label: s.name,
    group: s.kind as 'class' | 'interface' | 'enum',
    kind: s.kind,
    fullPath: s.fq_name,
    filePath: file?.path,
    startLine: s.start_line,
    endLine: s.end_line,
    connections: connectionCount.get(nodeId) ?? 0,
  });
}

// Build links
const links: GraphLink[] = filteredEdges.map((e) => ({
  source: `${e.src_type}:${e.src_id}`,
  target: `${e.dst_type}:${e.dst_id}`,
  rel: e.rel as EdgeRel,
}));

// Only keep links where both source and target exist in nodes
const nodeIdSet = new Set(nodes.map((n) => n.id));
const validLinks = links.filter(
  (l) => nodeIdSet.has(l.source) && nodeIdSet.has(l.target),
);

const classCount = includedSymbols.filter((s) => s.kind === 'class').length;
const interfaceCount = includedSymbols.filter((s) => s.kind === 'interface').length;
const enumCount = includedSymbols.filter((s) => s.kind === 'enum').length;

const graphData: GraphData = {
  nodes,
  links: validLinks,
  stats: {
    files: allFiles.length,
    symbols: allSymbols.length,
    edges: allEdges.length,
    classes: classCount,
    interfaces: interfaceCount,
    enums: enumCount,
  },
  repoPath,
};

console.log(`  Graph nodes: ${nodes.length}`);
console.log(`  Graph links: ${validLinks.length}`);

// ---------------------------------------------------------------------------
// Generate HTML
// ---------------------------------------------------------------------------

const htmlContent = generateHTML(graphData);

// Write to .cindex/graph.html
mkdirSync(cindexDir, { recursive: true });
const outputPath = join(cindexDir, 'graph.html');
writeFileSync(outputPath, htmlContent, 'utf-8');
console.log(`\nGraph written to: ${outputPath}`);

// Close database
database.close();

// Open in browser
if (!noOpen) {
  try {
    const cmd =
      platform() === 'darwin'
        ? 'open'
        : platform() === 'win32'
          ? 'start'
          : 'xdg-open';
    execSync(`${cmd} "${outputPath}"`, { stdio: 'ignore' });
    console.log('Opened in default browser.');
  } catch {
    console.log('Could not open browser automatically. Open the file manually.');
  }
}

// ---------------------------------------------------------------------------
// HTML Generator
// ---------------------------------------------------------------------------

function generateHTML(data: GraphData): string {
  const graphJSON = JSON.stringify(data);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>cindex - Codebase Graph</title>
<style>
  *, *::before, *::after {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    background: #0d1117;
    color: #c9d1d9;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    overflow: hidden;
    width: 100vw;
    height: 100vh;
  }

  /* ---- Header / Controls ---- */
  #controls {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 20px;
    background: rgba(13, 17, 23, 0.92);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid #21262d;
    flex-wrap: wrap;
  }

  #controls .title {
    font-size: 15px;
    font-weight: 600;
    color: #58a6ff;
    white-space: nowrap;
    letter-spacing: -0.3px;
  }

  #controls .title span {
    color: #484f58;
    font-weight: 400;
  }

  #controls .stats {
    font-size: 12px;
    color: #8b949e;
    white-space: nowrap;
  }

  #controls .divider {
    width: 1px;
    height: 24px;
    background: #21262d;
    flex-shrink: 0;
  }

  #search-box {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 5px 12px;
    color: #c9d1d9;
    font-size: 13px;
    outline: none;
    width: 200px;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  #search-box:focus {
    border-color: #58a6ff;
    box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.15);
  }

  #search-box::placeholder {
    color: #484f58;
  }

  .toggle-group {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .toggle-group label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #8b949e;
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
  }

  .toggle-group label:hover {
    color: #c9d1d9;
  }

  .toggle-group input[type="checkbox"] {
    appearance: none;
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border: 1px solid #30363d;
    border-radius: 3px;
    background: #161b22;
    cursor: pointer;
    position: relative;
    flex-shrink: 0;
  }

  .toggle-group input[type="checkbox"]:checked {
    background: #238636;
    border-color: #238636;
  }

  .toggle-group input[type="checkbox"]:checked::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 0px;
    width: 5px;
    height: 9px;
    border: solid #fff;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  .color-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 2px;
    flex-shrink: 0;
  }

  .btn {
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 4px 12px;
    color: #c9d1d9;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s, border-color 0.15s;
  }

  .btn:hover {
    background: #30363d;
    border-color: #484f58;
  }

  /* ---- Tooltip ---- */
  #tooltip {
    position: fixed;
    pointer-events: none;
    z-index: 200;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 12px;
    line-height: 1.5;
    color: #c9d1d9;
    max-width: 380px;
    opacity: 0;
    transition: opacity 0.15s;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  #tooltip.visible {
    opacity: 1;
  }

  #tooltip .tt-type {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 1px 6px;
    border-radius: 3px;
    margin-bottom: 6px;
  }

  #tooltip .tt-type.file { background: rgba(88,166,255,0.15); color: #58a6ff; }
  #tooltip .tt-type.class { background: rgba(240,136,62,0.15); color: #f0883e; }
  #tooltip .tt-type.interface { background: rgba(163,113,247,0.15); color: #a371f7; }
  #tooltip .tt-type.enum { background: rgba(86,211,100,0.15); color: #56d364; }

  #tooltip .tt-name {
    font-size: 14px;
    font-weight: 600;
    color: #f0f6fc;
    margin-bottom: 4px;
    word-break: break-all;
  }

  #tooltip .tt-detail {
    color: #8b949e;
    font-size: 11px;
  }

  #tooltip .tt-detail span {
    color: #c9d1d9;
  }

  /* ---- Legend ---- */
  #legend {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 100;
    background: rgba(22, 27, 34, 0.92);
    backdrop-filter: blur(12px);
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 14px 18px;
    font-size: 11px;
    line-height: 1.8;
  }

  #legend .legend-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #484f58;
    margin-bottom: 6px;
  }

  #legend .legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #8b949e;
  }

  #legend .legend-circle {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  #legend .legend-line {
    width: 24px;
    height: 2px;
    flex-shrink: 0;
  }

  #legend .legend-line.dashed {
    background: repeating-linear-gradient(
      90deg,
      currentColor 0px,
      currentColor 4px,
      transparent 4px,
      transparent 8px
    );
    height: 2px;
  }

  #legend .legend-line.dotted {
    background: repeating-linear-gradient(
      90deg,
      currentColor 0px,
      currentColor 2px,
      transparent 2px,
      transparent 6px
    );
    height: 2px;
  }

  #legend .legend-line.solid {
    background: currentColor;
    height: 1px;
  }

  /* ---- SVG ---- */
  svg {
    display: block;
    width: 100vw;
    height: 100vh;
  }

  /* ---- Search match glow animation ---- */
  @keyframes nodeGlow {
    0%, 100% { filter: drop-shadow(0 0 4px currentColor); }
    50% { filter: drop-shadow(0 0 14px currentColor); }
  }

  .search-match {
    animation: nodeGlow 1.2s ease-in-out infinite;
  }

  /* ---- Empty state ---- */
  #empty-state {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    z-index: 50;
    display: none;
  }

  #empty-state h2 {
    font-size: 20px;
    color: #c9d1d9;
    margin-bottom: 8px;
  }

  #empty-state p {
    font-size: 14px;
    color: #8b949e;
  }
</style>
</head>
<body>

<!-- Controls bar -->
<div id="controls">
  <div class="title">cindex <span>Codebase Graph</span></div>
  <div class="divider"></div>
  <div class="stats" id="stats-display"></div>
  <div class="divider"></div>
  <input type="text" id="search-box" placeholder="Search nodes..." autocomplete="off" spellcheck="false" />
  <div class="divider"></div>
  <div class="toggle-group">
    <label><input type="checkbox" id="toggle-files" checked /><span class="color-dot" style="background:#58a6ff"></span>Files</label>
    <label><input type="checkbox" id="toggle-classes" checked /><span class="color-dot" style="background:#f0883e"></span>Classes</label>
    <label><input type="checkbox" id="toggle-interfaces" checked /><span class="color-dot" style="background:#a371f7"></span>Interfaces</label>
    <label><input type="checkbox" id="toggle-enums" checked /><span class="color-dot" style="background:#56d364"></span>Enums</label>
  </div>
  <div class="divider"></div>
  <label class="toggle-group"><input type="checkbox" id="toggle-labels" checked /> Labels</label>
  <div class="divider"></div>
  <button class="btn" id="btn-reset">Reset Layout</button>
  <button class="btn" id="btn-fit">Fit View</button>
</div>

<!-- Tooltip -->
<div id="tooltip"></div>

<!-- Legend -->
<div id="legend">
  <div class="legend-title">Legend</div>
  <div class="legend-item"><div class="legend-circle" style="background:#58a6ff"></div> File</div>
  <div class="legend-item"><div class="legend-circle" style="background:#f0883e"></div> Class</div>
  <div class="legend-item"><div class="legend-circle" style="background:#a371f7"></div> Interface</div>
  <div class="legend-item"><div class="legend-circle" style="background:#56d364"></div> Enum</div>
  <div style="height:6px"></div>
  <div class="legend-item"><div class="legend-line solid" style="color:#484f58"></div> Imports</div>
  <div class="legend-item"><div class="legend-line dashed" style="color:#f0883e"></div> Extends</div>
  <div class="legend-item"><div class="legend-line dotted" style="color:#a371f7"></div> Implements</div>
</div>

<!-- Empty state -->
<div id="empty-state">
  <h2>No graph data</h2>
  <p>The indexed repository has no visible connections to display.</p>
</div>

<svg id="graph-svg"></svg>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
// ===========================================================================
// Graph Data (injected at build time)
// ===========================================================================
const GRAPH_DATA = ${graphJSON};

// ===========================================================================
// Constants
// ===========================================================================
const COLORS = {
  file: '#58a6ff',
  class: '#f0883e',
  interface: '#a371f7',
  enum: '#56d364',
};

const EDGE_COLORS = {
  IMPORTS: '#484f58',
  EXTENDS: '#f0883e',
  IMPLEMENTS: '#a371f7',
};

const LINK_DISTANCE = {
  IMPORTS: 150,
  EXTENDS: 80,
  IMPLEMENTS: 80,
};

// ===========================================================================
// State
// ===========================================================================
let currentNodes = [...GRAPH_DATA.nodes];
let currentLinks = [...GRAPH_DATA.links];
let showLabels = true;
let searchTerm = '';
let pinnedNodes = new Set();
let highlightedNode = null;

const visibility = {
  file: true,
  class: true,
  interface: true,
  enum: true,
};

// ===========================================================================
// Stats display
// ===========================================================================
const statsEl = document.getElementById('stats-display');
function updateStats() {
  const s = GRAPH_DATA.stats;
  const parts = [];
  parts.push(s.files + ' file' + (s.files !== 1 ? 's' : ''));
  if (s.classes > 0) parts.push(s.classes + ' class' + (s.classes !== 1 ? 'es' : ''));
  if (s.interfaces > 0) parts.push(s.interfaces + ' interface' + (s.interfaces !== 1 ? 's' : ''));
  if (s.enums > 0) parts.push(s.enums + ' enum' + (s.enums !== 1 ? 's' : ''));
  parts.push(s.edges + ' edge' + (s.edges !== 1 ? 's' : ''));
  statsEl.textContent = parts.join('  \\u00b7  ');
}
updateStats();

// ===========================================================================
// Show empty state if no nodes
// ===========================================================================
if (GRAPH_DATA.nodes.length === 0) {
  document.getElementById('empty-state').style.display = 'block';
}

// ===========================================================================
// SVG Setup
// ===========================================================================
const svg = d3.select('#graph-svg');
const width = window.innerWidth;
const height = window.innerHeight;

// Arrow markers for each edge type
const defs = svg.append('defs');

function createMarker(id, color) {
  defs.append('marker')
    .attr('id', id)
    .attr('viewBox', '0 -4 8 8')
    .attr('refX', 20)
    .attr('refY', 0)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-4L8,0L0,4')
    .attr('fill', color);
}

createMarker('arrow-imports', EDGE_COLORS.IMPORTS);
createMarker('arrow-extends', EDGE_COLORS.EXTENDS);
createMarker('arrow-implements', EDGE_COLORS.IMPLEMENTS);

// Glow filter for search matches
const glowFilter = defs.append('filter')
  .attr('id', 'glow')
  .attr('x', '-50%')
  .attr('y', '-50%')
  .attr('width', '200%')
  .attr('height', '200%');
glowFilter.append('feGaussianBlur')
  .attr('in', 'SourceGraphic')
  .attr('stdDeviation', '4')
  .attr('result', 'blur');
const glowMerge = glowFilter.append('feMerge');
glowMerge.append('feMergeNode').attr('in', 'blur');
glowMerge.append('feMergeNode').attr('in', 'SourceGraphic');

// Container for zoom/pan
const container = svg.append('g');

// Layers
const linkGroup = container.append('g').attr('class', 'links');
const nodeGroup = container.append('g').attr('class', 'nodes');
const labelGroup = container.append('g').attr('class', 'labels');

// ===========================================================================
// Zoom
// ===========================================================================
const zoom = d3.zoom()
  .scaleExtent([0.05, 8])
  .on('zoom', (event) => {
    container.attr('transform', event.transform);
    // Show/hide labels based on zoom level
    const scale = event.transform.k;
    if (showLabels) {
      labelGroup.style('opacity', scale > 0.4 ? Math.min(1, (scale - 0.4) / 0.6) : 0);
    }
  });

svg.call(zoom);

// ===========================================================================
// Force Simulation
// ===========================================================================
let simulation;

function nodeRadius(d) {
  const minR = 5;
  const maxR = 22;
  if (d.group === 'file') {
    return Math.max(minR, Math.min(maxR, 6 + d.connections * 1.5));
  }
  return Math.max(minR + 2, Math.min(maxR, 8 + d.connections * 2));
}

function buildSimulation() {
  // Filter nodes/links based on visibility
  currentNodes = GRAPH_DATA.nodes.filter(n => visibility[n.group]);
  const visibleIds = new Set(currentNodes.map(n => n.id));
  currentLinks = GRAPH_DATA.links.filter(l => visibleIds.has(l.source?.id ?? l.source) && visibleIds.has(l.target?.id ?? l.target));

  // Ensure links reference string IDs (not objects) for fresh simulation
  const freshLinks = currentLinks.map(l => ({
    ...l,
    source: typeof l.source === 'object' ? l.source.id : l.source,
    target: typeof l.target === 'object' ? l.target.id : l.target,
  }));
  currentLinks = freshLinks;

  if (simulation) simulation.stop();

  simulation = d3.forceSimulation(currentNodes)
    .force('link', d3.forceLink(currentLinks)
      .id(d => d.id)
      .distance(d => LINK_DISTANCE[d.rel] || 120)
      .strength(0.7)
    )
    .force('charge', d3.forceManyBody()
      .strength(-300)
      .distanceMax(600)
    )
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide()
      .radius(d => nodeRadius(d) + 4)
      .strength(0.8)
    )
    .force('x', d3.forceX(width / 2).strength(0.03))
    .force('y', d3.forceY(height / 2).strength(0.03))
    .alphaDecay(0.02)
    .velocityDecay(0.35)
    .on('tick', ticked);

  render();
}

// ===========================================================================
// Rendering
// ===========================================================================
function render() {
  // --- Links ---
  linkGroup.selectAll('line').remove();
  const linkSel = linkGroup.selectAll('line')
    .data(currentLinks, d => d.source?.id + '-' + d.target?.id + '-' + d.rel)
    .join('line')
    .attr('stroke', d => EDGE_COLORS[d.rel] || '#30363d')
    .attr('stroke-width', d => d.rel === 'IMPORTS' ? 1 : 1.5)
    .attr('stroke-opacity', d => d.rel === 'IMPORTS' ? 0.3 : 0.6)
    .attr('stroke-dasharray', d => {
      if (d.rel === 'EXTENDS') return '6,3';
      if (d.rel === 'IMPLEMENTS') return '2,3';
      return null;
    })
    .attr('marker-end', d => 'url(#arrow-' + d.rel.toLowerCase() + ')');

  // --- Nodes ---
  nodeGroup.selectAll('circle').remove();
  const nodeSel = nodeGroup.selectAll('circle')
    .data(currentNodes, d => d.id)
    .join('circle')
    .attr('r', d => nodeRadius(d))
    .attr('fill', d => COLORS[d.group] || '#8b949e')
    .attr('stroke', d => d3.color(COLORS[d.group] || '#8b949e').brighter(0.5))
    .attr('stroke-width', 1.5)
    .attr('stroke-opacity', 0.4)
    .attr('cursor', 'pointer')
    .style('transition', 'opacity 0.2s')
    .on('mouseover', handleMouseOver)
    .on('mouseout', handleMouseOut)
    .on('click', handleClick)
    .on('dblclick', handleDblClick)
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded)
    );

  // --- Labels ---
  labelGroup.selectAll('text').remove();
  const labelSel = labelGroup.selectAll('text')
    .data(currentNodes, d => d.id)
    .join('text')
    .text(d => d.label)
    .attr('font-size', d => d.group === 'file' ? '9px' : '10px')
    .attr('font-weight', d => d.group === 'file' ? '400' : '500')
    .attr('fill', '#c9d1d9')
    .attr('fill-opacity', 0.85)
    .attr('text-anchor', 'middle')
    .attr('dy', d => nodeRadius(d) + 13)
    .attr('pointer-events', 'none')
    .style('text-shadow', '0 1px 3px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.6)');

  if (!showLabels) labelGroup.style('display', 'none');
  else labelGroup.style('display', null);

  // Store selections for tick updates
  linkSel._data = currentLinks;
  nodeSel._data = currentNodes;

  // Update search highlights
  applySearchHighlight();
}

// ===========================================================================
// Tick handler
// ===========================================================================
function ticked() {
  linkGroup.selectAll('line')
    .attr('x1', d => d.source.x)
    .attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x)
    .attr('y2', d => d.target.y);

  nodeGroup.selectAll('circle')
    .attr('cx', d => d.x)
    .attr('cy', d => d.y);

  labelGroup.selectAll('text')
    .attr('x', d => d.x)
    .attr('y', d => d.y);
}

// ===========================================================================
// Drag handlers
// ===========================================================================
function dragStarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.15).restart();
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function dragEnded(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  if (!pinnedNodes.has(d.id)) {
    d.fx = null;
    d.fy = null;
  }
}

// ===========================================================================
// Hover / Click handlers
// ===========================================================================
const tooltip = document.getElementById('tooltip');

function getConnectedIds(nodeId) {
  const ids = new Set([nodeId]);
  currentLinks.forEach(l => {
    const srcId = typeof l.source === 'object' ? l.source.id : l.source;
    const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
    if (srcId === nodeId) ids.add(tgtId);
    if (tgtId === nodeId) ids.add(srcId);
  });
  return ids;
}

function handleMouseOver(event, d) {
  highlightedNode = d.id;
  const connectedIds = getConnectedIds(d.id);

  // Dim unrelated nodes
  nodeGroup.selectAll('circle')
    .attr('opacity', n => connectedIds.has(n.id) ? 1 : 0.12);

  linkGroup.selectAll('line')
    .attr('stroke-opacity', l => {
      const srcId = typeof l.source === 'object' ? l.source.id : l.source;
      const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
      return (srcId === d.id || tgtId === d.id) ? 0.8 : 0.04;
    });

  labelGroup.selectAll('text')
    .attr('fill-opacity', n => connectedIds.has(n.id) ? 1 : 0.1);

  // Show tooltip
  let html = '';
  html += '<div class="tt-type ' + d.group + '">' + d.group.toUpperCase() + '</div>';
  html += '<div class="tt-name">' + escapeHtml(d.label) + '</div>';

  if (d.group === 'file') {
    html += '<div class="tt-detail">Path: <span>' + escapeHtml(d.fullPath || '') + '</span></div>';
    if (d.lang) html += '<div class="tt-detail">Language: <span>' + d.lang + '</span></div>';
    if (d.sizeBytes) html += '<div class="tt-detail">Size: <span>' + formatBytes(d.sizeBytes) + '</span></div>';
  } else {
    if (d.kind) html += '<div class="tt-detail">Kind: <span>' + d.kind + '</span></div>';
    if (d.fullPath) html += '<div class="tt-detail">FQ Name: <span>' + escapeHtml(d.fullPath) + '</span></div>';
    if (d.filePath) html += '<div class="tt-detail">File: <span>' + escapeHtml(d.filePath) + '</span></div>';
    if (d.startLine != null) html += '<div class="tt-detail">Lines: <span>' + d.startLine + ' - ' + d.endLine + '</span></div>';
  }
  html += '<div class="tt-detail">Connections: <span>' + d.connections + '</span></div>';

  tooltip.innerHTML = html;
  tooltip.classList.add('visible');
  positionTooltip(event);
}

function handleMouseOut(event, d) {
  highlightedNode = null;
  nodeGroup.selectAll('circle').attr('opacity', 1);
  linkGroup.selectAll('line')
    .attr('stroke-opacity', l => l.rel === 'IMPORTS' ? 0.3 : 0.6);
  labelGroup.selectAll('text').attr('fill-opacity', 0.85);
  tooltip.classList.remove('visible');
}

function positionTooltip(event) {
  const pad = 16;
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  const rect = tooltip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - pad) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - pad) y = event.clientY - rect.height - pad;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}

document.addEventListener('mousemove', (e) => {
  if (tooltip.classList.contains('visible')) {
    positionTooltip(e);
  }
});

function handleClick(event, d) {
  event.stopPropagation();
  if (pinnedNodes.has(d.id)) {
    pinnedNodes.delete(d.id);
    d.fx = null;
    d.fy = null;
    d3.select(event.currentTarget)
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', 0.4);
  } else {
    pinnedNodes.add(d.id);
    d.fx = d.x;
    d.fy = d.y;
    d3.select(event.currentTarget)
      .attr('stroke-width', 2.5)
      .attr('stroke-opacity', 0.9);
  }
}

function handleDblClick(event, d) {
  event.preventDefault();
  event.stopPropagation();

  // Center and zoom on the double-clicked node
  const scale = 2;
  const transform = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(scale)
    .translate(-d.x, -d.y);

  svg.transition()
    .duration(600)
    .ease(d3.easeCubicInOut)
    .call(zoom.transform, transform);
}

// ===========================================================================
// Search
// ===========================================================================
const searchBox = document.getElementById('search-box');

searchBox.addEventListener('input', (e) => {
  searchTerm = e.target.value.toLowerCase().trim();
  applySearchHighlight();
});

searchBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && searchTerm) {
    const match = currentNodes.find(n =>
      n.label.toLowerCase().includes(searchTerm) ||
      (n.fullPath && n.fullPath.toLowerCase().includes(searchTerm))
    );
    if (match && match.x != null) {
      const scale = 2;
      const transform = d3.zoomIdentity
        .translate(width / 2, height / 2)
        .scale(scale)
        .translate(-match.x, -match.y);

      svg.transition()
        .duration(600)
        .ease(d3.easeCubicInOut)
        .call(zoom.transform, transform);
    }
  }
  if (e.key === 'Escape') {
    searchBox.value = '';
    searchTerm = '';
    applySearchHighlight();
    searchBox.blur();
  }
});

function applySearchHighlight() {
  if (!searchTerm) {
    nodeGroup.selectAll('circle')
      .classed('search-match', false)
      .attr('filter', null);
    return;
  }

  nodeGroup.selectAll('circle')
    .each(function(d) {
      const isMatch = d.label.toLowerCase().includes(searchTerm) ||
        (d.fullPath && d.fullPath.toLowerCase().includes(searchTerm));
      d3.select(this)
        .classed('search-match', isMatch)
        .attr('filter', isMatch ? 'url(#glow)' : null);
    });
}

// ===========================================================================
// Toggle controls
// ===========================================================================
document.getElementById('toggle-files').addEventListener('change', (e) => {
  visibility.file = e.target.checked;
  buildSimulation();
});
document.getElementById('toggle-classes').addEventListener('change', (e) => {
  visibility.class = e.target.checked;
  buildSimulation();
});
document.getElementById('toggle-interfaces').addEventListener('change', (e) => {
  visibility.interface = e.target.checked;
  buildSimulation();
});
document.getElementById('toggle-enums').addEventListener('change', (e) => {
  visibility.enum = e.target.checked;
  buildSimulation();
});

document.getElementById('toggle-labels').addEventListener('change', (e) => {
  showLabels = e.target.checked;
  if (showLabels) {
    labelGroup.style('display', null);
  } else {
    labelGroup.style('display', 'none');
  }
});

document.getElementById('btn-reset').addEventListener('click', () => {
  pinnedNodes.clear();
  currentNodes.forEach(n => { n.fx = null; n.fy = null; });
  buildSimulation();
  svg.transition()
    .duration(500)
    .call(zoom.transform, d3.zoomIdentity);
});

document.getElementById('btn-fit').addEventListener('click', fitView);

function fitView() {
  if (currentNodes.length === 0) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  currentNodes.forEach(n => {
    if (n.x == null) return;
    const r = nodeRadius(n);
    minX = Math.min(minX, n.x - r);
    maxX = Math.max(maxX, n.x + r);
    minY = Math.min(minY, n.y - r);
    maxY = Math.max(maxY, n.y + r);
  });

  if (!isFinite(minX)) return;

  const graphWidth = maxX - minX;
  const graphHeight = maxY - minY;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  const padding = 80;
  const scaleX = (width - padding * 2) / graphWidth;
  const scaleY = (height - padding * 2) / graphHeight;
  const scale = Math.min(scaleX, scaleY, 4);

  const transform = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(scale)
    .translate(-midX, -midY);

  svg.transition()
    .duration(600)
    .ease(d3.easeCubicInOut)
    .call(zoom.transform, transform);
}

// ===========================================================================
// Keyboard shortcuts
// ===========================================================================
document.addEventListener('keydown', (e) => {
  // Cmd/Ctrl+F or / to focus search
  if ((e.key === 'f' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && document.activeElement !== searchBox)) {
    e.preventDefault();
    searchBox.focus();
    searchBox.select();
  }
});

// ===========================================================================
// Utilities
// ===========================================================================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ===========================================================================
// Initialize
// ===========================================================================
buildSimulation();

// After simulation settles, fit view
setTimeout(() => {
  fitView();
}, 2000);

// Handle window resize
window.addEventListener('resize', () => {
  // Update center force
  if (simulation) {
    simulation.force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2));
    simulation.force('x', d3.forceX(window.innerWidth / 2).strength(0.03));
    simulation.force('y', d3.forceY(window.innerHeight / 2).strength(0.03));
    simulation.alpha(0.1).restart();
  }
});
</script>
</body>
</html>`;
}
