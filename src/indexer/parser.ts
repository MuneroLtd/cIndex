import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Rust from "tree-sitter-rust";
import PHP from "tree-sitter-php";
import Java from "tree-sitter-java";
import Ruby from "tree-sitter-ruby";
import C from "tree-sitter-c";
import Cpp from "tree-sitter-cpp";
import CSharp from "tree-sitter-c-sharp";
import { extname } from "node:path";
import type { Language, ParseResult } from "../types.js";
import { parseTypeScript } from "./parsers/typescript.js";
import { parseJavaScript } from "./parsers/javascript.js";
import { parsePython } from "./parsers/python.js";
import { parseGo } from "./parsers/go.js";
import { parseRust } from "./parsers/rust.js";
import { parsePHP } from "./parsers/php.js";
import { parseJava } from "./parsers/java.js";
import { parseRuby } from "./parsers/ruby.js";
import { parseC } from "./parsers/c.js";
import { parseCpp } from "./parsers/cpp.js";
import { parseCSharp } from "./parsers/csharp.js";

// ---------------------------------------------------------------------------
// Initialise parsers -- one per grammar variant
// ---------------------------------------------------------------------------

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx);

const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

const pythonParser = new Parser();
pythonParser.setLanguage(Python);

const goParser = new Parser();
goParser.setLanguage(Go);

const rustParser = new Parser();
rustParser.setLanguage(Rust);

const phpParser = new Parser();
// tree-sitter-php exports { php, php_only } — use php which includes HTML
phpParser.setLanguage((PHP as any).php ?? PHP);

const javaParser = new Parser();
javaParser.setLanguage(Java);

const rubyParser = new Parser();
rubyParser.setLanguage(Ruby);

const cParser = new Parser();
cParser.setLanguage(C);

const cppParser = new Parser();
cppParser.setLanguage(Cpp);

const csharpParser = new Parser();
csharpParser.setLanguage(CSharp);

/** Select the correct tree-sitter Parser instance for a given file. */
function parserForFile(filePath: string, lang: Language): Parser {
  switch (lang) {
    case "typescript": {
      const ext = extname(filePath).toLowerCase();
      return ext === ".tsx" ? tsxParser : tsParser;
    }
    case "javascript":
      return jsParser;
    case "python":
      return pythonParser;
    case "go":
      return goParser;
    case "rust":
      return rustParser;
    case "php":
      return phpParser;
    case "java":
      return javaParser;
    case "ruby":
      return rubyParser;
    case "c":
      return cParser;
    case "cpp":
      return cppParser;
    case "csharp":
      return csharpParser;
  }
}

/** Return an empty ParseResult (used as fallback on errors). */
function emptyResult(): ParseResult {
  return { imports: [], exports: [], symbols: [] };
}

// ---------------------------------------------------------------------------
// tree-sitter 0.21.x workaround: string input fails at >= 32768 bytes due to
// a signed 16-bit overflow in the native binding. The callback form of
// parser.parse() does not have this limit.
// ---------------------------------------------------------------------------

const TREE_SITTER_STRING_LIMIT = 32768;

function treeSitterParse(parser: Parser, source: string): Parser.Tree {
  if (source.length < TREE_SITTER_STRING_LIMIT) {
    return parser.parse(source);
  }
  // Use callback form for large files
  return parser.parse((index: number) => source.slice(index, index + 4096));
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
 */
export function parseFile(
  source: string,
  filePath: string,
  lang: Language,
): ParseResult {
  try {
    const parser = parserForFile(filePath, lang);
    const tree = treeSitterParse(parser, source);

    if (!tree || !tree.rootNode) {
      console.error(`[cindex] tree-sitter returned empty tree for ${filePath}`);
      return emptyResult();
    }

    switch (lang) {
      case "typescript":
        return parseTypeScript(source, filePath, tree);
      case "javascript":
        return parseJavaScript(source, filePath, tree);
      case "python":
        return parsePython(source, filePath, tree);
      case "go":
        return parseGo(source, filePath, tree);
      case "rust":
        return parseRust(source, filePath, tree);
      case "php":
        return parsePHP(source, filePath, tree);
      case "java":
        return parseJava(source, filePath, tree);
      case "ruby":
        return parseRuby(source, filePath, tree);
      case "c":
        return parseC(source, filePath, tree);
      case "cpp":
        return parseCpp(source, filePath, tree);
      case "csharp":
        return parseCSharp(source, filePath, tree);
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[cindex] Parse error for ${filePath}: ${message}`);
    return emptyResult();
  }
}
