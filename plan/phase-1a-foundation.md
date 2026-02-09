# Phase 1A: Foundation (Scaffolding + Storage)

## Overview
Set up the project structure, build tooling, and implement the SQLite storage layer with all tables from the spec.

## Goals
- Working TypeScript project with build, lint, and test
- SQLite database with full schema from spec
- Repository pattern for CRUD operations on all entities
- All storage operations unit-tested

## Implementation Steps

### 1. Project Scaffolding
- `package.json` with dependencies:
  - `@modelcontextprotocol/sdk` - MCP server
  - `better-sqlite3` - SQLite
  - `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript` - parsing
  - `ignore` - gitignore parsing
  - `fast-glob` - file discovery
- `tsconfig.json` targeting ES2022, Node16 module resolution
- `tsup.config.ts` for building to `dist/`
- `vitest.config.ts` for testing
- `.gitignore`
- Directory structure: `src/`, `tests/`, `fixtures/`

### 2. Shared Types (`src/types.ts`)
- `NodeType`: file | symbol | module
- `EdgeRel`: IMPORTS | EXPORTS | DEFINES | REFERENCES | EXTENDS | IMPLEMENTS | TESTS
- `SymbolKind`: function | class | interface | type | variable | enum | method | property
- `IndexMode`: full | incremental
- `IndexLevel`: 0 | 1
- Interfaces for: Repo, FileRecord, Symbol, Module, Edge, SearchEntry
- Context bundle types: ContextBundle, FocusItem, Snippet, Subgraph

### 3. SQLite Schema (`src/storage/schema.ts`)
Tables per spec:
- `repos(id, root_path, created_at, updated_at)`
- `files(id, repo_id, path, lang, sha256, mtime, size_bytes, last_indexed_at)`
- `symbols(id, repo_id, file_id, kind, name, fq_name, signature, start_line, start_col, end_line, end_col)`
- `modules(id, repo_id, name, version, manifest_path)`
- `edges(id, repo_id, src_type, src_id, rel, dst_type, dst_id, meta_json, weight, created_at)`
- `search_index` - FTS5 virtual table for full-text search
- Proper indexes on foreign keys and frequently queried columns

### 4. Database Class (`src/storage/database.ts`)
- Constructor takes db path (default: `.cindex/cindex.db` relative to repo root)
- Auto-create directory if needed
- Run migrations on open
- WAL mode for better read concurrency
- Transaction helper
- Close/cleanup

### 5. Repository Classes (`src/storage/repositories/`)
- `RepoRepository` - CRUD for repos table
- `FileRepository` - CRUD for files, find by path, find changed files
- `SymbolRepository` - CRUD for symbols, find by file, find by name/fq_name
- `ModuleRepository` - CRUD for modules
- `EdgeRepository` - CRUD for edges, find by src/dst, find neighbours
- `SearchRepository` - FTS insert/update/delete/search

### 6. Unit Tests
- Database creation and migration
- CRUD operations for each repository
- FTS5 search queries
- Transaction rollback behaviour
- Edge queries (neighbours, traversal)

## Files to Create
- `package.json`
- `tsconfig.json`
- `tsup.config.ts`
- `vitest.config.ts`
- `.gitignore`
- `src/types.ts`
- `src/storage/database.ts`
- `src/storage/schema.ts`
- `src/storage/repositories/repo-repository.ts`
- `src/storage/repositories/file-repository.ts`
- `src/storage/repositories/symbol-repository.ts`
- `src/storage/repositories/module-repository.ts`
- `src/storage/repositories/edge-repository.ts`
- `src/storage/repositories/search-repository.ts`
- `src/storage/repositories/index.ts`
- `tests/storage/database.test.ts`
- `tests/storage/repositories.test.ts`
