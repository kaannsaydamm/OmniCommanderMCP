[CmdletBinding()]
param(
  [switch]$InstallTesseract
)
$ErrorActionPreference = 'Stop'
Write-Host 'Windows pointer, keyboard, window and screenshot control use built-in PowerShell/.NET APIs.'
if ($InstallTesseract) {
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw 'winget is required to install Tesseract automatically.'
  }
  winget install --id UB-Mannheim.TesseractOCR -e --accept-package-agreements --accept-source-agreements
}
Write-Host 'Run OmniCommander at the same elevation level as applications you need to control. Elevated windows cannot be automated by a non-elevated process.'
