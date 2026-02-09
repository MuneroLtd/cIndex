/**
 * cindex — unified CLI entry point
 *
 * Subcommands:
 *   (none)         Start MCP server on stdio (editor integration)
 *   status [path]  Show index status for a repository
 *   index [path]   Index or re-index a repository
 *   visualize [path] [--no-open]  Generate and open graph visualization
 *   help           Show usage information
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Database } from './storage/database.js';
import { repoStatus } from './tools/repo-status.js';
import { repoIndex } from './tools/repo-index.js';
import type { RepoStatus, IndexSummary } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
cindex — Offline codebase graph indexer for AI-powered editors

Usage:
  cindex                          Start MCP server (stdio) for editor integration
  cindex status [path]            Show index status for a repository
  cindex index [path] [options]   Index or re-index a repository
  cindex visualize [path] [opts]  Generate and open graph visualization
  cindex help                     Show this help message

Options for 'index':
  --full                          Force full re-index (default: auto-detect)
  --incremental                   Force incremental index
  --level=0|1                     Index depth (0=structure, 1=detail, default: 0)

Options for 'visualize':
  --no-open                       Generate graph HTML without opening browser

Path defaults to the current working directory if not specified.

Examples:
  cindex status                   Check if current directory is indexed
  cindex index .                  Index the current directory
  cindex index /path/to/repo      Index a specific repository
  cindex index --full             Force full re-index of current directory
  cindex visualize --no-open      Generate graph without opening browser
`.trim());
}

function openDatabase(): Database {
  const dbPath = process.env.CINDEX_DB_PATH || join(homedir(), '.cindex', 'cindex.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  return new Database(dbPath);
}

// ---------------------------------------------------------------------------
// CLI Handlers
// ---------------------------------------------------------------------------

async function handleStatus(args: string[]): Promise<void> {
  const repoPath = resolve(args[0] ?? process.cwd());
  const db = openDatabase();

  try {
    const status: RepoStatus = await repoStatus(db, repoPath);

    if (status.status === 'not_indexed') {
      console.log(`Not indexed: ${repoPath}`);
      console.log(`Run "cindex index" to index this repository.`);
      return;
    }

    console.log(`Indexed: ${status.rootPath}`);
    console.log(`  Last indexed: ${status.lastIndexedAt}`);
    console.log(`  Files:        ${status.fileCounts!.total}`);

    const byLang = status.fileCounts!.byLang;
    const langs = Object.entries(byLang).sort((a, b) => b[1] - a[1]);
    if (langs.length > 0) {
      const langStr = langs.map(([lang, count]) => `${lang}(${count})`).join(', ');
      console.log(`  Languages:    ${langStr}`);
    }

    console.log(`  Symbols:      ${status.symbolCount}`);
    console.log(`  Edges:        ${status.edgeCount}`);
  } finally {
    db.close();
  }
}

async function handleIndex(args: string[]): Promise<void> {
  // Parse options
  const positional: string[] = [];
  let mode: string | undefined;
  let level: number | undefined;

  for (const arg of args) {
    if (arg === '--full') {
      mode = 'full';
    } else if (arg === '--incremental') {
      mode = 'incremental';
    } else if (arg.startsWith('--level=')) {
      const val = parseInt(arg.split('=')[1], 10);
      if (val === 0 || val === 1) {
        level = val;
      } else {
        console.error(`Invalid level: ${arg}. Use --level=0 or --level=1.`);
        process.exit(1);
      }
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  const repoPath = resolve(positional[0] ?? process.cwd());
  const db = openDatabase();

  try {
    console.log(`Indexing: ${repoPath}`);
    const start = Date.now();
    const summary: IndexSummary = await repoIndex(db, repoPath, mode, level);
    const elapsed = Date.now() - start;

    console.log(`  Mode:          ${summary.mode}`);
    console.log(`  Level:         ${summary.level}`);
    console.log(`  Files indexed: ${summary.filesIndexed}`);
    console.log(`  Files skipped: ${summary.filesSkipped}`);
    if (summary.filesDeleted > 0) {
      console.log(`  Files deleted: ${summary.filesDeleted}`);
    }
    console.log(`  Symbols:       ${summary.symbolCount}`);
    console.log(`  Edges:         ${summary.edgeCount}`);
    console.log(`  Duration:      ${summary.durationMs}ms`);

    if (summary.warnings.length > 0) {
      console.log(`  Warnings:`);
      for (const w of summary.warnings) {
        console.log(`    - ${w}`);
      }
    }
  } finally {
    db.close();
  }
}

async function handleVisualize(args: string[]): Promise<void> {
  // Parse options
  const positional: string[] = [];
  let noOpen = false;

  for (const arg of args) {
    if (arg === '--no-open') {
      noOpen = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  const repoPath = positional[0];

  // Dynamic import to avoid bundling the large visualizer HTML in every command
  const { runVisualize } = await import('./visualizer.js');
  runVisualize(repoPath, { noOpen });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  // No args or explicitly starting server
  if (!subcommand) {
    const { startServer } = await import('./server.js');
    await startServer();
    return;
  }

  switch (subcommand) {
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      break;

    case 'status':
      await handleStatus(args.slice(1));
      break;

    case 'index':
      await handleIndex(args.slice(1));
      break;

    case 'visualize':
      await handleVisualize(args.slice(1));
      break;

    default:
      console.error(`Unknown command: ${subcommand}\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
