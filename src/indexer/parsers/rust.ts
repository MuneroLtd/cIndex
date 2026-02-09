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

/** Helper: get the first line of the node text for use as a signature, truncated to 200 chars. */
function signatureOf(node: Parser.SyntaxNode): string {
  const firstLine = node.text.split("\n")[0];
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
}

/** Helper: check if a node has a `visibility_modifier` child whose text starts with "pub". */
function isPub(node: Parser.SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "visibility_modifier" && child.text.startsWith("pub")) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Walk a use_tree (or scoped_use_list, use_as_clause, etc.) and collect the
 * path prefix and leaf names. Rust use trees are recursive, so this function
 * builds up a path prefix as it descends.
 */
function collectUseTree(
  node: Parser.SyntaxNode,
  prefixParts: string[],
  results: ParsedImport[],
): void {
  switch (node.type) {
    case "use_declaration": {
      // The root; descend into the child use tree.
      for (const child of node.namedChildren) {
        if (child.type === "visibility_modifier") continue;
        collectUseTree(child, prefixParts, results);
      }
      break;
    }

    case "scoped_identifier": {
      // e.g. `std::collections::HashMap`
      // `path` field is the left side, `name` field is the right side.
      const pathNode = node.childForFieldName("path");
      const nameNode = node.childForFieldName("name");
      const pathText = pathNode ? pathNode.text : "";
      const fullPrefix = [...prefixParts, pathText].filter(Boolean).join("::");
      const name = nameNode ? nameNode.text : "";
      results.push({
        source: fullPrefix,
        names: name ? [name] : [],
        isDefault: false,
        isNamespace: false,
        isTypeOnly: false,
        isDynamic: false,
      });
      break;
    }

    case "scoped_use_list": {
      // e.g. `std::io::{Read, Write}` or `std::{io, fs}`
      // `path` field is the prefix, then a `use_list` child.
      const pathNode = node.childForFieldName("path");
      const newPrefix = pathNode
        ? [...prefixParts, pathNode.text]
        : [...prefixParts];
      const useList = node.children.find((c) => c.type === "use_list");
      if (useList) {
        collectUseList(useList, newPrefix, results);
      }
      break;
    }

    case "use_as_clause": {
      // e.g. `use std::io::Read as IoRead;`
      // The path child is a scoped_identifier or identifier.
      const pathChild = node.childForFieldName("path");
      if (pathChild) {
        // Extract the source and the final name from the path.
        if (pathChild.type === "scoped_identifier") {
          const scopedPath = pathChild.childForFieldName("path");
          const scopedName = pathChild.childForFieldName("name");
          const fullPrefix = [...prefixParts, scopedPath ? scopedPath.text : ""]
            .filter(Boolean)
            .join("::");
          const name = scopedName ? scopedName.text : "";
          results.push({
            source: fullPrefix,
            names: name ? [name] : [],
            isDefault: false,
            isNamespace: false,
            isTypeOnly: false,
            isDynamic: false,
          });
        } else if (pathChild.type === "identifier") {
          const fullPrefix = prefixParts.join("::");
          results.push({
            source: fullPrefix || pathChild.text,
            names: fullPrefix ? [pathChild.text] : [],
            isDefault: false,
            isNamespace: false,
            isTypeOnly: false,
            isDynamic: false,
          });
        } else {
          // Fallback: treat full path text as source
          const fullText = pathChild.text;
          const lastSep = fullText.lastIndexOf("::");
          if (lastSep >= 0) {
            results.push({
              source: fullText.slice(0, lastSep),
              names: [fullText.slice(lastSep + 2)],
              isDefault: false,
              isNamespace: false,
              isTypeOnly: false,
              isDynamic: false,
            });
          } else {
            results.push({
              source: fullText,
              names: [],
              isDefault: false,
              isNamespace: false,
              isTypeOnly: false,
              isDynamic: false,
            });
          }
        }
      }
      break;
    }

    case "use_wildcard": {
      // e.g. `use std::io::*;`
      // The path is in the parent scoped structure or in a path child.
      const pathNode2 = node.childForFieldName("path") ?? node.children.find(
        (c) => c.type === "scoped_identifier" || c.type === "identifier" || c.type === "crate" || c.type === "self" || c.type === "super",
      );
      if (pathNode2) {
        const fullPrefix = [...prefixParts, pathNode2.text]
          .filter(Boolean)
          .join("::");
        results.push({
          source: fullPrefix,
          names: [],
          isDefault: false,
          isNamespace: true,
          isTypeOnly: false,
          isDynamic: false,
        });
      } else {
        // Wildcard with parent prefix only
        const fullPrefix = prefixParts.filter(Boolean).join("::");
        results.push({
          source: fullPrefix,
          names: [],
          isDefault: false,
          isNamespace: true,
          isTypeOnly: false,
          isDynamic: false,
        });
      }
      break;
    }

    case "identifier":
    case "crate":
    case "self":
    case "super": {
      // Simple import: `use helper;` or within a list
      const fullPrefix = prefixParts.filter(Boolean).join("::");
      if (fullPrefix) {
        results.push({
          source: fullPrefix,
          names: [node.text],
          isDefault: false,
          isNamespace: false,
          isTypeOnly: false,
          isDynamic: false,
        });
      } else {
        // Bare identifier at the top level
        results.push({
          source: node.text,
          names: [],
          isDefault: false,
          isNamespace: false,
          isTypeOnly: false,
          isDynamic: false,
        });
      }
      break;
    }

    default: {
      // For any other node type, try descending into named children.
      for (const child of node.namedChildren) {
        collectUseTree(child, prefixParts, results);
      }
      break;
    }
  }
}

