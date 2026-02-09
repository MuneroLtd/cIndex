import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
import { extname } from "node:path";
import type { Language, ParseResult } from "../types.js";
import { parseTypeScript } from "./parsers/typescript.js";
import { parseJavaScript } from "./parsers/javascript.js";

// ---------------------------------------------------------------------------
// Initialise parsers -- one per grammar variant
// ---------------------------------------------------------------------------

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx);

const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

/** Select the correct tree-sitter Parser instance for a given file. */
function parserForFile(filePath: string, lang: Language): Parser {
  if (lang === "typescript") {
    const ext = extname(filePath).toLowerCase();
    return ext === ".tsx" ? tsxParser : tsParser;
  }
  return jsParser;
}

/** Return an empty ParseResult (used as fallback on errors). */
function emptyResult(): ParseResult {
  return { imports: [], exports: [], symbols: [] };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a source file and extract imports, exports, and symbol declarations.
 *
 * Routes to the appropriate language-specific parser based on the `lang`
 * parameter. The tree-sitter grammar is selected by file extension within
 * each language (e.g. `.tsx` uses the TSX grammar).
 *
 * @param source   - The raw source code string.
 * @param filePath - Absolute or relative file path (used for grammar selection
 *                   and error messages).
 * @param lang     - The language identifier for the file.
 * @returns A ParseResult containing all discovered imports, exports, and symbols.
 */
export function parseFile(
  source: string,
  filePath: string,
  lang: Language,
): ParseResult {
  try {
    const parser = parserForFile(filePath, lang);
    const tree = parser.parse(source);

    if (!tree || !tree.rootNode) {
      console.error(`[cindex] tree-sitter returned empty tree for ${filePath}`);
      return emptyResult();
    }

    switch (lang) {
      case "typescript":
        return parseTypeScript(source, filePath, tree);
      case "javascript":
        return parseJavaScript(source, filePath, tree);
      default: {
        // Exhaustive check -- should never happen with the Language type
        const _exhaustive: never = lang;
        console.error(`[cindex] Unsupported language: ${_exhaustive}`);
        return emptyResult();
      }
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[cindex] Parse error for ${filePath}: ${message}`);
    return emptyResult();
  }
}
