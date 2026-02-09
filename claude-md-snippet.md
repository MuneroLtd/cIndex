## Codebase Index (cindex)

This project is indexed with cindex (MCP codebase graph indexer).

**Workflow — do this at the start of every session:**
1. Call `repo_status` with this project's root path to check if the index exists
2. If not indexed or if many files have changed, call `repo_index` to update (takes ~2s)
3. Before starting any coding task, call `repo_context_get` with a description of the task to get relevant files, symbols, and code snippets ranked by importance
4. Use `repo_search` to find specific symbols, files, or types by keyword
5. Use `repo_snippet` to read full source of files identified by search or context

This gives you a map of the codebase's dependency graph so you can make targeted, informed changes instead of reading files blindly.
