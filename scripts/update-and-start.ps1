# YixiuBridge 一键更新与启动（Windows）
# 双击仓库根目录的 一键启动.bat 运行本脚本。本脚本会被复制到 %TEMP% 后执行，
# 这样解压覆盖安装目录时不会动到正在运行的脚本自身。
# 流程：检查 node → 读令牌 → 下载最新版覆盖 → 打包插件 → 重启桥 → 启动 runner
# → 打开装了插件的那个 Chrome 身份到 Gemini。
# 令牌只从本机 $env:USERPROFILE\.yixiubridge\config.json 读取，只发给
# codeload.github.com，绝不打印。
# 多 Chrome 身份：只动装了 YixiuBridge 扩展的那一个身份，绝不写死路径。
# 每次运行时动态发现：先找 chrome.exe（注册表 App Paths、Get-Command、
# 标准路径，正式版/Beta/Canary 都查），再扫各身份的 Preferences
# （解压扩展的记录只在这里：extensions.settings.<扩展 ID>，location 4
# + path 字段；Secure Preferences 里没有解压扩展的记录——2026-11-21
# 真机验证：Profile 21 的 Secure Preferences 里搜不到扩展 ID）和
# Secure Preferences、Local Extension Settings，按扩展 ID 定位身份
# 目录名。多个身份都装了插件时，优先选已有进程在运行的那个；都没在
# 运行就选 Preferences 最近修改的那个；上次选中的身份只存 config.json
# 当平局参考，每次都重新扫描、以新结果为准。定位不到就不打开任何浏览
# 器，只更新代码和服务。绝不杀 chrome.exe、不关任何窗口。
param(
[string]$InstallDir = "",
[switch]$SkipUpdate
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 > $null} catch {}

$EXTENSION_ID = 'alcjfcjfkfhfacgofhgoenljfenbcgcel'
$BRIDGE_PORT = 8765
$REPO = 'yixiulab/YixiuBridge'

# 步骤跟踪：catch 里按实情汇报哪一步失败、桥和 runner 各自起了没有，
# 不再笼统说“桥和 runner 可能还没起来”。
$currentStep = 0
$bridgeStarted = $false
$runnerStarted = $false

function Step($n, $text) { $script:currentStep = $n; Write-Host "$text"}
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

