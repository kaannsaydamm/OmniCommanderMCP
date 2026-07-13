#!/usr/bin/env bash
set -euo pipefail

REPO_NAME="${1:-OmniCommanderMCP}"
VISIBILITY="${2:-public}"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required." >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init
  git add .
  git commit -m "feat: initial Omni Commander MCP release"
fi

gh repo create "$REPO_NAME" --"$VISIBILITY" --source=. --remote=origin --push
