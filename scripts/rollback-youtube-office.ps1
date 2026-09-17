param([Parameter(Mandatory=$true)][string]$Backup,[string]$DataDir = (Join-Path $env:LOCALAPPDATA 'YouTube Office\data'))
$ErrorActionPreference = 'Stop'
$OfficeRoot = Split-Path -Parent $PSScriptRoot
$resolvedBackup = (Resolve-Path -LiteralPath $Backup).Path
$resolvedData = [IO.Path]::GetFullPath($DataDir)
if (-not $resolvedBackup.EndsWith('.yobak', [StringComparison]::OrdinalIgnoreCase)) { throw 'Rollback requires a .yobak profile backup.' }
$stage = Join-Path $env:TEMP ("youtube-office-rollback-" + [guid]::NewGuid().ToString('N'))
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $OfficeRoot 'scripts\restore-backup.ps1') -Backup $resolvedBackup -Destination $stage
  if (-not (Test-Path -LiteralPath (Join-Path $stage 'office-state.json'))) { throw 'Backup verification failed: office-state.json is missing.' }
  New-Item -ItemType Directory -Force -Path $resolvedData | Out-Null
  Get-ChildItem -LiteralPath $stage -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $resolvedData $_.Name) -Force }
  Write-Host 'Profile rollback restored. Restart YouTube Office.'
} finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
