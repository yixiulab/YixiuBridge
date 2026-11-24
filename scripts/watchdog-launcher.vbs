' YixiuBridge watchdog launcher (v0.4.20).
' Runs watchdog.ps1 with NO console window at all. wscript.exe is a
' GUI-subsystem host: it never creates a console, and Run(..., 0)
' starts the child hidden from birth. That is the bulletproof fix for
' the desktop flash: powershell.exe -WindowStyle Hidden (v0.4.19)
' still lets conhost / Windows Terminal flash a window briefly on
' some Windows 11 machines, because the console host creates the
' window before PowerShell hides it. With wscript there is no
' console host at all, so nothing can flash.
' Pure ASCII on purpose - same rule as watchdog.ps1: a script with
' Chinese text is misread as ANSI by Windows PowerShell 5.1.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
ps = dir & "\watchdog.ps1"
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps & """", 0, False