# 3. 下载最新版并覆盖（-SkipUpdate 时跳过：新版脚本接管后不需要重复下载）。
$downloaded = $false
if ($token -and -not $SkipUpdate) {
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

# 自我更新交接：刚下载的新版里如果启动脚本变了，改用新版脚本继续执行。
# （本脚本是 .bat 拷到 %TEMP% 的旧副本；不交接的话一次双击会跑完旧逻辑。）
# 新版脚本用 -SkipUpdate 接管，只跑打包、重启桥、启动 runner、开 Chrome，
# 不重复下载。哈希相同就不交接，直接继续。
if ($downloaded) {
$newScript = Join-Path $InstallDir 'scripts\update-and-start.ps1'
$runningScript = $MyInvocation.MyCommand.Path
try {
$hOld = (Get-FileHash $runningScript -Algorithm SHA256 -ErrorAction Stop).Hash
$hNew = (Get-FileHash $newScript -Algorithm SHA256 -ErrorAction Stop).Hash
if ($hOld -ne $hNew) {
Info '检测到新版启动脚本，改用新版继续执行...'
& powershell -NoProfile -ExecutionPolicy Bypass -File "$newScript" -InstallDir "$InstallDir" -SkipUpdate
exit $LASTEXITCODE
}
} catch {
Warn "新版脚本交接失败（$($_.Exception.Message)），继续用当前版本执行。"
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
$bridgeStarted = $true
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
if ($lockPid -and [regex]::IsMatch($lockPid, '^\d+$')) {
$p = Get-Process -Id ([int]$lockPid) -ErrorAction SilentlyContinue
if ($p) { $runnerRunning = $true}
}
}
if ($runnerRunning) {
Info 'runner 已在运行，跳过。'
$runnerStarted = $true
} else {
Start-Process -FilePath 'node' -ArgumentList 'bin/yixiubridge.mjs','runner' -WorkingDirectory $InstallDir -WindowStyle Minimized
$runnerStarted = $true
Info 'runner 已启动（最小化窗口）。'
}

# 7. 打开装了插件的 Chrome 身份到 Gemini。绝不无条件打开默认 Chrome：
# 用户有多个 Chrome 身份，Gemini 和插件只在其中一个上。先按扩展 ID
# 扫描各身份的 Preferences、Secure Preferences 定位身份目录名，再用
# --profile-directory 只开那一个身份；已在运行就不重复开。
# 定位不到就不开任何浏览器，只完成上面的更新和启动。
# 证据有三条（任一成立即算该身份装了插件）：
# (1) Preferences 文本里含有扩展 ID——解压扩展的主证据：Chrome 把
#     解压扩展记在 extensions.settings.<ID>（location 4 + path 字段），
#     Secure Preferences 里没有它（2026-11-21 真机验证：Profile 21 的
#     Secure Preferences 里搜不到扩展 ID，0.3.1 扫 72 个身份 0 匹配
#     就是这个原因）；
# (2) Secure Preferences 文本里含有扩展 ID（商店安装的扩展走这里）；
# (3) 该身份下有 "Local Extension Settings\<扩展 ID>" 目录（扩展用
#     过本地存储就会有）。
# 匹配时还从 Preferences 里读出扩展的加载路径（extensions.settings.
# <ID>.path）打印出来——能确认 Chrome 实际加载的是不是更新脚本维护
# 的那个文件夹。
# 血的教训（v0.3.1 的 bug）：绝不能用 $matches 存扫描结果！$matches
# 是 PowerShell 自动变量，-match / -notmatch 会把它改写成匹配记录
# （hashtable），后面选出来的就是个没有 ProfileDir/Exe 的空对象
# （身份名为空、chrome.exe 为 Null）。所以本节一律用 [regex]::IsMatch()
# 和 .Contains()，绝不用 -match / -notmatch。
# 选身份的规则另见 kernel/shared/chrome-discovery.js（可测试的同款实现）。
Step 7 '定位装了插件的 Chrome 身份...'
# 硬要求：(1) 绝不写死路径——每次动态发现 chrome.exe（注册表 App Paths、
# Get-Command、标准路径：正式版/Beta/Canary 都查），再按扩展 ID 扫各身份
# 的 Preferences / Secure Preferences 定位身份目录名；(2) 只开那一个，绝不影响正在运
# 行的别的浏览器——不杀 chrome.exe、不关任何窗口，用 --profile-directory
# 只开匹配身份，已在运行就把标签页交给已有实例；(3) 多个身份都装了插件
# 时优先选已有进程在运行的那个，都没在运行就选 Preferences 最近修改的
# 那个，选了哪个、为什么都写出来；上次选中的身份目录存在 config.json
# 里（last_chrome_profile），只做平局参考，每次都重新扫描、以新结果为
# 准；(4) 定位不到就不开任何浏览器，只完成上面的更新和启动。

# 按 chrome.exe 路径推断它用的 User Data 目录（正式版/Beta/Canary）。
function Get-UserDataDirForChrome($exePath) {
  if ([regex]::IsMatch($exePath, 'Chrome Beta')) { return (Join-Path $env:LOCALAPPDATA 'Google\Chrome Beta\User Data') }
  if ([regex]::IsMatch($exePath, 'Chrome SxS')) { return (Join-Path $env:LOCALAPPDATA 'Google\Chrome SxS\User Data') }
  return (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')
}

# 收集 chrome.exe 候选路径：注册表 → Get-Command → 各通道标准路径。
# 下面这些是 Chrome 各通道的默认安装位置（系统默认值，不是用户写死的
# 个人路径）；身份目录仍每次动态发现，绝不写死。
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

# 读一个文本文件：Chrome 运行时可能正写着它，先正常读，失败再用共享读
# 方式重试；都失败返回 $null（调用方记为“读不到”并告警，不静默跳过）。
function Read-TextFileShared($path) {
  try { return (Get-Content $path -Raw -ErrorAction Stop) } catch { }
  $fs = $null
  $sr = $null
  try {
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    return $sr.ReadToEnd()
  } catch { return $null } finally {
    if ($sr) { $sr.Dispose() } elseif ($fs) { $fs.Dispose() }
  }
}

# 从 Preferences 文本里取扩展的加载路径（extensions.settings.<ID>.path，
# 解压扩展 location 4 才有）。只在文本里含有扩展 ID 时才解析 JSON；
# 解析失败退回正则在 ID 附近找 "path"。取不到返回 $null，绝不报错——
# 路径只是诊断信息，没有它也不影响匹配。
function Get-ExtensionPathFromPrefs($prefsText) {
  if (-not $prefsText) { return $null }
  if (-not $prefsText.Contains($EXTENSION_ID)) { return $null }
  try {
    $prefsJson = $prefsText | ConvertFrom-Json -ErrorAction Stop
    $entry = $prefsJson.extensions.settings.$EXTENSION_ID
    if ($entry -and $entry.path) { return [string]$entry.path }
  } catch { }
  try {
    $m = [regex]::Match($prefsText, [regex]::Escape($EXTENSION_ID) + '"\s*:\s*\{[\s\S]{0,5000}?"path"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if ($m.Success) { return ($m.Groups[1].Value -replace '\\\\', '\') }
  } catch { }
  return $null
}

# 扫描各身份，找含有扩展 ID 的身份。证据有三条（任一成立即算匹配）：
# (1) Preferences 文本里含有扩展 ID；(2) Secure Preferences 文本里
# 含有扩展 ID；(3) 该身份下有 "Local Extension Settings\<扩展 ID>"
# 目录（扩展用过本地存储就会有）。
# 两个文件都读不到、又没有 Local Extension Settings 目录的身份记下来
# 并告警，绝不静默跳过。
# 变量名绝不能叫 $matches（见上面血的教训）。
$foundProfiles = @()
$scannedProfiles = 0
$scannedUserDataDirs = 0
$readablePrefsProfiles = 0
$unreadableProfiles = @()
foreach ($inst in $installs) {
  if (-not (Test-Path $inst.UserData)) { continue }
  $scannedUserDataDirs++
  $profileDirs = Get-ChildItem -Path $inst.UserData -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'Default' -or [regex]::IsMatch($_.Name, '^Profile \d+$') }
  foreach ($d in $profileDirs) {
    $scannedProfiles++
    $prefsPath = Join-Path $d.FullName 'Preferences'
    $prefsText = $null
    $prefsReadable = $false
    if (Test-Path $prefsPath) {
      $prefsText = Read-TextFileShared $prefsPath
      if ($null -ne $prefsText) { $prefsReadable = $true; $readablePrefsProfiles++ }
    }
    $securePath = Join-Path $d.FullName 'Secure Preferences'
    $secureText = $null
    $secureReadable = $false
    if (Test-Path $securePath) {
      $secureText = Read-TextFileShared $securePath
      if ($null -ne $secureText) { $secureReadable = $true }
    }
    $lesDir = Join-Path $d.FullName "Local Extension Settings\$EXTENSION_ID"
    $lesExists = Test-Path $lesDir
    if (-not $prefsReadable -and -not $secureReadable -and -not $lesExists) {
      $unreadableProfiles += "$($d.Name)（$($inst.UserData)）"
      continue
    }
    $hasId = $false
    $evidence = @()
    $loadedPath = $null
    if ($prefsReadable -and $prefsText.Contains($EXTENSION_ID)) {
      $hasId = $true; $evidence += 'Preferences'
      $loadedPath = Get-ExtensionPathFromPrefs $prefsText
    }
    if ($secureReadable -and $secureText.Contains($EXTENSION_ID)) { $hasId = $true; $evidence += 'Secure Preferences' }
    if ($lesExists) { $hasId = $true; $evidence += 'Local Extension Settings' }
    if (-not $hasId) { continue }
    $prefFile = Join-Path $d.FullName 'Preferences'
    $mtime = $null
    if (Test-Path $prefFile) { $mtime = (Get-Item $prefFile).LastWriteTime }
    elseif (Test-Path $securePath) { $mtime = (Get-Item $securePath).LastWriteTime }
    $foundProfiles += @{ Exe = $inst.Exe; ProfileDir = $d.Name; UserData = $inst.UserData; Modified = $mtime; Evidence = ($evidence -join '+'); LoadedPath = $loadedPath }
  }
}
Info "共扫描 $scannedUserDataDirs 个 User Data 目录、$scannedProfiles 个 Chrome 身份（其中 $readablePrefsProfiles 个的 Preferences 可读），其中 $($foundProfiles.Count) 个装了 YixiuBridge。"
if ($unreadableProfiles.Count -gt 0) {
  Warn '以下身份的 Preferences 和 Secure Preferences 都读不到、也没有 Local Extension Settings 目录，本次没用它们做判断：'
  foreach ($u in $unreadableProfiles) { Info "  $u" }
}

# 选择：(a) 优先选已有 chrome.exe 进程在运行的那个匹配身份；
# (b) 都没在运行就选 Preferences 最近修改的那个；
# (c) 修改时间相同（或都没有）时，参考上次选中的身份。
# 注意：只在已确认装了插件的身份里选；一个都没找到就什么都不开，
# 绝不退而求其次去开一个没装插件的身份。
$chosen = $null
$chosenRunning = $false
$why = ''
if ($foundProfiles.Count -gt 0) {
  $running = @()
  try {
    $chromeProcs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop
    foreach ($m in $foundProfiles) {
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
    $sorted = $foundProfiles | Sort-Object { if ($_.Modified) { $_.Modified } else { [datetime]::MinValue } } -Descending
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

$chromeOpened = $false
$chromeSkipped = ''
if ($chosen) {
  Info "选中 Chrome 身份：$($chosen.ProfileDir)（$why；证据：$($chosen.Evidence)）"
  if ($chosen.LoadedPath) {
    Info "  扩展加载路径：$($chosen.LoadedPath)"
    if ($chosen.LoadedPath -ne (Join-Path $InstallDir 'extension')) {
      Warn "该路径和一键更新维护的安装目录（$InstallDir\extension）不一样：Chrome 加载的插件可能不是更新脚本下载的那一份，更新后插件不会自动变新。请确认 chrome://extensions 里加载的是哪个文件夹。"
    }
  }
  # 把本次选择记到 config.json 里当下次平局的参考；写失败也不影响主流程。
  try {
    $cfgObj = $null
    if (Test-Path $configPath) { $cfgObj = Get-Content $configPath -Raw -ErrorAction Stop | ConvertFrom-Json }
    if (-not $cfgObj) { $cfgObj = New-Object PSObject }
    $cfgObj | Add-Member -NotePropertyName 'last_chrome_profile' -NotePropertyValue $chosen.ProfileDir -Force
    $cfgObj | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding UTF8
  } catch { }
  if (-not $chosen.Exe -or -not (Test-Path $chosen.Exe)) {
    Warn '选中的身份没有可用的 chrome.exe 路径（内部错误），本次不打开浏览器。桥和 runner 已正常启动。'
    $chromeSkipped = '选中的身份缺少 chrome.exe 路径'
  } elseif ($chosenRunning) {
    Info "Chrome（$($chosen.ProfileDir)）已在运行，不再重复打开。"
    $chromeOpened = $true
  } else {
    Start-Process -FilePath $chosen.Exe -ArgumentList "--profile-directory=`"$($chosen.ProfileDir)`"", 'https://gemini.google.com'
    Info "已用身份 $($chosen.ProfileDir) 打开 Chrome 到 Gemini。"
    $chromeOpened = $true
  }
} else {
  Warn "没能定位到装了 YixiuBridge 的 Chrome 身份（已扫 $scannedUserDataDirs 个 User Data 目录、$scannedProfiles 个身份，其中 $readablePrefsProfiles 个的 Preferences 可读；没有哪个身份的 Preferences / Secure Preferences 里含有该扩展，也没有 Local Extension Settings 目录），本次不打开任何浏览器。"
  Write-Host ' 请你自己打开平时用 Gemini 的那个 Chrome 就好：插件会靠定时自检自动更新到最新版，任务会等插件连上再做，不会丢。'
  $chromeSkipped = '没能定位到装了插件的身份'
}

Write-Host ''
if ($chromeOpened) {
Write-Host '全部完成：桥和 runner 已启动，Chrome 已打开到 Gemini。插件会在一分钟内自动更新到最新版（不需要再手动重载）。'
} elseif ($chromeSkipped) {
Write-Host "已完成：桥和 runner 已启动；Chrome 没打开（$chromeSkipped）。请自己打开平时用 Gemini 的那个 Chrome，插件会自动更新。"
} else {
Write-Host '全部完成：桥和 runner 已启动。插件会在一分钟内自动更新到最新版（不需要再手动重载）。'
}
} catch {
Write-Host ''
Write-Host "出错（第 $currentStep 步）：$($_.Exception.Message)"
if ($bridgeStarted) { Write-Host '桥已经启动成功。' } else { Write-Host '桥还没启动。' }
if ($runnerStarted) { Write-Host 'runner 已经启动成功。' } else { Write-Host 'runner 还没启动。' }
Write-Host '请看上面的报错，处理好后再双击一次 一键启动.bat。'
}

Write-Host ''
Write-Host '按任意键关闭本窗口...'
try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')} catch {}
