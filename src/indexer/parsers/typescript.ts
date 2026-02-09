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
  // Remove surrounding quotes (' or " or `)
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("`") && text.endsWith("`"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** Helper: get the first line of the node text for use as a signature. */
function signatureOf(node: Parser.SyntaxNode): string {
  const firstLine = node.text.split("\n")[0];
  // Truncate very long signatures
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

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
  const imports: ParsedImport[] = [];

  // Standard import statements
  const importStatements = rootNode.descendantsOfType("import_statement");
  for (const stmt of importStatements) {
    const parsed = parseImportStatement(stmt);
    if (parsed) {
      imports.push(parsed);
    }
  }

  // Dynamic imports: `import('...')` or `await import('...')`
  // These appear as `call_expression` with function = `import`
  const callExpressions = rootNode.descendantsOfType("call_expression");
  for (const call of callExpressions) {
    const fn = call.childForFieldName("function");
    if (fn && fn.type === "import") {
      const args = call.childForFieldName("arguments");
      if (args && args.namedChildren.length > 0) {
        const sourceNode = args.namedChildren[0];
        if (
          sourceNode.type === "string" ||
          sourceNode.type === "template_string"
        ) {
          imports.push({
            source: stringLiteralValue(sourceNode),
            names: [],
            isDefault: false,
            isNamespace: false,
            isTypeOnly: false,
            isDynamic: true,
          });
        }
      }
    }
  }

  return imports;
}

function parseImportStatement(stmt: Parser.SyntaxNode): ParsedImport | null {
  // Determine the source path
  const sourceNode = stmt.childForFieldName("source");
  if (!sourceNode) return null;
  const source = stringLiteralValue(sourceNode);

  // Check for `import type`
  const isTypeOnly =
    stmt.children.some(
      (c) => c.type === "type" || (c.type === "import" && false),
    ) || stmt.text.startsWith("import type ");

  const names: string[] = [];
  let isDefault = false;
  let isNamespace = false;

  // Walk children to find import clause, namespace import, or named imports
  for (const child of stmt.children) {
    // `import_clause` contains the default import identifier and/or named imports
    if (child.type === "import_clause") {
      for (const clauseChild of child.children) {
        if (clauseChild.type === "identifier") {
          // Default import: `import Foo from '...'`
          names.push(clauseChild.text);
          isDefault = true;
        } else if (clauseChild.type === "namespace_import") {
          // Namespace import: `import * as Foo from '...'`
          // Note: childForFieldName("name") does not work here;
          // the identifier is an unnamed child of namespace_import.
          const identifiers =
            clauseChild.descendantsOfType("identifier");
          if (identifiers.length > 0) {
            names.push(identifiers[0].text);
          }
          isNamespace = true;
        } else if (clauseChild.type === "named_imports") {
          // Named imports: `import { A, B } from '...'`
          const specifiers =
            clauseChild.descendantsOfType("import_specifier");
          for (const spec of specifiers) {
            const aliasNode = spec.childForFieldName("alias");
            const nameNode = spec.childForFieldName("name");
            if (aliasNode) {
              names.push(aliasNode.text);
            } else if (nameNode) {
              names.push(nameNode.text);
            }
          }
        }
      }
    }
  }

  // Side-effect import: `import 'foo'` -- no clause at all
  // names will be empty, which is correct

  return {
    source,
    names,
    isDefault,
    isNamespace,
    isTypeOnly,
    isDynamic: false,
  };
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

function extractExports(rootNode: Parser.SyntaxNode): ParsedExport[] {
  const exports: ParsedExport[] = [];

  const exportStatements = rootNode.descendantsOfType("export_statement");
  for (const stmt of exportStatements) {
    const parsed = parseExportStatement(stmt);
    exports.push(...parsed);
  }

  return exports;
}

function parseExportStatement(stmt: Parser.SyntaxNode): ParsedExport[] {
  const results: ParsedExport[] = [];

  // Check for re-export source: `export { X } from 'Z'` or `export * from 'Z'`
  const sourceNode = stmt.childForFieldName("source");
  const source = sourceNode ? stringLiteralValue(sourceNode) : null;
  const isReExport = source !== null;

  // Check for `export default`
  const hasDefault = stmt.children.some(
    (c) => c.type === "default" || c.text === "default",
  );

  // `export * from '...'`
  const wildcardChild = childOfType(stmt, "*");
  // Also check for namespace_export: `export * as X from '...'`
  const namespaceExport = childOfType(stmt, "namespace_export");

  if (wildcardChild && !namespaceExport) {
    results.push({
      name: "*",
      isDefault: false,
      isReExport: true,
      source,
    });
    return results;
  }

  if (namespaceExport) {
    const nameNode = namespaceExport.childForFieldName("name");
    results.push({
      name: nameNode ? nameNode.text : "*",
      isDefault: false,
      isReExport: true,
      source,
    });
    return results;
  }

  // `export { X, Y }` or `export { X, Y } from '...'`
  const exportClause = childOfType(stmt, "export_clause");
  if (exportClause) {
    const specifiers = exportClause.descendantsOfType("export_specifier");
    for (const spec of specifiers) {
      const aliasNode = spec.childForFieldName("alias");
      const nameNode = spec.childForFieldName("name");
      const name = aliasNode ? aliasNode.text : nameNode ? nameNode.text : "";
      if (name) {
        results.push({
          name,
          isDefault: name === "default",
          isReExport,
          source,
        });
      }
    }
    return results;
  }

  // `export default expression`
  if (hasDefault) {
    // Try to get the name from the declaration after default
    let name = "default";
    const decl = stmt.childForFieldName("declaration");
    if (decl) {
      const declName = decl.childForFieldName("name");
      if (declName) {
        name = declName.text;
      }
    }
    // For `export default X` where X is an identifier
    for (const child of stmt.children) {
      if (child.type === "identifier" && child.text !== "default") {
        name = child.text;
        break;
      }
    }
    results.push({
      name,
      isDefault: true,
      isReExport: false,
      source: null,
    });
    return results;
  }

  // `export function X`, `export class X`, `export const X`, etc.
  const declaration = stmt.childForFieldName("declaration");
  if (declaration) {
    const names = extractDeclaredNames(declaration);
    for (const name of names) {
      results.push({
        name,
        isDefault: false,
        isReExport: false,
        source: null,
      });
    }
    return results;
  }

  // `export` in front of a named declaration (without field name)
  for (const child of stmt.namedChildren) {
    if (
      [
        "function_declaration",
        "class_declaration",
        "interface_declaration",
        "type_alias_declaration",
        "enum_declaration",
        "lexical_declaration",
        "variable_declaration",
        "abstract_class_declaration",
      ].includes(child.type)
    ) {
      const names = extractDeclaredNames(child);
      for (const name of names) {
        results.push({
          name,
          isDefault: false,
          isReExport: false,
          source: null,
        });
      }
    }
  }

  return results;
}

/** Get declared names from a declaration node. */
function extractDeclaredNames(node: Parser.SyntaxNode): string[] {
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    return [nameNode.text];
  }

  // For lexical_declaration / variable_declaration: `const a = 1, b = 2`
  if (
    node.type === "lexical_declaration" ||
    node.type === "variable_declaration"
  ) {
    const names: string[] = [];
    const declarators = node.descendantsOfType("variable_declarator");
    for (const d of declarators) {
      const n = d.childForFieldName("name");
      if (n) {
        // Could be identifier or a destructuring pattern
        if (n.type === "identifier") {
          names.push(n.text);
        } else if (
          n.type === "object_pattern" ||
          n.type === "array_pattern"
        ) {
          // For destructured exports, use the pattern text
          const idents = n.descendantsOfType("shorthand_property_identifier_pattern");
          for (const ident of idents) {
            names.push(ident.text);
          }
          // Also check plain identifiers inside patterns
          const patternIdents = n.descendantsOfType("identifier");
          for (const ident of patternIdents) {
            names.push(ident.text);
          }
        }
      }
    }
    return names;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

function extractSymbols(rootNode: Parser.SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  // Top-level function declarations
  for (const node of rootNode.descendantsOfType("function_declaration")) {
    const sym = parseFunctionDeclaration(node);
    if (sym) symbols.push(sym);
  }

  // Top-level class declarations
  for (const node of rootNode.descendantsOfType("class_declaration")) {
    const sym = parseClassDeclaration(node);
    if (sym) symbols.push(sym);

    // Methods inside the class
    const body = node.childForFieldName("body");
    if (body) {
      const methods = body.descendantsOfType("method_definition");
      for (const method of methods) {
        const msym = parseMethodDefinition(method, sym?.name ?? "");
        if (msym) symbols.push(msym);
      }
    }
  }

  // Abstract class declarations (TypeScript)
  for (const node of rootNode.descendantsOfType(
    "abstract_class_declaration",
  )) {
    const sym = parseClassDeclaration(node);
    if (sym) symbols.push(sym);

    const body = node.childForFieldName("body");
    if (body) {
      const methods = body.descendantsOfType("method_definition");
      for (const method of methods) {
        const msym = parseMethodDefinition(method, sym?.name ?? "");
        if (msym) symbols.push(msym);
      }
      // abstract method signatures
      const abstractMethods = body.descendantsOfType(
        "abstract_method_signature",
      );
      for (const method of abstractMethods) {
        const msym = parseMethodDefinition(method, sym?.name ?? "");
        if (msym) symbols.push(msym);
      }
    }
  }

  // Interface declarations
  for (const node of rootNode.descendantsOfType("interface_declaration")) {
    const sym = parseInterfaceDeclaration(node);
    if (sym) symbols.push(sym);
  }

  // Type alias declarations
  for (const node of rootNode.descendantsOfType("type_alias_declaration")) {
    const sym = parseTypeAliasDeclaration(node);
    if (sym) symbols.push(sym);
  }

  // Enum declarations
  for (const node of rootNode.descendantsOfType("enum_declaration")) {
    const sym = parseEnumDeclaration(node);
    if (sym) symbols.push(sym);
  }

  // Top-level variable declarations (const/let/var)
  // Only capture those that are direct children of the root or of export_statement
  for (const child of rootNode.children) {
    if (
      child.type === "lexical_declaration" ||
      child.type === "variable_declaration"
    ) {
      const vars = parseVariableDeclaration(child);
      symbols.push(...vars);
    }
    if (child.type === "export_statement") {
      for (const exportChild of child.namedChildren) {
        if (
          exportChild.type === "lexical_declaration" ||
          exportChild.type === "variable_declaration"
        ) {
          const vars = parseVariableDeclaration(exportChild);
          symbols.push(...vars);
        }
      }
    }
  }

  return symbols;
}

function parseFunctionDeclaration(
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

function parseClassDeclaration(node: Parser.SyntaxNode): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  let extendsName: string | null = null;
  const implementsList: string[] = [];

  // Look for extends clause (heritage)
  // In tree-sitter-typescript, class_heritage contains extends_clause and implements_clause
  const extendsClause = childOfType(node, "extends_clause");
  if (!extendsClause) {
    // Alternate: look in class_heritage
    const heritage = childOfType(node, "class_heritage");
    if (heritage) {
      const ec = childOfType(heritage, "extends_clause");
      if (ec && ec.namedChildren.length > 0) {
        extendsName = ec.namedChildren[0].text;
      }
      const ic = childOfType(heritage, "implements_clause");
      if (ic) {
        for (const child of ic.namedChildren) {
          implementsList.push(child.text);
        }
      }
    }
  } else {
    if (extendsClause.namedChildren.length > 0) {
      extendsName = extendsClause.namedChildren[0].text;
    }
  }

  // implements_clause at class level
  const implClause = childOfType(node, "implements_clause");
  if (implClause) {
    for (const child of implClause.namedChildren) {
      implementsList.push(child.text);
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

function parseMethodDefinition(
  node: Parser.SyntaxNode,
  className: string,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
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

function parseInterfaceDeclaration(
  node: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  let extendsName: string | null = null;
  const extendsClause = childOfType(node, "extends_type_clause");
  if (extendsClause && extendsClause.namedChildren.length > 0) {
    extendsName = extendsClause.namedChildren[0].text;
  }
  // Some grammars use extends_clause for interfaces too
  if (!extendsName) {
    const ec = childOfType(node, "extends_clause");
    if (ec && ec.namedChildren.length > 0) {
      extendsName = ec.namedChildren[0].text;
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

function parseTypeAliasDeclaration(
  node: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  return {
    kind: "type",
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
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  return {
    kind: "enum",
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

function parseVariableDeclaration(node: Parser.SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const declarators = node.descendantsOfType("variable_declarator");

  for (const declarator of declarators) {
    const nameNode = declarator.childForFieldName("name");
    if (!nameNode) continue;

    // Only capture simple identifiers, not destructuring
    if (nameNode.type !== "identifier") continue;

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

  return symbols;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a TypeScript (or TSX) source string using the provided tree-sitter
 * parse tree, extracting imports, exports, and symbol declarations.
 *
 * @param source - The source code text.
 * @param filePath - File path (used for error context).
 * @param tree - The tree-sitter parse tree for the source.
 * @returns Parsed imports, exports, and symbols.
 */
export function parseTypeScript(
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
