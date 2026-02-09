# cindex

Offline MCP codebase graph indexer for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Parses codebases into dependency/symbol graphs using Tree-sitter and serves ranked context bundles on demand.

## Install

```bash
npm install -g cindex
```

Then add to Claude Code:

```bash
claude mcp add -s user cindex -- cindex
```

Or use npx (no global install):

```bash
claude mcp add -s user cindex -- npx -y cindex
```

## What it does

cindex parses your codebase using Tree-sitter, builds a graph of files, symbols (functions, classes, interfaces, types), and relationships (imports, exports, extends, implements), stores it in a local SQLite database, and exposes it via MCP tools.

When you ask Claude to work on a task, `repo_context_get` returns a ranked bundle of the most relevant files and code snippets based on the dependency graph and text search — so Claude starts with the right context.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `repo_status` | Check if a repo is indexed |
| `repo_index` | Index/re-index a codebase (incremental by default) |
| `repo_search` | Full-text search across files and symbols |
| `repo_snippet` | Read source code from indexed files |
| `repo_context_get` | Get ranked context bundle for a task description |

## Making Claude use cindex automatically

After installing, add this to your project's `CLAUDE.md`:

```markdown
## Codebase Index (cindex)

This project is indexed with cindex (MCP codebase graph indexer).

**Workflow — do this at the start of every session:**
1. Call `repo_status` with this project's root path to check if the index exists
2. If not indexed or if many files have changed, call `repo_index` to update (takes ~2s)
3. Before starting any coding task, call `repo_context_get` with a description of the task to get relevant files, symbols, and code snippets ranked by importance
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
