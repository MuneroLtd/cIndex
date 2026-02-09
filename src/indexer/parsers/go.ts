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

/** Helper: strip surrounding double quotes from a Go string literal. */
function stripQuotes(text: string): string {
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  // Raw string literals use backticks
  if (text.startsWith("`") && text.endsWith("`")) {
    return text.slice(1, -1);
  }
  return text;
}

/** Helper: get the first line of the node text, truncated to 200 chars. */
function signatureOf(node: Parser.SyntaxNode): string {
  const firstLine = node.text.split("\n")[0];
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
}

/** Helper: check if a Go identifier is exported (starts with uppercase). */
function isExported(name: string): boolean {
  if (name.length === 0) return false;
  const first = name.charAt(0);
  return first >= "A" && first <= "Z";
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
  const imports: ParsedImport[] = [];

  const importDeclarations = rootNode.descendantsOfType("import_declaration");
  for (const importDecl of importDeclarations) {
    // An import_declaration contains one or more import_spec nodes.
    // Single import: `import "fmt"` has one import_spec directly.
    // Grouped import: `import ( "fmt"; "os" )` has an import_spec_list
    // containing multiple import_spec nodes.
    const importSpecs = importDecl.descendantsOfType("import_spec");
    for (const spec of importSpecs) {
      const parsed = parseImportSpec(spec);
      if (parsed) {
        imports.push(parsed);
      }
    }
  }

  return imports;
}

