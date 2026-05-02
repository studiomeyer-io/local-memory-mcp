<!-- studiomeyer-mcp-stack-banner:start -->
> **Part of the [StudioMeyer MCP Stack](https://studiomeyer.io)** — Built in Mallorca 🌴 · ⭐ if you use it
<!-- studiomeyer-mcp-stack-banner:end -->

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

During the conversation, the AI stores patterns, insights, and mistakes via `memory_learn`. It records facts about people, projects, and tools via `memory_entity_observe` -- building a knowledge graph over time.

When you search, FTS5 full-text search with bm25 ranking finds relevant memories instantly. The duplicate gatekeeper prevents storing the same information twice.

## Tools (13)

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

## local-memory-mcp vs. StudioMeyer Memory

Two products, same team, different use cases:

| | **local-memory-mcp** (this repo) | **StudioMeyer Memory** (hosted) |
|---|---|---|
| Where | Your machine (SQLite) | Cloud (Supabase EU Frankfurt) |
| Tools | 13 | 56 |
| Search | FTS5 keyword | FTS5 + pgvector semantic + reranking |
| Multi-device | No | Yes |
| Multi-agent | No | Yes |
| Price | Free forever | Free tier / $29 Pro / $49 Team |
| Install | `npx` | [memory.studiomeyer.io](https://memory.studiomeyer.io) |
| Repo | [local-memory-mcp](https://github.com/studiomeyer-io/local-memory-mcp) | [studiomeyer-memory](https://github.com/studiomeyer-io/studiomeyer-memory) (docs) |

Start local. Upgrade when you need teams or semantic search.

## Also by StudioMeyer

| Server | What it does | Link |
|--------|-------------|------|
| **StudioMeyer Memory** | Hosted AI memory with 56 tools, semantic search, multi-agent | [memory.studiomeyer.io](https://memory.studiomeyer.io) |
| **StudioMeyer CRM** | AI-native CRM -- 33 tools, pipeline, leads, revenue | [crm.studiomeyer.io](https://crm.studiomeyer.io) |
| **StudioMeyer GEO** | AI visibility monitoring -- 23 tools, 8 LLM platforms | [geo.studiomeyer.io](https://geo.studiomeyer.io) |
| **MCP Crew** | Agent personas for Claude -- 10 tools, 8 roles, 3 workflows | [crew.studiomeyer.io](https://crew.studiomeyer.io) |

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## About StudioMeyer

[StudioMeyer](https://studiomeyer.io) is an AI and design studio from Palma de Mallorca, building custom websites and AI infrastructure for small and medium businesses. Production stack on Claude Agent SDK, MCP and n8n, with Sentry, Langfuse and LangGraph for observability and an in-house guard layer.

## License

[MIT](LICENSE)

---

Built by [StudioMeyer](https://studiomeyer.io) -- AI-first web studio from Mallorca.