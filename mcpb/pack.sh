#!/usr/bin/env bash
# Build the local-memory .mcpb bundle.
#
# Layout:
#   manifest.json
#   server/
#     package.json
#     dist/server.js + all compiled files + db/schema.sql
#     node_modules/   (production deps — better-sqlite3 is native!)
#
# CRITICAL: better-sqlite3 is a native module. Its prebuilt binary must match
# the Node version that Claude Desktop uses internally. CI builds on Node 24
# which matches Claude Desktop's runtime.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MCPB_DIR="$ROOT/mcpb"
BUILD_DIR="$MCPB_DIR/build"
OUTPUT="$MCPB_DIR/local-memory.mcpb"

echo "==> Cleaning build dir"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/server"

echo "==> Building TypeScript"
(cd "$ROOT" && npm run build)

echo "==> Staging bundle layout"
cp "$MCPB_DIR/manifest.json" "$BUILD_DIR/manifest.json"
cp -r "$ROOT/dist" "$BUILD_DIR/server/dist"

cat > "$BUILD_DIR/server/package.json" <<'JSON'
{
  "name": "local-memory-server",
  "version": "1.0.1",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "better-sqlite3": "^11.7.0",
    "zod": "^3.23.8"
  }
}
JSON

echo "==> Installing production deps (compiles better-sqlite3 native bindings)"
(cd "$BUILD_DIR/server" && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5)

# On macOS: build a UNIVERSAL better-sqlite3 binary (arm64 + x86_64).
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "==> Building universal better-sqlite3 binary (arm64 + x86_64)"
  NODE_BIN="$BUILD_DIR/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  if [[ ! -f "$NODE_BIN" ]]; then
    echo "    ERROR: better_sqlite3.node not found" >&2
    exit 1
  fi

  HOST_ARCH="$(uname -m)"
  echo "    Host arch: $HOST_ARCH"

  TMP_NATIVE="$(mktemp -d)"
  cp "$NODE_BIN" "$TMP_NATIVE/native.node"

  OTHER_ARCH=""
  if [[ "$HOST_ARCH" == "arm64" ]]; then
    OTHER_ARCH="x64"
  else
    OTHER_ARCH="arm64"
  fi
  echo "    Fetching $OTHER_ARCH build"

  TMP_OTHER="$(mktemp -d)"
  (
    cd "$TMP_OTHER"
    npm init -y >/dev/null 2>&1
    npm_config_target_arch="$OTHER_ARCH" \
    npm_config_arch="$OTHER_ARCH" \
    npm install --omit=dev --no-audit --no-fund better-sqlite3@"^11.7.0" 2>&1 | tail -3
  )
  OTHER_NODE="$TMP_OTHER/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  if [[ ! -f "$OTHER_NODE" ]]; then
    echo "    WARNING: failed to fetch $OTHER_ARCH prebuild, shipping single-arch" >&2
  else
    lipo -create "$TMP_NATIVE/native.node" "$OTHER_NODE" -output "$NODE_BIN"
    echo "    Universal binary:"
    lipo -info "$NODE_BIN"
  fi

  rm -rf "$TMP_NATIVE" "$TMP_OTHER"
fi

echo "==> Validating manifest"
mcpb validate "$BUILD_DIR/manifest.json"

echo "==> Packing .mcpb"
rm -f "$OUTPUT"
mcpb pack "$BUILD_DIR" "$OUTPUT"

echo ""
echo "==> Bundle ready: $OUTPUT"
ls -lh "$OUTPUT"
echo ""
echo "Double-click the .mcpb file to install in Claude Desktop."
