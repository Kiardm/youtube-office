param(
  [string]$ContentRoot = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'YouTube Office\content-workspace'),
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'YouTube Office\data'),
  [switch]$SkipDependencyInstall,
  [switch]$SkipBuild,
  [switch]$SkipShortcut
)

$ErrorActionPreference = 'Stop'
$OfficeRoot = Split-Path -Parent $PSScriptRoot
$ConfigDir = Join-Path $env:APPDATA 'YouTube Office'
$ConfigFile = Join-Path $ConfigDir 'config.json'
$BaselinePrompt = Join-Path $OfficeRoot 'youtube-office\prompts\master-prompt-baseline.md'
$MasterPrompt = Join-Path $ContentRoot 'MASTER_PROMPT.md'
$RulesFile = Join-Path $ContentRoot 'content-ops\user-approved-rules.json'

foreach ($required in @('git', 'node')) {
  if (-not (Get-Command $required -ErrorAction SilentlyContinue)) {
    throw "$required is required but was not found in PATH."
  }
}

$Pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $Pnpm) {
  $Corepack = Get-Command corepack -ErrorAction SilentlyContinue
  if (-not $Corepack) { throw 'pnpm is required. Install current Node.js, then run: corepack enable' }
  & $Corepack.Source enable
  $Pnpm = Get-Command pnpm -ErrorAction Stop
}

New-Item -ItemType Directory -Force -Path $ConfigDir, $ContentRoot, $DataDir, (Split-Path $RulesFile -Parent) | Out-Null
if (-not (Test-Path -LiteralPath $MasterPrompt)) {
  Copy-Item -LiteralPath $BaselinePrompt -Destination $MasterPrompt
}
if (-not (Test-Path -LiteralPath $RulesFile)) {
  Set-Content -LiteralPath $RulesFile -Encoding UTF8 -Value "{`n  `"version`": 1,`n  `"rules`": []`n}"
}
if (-not (Test-Path -LiteralPath (Join-Path $ContentRoot '.git'))) {
  & git -C $ContentRoot init | Out-Null
}

@{
  version = 1
  contentRoot = [IO.Path]::GetFullPath($ContentRoot)
  dataDir = [IO.Path]::GetFullPath($DataDir)
} | ConvertTo-Json | Set-Content -LiteralPath $ConfigFile -Encoding UTF8

Set-Location -LiteralPath $OfficeRoot
if (-not $SkipDependencyInstall) { & $Pnpm.Source install --frozen-lockfile }
if (-not $SkipBuild) { & $Pnpm.Source build }

$ElectronPath = Join-Path $OfficeRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $ElectronPath)) { throw 'Electron was not installed successfully.' }
if (-not $SkipShortcut) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $OfficeRoot 'scripts\install-office-shortcut.ps1') -ElectronPath $ElectronPath -EntryPoint (Join-Path $OfficeRoot 'electron\main.cjs') -IconPath (Join-Path $OfficeRoot 'icon.png')
}

Write-Host 'YouTube Office 3.2.3 is installed.'
Write-Host "Private content workspace: $ContentRoot"
Write-Host "Private application data: $DataDir"
Write-Host 'Open it from the YouTube Office 3.2 desktop shortcut.'
