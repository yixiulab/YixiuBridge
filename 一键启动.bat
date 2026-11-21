@echo off
rem YixiuBridge one-click update & start (Windows).
rem Copies update-and-start.ps1 to %TEMP% and runs it from there, so the
rem update can overwrite the install folder without touching the running
rem script itself. The .bat exits right after launching PowerShell, so the
rem .bat file itself can also be safely overwritten by the update.
chcp 65001 >nul
set "INSTALL_DIR=%~dp0"
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"
set "PS1=%TEMP%\YixiuBridge-update-and-start.ps1"
copy /Y "%INSTALL_DIR%\scripts\update-and-start.ps1" "%PS1%" >nul
if not exist "%PS1%" (
  echo Cannot find scripts\update-and-start.ps1 in %INSTALL_DIR%
  echo Please re-download the YixiuBridge ZIP and extract it first.
  pause
  exit /b 1
)
start "YixiuBridge" powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -InstallDir "%INSTALL_DIR%"
