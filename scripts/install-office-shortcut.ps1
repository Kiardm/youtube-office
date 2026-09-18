param(
  [Parameter(Mandatory = $true)][string]$ElectronPath,
  [Parameter(Mandatory = $true)][string]$EntryPoint,
  [Parameter(Mandatory = $true)][string]$IconPath
)

$desktopPath = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktopPath)) { exit 0 }
$shortcutPath = Join-Path $desktopPath 'YouTube Office 4.1.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $ElectronPath
$shortcut.Arguments = '"' + $EntryPoint + '"'
$shortcut.WorkingDirectory = Split-Path $EntryPoint -Parent
$shortcut.IconLocation = $IconPath
$shortcut.Description = 'Open YouTube Office 4.1'
$shortcut.Save()

$previousShortcut = Join-Path $desktopPath 'YouTube Office 3.0.lnk'
if (Test-Path -LiteralPath $previousShortcut) { Remove-Item -LiteralPath $previousShortcut -Force }

$legacyShortcut = Join-Path $desktopPath 'YouTube Agent Office.lnk'
if ((Test-Path -LiteralPath $legacyShortcut) -and ($legacyShortcut -ne $shortcutPath)) {
  Remove-Item -LiteralPath $legacyShortcut -Force
}
