import type Parser from "tree-sitter";
import type {
  ParseResult,
  ParsedImport,
  ParsedExport,
  ParsedSymbol,
} from "../../types.js";

/** Return an empty ParseResult (used as fallback on errors). */
function emptyResult(): ParseResult {
  return { imports: [], exports: [], symbols: [] };
}

/** Get the first line of the node text for use as a signature, truncated to 200 chars. */
function signatureOf(node: Parser.SyntaxNode): string {
  const firstLine = node.text.split("\n")[0];
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
}

/** Find a direct child node of a given type. */
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

/** Check whether a declaration node has a `public` modifier. */
function hasPublicModifier(node: Parser.SyntaxNode): boolean {
  const modifiers = childOfType(node, "modifiers");
  if (!modifiers) return false;
  for (const child of modifiers.children) {
    if (child.type === "public") {
      return true;
    }
  }
  return false;
}

/** Check whether an import_declaration node has a `static` keyword child. */
function hasStaticModifier(node: Parser.SyntaxNode): boolean {
  for (const child of node.children) {
    if (child.type === "static") {
      return true;
    }
  }
  return false;
}

/** Find the first descendant of the given type (breadth-first). */
function findDescendantOfType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | null {
  const queue: Parser.SyntaxNode[] = [...node.children];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.type === type) {
      return current;
    }
    queue.push(...current.children);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Extract imports from Java source.
 *
 * Java import declarations take these forms:
 *   import java.util.List;           -> source: "java.util", names: ["List"]
 *   import java.util.*;              -> source: "java.util", names: [], isNamespace: true
 *   import static java.lang.Math.PI; -> source: "java.lang.Math", names: ["PI"]
 */
function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const importNodes = rootNode.descendantsOfType("import_declaration");

  for (const importNode of importNodes) {
    const parsed = parseImportDeclaration(importNode);
    if (parsed) {
      imports.push(parsed);
    }
  }

  return imports;
}

