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

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Extract imports from Python source.
 *
 * Handles:
 * - `import foo` / `import foo.bar` / `import foo as bar`
 * - `from foo import bar, baz` / `from foo import *`
 * - `from . import foo` / `from ..utils import helper`
 */
function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
  const imports: ParsedImport[] = [];

  // --- `import X` statements ---
  const importStatements = rootNode.descendantsOfType("import_statement");
  for (const stmt of importStatements) {
    const parsed = parseImportStatement(stmt);
    imports.push(...parsed);
  }

  // --- `from X import Y` statements ---
  const importFromStatements = rootNode.descendantsOfType("import_from_statement");
  for (const stmt of importFromStatements) {
    const parsed = parseImportFromStatement(stmt);
    if (parsed) {
      imports.push(parsed);
    }
  }

  return imports;
}

/**
 * Parse a plain `import` statement.
 *
 * `import foo`           -> source: "foo", names: ["foo"], isDefault: true
 * `import foo.bar`       -> source: "foo.bar", names: ["bar"], isDefault: true
 * `import foo as bar`    -> source: "foo", names: ["bar"], isDefault: true
 * `import foo, bar.baz`  -> multiple entries
 */
function parseImportStatement(stmt: Parser.SyntaxNode): ParsedImport[] {
  const results: ParsedImport[] = [];

  // In tree-sitter-python, `import_statement` children are `dotted_name` or
  // `aliased_import` nodes (one per imported module).
  for (const child of stmt.namedChildren) {
    if (child.type === "dotted_name") {
      // `import foo` or `import foo.bar`
      const source = child.text;
      const parts = source.split(".");
      const localName = parts[parts.length - 1];
      results.push({
        source,
        names: [localName],
        isDefault: true,
        isNamespace: false,
        isTypeOnly: false,
        isDynamic: false,
      });
    } else if (child.type === "aliased_import") {
      // `import foo as bar`
      const nameNode = child.childForFieldName("name");
      const aliasNode = child.childForFieldName("alias");
      if (nameNode) {
        const source = nameNode.text;
        const localName = aliasNode ? aliasNode.text : source.split(".").pop() ?? source;
        results.push({
          source,
          names: [localName],
          isDefault: true,
          isNamespace: false,
          isTypeOnly: false,
          isDynamic: false,
        });
      }
    }
  }

  return results;
}

/**
 * Parse a `from X import Y` statement.
 *
 * `from foo import bar, baz`   -> source: "foo", names: ["bar", "baz"], isDefault: false
 * `from foo import *`          -> source: "foo", names: [], isNamespace: true
 * `from . import foo`          -> source: ".", names: ["foo"], isDefault: false
 * `from ..utils import helper` -> source: "..utils", names: ["helper"], isDefault: false
 */
