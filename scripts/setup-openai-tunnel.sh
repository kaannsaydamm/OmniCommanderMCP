#!/usr/bin/env bash
set -euo pipefail

TUNNEL_ID="${1:-${TUNNEL_ID:-}}"
PROFILE="${OMNI_TUNNEL_PROFILE:-omni-commander}"
MODE="${OMNI_PROFILE:-full}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$TUNNEL_ID" ]]; then
  echo "Usage: CONTROL_PLANE_API_KEY=sk-... $0 tunnel_xxx" >&2
  exit 2
fi
if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  echo "CONTROL_PLANE_API_KEY is required for tunnel-client." >&2
  exit 2
fi
if ! command -v tunnel-client >/dev/null 2>&1; then
  echo "Download the latest tunnel-client from OpenAI Platform tunnel settings or github.com/openai/tunnel-client." >&2
  exit 3
fi

cd "$ROOT"
npm ci
npm run build
MCP_COMMAND="node \"$ROOT/dist/index.js\" --profile=$MODE"

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile "$PROFILE" \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-command "$MCP_COMMAND"

tunnel-client doctor --profile "$PROFILE" --explain
cat <<MSG
Tunnel profile '$PROFILE' is configured.
Start it with:
  CONTROL_PLANE_API_KEY=sk-... tunnel-client run --profile "$PROFILE"
Then create a ChatGPT developer-mode app and choose Tunnel as the connection.
MSG
