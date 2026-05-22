#!/usr/bin/env bash
#
# build-mcpb.sh — Build a .mcpb bundle for one-click Claude Desktop install.
#
# Output: local-memory-mcp-${VERSION}-${PLATFORM}-${ARCH}.mcpb in the repo root.
#
# Bundle layout:
#   manifest.json   — copied from mcpb-build/manifest.json (kept in git)
#   server/         — copy of dist/ (the compiled MCP server)
#   node_modules/   — production-only deps installed fresh into a sibling dir
#
# Requirements:
#   - Node >=18 + npm
#   - npx @anthropic-ai/mcpb (pulled on demand)
#
# The bundle is platform-specific because better-sqlite3 is a native module.
# Run this script on each target platform (linux, macOS, win32) to ship
# multi-platform bundles. A future GitHub Actions matrix can automate that.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="$(node -p "require('./package.json').version")"
PLATFORM="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"
BUNDLE_NAME="local-memory-mcp-${VERSION}-${PLATFORM}-${ARCH}.mcpb"

echo "[mcpb-build] version=${VERSION} platform=${PLATFORM} arch=${ARCH}"

echo "[mcpb-build] (1/5) Build TypeScript -> dist/"
npm run build

echo "[mcpb-build] (2/5) Prepare bundle dir mcpb-build/"
rm -rf mcpb-build/server mcpb-build/node_modules
mkdir -p mcpb-build/server
cp -r dist/* mcpb-build/server/

echo "[mcpb-build] (3/5) Install production-only deps into mcpb-build/node_modules/"
rm -rf mcpb-build-deps
mkdir -p mcpb-build-deps
(
  cd mcpb-build-deps
  npm init -y > /dev/null
  # Pin to the same versions package.json declares for production.
  SDK_VER="$(node -p "require('../package.json').dependencies['@modelcontextprotocol/sdk']")"
  SQLITE_VER="$(node -p "require('../package.json').dependencies['better-sqlite3']")"
  ZOD_VER="$(node -p "require('../package.json').dependencies['zod']")"
  npm install \
    --omit=dev --no-audit --no-fund --no-package-lock \
    "@modelcontextprotocol/sdk@${SDK_VER}" \
    "better-sqlite3@${SQLITE_VER}" \
    "zod@${ZOD_VER}" \
    > /dev/null
)
cp -r mcpb-build-deps/node_modules mcpb-build/
rm -rf mcpb-build-deps

echo "[mcpb-build] (4/5) Validate manifest"
npx -y @anthropic-ai/mcpb@latest validate mcpb-build/manifest.json

echo "[mcpb-build] (5/5) Pack -> ${BUNDLE_NAME}"
rm -f "${BUNDLE_NAME}"
npx -y @anthropic-ai/mcpb@latest pack mcpb-build/ "${BUNDLE_NAME}"

echo "[mcpb-build] done: ${BUNDLE_NAME}"
ls -lh "${BUNDLE_NAME}"
