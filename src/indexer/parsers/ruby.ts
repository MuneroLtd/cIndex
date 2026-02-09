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

/** Helper: extract the text content of a string literal node (strip quotes). */
function stringLiteralValue(node: Parser.SyntaxNode): string {
  const text = node.text;
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** Helper: get the first line of the node text for use as a signature. */
function signatureOf(node: Parser.SyntaxNode): string {
  const firstLine = node.text.split("\n")[0];
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
}

/**
 * Extract the last path segment from a require source string.
 * For example: "active_support/core_ext" -> "core_ext", "json" -> "json".
 */
function lastSegment(source: string): string {
  const parts = source.split("/");
  return parts[parts.length - 1];
}

/**
 * Check whether a node is a `call` or `method_call` whose method name matches
 * one of the given names. Returns the method name if matched, null otherwise.
 *
 * In tree-sitter-ruby, `require 'json'` parses as a `call` node with:
 *   - method: identifier "require"
 *   - arguments: argument_list containing a string node
 */
function getCallMethodName(
  node: Parser.SyntaxNode,
  names: Set<string>,
): string | null {
  if (node.type !== "call" && node.type !== "method_call") {
    return null;
  }

  const methodNode = node.childForFieldName("method");
  if (methodNode && names.has(methodNode.text)) {
    return methodNode.text;
  }

  // Some grammars put the method name as the first child identifier
  for (const child of node.children) {
    if (child.type === "identifier" && names.has(child.text)) {
      return child.text;
    }
  }

  return null;
}

/**
 * Extract the first string argument from a call node.
 * Handles both parenthesized `require('json')` and bare `require 'json'` forms.
 */
function getFirstStringArg(node: Parser.SyntaxNode): string | null {
  // Check the arguments field (parenthesized form)
  const argsNode = node.childForFieldName("arguments");
  if (argsNode) {
    for (const child of argsNode.namedChildren) {
      if (child.type === "string" || child.type === "string_literal") {
        return stringLiteralValue(child);
      }
      // Handle string content nested inside a string node
      if (child.type === "string_content") {
        return child.text;
      }
    }
    // Sometimes the string is a direct child (argument_list > string)
    for (const child of argsNode.children) {
      if (child.type === "string" || child.type === "string_literal") {
        return stringLiteralValue(child);
      }
    }
  }

  // Bare form: `require 'json'` -- the string is a direct child of the call
  for (const child of node.namedChildren) {
    if (child.type === "string" || child.type === "string_literal") {
      return stringLiteralValue(child);
    }
  }

  // Also try argument_list without field name
  for (const child of node.children) {
    if (child.type === "argument_list") {
      for (const arg of child.namedChildren) {
        if (arg.type === "string" || arg.type === "string_literal") {
          return stringLiteralValue(arg);
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

const REQUIRE_METHODS = new Set(["require", "require_relative", "load"]);

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
  const imports: ParsedImport[] = [];

  // Collect all call / method_call nodes in the tree
  const callNodes = [
    ...rootNode.descendantsOfType("call"),
    ...rootNode.descendantsOfType("method_call"),
  ];

  for (const callNode of callNodes) {
    const methodName = getCallMethodName(callNode, REQUIRE_METHODS);
    if (!methodName) continue;

    const rawSource = getFirstStringArg(callNode);
    if (rawSource === null) continue;

    let source = rawSource;

    // For require_relative, ensure the path starts with "./" or "../"
    if (methodName === "require_relative") {
      if (!source.startsWith("./") && !source.startsWith("../")) {
        source = "./" + source;
      }
    }

    const name = lastSegment(source);
    const isDynamic = methodName === "load";

    imports.push({
      source,
      names: [name],
      isDefault: !isDynamic,
      isNamespace: false,
      isTypeOnly: false,
      isDynamic,
    });
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/**
 * Ruby has no explicit export system. Everything defined at the top level of
 * a file (classes, modules, methods) is accessible to code that requires it.
 * We treat all top-level classes, modules, and methods as exports.
 */
function extractExports(rootNode: Parser.SyntaxNode): ParsedExport[] {
  const exports: ParsedExport[] = [];

  for (const child of rootNode.namedChildren) {
    let name: string | null = null;

    if (child.type === "class" || child.type === "class_declaration") {
      name = getClassName(child);
    } else if (child.type === "module" || child.type === "module_declaration") {
      name = getModuleName(child);
    } else if (child.type === "method" || child.type === "method_definition") {
      name = getMethodName(child);
    } else if (child.type === "singleton_method") {
      name = getSingletonMethodName(child);
    }

    if (name) {
      exports.push({
        name,
        isDefault: false,
        isReExport: false,
        source: null,
      });
    }
  }

  return exports;
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

/**
 * Get the class name from a class node. The name is typically a `constant`
 * or `scope_resolution` child.
 */
function getClassName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  // Fallback: find the first constant child
  for (const child of node.children) {
    if (child.type === "constant" || child.type === "scope_resolution") {
      return child.text;
    }
  }
  return null;
}

/**
 * Get the superclass from a class node. The superclass is typically in the
 * `superclass` field.
 */
function getSuperclass(node: Parser.SyntaxNode): string | null {
  const superNode = node.childForFieldName("superclass");
  if (superNode) return superNode.text;

  // Some grammars wrap it in a `superclass` node type
  for (const child of node.children) {
    if (child.type === "superclass") {
      // The actual name is inside the superclass node
      for (const sc of child.namedChildren) {
        if (
          sc.type === "constant" ||
          sc.type === "scope_resolution" ||
          sc.type === "identifier"
        ) {
          return sc.text;
        }
      }
      return child.text;
    }
  }
  return null;
}

/** Get the module name from a module node. */
function getModuleName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  for (const child of node.children) {
    if (child.type === "constant" || child.type === "scope_resolution") {
      return child.text;
    }
  }
  return null;
}

/** Get the method name from a method node. */
function getMethodName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  for (const child of node.children) {
    if (child.type === "identifier") {
      return child.text;
    }
  }
  return null;
}

/** Get the name from a singleton_method node (e.g., `def self.foo`). */
function getSingletonMethodName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  // Walk children: the name is usually an identifier after `self` and `.`
  const identifiers: string[] = [];
  for (const child of node.children) {
    if (child.type === "identifier") {
      identifiers.push(child.text);
    }
  }
  // The last identifier is typically the method name
  return identifiers.length > 0 ? identifiers[identifiers.length - 1] : null;
}

/**
 * Build a ParsedSymbol from a tree-sitter node.
 */
function makeSymbol(
  kind: SymbolKind,
  name: string,
  node: Parser.SyntaxNode,
  extendsName: string | null = null,
  implementsList: string[] = [],
): ParsedSymbol {
  return {
    kind,
    name,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: extendsName,
    implements: implementsList,
  };
}

/**
 * Check whether a node is directly inside a class or module body (not nested
 * inside another class/module). Returns the enclosing class/module name or null.
 */
function getEnclosingClassName(node: Parser.SyntaxNode): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === "class" || current.type === "class_declaration") {
      return getClassName(current);
    }
    if (current.type === "module" || current.type === "module_declaration") {
      return getModuleName(current);
    }
    // If we hit the program/root, stop
    if (current.type === "program") {
      return null;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Determine if a node is a direct child of the program root (top-level).
 */
function isTopLevel(node: Parser.SyntaxNode): boolean {
  return node.parent !== null && node.parent.type === "program";
}

const ATTR_METHODS = new Set([
  "attr_accessor",
  "attr_reader",
  "attr_writer",
]);

function extractSymbols(rootNode: Parser.SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  // --- Classes ---
  const classNodes = [
    ...rootNode.descendantsOfType("class"),
    ...rootNode.descendantsOfType("class_declaration"),
  ];
  for (const node of classNodes) {
    const name = getClassName(node);
    if (!name) continue;

    const superclass = getSuperclass(node);
    symbols.push(makeSymbol("class", name, node, superclass, []));
  }

  // --- Modules ---
  const moduleNodes = [
    ...rootNode.descendantsOfType("module"),
    ...rootNode.descendantsOfType("module_declaration"),
  ];
  // Filter out the root "program" node if it happens to be captured
  for (const node of moduleNodes) {
    if (node.type === "program") continue;
    const name = getModuleName(node);
    if (!name) continue;

    symbols.push(makeSymbol("module", name, node));
  }

  // --- Methods (def) ---
  const methodNodes = [
    ...rootNode.descendantsOfType("method"),
    ...rootNode.descendantsOfType("method_definition"),
  ];
  for (const node of methodNodes) {
    const rawName = getMethodName(node);
    if (!rawName) continue;

    const enclosingClass = getEnclosingClassName(node);
    const kind: SymbolKind = enclosingClass ? "method" : "function";
    const qualifiedName = enclosingClass
      ? `${enclosingClass}.${rawName}`
      : rawName;

    symbols.push(makeSymbol(kind, qualifiedName, node));
  }

  // --- Singleton methods (def self.foo) ---
  const singletonNodes = rootNode.descendantsOfType("singleton_method");
  for (const node of singletonNodes) {
    const rawName = getSingletonMethodName(node);
    if (!rawName) continue;

    const enclosingClass = getEnclosingClassName(node);
    const qualifiedName = enclosingClass
      ? `${enclosingClass}.${rawName}`
      : rawName;

    symbols.push(makeSymbol("method", qualifiedName, node));
  }

  // --- Constants (CONSTANT = value) ---
  // Look for assignment nodes where the left-hand side is a constant
  const assignmentNodes = [
    ...rootNode.descendantsOfType("assignment"),
    ...rootNode.descendantsOfType("assignment_expression"),
  ];
  for (const node of assignmentNodes) {
    const leftNode = node.childForFieldName("left");
    if (!leftNode) {
      // Try the first child as a fallback
      const first = node.namedChildren[0];
      if (first && first.type === "constant") {
        symbols.push(makeSymbol("constant", first.text, node));
      }
      continue;
    }
    if (leftNode.type === "constant") {
      symbols.push(makeSymbol("constant", leftNode.text, node));
    }
  }

  // --- attr_accessor / attr_reader / attr_writer ---
  const allCalls = [
    ...rootNode.descendantsOfType("call"),
    ...rootNode.descendantsOfType("method_call"),
  ];
  for (const callNode of allCalls) {
    const methodNode = callNode.childForFieldName("method");
    let methodName: string | null = null;

    if (methodNode && ATTR_METHODS.has(methodNode.text)) {
      methodName = methodNode.text;
    } else {
      // Check first identifier child as fallback
      for (const child of callNode.children) {
        if (child.type === "identifier" && ATTR_METHODS.has(child.text)) {
          methodName = child.text;
          break;
        }
      }
    }

    if (!methodName) continue;

    // Extract symbol arguments: attr_accessor :name, :email
    const enclosingClass = getEnclosingClassName(callNode);

    // Collect all simple_symbol and symbol children (`:name` style)
    const symbolArgs = collectSymbolArguments(callNode);
    for (const symName of symbolArgs) {
      const qualifiedName = enclosingClass
        ? `${enclosingClass}.${symName}`
        : symName;
      symbols.push(makeSymbol("property", qualifiedName, callNode));
    }
  }

  return symbols;
}

/**
 * Collect symbol literal arguments from a call node.
 * Handles both `:name` (simple_symbol / symbol) and `"name"` (string) forms.
 * Strips the leading colon from symbol literals.
 */
function collectSymbolArguments(callNode: Parser.SyntaxNode): string[] {
  const names: string[] = [];

  // Check arguments field
  const argsNode = callNode.childForFieldName("arguments");
  const searchNodes = argsNode ? argsNode.children : callNode.children;

  for (const child of searchNodes) {
    if (child.type === "simple_symbol" || child.type === "symbol") {
      // Strip leading colon: `:name` -> `name`
      const text = child.text.startsWith(":") ? child.text.slice(1) : child.text;
      names.push(text);
    } else if (child.type === "bare_symbol") {
      names.push(child.text);
    } else if (child.type === "string" || child.type === "string_literal") {
      names.push(stringLiteralValue(child));
    } else if (child.type === "argument_list") {
      // Recurse into argument_list
      for (const arg of child.children) {
        if (arg.type === "simple_symbol" || arg.type === "symbol") {
          const text = arg.text.startsWith(":") ? arg.text.slice(1) : arg.text;
          names.push(text);
        } else if (arg.type === "bare_symbol") {
          names.push(arg.text);
        } else if (arg.type === "string" || arg.type === "string_literal") {
          names.push(stringLiteralValue(arg));
        }
      }
    }
  }

  return names;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Ruby source string using the provided tree-sitter parse tree,
 * extracting imports (require/require_relative/load), exports (top-level
 * definitions), and symbol declarations (classes, modules, methods, constants,
 * properties).
 *
 * @param source - The source code text.
 * @param filePath - File path (used for error context).
 * @param tree - The tree-sitter parse tree for the source.
 * @returns Parsed imports, exports, and symbols.
 */
export function parseRuby(
  source: string,
  filePath: string,
  tree: Parser.Tree,
): ParseResult {
  try {
    const rootNode = tree.rootNode;

    return {
      imports: extractImports(rootNode),
      exports: extractExports(rootNode),
      symbols: extractSymbols(rootNode),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[cindex] Failed to parse ${filePath}: ${message}`);
    return emptyResult();
  }
}
