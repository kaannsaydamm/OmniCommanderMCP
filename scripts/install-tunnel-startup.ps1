[CmdletBinding()]
param(
  [string]$Profile = 'omni-commander',
  [string]$TaskName = 'OmniCommander MCP Tunnel'
)
$ErrorActionPreference = 'Stop'
$TunnelClient = (Get-Command tunnel-client.exe -ErrorAction Stop).Source
if (-not $env:CONTROL_PLANE_API_KEY) {
  throw 'CONTROL_PLANE_API_KEY must exist in the user environment before installing the startup task.'
}
[Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY', $env:CONTROL_PLANE_API_KEY, 'User')
$Action = New-ScheduledTaskAction -Execute $TunnelClient -Argument "run --profile $Profile"
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started scheduled task: $TaskName"