function parseImportFromStatement(stmt: Parser.SyntaxNode): ParsedImport | null {
  // Build the module source string.
  // The module name may be in a `module_name` field, or it may be composed of
  // relative import dots and a `dotted_name`.
  let source = "";

  const moduleNameNode = stmt.childForFieldName("module_name");
  if (moduleNameNode) {
    source = moduleNameNode.text;
  } else {
    // For relative imports like `from . import foo`, there is no module_name field.
    // We need to reconstruct the source from the relative_import or import_prefix children.
    // Walk children to gather dots and any dotted_name before `import` keyword.
    const parts: string[] = [];
    for (const child of stmt.children) {
      if (child.type === "import") {
        // We have hit the `import` keyword; stop collecting module path parts.
        break;
      }
      if (child.type === "from") {
        continue;
      }
      if (child.type === "relative_import") {
        // `relative_import` wraps the prefix dots and optional dotted_name
        const prefix = child.childForFieldName("import_prefix");
        const dotted = child.descendantsOfType("dotted_name");
        if (prefix) {
          parts.push(prefix.text);
        }
        if (dotted.length > 0) {
          parts.push(dotted[0].text);
        }
        break;
      }
      if (child.type === "import_prefix") {
        parts.push(child.text);
      }
      if (child.type === "dotted_name") {
        parts.push(child.text);
      }
    }
    source = parts.join("");
  }

  // If we still have no source, try to gather it from the raw children.
  // Some tree-sitter-python versions put the module as unnamed `.` children
  // followed by a `dotted_name`.
  if (!source) {
    const textParts: string[] = [];
    for (const child of stmt.children) {
      if (child.type === "from") continue;
      if (child.type === "import") break;
      // Dot tokens for relative imports
      if (child.type === "." || child.type === "..") {
        textParts.push(child.text);
      } else if (child.type === "dotted_name") {
        textParts.push(child.text);
      }
    }
    source = textParts.join("");
  }

  if (!source) {
    return null;
  }

  // Check for wildcard import: `from foo import *`
  const hasWildcard = stmt.children.some(
    (c) => c.type === "wildcard_import" || c.text === "*",
  );
  if (hasWildcard) {
    return {
      source,
      names: [],
      isDefault: false,
      isNamespace: true,
      isTypeOnly: false,
      isDynamic: false,
    };
  }

  // Collect imported names from the statement.
  // These appear after the `import` keyword and can be `dotted_name`,
  // `aliased_import`, or `identifier` nodes.
  const names: string[] = [];
  let pastImportKeyword = false;

  for (const child of stmt.children) {
    if (child.type === "import") {
      pastImportKeyword = true;
      continue;
    }
    if (!pastImportKeyword) continue;

    // Skip punctuation (commas, parens)
    if (child.type === "," || child.type === "(" || child.type === ")") {
      continue;
    }

    if (child.type === "dotted_name" || child.type === "identifier") {
      names.push(child.text);
    } else if (child.type === "aliased_import") {
      // `from foo import bar as baz` -> use the alias "baz" as the imported name
      const aliasNode = child.childForFieldName("alias");
      const nameNode = child.childForFieldName("name");
      if (aliasNode) {
        names.push(aliasNode.text);
      } else if (nameNode) {
        names.push(nameNode.text);
      }
    }
  }

  // Also pick up any named children that are dotted_name or aliased_import
  // in case the above loop missed them (some grammars put them as named children).
  if (names.length === 0) {
    for (const child of stmt.namedChildren) {
      // Skip the module_name we already processed
      if (child === moduleNameNode) continue;

      if (child.type === "dotted_name" || child.type === "identifier") {
        if (child.text !== source && !names.includes(child.text)) {
          names.push(child.text);
        }
      } else if (child.type === "aliased_import") {
        const aliasNode = child.childForFieldName("alias");
        const nameNode = child.childForFieldName("name");
        const n = aliasNode ? aliasNode.text : nameNode ? nameNode.text : null;
        if (n && !names.includes(n)) {
          names.push(n);
        }
      }
    }
  }

  return {
    source,
    names,
    isDefault: false,
    isNamespace: false,
    isTypeOnly: false,
    isDynamic: false,
  };
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/**
 * Extract exports from Python source.
 *
 * Python does not have explicit export syntax. By convention:
 * - If `__all__` is defined, only those names are public exports.
 * - Otherwise, all top-level functions, classes, and variable assignments
 *   that do not start with `_` are considered exports.
 */
function extractExports(rootNode: Parser.SyntaxNode, symbols: ParsedSymbol[]): ParsedExport[] {
  // Check for __all__ assignment
  const allNames = extractDunderAll(rootNode);
  if (allNames !== null) {
    return allNames.map((name) => ({
      name,
      isDefault: false,
      isReExport: false,
      source: null,
    }));
  }

  // No __all__ found; treat all non-private top-level symbols as exports.
  const exports: ParsedExport[] = [];
  const seen = new Set<string>();

  for (const sym of symbols) {
    // Only export top-level symbols (no dot in name, indicating methods).
    // Methods are recorded as "ClassName.method_name".
    if (sym.name.includes(".")) continue;

    // Skip private names (leading underscore)
    if (sym.name.startsWith("_")) continue;

    if (seen.has(sym.name)) continue;
    seen.add(sym.name);

    exports.push({
      name: sym.name,
      isDefault: false,
      isReExport: false,
      source: null,
    });
  }

  return exports;
}

/**
 * Look for an `__all__` assignment at module level and extract the list of
 * exported names from it.
 *
 * Patterns handled:
 * - `__all__ = ["foo", "bar"]`
 * - `__all__ = ("foo", "bar")`
 *
 * Returns null if no `__all__` assignment is found.
 */
function extractDunderAll(rootNode: Parser.SyntaxNode): string[] | null {
  for (const child of rootNode.children) {
    // Direct assignment: `__all__ = [...]`
    if (child.type === "expression_statement") {
      const expr = child.namedChildren[0];
      if (expr && expr.type === "assignment") {
        const allNames = parseDunderAllAssignment(expr);
        if (allNames !== null) return allNames;
      }
    }

    // Some grammars surface assignment as a direct child
    if (child.type === "assignment") {
      const allNames = parseDunderAllAssignment(child);
      if (allNames !== null) return allNames;
    }
  }

  return null;
}

/**
 * Given an assignment node, check if it assigns to `__all__` and extract names.
 */
function parseDunderAllAssignment(node: Parser.SyntaxNode): string[] | null {
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");

  if (!left || !right) return null;
  if (left.type !== "identifier" || left.text !== "__all__") return null;

  // Right side should be a list or tuple of string literals
  if (right.type !== "list" && right.type !== "tuple") return null;

  const names: string[] = [];
  for (const elem of right.namedChildren) {
    if (elem.type === "string") {
      // Strip quotes from the string content
      const content = extractStringContent(elem);
      if (content !== null) {
        names.push(content);
      }
    }
  }

  return names;
}

/**
 * Extract the text content of a Python string node, stripping quotes.
 * Handles single/double/triple-quoted strings.
 */
function extractStringContent(node: Parser.SyntaxNode): string | null {
  // tree-sitter-python string nodes contain `string_content` children
  const contentNode = node.descendantsOfType("string_content");
  if (contentNode.length > 0) {
    return contentNode[0].text;
  }

  // Fallback: strip quotes manually
  const text = node.text;
  // Triple-quoted strings
  if (text.startsWith('"""') && text.endsWith('"""')) {
    return text.slice(3, -3);
  }
  if (text.startsWith("'''") && text.endsWith("'''")) {
    return text.slice(3, -3);
  }
  // Single-quoted
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1);
  }

  return text;
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

