param([switch]$Install,[string]$ReleaseRef = 'origin/main')
$ErrorActionPreference = 'Stop'
$OfficeRoot = Split-Path -Parent $PSScriptRoot
$session = $null
try { $session = Invoke-RestMethod -Uri 'http://127.0.0.1:3300/api/youtube-office-session' -TimeoutSec 3 } catch {}
$bridge = if ($session.token) { 'http://127.0.0.1:3310/session/' + [Uri]::EscapeDataString($session.token) } else { 'http://127.0.0.1:3310/session/browser-preview' }
$state = $null
try { $state = Invoke-RestMethod -Uri "$bridge/state" -TimeoutSec 3 } catch {}
if ($state -and $state.activeProject) { throw 'Finish or cancel the active project before updating.' }
Set-Location -LiteralPath $OfficeRoot
& git fetch origin --tags
$current = (& git rev-parse HEAD).Trim()
$target = (& git rev-parse $ReleaseRef).Trim()
if ($current -eq $target) { Write-Host 'YouTube Office is already current.'; exit 0 }
Write-Host "Update available: $current -> $target"
& git log --oneline "$current..$target"
if (-not $Install) { Write-Host 'Review the changes, then rerun with -Install. No update was installed.'; exit 0 }
try { Invoke-RestMethod -Method Post -Uri "$bridge/backups" -ContentType 'application/json' -Body '{"label":"pre-update"}' -TimeoutSec 60 | Out-Null } catch { throw "Could not create the required encrypted pre-update backup: $($_.Exception.Message)" }
$worktree = Join-Path $env:TEMP ("youtube-office-update-" + [guid]::NewGuid().ToString('N'))
& git worktree add --detach $worktree $target | Out-Null
try {
  Set-Location -LiteralPath $worktree
  & pnpm install --frozen-lockfile
  & pnpm check-types
  & pnpm office:test
  & pnpm office:audit-distribution
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw 'Update verification failed; the current installation was not changed.' }
  Set-Location -LiteralPath $OfficeRoot
  & git merge --ff-only $target
  & pnpm install --frozen-lockfile
  & pnpm build
  Write-Host 'Update installed. Restart YouTube Office to load it.'
} finally {
  Set-Location -LiteralPath $OfficeRoot
  & git worktree remove --force $worktree 2>$null
}
