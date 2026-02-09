# cindex - Offline MCP Codebase Graph Indexer

## Purpose
MCP server that indexes a codebase into a dependency/symbol graph and serves context bundles to Claude Code.

## Quick Start
```bash
npm install && npm run build
# Test: npm test
# Dev: npx tsx src/server.ts
```

## Architecture
```
src/
├── server.ts              # MCP server entry point (stdio transport)
├── types.ts               # All shared TypeScript types
├── storage/
│   ├── database.ts        # SQLite via better-sqlite3 (WAL mode)
│   ├── schema.ts          # DDL for all tables + FTS5
│   └── repositories/      # CRUD for repos, files, symbols, edges, search, modules
├── indexer/
│   ├── walker.ts          # File discovery (gitignore-aware, fast-glob)
│   ├── parser.ts          # Tree-sitter orchestrator (TS/JS)
│   ├── parsers/           # Language-specific AST extraction
│   ├── resolver.ts        # Import path resolution
│   ├── hasher.ts          # SHA-256 file hashing
│   └── indexer.ts         # Full + incremental indexing pipeline
├── retriever/
│   ├── search.ts          # FTS5 text search with sanitization
│   ├── candidates.ts      # Multi-strategy candidate discovery
│   ├── expander.ts        # BFS graph expansion from seeds
│   ├── ranker.ts          # Score-based ranking with entry point detection
│   ├── snippets.ts        # Budget-aware snippet extraction
│   └── retriever.ts       # Full retrieval pipeline -> ContextBundle
└── tools/                 # MCP tool handlers (validation, 5 tools)
```

## Key Patterns
- **Storage**: SQLite with FTS5 for search. In-memory DB for tests (`:memory:`).
- **Parsing**: Tree-sitter with native bindings. Separate grammars for TS, TSX, JS.
- **Indexing**: Full (scan all) or incremental (sha256/mtime change detection).
- **Retrieval**: candidates -> graph expansion -> ranking -> budget-constrained snippets.
- **Edges**: IMPORTS, EXPORTS, DEFINES, EXTENDS, IMPLEMENTS between files and symbols.

## MCP Tools
| Tool | Purpose |
|------|---------|
| `repo_status` | Check index status and counts |
| `repo_index` | Build/update the code graph |
| `repo_search` | FTS5 search over files and symbols |
| `repo_snippet` | Read code from a file (with path traversal protection) |
| `repo_context_get` | Get a context bundle for a task |

## Testing
```bash
npm test              # Run all 114 tests
npm run test:watch    # Watch mode
```

## Configuration
- DB path: `$CINDEX_DB_PATH` or `~/.cindex/cindex.db`
- Claude Code MCP config (`.mcp.json`):
```json
{
  "mcpServers": {
    "cindex": {
      "command": "node",
      "args": ["/path/to/cindex/dist/server.js"]
    }
  }
}
```
