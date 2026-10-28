# Watchdog body: repair the splash patch after a DSH update.
# Runs hidden from Task Scheduler (at logon + every 5 minutes).
$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'common\config.ps1')
$log = Join-Path $repo 'state\watchdog.log'
$configPath = Join-Path $repo 'config.json'
if (-not (Test-Path $configPath)) { exit 0 }
$config = Get-DshConfig -RepoRoot $repo
$asar = Get-DshAsarPath $config
if ((-not $asar) -or (-not (Test-Path $asar))) { exit 0 }
if (Test-DshRunning) {
  Add-Content -Path $log -Value ("[{0}] DSH is running; skipping" -f (Get-Date -Format s))
  exit 0
}
$node = Resolve-DshNode -Config $config
if (-not $node) {
  Add-Content -Path $log -Value ("[{0}] node.exe not found" -f (Get-Date -Format s))
  exit 0
}
$code = Invoke-DshPatcher -RepoRoot $repo -NodePath $node
if ($code -ne 0) {
  Add-Content -Path $log -Value ("[{0}] patch exit {1}" -f (Get-Date -Format s), $code)
  if ($code -eq 2) {
    Copy-Item (Join-Path $repo 'state\status.json') (Join-Path $repo 'state\PATCH-UNSUPPORTED.txt') -Force
  }
}
exit 0