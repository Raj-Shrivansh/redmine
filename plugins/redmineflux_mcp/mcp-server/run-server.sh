#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Optional: load nvm if present so `node` resolves in desktop app contexts.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
fi

export REDMINE_URL="${REDMINE_URL:-http://127.0.0.1:3000}"

cd "$SCRIPT_DIR"
exec node server.js
