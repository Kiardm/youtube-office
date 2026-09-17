$ErrorActionPreference = 'Stop'
$OfficeRoot = 'C:\Users\Owner\Documents\Codex\youtube-agent-office'
$Pnpm = 'C:\Users\Owner\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'

Set-Location -LiteralPath $OfficeRoot
& $Pnpm office

