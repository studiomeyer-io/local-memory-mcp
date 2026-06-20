# local-memory-mcp — Whitepaper

**Local-first persistent memory for AI agents. One SQLite file, no cloud, no API keys.**

**Version:** 1.0 (covers local-memory-mcp v2.2.0)
**Date:** 2026-06-20
**Repo:** [github.com/studiomeyer-io/local-memory-mcp](https://github.com/studiomeyer-io/local-memory-mcp)
**npm:** `@studiomeyer/local-memory-mcp`
**License (code):** MIT · **License (this paper):** CC BY 4.0

---

## Executive Summary

AI assistants have no memory. Every session starts from zero. In 2026 this is still the biggest unsolved problem in the LLM application layer.

`local-memory-mcp` solves it the boring, durable way: a single SQLite file on your own machine, exposed to any MCP client (Claude Desktop, Claude Code, Cursor, Codex, Continue) over stdio. There is no server to run, no account to create, no API key to manage, and — by design — no network call other than one optional, opt-out model download. Your data never leaves the machine it was created on.

It is not a thin note-taker. Under the hood it is a structured, bi-temporal knowledge graph with hybrid retrieval:

- **25 tools** spanning sessions, learnings, decisions, a typed knowledge graph, lifecycle management, reflection, and portability.
- **Hybrid search** — FTS5/BM25 fused with sqlite-vec cosine similarity via Reciprocal Rank Fusion (RRF, k=60), over multilingual embeddings (DE / EN / ES + 100 more) computed locally.
- **Bi-temporal facts** — every observation carries `valid_from`/`valid_to`, so you can ask "what did I know on date X?" and retire a stale fact without deleting its history.
- **LLM-free cognition** — contradiction detection and reflection run as deterministic heuristics in SQL, so the no-API-key promise holds end to end.

It is MIT-licensed, shipped on npm and as one-click `.mcpb` bundles for macOS, Windows, and Linux, and it is the open, local sibling of the hosted [StudioMeyer Memory](https://memory.studiomeyer.io) service. Section 3 is explicit about where the line between the two sits — and why that line is a feature, not a limitation.

---

## 1. The Problem — AI memory in 2026

### 1.1 Three things all called "memory"

The market sells three very different things under one word. Conflating them compares apples to oranges.

**Layer 1 — static notes.** A markdown file like `CLAUDE.md` or `AGENTS.md`. You write "we use TypeScript strict" and the assistant reads it every session. No algorithm, no embeddings, no cloud. Enough for many solo developers.

**Layer 2 — accumulating notes.** What Claude Code's auto-memory does: the model appends to that same markdown file as it works, a nightly pass consolidates. Local, file-system bound, no semantic retrieval. ChatGPT Memory is the same idea without the edit access.

**Layer 3 — structured memory with a knowledge graph.** Facts as nodes plus edges, with semantic search, confidence, and temporal validity. Solves what layers 1 and 2 cannot. This is the category `local-memory-mcp` competes in — while staying entirely on your machine.

### 1.2 Where a markdown file stops being enough

- **Cross-tool recall** — Claude Code, Cursor, and Codex sharing one memory file on the same machine.
- **Semantic retrieval** — finding "the thing about SSL" even when it was stored as "certbot renewal."
- **Bi-temporality** — what was true when, and what superseded it.
- **Contradiction surfacing** — "I live in Berlin" vs. three weeks later "I live in Hamburg" — not both true at once.
- **A knowledge graph** — people, projects, tools, and the typed relations between them, not a flat blob.

### 1.3 Who this is for

Developers and privacy-conscious users who want structured, searchable, long-term memory for their AI tools **without** sending their thoughts, code, or client data to a cloud they don't control — and without paying a subscription or wiring up an API key. If your hardware is your own (laptop, workstation, a Mac with Apple Silicon), local-first memory is the right default. When you outgrow one machine — teams, multi-device sync, server-side LLM cognition — Section 4 shows the one-file upgrade path to the hosted tier.

---

## 2. What local-memory-mcp does

### 2.1 Core functions

**Sessions.** Each conversation can be started and ended; `memory_session_start` loads context from the last few sessions so the assistant resumes where you left off.

**Learnings.** Typed knowledge entries (`pattern`, `mistake`, `insight`, `research`, `architecture`, `infrastructure`, `tool`, `workflow`, `performance`, `security`) with confidence, tags, and an episodic/semantic type that is auto-classified. A gatekeeper prevents duplicates: exact matches bump a usage counter; a much longer, very similar entry updates the existing one rather than forking it.

**Decisions.** Strategic choices with reasoning and alternatives, so months later you can reconstruct *why* you chose something — not just what.

**Knowledge graph.** Entities (people, projects, companies, tools, concepts) with bi-temporal observations and typed, directed relations. The graph is the structure that a flat note file can never be.

**Contradiction scanner (LLM-free).** Surfaces observation pairs that are semantically close (cosine similarity) but disagree — either by a negation marker (7-language regex) or by a large confidence drift. It flags candidates; the AI client judges. No LLM call, no API key.

**Fact supersession (v2.2).** The execution arm of the scanner: retire a stale observation by setting its `valid_to` tombstone. It drops out of live search and the live entity view but remains reachable through a point-in-time `asOf` query. Invalidate, never delete — the Zep fact-supersession pattern, implemented locally.

**Reflection (LLM-free).** An aggregation pass — most-used learnings, stale candidates, hot entities, open decisions — returned as both structured data and a markdown summary. Stanford's "generative agents" reflection step, minus the model call.

**Portability (v2.2).** `memory_export` / `memory_import` move your whole memory as a versioned JSON envelope (Section 4).

### 2.2 Tool inventory — 25 tools

| Block | Count | Examples |
|---|---|---|
| Sessions | 2 | `session_start`, `session_end` |
| Learnings | 5 | `learn`, `recall`, `learn_archive`, `learn_update`, `learn_bulk` |
| Search | 1 | `search` (hybrid: FTS5 + vector via RRF) |
| Decisions | 1 | `decide` |
| Knowledge graph | 7 | `entity_create/observe/search/open/relate/delete`, `observation_supersede` |
| Cognition (LLM-free) | 2 | `contradictions`, `reflect` |
| Metadata + help | 4 | `insights`, `profile`, `goal`, `guide` |
| Portability | 2 | `export`, `import` |
| Health | 1 | `health` |

Every tool ships MCP annotation hints (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`, the last always `false` — the server only ever touches the local file), so a client can decide whether to auto-run a tool or ask for confirmation first.

### 2.3 Architecture

```
MCP Client (Claude Desktop / Claude Code / Cursor / Codex / Continue)
    │  stdio (JSON-RPC) — no network, no port
    ▼
local-memory-mcp  (Node, TypeScript strict)
    │  Tool layer (25 tools, Zod-validated)
    │  Hybrid retrieval (RRF k=60 over BM25 + cosine)
    │  Local embeddings (Transformers.js, multilingual-e5-small)
    │  Gatekeeper · bi-temporal valid_from/valid_to · LLM-free heuristics
    ▼
One SQLite file  (better-sqlite3, WAL)
    - FTS5 (unicode61, accent-folding) — keyword/BM25
    - sqlite-vec vec0 (384-dim) — cosine KNN
    - bi-temporal observations + typed relations
    - lives under your OS data dir; MEMORY_DB_PATH to relocate
```

No daemon, no socket, no container. The server is a stdio subprocess your MCP client spawns; the database is a file you can copy, back up, or delete with `cp` and `rm`.

### 2.4 The search stack

A query runs through two rankers and a fusion step:

1. **FTS5 / BM25** over a unified full-text index (`unicode61 remove_diacritics 2`, so "münchen" matches "munchen"), kept in sync by triggers.
2. **Vector cosine** via sqlite-vec's `vec0` virtual table against locally-computed 384-dim embeddings.
3. **Reciprocal Rank Fusion** (k=60, the canonical constant) merges the two rankings — high recall, multilingual, robust to vocabulary mismatch ("send" finds "publish").

`mode` is selectable: `hybrid` (default), `fts`, or `vector`. If the vector extension can't load on a platform, or the embedding model is disabled, search **transparently degrades to FTS5** and a `notice` field tells the caller it did — so "vector ran and found nothing" is never confused with "vector silently fell back."

### 2.5 Embeddings — local, multilingual, optional

The default model is `Xenova/multilingual-e5-small` (Apache-2.0, 384-dim, q8-quantized to ~30 MB, strong on DE / EN / ES + 100 more), run on the CPU via Transformers.js. It is lazy-loaded on the first embedding call and cached locally; every call after is fully offline. Three modes:

- **Real** (default) — the local model.
- **`MEMORY_EMBED_DISABLED=1`** — no model, FTS5-only. For air-gapped or proxy-restricted machines.
- **`MEMORY_EMBED_MODEL=…`** — point at any alternative feature-extraction model.

Writes embed in one place each, and `memory_learn_bulk` / `memory_import` embed a whole batch in a **single model forward pass** — the throughput-correct way, since `Promise.all` over a CPU-only backend would run sequentially anyway.

### 2.6 Bi-temporal facts + asOf

Observations have carried `valid_from`/`valid_to` since v1. `memory_entity_open({ asOf })` filters to the validity window that contained that instant — the snapshot of belief at a moment in time. v2.2 added an expression index on `(entity_id, datetime(valid_from))` so that query stays fast as an entity accumulates history, and `memory_observation_supersede` to set the `valid_to` cutoff (Section 2.1).

---

## 3. Design principles — the local-first contract

Four invariants define this project. They are what make it trustworthy, and they are deliberately narrower than the hosted product.

1. **Local.** One SQLite file on one machine. No replication, no multi-tenant, no remote state.
2. **No API key, no LLM at runtime.** Cognition (contradictions, reflection, the gatekeeper) is deterministic heuristics in SQL. The only outbound network event the server can produce is the optional, opt-out embedding-model fetch.
3. **Deterministic.** Same input, same output. The mock embedder is a stable hash; the real embedder is fixed given a model version. No sampling in search.
4. **Honest degradation.** If a native piece (sqlite-vec, the model) can't load, the server falls back to FTS5 and says so — it never crashes the client or pretends.

### 3.1 What this is NOT — and why that's on purpose

`local-memory-mcp` intentionally does **not** include:

- **LLM-powered cognition** — no model deciding ADD/UPDATE/DELETE, no episodic→semantic "dreaming," no LLM reranking or agentic multi-hop retrieval.
- **Multi-device sync or a server** — it's one file on one machine.
- **Multi-tenant / team sharing / auth** — single user, no identity layer.

Those belong to the hosted [StudioMeyer Memory](https://memory.studiomeyer.io) tier, because each of them needs either an LLM call, a server, or a shared database — none of which can be honestly promised by a zero-key local process. The split is clean: **anything that needs an LLM, a server, or more than one device is hosted; anything deterministic, offline, and single-machine is here, and it is as good as we can make it.** A strong free local tool is not a teaser for the paid one — it is a complete product that also happens to be the on-ramp.

---

## 4. Portability + the upgrade path

Your memory is already a file (`cp memory.sqlite backup.sqlite` is a complete backup). v2.2 makes it a document, too.

**`memory_export`** dumps everything — learnings, decisions, entities, observations, relations, sessions, profile, goal — into a versioned, camelCase JSON envelope (`format: "studiomeyer-memory-export"`, `version: 1`). Embeddings are deliberately **not** exported: they are derived, so they are re-computed on import with whatever model the importing machine runs. The envelope stays small and model-agnostic.

**`memory_import`** ingests that envelope. It is **purely additive and idempotent** — every write is `INSERT OR IGNORE` on the source id (entities also dedupe on their unique name+type), so re-importing the same file is a no-op and importing into a populated store never clobbers an existing row. It preserves referential integrity with FK-safe ordering and skips (with a count, never a throw) any observation whose entity is absent or relation whose endpoint is missing. There is no `replace` mode by design — wiping a local store is `rm memory.sqlite`, not a tool that can silently delete your history.

The same envelope imports into the hosted tier. So the path is: **start local and free; if you later need teams, multi-device sync, or server-side LLM cognition, export once and carry your entire memory across.** No lock-in, in either direction.

---

## 5. Install + integration

**Claude Code:**
```bash
claude mcp add memory -- npx -y @studiomeyer/local-memory-mcp
```

**Claude Desktop:** download the one-click `.mcpb` bundle for your OS from the [latest release](https://github.com/studiomeyer-io/local-memory-mcp/releases/latest) and double-click — no JSON, no terminal. Bundles are built per-platform (macOS Intel + Apple Silicon, Windows x64, Linux x64) because `better-sqlite3` ships a native binary; the matching one is inside the bundle.

**Cursor / VS Code / Codex / Continue:** any MCP client that speaks stdio. Point it at `npx -y @studiomeyer/local-memory-mcp`.

Once the tools are available, the assistant uses them on its own — "remember this" calls `memory_learn`, "what do you know about Sarah" calls `memory_entity_search`. For automatic session tracking, wire a SessionStart hook (Claude Code) or just say "load memory" at the start of a conversation.

---

## 6. Comparison

### 6.1 vs. other local / OSS memory servers

| | local-memory-mcp | Penfield | Official MCP Memory | Mem0 (OSS) | Zep | Letta |
|---|---|---|---|---|---|---|
| Local-first, no API key | **Yes** | Yes | Yes | No (cloud-leaning) | No (cloud) | Partial |
| Hybrid BM25 + vector (RRF) | **Yes** | Yes | No | Vector only | Vector only | Vector + graph |
| Multilingual local embeddings | **Yes (e5-small)** | Unknown | No | EN-leaning | EN-leaning | Mixed |
| Knowledge graph | Yes | Yes | Triples | Paid tier | Yes | Yes |
| Bi-temporal asOf + supersession | **Yes** | Unknown | No | Partial | Yes | Partial |
| Contradiction scan (LLM-free) | **Yes** | No | No | LLM-driven | LLM-driven | No |
| Decision tracking | **Yes (unique)** | No | No | No | No | No |
| Portable export/import | **Yes (JSON)** | Unknown | No | API | API | `.af` file |
| Storage | SQLite + sqlite-vec | SQLite | JSON file | Cloud | Cloud | Various |
| Install | `npx` / `.mcpb` | `npx` | `npx` | sign-up | sign-up | `pip`/Docker |
| License | MIT | MIT-ish | MIT | mixed | — | — |

Where it stands out: the only local, MIT-licensed, API-key-free memory MCP shipping hybrid retrieval with multilingual local embeddings, bi-temporal fact supersession, LLM-free contradiction detection, decision tracking, and one-click installers for every desktop OS.

**On benchmarks — honest note.** We have not run a published LongMemEval score for the *local* server. Our hosted sibling is benchmarked (see its whitepaper, with caveats); the local server shares the same retrieval primitives (FTS5 + vector + RRF, bi-temporal model) but a different stack (SQLite/sqlite-vec vs. PostgreSQL/pgvector) and a different embedding model, so we will not borrow that number. A dedicated local benchmark is on the roadmap (Section 8); until it is run and reproducible, we make no aggregate-score claim.

### 6.2 vs. StudioMeyer Memory (hosted)

| | local-memory-mcp (this repo) | StudioMeyer Memory (hosted) |
|---|---|---|
| Where | Your machine (SQLite + sqlite-vec) | Cloud (PostgreSQL, EU-Frankfurt) |
| Tools | 25 | 56 |
| Cognition | Deterministic, LLM-free | LLM-powered (gatekeeper, dreaming, rerank, agentic retrieval) |
| Multi-device / multi-agent | No | Yes |
| Team / multi-tenant | No | Yes |
| Price | Free forever (MIT) | Free tier / paid Pro & Team |

Start local. Upgrade when you need teams, multi-device sync, or server-side LLM cognition — `memory_export` carries your whole memory across.

---

## 7. Security + Privacy

The full threat model is in [SECURITY.md](SECURITY.md). In short:

- **No network code in source.** No HTTP server, no `fetch`, no API calls. The process talks to its parent over stdio only.
- **No shell execution.** Zero `child_process` / `spawn` / `execSync` / `execFile` (verifiable with `grep`; the one `db.exec()` is better-sqlite3's SQL executor, documented as a known SAST false positive).
- **No telemetry.** No analytics, no phone-home, no crash reporting.
- **One opt-out network event.** The first embedding call fetches the model from the Hugging Face Hub over HTTPS, then runs offline forever. `MEMORY_EMBED_DISABLED=1` skips it entirely.
- **v2.2 portability tools add no new surface** — `export`/`import`/`bulk`/`supersede` are pure local SQLite operations with parameterized SQL; the envelope is never interpolated into a query.

Your data lives in one file under your user account. There is no privilege-escalation surface and nothing to leak to a third party.

---

## 8. Roadmap

- **A published local benchmark** — a reproducible LongMemEval (or LoCoMo/ConvoMem) run against the SQLite stack, with config and caveats, so Section 6.1 can carry a real number.
- **Full four-timestamp bi-temporal model** (real-world `valid_at`/`invalid_at` + system-time `created_at`/`expired_at`) plus a `superseded_by` provenance column — pending a proper schema-migration runner.
- **`dry_run` on import** — preview what would be imported/skipped before writing.
- **Envelope field-name alignment** with the emerging Memory-Interchange-Format core, for cheap adapters to/from other systems.
- **An immutable `learnings_history` table** for point-in-time recovery of edited learnings.

These are tracked openly; none ships until it is tested and reviewed.

---

## 9. Limitations + Honesty

- **No published local benchmark yet** (Section 6.1, 8). We will not borrow the hosted server's score.
- **CPU embedding latency.** On a CPU-only machine the first embedding pays the model load, and large batches take real time. The batched-forward-pass path mitigates it, and FTS5-only mode (`MEMORY_EMBED_DISABLED=1`) removes the model entirely if you don't want it.
- **Embeddings are English-leaning.** multilingual-e5-small is genuinely multilingual but EN-trained; very nuanced paraphrase queries in DE/ES are occasionally weaker than EN.
- **No LLM cognition — by design** (Section 3.1). If you want a model deciding what to merge, episodic→semantic consolidation, or agentic multi-hop retrieval, that is the hosted tier.
- **Single machine — by design.** No sync, no team. Export/import is the bridge.

We document this openly because an honest tool is more trustworthy than a marketing wall.

---

## 10. References

- MCP Specification: [modelcontextprotocol.io/specification](https://modelcontextprotocol.io/specification)
- MCP Apps Spec (2026-01-26): [blog.modelcontextprotocol.io](https://blog.modelcontextprotocol.io)
- sqlite-vec: [github.com/asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) (MIT/Apache-2.0)
- multilingual-e5-small: [huggingface.co/intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small) (Apache-2.0)
- Transformers.js: [huggingface.co/docs/transformers.js](https://huggingface.co/docs/transformers.js)
- Reciprocal Rank Fusion (hybrid search recipe): [alexgarcia.xyz/sqlite-vec](https://alexgarcia.xyz/sqlite-vec)
- Zep / fact supersession: arXiv 2501.13956
- LongMemEval: arXiv 2410.10813

---

## Contact

- **Email:** hello@studiomeyer.io
- **GitHub:** [studiomeyer-io/local-memory-mcp](https://github.com/studiomeyer-io/local-memory-mcp)
- **Hosted sibling:** [memory.studiomeyer.io](https://memory.studiomeyer.io)

---

*This whitepaper is licensed CC BY 4.0 — share, quote, and reuse with attribution to studiomeyer.io. Covers local-memory-mcp v2.2.0; last updated 2026-06-20.*
