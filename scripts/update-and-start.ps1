# YixiuBridge 一键更新与启动（Windows）
# 双击仓库根目录的 一键启动.bat 运行本脚本。本脚本会被复制到 %TEMP% 后执行，
# 这样解压覆盖安装目录时不会动到正在运行的脚本自身。
# 流程：检查 node → 读令牌 → 下载最新版覆盖 → 打包插件 → 重启桥 → 启动 runner
# → 打开装了插件的那个 Chrome 身份到 Gemini。
# 令牌只从本机 $env:USERPROFILE\.yixiubridge\config.json 读取，只发给
# codeload.github.com，绝不打印。
# 多 Chrome 身份：只动装了 YixiuBridge 扩展的那一个身份，绝不写死路径。
# 每次运行时动态发现：先找 chrome.exe（注册表 App Paths、Get-Command、
# 标准路径，正式版/Beta/Canary 都查），再扫各身份的 Secure Preferences
# 按扩展 ID 定位身份目录名。多个身份都装了插件时，优先选已有进程在运行
# 的那个；都没在运行就选 Preferences 最近修改的那个；上次选中的身份只
# 存 config.json 当平局参考，每次都重新扫描、以新结果为准。定位不到就
# 不打开任何浏览器，只更新代码和服务。绝不杀 chrome.exe、不关任何窗口。
param(
[string]$InstallDir = ""
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 > $null} catch {}

$EXTENSION_ID = 'alcjfcjfkfhfacgofhgoenljfenbcgcel'
$BRIDGE_PORT = 8765
$REPO = 'yixiulab/YixiuBridge'

function Step($n, $text) { Write-Host "$text"}
function Info($text) { Write-Host " $text"}
function Warn($text) { Write-Host " 注意：$text"}

