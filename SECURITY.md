# Security Policy

## Reporting a Vulnerability

If you find a security vulnerability, please report it privately.

**Email:** hello@studiomeyer.io

Please do not open a public GitHub issue for security vulnerabilities.

We will acknowledge your report within 48 hours and provide a fix timeline within 7 days.

## Threat Model

`local-memory-mcp` is a single-user, local-only MCP server. It runs as a stdio process invoked by an MCP client on the same machine, stores all data in a single SQLite file under the user's local data directory, and never makes outbound network requests.

- **No network code.** No HTTP server, no fetch, no API calls. The process talks to its parent over stdio only.
- **No shell execution.** No `child_process`, no `spawn`, no `execSync`, no `execFile`. The codebase has zero subprocess invocations. See "Known SAST scanner false positives" below.
- **No telemetry.** No analytics, no phone-home, no crash reporting.
- **Local filesystem only.** The SQLite file lives at `~/Library/Application Support/local-memory-mcp/memory.sqlite` (macOS), `~/.local/share/local-memory-mcp/memory.sqlite` (Linux), or `%APPDATA%\local-memory-mcp\memory.sqlite` (Windows). Override with `MEMORY_DB_PATH`.

Privilege boundary: the server runs as the same user who started the MCP client. There is no privilege escalation surface.

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
- `zod` — schema validation

Dev dependencies are not shipped to users (`tsx`, `vitest`, `typescript`, `@types/*`).

`npm audit` is run on every release.
