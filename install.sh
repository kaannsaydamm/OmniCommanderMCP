#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-safe}"
if [[ "$PROFILE" != "safe" && "$PROFILE" != "full" ]]; then
  echo "Usage: ./install.sh [safe|full]" >&2
  exit 2
fi

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or later is required." >&2
  exit 1
fi

NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node.js 20 or later is required; found $(node --version)." >&2
  exit 1
fi

if ! command -v tar >/dev/null 2>&1; then
  echo "The tar command is required to materialize the source archive." >&2
  exit 1
fi

echo "Materializing checksum-protected Omni Commander 0.2.0 source..."
node scripts/materialize-source.mjs

echo "Installing dependencies..."
npm install

echo "Running checks and tests..."
npm run check

echo "Building production output..."
npm run build

cat <<EOF

Omni Commander is ready.
Local command: node dist/index.js --profile=$PROFILE
For ChatGPT web, follow docs/REMOTE_CHATGPT.md and use OpenAI Secure MCP Tunnel.
Full profile grants the MCP client the same OS rights as this process.
EOF
