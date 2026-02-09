import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { Database } from '../storage/database.js';
import {
  RepoRepository,
  FileRepository,
  SymbolRepository,
  EdgeRepository,
  SearchRepository,
  ModuleRepository,
} from '../storage/index.js';
import { walkRepo } from './walker.js';
import { parseFile } from './parser.js';
import { resolveImport } from './resolver.js';
import { hashFile } from './hasher.js';
import type {
  IndexMode,
  IndexLevel,
  IndexSummary,
  DiscoveredFile,
  ParseResult,
  ParsedSymbol,
  FileRecord,
  SymbolRecord,
} from '../types.js';

/** Edge weight constants. */
const WEIGHT = {
  DEFINES: 1.0,
  IMPORTS: 1.0,
  EXPORTS: 0.8,
  EXTENDS: 1.0,
  IMPLEMENTS: 0.8,
} as const;

/** Batch size for transactional file processing. */
const BATCH_SIZE = 50;

/**
 * Orchestrates full and incremental indexing of a repository.
 *
 * The indexer walks the file tree, parses each source file with tree-sitter,
 * and populates the graph database with files, symbols, and edges.
 */
export class Indexer {
  private readonly repoRepo: RepoRepository;
  private readonly fileRepo: FileRepository;
  private readonly symbolRepo: SymbolRepository;
  private readonly edgeRepo: EdgeRepository;
  private readonly searchRepo: SearchRepository;
  private readonly moduleRepo: ModuleRepository;

  constructor(private readonly database: Database) {
    this.repoRepo = new RepoRepository(database);
    this.fileRepo = new FileRepository(database);
    this.symbolRepo = new SymbolRepository(database);
    this.edgeRepo = new EdgeRepository(database);
    this.searchRepo = new SearchRepository(database);
    this.moduleRepo = new ModuleRepository(database);
  }

  /**
   * Index a repository, building or updating the code graph.
   *
   * @param repoRoot - Absolute path to the repository root directory.
   * @param mode     - "full" re-indexes everything; "incremental" processes only changes.
   * @param level    - Index depth (0 = structure only, 1 = full detail). Currently unused
   *                   but reserved for future use.
   * @returns Summary statistics about the indexing run.
   */
  async indexRepo(
    repoRoot: string,
    mode: IndexMode,
    level: IndexLevel,
  ): Promise<IndexSummary> {
    const startTime = Date.now();
    const warnings: string[] = [];

    if (mode === 'full') {
      return this.indexFull(repoRoot, level, startTime, warnings);
    }
    return this.indexIncremental(repoRoot, level, startTime, warnings);
  }

  // ---------------------------------------------------------------------------
  // Full index
  // ---------------------------------------------------------------------------