/**
 * Extract all symbol declarations from the Python AST.
 *
 * Handles:
 * - Top-level function definitions (including decorated ones)
 * - Top-level class definitions (including decorated ones)
 * - Methods inside classes
 * - Top-level variable assignments
 */
function extractSymbols(rootNode: Parser.SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const child of rootNode.children) {
    processTopLevelNode(child, symbols);
  }

  return symbols;
}

/**
 * Process a single top-level AST node and extract symbols from it.
 * Handles `function_definition`, `class_definition`, `decorated_definition`,
 * `expression_statement` (containing assignments), and `assignment`.
 */
function processTopLevelNode(
  node: Parser.SyntaxNode,
  symbols: ParsedSymbol[],
): void {
  switch (node.type) {
    case "function_definition": {
      const sym = parseFunctionDefinition(node);
      if (sym) symbols.push(sym);
      break;
    }

    case "class_definition": {
      parseClassAndMethods(node, symbols);
      break;
    }

    case "decorated_definition": {
      // A `decorated_definition` wraps a `function_definition` or `class_definition`
      // with one or more decorator nodes.
      const definition = getDecoratedDefinition(node);
      if (definition) {
        if (definition.type === "function_definition") {
          const sym = parseFunctionDefinition(definition, node);
          if (sym) symbols.push(sym);
        } else if (definition.type === "class_definition") {
          parseClassAndMethods(definition, symbols, node);
        }
      }
      break;
    }

    case "expression_statement": {
      // Expression statements may contain assignments: `x = 42`
      const expr = node.namedChildren[0];
      if (expr && expr.type === "assignment") {
        const vars = parseTopLevelAssignment(expr, node);
        symbols.push(...vars);
      }
      break;
    }

    case "assignment": {
      const vars = parseTopLevelAssignment(node, node);
      symbols.push(...vars);
      break;
    }

    default:
      break;
  }
}

/**
 * Unwrap a `decorated_definition` to find the inner `function_definition`
 * or `class_definition`.
 */
function getDecoratedDefinition(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const defNode = node.childForFieldName("definition");
  if (defNode) return defNode;

  // Fallback: search children directly
  for (const child of node.namedChildren) {
    if (child.type === "function_definition" || child.type === "class_definition") {
      return child;
    }
  }
  return null;
}

/**
 * Parse a `function_definition` node into a ParsedSymbol.
 * If `outerNode` is provided (from a decorated_definition), the position spans
 * from the outerNode start to the definition end.
 */
