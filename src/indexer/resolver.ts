import { existsSync } from "node:fs";
import { resolve, relative, dirname, isAbsolute, normalize } from "node:path";

/**
 * Extensions to try when resolving a relative import that has no extension.
 * Order matters -- earlier entries are preferred.
 */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/**
 * Index filenames to try when an import points at a directory.
 */
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];

/**
 * Resolve an import path to a repo-relative file path.
 *
 * For relative imports (starting with `.` or `..`), this function attempts
 * to locate the actual file on disk by trying the exact path first, then
 * common extensions, then directory index files.
 *
 * For bare specifiers (e.g. `lodash`, `@scope/pkg`), returns null since
 * those refer to external packages and are resolved differently.
 *
 * @param importSource - The import path string (e.g. `./utils`, `../types`,
 *                       `lodash`).
 * @param fromFile     - The absolute path of the file containing the import.
 * @param repoRoot     - The absolute path of the repository root.
 * @returns The repo-relative path of the resolved file (using forward slashes),
 *          or null if the import could not be resolved or is a bare specifier.
 */
export function resolveImport(
  importSource: string,
  fromFile: string,
  repoRoot: string,
): string | null {
  // Bare specifier -- external module
  if (!importSource.startsWith(".")) {
    return null;
  }

  const normalizedRoot = normalize(repoRoot);
  const fromDir = dirname(fromFile);

  // Resolve the import relative to the importing file's directory
  const candidate = resolve(fromDir, importSource);

  // Security: prevent path traversal outside repo root
  if (!isWithinRoot(candidate, normalizedRoot)) {
    return null;
  }

  // 1. Try the exact path
  const exact = tryExact(candidate);
  if (exact) {
    return toRelative(exact, normalizedRoot);
  }

  // 2. Try appending extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = candidate + ext;
    if (existsSync(withExt)) {
      const rel = toRelative(withExt, normalizedRoot);
      if (rel) return rel;
    }
  }

  // 3. Try as a directory with index file
  for (const indexFile of INDEX_FILES) {
    const indexPath = resolve(candidate, indexFile);
    if (existsSync(indexPath)) {
      const rel = toRelative(indexPath, normalizedRoot);
      if (rel) return rel;
    }
  }

  return null;
}

/**
 * Try the exact path, handling the case where the import already has
 * an extension. Also strips `.js` / `.jsx` and retries with `.ts` / `.tsx`
 * because TypeScript projects often import `.js` that actually map to `.ts`.
 */
function tryExact(candidate: string): string | null {
  if (existsSync(candidate)) {
    return candidate;
  }

  // TypeScript allows importing `.js` that resolves to `.ts`
  if (candidate.endsWith(".js")) {
    const tsEquiv = candidate.slice(0, -3) + ".ts";
    if (existsSync(tsEquiv)) return tsEquiv;
    const tsxEquiv = candidate.slice(0, -3) + ".tsx";
    if (existsSync(tsxEquiv)) return tsxEquiv;
  }

  if (candidate.endsWith(".jsx")) {
    const tsxEquiv = candidate.slice(0, -4) + ".tsx";
    if (existsSync(tsxEquiv)) return tsxEquiv;
  }

  return null;
}

/** Convert an absolute path to a repo-relative forward-slash path, with traversal guard. */
function toRelative(
  absolutePath: string,
  normalizedRoot: string,
): string | null {
  const normalized = normalize(absolutePath);
  if (!isWithinRoot(normalized, normalizedRoot)) {
    return null;
  }
  const rel = relative(normalizedRoot, normalized);
  // Ensure forward slashes (for consistency on Windows/POSIX)
  return rel.split("\\").join("/");
}

/** Guard: ensure a path stays within the repo root. */
function isWithinRoot(candidate: string, normalizedRoot: string): boolean {
  const normalized = normalize(candidate);
  return (
    normalized === normalizedRoot ||
    normalized.startsWith(normalizedRoot + "/") ||
    normalized.startsWith(normalizedRoot + "\\")
  );
}
