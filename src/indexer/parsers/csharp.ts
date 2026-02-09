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

/** Helper: get the first line of the node text, truncated to 200 chars. */
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

/**
 * Helper: check if a declaration node has a `public` modifier.
 * In the tree-sitter-c-sharp grammar, modifiers appear as direct children
 * of the declaration node with type `modifier`.
 */
function hasPublicModifier(node: Parser.SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "modifier" && child.text === "public") {
      return true;
    }
  }
  return false;
}

/**
 * Helper: extract the name of a type from a type node in a base_list.
 * Handles simple identifiers, generic names, and qualified names.
 */
function extractTypeName(node: Parser.SyntaxNode): string {
  if (node.type === "identifier" || node.type === "predefined_type") {
    return node.text;
  }
  if (node.type === "generic_name") {
    const identNode = node.childForFieldName("name");
    return identNode ? identNode.text : node.text;
  }
  if (node.type === "qualified_name") {
    return node.text;
  }
  // For other complex type expressions, just use the full text
  return node.text;
}

/**
 * Helper: extract base types from a base_list node.
 * Returns an array of type name strings.
 * In tree-sitter-c-sharp, `base_list` contains children separated by commas.
 * Each base type is typically an `identifier`, `generic_name`, or `qualified_name`.
 */
function extractBaseTypes(baseList: Parser.SyntaxNode): string[] {
  const types: string[] = [];
  for (const child of baseList.namedChildren) {
    // Skip colon and comma punctuation; only process type nodes
    if (
      child.type === "identifier" ||
      child.type === "generic_name" ||
      child.type === "qualified_name" ||
      child.type === "predefined_type"
    ) {
      types.push(extractTypeName(child));
    }
    // Some grammars wrap base types in a simple_base_type or other wrapper
    // Fallback: if the child is a named node we haven't matched, try its text
    if (
      child.type !== "identifier" &&
      child.type !== "generic_name" &&
      child.type !== "qualified_name" &&
      child.type !== "predefined_type" &&
      child.type !== "," &&
      child.type !== ":"
    ) {
      // Could be a wrapper like `simple_base_type` -- try to get the inner identifier
      const innerIdent =
        child.childForFieldName("name") ||
        childOfType(child, "identifier") ||
        childOfType(child, "generic_name") ||
        childOfType(child, "qualified_name");
      if (innerIdent) {
        types.push(extractTypeName(innerIdent));
      } else if (child.text && child.text.trim()) {
        types.push(child.text.trim());
      }
    }
  }
  return types;
}

/**
 * Helper: parse extends/implements from a base_list.
 * The first type goes into `extends`, the rest go into `implements`.
 */
function parseBaseList(
  node: Parser.SyntaxNode,
): { extendsName: string | null; implementsList: string[] } {
  const baseList = childOfType(node, "base_list");
  if (!baseList) {
    return { extendsName: null, implementsList: [] };
  }

  const types = extractBaseTypes(baseList);
  if (types.length === 0) {
    return { extendsName: null, implementsList: [] };
  }

  return {
    extendsName: types[0],
    implementsList: types.slice(1),
  };
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
  const imports: ParsedImport[] = [];

  const usingDirectives = rootNode.descendantsOfType("using_directive");
  for (const directive of usingDirectives) {
    const parsed = parseUsingDirective(directive);
    if (parsed) {
      imports.push(parsed);
    }
  }

  return imports;
}

