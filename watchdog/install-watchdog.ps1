# Registers the watchdog as a per-user scheduled task (no admin).
# Uses wscript.exe + run-watchdog.vbs so no console window ever flashes.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$taskName = 'DSH-SplashPatch-Watchdog'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$vbs = Join-Path $repo 'watchdog\run-watchdog.vbs'
$user = "$env:USERDOMAIN\$env:USERNAME"
if (-not (Test-Path $vbs)) { throw "run-watchdog.vbs not found: $vbs" }
$action = New-ScheduledTaskAction -Execute $wscript -Argument "`"$vbs`""
try {
  $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
  $triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($triggerLogon, $triggerRepeat) -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "registered task: $taskName (wscript shim, no console flash)"
} catch {
  Write-Warning "Register-ScheduledTask failed ($($_.Exception.Message)); falling back to schtasks"
  & schtasks /Create /F /TN "$taskName" /TR "`"$wscript`" `"$vbs`"" /SC MINUTE /MO 5 | Out-Null
  & schtasks /Create /F /TN "$taskName-AtLogon" /TR "`"$wscript`" `"$vbs`"" /SC ONLOGON | Out-Null
  Write-Host 'registered via schtasks'
}
Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Write-Host 'ran one check now'