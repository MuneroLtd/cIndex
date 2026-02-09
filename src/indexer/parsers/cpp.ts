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
 * Helper: strip surrounding delimiters from an include path.
 * Handles `<iostream>` -> `iostream` and `"myheader.h"` -> `myheader.h`.
 */
function stripIncludeDelimiters(text: string): string {
  if (text.startsWith("<") && text.endsWith(">")) {
    return text.slice(1, -1);
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Helper: derive a short name from an include path.
 * `"myheader.h"` -> `myheader`, `<iostream>` -> `iostream`,
 * `<sys/types.h>` -> `types`.
 */
function includeShortName(path: string): string {
  // Take the last path segment
  const segments = path.split("/");
  const filename = segments[segments.length - 1];
  // Strip file extension if present
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex > 0) {
    return filename.slice(0, dotIndex);
  }
  return filename;
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
 * Helper: check if a declaration has a `static` storage class specifier.
 * Static top-level declarations have internal linkage and are not exported.
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
 * Helper: extract the function name from a declarator chain.
 * C++ function declarators can be nested: the `declarator` field of a
 * `function_definition` is a `function_declarator`, whose own `declarator`
 * field is the actual name (an `identifier`, `qualified_identifier`,
 * `field_identifier`, or `destructor_name`).
 */
function extractFunctionName(
  declaratorNode: Parser.SyntaxNode,
): string | null {
  if (!declaratorNode) return null;

  // If this is already an identifier, return it directly
  if (
    declaratorNode.type === "identifier" ||
    declaratorNode.type === "field_identifier" ||
    declaratorNode.type === "destructor_name"
  ) {
    return declaratorNode.text;
  }

  if (declaratorNode.type === "qualified_identifier") {
    return declaratorNode.text;
  }

  // For operator overloads like `operator+`
  if (declaratorNode.type === "operator_name") {
    return declaratorNode.text;
  }

  // function_declarator -> its declarator child holds the name
  if (declaratorNode.type === "function_declarator") {
    const inner = declaratorNode.childForFieldName("declarator");
    if (inner) {
      return extractFunctionName(inner);
    }
  }

  // pointer_declarator wraps another declarator (e.g., `*funcPtr(...)`)
  if (declaratorNode.type === "pointer_declarator") {
    const inner = declaratorNode.childForFieldName("declarator");
    if (inner) {
      return extractFunctionName(inner);
    }
  }

  // reference_declarator wraps another declarator
  if (declaratorNode.type === "reference_declarator") {
    const inner = declaratorNode.childForFieldName("declarator");
    if (inner) {
      return extractFunctionName(inner);
    }
    // Some grammars put the child directly
    for (const child of declaratorNode.namedChildren) {
      const result = extractFunctionName(child);
      if (result) return result;
    }
  }

  // parenthesized_declarator: `(funcName)(...)`
  if (declaratorNode.type === "parenthesized_declarator") {
    for (const child of declaratorNode.namedChildren) {
      const result = extractFunctionName(child);
      if (result) return result;
    }
  }

  // template_function: `foo<T>(...)`
  if (declaratorNode.type === "template_function") {
    const nameChild = declaratorNode.childForFieldName("name");
    if (nameChild) {
      return extractFunctionName(nameChild);
    }
  }

  // structured_binding_declarator or other less common forms -- fallback
  // Try childForFieldName("declarator") generically
  const genericInner = declaratorNode.childForFieldName("declarator");
  if (genericInner) {
    return extractFunctionName(genericInner);
  }

  return null;
}

/**
 * Helper: extract base class names from a `base_class_clause` node.
 * Returns an array of type name strings in declaration order.
 */
function extractBaseClasses(baseClauseNode: Parser.SyntaxNode): string[] {
  const bases: string[] = [];
  // base_class_clause contains one or more base_class_specifier children
  // separated by commas. Each specifier may have an access specifier
  // (public/protected/private) and a type name.
  for (const child of baseClauseNode.namedChildren) {
    if (child.type === "base_class_specifier") {
      // The type name is typically a type_identifier, qualified_identifier,
      // or template_type child.
      const typeName = extractBaseClassName(child);
      if (typeName) {
        bases.push(typeName);
      }
    }
  }
  return bases;
}

/**
 * Helper: extract the type name from a single `base_class_specifier` node.
 * Skips access specifiers (public, protected, private, virtual).
 */
function extractBaseClassName(specNode: Parser.SyntaxNode): string | null {
  for (const child of specNode.namedChildren) {
    if (child.type === "access_specifier") continue;
    if (child.type === "virtual") continue;

    // type_identifier, qualified_identifier, template_type, etc.
    if (
      child.type === "type_identifier" ||
      child.type === "qualified_identifier" ||
      child.type === "template_type"
    ) {
      return child.text;
    }
  }

  // Fallback: look for any unnamed type children
  for (const child of specNode.children) {
    if (
      child.type === "type_identifier" ||
      child.type === "qualified_identifier" ||
      child.type === "template_type"
    ) {
      return child.text;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImports(rootNode: Parser.SyntaxNode): ParsedImport[] {
  const imports: ParsedImport[] = [];

  // #include directives appear as `preproc_include` nodes
  const includeNodes = rootNode.descendantsOfType("preproc_include");
  for (const node of includeNodes) {
    const parsed = parseIncludeDirective(node);
    if (parsed) {
      imports.push(parsed);
    }
  }

  // C++20 `import` declarations (module imports)
  // These may appear as `module_import` or `import_declaration` nodes
  // depending on the grammar version.
  const moduleImports = rootNode.descendantsOfType("module_import");
  for (const node of moduleImports) {
    const parsed = parseModuleImport(node);
    if (parsed) {
      imports.push(parsed);
    }
  }

  // Some grammars use `preproc_import` for C++20 imports
  const preprocImports = rootNode.descendantsOfType("preproc_import");
  for (const node of preprocImports) {
    const parsed = parseModuleImport(node);
    if (parsed) {
      imports.push(parsed);
    }
  }

  return imports;
}

function parseIncludeDirective(
  node: Parser.SyntaxNode,
): ParsedImport | null {
  // The path field contains the included file: system_lib_string (<...>)
  // or string_literal ("...").
  const pathNode = node.childForFieldName("path");
  if (pathNode) {
    const rawPath = pathNode.text;
    const cleanPath = stripIncludeDelimiters(rawPath);
    return {
      source: cleanPath,
      names: [includeShortName(cleanPath)],
      isDefault: true,
      isNamespace: false,
      isTypeOnly: false,
      isDynamic: false,
    };
  }

  // Fallback: some grammars put the path as a direct child
  // (system_lib_string or string_literal)
  for (const child of node.namedChildren) {
    if (
      child.type === "system_lib_string" ||
      child.type === "string_literal" ||
      child.type === "string"
    ) {
      const rawPath = child.text;
      const cleanPath = stripIncludeDelimiters(rawPath);
      return {
        source: cleanPath,
        names: [includeShortName(cleanPath)],
        isDefault: true,
        isNamespace: false,
        isTypeOnly: false,
        isDynamic: false,
      };
    }
  }

  return null;
}

function parseModuleImport(node: Parser.SyntaxNode): ParsedImport | null {
  // C++20 module import: `import <module_name>;` or `import "header";`
  // Extract the module name from the node text as a fallback
  const text = node.text.trim();
  // Remove trailing semicolons and the `import` keyword
  const match = text.match(/^import\s+(.+?)\s*;?\s*$/);
  if (match) {
    const rawSource = match[1];
    const cleanSource = stripIncludeDelimiters(rawSource);
    return {
      source: cleanSource,
      names: [includeShortName(cleanSource)],
      isDefault: true,
      isNamespace: false,
      isTypeOnly: false,
      isDynamic: false,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

function extractSymbols(
  rootNode: Parser.SyntaxNode,
  source: string,
): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  // Process top-level children to extract symbols.
  // We iterate children directly to avoid double-counting nested items
  // (e.g., methods inside classes).
  for (const child of rootNode.children) {
    extractSymbolsFromNode(child, symbols, null);
  }

  return symbols;
}

/**
 * Recursively extract symbols from an AST node.
 * @param node - Current AST node to inspect.
 * @param symbols - Accumulator array for discovered symbols.
 * @param enclosingClass - Name of enclosing class/struct, or null if top-level.
 */
function extractSymbolsFromNode(
  node: Parser.SyntaxNode,
  symbols: ParsedSymbol[],
  enclosingClass: string | null,
): void {
  switch (node.type) {
    case "class_specifier":
      handleClassOrStruct(node, symbols, "class", enclosingClass);
      break;

    case "struct_specifier":
      handleClassOrStruct(node, symbols, "struct", enclosingClass);
      break;

    case "function_definition":
      handleFunctionDefinition(node, symbols, enclosingClass);
      break;

    case "namespace_definition":
      handleNamespaceDefinition(node, symbols);
      break;

    case "enum_specifier":
      handleEnumSpecifier(node, symbols);
      break;

    case "template_declaration":
      handleTemplateDeclaration(node, symbols, enclosingClass);
      break;

    case "type_definition":
      handleTypeDefinition(node, symbols);
      break;

    case "alias_declaration":
      handleAliasDeclaration(node, symbols);
      break;

    case "declaration":
      handleDeclaration(node, symbols, enclosingClass);
      break;

    // Declarations inside linkage specifications: `extern "C" { ... }`
    case "linkage_specification": {
      const body = node.childForFieldName("body");
      if (body) {
        for (const child of body.children) {
          extractSymbolsFromNode(child, symbols, enclosingClass);
        }
      }
      // Also handle single-declaration form: `extern "C" void foo();`
      for (const child of node.namedChildren) {
        if (
          child.type === "function_definition" ||
          child.type === "declaration"
        ) {
          extractSymbolsFromNode(child, symbols, enclosingClass);
        }
      }
      break;
    }

    // Access specifiers in class bodies (public:, private:, protected:)
    // are skipped -- we process their sibling declarations instead.
    case "access_specifier":
      break;

    // For expression_statement and other nodes that may contain
    // nested declarations, we do not recurse to avoid noise.
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Class / Struct handling
// ---------------------------------------------------------------------------

function handleClassOrStruct(
  node: Parser.SyntaxNode,
  symbols: ParsedSymbol[],
  kind: "class" | "struct",
  enclosingClass: string | null,
): void {
  const nameNode = node.childForFieldName("name");
  // Anonymous classes/structs (e.g., inside typedefs) have no name
  if (!nameNode) return;

  const className = enclosingClass
    ? `${enclosingClass}::${nameNode.text}`
    : nameNode.text;

  let extendsName: string | null = null;
  const implementsList: string[] = [];

  // Extract base classes from the base_class_clause
  const baseClause = childOfType(node, "base_class_clause");
  if (baseClause) {
    const bases = extractBaseClasses(baseClause);
    if (bases.length > 0) {
      extendsName = bases[0];
    }
    for (let i = 1; i < bases.length; i++) {
      implementsList.push(bases[i]);
    }
  }

  symbols.push({
    kind,
    name: className,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: extendsName,
    implements: implementsList,
  });

  // Process the class body to find methods and nested types
  const body = node.childForFieldName("body");
  if (body) {
    for (const child of body.children) {
      extractSymbolsFromNode(child, symbols, className);
    }
  }
}

// ---------------------------------------------------------------------------
// Function handling
// ---------------------------------------------------------------------------

function handleFunctionDefinition(
  node: Parser.SyntaxNode,
  symbols: ParsedSymbol[],
  enclosingClass: string | null,
): void {
  const declarator = node.childForFieldName("declarator");
  if (!declarator) return;

  const name = extractFunctionName(declarator);
  if (!name) return;

  // If the function is inside a class body, it is a method
  if (enclosingClass) {
    symbols.push({
      kind: "method",
      name: `${enclosingClass}::${name}`,
      signature: signatureOf(node),
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column + 1,
      extends: null,
      implements: [],
    });
    return;
  }

  // A qualified name like `ClassName::methodName` at top level is still a
  // method definition (out-of-line method implementation).
  if (name.includes("::")) {
    symbols.push({
      kind: "method",
      name,
      signature: signatureOf(node),
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column + 1,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column + 1,
      extends: null,
      implements: [],
    });
    return;
  }

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

// ---------------------------------------------------------------------------
// Namespace handling
// ---------------------------------------------------------------------------

function handleNamespaceDefinition(
  node: Parser.SyntaxNode,
  symbols: ParsedSymbol[],
): void {
  const nameNode = node.childForFieldName("name");
  // Anonymous namespaces have no name node
  const name = nameNode ? nameNode.text : "<anonymous>";

  symbols.push({
    kind: "namespace",
    name,
    signature: signatureOf(node),
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column + 1,
    extends: null,
    implements: [],
  });

  // Recurse into the namespace body to extract nested symbols
  const body = node.childForFieldName("body");
  if (body) {
    for (const child of body.children) {
      extractSymbolsFromNode(child, symbols, null);
    }
  }
}

// ---------------------------------------------------------------------------
// Enum handling
// ---------------------------------------------------------------------------

function handleEnumSpecifier(
  node: Parser.SyntaxNode,
  symbols: ParsedSymbol[],
): void {
  const nameNode = node.childForFieldName("name");
  // Anonymous enums have no name
  if (!nameNode) return;

  symbols.push({
    kind: "enum",
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

// ---------------------------------------------------------------------------
// Template handling
// ---------------------------------------------------------------------------

function handleTemplateDeclaration(
  node: Parser.SyntaxNode,
  symbols: ParsedSymbol[],
  enclosingClass: string | null,
): void {
  // A template_declaration wraps another declaration.
  // We unwrap it and process the inner declaration, which may be a
  // function_definition, class_specifier, struct_specifier, declaration, etc.
  for (const child of node.namedChildren) {
    // Skip the template_parameter_list child
    if (child.type === "template_parameter_list") continue;

    // The inner declaration is the actual symbol to extract
    extractSymbolsFromNode(child, symbols, enclosingClass);
  }
}

// ---------------------------------------------------------------------------
// Typedef / Using handling
// ---------------------------------------------------------------------------

function handleTypeDefinition(
  node: Parser.SyntaxNode,
  symbols: ParsedSymbol[],
): void {
  // `typedef int MyInt;` or `typedef struct { ... } MyStruct;`
  // The declarator field holds the alias name.
  const declarator = node.childForFieldName("declarator");
  if (declarator) {
    const name = extractTypedefName(declarator);
    if (name) {
      symbols.push({
        kind: "type",
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

/**
 * Helper: extract the typedef name from a declarator node.
 * The declarator may be a type_identifier, a pointer_declarator wrapping
 * a type_identifier, or a function_declarator.
 */
function extractTypedefName(node: Parser.SyntaxNode): string | null {
  if (node.type === "type_identifier" || node.type === "identifier") {
    return node.text;
  }
  if (node.type === "pointer_declarator") {
    const inner = node.childForFieldName("declarator");
    if (inner) return extractTypedefName(inner);
  }
  if (node.type === "function_declarator") {
    const inner = node.childForFieldName("declarator");
    if (inner) return extractTypedefName(inner);
  }
  if (node.type === "parenthesized_declarator") {
    for (const child of node.namedChildren) {
      const result = extractTypedefName(child);
      if (result) return result;
    }
  }
  if (node.type === "array_declarator") {
    const inner = node.childForFieldName("declarator");
    if (inner) return extractTypedefName(inner);
  }
  return null;
}

function handleAliasDeclaration(
  node: Parser.SyntaxNode,
  symbols: ParsedSymbol[],
): void {
  // `using MyInt = int;`
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;

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

// ---------------------------------------------------------------------------
// Top-level declaration handling (variables, forward declarations, etc.)
// ---------------------------------------------------------------------------

function handleDeclaration(
  node: Parser.SyntaxNode,
  symbols: ParsedSymbol[],
  enclosingClass: string | null,
): void {
  // A `declaration` node at top level can be many things:
  // - Variable declarations: `int x = 5;`
  // - Forward declarations: `class Foo;`
  // - Function declarations (prototypes): `void foo(int x);`
  // - Type definitions embedded in declarations
  // - Friend declarations

  // Check if this declaration contains a class_specifier, struct_specifier,
  // or enum_specifier as the type -- if so, extract those as well.
  for (const child of node.namedChildren) {
    if (child.type === "class_specifier") {
      handleClassOrStruct(child, symbols, "class", enclosingClass);
      return;
    }
    if (child.type === "struct_specifier") {
      handleClassOrStruct(child, symbols, "struct", enclosingClass);
      return;
    }
    if (child.type === "enum_specifier") {
      handleEnumSpecifier(child, symbols);
      return;
    }
  }

  // Check if this is a function declaration (prototype) -- the declarator
  // will be a function_declarator.
  const declarator = node.childForFieldName("declarator");
  if (declarator) {
    if (isFunctionDeclarator(declarator)) {
      const name = extractFunctionName(declarator);
      if (name) {
        // Function prototype or friend declaration at class level
        if (enclosingClass) {
          symbols.push({
            kind: "method",
            name: `${enclosingClass}::${name}`,
            signature: signatureOf(node),
            startLine: node.startPosition.row + 1,
            startCol: node.startPosition.column + 1,
            endLine: node.endPosition.row + 1,
            endCol: node.endPosition.column + 1,
            extends: null,
            implements: [],
          });
        } else if (name.includes("::")) {
          symbols.push({
            kind: "method",
            name,
            signature: signatureOf(node),
            startLine: node.startPosition.row + 1,
            startCol: node.startPosition.column + 1,
            endLine: node.endPosition.row + 1,
            endCol: node.endPosition.column + 1,
            extends: null,
            implements: [],
          });
        } else {
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
        return;
      }
    }

    // Otherwise it is a variable declaration (only at top level, not in class)
    if (!enclosingClass) {
      const varName = extractVariableName(declarator);
      if (varName) {
        symbols.push({
          kind: "variable",
          name: varName,
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
    return;
  }

  // Handle multiple declarators in a single declaration: `int a, b, c;`
  // These appear as `init_declarator` children when there are initializers,
  // or as multiple declarator children.
  const initDeclarators = node.descendantsOfType("init_declarator");
  if (initDeclarators.length > 0 && !enclosingClass) {
    for (const initDecl of initDeclarators) {
      const innerDecl = initDecl.childForFieldName("declarator");
      if (innerDecl) {
        if (isFunctionDeclarator(innerDecl)) {
          const name = extractFunctionName(innerDecl);
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
          const varName = extractVariableName(innerDecl);
          if (varName) {
            symbols.push({
              kind: "variable",
              name: varName,
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
  }
}

/**
 * Helper: check if a declarator node is (or contains) a function_declarator.
 */
function isFunctionDeclarator(node: Parser.SyntaxNode): boolean {
  if (node.type === "function_declarator") return true;
  // Pointer to function: `void (*fp)(int)`
  if (node.type === "pointer_declarator") {
    const inner = node.childForFieldName("declarator");
    if (inner) return isFunctionDeclarator(inner);
  }
  if (node.type === "reference_declarator") {
    const inner = node.childForFieldName("declarator");
    if (inner) return isFunctionDeclarator(inner);
  }
  if (node.type === "parenthesized_declarator") {
    for (const child of node.namedChildren) {
      if (isFunctionDeclarator(child)) return true;
    }
  }
  return false;
}

/**
 * Helper: extract a variable name from a declarator node.
 * Handles init_declarator, identifier, pointer_declarator, array_declarator,
 * and reference_declarator chains.
 */
function extractVariableName(node: Parser.SyntaxNode): string | null {
  if (node.type === "identifier") {
    return node.text;
  }
  if (node.type === "qualified_identifier") {
    return node.text;
  }
  if (node.type === "field_identifier") {
    return node.text;
  }
  if (
    node.type === "pointer_declarator" ||
    node.type === "reference_declarator" ||
    node.type === "array_declarator"
  ) {
    const inner = node.childForFieldName("declarator");
    if (inner) return extractVariableName(inner);
  }
  if (node.type === "init_declarator") {
    const inner = node.childForFieldName("declarator");
    if (inner) return extractVariableName(inner);
  }
  if (node.type === "parenthesized_declarator") {
    for (const child of node.namedChildren) {
      const result = extractVariableName(child);
      if (result) return result;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/**
 * In C++, there are no explicit export keywords in pre-C++20 code.
 * We treat all non-static top-level functions, classes, structs,
 * namespaced items, enums, types, and variables as exports.
 */
function extractExports(
  symbols: ParsedSymbol[],
  rootNode: Parser.SyntaxNode,
): ParsedExport[] {
  const exports: ParsedExport[] = [];

  // Collect the set of top-level static declarations to exclude them
  const staticNames = new Set<string>();
  for (const child of rootNode.children) {
    if (child.type === "declaration" && hasStaticSpecifier(child)) {
      const declarator = child.childForFieldName("declarator");
      if (declarator) {
        const name =
          extractFunctionName(declarator) || extractVariableName(declarator);
        if (name) staticNames.add(name);
      }
      // Also check init_declarators
      const initDecls = child.descendantsOfType("init_declarator");
      for (const initDecl of initDecls) {
        const inner = initDecl.childForFieldName("declarator");
        if (inner) {
          const name =
            extractFunctionName(inner) || extractVariableName(inner);
          if (name) staticNames.add(name);
        }
      }
    }
    if (
      child.type === "function_definition" &&
      hasStaticSpecifier(child)
    ) {
      const declarator = child.childForFieldName("declarator");
      if (declarator) {
        const name = extractFunctionName(declarator);
        if (name) staticNames.add(name);
      }
    }
  }

  for (const sym of symbols) {
    // Skip symbols that are marked static (internal linkage)
    if (staticNames.has(sym.name)) continue;

    exports.push({
      name: sym.name,
      isDefault: false,
      isReExport: false,
      source: null,
    });
  }

  return exports;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a C++ source string using the provided tree-sitter parse tree,
 * extracting imports (#include directives), exports (non-static top-level
 * declarations), and symbol declarations (classes, structs, functions,
 * methods, namespaces, enums, typedefs, using aliases, and variables).
 *
 * @param source - The source code text.
 * @param filePath - File path (used for error context).
 * @param tree - The tree-sitter parse tree for the source.
 * @returns Parsed imports, exports, and symbols.
 */
export function parseCpp(
  source: string,
  filePath: string,
  tree: Parser.Tree,
): ParseResult {
  try {
    const rootNode = tree.rootNode;

    const imports = extractImports(rootNode);
    const symbols = extractSymbols(rootNode, source);
    const exports = extractExports(symbols, rootNode);

    return { imports, exports, symbols };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[cindex] Failed to parse ${filePath}: ${message}`);
    return emptyResult();
  }
}
