param(
  [string]$RepoName = "OmniCommanderMCP",
  [ValidateSet("public", "private", "internal")]
  [string]$Visibility = "public"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) is required."
}

try {
  git rev-parse --is-inside-work-tree | Out-Null
} catch {
  git init
  git add .
  git commit -m "feat: initial Omni Commander MCP release"
}

gh repo create $RepoName "--$Visibility" --source=. --remote=origin --push
