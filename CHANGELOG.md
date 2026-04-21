# Changelog

## Unreleased

### Performance — push `entityType` filter into FTS5 sub-queries (Session 840, 2026-04-21)

`memory_entity_search` has filtered matches by `entityType` since v1.0.0,
but the filter was applied on the *outer* SELECT — after the `UNION ALL`
had already ranked every FTS match across all types. On large stores this
forced bm25() to rank rows we were about to throw away.

Push the filter down into each leg of the `UNION ALL`:

- entity-row leg gets `AND e.entity_type = ?`
- observation-row leg adds a second JOIN to `entities e_obs` and filters
  `AND e_obs.entity_type = ?`

Effect: narrow-type queries (e.g. "search for `Server` entityType=tool" on
a 100k-entity store with 90% non-tool) scan ~10× fewer rows inside the
`UNION ALL`. The outer query is one GROUP BY over a shorter list.

The fallback LIKE query already filtered in its WHERE clause — unchanged.

**`tests/entity.test.ts`** gains a regression guard that creates two
entities of different types whose observations both mention the same
search term, and verifies the `entityType` filter matches only one.

**Post-review follow-through (Session 840 Agent Critic):**

The Critic confirmed the push-down is required (SQLite ≥ 3.40.0
deliberately disabled automatic WHERE-push in `UNION ALL` branches, a
documented 4 700× regression) but flagged three edge cases without
coverage:

- observation-only hits (entity name doesn't match but observation
  content does) — new test `returns an observation-only hit when the
  entity name does not match`.
- case-insensitivity of the FTS tokenizer — new test
  `FTS search is case-insensitive on both name and observation legs`.
- zero-match FTS quoted phrases not falling into the LIKE fallback —
  new test `handles an empty FTS MATCH result without falling into the
  LIKE fallback`.

Total: **87/87 green** (83 existing + 4 new).

## 1.0.7 — 2026-04-21

Correctness patch + test expansion. No API changes.

- **Fix: `memory_entity_search` silently lost summary and observation hits.**
  The primary FTS5 query joined `search_fts` to `entities` with an OR that
  mixed entity-level and observation-level matches. That puts the `MATCH`
  subquery behind a derived JOIN, which SQLite rejects with "unable to use
  function bm25 in the requested context". The try/catch caught it and fell
  back to `WHERE name LIKE ?` — so any hit whose match lived in the entity
  summary or in an observation disappeared. Rewrite: two `MATCH`-ed subqueries
  `UNION ALL`'d by `entity_id`, then JOIN entities + GROUP BY with `MIN(rank)`.
  The fallback LIKE now also covers `summary` and `observations.content` via
  a LEFT JOIN, so an FTS outage still returns sensible rows.
- **Add `obs_au` trigger** on `entity_observations` so an UPDATE to an
  observation's `content` refreshes the FTS5 row instead of leaving a stale
  one pointing at the old text. Symmetric with the existing triggers on
  `learnings` / `decisions` / `entities`. No current code path edits
  observation content, but the symmetry keeps future edits safe.
- **Expand test coverage from 12 → 83 tests** (+71). `src/tools/entity.test.ts`
  (35 tests), `session.test.ts` (19), `search.test.ts` (17). Every tool surface
  exercised, plus the v1.0.6 archived-learning regression guard and the
  `obs_au` trigger verification.

## 1.0.6 — 2026-04-21

Correctness + performance patch. No API changes.

- **Fix: archived learnings no longer short-change the LIMIT** in `memory_search`.
  Filter moved from an in-memory post-pass into the SQL join, so the returned
  result set actually contains up to `limit` unarchived matches instead of
  `limit` minus-however-many-happened-to-be-archived-at-the-top-of-the-rank.
  Also avoids a second full scan of `learnings WHERE archived = 1` per call.

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
