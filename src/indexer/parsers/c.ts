import type Parser from "tree-sitter";
import type {
  ParseResult,
  ParsedImport,
  ParsedExport,
  ParsedSymbol,
  SymbolKind,
} from "../../types.js";

/** Helper: create an empty ParseResult. */
function emptyResult(): ParseResult {
  return { imports: [], exports: [], symbols: [] };
}

/** Helper: get the first line of the node text, truncated to 200 chars. */
function signatureOf(node: Parser.SyntaxNode): string {
  const firstLine = node.text.split("\n")[0];
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
}

/**
 * Helper: strip surrounding angle brackets or double quotes from an include
 * path string.
 *
 * `<stdio.h>` -> `stdio.h`
 * `"myheader.h"` -> `myheader.h`
 */
function stripIncludePath(text: string): string {
  if (text.startsWith("<") && text.endsWith(">")) {
    return text.slice(1, -1);
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Helper: extract the base name from an include path, without extension.
 *
 * `stdio.h` -> `stdio`
 * `sys/types.h` -> `types`
 * `myheader.h` -> `myheader`
 */
function baseNameWithoutExt(includePath: string): string {
  // Take the last segment after any slashes
  const segments = includePath.split("/");
  const filename = segments[segments.length - 1];
  // Remove extension
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex > 0) {
    return filename.slice(0, dotIndex);
  }
  return filename;
}

/**
 * Helper: check if a top-level declaration has the `static` storage class
 * specifier, meaning it has file-local linkage and should not be treated
 * as exported.
 */
function hasStaticSpecifier(node: Parser.SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "storage_class_specifier" && child.text === "static") {
      return true;
    }
  }
  return false;
}

/**
 * Helper: recursively unwrap a declarator node to find the identifier name.
 * C declarators can be nested: pointer_declarator -> function_declarator ->
 * parenthesized_declarator -> identifier. This function walks down to find
 * the actual identifier text.
 */
function getDeclaratorName(node: Parser.SyntaxNode): string | null {
  if (node.type === "identifier") {
    return node.text;
  }

  // function_declarator has a `declarator` field which holds the name
  const declaratorChild = node.childForFieldName("declarator");
  if (declaratorChild) {
    return getDeclaratorName(declaratorChild);
  }

  // pointer_declarator: the declarator is the first non-"*" child
  // parenthesized_declarator: unwrap parentheses
  // array_declarator: has a `declarator` field
  for (const child of node.children) {
    if (
      child.type === "identifier" ||
      child.type === "function_declarator" ||
      child.type === "pointer_declarator" ||
      child.type === "parenthesized_declarator" ||
      child.type === "array_declarator"
    ) {
      return getDeclaratorName(child);
    }
  }

  return null;
}

/**
 * Helper: check if a declarator node contains a function_declarator,
 * meaning this declaration is a function prototype rather than a variable.
 */