function parseImportSpec(spec: Parser.SyntaxNode): ParsedImport | null {
  // The import_spec node has:
  //   - an optional `name` field (alias identifier, or "." or "_")
  //   - a `path` field (interpreted_string_literal)
  const pathNode = spec.childForFieldName("path");
  if (!pathNode) return null;

  const source = stripQuotes(pathNode.text);
  const nameNode = spec.childForFieldName("name");

  if (!nameNode) {
    // Plain import: `import "fmt"` -> names: ["fmt" (last segment)]
    // Use the last path segment as the default name
    const segments = source.split("/");
    const defaultName = segments[segments.length - 1];
    return {
      source,
      names: [defaultName],
      isDefault: true,
      isNamespace: false,
      isTypeOnly: false,
      isDynamic: false,
    };
  }

  const alias = nameNode.text;

  // Dot import: `import . "fmt"` -> namespace import
  if (alias === ".") {
    return {
      source,
      names: [],
      isDefault: false,
      isNamespace: true,
      isTypeOnly: false,
      isDynamic: false,
    };
  }

  // Blank import (side-effect): `import _ "fmt"`
  if (alias === "_") {
    return {
      source,
      names: ["_"],
      isDefault: false,
      isNamespace: false,
      isTypeOnly: false,
      isDynamic: false,
    };
  }

  // Aliased import: `import f "fmt"`
  return {
    source,
    names: [alias],
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

  // Function declarations: `func Foo(...) ...`
  const funcDecls = rootNode.descendantsOfType("function_declaration");
  for (const node of funcDecls) {
    const sym = parseFunctionDeclaration(node);
    if (sym) symbols.push(sym);
  }

  // Method declarations: `func (r *Receiver) Foo(...) ...`
  const methodDecls = rootNode.descendantsOfType("method_declaration");
  for (const node of methodDecls) {
    const sym = parseMethodDeclaration(node);
    if (sym) symbols.push(sym);
  }

  // Type declarations: structs, interfaces, type aliases
  const typeDecls = rootNode.descendantsOfType("type_declaration");
  for (const typeDecl of typeDecls) {
    const typeSpecs = typeDecl.descendantsOfType("type_spec");
    for (const spec of typeSpecs) {
      const sym = parseTypeSpec(spec);
      if (sym) symbols.push(sym);
    }
  }

  // Const declarations
  const constDecls = rootNode.descendantsOfType("const_declaration");
  for (const constDecl of constDecls) {
    const constSpecs = constDecl.descendantsOfType("const_spec");
    for (const spec of constSpecs) {
      const syms = parseConstSpec(spec, constDecl);
      symbols.push(...syms);
    }
  }

  // Var declarations
  const varDecls = rootNode.descendantsOfType("var_declaration");
  for (const varDecl of varDecls) {
    const varSpecs = varDecl.descendantsOfType("var_spec");
    for (const spec of varSpecs) {
      const syms = parseVarSpec(spec, varDecl);
      symbols.push(...syms);
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

function parseMethodDeclaration(
  node: Parser.SyntaxNode,
): ParsedSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const receiverNode = node.childForFieldName("receiver");
  let receiverTypeName = "";

  if (receiverNode) {
    // The receiver is a parameter_list node like `(r *Foo)` or `(r Foo)`.
    // We need to find the type identifier inside it.
    // It may contain a pointer_type wrapping a type_identifier,
    // or just a type_identifier directly.
    const pointerTypes = receiverNode.descendantsOfType("pointer_type");
    if (pointerTypes.length > 0) {
      // Pointer receiver: `(r *Foo)` -> extract "Foo" from pointer_type
      const typeIdent =
        pointerTypes[0].descendantsOfType("type_identifier");
      if (typeIdent.length > 0) {
        receiverTypeName = typeIdent[0].text;
      }
    }

    if (!receiverTypeName) {
      // Value receiver: `(r Foo)` -> look for type_identifier directly
      const typeIdents =
        receiverNode.descendantsOfType("type_identifier");
      if (typeIdents.length > 0) {
        receiverTypeName = typeIdents[0].text;
      }
    }

    // Handle generic receivers like `(r *Foo[T])` - look for generic_type
    if (!receiverTypeName) {
      const genericTypes =
        receiverNode.descendantsOfType("generic_type");
      if (genericTypes.length > 0) {
        const typeIdent =
          genericTypes[0].descendantsOfType("type_identifier");
        if (typeIdent.length > 0) {
          receiverTypeName = typeIdent[0].text;
        }
      }
    }
  }

  const methodName = receiverTypeName
    ? `${receiverTypeName}.${nameNode.text}`
    : nameNode.text;

  return {
    kind: "method",
    name: methodName,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: [],
  };
}

function parseTypeSpec(spec: Parser.SyntaxNode): ParsedSymbol | null {
  const nameNode = spec.childForFieldName("name");
  if (!nameNode) return null;

  const typeNode = spec.childForFieldName("type");
  if (!typeNode) return null;

  let kind: SymbolKind;
  let extendsName: string | null = null;

  if (typeNode.type === "struct_type") {
    kind = "struct";

    // Look for embedded types (fields with no name, just a type) as a
    // rough "extends" equivalent. The first embedded type is used.
    const fieldDeclarations = typeNode.descendantsOfType(
      "field_declaration",
    );
    for (const field of fieldDeclarations) {
      // An embedded field has no `name` field -- just a `type` field.
      const fieldName = field.childForFieldName("name");
      const fieldType = field.childForFieldName("type");

      if (!fieldName && fieldType) {
        // This is an embedded type. Extract the type name.
        if (fieldType.type === "type_identifier") {
          extendsName = fieldType.text;
          break;
        } else if (fieldType.type === "pointer_type") {
          const inner =
            fieldType.descendantsOfType("type_identifier");
          if (inner.length > 0) {
            extendsName = inner[0].text;
            break;
          }
        } else if (fieldType.type === "qualified_type") {
          // e.g., `pkg.Type`
          extendsName = fieldType.text;
          break;
        }
      }
    }
  } else if (typeNode.type === "interface_type") {
    kind = "interface";
  } else {
    kind = "type";
  }

  return {
    kind,
    name: nameNode.text,
    signature: signatureOf(spec),
    startLine: spec.startPosition.row + 1,
    startCol: spec.startPosition.column + 1,
    endLine: spec.endPosition.row + 1,
    endCol: spec.endPosition.column + 1,
    extends: extendsName,
    implements: [],
  };
}

function parseConstSpec(
  spec: Parser.SyntaxNode,
  parentDecl: Parser.SyntaxNode,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  // A const_spec can declare multiple names: `const A, B = 1, 2`
  // The `name` field may appear multiple times, or there may be
  // an identifier_list. We look for all identifier children that
  // serve as names.
  const nameNode = spec.childForFieldName("name");
  if (nameNode) {
    symbols.push({
      kind: "constant",
      name: nameNode.text,
      signature: signatureOf(spec),
      startLine: parentDecl.startPosition.row + 1,
      startCol: parentDecl.startPosition.column + 1,
      endLine: parentDecl.endPosition.row + 1,
      endCol: parentDecl.endPosition.column + 1,
      extends: null,
      implements: [],
    });
  }

  // Handle multiple names in a single const_spec if tree-sitter
  // provides them as direct identifier children (common in grouped consts).
  // Some grammars put additional names as plain identifier children
  // without the `name` field.  We skip the first if we already have it.
  const seenName = nameNode ? nameNode.text : null;
  for (const child of spec.children) {
    if (child.type === "identifier" && child.text !== seenName) {
      symbols.push({
        kind: "constant",
        name: child.text,
        signature: signatureOf(spec),
        startLine: parentDecl.startPosition.row + 1,
        startCol: parentDecl.startPosition.column + 1,
        endLine: parentDecl.endPosition.row + 1,
        endCol: parentDecl.endPosition.column + 1,
        extends: null,
        implements: [],
      });
    }
  }

  return symbols;
}

function parseVarSpec(
  spec: Parser.SyntaxNode,
  parentDecl: Parser.SyntaxNode,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  const nameNode = spec.childForFieldName("name");
  if (nameNode) {
    symbols.push({
      kind: "variable",
      name: nameNode.text,
      signature: signatureOf(spec),
      startLine: parentDecl.startPosition.row + 1,
      startCol: parentDecl.startPosition.column + 1,
      endLine: parentDecl.endPosition.row + 1,
      endCol: parentDecl.endPosition.column + 1,
      extends: null,
      implements: [],
    });
  }

  // Handle multiple names in a single var_spec similarly to const_spec.
  const seenName = nameNode ? nameNode.text : null;
  for (const child of spec.children) {
    if (child.type === "identifier" && child.text !== seenName) {
      symbols.push({
        kind: "variable",
        name: child.text,
        signature: signatureOf(spec),
        startLine: parentDecl.startPosition.row + 1,
        startCol: parentDecl.startPosition.column + 1,
        endLine: parentDecl.endPosition.row + 1,
        endCol: parentDecl.endPosition.column + 1,
        extends: null,
        implements: [],
      });
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Export extraction (uppercase symbols are exported in Go)
// ---------------------------------------------------------------------------

function extractExports(symbols: ParsedSymbol[]): ParsedExport[] {
  const exports: ParsedExport[] = [];

  for (const sym of symbols) {
    // For methods like "ReceiverType.MethodName", check the method name part
    const nameParts = sym.name.split(".");
    const leafName = nameParts[nameParts.length - 1];

    if (isExported(leafName)) {
      exports.push({
        name: sym.name,
        isDefault: false,
        isReExport: false,
        source: null,
      });
    }
  }

  return exports;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Go source string using the provided tree-sitter parse tree,
 * extracting imports, exports, and symbol declarations.
 *
 * In Go, exported identifiers are those that start with an uppercase letter.
 * The parser extracts functions, methods, structs, interfaces, type aliases,
 * constants, and variables from the AST.
 *
 * @param source - The source code text.
 * @param filePath - File path (used for error context).
 * @param tree - The tree-sitter parse tree for the source.
 * @returns Parsed imports, exports, and symbols.
 */
export function parseGo(
  source: string,
  filePath: string,
  tree: Parser.Tree,
): ParseResult {
  try {
    const rootNode = tree.rootNode;

    const imports = extractImports(rootNode);
    const symbols = extractSymbols(rootNode);
    const exports = extractExports(symbols);

    return { imports, exports, symbols };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[cindex] Failed to parse ${filePath}: ${message}`);
    return emptyResult();
  }
}
