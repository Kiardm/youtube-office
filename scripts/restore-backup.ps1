param([Parameter(Mandatory=$true)][string]$Backup,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$temp = Join-Path ([IO.Path]::GetTempPath()) ("youtube-office-restore-" + [guid]::NewGuid().ToString('N') + '.zip')
try {
  $protected = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Backup).Path)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, [Text.Encoding]::UTF8.GetBytes('YouTube Office profile backup v1'), [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes($temp, $plain)
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Expand-Archive -LiteralPath $temp -DestinationPath $Destination -Force
} finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
