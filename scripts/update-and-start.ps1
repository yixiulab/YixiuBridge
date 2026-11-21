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
# （Chrome 把扩展安装记录记在这里：extensions.settings.<扩展 ID>，
# location + path 字段——主证据）、Local Extension Settings（补充证据）、
# Preferences（弱信号：有些 Chromium 系浏览器记在这里，Chrome 不记——
# 2026-11-21 真机验证：Profile 21 的 Preferences 文件里根本没有
# extensions.settings 这个键，扩展 ID 出现 0 次；0.3.2 改查 Preferences
# 是错方向，0.3.3 已改回），按扩展 ID 定位身份目录名。多个身份都装了
# 插件时，优先选已有进程在运行的那个；都没在运行就选 Preferences 最近
# 修改的那个；上次选中的身份只存 config.json 当平局参考，每次都重新
# 扫描、以新结果为准。定位不到就不打开任何浏览器，只更新代码和服务。
# 绝不杀 chrome.exe、不关任何窗口。
param(
[string]$InstallDir = "",
[switch]$SkipUpdate,
[switch]$Updated
)
# -Updated：内部开关，自我更新交接时由旧脚本传给新脚本，表示“刚下载过
# 新版”（新脚本自己 -SkipUpdate，$downloaded 为假，但更新确实发生了，
# 第 6 步要按“更新过”处理 runner）。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 > $null} catch {}

$EXTENSION_ID = 'alcjfcjfkhfacgofhgoenljfenbcgcel'
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

