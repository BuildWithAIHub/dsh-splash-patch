# Points the existing DeepSeek Harness shortcuts at the launcher.
# Originals are backed up next to each shortcut as "<name>.lnk.dsh-patch-backup".
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'common\config.ps1')
$config = Get-DshConfig -RepoRoot $repo
$exe = Get-DshExePath $config
$launcher = Join-Path $repo 'launch\launch-dsh.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$changedFile = Join-Path $repo 'state\shortcuts-changed.json'
$changed = @()

if (-not (Test-Path $launcher)) { throw "launcher not found: $launcher" }
if (-not (Test-Path $exe)) { throw "DSH executable not found: $exe" }

$roots = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

$shell = New-Object -ComObject WScript.Shell
foreach ($root in $roots) {
  foreach ($link in (Get-ChildItem $root -Recurse -File -Filter *.lnk -ErrorAction SilentlyContinue)) {
    try {
      $shortcut = $shell.CreateShortcut($link.FullName)
      if (-not $shortcut.TargetPath) { continue }
      if ([IO.Path]::GetFileName($shortcut.TargetPath) -ne [IO.Path]::GetFileName($exe)) { continue }
      $backup = $link.FullName + '.dsh-patch-backup'
      if (-not (Test-Path $backup)) { Copy-Item $link.FullName $backup -Force }
      $shortcut.TargetPath = $wscript
      $shortcut.Arguments = '"' + $launcher + '"'
      $shortcut.WorkingDirectory = Split-Path -Parent $exe
      $shortcut.IconLocation = '"' + $exe + '",0'
      $shortcut.Save()
      $changed += [pscustomobject]@{ shortcut = $link.FullName; backup = $backup; created = $false }
      Write-Host "retargeted: $($link.FullName)"
    } catch {
      Write-Warning "skipped $($link.FullName): $($_.Exception.Message)"
    }
  }
}

if ($changed.Count -eq 0) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) {
    $new = Join-Path $desktop 'DeepSeek Harness (splash).lnk'
    $shortcut = $shell.CreateShortcut($new)
    $shortcut.TargetPath = $wscript
    $shortcut.Arguments = '"' + $launcher + '"'
    $shortcut.WorkingDirectory = Split-Path -Parent $exe
    $shortcut.IconLocation = '"' + $exe + '",0'
    $shortcut.Description = 'DeepSeek Harness with boot splash'
    $shortcut.Save()
    $changed += [pscustomobject]@{ shortcut = $new; backup = ''; created = $true }
    Write-Host "created: $new"
  }
}

$changed | ConvertTo-Json | Set-Content -Path $changedFile -Encoding UTF8
Write-Host "done, changed $($changed.Count) shortcut(s)"