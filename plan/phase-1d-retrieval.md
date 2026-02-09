# Phase 1D: Retrieval + Search

## Overview
Implement the retrieval pipeline: text search, candidate discovery, graph expansion, ranking, and context bundle assembly.

## Goals
- Full-text search over indexed content
- Discover candidate files/symbols from a task description
- Expand candidates via graph traversal
- Rank and select under budget constraints
- Assemble structured context bundle per spec format

## Implementation Steps

### 1. Text Search (`src/retriever/search.ts`)
- FTS5 query on search_index table
- Support substring matching for file paths and symbol names
- Return ranked results with match highlights
- Limit results configurable (default 20)

### 2. Candidate Discovery (`src/retriever/candidates.ts`)
From a task description, find initial candidate nodes:

**Exact match:**
- Extract file paths mentioned in task text (regex for path-like strings)
- Extract symbol names mentioned in task text (CamelCase, snake_case patterns)
- Look up in DB

**Text search:**
- Extract keywords from task (filter stop words)
- Run FTS5 search
- Return matched files and symbols with relevance scores

**Hints processing:**
- If hints include paths -> add those files directly
- If hints include symbols -> look up and add
- If hints include language filter -> restrict candidates

### 3. Graph Expansion (`src/retriever/expander.ts`)
From seed candidates, expand the graph:
- Follow IMPORTS edges outward (depth 1-3, configurable)
- Follow DEFINES edges to get symbols in imported files
- Follow EXPORTS to find what's used from dependencies
- Track visited nodes to avoid cycles
- Score decays with distance from seed

### 4. Ranking (`src/retriever/ranker.ts`)
Score each candidate node:

**Signals:**
- `mentionScore` (0-10): explicitly mentioned in task
- `proximityScore` (0-5): graph distance from top candidates
- `entryPointScore` (0-5): is this a route/controller/main file?
- `recentEditScore` (0-3): recently modified (mtime)
- `sizeScore` (0-2): prefer smaller, focused files

**Entry point detection:**
- Files matching patterns: `routes/*`, `controllers/*`, `pages/*`, `app.*`, `main.*`, `index.*`
- Files with many inbound edges (frequently imported)

**Final score:** weighted sum, sort descending

### 5. Budget Enforcement (`src/retriever/budget.ts`)
- Accept budget as max tokens or max lines
- Estimate tokens from text (rough: chars / 4)
- Select top-ranked candidates until budget exhausted
- Prefer snippets over whole files:
  - If file has relevant symbols, extract only those line ranges (+context)
  - If entire file is small (<50 lines), include whole file
- Track used budget

### 6. Snippet Extraction (`src/retriever/snippets.ts`)
- Given a file and relevant symbols, extract line ranges
- Add context lines (5 above, 5 below by default)
- Merge overlapping ranges
- Include file header (first few lines with imports) if not already included

### 7. Context Bundle Assembly (`src/retriever/retriever.ts`)
Orchestrate the full pipeline:
1. Discover candidates from task
2. Expand graph
3. Rank
4. Select under budget
5. Extract snippets
6. Build subgraph (nodes + edges between selected items)
7. Generate intent summary
8. Return ContextBundle per spec format

### 8. Tests
- Search: finds files/symbols by text
- Candidates: discovers from task description
- Expansion: follows import chains correctly
- Ranking: top candidates are most relevant
- Budget: respects limits, prefers snippets
- Bundle: matches spec output format
- Integration: end-to-end from task text to bundle

## Files to Create
- `src/retriever/search.ts`
- `src/retriever/candidates.ts`
- `src/retriever/expander.ts`
- `src/retriever/ranker.ts`
- `src/retriever/budget.ts`
- `src/retriever/snippets.ts`
- `src/retriever/retriever.ts`
- `tests/retriever/search.test.ts`
- `tests/retriever/candidates.test.ts`
- `tests/retriever/retriever.test.ts`
