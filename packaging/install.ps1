[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$AgentId,

  [string]$ApiUrl = 'https://tender-automation-api.onrender.com/api/v1'
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdministrator = $principal.IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)

if (-not $isAdministrator) {
  throw 'Run PowerShell as Administrator before executing install.ps1.'
}

$apiKeySecure = Read-Host 'Enter the API key for this machine' -AsSecureString
$apiKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
  $apiKeySecure
)

try {
  $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
    $apiKeyPointer
  )
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($apiKeyPointer)
}

if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw 'API key cannot be empty.'
}

$sourceRoot = $PSScriptRoot
$installRoot = Join-Path $env:ProgramFiles 'TenderAgent'
$dataRoot = Join-Path $env:ProgramData 'TenderAgent'
$watchedRoot = Join-Path $env:PUBLIC 'Documents\Tender Uploads'
$publicDesktop = Join-Path $env:PUBLIC 'Desktop'
$shortcutPath = Join-Path $publicDesktop 'Upload Tender Documents.lnk'

New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
New-Item -ItemType Directory -Path $watchedRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dataRoot 'data') -Force |
  Out-Null
New-Item -ItemType Directory -Path (Join-Path $dataRoot 'logs') -Force |
  Out-Null
New-Item -ItemType Directory -Path (Join-Path $dataRoot 'rejected') -Force |
  Out-Null
New-Item -ItemType Directory -Path (Join-Path $dataRoot 'service-logs') -Force |
  Out-Null

$serviceExecutable = Join-Path $installRoot 'TenderAgentService.exe'

if (Test-Path $serviceExecutable) {
  & $serviceExecutable stop 2>$null
  & $serviceExecutable uninstall 2>$null
}

if ((Resolve-Path $sourceRoot).Path -eq $installRoot) {
  throw 'Run install.ps1 from the extracted release folder, not Program Files.'
}

Get-ChildItem -LiteralPath $installRoot -Force |
  Remove-Item -Recurse -Force

Get-ChildItem -LiteralPath $sourceRoot -Force |
  Where-Object { $_.Name -notin @('install.ps1', 'config.production.yaml') } |
  Copy-Item -Destination $installRoot -Recurse -Force

$configTemplate = Get-Content `
  -LiteralPath (Join-Path $sourceRoot 'config.production.yaml') -Raw
$configContent = $configTemplate.Replace('__AGENT_ID__', $AgentId)
Set-Content -LiteralPath (Join-Path $dataRoot 'config.yaml') `
  -Value $configContent -Encoding UTF8

$envContent = @(
  "CLOUD_API_URL=$ApiUrl"
  "CLOUD_API_KEY=$apiKey"
  "AGENT_ID=$AgentId"
) -join [Environment]::NewLine
$envPath = Join-Path $dataRoot '.env'
Set-Content -LiteralPath $envPath -Value $envContent -Encoding ASCII

& icacls.exe $envPath /inheritance:r /grant:r `
  '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $watchedRoot
$shortcut.WorkingDirectory = $watchedRoot
$shortcut.Description = 'Drop tender documents here for automatic upload.'
$shortcut.Save()

& $serviceExecutable install
if ($LASTEXITCODE -ne 0) {
  throw 'Windows service installation failed.'
}

& $serviceExecutable start
if ($LASTEXITCODE -ne 0) {
  throw 'Windows service failed to start.'
}

Write-Host 'Tender Agent installed successfully.'
Write-Host "Agent ID: $AgentId"
Write-Host "Upload folder: $watchedRoot"
Write-Host "Logs: $(Join-Path $dataRoot 'logs')"
