# Launcher: make sure the splash patch is present, then start DSH.
# Called hidden by launch-dsh.vbs (which the shortcuts point at).
$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'common\config.ps1')
$config = Get-DshConfig -RepoRoot $repo
$asar = Get-DshAsarPath $config
$exe = Get-DshExePath $config
$testOnly = ($env:DSH_LAUNCHER_TEST -eq '1')

if ((-not $asar) -or (-not (Test-Path $asar))) {
  if ((-not $testOnly) -and $exe -and (Test-Path $exe)) { Start-Process -FilePath $exe }
  Write-Output 'asar missing; started DSH without patch check'
  exit 0
}

# Never rewrite app.asar underneath a live DSH process.
if (-not (Test-DshRunning)) {
  $node = Resolve-DshNode -Config $config
  if ($node) {
    $code = Invoke-DshPatcher -RepoRoot $repo -NodePath $node
    if ($code -ne 0) { Write-Output "patcher exit $code" }
  } else {
    Write-Output 'node.exe not found; skipped patch check'
  }
}

if ($testOnly) {
  Write-Output 'launcher test ok'
  exit 0
}
if ($exe -and (Test-Path $exe)) { Start-Process -FilePath $exe }
exit 0