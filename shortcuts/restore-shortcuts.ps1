# Restores the shortcuts changed by install-shortcuts.ps1.
$changedFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'state\shortcuts-changed.json'
if (-not (Test-Path $changedFile)) { Write-Host 'nothing to restore'; exit 0 }
$changed = Get-Content $changedFile -Raw | ConvertFrom-Json
foreach ($entry in $changed) {
  if ($entry.created -eq $true) {
    Remove-Item $entry.shortcut -Force -ErrorAction SilentlyContinue
    Write-Host "removed: $($entry.shortcut)"
    continue
  }
  if ($entry.backup -and (Test-Path $entry.backup)) {
    Copy-Item $entry.backup $entry.shortcut -Force
    Write-Host "restored: $($entry.shortcut)"
  }
}
Write-Host 'done'