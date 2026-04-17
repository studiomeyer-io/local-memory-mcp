#!/usr/bin/env bash
# Build local-memory .mcpb as standalone binary (bun:sqlite, no native modules).
#
# This uses bun build --compile to produce a single executable that embeds
# the Bun runtime + bun:sqlite. No Node.js required on the target machine.
# Eliminates the native module version mismatch that crashes type:"node" bundles.
#
# Usage:
#   ./pack-binary.sh              # builds for current platform
#   ./pack-binary.sh darwin-arm64 # cross-compile for Mac ARM
#   ./pack-binary.sh darwin-x64   # cross-compile for Mac Intel

set -euo pipefail

TARGET="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MCPB_DIR="$ROOT/mcpb"
BUILD_DIR="$MCPB_DIR/build"

echo "==> Cleaning build dir"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/server"

echo "==> Swapping client.ts to bun:sqlite version"
cp "$ROOT/src/db/client.ts" "$ROOT/src/db/client-node-backup.ts"
cp "$ROOT/src/db/client-bun.ts" "$ROOT/src/db/client.ts"

# Determine compile target
COMPILE_ARGS=""
OUTPUT_NAME="local-memory"
if [[ -n "$TARGET" ]]; then
  COMPILE_ARGS="--target=bun-${TARGET}"
  echo "==> Cross-compiling for $TARGET"
fi

echo "==> Compiling standalone binary with bun"
cd "$ROOT"
bun build src/server.ts --compile $COMPILE_ARGS --outfile "$BUILD_DIR/server/$OUTPUT_NAME"

echo "==> Restoring original client.ts"
mv "$ROOT/src/db/client-node-backup.ts" "$ROOT/src/db/client.ts"

echo "==> Writing binary manifest"
cat > "$BUILD_DIR/manifest.json" <<'JSON'
{
  "manifest_version": "0.2",
  "name": "local-memory",
  "display_name": "Local Memory",
  "version": "1.0.1",
  "description": "Persistent local memory for Claude. 100% local, SQLite-based, zero API keys.",
  "long_description": "Local Memory gives Claude a persistent memory across conversations. Sessions, learnings, decisions, and a knowledge graph -- all stored in a single SQLite file on your machine. No cloud, no account, no telemetry. Install with a double-click. 13 tools.",
  "author": {
    "name": "StudioMeyer",
    "email": "hello@studiomeyer.io",
    "url": "https://studiomeyer.io"
  },
  "homepage": "https://github.com/studiomeyer-io/local-memory-mcp",
  "license": "MIT",
  "keywords": ["memory", "local-first", "privacy", "sqlite", "knowledge-graph", "claude", "mcp"],
  "server": {
    "type": "binary",
    "entry_point": "server/local-memory"
  },
  "tools": [
    { "name": "memory_session_start", "description": "Start a session and load previous context" },
    { "name": "memory_session_end", "description": "End the current session with a summary" },
    { "name": "memory_learn", "description": "Store a learning with duplicate detection" },
    { "name": "memory_recall", "description": "Quick recall of learnings" },
    { "name": "memory_search", "description": "Unified FTS5 search across everything" },
    { "name": "memory_decide", "description": "Log a decision with reasoning" },
    { "name": "memory_entity_observe", "description": "Record a fact about an entity (auto-creates)" },
    { "name": "memory_entity_search", "description": "Fuzzy search the knowledge graph" },
    { "name": "memory_entity_open", "description": "Load entity with observations and relations" },
    { "name": "memory_entity_relate", "description": "Create a typed relation between entities" },
    { "name": "memory_insights", "description": "Memory stats and reflection" },
    { "name": "memory_profile", "description": "Read or write a user profile field" },
    { "name": "memory_guide", "description": "On-demand help for any topic" }
  ],
  "compatibility": {
    "platforms": ["darwin", "win32", "linux"]
  }
}
JSON

echo "==> Packing .mcpb"
PLATFORM="${TARGET:-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)}"
OUTPUT="$MCPB_DIR/local-memory-${PLATFORM}.mcpb"
rm -f "$OUTPUT"
mcpb pack "$BUILD_DIR" "$OUTPUT" 2>/dev/null || (cd "$BUILD_DIR" && zip -r "$OUTPUT" manifest.json server/)

echo ""
echo "==> Bundle ready: $OUTPUT"
ls -lh "$OUTPUT"
echo ""
echo "Double-click the .mcpb file to install in Claude Desktop."
