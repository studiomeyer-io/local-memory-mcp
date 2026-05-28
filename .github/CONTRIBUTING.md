# Contributing

Issues and pull requests welcome.

## Local Development

```bash
git clone https://github.com/studiomeyer-io/local-memory-mcp.git
cd local-memory-mcp
npm install
npm run dev    # starts server with tsx watch
npm test       # runs vitest with MEMORY_EMBED_MOCK=1
npm run build  # compiles TypeScript + copies schema.sql + migrations
```

Test manually:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node dist/server.js
```

## v2.0.0 embedding pipeline — test modes

The hybrid retrieval layer uses Transformers.js for embeddings. Tests don't pull the 120 MB model — `npm test` sets `MEMORY_EMBED_MOCK=1`, which switches `src/lib/embed.ts` to a deterministic bag-of-tokens fallback. Shared tokens map to overlapping buckets, so cosine similarity is still meaningful for assertions. If you need to exercise the real model in a one-off run:

```bash
unset MEMORY_EMBED_MOCK
npx vitest run src/lib/embed.test.ts   # will fetch ~30 MB on first call
```

To skip embeddings entirely (e.g. corporate proxy that blocks Hugging Face Hub), set `MEMORY_EMBED_DISABLED=1`. Tests then run with hybrid search downgraded to FTS5-only, which is also a covered path.

## Multi-platform MCPB bundle

`scripts/build-mcpb.sh` builds a per-platform `.mcpb` bundle. The script honours the host platform and the matching `better-sqlite3` + `sqlite-vec` prebuilt binaries. CI (`.github/workflows/release-mcpb.yml`) runs this on a matrix of `ubuntu-latest`, `macos-13` (Intel), `macos-14` (Apple Silicon), and `windows-latest` for every `v*` tag push, then attaches all four bundles to the release. Local cross-compilation is not supported — you can only build a bundle for the platform you're currently on.

## Pull Requests

- One feature or fix per PR
- Include tests for new tools
- Run `npm test` and `npm run build` before submitting
- Keep PRs small and focused

## Commit Messages

Format: `type: short description`

Types: `feat`, `fix`, `docs`, `chore`, `test`
