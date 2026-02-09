# cindex

Offline MCP codebase graph indexer for Claude Code. Indexes TypeScript/JavaScript codebases into dependency/symbol graphs and serves ranked context bundles on demand.

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

cindex parses your TS/JS codebase using Tree-sitter, builds a graph of files, symbols (functions, classes, interfaces, types), and relationships (imports, exports, extends, implements), stores it in a local SQLite database, and exposes it via MCP tools.

When you ask Claude to work on a task, `repo_context_get` returns a ranked bundle of the most relevant files and code snippets based on the dependency graph and text search — so Claude starts with the right context.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `repo_status` | Check if a repo is indexed |
| `repo_index` | Index/re-index a codebase (incremental by default) |
| `repo_search` | Full-text search across files and symbols |
| `repo_snippet` | Read source code from indexed files |
| `repo_context_get` | Get ranked context bundle for a task description |

## Usage with Claude Code

After installing and adding the MCP server, add this to your project's `CLAUDE.md` to have Claude use it automatically:

```markdown
## Codebase Index (cindex)

This project is indexed with cindex. At the start of a session:
1. Call `repo_status` with the project root to check the index
2. If not indexed or stale, call `repo_index` to update
3. Before working on a task, call `repo_context_get` with a task description to get relevant context
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
| **C** | `.c`, `.h` | #include, structs, functions, #defines |
| **C++** | `.cpp`, `.cc`, `.hpp`, etc. | #include, classes, namespaces, templates, methods |
| **C#** | `.cs` | using, namespaces, classes, interfaces, enums, methods |

The parser architecture is extensible — adding new languages requires a tree-sitter grammar and a parser file.

## How it works

1. **Walk** — Discovers files respecting `.gitignore`
2. **Parse** — Extracts symbols, imports, and exports using Tree-sitter ASTs
3. **Resolve** — Links import paths to actual files in the repo
4. **Store** — Writes to SQLite with FTS5 full-text search index
5. **Retrieve** — On query: candidate discovery → BFS graph expansion → ranking → budget-aware snippet extraction

Indexing is fast (~2s for medium repos) and incremental updates only re-parse changed files.

## Data storage

Index database: `~/.cindex/cindex.db` (override with `CINDEX_DB_PATH` env var)

## Requirements

- Node.js >= 20
- C++ compiler (for native tree-sitter/SQLite bindings — installed automatically on most systems)
