#!/usr/bin/env bash
set -euo pipefail

echo "Starting Redmine + MCP container..."

# ----------------------------
# Environment setup
# ----------------------------
RAILS_ENV="${RAILS_ENV:-production}"
PUBLIC_PORT="${PORT:-3000}"
RAILS_INTERNAL_PORT="${RAILS_INTERNAL_PORT:-3001}"

# MCP binds to Railway public port by default
export MCP_HOST="${MCP_HOST:-0.0.0.0}"
export MCP_PORT="${MCP_PORT:-${PUBLIC_PORT}}"

# Redmine internal URL for MCP API calls
export REDMINE_URL="${REDMINE_URL:-http://127.0.0.1:${RAILS_INTERNAL_PORT}}"

echo "RAILS_ENV=${RAILS_ENV}"
echo "PUBLIC_PORT=${PUBLIC_PORT}"
echo "RAILS_INTERNAL_PORT=${RAILS_INTERNAL_PORT}"
echo "MCP_PORT=${MCP_PORT}"
echo "REDMINE_URL=${REDMINE_URL}"

# ----------------------------
# Rails setup (startup tasks)
# ----------------------------
echo "Running database migrations..."
bundle exec rake db:migrate RAILS_ENV="${RAILS_ENV}" || {
  echo "DB migration failed"
  exit 1
}

echo "Running plugin migrations..."
bundle exec rake redmine:plugins:migrate RAILS_ENV="${RAILS_ENV}" || {
  echo "Plugin migration failed"
  exit 1
}

echo "Generating secret token (safe if already exists)..."
bundle exec rake generate_secret_token

# ----------------------------
# Start Redmine (internal)
# ----------------------------
echo "Starting Redmine on 127.0.0.1:${RAILS_INTERNAL_PORT}..."
bundle exec rails server -e "${RAILS_ENV}" -b 127.0.0.1 -p "${RAILS_INTERNAL_PORT}" &
RAILS_PID=$!

# ----------------------------
# Start MCP server (public)
# ----------------------------
echo "Starting MCP server on 0.0.0.0:${MCP_PORT}..."
cd /usr/src/redmine/mcp-redmine-oauth-js
node dist/index.js &
MCP_PID=$!

# ----------------------------
# Graceful shutdown
# ----------------------------
trap 'echo "Shutting down..."; kill ${RAILS_PID} ${MCP_PID} 2>/dev/null || true' SIGINT SIGTERM

wait -n ${RAILS_PID} ${MCP_PID}
STATUS=$?

echo "One process exited. Stopping all..."
kill ${RAILS_PID} ${MCP_PID} 2>/dev/null || true
wait || true

exit ${STATUS}
