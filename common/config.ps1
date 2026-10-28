# Shared helpers for the dsh-splash-patch scripts. ASCII only, Windows PowerShell 5.1 compatible.

function Get-DshRepoRoot {
  param([string]$ScriptDir)
  if ([string]::IsNullOrWhiteSpace($ScriptDir)) { $ScriptDir = $PSScriptRoot }
  return (Split-Path -Parent $ScriptDir)
}

function Get-DshConfig {
  param([string]$RepoRoot)
  $configPath = Join-Path $RepoRoot 'config.json'
  if (-not (Test-Path $configPath)) {
    throw "config.json not found at $configPath. Run setup\install.ps1 first."
  }
  return (Get-Content $configPath -Raw | ConvertFrom-Json)
}

function Get-DshExePath {
  param($Config)
  return [string]$Config.exe
}

function Get-DshAsarPath {
  param($Config)
  return [string]$Config.asar
}

function Resolve-DshNode {
  param($Config)
  $candidates = @()
  if ($Config -ne $null -and $Config.node) { $candidates += [string]$Config.node }
  $candidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
  $candidates += 'C:\Program Files\nodejs\node.exe'
  $candidates += 'C:\Program Files (x86)\nodejs\node.exe'
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($found) { $candidates += $found.Source }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return ''
}

function Test-DshRunning {
  return [bool](Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
}

function Invoke-DshPatcher {
  param([string]$RepoRoot, [string]$NodePath, [bool]$Quiet = $true)
  $patcher = Join-Path $RepoRoot 'patcher\apply-patch.mjs'
  if (-not (Test-Path $patcher)) { return 3 }
  if (-not $NodePath) { return 4 }
  if ($Quiet) {
    & $NodePath $patcher --quiet
  } else {
    & $NodePath $patcher
  }
  return $LASTEXITCODE
}