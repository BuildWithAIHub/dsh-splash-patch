' Silent launcher for the splash-patch watchdog.
' wscript.exe has no console window, and WScript.Shell.Run with window style 0
' starts PowerShell with SW_HIDE from the very beginning - so Task Scheduler
' never flashes a console window (the old "powershell.exe -WindowStyle Hidden"
' action still flashed conhost for ~250 ms).
Option Explicit
Dim shell, fso, here, ps1
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\run-watchdog.ps1"
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, True
