# YixiuBridge runner watchdog (v0.4.16).
#
# Pure ASCII on purpose: the test-PC script saga (2026-11-22) proved that
# a PowerShell script with Chinese text is misread as ANSI by Windows
# PowerShell 5.1 and dies with cascading parse errors. This file must
# stay ASCII-only - no Chinese, no smart quotes, no em-dashes.
#
# What it does:
#   * Check mode (default, run by the scheduled task every 3 minutes):
#     the runner refreshes its heartbeat file every 30s, so a heartbeat
#     older than 3 minutes means the runner is hung or dead. In that
#     case stop the hung node runner (only when its command line proves
#     it IS muse-runner - never kill an unrelated node process) and
#     start a fresh runner, minimized. Actions are logged to
#     ~/.yixiubridge/muse-watchdog.log; quiet checks log nothing.
#   * Register mode (-Register): create/overwrite the Windows Scheduled
#     Task "YixiuBridgeWatchdog" (every 3 minutes, 365 days). Idempotent:
#     Register-ScheduledTask -Force overwrites the existing task, so
#     calling it on every runner start and every .bat run is safe.
#     Always exits 0 - registration is best-effort and must never break
#     the caller. (v0.4.20: the task action runs wscript.exe with
#     scripts/watchdog-launcher.vbs, which starts PowerShell with no
#     console window at all - powershell.exe -WindowStyle Hidden
#     (v0.4.19) still let conhost / Windows Terminal flash a window
#     briefly on some Windows 11 machines, because the console host
#     creates the window before PowerShell hides it. With wscript
#     there is no console host, so nothing can flash.)
#
# Why a watchdog at all: teacher-005 (2026-11-22) sat unclaimed for
# ~7 minutes because the runner had stopped processing after an update
# restart; nothing restarted it until the user double-clicked .bat.
# The runner's own stale-lock takeover only helps when a NEW runner
# starts - this task makes sure one does.
param(
    [switch]$Register
)

$ErrorActionPreference = 'Stop'
$TaskName = 'YixiuBridgeWatchdog'
$HeartbeatStaleSeconds = 180
$DataDir = Join-Path $env:USERPROFILE '.yixiubridge'
$HeartbeatFile = Join-Path $DataDir 'muse-runner.heartbeat'
$LockFile = Join-Path $DataDir 'muse-runner.lock'
$ConfigFile = Join-Path $DataDir 'config.json'
$WatchdogLog = Join-Path $DataDir 'muse-watchdog.log'
$InstallDir = Split-Path -Parent $PSScriptRoot
$RunnerScript = Join-Path $InstallDir 'host\muse-runner.mjs'

function Write-WatchdogLog([string]$Message) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message
    try { Add-Content -Path $WatchdogLog -Value $line -Encoding UTF8 } catch { }
}

if ($Register) {
    try {
        $launcherPath = Join-Path $PSScriptRoot 'watchdog-launcher.vbs'
        $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $launcherPath + '"')
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 3) -RepetitionDuration (New-TimeSpan -Days 365)
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
        Write-Host 'YixiuBridge watchdog registered (every 3 minutes).'
    } catch {
        Write-Warning ('Watchdog registration failed: ' + $_.Exception.Message)
    }
    exit 0
}

# No config yet (bridge never set up): nothing to watch - exit quietly
# instead of restarting a runner that would die at once, every 3 min.
if (-not (Test-Path $ConfigFile)) { exit 0 }

# Heartbeat fresh (<3 min) means the runner is alive - nothing to do.
$heartbeatFresh = $false
try {
    $hb = Get-Item $HeartbeatFile -ErrorAction Stop
    if (((Get-Date) - $hb.LastWriteTime).TotalSeconds -lt $HeartbeatStaleSeconds) { $heartbeatFresh = $true }
} catch { }
if ($heartbeatFresh) { exit 0 }

# Heartbeat stale or missing: is a runner process actually alive?
$runnerPid = $null
try {
    $lockText = (Get-Content $LockFile -ErrorAction Stop | Select-Object -First 1).Trim()
    [int]$runnerPid = $lockText
} catch { }
$runnerAlive = $false
if ($runnerPid) {
    $cmdline = $null
    try { $cmdline = (Get-CimInstance Win32_Process -Filter ("ProcessId = " + $runnerPid) -ErrorAction Stop).CommandLine } catch { }
    if ($cmdline -and $cmdline -match 'muse-runner') {
        $runnerAlive = $true
    } elseif (-not $cmdline) {
        # CIM unavailable: fall back to the process-name check.
        $proc = Get-Process -Id $runnerPid -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -eq 'node') { $runnerAlive = $true }
    }
}
if ($runnerAlive) {
    # A live node runner with a stale heartbeat is hung: a healthy
    # runner refreshes its heartbeat every 30s even during a 15-minute
    # ask (its event loop stays free), so stale > 3 min genuinely means
    # wedged. Stop it, then start fresh.
    try { Stop-Process -Id $runnerPid -Force -ErrorAction Stop; Start-Sleep -Seconds 10 } catch { }
    Write-WatchdogLog ("runner pid " + $runnerPid + " hung (heartbeat stale) - stopped it")
}

# Start a fresh runner, hidden, detached (same shape as
# update-and-start.ps1 step 6, but Hidden not Minimized: this restart
# happens silently in the background, and a minimized console still
# puts a taskbar button up - Hidden leaves no trace on the desktop).
# If a hung runner is still around, the new runner's stale-lock
# takeover + idempotency guard make it safe.
try {
    Start-Process -FilePath 'node' -ArgumentList @($RunnerScript) -WindowStyle Hidden -WorkingDirectory $InstallDir | Out-Null
    Write-WatchdogLog 'runner restarted (heartbeat stale or missing)'
} catch {
    Write-WatchdogLog ('runner restart failed: ' + $_.Exception.Message)
}
exit 0
