# Changelog

## [2.1.0] — 2026-05-29

### Added — Bi-temporal asOf queries (`memory_entity_open`)

The `entity_observations` table has carried `valid_from` + `valid_to` columns since v1.0.0, but until v2.1.0 no tool actually filtered on them. `memory_entity_open` now accepts an optional `asOf` parameter. When provided, observations are filtered to the bi-temporal window:

```sql
WHERE datetime(valid_from) <= datetime(?)
  AND (valid_to IS NULL OR datetime(valid_to) > datetime(?))
```

Both `valid_from` and `valid_to` plus the user input are wrapped through `datetime()` so the caller can pass any format SQLite understands — `2026-04-15`, `2026-04-15 00:00:00`, `2026-04-15T00:00:00`, `2026-04-15T00:00:00Z` — without normalising on our side. The Zod schema uses `Date.parse()` (permissive) to fail-fast on a malformed string. Backward-compatible: omit `asOf` and you get the legacy `valid_to IS NULL` live view.

Use case: "what did I know about Matthias on April 15?" The LLM reads the resulting observation set as the snapshot of belief at that moment.

### Added — `memory_contradictions` (LLM-free fact-supersession scanner)

Surfaces observation pairs that are semantically very similar (cosine similarity above a threshold) but disagree on one of two heuristic axes:

1. **Negation marker XOR** — one side asserts, the other negates. The regex covers EN / DE / ES / Catalan (`not`, `no longer`, `never`, `n't`, `kein`, `nicht`, `niemals`, `nie`, `sin`, `sem`, `não`, `none`).
2. **Confidence drift** — same surface claim recorded with very different `confidence` values (`>= minConfidenceDrift`, default 0.2).

Cosine math runs in SQL via `vec_distance_cosine` (provided by sqlite-vec). The intra-entity self-join keeps the pair-set bounded at Σ N²/2 over entities — a few hundred pairs even for power-user corpora. Per pair we return both observations, the cosine score, the reasons flagged, and a supersede suggestion identifying the older side (by `valid_from`).

LLM-free on purpose — the no-API-key promise holds. Pure duplicates (high cosine, no negation, no confidence drift) are NOT flagged, only contradiction candidates. Requires sqlite-vec to be loaded; on platforms where it isn't, returns `code: 'VECTOR_DISABLED'` with a clear message instead of degrading silently.

Scope: `entityId` > `entityName + entityType` > global scan (default). Knobs: `minCosine` (default 0.7), `minConfidenceDrift` (default 0.2), `limit` (default 20).

### Added — `memory_learn_archive` (soft delete)

Flips `archived = 1`, `archived_at = now`, `lifecycle_state = 'archived'` (or `archived:<reason>` if a reason is provided). The row stays in `learnings` so asOf-style cross-references continue to resolve, and the embedding stays in vec0 so a "find me past archived learnings that looked like this" search remains possible. `recall`, `search`, and the gatekeeper's similarity check all filter `archived = 0`, so archived rows never resurface as live answers. Idempotent — a second call returns `action: 'already_archived'` without mutating.

### Added — `memory_learn_update` (atomic edit)

Edits a live (non-archived) learning. At least one of `content`, `confidence`, or `tags` must be provided. Bumps `usage_count` and sets `last_used` so an edit counts as a touch. When `content` changes, re-embeds in the F4 atomic pattern: compute the vector outside any transaction (because `embed()` is async), then `UPDATE` the row + `writeEmbeddingSync` inside one sync `db.transaction()`. Either both commit or both roll back. If `vec` is disabled or `embed()` fails, the now-stale OLD embedding is purged so cosine search can't surface a vector that no longer represents the live text. Rejects edits to archived learnings with `code: 'ARCHIVED'`.

### Added — `memory_reflect` (LLM-free aggregation)

Stanford Generative Agents' reflection step, minus the LLM call. Aggregates recent memory activity into four sections:

- **Most-used learnings** — top N by `usage_count` last touched inside the lookback window.
- **Stale learnings** — `archived = 0`, `usage_count = 0`, `date < (now - staleThresholdDays)`. Candidates for `memory_learn_archive` / `memory_learn_update`.
- **Hot entities** — top N entities by new observations created inside the lookback window.
- **Open decisions** — `verified = 0` AND `date < (now - lookback)`. Candidates for follow-up.

Returns structured data PLUS a Markdown summary in `data.summary`. The Markdown is for the LLM to read at session start; the structured fields are for downstream automation (Claude Code Hook, n8n workflow) that wants to react without reparsing. Defaults: `lookbackDays: 7`, `staleThresholdDays: 30`, `limit: 5`. Optional `project` filter.

