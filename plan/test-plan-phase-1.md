# Test Plan: Phase 1 - MVP

## Prerequisites
- Node.js 20+
- Fixture repo at `fixtures/sample-repo/`
- All dependencies installed (`npm install`)

## Fixture Repo Structure
```
fixtures/sample-repo/
├── package.json
├── src/
│   ├── index.ts            # Entry point, imports from services
│   ├── types.ts            # Shared type definitions
│   ├── services/
│   │   ├── index.ts        # Barrel re-export
│   │   ├── auth.ts         # AuthService class, imports User model
│   │   └── user.ts         # UserService class
│   ├── models/
│   │   ├── user.ts         # User interface + class
│   │   └── session.ts      # Session class extends BaseModel
│   ├── controllers/
│   │   └── auth-controller.ts  # Uses AuthService
│   ├── utils/
│   │   └── helpers.ts      # Utility functions
│   └── legacy/
│       └── old-module.js   # CommonJS require/exports
├── node_modules/           # (ignored)
│   └── some-dep/
└── .gitignore
```

## Test Cases

### Phase 1A: Storage

#### TC-1A.1: Database Initialization
**Steps:**
1. Create Database instance with temp path
2. Check tables exist

**Expected:** All 6 tables created (repos, files, symbols, modules, edges, search_index)

**Status:** ⬜ Not tested

#### TC-1A.2: Repo CRUD
**Steps:**
1. Insert repo record
2. Read back by path
3. Update timestamp
4. Verify update

**Expected:** All operations succeed with correct data

**Status:** ⬜ Not tested

#### TC-1A.3: File CRUD with Foreign Keys
**Steps:**
1. Insert repo, then insert file
2. Query files by repo_id
3. Update file sha256
4. Delete file, verify cascade

**Expected:** Foreign key relationships enforced

**Status:** ⬜ Not tested

#### TC-1A.4: FTS5 Search
**Steps:**
1. Insert search entries for files and symbols
2. Search for partial match
3. Search for exact name
4. Search for non-existent term

**Expected:** Relevant results returned, empty for non-match

**Status:** ⬜ Not tested

#### TC-1A.5: Edge Queries
**Steps:**
1. Insert nodes and edges
2. Query outgoing edges from a node
3. Query incoming edges to a node
4. Query neighbours at depth 2

**Expected:** Correct traversal results

**Status:** ⬜ Not tested

---

### Phase 1B: File Discovery + Parsing

#### TC-1B.1: File Walker - Basic Discovery
**Steps:**
1. Run walker on fixture repo
2. Check discovered files list

**Expected:** All .ts/.js files found, node_modules excluded, .gitignore respected

**Status:** ⬜ Not tested

#### TC-1B.2: File Walker - Ignore Patterns
**Steps:**
1. Add files to dist/, build/, .cache/
2. Run walker
3. Verify those files are excluded

**Expected:** Default ignore patterns applied

**Status:** ⬜ Not tested

#### TC-1B.3: TypeScript Import Extraction
**Steps:**
1. Parse `auth.ts` with named imports
2. Parse `index.ts` with barrel imports
3. Parse file with dynamic import

**Expected:** All import types extracted with correct source paths

**Status:** ⬜ Not tested

#### TC-1B.4: TypeScript Export Extraction
**Steps:**
1. Parse file with `export class`
2. Parse file with `export default`
3. Parse barrel file with `export * from`

**Expected:** All export types extracted with correct symbol names

**Status:** ⬜ Not tested

#### TC-1B.5: Symbol Extraction
**Steps:**
1. Parse file with classes, functions, interfaces, types, enums
2. Verify each symbol has: name, kind, line range, signature

**Expected:** All symbol types extracted with correct metadata

**Status:** ⬜ Not tested

#### TC-1B.6: JavaScript/CommonJS Parsing
**Steps:**
1. Parse `old-module.js` with `require()` and `module.exports`
2. Verify imports and exports extracted

**Expected:** CommonJS patterns handled correctly

**Status:** ⬜ Not tested

#### TC-1B.7: Import Resolution
**Steps:**
1. Resolve `'./services/auth'` from `src/index.ts`
2. Resolve `'./services'` (barrel index.ts)
3. Resolve `'express'` (external module)

**Expected:** Relative paths resolved to files, externals marked as module refs

**Status:** ⬜ Not tested

---

### Phase 1C: Indexer

#### TC-1C.1: Full Index
**Steps:**
1. Run full index on fixture repo
2. Check file count
3. Check symbol count
4. Check edge count

**Expected:** All files indexed, symbols extracted, import/define edges created

**Status:** ⬜ Not tested

#### TC-1C.2: Incremental - New File
**Steps:**
1. Full index
2. Add new file `src/services/email.ts`
3. Run incremental index
4. Verify new file + symbols indexed

**Expected:** Only new file processed, counts increase

