# Phase 1E: MCP Server + Integration

## Overview
Wire everything together as an MCP server with stdio transport, implement all tool handlers, add input validation, and create integration tests.

## Goals
- Working MCP server callable by Claude Code
- All 5 Phase 1 tools implemented
- Input validation and error handling
- Integration tests with fixture repo
- Configuration and installation instructions

## Implementation Steps

### 1. MCP Server (`src/server.ts`)
- Import `@modelcontextprotocol/sdk`
- Create `Server` with metadata (name: "cindex", version)
- Register all tools with schemas
- Use `StdioServerTransport`
- Graceful shutdown handling

### 2. Tool: `repo_status` (`src/tools/repo-status.ts`)
**Input:** `{ repo_path: string }`
**Logic:**
- Check if DB exists for repo
- If not indexed: return status "not_indexed"
- If indexed: return repo id, last indexed time, file count, symbol count, edge count
**Output:** Status object

### 3. Tool: `repo_index` (`src/tools/repo-index.ts`)
**Input:** `{ repo_path: string, mode?: "full" | "incremental", level?: 0 | 1 }`
**Logic:**
- Validate repo_path exists and is a directory
- Default mode: "incremental" if already indexed, "full" if not
- Default level: 0
- Run indexer
- Return summary with counts and duration
**Output:** Index summary

### 4. Tool: `repo_search` (`src/tools/repo-search.ts`)
**Input:** `{ repo_path: string, query: string, limit?: number }`
**Logic:**
- Validate repo is indexed (suggest indexing if not)
- Run text search
- Return matched files with line numbers and excerpts
**Output:** Search results array

### 5. Tool: `repo_snippet` (`src/tools/repo-snippet.ts`)
**Input:** `{ repo_path: string, file_path: string, start_line?: number, end_line?: number }`
**Logic:**
- Validate file exists within repo (path traversal protection)
- Read file from disk (not from DB - always fresh)
- Extract requested line range
- Enforce max snippet size (default 500 lines)
**Output:** Snippet text with metadata

### 6. Tool: `repo_context_get` (`src/tools/repo-context-get.ts`)
**Input:** `{ repo_path: string, task: string, budget?: number, hints?: { paths?: string[], symbols?: string[], lang?: string } }`
**Logic:**
- If not indexed: return instruction to call repo_index first
- Run retrieval pipeline
- Return context bundle per spec format
**Output:** ContextBundle

### 7. Input Validation (`src/tools/validation.ts`)
- `repo_path`: must exist, must be directory, normalize to absolute path
- `file_path`: must be within repo (prevent path traversal with `..`)
- `budget`: positive integer, max 50000
- `query`: non-empty string, max 500 chars
- `limit`: positive integer, max 100

### 8. Error Handling
- Tool errors return structured error objects (not throw)
- Missing index: helpful message with instructions
- Parse errors: log warning, skip file, continue
- File read errors: log warning, skip

### 9. Build Configuration
- `tsup` builds to `dist/server.js`
- `package.json` bin field: `"cindex": "./dist/server.js"`
- Shebang line for direct execution

### 10. Claude Code Configuration
Create example `.mcp.json`:
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

### 11. Integration Tests
- Fixture repo with known structure
- Test full workflow: status -> index -> search -> snippet -> context_get
- Verify context bundle format matches spec
- Verify incremental index after file changes
- Verify error cases: missing repo, missing index, invalid paths

## Files to Create
- `src/server.ts`
- `src/tools/repo-status.ts`
- `src/tools/repo-index.ts`
- `src/tools/repo-search.ts`
- `src/tools/repo-snippet.ts`
- `src/tools/repo-context-get.ts`
- `src/tools/validation.ts`
- `src/tools/index.ts`
- `tests/integration/workflow.test.ts`
- `tests/integration/tools.test.ts`
