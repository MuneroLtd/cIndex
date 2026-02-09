# Phase 1C: Indexer

## Overview
Orchestrate the full and incremental indexing pipelines, combining file discovery, parsing, and storage to build the repo graph.

## Goals
- Full index: scan entire repo, build complete graph
- Incremental index: detect changes, re-index only changed files, garbage collect
- Populate search_index for text search
- Batch operations for performance

## Implementation Steps

### 1. Full Indexer (`src/indexer/indexer.ts`)
Pipeline:
1. Create or get repo record in `repos` table
2. Discover all files via walker
3. For each file (in batches):
   a. Compute sha256 hash
   b. Parse with Tree-sitter -> get imports, exports, symbols
   c. Upsert file record
   d. Upsert symbol records
   e. Create edges:
      - File DEFINES Symbol (for each symbol)
      - File IMPORTS File (for each resolved import)
      - File EXPORTS Symbol (for each export)
      - Symbol EXTENDS Symbol (for class inheritance)
      - Symbol IMPLEMENTS Symbol (for interface implementation)
   f. Populate search_index entries (file path, symbol names, fq_names)
4. Store module records from package.json if present
5. Return summary: file count, symbol count, edge count, duration, warnings

### 2. Incremental Indexer (extension of indexer.ts)
Pipeline:
1. Get repo record
2. Discover current files via walker
3. Compare with stored files:
   - **New files**: files on disk not in DB -> full parse + insert
   - **Changed files**: sha256 or mtime differs -> re-parse + update
   - **Deleted files**: files in DB not on disk -> remove records
4. For changed/new files:
   a. Delete old symbols and edges for that file
   b. Re-parse and insert new symbols/edges
   c. Update search_index
5. Garbage collect:
   - Remove symbols for deleted files
   - Remove edges with dangling src/dst
   - Remove search_index entries for removed entities
6. Return summary with counts of added/changed/deleted

### 3. Batch Processing
- Process files in batches of 100 within transactions
- Use prepared statements for repeated inserts
- Compute sha256 using crypto.createHash (stream for large files)

### 4. Edge Building Logic
- Import edges: resolved source file -> resolved target file
- Define edges: file -> each symbol defined in it
- Export edges: file -> each exported symbol
- Extends: class symbol -> parent class symbol (resolve across files)
- Implements: class symbol -> interface symbol (resolve across files)

### 5. Progress Reporting
- Log structured progress: files scanned, files parsed, edges created
- Emit progress events for potential future UI

### 6. Tests
- Full index of fixture repo: correct counts
- Incremental: add file -> new records appear
- Incremental: modify file -> records updated
- Incremental: delete file -> records removed, edges cleaned
- Edge correctness: import chains, define relationships
- Performance: index completes within timeout for medium repo

## Files to Create/Modify
- `src/indexer/indexer.ts`
- `src/indexer/hasher.ts` (sha256 helper)
- `tests/indexer/indexer.test.ts`
- `tests/indexer/incremental.test.ts`
