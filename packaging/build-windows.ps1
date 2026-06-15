[CmdletBinding()]
param(
  [string]$WinSwVersion = '2.12.0'
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $repositoryRoot 'release'
$stagingRoot = Join-Path $releaseRoot 'TenderAgent'
$archivePath = Join-Path $releaseRoot 'TenderAgent-Windows-x64.zip'

Push-Location $repositoryRoot
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    throw 'TypeScript build failed.'
  }

  if (Test-Path $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }

  New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'dist') `
    -Destination $stagingRoot -Recurse
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'package.json') `
    -Destination $stagingRoot
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'package-lock.json') `
    -Destination $stagingRoot

  Push-Location $stagingRoot
  try {
    & npm.cmd ci --omit=dev
    if ($LASTEXITCODE -ne 0) {
      throw 'Production dependency installation failed.'
    }
  } finally {
    Pop-Location
  }

  $nodeExecutable = (Get-Command node.exe).Source
  Copy-Item -LiteralPath $nodeExecutable `
    -Destination (Join-Path $stagingRoot 'node.exe')

  $winSwPath = Join-Path $stagingRoot 'TenderAgentService.exe'
  $winSwUrl = "https://github.com/winsw/winsw/releases/download/v$WinSwVersion/WinSW-x64.exe"
  Invoke-WebRequest -Uri $winSwUrl -OutFile $winSwPath

  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'TenderAgentService.xml') `
    -Destination $stagingRoot
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config.production.yaml') `
    -Destination $stagingRoot
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') `
    -Destination $stagingRoot
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') `
    -Destination $stagingRoot
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'INSTALL.md') `
    -Destination $stagingRoot

  if (Test-Path $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }

  Compress-Archive -Path (Join-Path $stagingRoot '*') `
    -DestinationPath $archivePath -CompressionLevel Optimal

  Write-Host "Windows package created:"
  Write-Host "  $archivePath"
} finally {
  Pop-Location
}