function isFunctionPrototype(declaratorNode: Parser.SyntaxNode): boolean {
  if (declaratorNode.type === "function_declarator") {
    return true;
  }
  for (const child of declaratorNode.children) {
    if (isFunctionPrototype(child)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
  const imports: ParsedImport[] = [];

  const includeDirectives = rootNode.descendantsOfType("preproc_include");
  for (const includeNode of includeDirectives) {
    const parsed = parseIncludeDirective(includeNode);
    if (parsed) {
      imports.push(parsed);
    }
  }

  return imports;
}

function parseIncludeDirective(
  node: Parser.SyntaxNode,
): ParsedImport | null {
  // The preproc_include node has a `path` field which is either a
  // `system_lib_string` (angle brackets) or a `string_literal` (quotes).
  const pathNode = node.childForFieldName("path");
  if (!pathNode) return null;

  const rawPath = pathNode.text;
  const source = stripIncludePath(rawPath);
  const name = baseNameWithoutExt(source);

  return {
    source,
    names: [name],
    isDefault: true,
    isNamespace: false,
    isTypeOnly: false,
    isDynamic: false,
  };
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

function extractSymbols(rootNode: Parser.SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  // Process only top-level children to avoid pulling in nested declarations.
  for (const node of rootNode.children) {
    switch (node.type) {
      case "function_definition":
        {
          const sym = parseFunctionDefinition(node);
          if (sym) symbols.push(sym);
        }
        break;

      case "declaration":
        {
          const syms = parseDeclaration(node);
          symbols.push(...syms);
        }
        break;

      case "type_definition":
        {
          const sym = parseTypeDefinition(node);
          if (sym) symbols.push(sym);
        }
        break;

      case "preproc_def":
        {
          const sym = parsePreprocDef(node);
          if (sym) symbols.push(sym);
        }
        break;

      case "preproc_function_def":
        {
          const sym = parsePreprocFunctionDef(node);
          if (sym) symbols.push(sym);
        }
        break;

      default:
        break;
    }
  }

  return symbols;
}

/**
 * Parse a function_definition node.
 * Structure: `type declarator body`
 * The declarator is a function_declarator whose own declarator field is the
 * function name identifier (possibly wrapped in pointer_declarator, etc).
 */
function parseFunctionDefinition(
  node: Parser.SyntaxNode,
): ParsedSymbol | null {
  const declaratorNode = node.childForFieldName("declarator");
  if (!declaratorNode) return null;

  const name = getDeclaratorName(declaratorNode);
  if (!name) return null;

  return {
    kind: "function",
    name,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

/**
 * Parse a top-level `declaration` node. This could be:
 * - A function prototype: `int foo(int x);`
 * - A variable declaration: `int x;` or `int x = 5;`
 * - A struct/enum declaration without typedef: `struct Foo { ... };`
 *
 * The tree-sitter C grammar represents declarations as:
 *   declaration -> type_specifier declarator ("," declarator)* ";"
 */
function parseDeclaration(node: Parser.SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  // Check for standalone struct or enum specifiers inside the declaration.
  // e.g., `struct Foo { int x; };` (no variable declarator)
  const typeNode = node.childForFieldName("type");
  if (typeNode) {
    if (typeNode.type === "struct_specifier") {
      const structSym = parseStructSpecifier(typeNode, node);
      if (structSym) symbols.push(structSym);
    } else if (typeNode.type === "enum_specifier") {
      const enumSym = parseEnumSpecifier(typeNode, node);
      if (enumSym) symbols.push(enumSym);
    }
  }

  // Process declarators. A declaration can have multiple declarators
  // separated by commas: `int a, b, c;`
  const declaratorNode = node.childForFieldName("declarator");
  if (declaratorNode) {
    if (isFunctionPrototype(declaratorNode)) {
      // Function prototype / forward declaration
      const name = getDeclaratorName(declaratorNode);
      if (name) {
        symbols.push({
          kind: "function",
          name,
          signature: signatureOf(node),
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column + 1,
          extends: null,
          implements: [],
        });
      }
    } else {
      // Variable declaration
      const name = getDeclaratorName(declaratorNode);
      if (name) {
        symbols.push({
          kind: "variable",
          name,
          signature: signatureOf(node),
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column + 1,
          extends: null,
          implements: [],
        });
      }
    }
  }

  // Handle additional declarators in multi-variable declarations.
  // tree-sitter may represent `int a, b;` with multiple declarator children
  // beyond the first field-named one, or via an init_declarator_list.
  // We scan all children that are init_declarator or plain declarator types
  // that are not the primary field-named declarator.
  for (const child of node.children) {
    if (child === declaratorNode) continue;
    if (
      child.type === "init_declarator" ||
      child.type === "identifier" ||
      child.type === "pointer_declarator" ||
      child.type === "array_declarator"
    ) {
      const name = getDeclaratorName(child);
      if (name) {
        const isFnProto = isFunctionPrototype(child);
        symbols.push({
          kind: isFnProto ? "function" : "variable",
          name,
          signature: signatureOf(node),
          startLine: node.startPosition.row + 1,
          startCol: node.startPosition.column + 1,
          endLine: node.endPosition.row + 1,
          endCol: node.endPosition.column + 1,
          extends: null,
          implements: [],
        });
      }
    }
  }

  return symbols;
}

/**
 * Parse a struct_specifier node.
 * Structure: `struct name { field_declaration_list }`
 * The struct may or may not have a name (anonymous structs in typedefs).
 */
function parseStructSpecifier(
  specNode: Parser.SyntaxNode,
  parentNode: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode = specNode.childForFieldName("name");
  if (!nameNode) return null;

  return {
    kind: "struct",
    name: nameNode.text,
    signature: signatureOf(parentNode),
    startLine: parentNode.startPosition.row + 1,
    startCol: parentNode.startPosition.column + 1,
    endLine: parentNode.endPosition.row + 1,
    endCol: parentNode.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

/**
 * Parse an enum_specifier node.
 * Structure: `enum name { enumerator_list }`
 */
function parseEnumSpecifier(
  specNode: Parser.SyntaxNode,
  parentNode: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode = specNode.childForFieldName("name");
  if (!nameNode) return null;

  return {
    kind: "enum",
    name: nameNode.text,
    signature: signatureOf(parentNode),
    startLine: parentNode.startPosition.row + 1,
    startCol: parentNode.startPosition.column + 1,
    endLine: parentNode.endPosition.row + 1,
    endCol: parentNode.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

/**
 * Parse a type_definition node (typedef).
 * Structure: `typedef type_specifier declarator ;`
 *
 * Examples:
 * - `typedef int MyInt;` -> kind: "type", name: "MyInt"
 * - `typedef struct { ... } Point;` -> kind: "type", name: "Point"
 *   Also emits a "struct" symbol if the struct has a tag name.
 * - `typedef enum Color { RED, GREEN } Color;` -> kind: "type", name: "Color"
 *   Also emits an "enum" symbol for the tag name.
 */
function parseTypeDefinition(node: Parser.SyntaxNode): ParsedSymbol | null {
  // The typedef name is in the `declarator` field.
  const declaratorNode = node.childForFieldName("declarator");
  if (!declaratorNode) return null;

  const name = getDeclaratorName(declaratorNode);
  if (!name) return null;

  // Determine the kind based on the type specifier.
  // If the underlying type is a struct or enum, we still report the typedef
  // as kind: "type". The struct/enum with a tag name, if present, will be
  // picked up separately if it appears as a standalone declaration. For
  // typedefs we always use kind: "type".
  return {
    kind: "type",
    name,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

/**
 * Parse a preproc_def node (value macro).
 * Structure: `#define NAME value`
 */
function parsePreprocDef(node: Parser.SyntaxNode): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  return {
    kind: "constant",
    name: nameNode.text,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

/**
 * Parse a preproc_function_def node (function-like macro).
 * Structure: `#define NAME(params) body`
 */
function parsePreprocFunctionDef(
  node: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  return {
    kind: "function",
    name: nameNode.text,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/**
 * In C, there is no explicit export mechanism. All top-level declarations
 * that do not have the `static` storage class specifier have external linkage
 * and are conceptually "exported" from the translation unit.
 *
 * We walk the top-level AST nodes and collect non-static function definitions,
 * function prototypes, struct/enum definitions, typedefs, and variable
 * declarations as exports. Macros (preproc_def, preproc_function_def) are
 * always exported since `static` does not apply to them.
 */
function extractExports(rootNode: Parser.SyntaxNode): ParsedExport[] {
  const exports: ParsedExport[] = [];
  const seen = new Set<string>();

  function addExport(name: string): void {
    if (seen.has(name)) return;
    seen.add(name);
    exports.push({
      name,
      isDefault: false,
      isReExport: false,
      source: null,
    });
  }

  for (const node of rootNode.children) {
    switch (node.type) {
      case "function_definition":
        {
          if (hasStaticSpecifier(node)) break;
          const declaratorNode = node.childForFieldName("declarator");
          if (declaratorNode) {
            const name = getDeclaratorName(declaratorNode);
            if (name) addExport(name);
          }
        }
        break;

      case "declaration":
        {
          if (hasStaticSpecifier(node)) break;

          // Export struct/enum tag names from standalone declarations
          const typeNode = node.childForFieldName("type");
          if (typeNode) {
            if (
              typeNode.type === "struct_specifier" ||
              typeNode.type === "enum_specifier"
            ) {
              const nameNode = typeNode.childForFieldName("name");
              if (nameNode) addExport(nameNode.text);
            }
          }

          // Export variable names / function prototype names
          const declaratorNode = node.childForFieldName("declarator");
          if (declaratorNode) {
            const name = getDeclaratorName(declaratorNode);
            if (name) addExport(name);
          }

          // Additional declarators in multi-variable declarations
          for (const child of node.children) {
            if (child === declaratorNode) continue;
            if (
              child.type === "init_declarator" ||
              child.type === "identifier" ||
              child.type === "pointer_declarator" ||
              child.type === "array_declarator"
            ) {
              const name = getDeclaratorName(child);
              if (name) addExport(name);
            }
          }
        }
        break;

      case "type_definition":
        {
          // typedefs do not have storage class specifiers in practice,
          // but we check to be safe.
          const declaratorNode = node.childForFieldName("declarator");
          if (declaratorNode) {
            const name = getDeclaratorName(declaratorNode);
            if (name) addExport(name);
          }
        }
        break;

      case "preproc_def":
        {
          const nameNode = node.childForFieldName("name");
          if (nameNode) addExport(nameNode.text);
        }
        break;

      case "preproc_function_def":
        {
          const nameNode = node.childForFieldName("name");
          if (nameNode) addExport(nameNode.text);
        }
        break;

      default:
        break;
    }
  }

  return exports;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a C source string using the provided tree-sitter parse tree,
 * extracting imports, exports, and symbol declarations.
 *
 * C does not have a module system. Imports are represented by `#include`
 * preprocessor directives, and exports are all non-static top-level
 * declarations (functions, structs, enums, typedefs, variables, macros).
 *
 * @param source - The source code text.
 * @param filePath - File path (used for error context).
 * @param tree - The tree-sitter parse tree for the source.
 * @returns Parsed imports, exports, and symbols.
 */
export function parseC(
  source: string,
  filePath: string,
  tree: Parser.Tree,
): ParseResult {
  try {
    const rootNode = tree.rootNode;

    const imports = extractImports(rootNode);
    const symbols = extractSymbols(rootNode);
    const exports = extractExports(rootNode);

    return { imports, exports, symbols };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[cindex] Failed to parse ${filePath}: ${message}`);
    return emptyResult();
  }
}