# 启动时哈希（v0.3.3 修交接 bug）：下载前先把正在运行的本脚本算一次
# SHA256，记下来。直接跑安装目录里的脚本时，下载后 $MyInvocation.
# MyCommand.Path 和安装目录里的脚本是同一个文件，下载后再算哈希永远
# 相等，交接永远跳过（2026-11-21 16:37 真机验证：下载了 0.3.2，却
# 一直跑 0.3.1 的逻辑）。拿下载前的哈希和下载后的文件比，才能看出
# 脚本变了。算不出来就记 $null，交接时退回旧行为。
$scriptHashAtStart = $null
try { $scriptHashAtStart = (Get-FileHash $MyInvocation.MyCommand.Path -Algorithm SHA256 -ErrorAction Stop).Hash } catch { }

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
# 新版脚本用 -SkipUpdate -Updated 接管，只跑打包、重启桥、启动 runner、
# 开 Chrome，不重复下载（-Updated 告诉新脚本“更新刚发生过”，第 6 步
# 要按更新过处理 runner）。哈希相同就不交接，直接继续。
# 关键（v0.3.3）：拿启动时算好的 $scriptHashAtStart（下载前那份）和下载
# 后的文件比——直接跑安装目录里的脚本时，$runningScript 和 $newScript
# 是同一个文件，下载后再算永远相等，交接永远跳过。取不到启动时哈希才
# 退回下载后再算 $runningScript（旧行为）。
if ($downloaded) {
$newScript = Join-Path $InstallDir 'scripts\update-and-start.ps1'
$runningScript = $MyInvocation.MyCommand.Path
try {
$hOld = $scriptHashAtStart
if (-not $hOld) { $hOld = (Get-FileHash $runningScript -Algorithm SHA256 -ErrorAction Stop).Hash }
$hNew = (Get-FileHash $newScript -Algorithm SHA256 -ErrorAction Stop).Hash
if ($hOld -ne $hNew) {
Info '检测到新版启动脚本，改用新版继续执行...'
& powershell -NoProfile -ExecutionPolicy Bypass -File "$newScript" -InstallDir "$InstallDir" -SkipUpdate -Updated
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
# 更新后 runner 必须跑新代码：runner 是常驻进程，本脚本以前“已在运行
# 就跳过”，所以代码更新了它还在跑旧版（2026-11-21：桥已是 0.3.2，侧
# 边栏却显示控制器 muse-runner/0.3.0）。更新过（本次下载了，或交接时
# 传了 -Updated）且 runner 已在运行时，只在空闲时重启它：问桥的
# /status，当前控制者（controller）为空才算空闲——有任务在跑就本次不
# 重启，等下次双击；桥没响应、无法确认空闲时也不重启。重启前再等 5 秒
# 复核一次（runner 可能正好在写 done/failed 文件，桥的控制者已经释放
# 了；复核能挡住刚接到的新任务）。停旧 runner 只按锁文件里的 PID 停
# node 进程，等它彻底退出后再起新的；新 runner 会按“死 PID 接管”规
# 则接管锁文件。pending 里的任务不会丢（没写完 done/failed 前 pending
# 文件还在，新 runner 会接着做；done/failed 已写好时 runner 的幂等守
# 卫会跳过重复提问——见 host/muse-runner.mjs）。
# “更新过”的判断（v0.3.4 修）：只看 $downloaded / -Updated 不够——
# 0.3.2 及更早的启动脚本交接时根本不传 -Updated（这个开关是 0.3.3
# 才加的），所以从旧版升上来时 $updateHappened 永远是假的（2026-11-21
# 真机：0.3.2 交接后 0.3.3 脚本打印“runner 已在运行，跳过”，runner
# 一直跑 0.3.0）。改用文件时间兜底：runner 代码文件
# （host\muse-runner.mjs、kernel\shared\constants.js）比 runner 进程
# 启动得晚，说明代码在它启动后被更新过，跑的是旧版。每次双击都会重新
# 解压、文件时间会刷新，所以即使没发新版也可能判为“旧”而重启一次—
# —无害（空闲时才重启，任务在跑时不动），重启本身只要一秒。
Step 6 '启动 runner...'
$lockPath = Join-Path $env:USERPROFILE '.yixiubridge\muse-runner.lock'
$updateHappened = $downloaded -or $Updated
$runnerRunning = $false
$runnerProc = $null
$lockPid = $null
if (Test-Path $lockPath) {
$lockPid = (Get-Content $lockPath -Raw -ErrorAction SilentlyContinue).Trim()
if ($lockPid -and [regex]::IsMatch($lockPid, '^\d+$')) {
$runnerProc = Get-Process -Id ([int]$lockPid) -ErrorAction SilentlyContinue
# 锁文件里的 PID 可能已被别的进程复用：只有 node 进程才当它是 runner。
if ($runnerProc -and $runnerProc.ProcessName -eq 'node') { $runnerRunning = $true }
else { $runnerProc = $null }
}
}
$runnerStale = $updateHappened
if ($runnerRunning -and -not $runnerStale -and $runnerProc -and $runnerProc.StartTime) {
foreach ($codeFile in @('host\muse-runner.mjs', 'kernel\shared\constants.js')) {
$codePath = Join-Path $InstallDir $codeFile
if (Test-Path $codePath) {
if ((Get-Item $codePath).LastWriteTime -gt $runnerProc.StartTime) { $runnerStale = $true; break }
}
}
}
if ($runnerRunning) {
if (-not $runnerStale) {
Info 'runner 已在运行，跳过。'
$runnerStarted = $true
} else {
# 更新过：只在空闲时重启。先问一次桥，再等 5 秒复核一次。
$controllerBusy = $null
$statusKnown = $false
for ($chk = 0; $chk -lt 2; $chk++) {
if ($chk -eq 1) { Start-Sleep -Seconds 5 }
try {
$stChk = Invoke-RestMethod -Uri "http://127.0.0.1:$BRIDGE_PORT/status" -TimeoutSec 5
$statusKnown = $true
$controllerBusy = $stChk.controller
} catch { $statusKnown = $false; $controllerBusy = $null }
if (-not $statusKnown) { break }
if ($controllerBusy) { break }
}
if (-not $statusKnown) {
Info 'runner 已在运行；桥没响应，无法确认是否空闲——本次不重启 runner（更新后第一次空闲双击时再重启）。'
$runnerStarted = $true
} elseif ($controllerBusy) {
Info "runner 已在运行，当前有任务在跑（控制者 $controllerBusy）——本次不重启 runner，等任务做完后下次双击再重启。"
$runnerStarted = $true
} else {
$stopped = $false
$rp = Get-Process -Id ([int]$lockPid) -ErrorAction SilentlyContinue
if ($rp -and $rp.ProcessName -eq 'node') {
try {
Stop-Process -Id $rp.Id -Force
$waited = 0
while ($waited -lt 10) {
Start-Sleep -Seconds 1
$waited++
if (-not (Get-Process -Id $rp.Id -ErrorAction SilentlyContinue)) { $stopped = $true; break }
}
} catch { $stopped = $false }
}
if ($stopped) {
Info "旧 runner（PID $($rp.Id)）已停，启动新版 runner..."
Start-Process -FilePath 'node' -ArgumentList 'bin/yixiubridge.mjs','runner' -WorkingDirectory $InstallDir -WindowStyle Minimized
$runnerStarted = $true
Info 'runner 已重启为新版（最小化窗口）。'
} else {
Warn '旧 runner 停不掉（或锁文件里的 PID 对不上），本次不重启 runner——它仍在跑旧版，下次双击时再试。'
$runnerStarted = $true
}
}
}
} else {
Start-Process -FilePath 'node' -ArgumentList 'bin/yixiubridge.mjs','runner' -WorkingDirectory $InstallDir -WindowStyle Minimized
$runnerStarted = $true
Info 'runner 已启动（最小化窗口）。'
}
# runner 的日志同时写进文件（v0.3.4）：窗口是最小化的，死掉/卡住时看不
# 到输出，日志文件是唯一的诊断入口。每次都打印路径。
Info "runner 日志：$env:USERPROFILE\.yixiubridge\muse-runner.log"

# 7. 打开装了插件的 Chrome 身份到 Gemini。绝不无条件打开默认 Chrome：
# 用户有多个 Chrome 身份，Gemini 和插件只在其中一个上。先按扩展 ID
# 扫描各身份的 Secure Preferences、Local Extension Settings、Preferences
# 定位身份目录名，再用 --profile-directory 只开那一个身份；已在运行
# 就不重复开。定位不到就不开任何浏览器，只完成上面的更新和启动。
# 证据有三条（任一成立即算该身份装了插件），按优先级：
# (1) Secure Preferences 文本里含有扩展 ID——主证据：Chrome 把扩展安
#     装记录记在这里（extensions.settings.<ID>，location + path 字段）；
# (2) 该身份下有 "Local Extension Settings\<扩展 ID>" 目录（扩展用
#     过本地存储就会有）——补充证据；
# (3) Preferences 文本里含有扩展 ID——弱信号：只对 Chromium 系浏览器
#     有意义（Chrome 不在这里记扩展安装记录：2026-11-21 真机验证，
#     Profile 21 的 Preferences 里根本没有 extensions.settings 这个键，
#     0.3.2 改查 Preferences 是错方向）。
# 匹配时还从 Secure Preferences（没有就从 Preferences）里读出扩展的加
# 载路径（extensions.settings.<ID>.path）打印出来——能确认 Chrome 实际
# 加载的是不是更新脚本维护的那个文件夹。路径只来自该 ID 自己的记录，
# 找不到就打印“未知”，绝不拿隔壁扩展的路径顶替（v0.3.5：旧正则兜底
# 会跨过记录边界，0.3.4 真机给 Profile 18 打印了内置
# network_speech_synthesis 的路径）。
# v0.3.5 匹配的“已确认”规则：只在文本里含有扩展 ID 不算“已确认”——
# Chrome 还在 protection/macs 里给每个扩展留完整性哈希（ID 作键），
# 记录删了哈希还会留着，子串搜索会把已卸载的身份也算成匹配（2026-11-21
# 真机：0.3.4 扫出 2 个匹配，错选 Profile 18）。已确认的才优先选；一
# 个已确认的都没有时，才退回未确认的，并在输出里明说。
# 破案（v0.3.3，2026-11-21 17:10）：0.3.1 扫 72 个身份 0 匹配的原因
# 找到了——根本不是文件或证据问题，是扩展 ID 写错了：之前全仓库用的
# alcjfcjfkfhfacgofhgoenljfenbcgcel 是 33 个字符（多了一个 f，11:36
# 看 chrome://extensions 截图时读错的），而 Chrome 扩展 ID 永远是
# 32 个字符，所以那个字符串永远匹配不到。真实 ID 是
# alcjfcjfkhfacgofhgoenljfenbcgcel（32 位）；用户 Profile 21 的
# Secure Preferences 里确实有这条记录（location 4，path 正是安装
# 目录 C:\software\myself\YixiuBridge-main\extension）。本次扫描还会
# 打印 Secure Preferences 可读的身份数，万一下次又是 0 匹配，从输出
# 就能分清是“读到了、没有 ID”还是“根本读不到”。
# 血的教训（v0.3.1 的 bug）：绝不能用 $matches 存扫描结果！$matches
# 是 PowerShell 自动变量，-match / -notmatch 会把它改写成匹配记录
# （hashtable），后面选出来的就是个没有 ProfileDir/Exe 的空对象
# （身份名为空、chrome.exe 为 Null）。所以本节一律用 [regex]::IsMatch()
# 和 .Contains()，绝不用 -match / -notmatch。
# 选身份的规则另见 kernel/shared/chrome-discovery.js（可测试的同款实现）。
Step 7 '定位装了插件的 Chrome 身份...'
# 硬要求：(1) 绝不写死路径——每次动态发现 chrome.exe（注册表 App Paths、
# Get-Command、标准路径：正式版/Beta/Canary 都查），再按扩展 ID 扫各身份
# 的 Secure Preferences / Local Extension Settings / Preferences 定位身份目录名；(2) 只开那一个，绝不影响正在运
# 行的别的浏览器——不杀 chrome.exe、不关任何窗口，用 --profile-directory
# 只开匹配身份，已在运行就把标签页交给已有实例；(3) 多个身份都装了插件
# 时：先在已确认的匹配里选——优先选已有进程在运行的那个，再优先选
# 加载的扩展正是本机维护那一份的（加载路径与安装目录一致），再选
# Preferences 最近修改的那个，选了哪个、为什么都写出来；上次选中的
# 身份目录存在 config.json 里（last_chrome_profile），只做平局参考，
# 每次都重新扫描、以新结果为准；(4) 定位不到就不开任何浏览器，只完成
# 上面的更新和启动。

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

# 从偏好设置格式的文本里取扩展的加载路径（extensions.settings.<ID>.path，
# 解压扩展 location 4 才有）。调用方先传 Secure Preferences 文本（主
# 证据，Chrome 的记录在这里），没有再传 Preferences 文本；两种文件
# 的 schema 相同。
# v0.3.5 血的教训：旧的正则兜底（ID 后 5000 字符内找第一个 "path"）没有
# 入口边界，ID 自身的记录里没有 path（或文件解析失败）时，会跨过记录边
# 界抓到隔壁扩展的路径——2026-11-21 真机：给 Profile 18 打印了 Chrome
# 内置 network_speech_synthesis 的路径
# （.../resources/network_speech_synthesis/mv3）。现在的规则：路径只
# 能来自该 ID 自己那条 extensions.settings 记录（JSON 按 ID 取键，或
# 正则只在该记录自己的花括号里找）；找不到就返回 $null（调用方打印
# “未知”），绝不拿别的扩展的路径顶替。
function Get-PrefsSettingsObject($prefsText) {
  # 解析一次，供“确认匹配”和“取路径”两处共用。解析失败返回 $null。
  if (-not $prefsText) { return $null }
  try {
    $prefsJson = $prefsText | ConvertFrom-Json -ErrorAction Stop
    $settings = $prefsJson.extensions.settings
    if ($settings) { return $settings }
  } catch { }
  return $null
}

function Test-SettingsHasId($settingsObj) {
  # 已确认：扩展 ID 是 extensions.settings 的一个键（一条活的安装记录）。
  if (-not $settingsObj) { return $false }
  return ($settingsObj.PSObject.Properties.Name -contains $EXTENSION_ID)
}

function Get-ExtensionPathFromSettings($settingsObj) {
  if (-not (Test-SettingsHasId $settingsObj)) { return $null }
  $entry = $settingsObj.PSObject.Properties[$EXTENSION_ID].Value
  if ($entry -and $entry.path) { return [string]$entry.path }
  return $null
}

# 正则兜底（仅当文件解析失败时用）：找到 "<ID>" 后紧跟 ':' 和 '{' 的
# 那一次出现（MAC 记录里 ID 后面跟的是哈希字符串，没有 '{'，不会误
# 判），再数字符配对的花括号，只在那条记录内部找 "path"。找不到、
# 花括号不配对、记录里没有 path，都返回 $null。
function Get-ExtensionPathFromEntryRegex($prefsText) {
  if (-not $prefsText) { return $null }
  $needle = '"' + $EXTENSION_ID + '"'
  $from = 0
  while ($true) {
    $idIdx = $prefsText.IndexOf($needle, $from, [System.StringComparison]::Ordinal)
    if ($idIdx -lt 0) { return $null }
    $j = $idIdx + $needle.Length
    while ($j -lt $prefsText.Length -and [char]::IsWhiteSpace($prefsText[$j])) { $j++ }
    if ($j -ge $prefsText.Length -or $prefsText[$j] -ne ':') { $from = $idIdx + $needle.Length; continue }
    $j++
    while ($j -lt $prefsText.Length -and [char]::IsWhiteSpace($prefsText[$j])) { $j++ }
    if ($j -ge $prefsText.Length -or $prefsText[$j] -ne '{') { $from = $idIdx + $needle.Length; continue }
    # 从 $j 的 '{' 开始数字符配对（字符串与转义要跳过）。
    $depth = 0
    $inStr = $false
    $esc = $false
    $end = -1
    for ($i = $j; $i -lt $prefsText.Length; $i++) {
      $ch = $prefsText[$i]
      if ($inStr) {
        if ($esc) { $esc = $false }
        elseif ($ch -eq '\') { $esc = $true }
        elseif ($ch -eq '"') { $inStr = $false }
      } else {
        if ($ch -eq '"') { $inStr = $true }
        elseif ($ch -eq '{') { $depth++ }
        elseif ($ch -eq '}') { $depth--; if ($depth -eq 0) { $end = $i + 1; break } }
      }
    }
    if ($end -lt 0) { return $null }
    $entryText = $prefsText.Substring($j, $end - $j)
    $m = [regex]::Match($entryText, '"path"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if (-not $m.Success) { return $null }
    return ($m.Groups[1].Value -replace '\\\\', '\' -replace '\\"', '"')
  }
}

function Get-ExtensionPathFromPrefs($prefsText) {
  if (-not $prefsText) { return $null }
  if (-not $prefsText.Contains($EXTENSION_ID)) { return $null }
  $settingsObj = Get-PrefsSettingsObject $prefsText
  if ($settingsObj) {
    # 解析成功就是权威结论：settings 对象就是全部真相——该 ID 没记录
    # 或记录里没 path，就是没有，绝不拿隔壁的顶替。
    return (Get-ExtensionPathFromSettings $settingsObj)
  }
  return (Get-ExtensionPathFromEntryRegex $prefsText)
}

# 扫描各身份，找含有扩展 ID 的身份。证据有三条（任一成立即算匹配，
# 优先级 Secure Preferences > Local Extension Settings > Preferences）：
# (1) Secure Preferences 文本里含有扩展 ID（主证据）；(2) 该身份下有
# "Local Extension Settings\<扩展 ID>" 目录（扩展用过本地存储就会有）；
# (3) Preferences 文本里含有扩展 ID（弱信号）。
# 两个文件都读不到、又没有 Local Extension Settings 目录的身份记下来
# 并告警，绝不静默跳过。
# 变量名绝不能叫 $matches（见上面血的教训）。
$foundProfiles = @()
$scannedProfiles = 0
$scannedUserDataDirs = 0
$readablePrefsProfiles = 0
$readableSecureProfiles = 0
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
      if ($null -ne $secureText) { $secureReadable = $true; $readableSecureProfiles++ }
    }
    $lesDir = Join-Path $d.FullName "Local Extension Settings\$EXTENSION_ID"
    $lesExists = Test-Path $lesDir
    if (-not $prefsReadable -and -not $secureReadable -and -not $lesExists) {
      $unreadableProfiles += "$($d.Name)（$($inst.UserData)）"
      continue
    }
    # 已确认（confirmed）：扩展 ID 是 extensions.settings 的一个键
    # （一条活的安装记录），或该身份有 Local Extension Settings\<ID>
    # 目录（扩展在那跑过）。未确认（unconfirmed）：ID 只在文本里出现
    # （例如 protection/macs 里的完整性哈希，记录删了哈希还会留着），
    # 没有安装记录——算匹配，但选身份时排在已确认的后面。
    # v0.3.5：只在文本含 ID 时才解析 JSON（72 个身份都解析太慢）；解
    # 析结果两处共用（确认匹配 + 取路径）。
    $secureSettings = $null
    $secureConfirmed = $false
    $secureTextHasId = $false
    if ($secureReadable) {
      $secureTextHasId = $secureText.Contains($EXTENSION_ID)
      if ($secureTextHasId) {
        $secureSettings = Get-PrefsSettingsObject $secureText
        $secureConfirmed = Test-SettingsHasId $secureSettings
      }
    }
    $prefsSettings = $null
    $prefsConfirmed = $false
    $prefsTextHasId = $false
    if ($prefsReadable) {
      $prefsTextHasId = $prefsText.Contains($EXTENSION_ID)
      if ($prefsTextHasId) {
        $prefsSettings = Get-PrefsSettingsObject $prefsText
        $prefsConfirmed = Test-SettingsHasId $prefsSettings
      }
    }
    $hasId = $false
    $confirmed = $false
    $evidence = @()
    $loadedPath = $null
    if ($secureConfirmed) {
      $hasId = $true; $confirmed = $true; $evidence += 'Secure Preferences'
      $loadedPath = Get-ExtensionPathFromSettings $secureSettings
    } elseif ($secureTextHasId) {
      $hasId = $true; $evidence += 'Secure Preferences (unconfirmed)'
    }
    if ($lesExists) { $hasId = $true; $confirmed = $true; $evidence += 'Local Extension Settings' }
    if ($prefsConfirmed) {
      $hasId = $true; $confirmed = $true; $evidence += 'Preferences'
      if (-not $loadedPath) { $loadedPath = Get-ExtensionPathFromSettings $prefsSettings }
    } elseif ($prefsTextHasId) {
      $hasId = $true; $evidence += 'Preferences (unconfirmed)'
    }
    if (-not $hasId) { continue }
    $prefFile = Join-Path $d.FullName 'Preferences'
    $mtime = $null
    if (Test-Path $prefFile) { $mtime = (Get-Item $prefFile).LastWriteTime }
    elseif (Test-Path $securePath) { $mtime = (Get-Item $securePath).LastWriteTime }
    $foundProfiles += @{ Exe = $inst.Exe; ProfileDir = $d.Name; UserData = $inst.UserData; Modified = $mtime; Evidence = ($evidence -join '+'); LoadedPath = $loadedPath; Confirmed = $confirmed }
  }
}
$confirmedCount = @($foundProfiles | Where-Object { $_.Confirmed }).Count
Info "共扫描 $scannedUserDataDirs 个 User Data 目录、$scannedProfiles 个 Chrome 身份（其中 $readablePrefsProfiles 个的 Preferences 可读、$readableSecureProfiles 个的 Secure Preferences 可读），其中 $($foundProfiles.Count) 个装了 YixiuBridge（其中 $confirmedCount 个是已确认的安装记录）。"
if ($unreadableProfiles.Count -gt 0) {
  Warn '以下身份的 Preferences 和 Secure Preferences 都读不到、也没有 Local Extension Settings 目录，本次没用它们做判断：'
  foreach ($u in $unreadableProfiles) { Info "  $u" }
}

# 某个 chrome.exe 命令行是否指向该身份目录。浏览器进程只有在最初就
# 是用 --profile-directory 启动时才带这个标记；已在运行的 Chrome 里
# 再开一个身份窗口（交接/身份切换）时，没有任何进程带这个标记，所以
# 这里找不到 ≠ 该身份没在运行——找不到时只退回后面的规则，绝不当成
# “没在运行”的证据（v0.3.5：旧的精确匹配
# '--profile-directory="Profile 21"' 在真机上从来没命中过，0.3.3 也
# 是靠“Preferences 最近修改过”蒙对 Profile 21 的）。
# 写法上容忍：--profile-directory 后面跟 '=' 或空格、引号可有可无；
# 也认完整路径里的身份目录段（--user-data-dir=...\Profile 21）。
# 目录名后必须跟引号/空白/斜杠或行尾，'Profile 2' 绝不会误 match
# 'Profile 21'。绝不用 -match（见上面血的教训）。
function Test-ProfileRunning($commandLines, $profileDir) {
  if (-not $profileDir) { return $false }
  $esc = [regex]::Escape($profileDir)
  $flagPat = '--profile-directory\s*=?\s*"' + $esc + '(?=["\s]|$)'
  $pathPat = '[\\/]' + $esc + '(?=[\\/"\s]|$)'
  foreach ($cl in $commandLines) {
    if (-not $cl) { continue }
    if ([regex]::IsMatch($cl, $flagPat, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) { return $true }
    if ([regex]::IsMatch($cl, $pathPat, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) { return $true }
  }
  return $false
}

# 桥上当前连着几个扩展（只作诊断参考：桥认扩展靠的是每个身份随机生成
# 的别名，脚本没法把别名对应回身份目录名，所以这里只打印个数，不用来
# 选身份；个数和扫描结果对不上时，输出里能看出来）。
$bridgeExtCount = $null
try {
  $st7 = Invoke-RestMethod -Uri "http://127.0.0.1:$BRIDGE_PORT/status" -TimeoutSec 5
  if ($null -ne $st7.extensions) { $bridgeExtCount = @($st7.extensions).Count }
} catch { $bridgeExtCount = $null }
if ($null -ne $bridgeExtCount) {
  Info "桥上当前连着 $bridgeExtCount 个扩展。"
  if ($bridgeExtCount -eq 1 -and $foundProfiles.Count -gt 1) {
    Info '（桥上只有一个扩展在线，而扫描到多个匹配身份——其中可能有已卸载留下的旧记录，下面会优先选已确认的身份。）'
  }
}

# 选择（v0.3.5 改顺序，见 kernel/shared/chrome-discovery.js 同款实现）：
# (a) 已确认的匹配里，优先选已有 chrome.exe 进程在运行的那个；
# (b) 再优先选加载的扩展正是本机维护的那一份的（加载路径与安装目录
#     一致——0.3.4 真机：Profile 18 赢在“Preferences 最近修改过”，
#     但它加载的根本不是我们维护的那份）；
# (c) 再选已确认的匹配里 Preferences 最近修改的那个；
# (d) 修改时间相同（或都没有）时，参考上次选中的身份。
# 一个已确认的都没有时，才退回未确认的匹配（并在输出里明说）。
# 注意：只在已确认装了插件的身份里选；一个都没找到就什么都不开，
# 绝不退而求其次去开一个没装插件的身份。
$chosen = $null
$chosenRunning = $false
$chosenConfirmed = $true
$why = ''
if ($foundProfiles.Count -gt 0) {
  $confirmedPool = @($foundProfiles | Where-Object { $_.Confirmed })
  $pool = $confirmedPool
  $poolConfirmed = $true
  if ($confirmedPool.Count -eq 0) {
    $pool = $foundProfiles
    $poolConfirmed = $false
  }
  $chosenConfirmed = $poolConfirmed
  $installExtDir = Join-Path $InstallDir 'extension'
  $chromeCmdlines = @()
  try {
    $chromeProcs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop
    foreach ($pr in $chromeProcs) { if ($pr.CommandLine) { $chromeCmdlines += [string]$pr.CommandLine } }
  } catch { $chromeCmdlines = @() }
  $running = @()
  foreach ($m in $pool) {
    if (Test-ProfileRunning $chromeCmdlines $m.ProfileDir) { $running += $m }
  }
  if ($running.Count -gt 0) {
    $chosen = $running[0]
    $chosenRunning = $true
    $why = '该身份的 Chrome 已在运行'
    if ($running.Count -gt 1) { $why += '（多个匹配身份都在运行，取第一个）' }
  } else {
    $ours = @($pool | Where-Object { $_.LoadedPath -and ($_.LoadedPath.TrimEnd('\') -ieq $installExtDir.TrimEnd('\')) })
    if ($ours.Count -gt 0) {
      $chosen = @($ours | Sort-Object { if ($_.Modified) { $_.Modified } else { [datetime]::MinValue } } -Descending)[0]
      $why = '该身份加载的扩展正是本机维护的那一份（路径与安装目录一致）'
    } else {
      $sorted = @($pool | Sort-Object { if ($_.Modified) { $_.Modified } else { [datetime]::MinValue } } -Descending)
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
}

$chromeOpened = $false
$chromeSkipped = ''
if ($chosen) {
  Info "选中 Chrome 身份：$($chosen.ProfileDir)（$why；证据：$($chosen.Evidence)）"
  if (-not $chosenConfirmed) {
    Warn '该身份只是“未确认”匹配（扩展 ID 只在文本里出现，没有扩展安装记录——可能是已卸载留下的旧记录）。如果打开后插件不在，请把这次输出发回来看。'
  }
  if ($chosen.LoadedPath) {
    Info "  扩展加载路径：$($chosen.LoadedPath)"
    if ($chosen.LoadedPath.TrimEnd('\') -ine (Join-Path $InstallDir 'extension').TrimEnd('\')) {
      Warn "该路径和一键更新维护的安装目录（$InstallDir\extension）不一样：Chrome 加载的插件可能不是更新脚本下载的那一份，更新后插件不会自动变新。请确认 chrome://extensions 里加载的是哪个文件夹。"
    }
  } else {
    Info '  扩展加载路径：未知（该身份的记录里没有加载路径）。'
  }
  # 把本次选择记到 config.json 里当下次平局的参考；写失败也不影响主流程。
  # 安全铁律（v0.3.4，2026-11-21 真机事故：旧写法把 config.json 里保存
  # 的 github_token 弄丢了——runner 重启后报“no github_token”、任务 8
  # 分钟没人接；另：Windows PowerShell 5.1 的 Set-Content -Encoding
  # UTF8 会带 BOM，Node 的 JSON.parse 读到 BOM 会直接报错，同样会让
  # runner 认不出里面的 github_token，所以这里必须无 BOM 写 UTF-8）：
  # (1) 读不到、读到空、解析失败或解析后没有属性时，绝不写，直接放弃，
  # 绝不拿空对象覆盖已有文件；(2) 写之前先备份 config.json.bak；
  # (3) 写临时文件再改名（原子写），写一半崩了也不会截断原文件；
  # (4) 写完读回来核对：原来有的顶层键（尤其 github_token）必须都还
  # 在，少了就从备份恢复。
  try {
    $cfgObj = $null
    $origKeys = @()
    if (Test-Path $configPath) {
      $rawCfg = Get-Content $configPath -Raw -ErrorAction Stop
      if (-not $rawCfg -or -not $rawCfg.Trim()) { throw 'config.json 为空，放弃写入缓存（原文件不动）。' }
      $cfgObj = $rawCfg | ConvertFrom-Json -ErrorAction Stop
      if (-not $cfgObj -or @($cfgObj.PSObject.Properties).Count -eq 0) { throw 'config.json 解析后没有属性，放弃写入缓存（原文件不动）。' }
      $origKeys = @($cfgObj.PSObject.Properties.Name)
      Copy-Item $configPath "$configPath.bak" -Force -ErrorAction Stop
    } else {
      $cfgObj = New-Object PSObject
    }
    $cfgObj | Add-Member -NotePropertyName 'last_chrome_profile' -NotePropertyValue $chosen.ProfileDir -Force
    $tmpCfg = "$configPath.tmp"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmpCfg, ($cfgObj | ConvertTo-Json -Depth 10), $utf8NoBom)
    Move-Item $tmpCfg $configPath -Force -ErrorAction Stop
    $checkObj = Get-Content $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $missingKeys = @($origKeys | Where-Object { $checkObj.PSObject.Properties.Name -notcontains $_ })
    if ($missingKeys.Count -gt 0) {
      if (Test-Path "$configPath.bak") { Copy-Item "$configPath.bak" $configPath -Force }
      Warn "写入缓存后核对发现缺失键（$($missingKeys -join ', ')），已从备份恢复，本次不写缓存。"
    }
  } catch {
    Warn "本次选择没能记入 config.json（$($_.Exception.Message)），不影响使用。"
  }
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
  Warn "没能定位到装了 YixiuBridge 的 Chrome 身份（已扫 $scannedUserDataDirs 个 User Data 目录、$scannedProfiles 个身份，其中 $readablePrefsProfiles 个的 Preferences 可读、$readableSecureProfiles 个的 Secure Preferences 可读；没有哪个身份的 Secure Preferences / Preferences 里含有该扩展，也没有 Local Extension Settings 目录），本次不打开任何浏览器。"
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