/**
 * Process a `use_list` node which is the `{A, B, C}` part of a use statement.
 * Each child in the list is a use tree entry.
 */
function collectUseList(
  useList: Parser.SyntaxNode,
  prefixParts: string[],
  results: ParsedImport[],
): void {
  for (const child of useList.namedChildren) {
    switch (child.type) {
      case "identifier":
      case "self":
      case "super":
      case "crate": {
        const fullPrefix = prefixParts.filter(Boolean).join("::");
        results.push({
          source: fullPrefix,
          names: [child.text],
          isDefault: false,
          isNamespace: false,
          isTypeOnly: false,
          isDynamic: false,
        });
        break;
      }

      case "use_as_clause": {
        const pathChild = child.childForFieldName("path");
        if (pathChild) {
          const fullPrefix = prefixParts.filter(Boolean).join("::");
          results.push({
            source: fullPrefix,
            names: [pathChild.text],
            isDefault: false,
            isNamespace: false,
            isTypeOnly: false,
            isDynamic: false,
          });
        }
        break;
      }

      case "use_wildcard": {
        const fullPrefix = prefixParts.filter(Boolean).join("::");
        results.push({
          source: fullPrefix,
          names: [],
          isDefault: false,
          isNamespace: true,
          isTypeOnly: false,
          isDynamic: false,
        });
        break;
      }

      case "scoped_identifier": {
        // Nested scoped path inside a list, e.g., `use std::{io::Read, fs::File}`
        const pathNode = child.childForFieldName("path");
        const nameNode = child.childForFieldName("name");
        const nestedPrefix = [...prefixParts, pathNode ? pathNode.text : ""]
          .filter(Boolean)
          .join("::");
        const name = nameNode ? nameNode.text : "";
        results.push({
          source: nestedPrefix,
          names: name ? [name] : [],
          isDefault: false,
          isNamespace: false,
          isTypeOnly: false,
          isDynamic: false,
        });
        break;
      }

      case "scoped_use_list": {
        // Nested braced list, e.g., `use std::{io::{Read, Write}, fs}`
        const pathNode = child.childForFieldName("path");
        const newPrefix = pathNode
          ? [...prefixParts, pathNode.text]
          : [...prefixParts];
        const nestedList = child.children.find((c) => c.type === "use_list");
        if (nestedList) {
          collectUseList(nestedList, newPrefix, results);
        }
        break;
      }

      default: {
        collectUseTree(child, prefixParts, results);
        break;
      }
    }
  }
}

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const useDeclarations = rootNode.descendantsOfType("use_declaration");

  for (const useDecl of useDeclarations) {
    collectUseTree(useDecl, [], imports);
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

/**
 * Extract the type name from an `impl_item` node.
 * The type being implemented is in the `type` field.
 * If there's a trait, the structure is: `impl Trait for Type`.
 */
function getImplInfo(node: Parser.SyntaxNode): {
  typeName: string;
  traitName: string | null;
} {
  const typeNode = node.childForFieldName("type");
  const traitNode = node.childForFieldName("trait");

  let typeName = "";
  let traitName: string | null = null;

  if (traitNode && typeNode) {
    // `impl Trait for Type` -- trait field is the trait, type field is the target type
    traitName = traitNode.text;
    typeName = typeNode.text;
  } else if (typeNode) {
    // `impl Type` -- no trait
    typeName = typeNode.text;
  }

  // Strip generic parameters for cleaner names
  const angleBracketIdx = typeName.indexOf("<");
  if (angleBracketIdx > 0) {
    typeName = typeName.slice(0, angleBracketIdx);
  }

  if (traitName) {
    const traitAngleIdx = traitName.indexOf("<");
    if (traitAngleIdx > 0) {
      traitName = traitName.slice(0, traitAngleIdx);
    }
  }

  return { typeName, traitName };
}

function extractSymbols(rootNode: Parser.SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  // Functions at any level (but we handle impl methods separately)
  const functionItems = rootNode.descendantsOfType("function_item");
  for (const node of functionItems) {
    // Skip functions that are inside an impl_item; they'll be handled as methods.
    if (isInsideImpl(node)) continue;

    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;

    symbols.push({
      kind: "function",
      name: nameNode.text,
      signature: signatureOf(node),
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column + 1,
      extends: null,
      implements: [],
    });
  }

  // Structs
  const structItems = rootNode.descendantsOfType("struct_item");
  for (const node of structItems) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;

    symbols.push({
      kind: "struct",
      name: nameNode.text,
      signature: signatureOf(node),
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column + 1,
      extends: null,
      implements: collectTraitsForType(rootNode, nameNode.text),
    });
  }

  // Enums
  const enumItems = rootNode.descendantsOfType("enum_item");
  for (const node of enumItems) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;

    symbols.push({
      kind: "enum",
      name: nameNode.text,
      signature: signatureOf(node),
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column + 1,
      extends: null,
      implements: collectTraitsForType(rootNode, nameNode.text),
    });
  }

  // Traits
  const traitItems = rootNode.descendantsOfType("trait_item");
  for (const node of traitItems) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;

    symbols.push({
      kind: "trait",
      name: nameNode.text,
      signature: signatureOf(node),
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column + 1,
      extends: null,
      implements: [],
    });
  }

  // Impl blocks -- extract methods inside
  const implItems = rootNode.descendantsOfType("impl_item");
  for (const node of implItems) {
    const { typeName, traitName } = getImplInfo(node);
    if (!typeName) continue;

    // Find the declaration_list (body of the impl block)
    const body = node.childForFieldName("body");
    if (!body) continue;

    for (const child of body.namedChildren) {
      if (child.type === "function_item") {
        const methodNameNode = child.childForFieldName("name");
        if (!methodNameNode) continue;

        symbols.push({
          kind: "method",
          name: `${typeName}.${methodNameNode.text}`,
          signature: signatureOf(child),
          startLine: child.startPosition.row + 1,
          startCol: child.startPosition.column + 1,
          endLine: child.endPosition.row + 1,
          endCol: child.endPosition.column + 1,
          extends: null,
          implements: traitName ? [traitName] : [],
        });
      }
    }
  }

  // Type aliases
  const typeItems = rootNode.descendantsOfType("type_item");
  for (const node of typeItems) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;

    symbols.push({
      kind: "type",
      name: nameNode.text,
      signature: signatureOf(node),
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column + 1,
      extends: null,
      implements: [],
    });
  }

  // Constants
  const constItems = rootNode.descendantsOfType("const_item");
  for (const node of constItems) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;

    symbols.push({
      kind: "constant",
      name: nameNode.text,
      signature: signatureOf(node),
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column + 1,
      extends: null,
      implements: [],
    });
  }

  // Static variables
  const staticItems = rootNode.descendantsOfType("static_item");
  for (const node of staticItems) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;

    symbols.push({
      kind: "variable",
      name: nameNode.text,
      signature: signatureOf(node),
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column + 1,
      extends: null,
      implements: [],
    });
  }

  // Modules
  const modItems = rootNode.descendantsOfType("mod_item");
  for (const node of modItems) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;

    symbols.push({
      kind: "module",
      name: nameNode.text,
      signature: signatureOf(node),
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column + 1,
      extends: null,
      implements: [],
    });
  }

  return symbols;
}

