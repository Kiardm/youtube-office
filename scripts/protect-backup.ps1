param([Parameter(Mandatory=$true)][string]$SourceDir,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$resolved = (Resolve-Path -LiteralPath $SourceDir).Path
$temp = Join-Path ([IO.Path]::GetTempPath()) ("youtube-office-" + [guid]::NewGuid().ToString('N') + '.zip')
try {
  $files = @(Get-ChildItem -LiteralPath $resolved -File)
  if ($files.Count -eq 0) { throw 'Backup source contains no files.' }
  Compress-Archive -LiteralPath $files.FullName -DestinationPath $temp -Force
  $plain = [IO.File]::ReadAllBytes($temp)
  $protected = [Security.Cryptography.ProtectedData]::Protect($plain, [Text.Encoding]::UTF8.GetBytes('YouTube Office profile backup v1'), [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes([IO.Path]::GetFullPath($Destination), $protected)
} finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