### Changed — `memory_session_end` instructions block bumped to 21 tools

`src/server.ts` INSTRUCTIONS block now lists the v2.1 surface: asOf on `entity_open`, the contradictions scanner, archive + update on learnings, and the reflection tool. The `21 tools` count line replaces the old `17 tools`.

### Changed — Manifests bumped to v2.1.0

- `package.json` — version + description extended.
- `server.json` — version on the package metadata + the tool-count line in the description.
- `mcpb-build/manifest.json` — version, long_description, and the `tools` array extended with the four new tool entries.
- `src/server.ts` — `SERVER_VERSION = '2.1.0'`.

### Tests

- `src/tools/entity.test.ts` — 5 new asOf test cases covering: in-window + closed-window + future, multi-format date parsing (ISO 8601, SQLite-style, date-only), pre-observation history, backward-compat without `asOf`, Zod schema rejection of unparseable strings. **+5 tests**
- `src/tools/learn.test.ts` — 10 new test cases for archive + update covering: flag flip, idempotency, recall-filter regression, NOT_FOUND, content-change re-embed, confidence-only no-reembed, archived rejection, NOTHING_TO_UPDATE, NOT_FOUND, tags-only update + JSON round-trip. Plus a registry test pinning the 4 v2.1 tools by name. **+11 tests**
- `src/tools/contradictions.test.ts` — **NEW**, 9 test cases covering: vec-disabled error, negation-diff flag, confidence-drift flag, clean-pair non-flag, entityId scope, entityName + entityType resolution, NOT_FOUND, limit, tombstone (`valid_to IS NOT NULL`) ignore.
- `src/tools/reflect.test.ts` — **NEW**, 8 test cases covering: structured payload + markdown shape, most-used in lookback, stale beyond threshold, hot entity by observation count, open decision older than lookback, project scope, archived skip from stale + most-used, friendly fallback on empty memory.
- `src/tools/learn.test.ts` — drift-detection test updated to `TOOLS.length === 21`, plus a new test pinning the four v2.1 tool names so this class of registry drift cannot recur silently.
- **Total: 159 tests** (was 126), all green on Linux x64 with sqlite-vec loaded.

### Backlog (v2.1 → v2.2 candidates)

The Phase 3 plan from `output/2026-05-28-local-memory-mcp-improvement-plan/PLAN.md` is fully landed. The following items were intentionally deferred to v2.2 or later:

- `memory_observation_supersede(observationId)` — companion tool to the contradiction scanner that sets `valid_to = now` on the older observation. The scanner's suggestion field references it.
- `memory_decide_verify(decisionId)` — flip `verified = 1` on a decision; would make `memory_reflect` "open decisions" semantically tighter.
- `memory_learn_history(learningId)` — proper audit trail for `learn_update` (currently the previous content is not retained — V2.1 trades perfect history for schema-stability).
- Migration runner (`meta.schema_version` driver), E2E stdio test layer, BEGIN IMMEDIATE pragma for multi-process writes — see the R1+R2 backlog in `nex-hq/docs/handovers/2026-05-29-local-memory-mcp-v2-phase3-phase4-handover.md`.

### Migration notes

- The on-disk DB layout from v2.0 is unchanged. v2.1 adds no schema migration — every new tool reads existing columns (`archived`, `archived_at`, `lifecycle_state`, `valid_from`, `valid_to`, `verified`) that have been present since v1.0.0.
- Existing rows without an embedding (created before v2.0 or under `MEMORY_EMBED_DISABLED=1`) are invisible to the contradictions scanner. That's by design — the cosine math needs both sides embedded.
- The `memory_contradictions` tool requires sqlite-vec. On platforms where the extension can't load, it returns `code: 'VECTOR_DISABLED'`. Every other v2.1 tool works without vec.

## [2.0.0] — 2026-05-28

### Added — Hybrid retrieval (BM25 + vector cosine via RRF)

`memory_search` now runs two rankers in parallel and fuses them with Reciprocal Rank Fusion (k=60):

