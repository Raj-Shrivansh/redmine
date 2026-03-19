#!/usr/bin/env bash
set -euo pipefail

echo "🚀 Starting Redmine + MCP container..."

# ----------------------------
# Environment setup
# ----------------------------
RAILS_ENV="${RAILS_ENV:-production}"
PUBLIC_PORT="${PORT:-3000}"
RAILS_INTERNAL_PORT="${RAILS_INTERNAL_PORT:-3001}"

export MCP_TRANSPORT="${MCP_TRANSPORT:-http}"
export MCP_HTTP_PATH="${MCP_HTTP_PATH:-/mcp}"

# Redmine internal URL (used by MCP)
export REDMINE_URL="${REDMINE_URL:-http://127.0.0.1:${RAILS_INTERNAL_PORT}}"
export REDMINE_PROXY_URL="${REDMINE_PROXY_URL:-http://127.0.0.1:${RAILS_INTERNAL_PORT}}"

echo "RAILS_ENV=$RAILS_ENV"
echo "PUBLIC_PORT=$PUBLIC_PORT"
echo "RAILS_INTERNAL_PORT=$RAILS_INTERNAL_PORT"

# ----------------------------
# Rails setup (one-time tasks)
# ----------------------------
echo "📦 Running database migrations..."
bundle exec rake db:migrate RAILS_ENV="${RAILS_ENV}"

echo "🔌 Running plugin migrations..."
bundle exec rake redmine:plugins:migrate RAILS_ENV="${RAILS_ENV}"

echo "🔑 Generating secret token (safe if already exists)..."
bundle exec rake generate_secret_token

# Optional (can slow startup)
# echo "🎨 Precompiling assets..."
# bundle exec rake assets:precompile RAILS_ENV="${RAILS_ENV}"

# ----------------------------
# Start Redmine (internal)
# ----------------------------
echo "🛠 Starting Redmine on port ${RAILS_INTERNAL_PORT}..."
bundle exec rails server -e "${RAILS_ENV}" -b 127.0.0.1 -p "${RAILS_INTERNAL_PORT}" &
RAILS_PID=$!

# ----------------------------
# Start MCP server (public)
# ----------------------------
echo "🤖 Starting MCP server on port ${PUBLIC_PORT}..."

cd /usr/src/redmine/plugins/redmineflux_mcp/mcp-server

# Ensure Node server binds correctly
export PORT="${PUBLIC_PORT}"

node server.js &
MCP_PID=$!

# ----------------------------
# Graceful shutdown handling
# ----------------------------
trap 'echo "🛑 Shutting down..."; kill ${RAILS_PID} ${MCP_PID} 2>/dev/null || true' SIGINT SIGTERM

# Wait for any process to exit
wait -n ${RAILS_PID} ${MCP_PID}
STATUS=$?

echo "⚠️ One process exited. Stopping all..."
kill ${RAILS_PID} ${MCP_PID} 2>/dev/null || true
wait || true

exit ${STATUS}