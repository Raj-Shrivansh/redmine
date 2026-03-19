#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
MCP_DIR="$PLUGIN_DIR/mcp-server"

cd "$MCP_DIR"
exec node server.js
