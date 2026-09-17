param(
  [Parameter(Mandatory = $true)][string]$ElectronPath,
  [Parameter(Mandatory = $true)][string]$EntryPoint,
  [Parameter(Mandatory = $true)][string]$IconPath
)

$desktopPath = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktopPath)) { exit 0 }
$shortcutPath = Join-Path $desktopPath 'YouTube Agent Office.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $ElectronPath
$shortcut.Arguments = '"' + $EntryPoint + '"'
$shortcut.WorkingDirectory = Split-Path $EntryPoint -Parent
$shortcut.IconLocation = $IconPath
$shortcut.Description = 'Open the interactive YouTube production office'
$shortcut.Save()
