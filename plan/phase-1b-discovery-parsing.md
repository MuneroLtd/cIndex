# Phase 1B: File Discovery + Parsing

## Overview
Implement file discovery (gitignore-aware) and Tree-sitter parsing for TypeScript/JavaScript to extract imports, exports, and symbol definitions.

## Goals
- Walk a repo respecting .gitignore and default ignore patterns
- Detect TS/JS files by extension
- Parse AST and extract: imports, exports, symbol definitions
- Return structured data ready for the indexer

## Implementation Steps

### 1. File Walker (`src/indexer/walker.ts`)
- Accept repo root path
- Read `.gitignore` files (nested supported)
- Apply default ignore patterns: `node_modules`, `vendor`, `dist`, `build`, `.next`, `.cache`, `coverage`, `.git`
- Read `.mcp-codegraph.yml` if present for custom include/exclude globs
- Return list of `{ path, lang, stat }` for each discovered file
- Language detection by extension:
  - `.ts`, `.tsx` -> typescript
  - `.js`, `.jsx`, `.mjs`, `.cjs` -> javascript
  - Skip non-supported extensions

### 2. Tree-sitter Parser Orchestrator (`src/indexer/parser.ts`)
- Initialize Tree-sitter with language grammars
- Route files to appropriate language parser
- Return `ParseResult`: `{ imports[], exports[], symbols[] }`

### 3. TypeScript Parser (`src/indexer/parsers/typescript.ts`)
Extract from TS/TSX AST:

**Imports:**
- `import { X } from 'Y'` -> named imports
- `import X from 'Y'` -> default import
- `import * as X from 'Y'` -> namespace import
- `import 'Y'` -> side-effect import
- `import type { X } from 'Y'` -> type import
- Dynamic `import('Y')` -> dynamic import

**Exports:**
- `export function X` / `export class X` / `export const X`
- `export default X`
- `export { X, Y }`
- `export { X } from 'Y'` -> re-export
- `export * from 'Y'` -> barrel re-export

**Symbols:**
- Functions (name, params signature, line range)
- Classes (name, extends, implements, line range)
- Interfaces (name, extends, line range)
- Type aliases (name, line range)
- Enums (name, line range)
- Variables/constants (name, line range)
- Methods within classes (name, params, line range)

### 4. JavaScript Parser (`src/indexer/parsers/javascript.ts`)
Same as TypeScript minus type-specific constructs. Also handles:
- `require('Y')` -> CommonJS import
- `module.exports = X` -> CommonJS export
- `exports.X = ...` -> named CommonJS export

### 5. Import Resolution (`src/indexer/resolver.ts`)
- Resolve relative imports (`./foo`, `../bar`) to file paths
- Try extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `/index.ts`, `/index.js`
- Mark external imports (from `node_modules`) as module references
- Skip path alias resolution in Phase 1 (log warning)

### 6. Fixture Files for Testing
Create `fixtures/sample-repo/` with various patterns:
- Simple imports/exports
- Re-exports and barrel files
- Class with extends/implements
- CommonJS patterns
- Mixed TS/JS

### 7. Unit Tests
- Walker: discovers correct files, respects ignores
- TS parser: extracts imports, exports, symbols from fixture files
- JS parser: handles CommonJS + ESM
- Resolver: resolves relative paths correctly

## Files to Create
- `src/indexer/walker.ts`
- `src/indexer/parser.ts`
- `src/indexer/parsers/typescript.ts`
- `src/indexer/parsers/javascript.ts`
- `src/indexer/resolver.ts`
- `fixtures/sample-repo/` (multiple fixture files)
- `tests/indexer/walker.test.ts`
- `tests/indexer/parser.test.ts`
- `tests/indexer/resolver.test.ts`
