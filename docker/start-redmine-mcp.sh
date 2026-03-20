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

# Redmine internal URL (used by MCP to proxy API calls)
export REDMINE_URL="${REDMINE_URL:-http://127.0.0.1:${RAILS_INTERNAL_PORT}}"
export REDMINE_PROXY_URL="${REDMINE_PROXY_URL:-http://127.0.0.1:${RAILS_INTERNAL_PORT}}"

# MCP public URL — used to build the OAuth callback URL
# Must be the externally reachable base URL of this container
# e.g. https://your-app.onrender.com
if [ -z "${MCP_PUBLIC_URL:-}" ]; then
  echo "⚠️  MCP_PUBLIC_URL is not set."
  echo "   OAuth callback will default to http://localhost:${PUBLIC_PORT}"
  echo "   Set MCP_PUBLIC_URL=https://your-app.onrender.com for production OAuth to work."
  export MCP_PUBLIC_URL="http://localhost:${PUBLIC_PORT}"
fi

# OAuth 2.0 credentials (Redmine 6.1 built-in OAuth provider)
# Register at: Redmine → Administration → Applications → New Application
# Redirect URI to register: ${MCP_PUBLIC_URL}/oauth/callback
if [ -n "${OAUTH_CLIENT_ID:-}" ] && [ -n "${OAUTH_CLIENT_SECRET:-}" ]; then
  echo "✅ OAuth 2.0 mode: OAUTH_CLIENT_ID is set"
  echo "   Callback URL: ${MCP_PUBLIC_URL}/oauth/callback"
  echo "   Make sure this URI is registered in Redmine → Administration → Applications"
else
  echo "ℹ️  OAuth not configured. Falling back to REDMINE_API_KEY if set."
  if [ -z "${REDMINE_API_KEY:-}" ]; then
    echo "⚠️  Neither OAUTH_CLIENT_ID nor REDMINE_API_KEY is set."
    echo "   MCP tools will require calling set_api_key or get_auth_status manually."
  else
    echo "✅ Auth mode: static REDMINE_API_KEY"
  fi
fi

echo ""
echo "RAILS_ENV=$RAILS_ENV"
echo "PUBLIC_PORT=$PUBLIC_PORT"
echo "RAILS_INTERNAL_PORT=$RAILS_INTERNAL_PORT"
echo "MCP_PUBLIC_URL=$MCP_PUBLIC_URL"
echo ""

# ----------------------------
# Rails setup (one-time tasks)
# ----------------------------
echo "📦 Running database migrations..."
bundle exec rake db:migrate RAILS_ENV="${RAILS_ENV}" || {
  echo "❌ DB migration failed"
  exit 1
}

echo "🔌 Running plugin migrations..."
bundle exec rake redmine:plugins:migrate RAILS_ENV="${RAILS_ENV}" || {
  echo "❌ Plugin migration failed"
  exit 1
}

echo "🔑 Generating secret token (safe if already exists)..."
bundle exec rake generate_secret_token

# ----------------------------
# Wait for Redmine to be ready
# ----------------------------
wait_for_redmine() {
  echo "⏳ Waiting for Redmine to be ready on port ${RAILS_INTERNAL_PORT}..."
  for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${RAILS_INTERNAL_PORT}" > /dev/null 2>&1; then
      echo "✅ Redmine is up!"
      return 0
    fi
    echo "   ... attempt ${i}/30"
    sleep 3
  done
  echo "❌ Redmine did not start in time"
  return 1
}

# ----------------------------
# Start Redmine (internal)
# ----------------------------
echo "🛠  Starting Redmine on port ${RAILS_INTERNAL_PORT}..."
bundle exec rails server -e "${RAILS_ENV}" -b 127.0.0.1 -p "${RAILS_INTERNAL_PORT}" &
RAILS_PID=$!

# Wait for Redmine before starting MCP (MCP proxies to Redmine)
wait_for_redmine || { kill ${RAILS_PID} 2>/dev/null; exit 1; }

# ----------------------------
# Start MCP server (public)
# ----------------------------
echo "🤖 Starting MCP server on port ${PUBLIC_PORT}..."

cd /usr/src/redmine/plugins/redmineflux_mcp/mcp-server

export PORT="${PUBLIC_PORT}"

node server.js &
MCP_PID=$!

echo ""
echo "✅ Both services started."
echo "   Redmine (internal) → http://127.0.0.1:${RAILS_INTERNAL_PORT}"
echo "   MCP server (public) → ${MCP_PUBLIC_URL}${MCP_HTTP_PATH}"
if [ -n "${OAUTH_CLIENT_ID:-}" ]; then
  echo "   OAuth callback URL  → ${MCP_PUBLIC_URL}/oauth/callback"
fi
echo ""

# ----------------------------
# Graceful shutdown handling
# ----------------------------
trap 'echo "🛑 Shutting down..."; kill ${RAILS_PID} ${MCP_PID} 2>/dev/null || true' SIGINT SIGTERM

# Wait for any process to exit
wait -n ${RAILS_PID} ${MCP_PID}
STATUS=$?

echo "⚠️  One process exited. Stopping all..."
kill ${RAILS_PID} ${MCP_PID} 2>/dev/null || true
wait || true

exit ${STATUS}