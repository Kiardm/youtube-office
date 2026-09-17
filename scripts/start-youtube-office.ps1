$ErrorActionPreference = 'Stop'
$OfficeRoot = Split-Path -Parent $PSScriptRoot
$Pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $Pnpm) {
  throw 'pnpm was not found. Install Node.js and run: corepack enable'
}

Set-Location -LiteralPath $OfficeRoot
& $Pnpm.Source office
