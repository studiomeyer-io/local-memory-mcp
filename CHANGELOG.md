# Changelog

## 1.0.5 — 2026-04-21

Resilience patch. No API changes.

- **Set `PRAGMA busy_timeout = 5000`** on every SQLite open so concurrent MCP
  clients (e.g. Claude Desktop + Claude Code sharing one memory file) wait
  briefly for a locked writer instead of returning `SQLITE_BUSY` immediately.
  Complements the existing `journal_mode = WAL` + `synchronous = NORMAL`
  setup.

## 1.0.4 — 2026-04-21

Bugfix release.

- **Fix: Installation fails on Node.js 24** ([#1](https://github.com/studiomeyer-io/local-memory-mcp/issues/1))
  - Bumped `better-sqlite3` from `^11.7.0` to `^12.9.0`. The 11.7 line shipped prebuilt binaries only up to Node 22 (`NODE_MODULE_VERSION 127`), so fresh `npx -y` installs on Node 24 (`NODE_MODULE_VERSION 137`) crashed at startup with `The module better_sqlite3.node was compiled against a different Node.js version`.
  - `better-sqlite3@12.x` officially supports Node 20, 22, 23, 24, 25.
- Bumped `@types/better-sqlite3` to `^7.6.13` to match.

No API changes. Safe minor upgrade — existing SQLite databases continue to work.

## 1.0.0

Initial public release.