  private async indexFull(
    repoRoot: string,
    level: IndexLevel,
    startTime: number,
    warnings: string[],
  ): Promise<IndexSummary> {
    // Step 1: Upsert repo record
    const repo = this.repoRepo.upsert(repoRoot);
    const repoId = repo.id;

    // Step 2: Walk the file tree
    const discoveredFiles = await walkRepo(repoRoot);

    let filesIndexed = 0;
    let filesSkipped = 0;
    let totalSymbolCount = 0;

    // Step 3: Pre-read all files (async) before entering synchronous transactions
    const fileContents = await this.readAllFiles(discoveredFiles, repoRoot, warnings);

    // Step 4: Process files in batches inside synchronous transactions
    const batches = toBatches(discoveredFiles, BATCH_SIZE);

    for (const batch of batches) {
      this.database.transaction(() => {
        for (const discovered of batch) {
          try {
            const source = fileContents.get(discovered.path);
            if (source === undefined) {
              filesSkipped++;
              continue;
            }

            const result = this.processFile(repoId, repoRoot, discovered, source, warnings);
            if (result) {
              filesIndexed++;
              totalSymbolCount += result.symbolCount;
            } else {
              filesSkipped++;
            }
          } catch (error) {
            filesSkipped++;
            const msg = error instanceof Error ? error.message : String(error);
            warnings.push(`Failed to index ${discovered.path}: ${msg}`);
          }
        }
      });
    }

    // Step 5: Resolve cross-file edges (imports) in a second pass.
    // We do this after all files are in the DB so target lookups succeed.
    this.database.transaction(() => {
      this.resolveAllImports(repoId, repoRoot, discoveredFiles, fileContents, warnings);
    });

    const edgeCount = this.edgeRepo.countByRepo(repoId);
    const durationMs = Date.now() - startTime;

    return {
      repoId,
      mode: 'full',
      level,
      filesIndexed,
      filesSkipped,
      filesDeleted: 0,
      symbolCount: totalSymbolCount,
      edgeCount,
      durationMs,
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Incremental index
  // ---------------------------------------------------------------------------

  private async indexIncremental(
    repoRoot: string,
    level: IndexLevel,
    startTime: number,
    warnings: string[],
  ): Promise<IndexSummary> {
    // Step 1: Get existing repo record
    const repo = this.repoRepo.findByPath(repoRoot);
    if (!repo) {
      throw new Error(
        `Repository not yet indexed: ${repoRoot}. Run a full index first.`,
      );
    }
    const repoId = repo.id;

    // Step 2: Discover files on disk
    const discoveredFiles = await walkRepo(repoRoot);

    // Step 3: Hash each discovered file and compute change set
    const currentFiles: Array<{ path: string; sha256: string; mtime: number }> = [];
    for (const df of discoveredFiles) {
      try {
        const sha256 = await hashFile(df.absolutePath);
        currentFiles.push({ path: df.path, sha256, mtime: df.mtime });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        warnings.push(`Failed to hash ${df.path}: ${msg}`);
      }
    }

    const changes = this.fileRepo.findChanged(repoId, currentFiles);

    // Build a lookup from path to DiscoveredFile for processing
    const discoveredByPath = new Map<string, DiscoveredFile>();
    for (const df of discoveredFiles) {
      discoveredByPath.set(df.path, df);
    }

    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesDeleted = 0;
    let totalSymbolCount = 0;

    // Step 4: Collect all files that need (re-)indexing
    const newFiles = changes.new
      .map((p) => discoveredByPath.get(p))
      .filter((f): f is DiscoveredFile => f !== undefined);

    const changedFiles = changes.changed
      .map((p) => discoveredByPath.get(p))
      .filter((f): f is DiscoveredFile => f !== undefined);

    const filesToProcess = [...newFiles, ...changedFiles];

    // Pre-read file contents asynchronously
    const fileContents = await this.readAllFiles(filesToProcess, repoRoot, warnings);

    // Step 5: Process new files in batches
    const newBatches = toBatches(newFiles, BATCH_SIZE);
    for (const batch of newBatches) {
      this.database.transaction(() => {
        for (const discovered of batch) {
          try {
            const source = fileContents.get(discovered.path);
            if (source === undefined) {
              filesSkipped++;
              continue;
            }

            const result = this.processFile(repoId, repoRoot, discovered, source, warnings);
            if (result) {
              filesIndexed++;
              totalSymbolCount += result.symbolCount;
            } else {
              filesSkipped++;
            }
          } catch (error) {
            filesSkipped++;
            const msg = error instanceof Error ? error.message : String(error);
            warnings.push(`Failed to index new file ${discovered.path}: ${msg}`);
          }
        }
      });
    }

    // Step 6: Process changed files (delete old data first, then re-index)
    const changedBatches = toBatches(changedFiles, BATCH_SIZE);
    for (const batch of changedBatches) {
      this.database.transaction(() => {
        for (const discovered of batch) {
          try {
            // Look up the existing file record to get its ID
            const existingFile = this.fileRepo.findByPath(repoId, discovered.path);
            if (existingFile) {
              // Clean up old data for this file
              this.edgeRepo.deleteByFile(existingFile.id);
              this.symbolRepo.deleteByFile(existingFile.id);
              this.searchRepo.deleteByEntity('file', existingFile.id);
            }

            const source = fileContents.get(discovered.path);
            if (source === undefined) {
              filesSkipped++;
              continue;
            }

            const result = this.processFile(repoId, repoRoot, discovered, source, warnings);
            if (result) {
              filesIndexed++;
              totalSymbolCount += result.symbolCount;
            } else {
              filesSkipped++;
            }
          } catch (error) {
            filesSkipped++;
            const msg = error instanceof Error ? error.message : String(error);
            warnings.push(`Failed to re-index ${discovered.path}: ${msg}`);
          }
        }
      });
    }

    // Step 7: Process deleted files
    if (changes.deleted.length > 0) {
      const deletedBatches = toBatches(changes.deleted, BATCH_SIZE);
      for (const batch of deletedBatches) {
        this.database.transaction(() => {
          for (const fileRecord of batch) {
            try {
              this.edgeRepo.deleteByFile(fileRecord.id);
              this.symbolRepo.deleteByFile(fileRecord.id);
              this.searchRepo.deleteByEntity('file', fileRecord.id);
              this.fileRepo.deleteByPath(repoId, fileRecord.path);
              filesDeleted++;
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              warnings.push(`Failed to clean up deleted file ${fileRecord.path}: ${msg}`);
            }
          }
        });
      }
    }

    // Step 8: Re-resolve imports for new/changed files so cross-file edges are correct.
    if (filesToProcess.length > 0) {
      this.database.transaction(() => {
        this.resolveAllImports(repoId, repoRoot, filesToProcess, fileContents, warnings);
      });
    }

    const edgeCount = this.edgeRepo.countByRepo(repoId);
    const durationMs = Date.now() - startTime;

    return {
      repoId,
      mode: 'incremental',
      level,
      filesIndexed,
      filesSkipped,
      filesDeleted,
      symbolCount: totalSymbolCount,
      edgeCount,
      durationMs,
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // File I/O helpers
  // ---------------------------------------------------------------------------

  /**
   * Pre-read all file contents asynchronously, before entering synchronous
   * transactions. Returns a map from repo-relative path to file content.
   *
   * Files that cannot be read are logged as warnings and omitted from
   * the map (they will be skipped during processing).
   */
  private async readAllFiles(
    files: DiscoveredFile[],
    repoRoot: string,
    warnings: string[],
  ): Promise<Map<string, string>> {
    const contents = new Map<string, string>();

    for (const df of files) {
      const absolutePath = join(repoRoot, df.path);
      try {
        // readFileSync is safe here since we are outside the transaction.
        // We could use async readFile, but for consistency and simplicity
        // we use sync to avoid Promise.all overhead on thousands of files.
        const source = readFileSync(absolutePath, 'utf-8');
        contents.set(df.path, source);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        warnings.push(`Cannot read ${df.path}: ${msg}`);
      }
    }

    return contents;
  }

  // ---------------------------------------------------------------------------
  // Per-file processing (synchronous -- called inside transactions)
  // ---------------------------------------------------------------------------

  /**
   * Process a single discovered file: hash, parse, and store.
   *
   * Creates file and symbol records, DEFINES edges, EXPORTS edges,
   * EXTENDS/IMPLEMENTS edges (where resolvable within the same file),
   * and search index entries.
   *
   * Import edges are NOT created here -- they require a second pass after
   * all files are in the DB (see {@link resolveAllImports}).
   *
   * @param repoId     - Database ID of the repository.
   * @param repoRoot   - Absolute path to the repository root.
   * @param discovered - File metadata from the walker.
   * @param source     - The pre-read file content string.
   * @param warnings   - Mutable array to append warning messages to.
   * @returns An object with the file record and symbol count, or null if skipped.
   */
  private processFile(
    repoId: number,
    repoRoot: string,
    discovered: DiscoveredFile,
    source: string,
    warnings: string[],
  ): { fileRecord: FileRecord; symbolCount: number } | null {
    const absolutePath = join(repoRoot, discovered.path);

    // Hash the content
    const sha256 = createHash('sha256').update(source).digest('hex');

    // Parse the source
    let parseResult: ParseResult;
    try {
      parseResult = parseFile(source, absolutePath, discovered.lang);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      warnings.push(`Parse error in ${discovered.path}: ${msg}`);
      return null;
    }

    // Upsert the file record
    const fileRecord = this.fileRepo.upsert(
      repoId,
      discovered.path,
      discovered.lang,
      sha256,
      discovered.mtime,
      discovered.size,
    );

    // Index the file in the search index
    this.searchRepo.upsert(repoId, 'file', fileRecord.id, discovered.path);

    // Track symbols created in this file for intra-file edge resolution
    const symbolsByName = new Map<string, SymbolRecord>();
    let symbolCount = 0;

    // Process symbols
    for (const parsedSymbol of parseResult.symbols) {
      const fqName = buildFqName(discovered.path, parsedSymbol);

      const symbolRecord = this.symbolRepo.insert(
        repoId,
        fileRecord.id,
        parsedSymbol.kind,
        parsedSymbol.name,
        fqName,
        parsedSymbol.signature,
        parsedSymbol.startLine,
        parsedSymbol.startCol,
        parsedSymbol.endLine,
        parsedSymbol.endCol,
      );

      symbolsByName.set(parsedSymbol.name, symbolRecord);
      symbolCount++;

      // Search index entry for the symbol
      this.searchRepo.upsert(
        repoId,
        'symbol',
        symbolRecord.id,
        `${parsedSymbol.name} ${fqName}`,
      );

      // DEFINES edge: file -> symbol
      this.edgeRepo.insert(
        repoId,
        'file',
        fileRecord.id,
        'DEFINES',
        'symbol',
        symbolRecord.id,
        null,
        WEIGHT.DEFINES,
      );
    }

    // EXPORTS edges: file -> symbol (for exported symbols)
    for (const parsedExport of parseResult.exports) {
      // Skip re-exports for now (they reference other files)
      if (parsedExport.isReExport) continue;

      const symbolRecord = symbolsByName.get(parsedExport.name);
      if (symbolRecord) {
        this.edgeRepo.insert(
          repoId,
          'file',
          fileRecord.id,
          'EXPORTS',
          'symbol',
          symbolRecord.id,
          null,
          WEIGHT.EXPORTS,
        );
      }
    }

    // EXTENDS / IMPLEMENTS edges (intra-file resolution only)
    for (const parsedSymbol of parseResult.symbols) {
      const sourceSymbol = symbolsByName.get(parsedSymbol.name);
      if (!sourceSymbol) continue;

      // EXTENDS
      if (parsedSymbol.extends) {
        const targetSymbol = symbolsByName.get(parsedSymbol.extends);
        if (targetSymbol) {
          this.edgeRepo.insert(
            repoId,
            'symbol',
            sourceSymbol.id,
            'EXTENDS',
            'symbol',
            targetSymbol.id,
            null,
            WEIGHT.EXTENDS,
          );
        }
        // Cross-file extends resolution is not implemented in this version.
      }

      // IMPLEMENTS
      for (const implName of parsedSymbol.implements) {
        const targetSymbol = symbolsByName.get(implName);
        if (targetSymbol) {
          this.edgeRepo.insert(
            repoId,
            'symbol',
            sourceSymbol.id,
            'IMPLEMENTS',
            'symbol',
            targetSymbol.id,
            null,
            WEIGHT.IMPLEMENTS,
          );
        }
      }
    }

    return { fileRecord, symbolCount };
  }

  // ---------------------------------------------------------------------------
  // Import resolution (second pass, synchronous -- called inside transaction)
  // ---------------------------------------------------------------------------

  /**
   * Resolve import statements across files and create IMPORTS edges.
   *
   * This must run after all files have been inserted into the database
   * so that target file lookups succeed.
   */
  private resolveAllImports(
    repoId: number,
    repoRoot: string,
    files: DiscoveredFile[],
    fileContents: Map<string, string>,
    warnings: string[],
  ): void {
    for (const discovered of files) {
      const absolutePath = join(repoRoot, discovered.path);

      // Use pre-read content, or fall back to synchronous read
      let source = fileContents.get(discovered.path);
      if (source === undefined) {
        try {
          source = readFileSync(absolutePath, 'utf-8');
        } catch {
          // File may have been deleted between passes -- skip
          continue;
        }
      }

      let parseResult: ParseResult;
      try {
        parseResult = parseFile(source, absolutePath, discovered.lang);
      } catch {
        continue;
      }

      const sourceFile = this.fileRepo.findByPath(repoId, discovered.path);
      if (!sourceFile) continue;

      for (const imp of parseResult.imports) {
        const resolvedPath = resolveImport(imp.source, absolutePath, repoRoot);
        if (!resolvedPath) {
          // External or unresolvable import -- skip
          continue;
        }

        const targetFile = this.fileRepo.findByPath(repoId, resolvedPath);
        if (!targetFile) {
          // Target file not in the index (possibly excluded)
          continue;
        }

        // Avoid self-imports
        if (sourceFile.id === targetFile.id) continue;

        this.edgeRepo.insert(
          repoId,
          'file',
          sourceFile.id,
          'IMPORTS',
          'file',
          targetFile.id,
          JSON.stringify({ names: imp.names, isTypeOnly: imp.isTypeOnly }),
          WEIGHT.IMPORTS,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fully-qualified name for a symbol.
 *
 * - For methods: `filePath:ClassName.methodName`
 * - For all others: `filePath:SymbolName`
 *
 * The filePath is the repo-relative path (forward slashes).
 */
function buildFqName(filePath: string, symbol: ParsedSymbol): string {
  // Methods get a compound name if we can infer the parent class.
  // Since tree-sitter parsers may not always set a parent reference,
  // we use the symbol name as-is (which may already include the class prefix
  // from the parser). The convention is:
  //   - Classes/functions/etc: "src/foo.ts:MyClass"
  //   - Methods: "src/foo.ts:MyClass.myMethod" (if the parser provides it)
  //     or "src/foo.ts:myMethod" (if not)
  return `${filePath}:${symbol.name}`;
}

/**
 * Split an array into batches of the given size.
 */
function toBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}
