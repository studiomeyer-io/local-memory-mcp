# local-memory-mcp

**Persistent local memory for Claude, Cursor & Codex. 13 tools. No cloud. No API keys.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@studiomeyer/local-memory-mcp)](https://www.npmjs.com/package/@studiomeyer/local-memory-mcp)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json)

Your AI assistant forgets everything when you close the chat. This fixes that.

Learnings, decisions, people, projects -- stored in a **single SQLite file** on your machine that never leaves your computer. Built-in Knowledge Graph, duplicate detection, and full-text search.

## Quick Start

### Claude Code

```bash
claude mcp add memory -- npx -y @studiomeyer/local-memory-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json` ([Settings > Developer > Edit Config](https://modelcontextprotocol.io/quickstart/user)):

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

## What it does

When you start a conversation, call `memory_session_start`. The server loads context from your last sessions so the AI knows what you were working on.

During the conversation, the AI stores patterns, insights, and mistakes via `memory_learn`. It records facts about people, projects, and tools via `memory_entity_observe` -- building a knowledge graph over time.

When you search, FTS5 full-text search with bm25 ranking finds relevant memories instantly. The duplicate gatekeeper prevents storing the same information twice.

## Tools (13)

| Tool | What it does |
|------|-------------|
| `memory_session_start` | Start a session, load context from previous conversations |
| `memory_session_end` | End session with summary for next time |
| `memory_learn` | Store a learning (pattern, mistake, insight, ...) with duplicate guard |
| `memory_recall` | Quick keyword search on learnings |
| `memory_search` | Unified FTS5 search across everything |
| `memory_decide` | Record a decision with reasoning and alternatives |
| `memory_entity_observe` | Record a fact about a person/project/tool (auto-creates entity) |
| `memory_entity_search` | Fuzzy search the knowledge graph |
| `memory_entity_open` | Load entity with all observations and relations |
| `memory_entity_relate` | Create typed relations between entities |
| `memory_insights` | Stats: days of memory, counts, breakdowns |
| `memory_profile` | Store your name, role, preferences locally |
| `memory_guide` | Built-in help (topics: quickstart, session, search, entities, learn, privacy) |

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

| Feature | local-memory-mcp | Official MCP Memory | MemPalace | Mem0 | Zep |
|---------|-----------------|---------------------|-----------|------|-----|
| Local-first | Yes | Yes | Yes | No (cloud) | No (cloud) |
| Knowledge Graph | Yes (entities + relations) | Yes (triples) | No | Paid tier | No |
| Duplicate Guard | Yes (FTS5 similarity) | No | No | Unknown | Unknown |
| Decision Tracking | Yes | No | No | No | No |
| Session Context | Yes (auto-load) | No | No | No | No |
| Full-Text Search | FTS5 + bm25 | No | No (vector only) | Vector | Vector |
| Tools | 13 | 5 | 29 | API | API |
| Language | TypeScript | TypeScript | Python | Python | Python |
| Storage | SQLite | JSON file | ChromaDB | Cloud | Cloud |
| Install | `npx` | `npx` | `pip` + venv | Sign up | Sign up |
| Price | Free forever | Free | Free | $0-249/mo | $0-499/mo |

## Need team features?

This is a single-user local memory. For teams, multi-device sync, semantic search with embeddings, and 53+ tools, check out [StudioMeyer Memory](https://memory.studiomeyer.io) -- the hosted version with the same DNA.

## Also by StudioMeyer

| Server | What it does | Link |
|--------|-------------|------|
| **StudioMeyer Memory** | Hosted AI memory with 53 tools, semantic search, multi-agent | [memory.studiomeyer.io](https://memory.studiomeyer.io) |
| **StudioMeyer CRM** | AI-native CRM -- 33 tools, pipeline, leads, revenue | [crm.studiomeyer.io](https://crm.studiomeyer.io) |
| **StudioMeyer GEO** | AI visibility monitoring -- 23 tools, 8 LLM platforms | [geo.studiomeyer.io](https://geo.studiomeyer.io) |
| **MCP Crew** | Agent personas for Claude -- 10 tools, 8 roles, 3 workflows | [crew.studiomeyer.io](https://crew.studiomeyer.io) |

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## License

[MIT](LICENSE)

---

Built by [StudioMeyer](https://studiomeyer.io) -- AI-first web studio from Mallorca.