**Status:** ⬜ Not tested

#### TC-1C.3: Incremental - Modified File
**Steps:**
1. Full index
2. Modify `src/services/auth.ts` (add a method)
3. Run incremental index
4. Verify updated symbols

**Expected:** Modified file re-parsed, old symbols removed, new symbols added

**Status:** ⬜ Not tested

#### TC-1C.4: Incremental - Deleted File
**Steps:**
1. Full index
2. Delete `src/utils/helpers.ts`
3. Run incremental index
4. Verify file, symbols, edges removed

**Expected:** Garbage collection removes all traces of deleted file

**Status:** ⬜ Not tested

#### TC-1C.5: Import Edge Correctness
**Steps:**
1. Full index
2. Query edges where rel = IMPORTS
3. Verify `auth-controller.ts` IMPORTS `auth.ts`
4. Verify `auth.ts` IMPORTS `user.ts` (model)

**Expected:** Import chain matches actual code dependencies

**Status:** ⬜ Not tested

---

### Phase 1D: Retrieval

#### TC-1D.1: Text Search
**Steps:**
1. Index fixture repo
2. Search for "AuthService"
3. Search for "auth"
4. Search for "nonexistent_xyz"

**Expected:** Relevant files found, empty for non-match

**Status:** ⬜ Not tested

#### TC-1D.2: Candidate Discovery from Task
**Steps:**
1. Index fixture repo
2. Get candidates for task: "Fix the login method in AuthService"
3. Verify auth.ts is top candidate

**Expected:** Mentioned symbols/paths discovered as candidates

**Status:** ⬜ Not tested

#### TC-1D.3: Graph Expansion
**Steps:**
1. From auth.ts as seed
2. Expand depth 1: should find user model, auth controller
3. Expand depth 2: should find session model

**Expected:** Connected nodes discovered at correct depths

**Status:** ⬜ Not tested

#### TC-1D.4: Budget Enforcement
**Steps:**
1. Get context with budget = 200 lines
2. Verify total snippet lines <= 200
3. Get context with budget = 50 lines
4. Verify fewer files included

**Expected:** Budget respected, snippets preferred over whole files

**Status:** ⬜ Not tested

#### TC-1D.5: Context Bundle Format
**Steps:**
1. Get context bundle for a task
2. Verify JSON structure matches spec
3. Check all required fields present

**Expected:** Bundle matches spec format exactly

**Status:** ⬜ Not tested

---

### Phase 1E: MCP Server + Tools

#### TC-1E.1: repo_status - Not Indexed
**Steps:**
1. Call repo_status on a fresh repo (no index)

**Expected:** Returns `{ status: "not_indexed" }` or similar

**Status:** ⬜ Not tested

#### TC-1E.2: repo_index - Full
**Steps:**
1. Call repo_index(repo_path, mode="full", level=0)
2. Verify returns summary with counts

**Expected:** Index created, summary returned

**Status:** ⬜ Not tested

#### TC-1E.3: repo_status - After Index
**Steps:**
1. Call repo_status after successful index

**Expected:** Returns counts, last indexed time, status "indexed"

**Status:** ⬜ Not tested

#### TC-1E.4: repo_search
**Steps:**
1. Index repo
2. Call repo_search(query="auth")
3. Verify results include auth-related files

**Expected:** Search results with file paths and excerpts

**Status:** ⬜ Not tested

#### TC-1E.5: repo_snippet
**Steps:**
1. Call repo_snippet(file_path="src/services/auth.ts", start_line=1, end_line=20)
2. Verify returns correct lines

**Expected:** Snippet text matches file content

**Status:** ⬜ Not tested

#### TC-1E.6: repo_snippet - Path Traversal Protection
**Steps:**
1. Call repo_snippet(file_path="../../etc/passwd")

**Expected:** Returns error, does not read file outside repo

**Status:** ⬜ Not tested

#### TC-1E.7: repo_context_get
**Steps:**
1. Index repo
2. Call repo_context_get(task="Fix the login method in AuthService", budget=8000)
3. Verify context bundle returned

**Expected:** Context bundle with focus items, snippets, subgraph

**Status:** ⬜ Not tested

#### TC-1E.8: repo_context_get - Not Indexed
**Steps:**
1. Call repo_context_get on unindexed repo

**Expected:** Returns instruction to call repo_index first

**Status:** ⬜ Not tested

#### TC-1E.9: Full Workflow
**Steps:**
1. repo_status -> not indexed
2. repo_index(full) -> success
3. repo_status -> indexed with counts
4. repo_search("auth") -> results
5. repo_snippet(first result) -> code
6. repo_context_get("Fix login") -> bundle
7. Modify a file
8. repo_index(incremental) -> updated
9. repo_context_get("Fix login") -> updated bundle

**Expected:** Complete workflow succeeds end-to-end

**Status:** ⬜ Not tested
