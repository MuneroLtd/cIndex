Offline MCP Codebase Graph Skill (Claude Code)

Goal

Provide an offline, local MCP server that indexes a codebase into a dependency and symbol graph, then serves a "context bundle" (minimal relevant code + relationships) to Claude Code on demand. Optional UI visualiser can be added later, it is not required for usefulness.

Non-goals

Perfect, whole-program call graph for dynamic languages.

Full repo visualisation in one view.

Remote indexing or cloud storage.


Key outcomes

Fast, incremental indexing of a local repo.

Deterministic retrieval of relevant files and snippets for a task.

Tooling that Claude Code can reliably call first (default workflow).

Works fully offline (no network required for indexing and retrieval).


Definitions

Repo graph: nodes (files, symbols, modules) and edges (imports, defines, references).

Context bundle: a structured response containing selected snippets, plus a subgraph explaining why those snippets matter.

Budget: maximum tokens or maximum bytes/lines returned in a single context bundle.


Architecture

Components

1. MCP Server (local)

Runs via stdio transport (preferred).

Exposes tools for indexing, querying, and snippet retrieval.



2. Indexer

Scans repo.

Extracts imports/exports and symbol definitions.

Optionally extracts symbol references.

Supports incremental updates using file hashes and timestamps.



3. Storage (local)

Default: SQLite.

Optional: Postgres or Neo4j.



4. Retriever

Computes relevant entry points for a task.

Expands neighbourhood in the graph.

Ranks and selects files and snippets under budget.



5. (Optional) Visualiser

Reads subgraphs from MCP server.

Renders interactive graph.




Data flow

Indexer builds or updates graph -> stored locally.

Claude Code calls repo_context_get -> retriever selects relevant nodes -> returns context bundle.

Claude Code may call repo_snippet for follow-up reads.


Supported languages

Phase 1

TypeScript and JavaScript.


Phase 2

PHP (Laravel oriented) and Python.


Parsing strategy

Default: Tree-sitter grammars bundled with the tool.

Optional: LSP integration for higher accuracy references.


Storage schema (SQLite)

Tables

repos(id, root_path, created_at, updated_at)

files(id, repo_id, path, lang, sha256, mtime, size_bytes, last_indexed_at)

symbols(id, repo_id, file_id, kind, name, fq_name, signature, start_line, start_col, end_line, end_col)

modules(id, repo_id, name, version, manifest_path)

edges(id, repo_id, src_type, src_id, rel, dst_type, dst_id, meta_json, weight, created_at)

search_index(id, repo_id, entity_type, entity_id, text)


Node types

file, symbol, module.


Edge rel values

IMPORTS, EXPORTS, DEFINES, REFERENCES, EXTENDS, IMPLEMENTS, TESTS.


Indexing

Full index

Discover files using ignore rules:

Respect .gitignore.

Default ignore: node_modules, vendor, dist, build, .next, .cache, coverage.


For each file:

Identify language.

Parse AST.

Extract:

imports and exports

symbol definitions

(optional) local references


Write nodes and edges.



Incremental index

Determine changed files by:

git diff (if repo) or

comparing stored sha256 or mtime.


Re-index changed files.

Update edges incident to changed files.

Garbage collect:

deleted files

symbols no longer present

edges whose endpoints no longer exist



Quality levels

Level 0: imports + symbol defs only (fast, robust).

Level 1: add references and type relationships (more accurate, slower).


Performance targets

Initial index: under 60s for medium repo (assumption, depends on size).

Incremental updates: under 3s for typical edit set.


Retrieval and ranking

Inputs

task: user request text.

budget: max tokens or lines.

hints: optional paths, symbols, language filter.


Candidate discovery

Exact match:

mentioned file paths

mentioned symbols


Text search:

ripgrep style substring search over repo

optional search over search_index


Graph expansion:

import chain depth 1 to 3

callers or references depth 1 to 2 (if available)



Ranking signals

Explicit mentions in task.

Path proximity to entry points (routes, controllers, main modules).

Graph proximity to top candidates.

Recent edits.

Test relevance (if requested or if failing tests are detected).


Selection rules

Always include:

top entry point files

direct dependencies needed to understand the change


Prefer snippets over whole files.

Stop when budget is reached.

Include a compact subgraph for explainability.


MCP tools

Tool list

1. repo_status(repo_path)

Returns repo id, index status, last indexed time, counts.



2. repo_index(repo_path, mode, level)

mode: full or incremental

level: 0 or 1

Returns summary and any warnings.



3. repo_search(repo_path, query, limit)

Returns matched files, line numbers, excerpts.



4. repo_snippet(repo_path, file_path, start_line, end_line)

Returns snippet text.



5. repo_graph_query(repo_path, seed, depth, filters)

seed: file path or symbol fq_name.

Returns nodes and edges.



6. repo_context_get(repo_path, task, budget, hints)

Returns structured context bundle.




Context bundle response format

{
  "repo": {"root": "/path", "rev": "git_sha_or_null"},
  "intent": "short inferred intent",
  "focus": [
    {"type": "file", "id": "...", "path": "src/auth.ts", "reason": "oauth flow"},
    {"type": "symbol", "id": "...", "fq_name": "AuthController.login", "reason": "entry point"}
  ],
  "snippets": [
    {"path": "src/auth.ts", "start": 1, "end": 120, "sha256": "...", "text": "..."}
  ],
  "subgraph": {
    "nodes": [{"type": "file", "id": "...", "path": "..."}],
    "edges": [{"src": "...", "rel": "IMPORTS", "dst": "..."}]
  },
  "notes": ["Short, actionable notes"],
  "limits": {"budget": 8000, "used_estimate": 7420}
}

Claude Code integration

Default workflow

Configure Claude Code to call repo_context_get at the start of most tasks.

Use returned focus and snippets as the primary context.

Use repo_snippet for follow-ups.


Failure modes

If index missing: repo_context_get should return a response that instructs Claude Code to call repo_index first.

If budget too small: return a smaller pack with a hint that the model should request specific snippets.


Configuration

File based config

.mcp-codegraph.yml at repo root.

Options:

include and exclude globs

language enable list

depth defaults

budget defaults

storage location

indexing level



Security and safety

Local only, no network calls required.

Do not execute repo code.

Treat repository content as untrusted input.

Protect against path traversal in snippet requests.

Limit file sizes and snippet sizes.


Observability

Structured logs for:

indexing duration

files indexed count

retrieval duration

snippet counts

cache hits


Optional metrics endpoint if running via HTTP transport.


Testing

Unit tests

parsers: import extraction, symbol extraction

incremental index: update and deletion behaviour

retrieval: candidate discovery and ranking determinism

tool layer: input validation, budget enforcement


Integration tests

run against a fixture repo

ensure stable context bundle output for given tasks


Roadmap

Phase 1: MVP (offline useful)

SQLite storage

TS/JS parser via Tree-sitter

Tools: status, index, search, snippet, context_get

Incremental indexing


Phase 2: Accuracy and scale

references extraction

graph_query tool

better ranking

optional embeddings


Phase 3: Visualisation

subgraph viewer UI

filters and node detail panel


Acceptance criteria

On a fresh repo, repo_index(full) produces file and symbol counts and import edges.

For a typical change request, repo_context_get returns a context bundle that includes:

at least one clear entry point

direct dependencies needed to understand the change

snippets, not entire repo

a subgraph explaining the selection


After editing 1 to 5 files, repo_index(incremental) updates nodes and edges correctly.

No network access is required to index and retrieve context.
