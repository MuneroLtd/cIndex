import { readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import type { DiscoveredFile, Language } from "../types.js";

/** Default directory/file patterns to always exclude. */
const DEFAULT_IGNORE_PATTERNS: string[] = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".git",
  "*.lock",
  "*.min.js",
  "*.min.css",
  "*.map",
];

/** Map file extensions to supported languages. Returns null for unsupported. */
function detectLanguage(filePath: string): Language | null {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
    case ".pyi":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".php":
      return "php";
    case ".java":
      return "java";
    case ".rb":
      return "ruby";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
    case ".hxx":
    case ".hh":
      return "cpp";
    case ".cs":
      return "csharp";
    default:
      return null;
  }
}

/**
 * Read the .gitignore at the repo root, returning an `ignore` instance
 * preloaded with default patterns and .gitignore rules.
 */
async function buildIgnoreFilter(repoRoot: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();

  // Add default ignore patterns
  ig.add(DEFAULT_IGNORE_PATTERNS);

  // Attempt to read .gitignore
  try {
    const gitignorePath = join(repoRoot, ".gitignore");
    const content = await readFile(gitignorePath, "utf-8");
    ig.add(content);
  } catch {
    // No .gitignore or unreadable -- that is fine, continue with defaults
  }

  return ig;
}

/**
 * Walk a repository directory, discovering all indexable source files.
 *
 * Applies .gitignore rules and hardcoded ignore patterns, then returns
 * metadata for every TypeScript / JavaScript file found.
 */
export async function walkRepo(repoRoot: string): Promise<DiscoveredFile[]> {
  const ig = await buildIgnoreFilter(repoRoot);

  // Use fast-glob to find all files under the repo.
  // We ask for relative paths so the ignore filter works correctly.
  const allFiles = await fg("**/*", {
    cwd: repoRoot,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    // fast-glob already skips node_modules etc. via the ignore option,
    // but we also feed through the `ignore` package for .gitignore rules.
    ignore: DEFAULT_IGNORE_PATTERNS,
  });

  // Filter through ignore rules and detect language
  const discovered: DiscoveredFile[] = [];

  for (const relPath of allFiles) {
    // Apply .gitignore rules
    if (ig.ignores(relPath)) {
      continue;
    }

    // Detect language -- skip unsupported files
    const lang = detectLanguage(relPath);
    if (lang === null) {
      continue;
    }

    const absolutePath = join(repoRoot, relPath);

    try {
      const fileStat = await stat(absolutePath);
      discovered.push({
        path: relPath,
        absolutePath,
        lang,
        mtime: fileStat.mtimeMs,
        size: fileStat.size,
      });
    } catch {
      // File disappeared between glob and stat -- skip it
      continue;
    }
  }

  return discovered;
}
