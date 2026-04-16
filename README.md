# local-memory-mcp

Persistent local memory for any MCP client. One command. No cloud. No API keys.

Works with **Claude Desktop**, **Claude Code**, **Cursor**, **Codex**, **Continue**, and any MCP-compatible client.

```
npx local-memory-mcp
```

Your AI assistant remembers everything across conversations. Learnings, decisions, people, projects -- stored in a single SQLite file on your machine that never leaves your computer.

## Why

AI assistants forget everything when you close the chat. This fixes that.

- **13 tools** for sessions, learnings, decisions, and a knowledge graph
- **Duplicate guard** prevents storing the same thing twice
- **FTS5 search** finds anything instantly, even with typos
- **Knowledge Graph** with entities, bi-temporal observations, and relations
- **Single SQLite file** you can back up, copy, or delete at any time
- **Zero dependencies** beyond Node.js -- no Docker, no Postgres, no Redis

## Install

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "local-memory-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add memory -- npx -y local-memory-mcp
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "local-memory-mcp"]
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.memory]
command = "npx"
args = ["-y", "local-memory-mcp"]
```

### Continue

Add to `~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: memory
    command: npx
    args: ["-y", "local-memory-mcp"]
```

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
| `memory_guide` | Built-in help per topic |

## How it works

When you start a conversation, call `memory_session_start`. The server loads context from your last 3 sessions so the AI knows what you were working on.

During the conversation, the AI calls `memory_learn` to store patterns, insights, and mistakes. It calls `memory_entity_observe` to record facts about people, projects, and tools -- building a knowledge graph over time.

When you search, FTS5 full-text search with bm25 ranking finds relevant memories instantly. The duplicate gatekeeper prevents storing the same information twice.

Everything is stored in a single SQLite file:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/local-memory-mcp/memory.sqlite` |
| Linux | `~/.local/share/local-memory-mcp/memory.sqlite` |
| Windows | `%APPDATA%\local-memory-mcp\memory.sqlite` |

Override with `MEMORY_DB_PATH=/your/path.sqlite`.

## Privacy

- Your data **never** leaves your machine
- No telemetry, no phone-home, no analytics
- No account required, no API keys needed
- The SQLite file is yours -- back it up, move it, delete it

## vs. Other Memory Solutions

| Feature | local-memory-mcp | MemPalace | Mem0 | Zep |
|---------|-----------------|-----------|------|-----|
| Local-first | Yes | Yes | No (cloud) | No (cloud) |
| Knowledge Graph | Yes (entities + relations) | No | Paid tier | No |
| Duplicate Guard | Yes (FTS5 similarity) | No | Unknown | Unknown |
| Decision Tracking | Yes | No | No | No |
| Session Context | Yes (auto-load) | No | No | No |
| Language | TypeScript (npm) | Python (pip) | Python | Python |
| Storage | SQLite + FTS5 | JSON files | Cloud DB | Cloud DB |
| Install | `npx` (one command) | `pip install` | Sign up | Sign up |
| Price | Free forever | Free | $0-249/mo | $0-499/mo |

## Need team features?

This is a single-user local memory. For teams, multi-device sync, semantic search with embeddings, and 53+ tools, check out [StudioMeyer Memory](https://memory.studiomeyer.io) -- the hosted version with the same DNA.

## Contributing

Issues and PRs welcome. MIT licensed.

## License

MIT
