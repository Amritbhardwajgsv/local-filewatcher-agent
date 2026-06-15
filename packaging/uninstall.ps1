[CmdletBinding()]
param(
  [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdministrator = $principal.IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)

if (-not $isAdministrator) {
  throw 'Run PowerShell as Administrator before executing uninstall.ps1.'
}

$installRoot = Join-Path $env:ProgramFiles 'TenderAgent'
$dataRoot = Join-Path $env:ProgramData 'TenderAgent'
$serviceExecutable = Join-Path $installRoot 'TenderAgentService.exe'
$shortcutPath = Join-Path $env:PUBLIC `
  'Desktop\Upload Tender Documents.lnk'

if (Test-Path $serviceExecutable) {
  & $serviceExecutable stop 2>$null
  & $serviceExecutable uninstall 2>$null
}

if (Test-Path $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
}

if (Test-Path $installRoot) {
  Remove-Item -LiteralPath $installRoot -Recurse -Force
}

if ($PurgeData -and (Test-Path $dataRoot)) {
  Remove-Item -LiteralPath $dataRoot -Recurse -Force
}

Write-Host 'Tender Agent uninstalled.'
if (-not $PurgeData) {
  Write-Host "Queue, configuration, and logs were preserved at $dataRoot"
}
