#!/usr/bin/env node
/**
 * local-memory-mcp — Persistent local memory for any MCP client.
 *
 * Works with Claude Desktop, Claude Code, Cursor, Codex, Continue, and any
 * other MCP-compatible client. Talks stdio, stores everything in a single
 * SQLite file on your machine. No cloud, no API keys.
 *
 * CRITICAL: we use the low-level MCP Server with setRequestHandler, NOT the
 * high-level McpServer.registerTool — because the high-level path has known
 * issues with JSON Schema in HTTP/OAuth modes.
 *
 * CRITICAL: all logging goes to stderr. stdout is reserved for JSON-RPC.
 */

// Very first: announce we're alive on stderr, BEFORE any other import.
process.stderr.write('[local-memory] boot: node ' + process.version + '\n');

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './lib/logger.js';
import { closeDb, getDb } from './db/client.js';
import { getHandler, toMcpToolList, TOOLS } from './tools/registry.js';

const SERVER_NAME = 'local-memory-mcp';
const SERVER_VERSION = '1.0.4';

const INSTRUCTIONS = `Local Memory — Persistent memory for your AI assistant.

100% local. No cloud. No API keys. Your data stays on your machine.

FIRST TIME?
  Call memory_guide({topic: "quickstart"}) to learn how this works.

EVERY CONVERSATION:
  1. Call memory_session_start() at the beginning — loads your context.
  2. Use memory_learn() to store knowledge as you work.
  3. Use memory_entity_observe() for facts about people, projects, tools.
  4. Use memory_search() or memory_recall() to find past knowledge.
  5. Call memory_session_end() at the end to save a summary.

13 tools available. Call memory_guide() for help on any topic.`;

process.stderr.write('[local-memory] imports loaded, bootstrapping db…\n');

async function main(): Promise<void> {
  // Bootstrap the DB early so any schema errors surface before we announce ready.
  try {
    getDb();
    logger.info('Database ready');
    process.stderr.write('[local-memory] database ready\n');
  } catch (err) {
    logger.logError('Database init failed', err);
    process.stderr.write('[local-memory] database init failed: ' + (err instanceof Error ? err.stack ?? err.message : String(err)) + '\n');
    process.exit(1);
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toMcpToolList(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = getHandler(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }, null, 2) }],
        isError: true,
      };
    }

    // Zod validation
    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Validation failed',
            details: parsed.error.flatten(),
          }, null, 2),
        }],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(parsed.data);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.success,
      };
    } catch (err) {
      logger.logError(`Tool ${name} threw`, err);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
            code: 'HANDLER_THREW',
          }, null, 2),
        }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info(`${TOOLS.length} tools registered (stdio)`);
  process.stderr.write('[local-memory] ready — ' + TOOLS.length + ' tools on stdio\n');
}

// Catch ANY unhandled error that could silently kill us — Claude Desktop
// reports "Server transport closed unexpectedly" when we die without logging.
process.on('uncaughtException', (err) => {
  process.stderr.write('[local-memory] uncaughtException: ' + (err.stack ?? err.message) + '\n');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write('[local-memory] unhandledRejection: ' + String(reason) + '\n');
  process.exit(1);
});

// Graceful shutdown
const gracefulExit = (): void => {
  try { closeDb(); } catch { /* ignore */ }
  process.exit(0);
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, gracefulExit);
}
process.stdin.on('end', gracefulExit);
process.stdin.on('close', gracefulExit);

main().catch((err) => {
  process.stderr.write('[local-memory] main() rejected: ' + (err instanceof Error ? err.stack ?? err.message : String(err)) + '\n');
  logger.logError('Fatal', err);
  process.exit(1);
});
