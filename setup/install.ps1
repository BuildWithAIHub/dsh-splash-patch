# One-shot installer:
#   1. locates the installed DeepSeek Harness,
#   2. writes config.json,
#   3. runs the patch once,
#   4. registers the watchdog task and retargets the shortcuts.
# No administrator rights are required.
param(
  [string]$Exe = '',
  [switch]$SkipShortcuts
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'common\config.ps1')

function Find-DshExe {
  # 1. a running instance knows its own path
  $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
  if ($proc) { return $proc.Path }
  # 2. existing shortcuts (desktop / start menu / taskbar)
  $shell = New-Object -ComObject WScript.Shell
  $roots = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
  foreach ($root in $roots) {
    foreach ($link in (Get-ChildItem $root -Recurse -File -Filter *.lnk -ErrorAction SilentlyContinue)) {
      try {
        $shortcut = $shell.CreateShortcut($link.FullName)
        if ([IO.Path]::GetFileName($shortcut.TargetPath) -eq 'DeepSeek Harness.exe' -and (Test-Path $shortcut.TargetPath)) {
          return $shortcut.TargetPath
        }
      } catch { }
    }
  }
  # 3. common install locations
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe',
    'C:\Program Files (x86)\DeepSeek Harness\DeepSeek Harness.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return ''
}

if (-not $Exe) { $Exe = Find-DshExe }
if (-not $Exe -or -not (Test-Path $Exe)) {
  throw "DeepSeek Harness not found. Pass -Exe <full path to DeepSeek Harness.exe>."
}
$asar = Join-Path (Split-Path -Parent $Exe) 'resources\app.asar'
if (-not (Test-Path $asar)) { throw "app.asar not found next to the executable: $asar" }

$node = Resolve-DshNode -Config $null
$config = [ordered]@{ exe = $Exe; asar = $asar; node = $(if ($node) { $node } else { $null }) }
$config | ConvertTo-Json | Set-Content -Path (Join-Path $repo 'config.json') -Encoding UTF8
Write-Host "config written: exe=$Exe"
Write-Host "                asar=$asar"

if ($node) {
  Write-Host 'running the patcher once...'
  $code = Invoke-DshPatcher -RepoRoot $repo -NodePath $node -Quiet $false
  Write-Host "patcher exit code: $code"
} else {
  Write-Warning 'node.exe not found; the patch was not applied. Install Node.js or run DSH once so its bundled runtime exists.'
}

& (Join-Path $repo 'watchdog\install-watchdog.ps1')
if (-not $SkipShortcuts) { & (Join-Path $repo 'shortcuts\install-shortcuts.ps1') }

Write-Host ''
Write-Host 'Done. Start DSH from the desktop/start-menu shortcut: the splash plays while DSH boots.'
Write-Host 'Uninstall: setup\uninstall.ps1'