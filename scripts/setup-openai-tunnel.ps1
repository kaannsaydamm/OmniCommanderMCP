[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TunnelId,
  [string]$Profile = 'omni-commander',
  [ValidateSet('safe','full')][string]$SecurityProfile = 'full'
)
$ErrorActionPreference = 'Stop'
if (-not $env:CONTROL_PLANE_API_KEY) { throw 'Set CONTROL_PLANE_API_KEY for tunnel-client before running this script.' }
if (-not (Get-Command tunnel-client.exe -ErrorAction SilentlyContinue)) {
  throw 'Download the latest tunnel-client from OpenAI Platform tunnel settings or github.com/openai/tunnel-client and add it to PATH.'
}
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $Root
try {
  npm ci
  npm run build
  $McpCommand = "node `"$Root\dist\index.js`" --profile=$SecurityProfile"
  tunnel-client init --sample sample_mcp_stdio_local --profile $Profile --tunnel-id $TunnelId --mcp-command $McpCommand
  tunnel-client doctor --profile $Profile --explain
  Write-Host "Tunnel profile '$Profile' is configured."
  Write-Host "Run: tunnel-client run --profile $Profile"
  Write-Host 'Then create a ChatGPT developer-mode app and choose Tunnel as the connection.'
}
finally { Pop-Location }