- **FTS5/BM25** — the v1 keyword path, unchanged in spirit but reused as one half of the fusion.
- **sqlite-vec** — the [`vec0`](https://alexgarcia.xyz/sqlite-vec/) virtual table holds 384-dim Float32 embeddings keyed by content_id. KNN runs as `WHERE embedding MATCH ? AND k = ?` with results post-filtered against `search_fts` for content-type + archived-row constraints (vec0 rejects WHERE constraints on aux columns inside a KNN query).
- **Reciprocal Rank Fusion** with `k=60` is Alex Garcia's canonical recipe and produces the best balance of keyword and semantic recall in our internal tests.

The new `mode` parameter selects the path explicitly:

```text
memory_search({ query: "…", mode: "hybrid" })   // default
memory_search({ query: "…", mode: "fts" })
memory_search({ query: "…", mode: "vector" })
```

Whenever `sqlite-vec` is unavailable on the host or the embedding pipeline can't produce a query vector, search transparently downgrades to FTS5 — never an error, just a `mode: "fts"` in the response payload so the caller can observe what actually happened.

### Added — Multilingual local embeddings

`@huggingface/transformers` (v4.2.0) is now a runtime dependency. The default model is `Xenova/multilingual-e5-small` (Apache-2.0, 384-dim, native DE / EN / ES + 100 more languages). The model is q8-quantized (~30 MB cache), loaded lazily on the first `embed()` call, and reused as a singleton thereafter. Everything runs on CPU — no GPU, no API key, no network call after the first model fetch.

Override knobs (env vars):

- `MEMORY_EMBED_DISABLED=1` — force FTS5-only (air-gapped / corporate network).
- `MEMORY_EMBED_MODEL=…` — swap in a different Transformers.js feature-extraction model.
- `MEMORY_EMBED_CACHE_DIR=…` — override the Transformers.js cache location.
- `MEMORY_EMBED_DTYPE=fp32|fp16|q8|q4` — quantization level (default `q8`).
- `MEMORY_EMBED_MOCK=1` — deterministic bag-of-tokens mock for CI / tests.

### Added — Auto-embed on insert

`memory_learn`, `memory_decide`, and `memory_entity_observe` upsert an embedding into the `embeddings` virtual table after a successful insert. Upsert is modeled as DELETE-then-INSERT inside a single transaction because vec0 doesn't honour `INSERT OR REPLACE` on its primary key. Failures (model not loaded, network blocked) are logged once and swallowed — the insert is the source of truth, the embedding is a recall optimization.

### Added — Multi-platform MCPB bundles via GitHub Actions matrix

`.github/workflows/release-mcpb.yml` now builds four `.mcpb` bundles in parallel on every `v*` tag push:

- `linux-x64`
- `darwin-x64` (Intel Mac)
- `darwin-arm64` (Apple Silicon)
- `win32-x64`

Each bundle includes the platform-correct `better-sqlite3` and `sqlite-vec` prebuilt binaries and is attached as a Release asset. macOS, Windows, and Linux users can now double-click to install without a build toolchain.

### Added — Vector status + embedding mode surfaced in `memory_health`

`memory_health` now returns a `vector` block (`enabled`, `error`, `embeddingsCount`, `dim`) and an `embedding` block (`mode`, `model`) so users and ops dashboards can see at a glance whether hybrid retrieval is live or the server is running FTS5-only.

### Added — Search-mode echo

Every `memory_search` response now carries `data.mode` so callers can verify which ranker actually ran (relevant when the requested mode was downgraded to FTS due to vec unavailability).

### Changed — Tool handlers go async

`memory_learn`, `memory_decide`, `memory_entity_observe`, and `memory_search` are now `async` to await the embedding step. The MCP server already supported `Promise<ToolResult>` handlers — no client-visible change beyond ordering, but third-party consumers of the raw exports need to `await` these calls now. All other tools stay synchronous.

### Changed — Schema bumped to version 2

The new `embeddings` `vec0` virtual table + `embedding_model` / `embedding_dim` fingerprints land via `src/db/migrations/002_vector.sql`. The migration is idempotent (`CREATE VIRTUAL TABLE IF NOT EXISTS`) and runs only after `sqlite-vec` successfully loads on the host — so the v1 DB layout remains untouched on platforms without vec.

### Changed — Server-version drift fixed

`SERVER_VERSION` in `src/server.ts` now reads `2.0.0` consistently with `package.json`, `server.json`, and `manifest.json`. (Same class of bug we fixed for v1.0.8 — pinning a regression-test now so a future bump can't silently drift again.)

### Changed — Manifest tool inventory matches code

`mcpb-build/manifest.json` previously listed two tools (`memory_summarize`, `memory_proactive`) that don't exist in the source. They are gone. The bundle now ships exactly the 17 tools you get over MCP.

### Changed — README disambiguation against `local-memory-releases`

Header note plus the scoped npm name pointer make clear this repo is **not affiliated** with the unrelated `danieleugenewilliams/local-memory-releases` Local Memory binary distribution. Always use the scoped `@studiomeyer/local-memory-mcp` package name.

### Tests

- New: `src/lib/embed.test.ts` — mock embedding determinism, L2 normalization, cosine sanity, multilingual handling, NFKD accent-strip, env-driven mode (mock / disabled / real).
- New: `src/db/vector.test.ts` — sqlite-vec load + reload-after-close (the regression guard for the early v2 stale-cache bug), embeddings table KNN, DELETE-then-INSERT upsert contract, schema_version bump, embedding_model fingerprint.
- Extended: `src/tools/search.test.ts` — hybrid / vector / fts mode tests, RRF score sanity, hybrid archive-filter, hybrid `types` filter, mode echo in response, schema accepts mode enum.
- All previously sync test calls (`learn(…)`, `decide(…)`, `entityObserve(…)`, `search(…)`) updated to `await` since those entry points are now async.
- Total: **120 tests** (was 88), all green on Linux x64 with sqlite-vec loaded.

### Migration notes

- The on-disk DB layout is forward-compatible: opening a v1 SQLite file with v2 simply adds the embeddings virtual table on first run. Existing rows are not retroactively embedded — only new writes get a vector. Run a one-shot reindex script (planned for v2.1) if you want full coverage.
- If you ran v1 with a custom path (`MEMORY_DB_PATH=…`), keep it. If you used the OS default, keep it. The v2 upgrade is in-place.

## [1.0.9] — 2026-05-28 (MCPB Foundation)

Internal-only release that promoted the MCPB bundle work from "Unreleased" to a tagged release before the v2 jump. No API changes from v1.0.8.

### Added — MCPB bundle for one-click Claude Desktop install

Built a `.mcpb` bundle (MCP Bundle, the official Anthropic format for one-click MCP install in Claude Desktop) packing `dist/`, production `node_modules/`, and a complete `manifest.json` (with tool inventory + `user_config.db_path` for the SQLite database location).

- `local-memory-mcp-1.0.8-linux-x64.mcpb` — 7.0 MB, ships the SQLite native binary for Linux x64. Users on Linux just double-click to install — no JSON editing, no `npm install`, no terminal.
- Bundle pipeline scripted as `scripts/build-mcpb.sh` and the build directory `mcpb-build/` is `.gitignore`d to keep the repo clean.
- Manifest schema validated with `mcpb validate` (`@anthropic-ai/mcpb@2.1.2`), pack via `mcpb pack`.
- Platform note (resolved in v2.0.0): only `linux-x64` was published in this release. v2.0.0 ships all four desktop platforms via GitHub Actions matrix.

## [1.0.8] — 2026-05-22

Trust + adoption polish based on an outside-the-fleet audit (`research/2026-05-22-local-memory-mcp-improvement-sweep.md` in the nex-hq mirror). Three drifts and one architectural omission, all small fixes with disproportionate trust impact.

### Fixed — Version drift sweep

- `src/server.ts` hardcoded `SERVER_VERSION = '1.0.6'` while `package.json` was at v1.0.7. Every MCP client's `initialize` response saw the wrong version. Now reads `1.0.8` consistently.
- `server.json` (MCP Registry manifest) was at `1.0.1` — six releases behind. Bumped to `1.0.8` plus the embedded `packages[0].version`.
- `package.json` bumped to `1.0.8`.

### Added — Four tools that already had handlers + tests, but were unreachable

`entityCreate`, `entityDelete`, `goal`, and `health` were exported, had Zod schemas, had unit-test coverage — but were missing from the `TOOLS` array. MCP clients calling `tools/list` got 13 tools instead of 17. Now registered:

- **`memory_entity_create`** — explicitly create an entity without an initial observation. Idempotent on `name + entityType`.
- **`memory_entity_delete`** — delete an entity + all its observations + relations. Destructive — use with care.
- **`memory_goal`** — read / set / clear a single user goal stored in the profile table.
- **`memory_health`** — SQLite integrity check + page-count + DB-size + WAL status. Zero-input.

`TOOLS.length` is now `17`. The drift-detection test in `src/tools/learn.test.ts` is updated; a new test pins the four formerly-orphan tools by name so this class of drift cannot recur silently.

### Added — CI workflow

`.github/workflows/test.yml` runs `npx tsc --noEmit`, `npm test`, and `npm run build` on Node 20 / 22 / 24 for every push and PR to `main`. The repo previously had only `publish-registry.yml` (tag-driven) — no green-on-PR signal for contributors.

### Removed

- Duplicate root `CONTRIBUTING.md`. The canonical guide lives at `.github/CONTRIBUTING.md` — that is where GitHub surfaces it. The root copy had drifted out of sync.
- `bun.lock`. We support `npm` and `bun` consumers, but two lockfiles is a known source of drift and the file was undocumented. `package-lock.json` remains the source of truth.

### Notes

No API breakage. The four newly-registered tools were already callable as importable functions; they are now also reachable over MCP.

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
