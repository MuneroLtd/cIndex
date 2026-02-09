# cindex

Offline MCP codebase graph indexer for AI-powered editors. Parses codebases into dependency/symbol graphs using Tree-sitter and serves ranked context bundles on demand.

Works with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Cursor](https://cursor.com), and any editor that supports [MCP](https://modelcontextprotocol.io).

## Setup

### Claude Code

```bash
claude mcp add -s user cindex -- npx -y @munero/cindex
```

### Cursor

Add to your project's `.cursor/mcp.json` (or global `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "cindex": {
      "command": "npx",
      "args": ["-y", "@munero/cindex"]
    }
  }
}
```

Then restart Cursor. The cindex tools will be available in Cursor's AI agent mode.

### Other MCP-compatible editors

cindex runs as a stdio MCP server. For any editor that supports MCP, point it at:

```
npx -y @munero/cindex
```

Or install globally and use the binary directly:

```bash
npm install -g @munero/cindex
cindex
```

## What it does

cindex parses your codebase using Tree-sitter, builds a graph of files, symbols (functions, classes, interfaces, types), and relationships (imports, exports, extends, implements), stores it in a local SQLite database, and exposes it via MCP tools.

When the AI works on a task, `repo_context_get` returns a ranked bundle of the most relevant files and code snippets based on the dependency graph and text search — so it starts with the right context.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `repo_status` | Check if a repo is indexed |
| `repo_index` | Index/re-index a codebase (incremental by default) |
| `repo_search` | Full-text search across files and symbols |
| `repo_snippet` | Read source code from indexed files |
| `repo_context_get` | Get ranked context bundle for a task description |

## Making the AI use cindex automatically

The AI won't proactively use cindex tools unless instructed. Add these instructions to your project:

**Claude Code** — add to your project's `CLAUDE.md`:

**Cursor** — add to your project's `.cursorrules`:

```markdown
## Codebase Index (cindex)

This project is indexed with cindex (MCP codebase graph indexer).

Workflow — do this at the start of every session:
1. Call `repo_status` with this project's root path to check if the index exists
2. If not indexed or if many files have changed, call `repo_index` to update
3. Before starting any coding task, call `repo_context_get` with a description of the task
4. Use `repo_search` to find specific symbols, files, or types by keyword
5. Use `repo_snippet` to read full source of files identified by search or context
```

## Supported Languages

| Language | Extensions | Extracts |
|----------|-----------|----------|
| **TypeScript** | `.ts`, `.tsx` | imports, exports, classes, interfaces, types, enums, functions |
| **JavaScript** | `.js`, `.jsx`, `.mjs`, `.cjs` | ESM + CommonJS imports/exports, classes, functions |
| **Python** | `.py`, `.pyi` | imports, classes, inheritance, functions, methods |
| **Go** | `.go` | imports, structs, interfaces, functions, methods |
| **Rust** | `.rs` | use imports, structs, traits, impl blocks, functions |
| **PHP** | `.php` | use/namespace, classes, interfaces, methods |
| **Java** | `.java` | imports, classes, interfaces, extends/implements, methods |
| **Ruby** | `.rb` | require, modules, classes, inheritance, methods |
| **C** | `.c`, `.h` | #include, functions, #defines |
| **C++** | `.cpp`, `.cc`, `.hpp`, etc. | #include, classes, namespaces, methods |
| **C#** | `.cs` | using, namespaces, classes, interfaces, enums, methods |

## How it works

1. **Walk** — Discovers files respecting `.gitignore`
2. **Parse** — Extracts symbols, imports, and exports via Tree-sitter ASTs
3. **Resolve** — Links import paths to actual files in the repo
4. **Store** — Writes to SQLite with FTS5 full-text search index
5. **Retrieve** — Candidate discovery → BFS graph expansion → ranking → budget-aware snippet extraction

Indexing is fast (~2s for medium repos) and incremental updates only re-parse changed files.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CINDEX_DB_PATH` | `~/.cindex/cindex.db` | Database file location |

## Development

```bash
git clone https://github.com/MuneroLtd/cIndex.git
cd cIndex
npm install
npm test          # 198 tests
npm run build     # production bundle
npm run dev       # dev server with tsx
```

## Requirements

- Node.js >= 20
- C++ compiler (for native tree-sitter/SQLite bindings — installed automatically on most systems)

## License

MIT