/**
 * Check if a function_item node is inside an impl_item by walking up parents.
 */
function isInsideImpl(node: Parser.SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "impl_item") {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Collect trait names from `impl Trait for TypeName` blocks in the file
 * for a given type name.
 */
function collectTraitsForType(
  rootNode: Parser.SyntaxNode,
  typeName: string,
): string[] {
  const traits: string[] = [];
  const implItems = rootNode.descendantsOfType("impl_item");

  for (const implNode of implItems) {
    const { typeName: implType, traitName } = getImplInfo(implNode);
    if (implType === typeName && traitName) {
      traits.push(traitName);
    }
  }

  return traits;
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/**
 * In Rust, `pub` items are exports. We check each extracted symbol's
 * corresponding AST node for a visibility_modifier starting with "pub".
 */
function extractExports(
  rootNode: Parser.SyntaxNode,
  symbols: ParsedSymbol[],
): ParsedExport[] {
  const exports: ParsedExport[] = [];

  // Collect all top-level and nested item declarations that could be pub.
  const exportableTypes = [
    "function_item",
    "struct_item",
    "enum_item",
    "trait_item",
    "type_item",
    "const_item",
    "static_item",
    "mod_item",
  ];

  for (const nodeType of exportableTypes) {
    const nodes = rootNode.descendantsOfType(nodeType);
    for (const node of nodes) {
      if (!isPub(node)) continue;

      // Skip function_items inside impl blocks; they are methods.
      if (nodeType === "function_item" && isInsideImpl(node)) continue;

      const nameNode = node.childForFieldName("name");
      if (!nameNode) continue;

      exports.push({
        name: nameNode.text,
        isDefault: false,
        isReExport: false,
        source: null,
      });
    }
  }

  // Also check for pub methods inside impl blocks
  const implItems = rootNode.descendantsOfType("impl_item");
  for (const implNode of implItems) {
    const { typeName } = getImplInfo(implNode);
    if (!typeName) continue;

    const body = implNode.childForFieldName("body");
    if (!body) continue;

    for (const child of body.namedChildren) {
      if (child.type === "function_item" && isPub(child)) {
        const methodNameNode = child.childForFieldName("name");
        if (!methodNameNode) continue;

        exports.push({
          name: `${typeName}.${methodNameNode.text}`,
          isDefault: false,
          isReExport: false,
          source: null,
        });
      }
    }
  }

  return exports;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Rust source string using the provided tree-sitter parse tree,
 * extracting imports, exports, and symbol declarations.
 *
 * @param source - The source code text.
 * @param filePath - File path (used for error context).
 * @param tree - The tree-sitter parse tree for the source.
 * @returns Parsed imports, exports, and symbols.
 */
export function parseRust(
  source: string,
  filePath: string,
  tree: Parser.Tree,
): ParseResult {
  try {
    const rootNode = tree.rootNode;

    const imports = extractImports(rootNode);
    const symbols = extractSymbols(rootNode);
    const exports = extractExports(rootNode, symbols);

    return { imports, exports, symbols };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cindex] Failed to parse ${filePath}: ${message}`);
    return emptyResult();
  }
}