function parseImportDeclaration(
  node: Parser.SyntaxNode,
): ParsedImport | null {
  const isStatic = hasStaticModifier(node);

  // In tree-sitter-java, the import path is a nested scoped_identifier tree.
  // For wildcard imports (`import java.util.*`), the outermost scoped_identifier
  // has an asterisk node as its `name` field, and the `scope` field holds the package.
  let fullPath = "";
  let isWildcard = false;

  // Check for an asterisk descendant (wildcard import)
  const asteriskNode = findDescendantOfType(node, "asterisk");

  if (asteriskNode) {
    isWildcard = true;

    // The asterisk is the `name` child of a scoped_identifier.
    // The `scope` field of that scoped_identifier is the package path.
    const parentScoped = asteriskNode.parent;
    if (parentScoped && parentScoped.type === "scoped_identifier") {
      const scopeNode = parentScoped.childForFieldName("scope");
      if (scopeNode) {
        fullPath = scopeNode.text;
      }
    }
  } else {
    // Regular import: find the scoped_identifier that contains the full path
    const scopedId = findDescendantOfType(node, "scoped_identifier");
    if (scopedId) {
      fullPath = scopedId.text;
    } else {
      // Could be a simple single-segment import (rare, same-package class)
      const identNode = findDescendantOfType(node, "identifier");
      if (identNode) {
        return {
          source: "",
          names: [identNode.text],
          isDefault: false,
          isNamespace: false,
          isTypeOnly: !isStatic,
          isDynamic: false,
        };
      }
      return null;
    }
  }

  if (!fullPath && !isWildcard) {
    return null;
  }

  if (isWildcard) {
    return {
      source: fullPath,
      names: [],
      isDefault: false,
      isNamespace: true,
      isTypeOnly: !isStatic,
      isDynamic: false,
    };
  }

  // Split the path: last segment is the imported name, rest is the source package.
  const lastDot = fullPath.lastIndexOf(".");
  if (lastDot === -1) {
    return {
      source: "",
      names: [fullPath],
      isDefault: false,
      isNamespace: false,
      isTypeOnly: !isStatic,
      isDynamic: false,
    };
  }

  const source = fullPath.substring(0, lastDot);
  const name = fullPath.substring(lastDot + 1);

  return {
    source,
    names: [name],
    isDefault: false,
    isNamespace: false,
    isTypeOnly: !isStatic,
    isDynamic: false,
  };
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/**
 * Extract exports from Java source.
 *
 * Java has no `export` keyword. Public declarations are the equivalent of
 * exports, since they are accessible from other compilation units.
 */
function extractExports(rootNode: Parser.SyntaxNode): ParsedExport[] {
  const exports: ParsedExport[] = [];
  const seenNames = new Set<string>();

  for (const child of rootNode.children) {
    const publicNames = extractPublicNames(child);
    for (const name of publicNames) {
      if (!seenNames.has(name)) {
        seenNames.add(name);
        exports.push({
          name,
          isDefault: false,
          isReExport: false,
          source: null,
        });
      }
    }
  }

  return exports;
}

/**
 * Extract names from a declaration node that has a `public` modifier.
 * Returns an array of names (usually one, but fields can declare multiple).
 */
function extractPublicNames(node: Parser.SyntaxNode): string[] {
  const typeDeclarations = [
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "annotation_type_declaration",
    "record_declaration",
  ];

  if (typeDeclarations.includes(node.type)) {
    if (hasPublicModifier(node)) {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        return [nameNode.text];
      }
    }
  }

  if (
    node.type === "method_declaration" ||
    node.type === "constructor_declaration"
  ) {
    if (hasPublicModifier(node)) {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        return [nameNode.text];
      }
    }
  }

  if (node.type === "field_declaration") {
    if (hasPublicModifier(node)) {
      return extractFieldNames(node);
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

function extractSymbols(rootNode: Parser.SyntaxNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  collectSymbols(rootNode, null, symbols);
  return symbols;
}

/**
 * Recursively collect symbols from the AST.
 *
 * @param node - Current AST node to inspect.
 * @param enclosingClassName - Name of the enclosing class/interface/enum, if any.
 * @param symbols - Accumulator array for discovered symbols.
 */
function collectSymbols(
  node: Parser.SyntaxNode,
  enclosingClassName: string | null,
  symbols: ParsedSymbol[],
): void {
  for (const child of node.children) {
    switch (child.type) {
      case "class_declaration": {
        const sym = parseClassDeclaration(child);
        if (sym) {
          symbols.push(sym);
          const body = child.childForFieldName("body");
          if (body) {
            collectSymbols(body, sym.name, symbols);
          }
        }
        break;
      }

      case "interface_declaration": {
        const sym = parseInterfaceDeclaration(child);
        if (sym) {
          symbols.push(sym);
          const body = child.childForFieldName("body");
          if (body) {
            collectSymbols(body, sym.name, symbols);
          }
        }
        break;
      }

      case "enum_declaration": {
        const sym = parseEnumDeclaration(child);
        if (sym) {
          symbols.push(sym);
          const body = child.childForFieldName("body");
          if (body) {
            collectSymbols(body, sym.name, symbols);
          }
        }
        break;
      }

      case "annotation_type_declaration": {
        const sym = parseAnnotationTypeDeclaration(child);
        if (sym) {
          symbols.push(sym);
        }
        break;
      }

      case "record_declaration": {
        const sym = parseRecordDeclaration(child);
        if (sym) {
          symbols.push(sym);
          const body = child.childForFieldName("body");
          if (body) {
            collectSymbols(body, sym.name, symbols);
          }
        }
        break;
      }

      case "method_declaration": {
        if (enclosingClassName) {
          const sym = parseMethodDeclaration(child, enclosingClassName);
          if (sym) {
            symbols.push(sym);
          }
        }
        break;
      }

      case "constructor_declaration": {
        if (enclosingClassName) {
          const sym = parseConstructorDeclaration(child, enclosingClassName);
          if (sym) {
            symbols.push(sym);
          }
        }
        break;
      }

      case "field_declaration": {
        if (enclosingClassName) {
          const fieldSymbols = parseFieldDeclaration(
            child,
            enclosingClassName,
          );
          symbols.push(...fieldSymbols);
        }
        break;
      }

      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Class / Interface / Enum / Record / Annotation parsers
// ---------------------------------------------------------------------------

function parseClassDeclaration(node: Parser.SyntaxNode): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  let extendsName: string | null = null;
  const implementsList: string[] = [];

  // In tree-sitter-java, the superclass clause (`extends Foo`) is a child node
  // of type "superclass". It contains the parent type as its child.
  const superclassNode = childOfType(node, "superclass");
  if (superclassNode) {
    extendsName = extractTypeName(superclassNode);
  }

  // The implements clause (`implements Foo, Bar`) is a "super_interfaces" node
  // containing a "type_list" with the individual types.
  const superInterfacesNode = childOfType(node, "super_interfaces");
  if (superInterfacesNode) {
    const typeList = childOfType(superInterfacesNode, "type_list");
    if (typeList) {
      for (const typeChild of typeList.namedChildren) {
        const name = extractTypeNameFromNode(typeChild);
        if (name) {
          implementsList.push(name);
        }
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
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  let extendsName: string | null = null;

  // In tree-sitter-java, interface extension (`extends Foo, Bar`) uses
  // an "extends_interfaces" node containing a "type_list".
  const extendsInterfacesNode = childOfType(node, "extends_interfaces");
  if (extendsInterfacesNode) {
    const typeList = childOfType(extendsInterfacesNode, "type_list");
    if (typeList && typeList.namedChildren.length > 0) {
      extendsName = extractTypeNameFromNode(typeList.namedChildren[0]);
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

function parseEnumDeclaration(node: Parser.SyntaxNode): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const implementsList: string[] = [];

  const superInterfacesNode = childOfType(node, "super_interfaces");
  if (superInterfacesNode) {
    const typeList = childOfType(superInterfacesNode, "type_list");
    if (typeList) {
      for (const typeChild of typeList.namedChildren) {
        const name = extractTypeNameFromNode(typeChild);
        if (name) {
          implementsList.push(name);
        }
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

function parseAnnotationTypeDeclaration(
  node: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  return {
    kind: "interface",
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

  const implementsList: string[] = [];

  const superInterfacesNode = childOfType(node, "super_interfaces");
  if (superInterfacesNode) {
    const typeList = childOfType(superInterfacesNode, "type_list");
    if (typeList) {
      for (const typeChild of typeList.namedChildren) {
        const name = extractTypeNameFromNode(typeChild);
        if (name) {
          implementsList.push(name);
        }
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
    extends: null,
    implements: implementsList,
  };
}

// ---------------------------------------------------------------------------
// Method / Constructor / Field parsers
// ---------------------------------------------------------------------------

function parseMethodDeclaration(
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

function parseConstructorDeclaration(
  node: Parser.SyntaxNode,
  className: string,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  const constructorName = nameNode ? nameNode.text : className;

  return {
    kind: "method",
    name: `${className}.${constructorName}`,
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
  className: string,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const names = extractFieldNames(node);

  for (const name of names) {
    symbols.push({
      kind: "variable",
      name: `${className}.${name}`,
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
 * Extract variable names from a field_declaration node.
 * A field_declaration can declare multiple variables:
 *   `private int x, y, z;`
 */
function extractFieldNames(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];
  const declarators = node.descendantsOfType("variable_declarator");

  for (const declarator of declarators) {
    const nameNode = declarator.childForFieldName("name");
    if (nameNode) {
      names.push(nameNode.text);
    }
  }

  return names;
}

// ---------------------------------------------------------------------------
// Type name extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the type name from a superclass node.
 * The superclass node in tree-sitter-java wraps the parent type.
 */
function extractTypeName(node: Parser.SyntaxNode): string | null {
  // The superclass node's named children contain the type reference
  if (node.namedChildren.length > 0) {
    return extractTypeNameFromNode(node.namedChildren[0]);
  }
  // Fallback: strip "extends " prefix and generic parameters
  const text = node.text.trim();
  if (text.startsWith("extends ")) {
    return text.substring("extends ".length).trim().split("<")[0].trim();
  }
  return text || null;
}

/**
 * Extract a clean type name from a type node (type_identifier, generic_type,
 * scoped_type_identifier, etc.), stripping generic parameters.
 */
function extractTypeNameFromNode(node: Parser.SyntaxNode): string | null {
  if (!node) return null;

  switch (node.type) {
    case "type_identifier":
      return node.text;

    case "generic_type": {
      // `List<String>` -> extract just "List"
      const baseType = node.children[0];
      return baseType ? extractTypeNameFromNode(baseType) : node.text;
    }

    case "scoped_type_identifier": {
      // `java.util.List` -> return full qualified path, strip generics
      return node.text.split("<")[0].trim();
    }

    default:
      // Fallback: strip generics and return raw text
      return node.text.split("<")[0].trim() || null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Java source string using the provided tree-sitter parse tree,
 * extracting imports, exports (public declarations), and symbol declarations.
 *
 * @param source - The Java source code text.
 * @param filePath - File path (used for error context).
 * @param tree - The tree-sitter parse tree for the source.
 * @returns Parsed imports, exports, and symbols.
 */
export function parseJava(
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