function parseFunctionDefinition(
  node: Parser.SyntaxNode,
  outerNode?: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const spanNode = outerNode ?? node;

  return {
    kind: "function",
    name: nameNode.text,
    signature: signatureOf(node),
    startLine: spanNode.startPosition.row + 1,
    startCol: spanNode.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

/**
 * Parse a `class_definition` node and its methods into ParsedSymbol entries.
 * If `outerNode` is provided (from a decorated_definition), the class position
 * spans from the outerNode start.
 */
function parseClassAndMethods(
  node: Parser.SyntaxNode,
  symbols: ParsedSymbol[],
  outerNode?: Parser.SyntaxNode,
): void {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;

  const className = nameNode.text;
  const spanNode = outerNode ?? node;

  // Extract base classes from the argument_list (superclasses).
  // In tree-sitter-python, the superclass list is in the `superclasses` field
  // or an `argument_list` child.
  let extendsName: string | null = null;
  const implementsList: string[] = [];

  const superclasses = node.childForFieldName("superclasses");
  if (superclasses) {
    const baseClasses = extractBaseClassNames(superclasses);
    if (baseClasses.length > 0) {
      extendsName = baseClasses[0];
      for (let i = 1; i < baseClasses.length; i++) {
        implementsList.push(baseClasses[i]);
      }
    }
  } else {
    // Fallback: look for an argument_list child
    for (const child of node.children) {
      if (child.type === "argument_list") {
        const baseClasses = extractBaseClassNames(child);
        if (baseClasses.length > 0) {
          extendsName = baseClasses[0];
          for (let i = 1; i < baseClasses.length; i++) {
            implementsList.push(baseClasses[i]);
          }
        }
        break;
      }
    }
  }

  symbols.push({
    kind: "class",
    name: className,
    signature: signatureOf(node),
    startLine: spanNode.startPosition.row + 1,
    startCol: spanNode.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: extendsName,
    implements: implementsList,
  });

  // Extract methods from the class body
  const body = node.childForFieldName("body");
  if (body) {
    for (const bodyChild of body.children) {
      if (bodyChild.type === "function_definition") {
        const methodSym = parseMethodDefinition(bodyChild, className);
        if (methodSym) symbols.push(methodSym);
      } else if (bodyChild.type === "decorated_definition") {
        const innerDef = getDecoratedDefinition(bodyChild);
        if (innerDef && innerDef.type === "function_definition") {
          const methodSym = parseMethodDefinition(innerDef, className, bodyChild);
          if (methodSym) symbols.push(methodSym);
        }
      }
    }
  }
}

/**
 * Extract base class names from a superclass / argument_list node.
 * Handles `identifier`, `dotted_name`, `keyword_argument` (e.g. metaclass=ABCMeta),
 * and `call` (e.g. Generic[T]) nodes.
 */
function extractBaseClassNames(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];

  for (const child of node.namedChildren) {
    if (child.type === "identifier" || child.type === "dotted_name") {
      names.push(child.text);
    } else if (child.type === "attribute") {
      // e.g., `module.ClassName`
      names.push(child.text);
    } else if (child.type === "call") {
      // e.g., `Generic[T]` appears as a subscript or `SomeBase(arg)`
      const fnNode = child.childForFieldName("function");
      if (fnNode) {
        names.push(fnNode.text);
      }
    } else if (child.type === "subscript") {
      // e.g., `Generic[T]`
      const valueNode = child.childForFieldName("value");
      if (valueNode) {
        names.push(valueNode.text);
      }
    } else if (child.type === "keyword_argument") {
      // e.g., `metaclass=ABCMeta` -- skip these, they are not base classes
      continue;
    }
  }

  return names;
}

/**
 * Parse a method (function_definition inside a class body) into a ParsedSymbol.
 * The method name is prefixed with the class name: "ClassName.method_name".
 */
function parseMethodDefinition(
  node: Parser.SyntaxNode,
  className: string,
  outerNode?: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const spanNode = outerNode ?? node;

  return {
    kind: "method",
    name: `${className}.${nameNode.text}`,
    signature: signatureOf(node),
    startLine: spanNode.startPosition.row + 1,
    startCol: spanNode.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

/**
 * Parse a top-level assignment into variable symbols.
 * Only captures simple `identifier = value` patterns (not tuple unpacking,
 * subscript assignments, attribute assignments, etc.).
 *
 * @param assignNode - The `assignment` node.
 * @param spanNode - The outer node to use for position (may be an expression_statement).
 */
function parseTopLevelAssignment(
  assignNode: Parser.SyntaxNode,
  spanNode: Parser.SyntaxNode,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  const left = assignNode.childForFieldName("left");
  if (!left) return symbols;

  if (left.type === "identifier") {
    symbols.push({
      kind: "variable",
      name: left.text,
      signature: signatureOf(spanNode),
      startLine: spanNode.startPosition.row + 1,
      startCol: spanNode.startPosition.column + 1,
      endLine: spanNode.endPosition.row + 1,
      endCol: spanNode.endPosition.column + 1,
      extends: null,
      implements: [],
    });
  } else if (left.type === "pattern_list" || left.type === "tuple_pattern") {
    // `a, b = 1, 2` -- extract each identifier
    for (const child of left.namedChildren) {
      if (child.type === "identifier") {
        symbols.push({
          kind: "variable",
          name: child.text,
          signature: signatureOf(spanNode),
          startLine: spanNode.startPosition.row + 1,
          startCol: spanNode.startPosition.column + 1,
          endLine: spanNode.endPosition.row + 1,
          endCol: spanNode.endPosition.column + 1,
          extends: null,
          implements: [],
        });
      }
    }
  }

  // Type-annotated assignments: `x: int = 42` appear as a different node in some
  // grammars. The left side may be a `type` node wrapping the identifier.
  // In tree-sitter-python, annotated assignments use the node type
  // `assignment` with the left side being the identifier directly,
  // so the above handling covers it.

  return symbols;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Python source string using the provided tree-sitter parse tree,
 * extracting imports, exports, and symbol declarations.
 *
 * @param source - The source code text.
 * @param filePath - File path (used for error context).
 * @param tree - The tree-sitter parse tree for the source.
 * @returns Parsed imports, exports, and symbols.
 */
export function parsePython(
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
