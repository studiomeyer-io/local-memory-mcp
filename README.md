<!-- studiomeyer-mcp-stack-banner:start -->
> **Part of the [StudioMeyer MCP Stack](https://studiomeyer.io)** — Built in Mallorca 🌴 · ⭐ if you use it
<!-- studiomeyer-mcp-stack-banner:end -->

# local-memory-mcp


<!-- badges -->
[![npm version](https://img.shields.io/npm/v/%40studiomeyer%2Flocal-memory-mcp?style=flat-square&color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/@studiomeyer/local-memory-mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40studiomeyer%2Flocal-memory-mcp?style=flat-square&color=cb3837&logo=npm&label=installs%2Fmo)](https://www.npmjs.com/package/@studiomeyer/local-memory-mcp)
![License](https://img.shields.io/github/license/studiomeyer-io/local-memory-mcp?style=flat-square&color=22c55e&label=license)
![Last commit](https://img.shields.io/github/last-commit/studiomeyer-io/local-memory-mcp?style=flat-square&color=88c0d0&label=updated)
![GitHub stars](https://img.shields.io/github/stars/studiomeyer-io/local-memory-mcp?style=flat-square&color=ffd700&logo=github&label=stars)
<!-- /badges -->**Persistent local memory for Claude, Cursor & Codex. 17 tools. Hybrid retrieval (BM25 + vector cosine, RRF). Multilingual embeddings. No cloud. No API keys.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@studiomeyer/local-memory-mcp)](https://www.npmjs.com/package/@studiomeyer/local-memory-mcp)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json)

Your AI assistant forgets everything when you close the chat. This fixes that.

Learnings, decisions, people, projects — stored in a **single SQLite file** on your machine that never leaves your computer. Built-in Knowledge Graph, duplicate detection, FTS5 keyword search, and (new in v2) **hybrid retrieval** that fuses BM25 with on-device vector cosine via Reciprocal Rank Fusion. The embedding model is multilingual (DE / EN / ES / 100+ languages) and runs locally — no API keys, no cloud.

> **Not affiliated with [`danieleugenewilliams/local-memory-releases`](https://github.com/danieleugenewilliams/local-memory-releases)** — that is a different "Local Memory" project with the same descriptive name. This package is published as [`@studiomeyer/local-memory-mcp`](https://www.npmjs.com/package/@studiomeyer/local-memory-mcp) — always use the scoped name to disambiguate.

## A note from us

We have been building tools and systems for ourselves for the past two years. The fact that this repo is small and has few stars is not because it is new. It is because we only just decided to share what we have built. It is not a fresh experiment, it is a long story with a recent commit.

We love building things and sharing them. We do not love social media tactics, growth hacks, or chasing stars and followers. So this repo is small. The code is real, it gets used, issues get answered. Judge for yourself.

If it helps you, sharing, testing, and feedback help us. If it could be better, an issue is more useful. If you build something with it, tell us at hello@studiomeyer.io. That genuinely makes our day.

From a small studio in Palma de Mallorca.

## Quick Start

### Claude Code

```bash
claude mcp add memory -- npx -y @studiomeyer/local-memory-mcp
```

### Claude Desktop

**Easiest: one-click MCPB bundle.** v2.0.0 ships pre-built `.mcpb` bundles for every major desktop platform — download the one for your OS from the [latest release](https://github.com/studiomeyer-io/local-memory-mcp/releases/latest) and double-click. Claude Desktop walks you through the install — no JSON editing, no `npm install`, no terminal.

| Platform | Bundle |
|---|---|
| Linux x64 | `local-memory-mcp-2.0.0-linux-x64.mcpb` |
| macOS Apple Silicon | `local-memory-mcp-2.0.0-darwin-arm64.mcpb` |
| macOS Intel | `local-memory-mcp-2.0.0-darwin-x64.mcpb` |
| Windows x64 | `local-memory-mcp-2.0.0-win32-x64.mcpb` |

Each bundle is platform-specific because `better-sqlite3` is a native module — the matching `.node` binary is shipped inside the bundle so you don't need a build toolchain.

**Manual config** (all platforms — add to `claude_desktop_config.json`, see [Settings > Developer > Edit Config](https://modelcontextprotocol.io/quickstart/user)):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@studiomeyer/local-memory-mcp"]
    }
  }
}
```

### Cursor / VS Code

Add to `.cursor/mcp.json` or `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@studiomeyer/local-memory-mcp"]
    }
  }
}
```

### Codex

```toml
# ~/.codex/config.toml
[mcp_servers.memory]
command = "npx"
args = ["-y", "@studiomeyer/local-memory-mcp"]
```

## Automatic session tracking

You can make session tracking fully automatic so you never have to think about it.

**Claude Code (CLAUDE.md):** Add this line to your project's `CLAUDE.md`:

```
Always call memory_session_start at the beginning of each conversation and memory_session_end when done.
```

**Claude Code (Hook):** For a system-wide setup, add a SessionStart hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "echo '{\"hookSpecificOutput\":{\"additionalContext\":\"Call memory_session_start now.\"}}'",
        "timeout": 5
      }]
    }]
  }
}
```

Both approaches make Claude call `memory_session_start` automatically. The CLAUDE.md way is simpler, the hook way works across all projects.

## What it does

When you start a conversation, the server loads context from your last sessions so the AI knows what you were working on.

During the conversation, the AI stores patterns, insights, and mistakes via `memory_learn`. It records facts about people, projects, and tools via `memory_entity_observe` — building a knowledge graph over time. Every stored row is also embedded into a local 384-dim vector via the multilingual-e5-small model.

When you search, the unified `memory_search` runs **hybrid retrieval**: FTS5 with BM25 ranking is fused with vector cosine via Reciprocal Rank Fusion (RRF, k=60). That bridges vocabulary mismatches ("send" finds "publish"), works across DE / EN / ES / 100+ languages, and matches even when the query has no exact token overlap with the stored content. If the vector extension can't load on your machine, search transparently falls back to FTS5-only — nothing breaks, you just lose the semantic half.

The duplicate gatekeeper still prevents storing the same information twice.

## Hybrid Search (v2.0.0+)

```text
memory_search({ query: "...", mode: "hybrid" })   // default
memory_search({ query: "...", mode: "fts" })       // keyword only
memory_search({ query: "...", mode: "vector" })    // cosine only
```

**Architecture**

- `search_fts` (FTS5, BM25) — keyword recall, the v1 path.
- `embeddings` (`sqlite-vec` `vec0` virtual table, float[384]) — vector recall.
- Reciprocal Rank Fusion (k=60) combines the two when `mode: "hybrid"`.
- Embeddings come from `Xenova/multilingual-e5-small` (Apache-2.0) via Transformers.js, q8-quantized (~30 MB cache). Model loads lazily on the first embed call; runs entirely on CPU.
- Auto-embed-on-insert covers learnings, decisions, and entity observations. Entities themselves are not embedded — their attached observations carry the semantic surface.

**Multilingual.** The default model is trained on 100+ languages with strong DE/EN/ES retrieval. Mixing languages in your stored data is fine — query in one language and the cosine half still surfaces relevant results in another.

**Environment overrides**

- `MEMORY_EMBED_DISABLED=1` — force FTS5-only (e.g. air-gapped or corporate-proxy network).
- `MEMORY_EMBED_MODEL=...` — swap in a different Transformers.js feature-extraction model.
- `MEMORY_EMBED_CACHE_DIR=...` — override the Transformers.js cache location.
- `MEMORY_EMBED_DTYPE=fp32|fp16|q8|q4` — model quantization (default `q8`).

## Tools (17)

### Sessions

**`memory_session_start`** -- Call this first in every conversation. Loads context from your last 3 sessions (summaries, recent learnings) so your AI knows what you were working on. Optional `project` parameter to scope sessions by project.

**`memory_session_end`** -- Call at the end to save a summary. Pass a `summary` string describing what was accomplished. The next session auto-loads this. Without arguments it closes the active session.

### Learnings

**`memory_learn`** -- The core tool. Stores a piece of knowledge with a category and content. Categories: `pattern` (recurring success), `mistake` (what went wrong), `insight` (strategic realization), `research` (external knowledge), `architecture`, `infrastructure`, `tool`, `workflow`, `performance`, `security`. The duplicate gatekeeper checks if something similar already exists. If it finds a match, it bumps the usage counter instead of creating a duplicate. Optional: `tags`, `confidence` (0-1), `project`, `memoryType` (episodic or semantic, auto-classified if omitted).

**`memory_recall`** -- Quick search on learnings only. Pass a `query` string for keyword search, or omit it to get the most recent learnings. Good for "what did I learn about X" questions. Use `limit` to control how many results come back (default 10).

**`memory_search`** -- Unified search across everything: learnings, decisions, entities, and observations. Uses FTS5 with bm25 ranking. Multi-word queries match any of the words and rank by relevance. Use `types` array to filter (e.g. `["learning", "decision"]`). This is the broadest search tool.

**When to use recall vs search:** Use `recall` when you want learnings specifically. Use `search` when you want to find anything across all types, including entities and decisions.

### Decisions

**`memory_decide`** -- Records a decision with structured context. Parameters: `title` (what was decided), `decision` (the choice made), `reasoning` (why), `alternatives` (what else was considered). Optional: `confidence`, `project`, `tags`. This is useful for looking back at past decisions months later and understanding why you chose something.

### Knowledge Graph

**`memory_entity_observe`** -- Record a fact about a person, project, company, tool, or any other entity. If the entity does not exist yet it gets created automatically. Parameters: `entityName`, `entityType` (person, project, company, tool, concept, etc.), `content` (the fact). Observations are bi-temporal, meaning they can be superseded over time without losing history.

**`memory_entity_search`** -- Fuzzy search across entity names and their observations. Finds "Claude" even if you search for "claude ai". Optional `entityType` filter to narrow results.

**`memory_entity_open`** -- Load a full entity view: the entity itself, all its current observations, and all its relations to other entities. Search by `name` or `id`. This is the deep-dive tool when you want everything about one entity.

**`memory_entity_relate`** -- Create a typed, directed edge between two entities. Parameters: `fromEntityId`, `toEntityId`, `relationType` (e.g. "works_at", "uses", "created", "depends_on"). Optional `weight` (0-1). Build a graph of how things connect.

**Recommended entity types:** `person`, `project`, `company`, `tool`, `concept`, `service`, `team`. Use whatever makes sense for your domain.

### Reflection

**`memory_insights`** -- Overview stats: how many days of memory, total sessions, learnings, decisions, entities. Category breakdown and entity type breakdown. Good for "what does Claude know about me" moments. Optional `project` filter.

**`memory_profile`** -- Store personal info locally. Use `set` to store fields (name, role, preferences, language, timezone), use `get` to retrieve them. Your AI can read this at session start to personalize its behavior.

**`memory_guide`** -- Built-in help. Topics: `quickstart` (how to get started), `session` (session workflow), `search` (how search works), `entities` (knowledge graph explained), `learn` (learning categories), `privacy` (where data lives, what is collected).

## Tips

- **Start with sessions and learnings.** Just calling `memory_session_start` at the beginning and `memory_learn` when something important comes up already gives you 80% of the value.
- **Use entities for people and projects.** When you mention a colleague, client, or project repeatedly, create an entity. Over time you build a knowledge graph that your AI can traverse.
- **Decisions are underrated.** Three months from now you will not remember why you chose Postgres over SQLite for that project. `memory_decide` captures the reasoning.
- **Let your AI drive.** Once the tools are available, your AI will naturally start using them. You do not need to call tools manually. Say "remember this" and it calls `memory_learn`. Say "what do you know about Sarah" and it calls `memory_entity_search`.
- **Back up your SQLite file.** It is a single file. Copy it to a USB drive, Dropbox, wherever. You can also open it with any SQLite browser to inspect what your AI has learned.

## Features

- **Knowledge Graph** -- not just flat text. Entities, bi-temporal observations, typed relations.
- **Duplicate Guard** -- FTS5 similarity check prevents storing the same thing twice. Usage counter instead.
- **Session Context** -- auto-loads last 3 sessions on start. Your AI picks up where you left off.
- **Decision Tracking** -- log decisions with reasoning and alternatives. Unique among memory servers.
- **Full-Text Search** -- FTS5 with bm25 ranking across learnings, decisions, entities, observations.
- **Single SQLite File** -- one file, portable, backupable, deletable. WAL mode for concurrent access.
- **Zero Config** -- `npx` and done. No Docker, no Postgres, no Redis, no API keys.

## Where your data lives

Everything in one SQLite file. Back it up, move it, delete it -- it's yours.

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/local-memory-mcp/memory.sqlite` |
| Linux | `~/.local/share/local-memory-mcp/memory.sqlite` |
| Windows | `%APPDATA%\local-memory-mcp\memory.sqlite` |

Override: `MEMORY_DB_PATH=/your/preferred/path.sqlite`

## Privacy

- Your data **never** leaves your machine
- No telemetry, no phone-home, no analytics
- No account required, no API keys needed
- Open source -- read every line of code

## Comparison

| Feature | local-memory-mcp | Penfield | Official MCP Memory | MemPalace | Mem0 | Zep | Letta | AutoMem |
|---|---|---|---|---|---|---|---|---|
| Local-first | Yes | Yes | Yes | Yes | No (cloud) | No (cloud) | Partial | Yes |
| Hybrid retrieval (BM25 + vector) | **Yes (RRF)** | Yes | No | No (vector only) | Vector only | Vector only | Vector + graph | Vector + graph |
| Multilingual embeddings | **Yes (e5-small, DE/EN/ES + 100 more)** | Unknown | No | Unknown | English-leaning | English-leaning | Mixed | Mixed |
| Knowledge Graph | Yes (entities + relations) | Yes | Yes (triples) | No | Paid tier | Yes | Yes | Yes (FalkorDB) |
| Bi-temporal facts | Yes (schema) | Unknown | No | No | Yes | Yes | Partial | Unknown |
| Duplicate Guard | Yes (FTS5 + similarity) | No | No | No | Unknown | Unknown | Unknown | Unknown |
| Decision Tracking | **Yes (unique)** | No | No | No | No | No | No | No |
| Session Context | Yes (auto-load) | Yes | No | No | No | No | Yes | Yes |
| Tools | **17** | 17 | 5 | 29 | API | API | API | API |
| Language | TypeScript | TypeScript | TypeScript | Python | Python | Python | Python | Python |
| Storage | SQLite + sqlite-vec | SQLite | JSON file | ChromaDB | Cloud | Cloud | Various | FalkorDB + Qdrant |
| API keys needed | **No** | No | No | No | Yes (cloud) | Yes (cloud) | Optional | Optional |
| Install | `npx` or `.mcpb` | `npx` | `npx` | `pip` + venv | Sign up | Sign up | `pip` / Docker | `pip` / Docker |
| Multi-platform bundle | **Yes (4 OS)** | No | No | n/a | n/a | n/a | n/a | n/a |
| Price | Free forever | Free | Free | Free | $0-249/mo | $0-499/mo | Free | Free |

**Where we stand out:** the only local, MIT-licensed, API-key-free memory MCP shipping hybrid retrieval (BM25 + vector cosine via RRF) with multilingual embeddings and one-click installers for every desktop OS. Decision tracking remains unique to us.

## local-memory-mcp vs. StudioMeyer Memory

Two products, same team, different use cases:

| | **local-memory-mcp** (this repo) | **StudioMeyer Memory** (hosted) |
|---|---|---|
| Where | Your machine (SQLite + sqlite-vec) | Cloud (Supabase EU Frankfurt) |
| Tools | 17 | 56 |
| Search | FTS5 + sqlite-vec hybrid (RRF) | FTS5 + pgvector + cross-encoder reranking |
| Embeddings | Local (multilingual-e5-small, 384-dim) | Cloud (multiple models, reranking) |
| Multi-device | No | Yes |
| Multi-agent | No | Yes |
| Price | Free forever | Free tier / EUR 19 Pro / EUR 39 Team |
| Install | `npx` or `.mcpb` (Linux / macOS / Windows) | [memory.studiomeyer.io](https://memory.studiomeyer.io) |
| Repo | [local-memory-mcp](https://github.com/studiomeyer-io/local-memory-mcp) | [studiomeyer-memory](https://github.com/studiomeyer-io/studiomeyer-memory) (docs) |

Start local. Upgrade when you need teams, multi-device sync, or cross-encoder rerank.

## Also by StudioMeyer

| Server | What it does | Link |
|--------|-------------|------|
| **StudioMeyer Memory** | Hosted AI memory with 56 tools, semantic search, multi-agent | [memory.studiomeyer.io](https://memory.studiomeyer.io) |
| **StudioMeyer CRM** | AI-native CRM -- 33 tools, pipeline, leads, revenue | [crm.studiomeyer.io](https://crm.studiomeyer.io) |
| **StudioMeyer GEO** | AI visibility monitoring -- 23 tools, 8 LLM platforms | [geo.studiomeyer.io](https://geo.studiomeyer.io) |
| **MCP Crew** | Agent personas for Claude -- 10 tools, 8 roles, 3 workflows | [crew.studiomeyer.io](https://crew.studiomeyer.io) |

## Security

See [SECURITY.md](SECURITY.md) for the threat model, reporting process, and notes on known SAST scanner false positives. In particular: `db.exec(schema)` in `src/db/client.ts` is `better-sqlite3`'s SQL-string executor, not `child_process.exec` — some pattern-based scanners flag it without import resolution. The repo contains zero shell-execution code (verify with `grep -rn child_process src/`).

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## About StudioMeyer

[StudioMeyer](https://studiomeyer.io) is an AI and design studio based in Palma de Mallorca, working with clients worldwide. We build custom websites and AI infrastructure for small and medium businesses. Production stack on Claude Agent SDK, MCP and n8n, with Sentry, Langfuse and LangGraph for observability and an in-house guard layer.

## License

[MIT](LICENSE)

---

Built by [StudioMeyer](https://studiomeyer.io) -- AI-first web studio from Mallorca.