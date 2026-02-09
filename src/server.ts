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
// Database initialization
// ---------------------------------------------------------------------------

const dbPath = process.env.CINDEX_DB_PATH || join(homedir(), '.cindex', 'cindex.db');

// Ensure the parent directory exists
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'cindex', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  {
    name: 'repo_status',
    description: 'Get indexing status of a repository',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to repo root',
        },
      },
      required: ['repo_path'],
    },
  },
  {
    name: 'repo_index',
    description: 'Index a repository to build the code graph',
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
          description: 'Indexing mode. Auto-detected if omitted.',
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
    description: 'Search indexed codebase for files and symbols',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to repo root',
        },
        query: {
          type: 'string',
          description: 'Search query string',
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
    description: 'Read a code snippet from a file in the repository',
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
    description: 'Get a context bundle of relevant code for a task',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo_path: {
          type: 'string',
          description: 'Absolute path to repo root',
        },
        task: {
          type: 'string',
          description: 'Natural-language task description',
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
              description: 'File paths to prioritize',
            },
            symbols: {
              type: 'array',
              items: { type: 'string' },
              description: 'Symbol names to prioritize',
            },
            lang: {
              type: 'string',
              description: 'Language filter',
            },
          },
        },
      },
      required: ['repo_path', 'task'],
    },
  },
];

// ---------------------------------------------------------------------------
// Handler: list tools
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOL_DEFINITIONS };
});

// ---------------------------------------------------------------------------
// Handler: call tool
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Startup and shutdown
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

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

main().catch((error) => {
  console.error('Fatal error:', error);
  db.close();
  process.exit(1);
});
