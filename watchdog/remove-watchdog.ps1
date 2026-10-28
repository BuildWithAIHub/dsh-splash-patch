# Removes the watchdog scheduled task(s). The patch already applied stays.
$taskName = 'DSH-SplashPatch-Watchdog'
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "$taskName-AtLogon" -Confirm:$false -ErrorAction SilentlyContinue
& schtasks /Delete /F /TN $taskName 2>$null | Out-Null
& schtasks /Delete /F /TN "$taskName-AtLogon" 2>$null | Out-Null
Write-Host "removed task: $taskName"