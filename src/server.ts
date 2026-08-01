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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './lib/logger.js';
import { closeDb, getDb } from './db/client.js';
import { getHandler, toMcpToolList, TOOLS } from './tools/registry.js';

const SERVER_NAME = 'local-memory-mcp';
// Read from package.json instead of a hardcoded literal — the literal sat at
// 2.3.0 through the 2.4.0 release, so the MCP handshake advertised a stale
// version to every client. package.json ships in the npm tarball one level
// above dist/, and the same relative path holds when running from src/.
const SERVER_VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf-8'),
).version;

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

SEARCH (v2.0.0+):
  memory_search runs hybrid retrieval — FTS5 (BM25) fused with vector
  cosine via Reciprocal Rank Fusion (RRF, k=60). Pass mode: 'fts' |
  'vector' | 'hybrid' (default) to switch modes. Embeddings use the
  multilingual-e5-small model (DE / EN / ES / 100+ languages). If the
  vector extension can't load, search falls back to FTS5 transparently.

LIFECYCLE (v2.1.0+):
  - memory_entity_open({asOf: "2026-04-15"}) — bi-temporal point-in-time
    view. Returns observations whose validity window contained that
    instant. "What did I know at this date?"
  - memory_contradictions() — LLM-free scanner: surfaces observation
    pairs with high cosine similarity but disagreeing negation or
    confidence. Requires sqlite-vec.
  - memory_learn_archive({learningId, reason?}) — soft-delete a
    learning. Row stays for asOf queries; never resurfaces in search.
  - memory_learn_update({learningId, content?, confidence?, tags?}) —
    edit a live learning; re-embeds atomically when content changes.
  - memory_reflect({lookbackDays?: 7}) — aggregation pass that surfaces
    most-used + stale learnings, hot entities, open decisions. Returns
    structured data PLUS markdown summary. No LLM call. Cheap to run.

LIFECYCLE + PORTABILITY (v2.2.0+):
  - memory_observation_supersede({observationId, supersededById?}) — the
    execution arm for memory_contradictions: retire a stale fact by setting
    valid_to. The row stays for asOf queries but drops out of live search
    and entity views. Pass supersededById to use the newer fact's valid_from
    as the cutoff (Zep fact-supersession).
  - memory_learn_bulk({items: [...]}) — batch-insert up to 500 learnings in
    one atomic call (parallel embedding, exact-duplicate skip). For restores,
    migrations, seeding a fresh DB.
  - memory_export({includeSessions?, includeArchived?}) — dump everything to
    a versioned JSON envelope. Embeddings re-derive on import.
  - memory_import({data}) — load an export envelope. Additive + idempotent.
    The same envelope also imports into the hosted tier (memory.studiomeyer.io).

25 tools available. Call memory_guide() for help on any topic.`;

process.stderr.write('[local-memory] imports loaded, bootstrapping db…\n');

async function main(): Promise<void> {
  // F6 fix (Critic R1): if the embedding pipeline is in mock mode in
  // production, make it loud. The mock returns deterministic FNV-1a token
  // hashes — structurally valid 384-dim vectors, semantically nonsense. A
  // user who accidentally exported MEMORY_EMBED_MOCK=1 (e.g. from a stale
  // .bashrc after debugging) would otherwise build up a corpus of garbage
  // embeddings without ever seeing an error. The warning is loud and
  // explicit so it surfaces on every startup until the env var is removed.
  if (process.env.MEMORY_EMBED_MOCK === '1') {
    process.stderr.write(
      '[local-memory] WARNING: MEMORY_EMBED_MOCK=1 is active — embeddings are deterministic token hashes, NOT semantic vectors. Do not use this in production. Unset the variable to enable the real model.\n'
    );
  }

  // Bootstrap the DB early so any schema errors surface before we announce ready.
  try {
    const db = getDb();
    logger.info('Database ready');
    process.stderr.write('[local-memory] database ready\n');
    // v2.3.0 entity-embedding backfill: existing DBs created before entities
    // were embeddable have entity rows with no vector, so vector/hybrid search
    // over entities misses them. Run a one-shot, idempotent, best-effort
    // backfill at boot — it no-ops on a fully-backfilled DB and never blocks
    // startup (a failure just leaves rows FTS-only, retried next boot).
    try {
      const { isVectorEnabled, backfillEntityEmbeddings } = await import('./db/vector.js');
      if (isVectorEnabled()) {
        const n = await backfillEntityEmbeddings(db);
        if (n > 0) process.stderr.write(`[local-memory] backfilled ${n} entity embedding(s)\n`);
      }
    } catch (err) {
      logger.warn(`[local-memory] entity embedding backfill skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
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
