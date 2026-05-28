# Security Policy

## Reporting a Vulnerability

If you find a security vulnerability, please report it privately.

**Email:** hello@studiomeyer.io

Please do not open a public GitHub issue for security vulnerabilities.

We will acknowledge your report within 48 hours and provide a fix timeline within 7 days.

## Threat Model

`local-memory-mcp` is a single-user, local-only MCP server. It runs as a stdio process invoked by an MCP client on the same machine and stores all data in a single SQLite file under the user's local data directory.

- **No network code in our source.** No HTTP server, no fetch, no API calls in `src/`. The process talks to its parent over stdio only.
- **No shell execution.** No `child_process`, no `spawn`, no `execSync`, no `execFile`. The codebase has zero subprocess invocations. See "Known SAST scanner false positives" below.
- **No telemetry.** No analytics, no phone-home, no crash reporting.
- **Local filesystem only.** The SQLite file lives at `~/Library/Application Support/local-memory-mcp/memory.sqlite` (macOS), `~/.local/share/local-memory-mcp/memory.sqlite` (Linux), or `%APPDATA%\local-memory-mcp\memory.sqlite` (Windows). Override with `MEMORY_DB_PATH`.

Privilege boundary: the server runs as the same user who started the MCP client. There is no privilege escalation surface.

### v2.0.0 — one explicit network event (model download, opt-out)

Hybrid retrieval depends on a local embedding model. The first time `embed()` runs, `@huggingface/transformers` will fetch the model files (default `Xenova/multilingual-e5-small`, ~30 MB q8 quantized) over HTTPS from `huggingface.co` and cache them under the Transformers.js cache directory (typically `~/.cache/huggingface/`). Subsequent calls are fully offline. The download is:

- **Initiated by user activity** — only when the user (via their MCP client) calls a tool that triggers `embed()`. The server never preemptively reaches out.
- **Opt-out** — set `MEMORY_EMBED_DISABLED=1` to force FTS5-only mode. No download happens, search still works (keyword only).
- **Replaceable** — point `MEMORY_EMBED_MODEL=…` at a self-hosted or alternative feature-extraction model. Combine with `MEMORY_EMBED_CACHE_DIR=…` for an air-gapped pre-seeded cache.

No analytics or identifiers are sent. The HTTPS request is to the Hugging Face Hub for the model artifacts only — this is the same fetch any Transformers.js consumer makes and is the only outbound network event the server can produce.

### v2.0.0 — sqlite-vec native extension

`sqlite-vec` is a native SQLite extension written in pure C ([`asg017/sqlite-vec`](https://github.com/asg017/sqlite-vec), MIT/Apache-2.0). It is loaded via `db.loadExtension` at boot. The prebuilt binary that ships in the matching npm package (e.g. `sqlite-vec-linux-x64`) is what gets loaded — it must be present, matching the host platform, and matching the better-sqlite3 ABI. If any of that fails, `loadVecExtension` catches the error, sets `vectorEnabled = false`, and the server runs in FTS5-only mode for the lifetime of the process. No fatal crash, no silent half-state.

There is no path by which a user-supplied SQL query selects a different shared object or invokes loadExtension at runtime — `db.loadExtension` is called exactly once per Database connection, with a path determined by the `sqlite-vec` npm package itself.

## Known SAST Scanner False Positives

Some automated security scanners flag patterns in this codebase that look risky in isolation but are safe in context. This section documents them so reviewers can verify quickly.

### `db.exec(...)` in `src/db/client.ts`

Pattern scanners that regex-match `.exec(` without resolving the receiver's type sometimes flag the schema-bootstrap line as shell command execution. It is not.

The receiver `db` is a `Database` instance from [`better-sqlite3`](https://github.com/wiselibs/better-sqlite3) (imported at the top of the file). `Database.prototype.exec(sql)` is the [official SQLite API](https://github.com/wiselibs/better-sqlite3/blob/master/docs/api.md#execstring---this) for executing one or more SQL statements from a string. It does not spawn a subprocess, does not invoke a shell, and has no relation to `child_process.exec`.

Independent verification you can run yourself:

```bash
git clone https://github.com/studiomeyer-io/local-memory-mcp
cd local-memory-mcp

grep -rn "child_process" src/                 # zero results
grep -rn -E "spawn|execSync|execFile" src/    # zero results
grep -rn -E "shell\s*:\s*true" src/           # zero results
```

The only `.exec(` call in the entire codebase is `db.exec(schema)` at `src/db/client.ts:57`, applied to a `better-sqlite3` Database, executing a static `schema.sql` file bundled with the package (no user input enters that string).

### Environment variable access

`process.env.MEMORY_DB_PATH`, `process.env.APPDATA`, `process.env.XDG_DATA_HOME`, and `process.env.MEMORY_LOG_LEVEL` are read to compute platform-standard filesystem paths and configuration. None of these values is ever interpolated into a shell command, passed to a subprocess, or used in any code path that could escape to the OS.

`src/tools/entity.test.ts` sets `MEMORY_DB_PATH` to a `mkdtempSync` temp directory before each test and deletes it after. This is standard Vitest test isolation, not runtime behavior.

## Dependencies

Runtime dependencies (audit-relevant):

- `@modelcontextprotocol/sdk` — official MCP SDK
- `better-sqlite3` — synchronous SQLite driver (native binding, no shell)
- `sqlite-vec` — native SQLite vector-search extension (MIT/Apache-2.0, prebuilt platform binary)
- `@huggingface/transformers` — Transformers.js, runs the local embedding model on CPU
- `zod` — schema validation

Dev dependencies are not shipped to users (`tsx`, `vitest`, `typescript`, `@types/*`).

`npm audit` is run on every release. The two new v2 runtime deps were audited at v2.0.0 cut:

- `sqlite-vec@0.1.9` — pure C, no transitive runtime deps, scoped to the SQLite extension surface.
- `@huggingface/transformers@4.2.0` — pure JS + WASM backend, no native bindings. Brings in `onnxruntime-web` as a runtime transitive but it's used purely as a WASM execution provider — no network outside the explicit model fetch documented above.
