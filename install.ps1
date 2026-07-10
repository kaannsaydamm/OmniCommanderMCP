[CmdletBinding()]
param(
  [ValidateSet('safe','full')]
  [string]$Profile = 'safe',
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Get-NodeMajorVersion {
  try {
    $version = (& node --version).Trim().TrimStart('v')
    return [int]($version.Split('.')[0])
  } catch {
    return 0
  }
}

if ((Get-NodeMajorVersion) -lt 20) {
  throw 'Node.js 20 or later is required. Install the current Node.js LTS release and run this script again.'
}

Write-Host 'Materializing checksum-protected Omni Commander 0.2.0 source...'
node scripts/materialize-source.mjs

Write-Host 'Installing dependencies...'
npm install

Write-Host 'Running TypeScript checks...'
npm run typecheck

if (-not $SkipTests) {
  Write-Host 'Running tests...'
  npm test
}

Write-Host 'Building production output...'
npm run build

Write-Host ''
Write-Host 'Omni Commander is ready.' -ForegroundColor Green
Write-Host "Local command: node dist/index.js --profile=$Profile"
Write-Host 'For ChatGPT web, follow docs/REMOTE_CHATGPT.md and use OpenAI Secure MCP Tunnel.'
Write-Host 'Full profile grants the MCP client the same OS rights as this process. Run elevated only when explicitly necessary.' -ForegroundColor Yellow
