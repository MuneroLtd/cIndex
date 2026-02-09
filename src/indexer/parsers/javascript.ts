import type Parser from "tree-sitter";
import type {
  ParseResult,
  ParsedImport,
  ParsedExport,
  ParsedSymbol,
} from "../../types.js";
import { parseTypeScript } from "./typescript.js";

/** Helper: create an empty ParseResult. */
function emptyResult(): ParseResult {
  return { imports: [], exports: [], symbols: [] };
}

/** Helper: extract the text content of a string literal node (strip quotes). */
function stringLiteralValue(node: Parser.SyntaxNode): string {
  const text = node.text;
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("`") && text.endsWith("`"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

// ---------------------------------------------------------------------------
// CommonJS require() extraction
// ---------------------------------------------------------------------------

/**
 * Find `require('...')` calls and convert them to ParsedImport entries.
 * Only captures top-level or assignment-style requires, not nested calls.
 */
function extractRequireCalls(rootNode: Parser.SyntaxNode): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const callExpressions = rootNode.descendantsOfType("call_expression");

  for (const call of callExpressions) {
    const fn = call.childForFieldName("function");
    if (!fn || fn.type !== "identifier" || fn.text !== "require") {
      continue;
    }

    const args = call.childForFieldName("arguments");
    if (!args || args.namedChildren.length === 0) continue;

    const sourceNode = args.namedChildren[0];
    if (sourceNode.type !== "string" && sourceNode.type !== "template_string") {
      continue;
    }

    const source = stringLiteralValue(sourceNode);
    const names: string[] = [];
    let isDefault = false;
    let isNamespace = false;

    // Walk up to find the assignment context:
    //   const X = require('...')          -> default import
    //   const { A, B } = require('...')   -> named import
    const parent = call.parent;
    if (parent && parent.type === "variable_declarator") {
      const nameNode = parent.childForFieldName("name");
      if (nameNode) {
        if (nameNode.type === "identifier") {
          names.push(nameNode.text);
          isDefault = true;
        } else if (nameNode.type === "object_pattern") {
          // Destructured: const { A, B } = require('...')
          const props = nameNode.descendantsOfType(
            "shorthand_property_identifier_pattern",
          );
          for (const prop of props) {
            names.push(prop.text);
          }
          // Also check pair_pattern for renamed: const { A: B } = require('...')
          const pairs = nameNode.descendantsOfType("pair_pattern");
          for (const pair of pairs) {
            const value = pair.childForFieldName("value");
            if (value && value.type === "identifier") {
              names.push(value.text);
            }
          }
        }
      }
    }

    // Avoid duplicating if already captured by ESM import handling
    // (require inside dynamic import is rare but possible)
    imports.push({
      source,
      names,
      isDefault,
      isNamespace,
      isTypeOnly: false,
      isDynamic: false,
    });
  }

  return imports;
}

// ---------------------------------------------------------------------------
// CommonJS exports extraction
// ---------------------------------------------------------------------------

/**
 * Extract `module.exports = ...` and `exports.X = ...` patterns.
 */
function extractCommonJSExports(rootNode: Parser.SyntaxNode): ParsedExport[] {
  const exports: ParsedExport[] = [];
  const seenNames = new Set<string>();

  // Find all assignment expressions
  const assignments = rootNode.descendantsOfType("assignment_expression");

  for (const assign of assignments) {
    const left = assign.childForFieldName("left");
    const right = assign.childForFieldName("right");
    if (!left || !right) continue;

    // `module.exports = X` or `module.exports = { A, B }`
    if (left.type === "member_expression") {
      const obj = left.childForFieldName("object");
      const prop = left.childForFieldName("property");

      if (obj && prop) {
        // module.exports = ...
        if (obj.type === "identifier" && obj.text === "module" && prop.text === "exports") {
          if (right.type === "object") {
            // module.exports = { A, B, C: val }
            for (const child of right.namedChildren) {
              if (
                child.type === "shorthand_property" ||
                child.type === "shorthand_property_identifier"
              ) {
                const name = child.text;
                if (!seenNames.has(name)) {
                  seenNames.add(name);
                  exports.push({
                    name,
                    isDefault: false,
                    isReExport: false,
                    source: null,
                  });
                }
              } else if (child.type === "pair") {
                const key = child.childForFieldName("key");
                if (key) {
                  const name = key.text;
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
            }
          } else if (right.type === "identifier") {
            // module.exports = SomeClass
            const name = right.text;
            if (!seenNames.has(name)) {
              seenNames.add(name);
              exports.push({
                name,
                isDefault: true,
                isReExport: false,
                source: null,
              });
            }
          } else {
            // module.exports = <expression>
            if (!seenNames.has("default")) {
              seenNames.add("default");
              exports.push({
                name: "default",
                isDefault: true,
                isReExport: false,
                source: null,
              });
            }
          }
          continue;
        }

        // exports.X = ...
        if (obj.type === "identifier" && obj.text === "exports") {
          const name = prop.text;
          if (!seenNames.has(name)) {
            seenNames.add(name);
            exports.push({
              name,
              isDefault: false,
              isReExport: false,
              source: null,
            });
          }
          continue;
        }

        // module.exports.X = ...
        if (
          obj.type === "member_expression" &&
          obj.childForFieldName("object")?.text === "module" &&
          obj.childForFieldName("property")?.text === "exports"
        ) {
          const name = prop.text;
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
    }
  }

  return exports;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a JavaScript source string using the provided tree-sitter parse tree.
 *
 * Handles both ESM (import/export) and CommonJS (require/module.exports).
 * ESM extraction is delegated to the TypeScript parser since the node types
 * are identical for the overlapping ES module syntax.
 *
 * @param source - The source code text.
 * @param filePath - File path (used for error context).
 * @param tree - The tree-sitter parse tree for the source.
 * @returns Parsed imports, exports, and symbols.
 */
export function parseJavaScript(
  source: string,
  filePath: string,
  tree: Parser.Tree,
): ParseResult {
  try {
    const rootNode = tree.rootNode;

    // Reuse the TypeScript parser for ESM syntax and symbol extraction
    // (the tree-sitter-javascript grammar uses the same node types for
    //  import_statement, export_statement, function_declaration, etc.)
    const esmResult = parseTypeScript(source, filePath, tree);

    // Layer on CommonJS patterns
    const cjsImports = extractRequireCalls(rootNode);
    const cjsExports = extractCommonJSExports(rootNode);

    // Deduplicate imports by source (ESM takes priority)
    const esmSources = new Set(esmResult.imports.map((i) => i.source));
    const uniqueCjsImports = cjsImports.filter(
      (i) => !esmSources.has(i.source),
    );

    // Deduplicate exports by name (ESM takes priority)
    const esmExportNames = new Set(esmResult.exports.map((e) => e.name));
    const uniqueCjsExports = cjsExports.filter(
      (e) => !esmExportNames.has(e.name),
    );

    return {
      imports: [...esmResult.imports, ...uniqueCjsImports],
      exports: [...esmResult.exports, ...uniqueCjsExports],
      symbols: esmResult.symbols,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[cindex] Failed to parse ${filePath}: ${message}`);
    return emptyResult();
  }
}
