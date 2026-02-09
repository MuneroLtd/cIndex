import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { Database } from './storage/database.js';
import { repoStatus } from './tools/repo-status.js';
import { repoIndex } from './tools/repo-index.js';
import { repoSearch } from './tools/repo-search.js';
import { repoSnippet } from './tools/repo-snippet.js';
import { repoContextGet } from './tools/repo-context-get.js';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  {
    name: 'repo_status',
    description:
      'Check if a repository has been indexed by cindex. Call this early in a session to see if an index exists. If not indexed, call repo_index first. Returns file count, symbol count, edge count, and last index time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to repo root (use the current working directory)',
        },
      },
      required: ['repo_path'],
    },
  },
  {
    name: 'repo_index',
    description:
      'Index a repository to build a code graph of files, symbols, imports, and dependencies. Run this before using other cindex tools if repo_status shows no index. Use mode=incremental (default) after the first full index for fast updates. Indexing is fast (~2s for medium repos).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to repo root',
        },
        mode: {
          type: 'string',
          enum: ['full', 'incremental'],
          description: 'Indexing mode. Auto-detected if omitted (full for first run, incremental after).',
        },
        level: {
          type: 'number',
          enum: [0, 1],
          description: 'Index depth (0 = structure, 1 = detail). Defaults to 0.',
        },
      },
      required: ['repo_path'],
    },
  },
  {
    name: 'repo_search',
    description:
      'Full-text search across all indexed files and symbols. Use this to find files, classes, functions, or types by name or keyword. Returns file paths, symbol names, and types ranked by relevance.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to repo root',
        },
        query: {
          type: 'string',
          description: 'Search query string (e.g. "authentication middleware" or "UserService")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (1-100, default 20)',
        },
      },
      required: ['repo_path', 'query'],
    },
  },
  {
    name: 'repo_snippet',
    description:
      'Read source code from a specific file, optionally a line range. Use this after repo_search or repo_context_get to view full source code of interesting files or symbols.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to repo root',
        },
        file_path: {
          type: 'string',
          description: 'Relative or absolute path to the file',
        },
        start_line: {
          type: 'number',
          description: '1-based start line (inclusive)',
        },
        end_line: {
          type: 'number',
          description: '1-based end line (inclusive)',
        },
      },
      required: ['repo_path', 'file_path'],
    },
  },
  {
    name: 'repo_context_get',
    description:
      'Get a ranked context bundle of the most relevant code for a task. This is the primary tool for understanding what code is relevant before making changes. Describe the task in natural language and cindex will return ranked files and code snippets based on the dependency graph, symbol relationships, and text relevance. Use hints.paths or hints.symbols to steer results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to repo root',
        },
        task: {
          type: 'string',
          description: 'Natural-language task description (e.g. "Fix the login validation bug" or "Add rate limiting to the API")',
        },
        budget: {
          type: 'number',
          description: 'Token budget for snippets (100-50000, default 8000)',
        },
        hints: {
          type: 'object',
          description: 'Optional hints to guide context retrieval',
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'File paths to prioritize (e.g. ["src/auth/login.ts"])',
            },
            symbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Symbol names to prioritize (e.g. ["UserService", "validateToken"])',
            },
            lang: {
              type: 'string',
              description: 'Language filter (typescript, javascript, python, go, rust, php, java, ruby, c, cpp, csharp)',
            },
          },
        },
      },
      required: ['repo_path', 'task'],
    },
  },
];

// ---------------------------------------------------------------------------
// startServer — exported for cli.ts
// ---------------------------------------------------------------------------

export async function startServer(): Promise<void> {
  const dbPath = process.env.CINDEX_DB_PATH || join(homedir(), '.cindex', 'cindex.db');

  // Ensure the parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  const server = new Server(
    { name: 'cindex', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Handler: list tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  // Handler: call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case 'repo_status': {
          const { repo_path } = args as { repo_path: string };
          result = await repoStatus(db, repo_path);
          break;
        }

        case 'repo_index': {
          const { repo_path, mode, level } = args as {
            repo_path: string;
            mode?: string;
            level?: number;
          };
          result = await repoIndex(db, repo_path, mode, level);
          break;
        }

        case 'repo_search': {
          const { repo_path, query, limit } = args as {
            repo_path: string;
            query: string;
            limit?: number;
          };
          result = await repoSearch(db, repo_path, query, limit);
          break;
        }

        case 'repo_snippet': {
          const { repo_path, file_path, start_line, end_line } = args as {
            repo_path: string;
            file_path: string;
            start_line?: number;
            end_line?: number;
          };
          result = await repoSnippet(db, repo_path, file_path, start_line, end_line);
          break;
        }

        case 'repo_context_get': {
          const { repo_path, task, budget, hints } = args as {
            repo_path: string;
            task: string;
            budget?: number;
            hints?: { paths?: string[]; symbols?: string[]; lang?: string };
          };
          result = await repoContextGet(db, repo_path, task, budget, hints);
          break;
        }

        default:
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: `Unknown tool: ${name}` }),
              },
            ],
            isError: true,
          };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  });

  // Shutdown handler
  function shutdown(): void {
    try {
      db.close();
    } catch {
      // Ignore close errors during shutdown
    }
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