try {
# 安装目录：由 一键启动.bat 传入；没传就用脚本所在目录。
if (-not $InstallDir) {
$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$InstallDir = $InstallDir.TrimEnd('\')
if (-not (Test-Path (Join-Path $InstallDir 'package.json'))) {
throw "找不到安装目录：$InstallDir（里面没有 package.json）。请确认 一键启动.bat 在仓库根目录。"
}
Set-Location $InstallDir

# 1. Node.js
Step 1 '检查 Node.js...'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
throw '未找到 node。请先安装 Node.js（https://nodejs.org，装 LTS 版），装好后再双击 一键启动.bat。'
}
Info "Node 已安装：$(node --version)"

# 2. 令牌
Step 2 '读取 GitHub 令牌...'
$token = $null
$configPath = Join-Path $env:USERPROFILE '.yixiubridge\config.json'
if (Test-Path $configPath) {
try {
$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
if ($cfg.github_token) { $token = [string]$cfg.github_token}
} catch { $token = $null}
}
if (-not $token) {
Info '没有找到令牌，跳过更新，只启动服务。想自动更新请先运行一次 node bin/yixiubridge.mjs github-token 粘贴令牌。'
}

# 3. 下载最新版并覆盖
if ($token) {
Step 3 '下载最新版...'
$zipPath = Join-Path $env:TEMP 'YixiuBridge-latest.zip'
$extractDir = Join-Path $env:TEMP 'YixiuBridge-update'
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force}
$headers = @{ Authorization = "token $token"}
$downloaded = $true
try {
Invoke-WebRequest -Uri "https://codeload.github.com/$REPO/zip/refs/heads/main" -Headers $headers -OutFile $zipPath -UseBasicParsing
} catch {
Write-Host "下载失败：$($_.Exception.Message)"
Write-Host '只启动现有服务，不更新。网络恢复后可以再双击一次。'
$downloaded = $false
}
if ($downloaded) {
Info '解压并覆盖安装目录...'
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
$srcDir = Join-Path $extractDir 'YixiuBridge-main'
if (-not (Test-Path $srcDir)) { throw '解压后的文件里没有 YixiuBridge-main 目录，更新中止。'}
Get-ChildItem -Path $srcDir -Force | Copy-Item -Destination $InstallDir -Recurse -Force
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
Info '更新完成。'
}
}

# 4. 打包插件
Step 4 '打包插件...'
node scripts/package-extension.mjs
if ($LASTEXITCODE -ne 0) { throw '打包插件失败（package-extension.mjs 报错），请看上面的输出。'}
Info '打包完成。'

# 5. 重启桥
Step 5 '重启桥服务...'
$skipBridge = $false
$conn = Get-NetTCPConnection -LocalPort $BRIDGE_PORT -State Listen -ErrorAction SilentlyContinue
if ($conn) {
Info '8765 端口已有旧桥在跑，先停掉它...'
foreach ($c in $conn) {
$proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
if ($proc -and $proc.ProcessName -eq 'node') {
Stop-Process -Id $proc.Id -Force
Info "已停掉旧桥进程（PID $($proc.Id)）。"
} else {
Warn "8765 端口被非 Node 进程占用（PID $($c.OwningProcess)），不停它。本次不启动新桥，请手动处理后重新双击。"
$skipBridge = $true
}
}
if (-not $skipBridge) { Start-Sleep -Seconds 1}
}
if (-not $skipBridge) {
Start-Process -FilePath 'node' -ArgumentList 'bin/yixiubridge.mjs','bridge' -WorkingDirectory $InstallDir -WindowStyle Minimized
Start-Sleep -Seconds 2
try {
$st = Invoke-RestMethod -Uri "http://127.0.0.1:$BRIDGE_PORT/status" -TimeoutSec 5
Info "桥已启动（运行版本 $($st.version)，磁盘版本 $($st.disk_version)）。"
} catch {
Warn '桥已启动但 /status 还没响应，稍等片刻再看。'
}
}

# 6. 启动 runner
Step 6 '启动 runner...'
$lockPath = Join-Path $env:USERPROFILE '.yixiubridge\muse-runner.lock'
$runnerRunning = $false
if (Test-Path $lockPath) {
$lockPid = (Get-Content $lockPath -Raw -ErrorAction SilentlyContinue).Trim()
if ($lockPid -match '^\d+$') {
$p = Get-Process -Id ([int]$lockPid) -ErrorAction SilentlyContinue
if ($p) { $runnerRunning = $true}
}
}
if ($runnerRunning) {
Info 'runner 已在运行，跳过。'
} else {
Start-Process -FilePath 'node' -ArgumentList 'bin/yixiubridge.mjs','runner' -WorkingDirectory $InstallDir -WindowStyle Minimized
Info 'runner 已启动（最小化窗口）。'
}

# 7. 打开装了插件的 Chrome 身份到 Gemini。绝不无条件打开默认 Chrome：
# 用户有多个 Chrome 身份，Gemini 和插件只在其中一个上。先按扩展 ID
# 扫描各身份的 Secure Preferences 定位身份目录名，再用
# --profile-directory 只开那一个身份；已在运行就不重复开。
# 定位不到就不开任何浏览器，只完成上面的更新和启动。
Step 7 '定位装了插件的 Chrome 身份...'
# 硬要求：(1) 绝不写死路径——每次动态发现 chrome.exe（注册表 App Paths、
# Get-Command、标准路径：正式版/Beta/Canary 都查），再按扩展 ID 扫各身份
# 的 Secure Preferences 定位身份目录名；(2) 只开那一个，绝不影响正在运
# 行的别的浏览器——不杀 chrome.exe、不关任何窗口，用 --profile-directory
# 只开匹配身份，已在运行就把标签页交给已有实例；(3) 多个身份都装了插件
# 时优先选已有进程在运行的那个，都没在运行就选 Preferences 最近修改的
# 那个，选了哪个、为什么都写出来；上次选中的身份目录存在 config.json
# 里（last_chrome_profile），只做平局参考，每次都重新扫描、以新结果为
# 准；(4) 定位不到就不开任何浏览器，只完成上面的更新和启动。

# 按 chrome.exe 路径推断它用的 User Data 目录（正式版/Beta/Canary）。
function Get-UserDataDirForChrome($exePath) {
  if ($exePath -match 'Chrome Beta') { return (Join-Path $env:LOCALAPPDATA 'Google\Chrome Beta\User Data') }
  if ($exePath -match 'Chrome SxS') { return (Join-Path $env:LOCALAPPDATA 'Google\Chrome SxS\User Data') }
  return (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')
}

# 收集 chrome.exe 候选路径：注册表 → Get-Command → 各通道标准路径。
$exeCandidates = @()
foreach ($regPath in @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe')) {
  try {
    $v = (Get-ItemProperty -Path $regPath -ErrorAction Stop).'(default)'
    if ($v) { $exeCandidates += $v }
  } catch { }
}
$cmdChrome = Get-Command chrome -ErrorAction SilentlyContinue
if ($cmdChrome -and $cmdChrome.Path) { $exeCandidates += $cmdChrome.Path }
$exeCandidates += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
$exeCandidates += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
$exeCandidates += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
$exeCandidates += (Join-Path $env:ProgramFiles 'Google\Chrome Beta\Application\chrome.exe')
$exeCandidates += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome Beta\Application\chrome.exe')
$exeCandidates += (Join-Path $env:LOCALAPPDATA 'Google\Chrome SxS\Application\chrome.exe')

# 去重并只留实际存在的；同一个 User Data 目录只扫一次。
$installs = @()
$seenExe = @{}
$seenUd = @{}
foreach ($exe in $exeCandidates) {
  if (-not $exe) { continue }
  $key = $exe.ToLower()
  if ($seenExe.ContainsKey($key)) { continue }
  $seenExe[$key] = $true
  if (-not (Test-Path $exe)) { continue }
  $ud = Get-UserDataDirForChrome $exe
  $udKey = $ud.ToLower()
  if ($seenUd.ContainsKey($udKey)) { continue }
  $seenUd[$udKey] = $true
  $installs += @{ Exe = $exe; UserData = $ud }
}

# 扫描各身份的 Secure Preferences，找含有扩展 ID 的身份。
$matches = @()
foreach ($inst in $installs) {
  if (-not (Test-Path $inst.UserData)) { continue }
  $profileDirs = Get-ChildItem -Path $inst.UserData -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'Default' -or $_.Name -match '^Profile \d+$' }
  foreach ($d in $profileDirs) {
    $prefs = Join-Path $d.FullName 'Secure Preferences'
    if (-not (Test-Path $prefs)) { continue }
    try {
      $text = Get-Content $prefs -Raw -ErrorAction Stop
    } catch { continue }
    if ($text -notmatch [regex]::Escape($EXTENSION_ID)) { continue }
    $prefFile = Join-Path $d.FullName 'Preferences'
    $mtime = $null
    if (Test-Path $prefFile) { $mtime = (Get-Item $prefFile).LastWriteTime }
    elseif (Test-Path $prefs) { $mtime = (Get-Item $prefs).LastWriteTime }
    $matches += @{ Exe = $inst.Exe; ProfileDir = $d.Name; UserData = $inst.UserData; Modified = $mtime }
  }
}

# 选择：(a) 优先选已有 chrome.exe 进程在运行的那个匹配身份；
# (b) 都没在运行就选 Preferences 最近修改的那个；
# (c) 修改时间相同（或都没有）时，参考上次选中的身份。
$chosen = $null
$chosenRunning = $false
$why = ''
if ($matches.Count -gt 0) {
  $running = @()
  try {
    $chromeProcs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop
    foreach ($m in $matches) {
      $wantFlag = '--profile-directory="' + $m.ProfileDir + '"'
      foreach ($pr in $chromeProcs) {
        if ($pr.CommandLine -and $pr.CommandLine.Contains($wantFlag)) { $running += $m; break }
      }
    }
  } catch { $running = @() }
  if ($running.Count -gt 0) {
    $chosen = $running[0]
    $chosenRunning = $true
    $why = '该身份的 Chrome 已在运行'
    if ($running.Count -gt 1) { $why += '（多个匹配身份都在运行，取第一个）' }
  } else {
    $sorted = $matches | Sort-Object { if ($_.Modified) { $_.Modified } else { [datetime]::MinValue } } -Descending
    $chosen = $sorted[0]
    $why = '该身份的 Preferences 最近修改过'
    if ($sorted.Count -gt 1 -and $sorted[0].Modified -eq $sorted[1].Modified) {
      $cached = $null
      try { $cached = (Get-Content $configPath -Raw -ErrorAction Stop | ConvertFrom-Json).last_chrome_profile } catch { }
      if ($cached) {
        $hit = @($sorted | Where-Object { $_.ProfileDir -eq $cached })
        if ($hit.Count -gt 0) { $chosen = $hit[0]; $why = '多个身份的修改时间相同，参考上次的选择' }
      }
    }
  }
}

if ($chosen) {
  Info "选中 Chrome 身份：$($chosen.ProfileDir)（$why）"
  # 把本次选择记到 config.json 里当下次平局的参考；写失败也不影响主流程。
  try {
    $cfgObj = $null
    if (Test-Path $configPath) { $cfgObj = Get-Content $configPath -Raw -ErrorAction Stop | ConvertFrom-Json }
    if (-not $cfgObj) { $cfgObj = New-Object PSObject }
    $cfgObj | Add-Member -NotePropertyName 'last_chrome_profile' -NotePropertyValue $chosen.ProfileDir -Force
    $cfgObj | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding UTF8
  } catch { }
  if ($chosenRunning) {
    Info "Chrome（$($chosen.ProfileDir)）已在运行，不再重复打开。"
  } else {
    Start-Process -FilePath $chosen.Exe -ArgumentList "--profile-directory=`"$($chosen.ProfileDir)`"", 'https://gemini.google.com'
    Info "已用身份 $($chosen.ProfileDir) 打开 Chrome 到 Gemini。"
  }
} else {
  Warn '没能定位到装了 YixiuBridge 的 Chrome 身份（路径不同、Beta/Canary 版、或 Secure Preferences 解析失败），本次不打开任何浏览器。'
  Write-Host ' 请你自己打开平时用 Gemini 的那个 Chrome 就好：插件会靠定时自检自动更新到最新版，任务会等插件连上再做，不会丢。'
}

Write-Host ''
Write-Host '全部完成：桥和 runner 已启动。插件会在一分钟内自动更新到最新版（不需要再手动重载）。'
} catch {
Write-Host ''
Write-Host "出错：$($_.Exception.Message)"
Write-Host '桥和 runner 可能还没起来。请看上面的报错，处理好后再双击一次 一键启动.bat。'
}

Write-Host ''
Write-Host '按任意键关闭本窗口...'
try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')} catch {}
