import type Parser from "tree-sitter";
import type {
  ParseResult,
  ParsedImport,
  ParsedExport,
  ParsedSymbol,
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

/** Helper: find a direct child node of a given type. */
function childOfType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | null {
  for (const child of node.children) {
    if (child.type === type) {
      return child;
    }
  }
  return null;
}

/** Helper: find all direct children of a given type. */
function childrenOfType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode[] {
  return node.children.filter((c) => c.type === type);
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

/**
 * Split a qualified PHP name (e.g. "App\\Models\\User") into source and name parts.
 * Returns [source, name] where source is everything before the last segment and
 * name is the last segment.
 */
function splitQualifiedName(qualifiedName: string): [string, string] {
  const segments = qualifiedName.replace(/^\\/, "").split("\\");
  if (segments.length <= 1) {
    return ["", segments[0] || ""];
  }
  const name = segments[segments.length - 1];
  const source = segments.slice(0, -1).join("\\");
  return [source, name];
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
  const imports: ParsedImport[] = [];

  // namespace_use_declaration: `use App\Models\User;` or `use App\Models\{User, Post};`
  const useDeclarations = rootNode.descendantsOfType(
    "namespace_use_declaration",
  );
  for (const useDecl of useDeclarations) {
    const parsed = parseNamespaceUseDeclaration(useDecl);
    imports.push(...parsed);
  }

  // include/require statements
  const includeTypes = [
    "include_expression",
    "require_expression",
    "include_once_expression",
    "require_once_expression",
  ];
  for (const includeType of includeTypes) {
    const includeNodes = rootNode.descendantsOfType(includeType);
    for (const includeNode of includeNodes) {
      const parsed = parseIncludeExpression(includeNode);
      if (parsed) {
        imports.push(parsed);
      }
    }
  }

  return imports;
}

/**
 * Parse a `namespace_use_declaration` node.
 *
 * Handles:
 * - `use App\Models\User;` (single use)
 * - `use App\Models\User as UserModel;` (aliased)
 * - `use App\Models\{User, Post};` (grouped)
 * - `use function App\Utils\helper;` (function import)
 */
function parseNamespaceUseDeclaration(
  node: Parser.SyntaxNode,
): ParsedImport[] {
  const results: ParsedImport[] = [];

  // Check for grouped use: `use App\Models\{User, Post};`
  const useGroup = childOfType(node, "namespace_use_group");
  if (useGroup) {
    // The prefix is in a `namespace_name` / `qualified_name` child of the
    // namespace_use_declaration (before the group).
    let prefix = "";
    for (const child of node.children) {
      if (
        child.type === "namespace_name" ||
        child.type === "qualified_name"
      ) {
        prefix = child.text.replace(/^\\/, "");
        break;
      }
    }

    // Each clause in the group
    const clauses = useGroup.descendantsOfType("namespace_use_group_clause");
    if (clauses.length > 0) {
      const names: string[] = [];
      for (const clause of clauses) {
        // Check for alias: `User as UserModel`
        const aliasClause = childOfType(clause, "namespace_aliasing_clause");
        if (aliasClause) {
          const aliasName =
            childOfType(aliasClause, "name") ||
            childOfType(aliasClause, "identifier");
          if (aliasName) {
            names.push(aliasName.text);
          } else {
            // Fallback: use the qualified name
            const qn =
              childOfType(clause, "namespace_name") ||
              childOfType(clause, "qualified_name") ||
              childOfType(clause, "name");
            if (qn) {
              const [, name] = splitQualifiedName(qn.text);
              names.push(name);
            }
          }
        } else {
          const qn =
            childOfType(clause, "namespace_name") ||
            childOfType(clause, "qualified_name") ||
            childOfType(clause, "name");
          if (qn) {
            const [, name] = splitQualifiedName(qn.text);
            names.push(name);
          }
        }
      }

      if (names.length > 0) {
        results.push({
          source: prefix,
          names,
          isDefault: false,
          isNamespace: false,
          isTypeOnly: false,
          isDynamic: false,
        });
      }
    }

    return results;
  }

  // Non-grouped use: one or more `namespace_use_clause` children
  const useClauses = node.descendantsOfType("namespace_use_clause");
  for (const clause of useClauses) {
    // The qualified name is the full path: App\Models\User
    const qualifiedNode =
      childOfType(clause, "qualified_name") ||
      childOfType(clause, "namespace_name") ||
      childOfType(clause, "name");

    if (!qualifiedNode) continue;

    const fullPath = qualifiedNode.text.replace(/^\\/, "");
    const [source, nameSegment] = splitQualifiedName(fullPath);

    // Check for alias: `use App\Models\User as UserModel;`
    const aliasClause = childOfType(clause, "namespace_aliasing_clause");
    let importedName = nameSegment;
    if (aliasClause) {
      const aliasName =
        childOfType(aliasClause, "name") ||
        childOfType(aliasClause, "identifier");
      if (aliasName) {
        importedName = aliasName.text;
      }
    }

    results.push({
      source,
      names: [importedName],
      isDefault: false,
      isNamespace: false,
      isTypeOnly: false,
      isDynamic: false,
    });
  }

  return results;
}

/**
 * Parse include/require expression nodes.
 * Extracts the string path argument.
 */
function parseIncludeExpression(
  node: Parser.SyntaxNode,
): ParsedImport | null {
  // The argument is typically a string child
  let pathValue = "";

  // Look for a string node among descendants (could be direct child or nested in parenthesized_expression)
  const stringNodes = node.descendantsOfType("string");
  if (stringNodes.length > 0) {
    pathValue = stringLiteralValue(stringNodes[0]);
  } else {
    // Try encapsed_string (double-quoted with variables)
    const encapsedNodes = node.descendantsOfType("encapsed_string");
    if (encapsedNodes.length > 0) {
      pathValue = stringLiteralValue(encapsedNodes[0]);
    }
  }

  if (!pathValue) {
    // Dynamic include (variable path, concatenation, etc.)
    // Still record it but with the raw expression text
    pathValue = node.text;
  }

  return {
    source: pathValue,
    names: [],
    isDefault: false,
    isNamespace: false,
    isTypeOnly: false,
    isDynamic: true,
  };
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/**
 * PHP does not have explicit export syntax.
 * Treat all top-level classes, interfaces, traits, functions, constants,
 * and enums as exports since they are globally accessible once the file
 * is loaded.
 */
function extractExports(rootNode: Parser.SyntaxNode): ParsedExport[] {
  const exports: ParsedExport[] = [];

  const exportableTypes = [
    "class_declaration",
    "interface_declaration",
    "trait_declaration",
    "function_definition",
    "const_declaration",
    "enum_declaration",
    "namespace_definition",
  ];

  for (const nodeType of exportableTypes) {
    const nodes = rootNode.descendantsOfType(nodeType);
    for (const node of nodes) {
      // Only consider top-level declarations.
      // A declaration is "top-level" if its parent is the program node
      // or a namespace_definition body (declaration_list).
      const parent = node.parent;
      if (!parent) continue;

      const isTopLevel =
        parent.type === "program" ||
        parent.type === "declaration_list" ||
        parent.type === "namespace_definition";

      if (!isTopLevel) continue;

      if (nodeType === "const_declaration") {
        // const_declaration can declare multiple constants: `const A = 1, B = 2;`
        const elements = node.descendantsOfType("const_element");
        for (const element of elements) {
          const nameNode =
            element.childForFieldName("name") ||
            childOfType(element, "name");
          if (nameNode) {
            exports.push({
              name: nameNode.text,
              isDefault: false,
              isReExport: false,
              source: null,
            });
          }
        }
      } else {
        const nameNode =
          node.childForFieldName("name") || childOfType(node, "name");
        if (nameNode) {
          exports.push({
            name: nameNode.text,
            isDefault: false,
            isReExport: false,
            source: null,
          });
        }
      }
    }
  }

  return exports;
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

function extractSymbols(rootNode: Parser.SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  // Namespace definitions
  const namespaceNodes = rootNode.descendantsOfType("namespace_definition");
  for (const node of namespaceNodes) {
    const sym = parseNamespaceDefinition(node);
    if (sym) symbols.push(sym);
  }

  // Class declarations
  const classNodes = rootNode.descendantsOfType("class_declaration");
  for (const node of classNodes) {
    const sym = parseClassDeclaration(node);
    if (sym) {
      symbols.push(sym);
      extractMethods(node, sym.name, symbols);
    }
  }

  // Interface declarations
  const interfaceNodes = rootNode.descendantsOfType("interface_declaration");
  for (const node of interfaceNodes) {
    const sym = parseInterfaceDeclaration(node);
    if (sym) {
      symbols.push(sym);
      extractMethods(node, sym.name, symbols);
    }
  }

  // Trait declarations
  const traitNodes = rootNode.descendantsOfType("trait_declaration");
  for (const node of traitNodes) {
    const sym = parseTraitDeclaration(node);
    if (sym) {
      symbols.push(sym);
      extractMethods(node, sym.name, symbols);
    }
  }

  // Enum declarations (PHP 8.1+)
  const enumNodes = rootNode.descendantsOfType("enum_declaration");
  for (const node of enumNodes) {
    const sym = parseEnumDeclaration(node);
    if (sym) {
      symbols.push(sym);
      extractMethods(node, sym.name, symbols);
    }
  }

  // Top-level function definitions
  const functionNodes = rootNode.descendantsOfType("function_definition");
  for (const node of functionNodes) {
    // Only top-level functions (not closures or methods inside classes)
    const parent = node.parent;
    if (!parent) continue;
    const isTopLevel =
      parent.type === "program" ||
      parent.type === "declaration_list" ||
      parent.type === "namespace_definition";
    if (!isTopLevel) continue;

    const sym = parseFunctionDefinition(node);
    if (sym) symbols.push(sym);
  }

  // Top-level constant declarations
  const constNodes = rootNode.descendantsOfType("const_declaration");
  for (const node of constNodes) {
    // Only top-level constants (not class constants)
    const parent = node.parent;
    if (!parent) continue;
    const isTopLevel =
      parent.type === "program" ||
      parent.type === "declaration_list" ||
      parent.type === "namespace_definition";
    if (!isTopLevel) continue;

    const constSymbols = parseConstDeclaration(node);
    symbols.push(...constSymbols);
  }

  return symbols;
}

/** Extract method declarations from a class/interface/trait/enum body. */
function extractMethods(
  parentNode: Parser.SyntaxNode,
  parentName: string,
  symbols: ParsedSymbol[],
): void {
  const body =
    parentNode.childForFieldName("body") ||
    childOfType(parentNode, "declaration_list") ||
    childOfType(parentNode, "enum_declaration_list");

  if (!body) return;

  const methods = body.descendantsOfType("method_declaration");
  for (const method of methods) {
    // Only direct methods of this body (not nested class methods)
    if (method.parent !== body) continue;

    const sym = parseMethodDeclaration(method, parentName);
    if (sym) symbols.push(sym);
  }
}

function parseNamespaceDefinition(
  node: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode =
    node.childForFieldName("name") || childOfType(node, "namespace_name");
  if (!nameNode) return null;

  return {
    kind: "namespace",
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

function parseClassDeclaration(node: Parser.SyntaxNode): ParsedSymbol | null {
  const nameNode =
    node.childForFieldName("name") || childOfType(node, "name");
  if (!nameNode) return null;

  let extendsName: string | null = null;
  const implementsList: string[] = [];

  // base_clause: `extends ParentClass`
  const baseClause = childOfType(node, "base_clause");
  if (baseClause) {
    const baseName =
      childOfType(baseClause, "name") ||
      childOfType(baseClause, "qualified_name") ||
      childOfType(baseClause, "namespace_name");
    if (baseName) {
      extendsName = baseName.text;
    }
  }

  // class_interface_clause: `implements InterfaceA, InterfaceB`
  const interfaceClause = childOfType(node, "class_interface_clause");
  if (interfaceClause) {
    for (const child of interfaceClause.namedChildren) {
      if (
        child.type === "name" ||
        child.type === "qualified_name" ||
        child.type === "namespace_name"
      ) {
        implementsList.push(child.text);
      }
    }
  }

  return {
    kind: "class",
    name: nameNode.text,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: extendsName,
    implements: implementsList,
  };
}

function parseInterfaceDeclaration(
  node: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode =
    node.childForFieldName("name") || childOfType(node, "name");
  if (!nameNode) return null;

  let extendsName: string | null = null;

  // Interfaces can extend other interfaces via base_clause
  const baseClause = childOfType(node, "base_clause");
  if (baseClause) {
    const baseName =
      childOfType(baseClause, "name") ||
      childOfType(baseClause, "qualified_name") ||
      childOfType(baseClause, "namespace_name");
    if (baseName) {
      extendsName = baseName.text;
    }
  }

  return {
    kind: "interface",
    name: nameNode.text,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: extendsName,
    implements: [],
  };
}

function parseTraitDeclaration(node: Parser.SyntaxNode): ParsedSymbol | null {
  const nameNode =
    node.childForFieldName("name") || childOfType(node, "name");
  if (!nameNode) return null;

  return {
    kind: "trait",
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

function parseEnumDeclaration(node: Parser.SyntaxNode): ParsedSymbol | null {
  const nameNode =
    node.childForFieldName("name") || childOfType(node, "name");
  if (!nameNode) return null;

  const implementsList: string[] = [];

  // Enums can implement interfaces via class_interface_clause
  const interfaceClause = childOfType(node, "class_interface_clause");
  if (interfaceClause) {
    for (const child of interfaceClause.namedChildren) {
      if (
        child.type === "name" ||
        child.type === "qualified_name" ||
        child.type === "namespace_name"
      ) {
        implementsList.push(child.text);
      }
    }
  }

  return {
    kind: "enum",
    name: nameNode.text,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: implementsList,
  };
}

function parseFunctionDefinition(
  node: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode =
    node.childForFieldName("name") || childOfType(node, "name");
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

function parseMethodDeclaration(
  node: Parser.SyntaxNode,
  className: string,
): ParsedSymbol | null {
  const nameNode =
    node.childForFieldName("name") || childOfType(node, "name");
  if (!nameNode) return null;

  return {
    kind: "method",
    name: `${className}.${nameNode.text}`,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

function parseConstDeclaration(node: Parser.SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  // const_declaration can contain multiple const_element children
  const elements = node.descendantsOfType("const_element");
  for (const element of elements) {
    const nameNode =
      element.childForFieldName("name") || childOfType(element, "name");
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

  return symbols;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a PHP source string using the provided tree-sitter parse tree,
 * extracting imports, exports, and symbol declarations.
 *
 * @param source - The source code text.
 * @param filePath - File path (used for error context).
 * @param tree - The tree-sitter parse tree for the source.
 * @returns Parsed imports, exports, and symbols.
 */
export function parsePHP(
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
    // Graceful degradation: return empty result on parse failure
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[cindex] Failed to parse ${filePath}: ${message}`);
    return emptyResult();
  }
}
