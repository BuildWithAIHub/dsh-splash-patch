# Registers the watchdog as a per-user scheduled task: at logon + every 5 minutes.
# No administrator rights are needed.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$taskName = 'DSH-SplashPatch-Watchdog'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script = Join-Path $repo 'watchdog\run-watchdog.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
try {
  $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
  $triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($triggerLogon, $triggerRepeat) -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "registered task: $taskName"
} catch {
  Write-Warning "Register-ScheduledTask failed ($($_.Exception.Message)); falling back to schtasks"
  & schtasks /Create /F /TN "$taskName" /TR "`"$ps`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" /SC MINUTE /MO 5 | Out-Null
  & schtasks /Create /F /TN "$taskName-AtLogon" /TR "`"$ps`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" /SC ONLOGON | Out-Null
  Write-Host 'registered via schtasks'
}
Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Write-Host 'ran one check now'