function parseUsingDirective(
  directive: Parser.SyntaxNode,
): ParsedImport | null {
  // Detect `using static` directives
  const isStatic = directive.children.some(
    (c) => c.type === "static" || (c.type === "modifier" && c.text === "static"),
  );

  // Detect alias: `using Alias = Namespace.Type;`
  // In tree-sitter-c-sharp, alias using has a `name_equals` child or
  // the structure is: `using <identifier> = <qualified_name>;`
  const nameEquals = childOfType(directive, "name_equals");
  let alias: string | null = null;
  if (nameEquals) {
    const identNode = childOfType(nameEquals, "identifier");
    if (identNode) {
      alias = identNode.text;
    }
  }

  // Get the namespace/type name.
  // It can be a `qualified_name`, `identifier_name`, `identifier`, or `name` field.
  let source: string | null = null;

  // Try the `name` field first (common in tree-sitter-c-sharp)
  const nameNode = directive.childForFieldName("name");
  if (nameNode) {
    source = nameNode.text;
  }

  // If no `name` field, look for qualified_name or identifier children
  if (!source) {
    const qualifiedName = childOfType(directive, "qualified_name");
    if (qualifiedName) {
      source = qualifiedName.text;
    }
  }

  if (!source) {
    const identNode = childOfType(directive, "identifier");
    // Make sure this is not the alias identifier
    if (identNode && identNode.text !== alias) {
      source = identNode.text;
    }
  }

  // For alias directives, the type name might be after the `=` sign
  if (!source && alias) {
    // Look for a qualified_name or identifier that comes after `=`
    let foundEquals = false;
    for (const child of directive.children) {
      if (child.type === "=" || child.text === "=") {
        foundEquals = true;
        continue;
      }
      if (
        foundEquals &&
        (child.type === "qualified_name" || child.type === "identifier")
      ) {
        source = child.text;
        break;
      }
    }
  }

  if (!source) {
    return null;
  }

  // Extract the last segment as the imported name
  const segments = source.split(".");
  const lastName = segments[segments.length - 1];

  // For alias using: `using Alias = System.String;`
  if (alias) {
    return {
      source,
      names: [alias],
      isDefault: true,
      isNamespace: false,
      isTypeOnly: false,
      isDynamic: false,
    };
  }

  // For static using: `using static System.Math;`
  if (isStatic) {
    return {
      source,
      names: [lastName],
      isDefault: false,
      isNamespace: false,
      isTypeOnly: false,
      isDynamic: false,
    };
  }

  // Regular using: `using System;` or `using System.Collections.Generic;`
  return {
    source,
    names: [lastName],
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

  // Namespace declarations
  const namespaceDecls = rootNode.descendantsOfType("namespace_declaration");
  for (const node of namespaceDecls) {
    const sym = parseNamespaceDeclaration(node);
    if (sym) symbols.push(sym);
  }

  // File-scoped namespace declarations (C# 10+)
  const fileScopedNamespaceDecls = rootNode.descendantsOfType(
    "file_scoped_namespace_declaration",
  );
  for (const node of fileScopedNamespaceDecls) {
    const sym = parseNamespaceDeclaration(node);
    if (sym) symbols.push(sym);
  }

  // Class declarations
  const classDecls = rootNode.descendantsOfType("class_declaration");
  for (const node of classDecls) {
    const sym = parseClassDeclaration(node);
    if (sym) symbols.push(sym);
    extractMembers(node, sym?.name ?? "", symbols);
  }

  // Interface declarations
  const interfaceDecls = rootNode.descendantsOfType("interface_declaration");
  for (const node of interfaceDecls) {
    const sym = parseInterfaceDeclaration(node);
    if (sym) symbols.push(sym);
    extractMembers(node, sym?.name ?? "", symbols);
  }

  // Struct declarations
  const structDecls = rootNode.descendantsOfType("struct_declaration");
  for (const node of structDecls) {
    const sym = parseStructDeclaration(node);
    if (sym) symbols.push(sym);
    extractMembers(node, sym?.name ?? "", symbols);
  }

  // Enum declarations
  const enumDecls = rootNode.descendantsOfType("enum_declaration");
  for (const node of enumDecls) {
    const sym = parseEnumDeclaration(node);
    if (sym) symbols.push(sym);
  }

  // Record declarations (C# 9+)
  const recordDecls = rootNode.descendantsOfType("record_declaration");
  for (const node of recordDecls) {
    const sym = parseRecordDeclaration(node);
    if (sym) symbols.push(sym);
    extractMembers(node, sym?.name ?? "", symbols);
  }

  // Record struct declarations (C# 10+)
  const recordStructDecls = rootNode.descendantsOfType(
    "record_struct_declaration",
  );
  for (const node of recordStructDecls) {
    const sym = parseRecordDeclaration(node);
    if (sym) symbols.push(sym);
    extractMembers(node, sym?.name ?? "", symbols);
  }

  // Delegate declarations
  const delegateDecls = rootNode.descendantsOfType("delegate_declaration");
  for (const node of delegateDecls) {
    const sym = parseDelegateDeclaration(node);
    if (sym) symbols.push(sym);
  }

  return symbols;
}

/**
 * Extract member declarations (methods, constructors, properties, fields)
 * from inside a type declaration body.
 */
function extractMembers(
  typeNode: Parser.SyntaxNode,
  typeName: string,
  symbols: ParsedSymbol[],
): void {
  const body = childOfType(typeNode, "declaration_list");
  if (!body) return;

  // Methods
  for (const child of body.children) {
    if (child.type === "method_declaration") {
      const sym = parseMethodDeclaration(child, typeName);
      if (sym) symbols.push(sym);
    } else if (child.type === "constructor_declaration") {
      const sym = parseConstructorDeclaration(child, typeName);
      if (sym) symbols.push(sym);
    } else if (child.type === "property_declaration") {
      const sym = parsePropertyDeclaration(child, typeName);
      if (sym) symbols.push(sym);
    } else if (child.type === "field_declaration") {
      const fieldSyms = parseFieldDeclaration(child, typeName);
      symbols.push(...fieldSyms);
    }
  }
}

function parseNamespaceDeclaration(
  node: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
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
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const { extendsName, implementsList } = parseBaseList(node);

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
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const { extendsName, implementsList } = parseBaseList(node);

  return {
    kind: "interface",
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

function parseStructDeclaration(node: Parser.SyntaxNode): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const { extendsName, implementsList } = parseBaseList(node);

  return {
    kind: "struct",
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

function parseRecordDeclaration(node: Parser.SyntaxNode): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const { extendsName, implementsList } = parseBaseList(node);

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

function parseDelegateDeclaration(
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

function parseMethodDeclaration(
  node: Parser.SyntaxNode,
  typeName: string,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const qualifiedName = typeName
    ? `${typeName}.${nameNode.text}`
    : nameNode.text;

  return {
    kind: "method",
    name: qualifiedName,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

function parseConstructorDeclaration(
  node: Parser.SyntaxNode,
  typeName: string,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  const ctorName = nameNode ? nameNode.text : typeName;

  const qualifiedName = typeName
    ? `${typeName}.${ctorName}`
    : ctorName;

  return {
    kind: "method",
    name: qualifiedName,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

function parsePropertyDeclaration(
  node: Parser.SyntaxNode,
  typeName: string,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const qualifiedName = typeName
    ? `${typeName}.${nameNode.text}`
    : nameNode.text;

  return {
    kind: "property",
    name: qualifiedName,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

function parseFieldDeclaration(
  node: Parser.SyntaxNode,
  typeName: string,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  // A field_declaration can declare multiple variables:
  // `public int x, y;`
  // In tree-sitter-c-sharp, the variable names are in `variable_declaration`
  // which contains `variable_declarator` children.
  const varDecl = childOfType(node, "variable_declaration");
  if (varDecl) {
    const declarators = varDecl.descendantsOfType("variable_declarator");
    for (const declarator of declarators) {
      const nameNode = declarator.childForFieldName("name");
      if (!nameNode) {
        // Some grammars use a direct identifier child instead of a `name` field
        const ident = childOfType(declarator, "identifier");
        if (ident) {
          const qualifiedName = typeName
            ? `${typeName}.${ident.text}`
            : ident.text;
          symbols.push({
            kind: "variable",
            name: qualifiedName,
            signature: signatureOf(node),
            startLine: node.startPosition.row + 1,
            startCol: node.startPosition.column + 1,
            endLine: node.endPosition.row + 1,
            endCol: node.endPosition.column + 1,
            extends: null,
            implements: [],
          });
        }
        continue;
      }

      const qualifiedName = typeName
        ? `${typeName}.${nameNode.text}`
        : nameNode.text;

      symbols.push({
        kind: "variable",
        name: qualifiedName,
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

  // Fallback: if no variable_declaration wrapper, look for direct identifier children
  if (symbols.length === 0) {
    for (const child of node.namedChildren) {
      if (child.type === "variable_declarator") {
        const nameNode =
          child.childForFieldName("name") || childOfType(child, "identifier");
        if (nameNode) {
          const qualifiedName = typeName
            ? `${typeName}.${nameNode.text}`
            : nameNode.text;
          symbols.push({
            kind: "variable",
            name: qualifiedName,
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
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Export extraction (public symbols are exported in C#)
// ---------------------------------------------------------------------------

function extractExports(rootNode: Parser.SyntaxNode): ParsedExport[] {
  const exports: ParsedExport[] = [];

  // Type declarations that can be public
  const typeDeclarationTypes = [
    "class_declaration",
    "interface_declaration",
    "struct_declaration",
    "enum_declaration",
    "record_declaration",
    "record_struct_declaration",
    "delegate_declaration",
  ];

  for (const typeName of typeDeclarationTypes) {
    const declarations = rootNode.descendantsOfType(typeName);
    for (const decl of declarations) {
      if (hasPublicModifier(decl)) {
        const nameNode = decl.childForFieldName("name");
        if (nameNode) {
          exports.push({
            name: nameNode.text,
            isDefault: false,
            isReExport: false,
            source: null,
          });
        }

        // Also check public members inside the type
        const body = childOfType(decl, "declaration_list");
        if (body) {
          extractPublicMemberExports(body, nameNode?.text ?? "", exports);
        }
      }
    }
  }

  return exports;
}

/**
 * Extract exports from public members inside a type declaration body.
 */
function extractPublicMemberExports(
  body: Parser.SyntaxNode,
  typeName: string,
  exports: ParsedExport[],
): void {
  for (const child of body.children) {
    if (!hasPublicModifier(child)) continue;

    let memberName: string | null = null;

    if (child.type === "method_declaration") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        memberName = `${typeName}.${nameNode.text}`;
      }
    } else if (child.type === "constructor_declaration") {
      const nameNode = child.childForFieldName("name");
      const ctorName = nameNode ? nameNode.text : typeName;
      memberName = `${typeName}.${ctorName}`;
    } else if (child.type === "property_declaration") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        memberName = `${typeName}.${nameNode.text}`;
      }
    } else if (child.type === "field_declaration") {
      const varDecl = childOfType(child, "variable_declaration");
      if (varDecl) {
        const declarators = varDecl.descendantsOfType("variable_declarator");
        for (const declarator of declarators) {
          const nameNode =
            declarator.childForFieldName("name") ||
            childOfType(declarator, "identifier");
          if (nameNode) {
            exports.push({
              name: `${typeName}.${nameNode.text}`,
              isDefault: false,
              isReExport: false,
              source: null,
            });
          }
        }
        continue; // Fields handled above, skip the push below
      }
    }

    if (memberName) {
      exports.push({
        name: memberName,
        isDefault: false,
        isReExport: false,
        source: null,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a C# source string using the provided tree-sitter parse tree,
 * extracting imports (using directives), exports (public declarations),
 * and symbol declarations.
 *
 * C# visibility is determined by the `public` modifier. Using directives
 * serve as the import mechanism. Symbols include classes, interfaces,
 * structs, enums, records, delegates, methods, constructors, properties,
 * fields, and namespaces.
 *
 * @param source - The source code text.
 * @param filePath - File path (used for error context).
 * @param tree - The tree-sitter parse tree for the source.
 * @returns Parsed imports, exports, and symbols.
 */
export function parseCSharp(
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
