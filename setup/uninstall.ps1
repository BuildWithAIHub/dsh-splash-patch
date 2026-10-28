# Removes the watchdog task and restores the original shortcuts.
# The already-applied app.asar patch stays unless -RestoreAsar is given.
param([switch]$RestoreAsar)
$repo = Split-Path -Parent $PSScriptRoot
& (Join-Path $repo 'watchdog\remove-watchdog.ps1')
& (Join-Path $repo 'shortcuts\restore-shortcuts.ps1')
if ($RestoreAsar) {
  $backup = Join-Path $repo 'state\app.asar.unpatched.bak'
  . (Join-Path $repo 'common\config.ps1')
  $config = Get-DshConfig -RepoRoot $repo
  $asar = Get-DshAsarPath $config
  if ((Test-Path $backup) -and (Test-Path $asar)) {
    Copy-Item $backup $asar -Force
    Write-Host "restored app.asar from $backup"
  } else {
    Write-Warning 'no unpatched backup found; app.asar left as is'
  }
}
Write-Host 'uninstalled (config.json and state\ are left in place; delete this folder to remove them)'