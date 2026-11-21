# YixiuBridge — 通用浏览器桥

让任何支持 MCP 的 AI（Muse、Antigravity、Claude Code、Cursor……）操作你真实登录好的 Chrome 浏览器，并向网页版模型提问、取回答案。100% 本地，数据不出本机。

> English summary: a universal browser bridge. Any MCP-capable AI drives your real, already-logged-in Chrome and asks web models (Gemini web first), with answers returned to the local agent. Local-only, zero npm dependencies.

## 它解决什么问题

本地便宜模型额度大、但智商不够；网页版旗舰模型聪明、额度免费、但看不到你的本地文件。YixiuBridge 是中间的桥：

1. 本地执行者（Muse / Antigravity 里便宜的模型）把难题整理成一份好问题；
2. 桥把问题填进网页版 Gemini，等它答完，把答案抓回来；
3. 本地执行者照单执行，执行前自己跑测试校验。

各模型按所长出力，众人拾柴火焰高；本地额度也省下来了。

## 快速开始

```bash
# 0. 需要 Node.js >= 18，不需要安装任何 npm 包
node --version

# 1. 生成 MCP 配置（写到 ~/.yixiubridge/config.json 并打印出来）
node bin/yixiubridge.mjs install

# 2. 打包插件（把 kernel/ 复制进 extension/，因为 Chrome 只能加载插件目录内的文件）
node scripts/package-extension.mjs

# 3. Chrome 加载插件：chrome://extensions -> 开发者模式 -> 加载已解压的扩展程序 -> 选 extension/ 文件夹

# 4. 启动桥服务（前台运行；另开一个终端）
node bin/yixiubridge.mjs bridge

# 5. 点插件侧边栏里的「复制连接提示词」，粘贴给你的 AI —— 30 分钟配对窗口内第一个连上的 AI 自动受信

# 6. 在 AI 里验证：
#    ping 和 tabs_context 都成功才算接通
# 想让 Muse 直接指挥 Gemini（不用 Antigravity 当中间人），见下面
# 「Muse 直接指挥 Gemini」一节：github-token -> bridge -> runner。
```

## MCP 工具（v0.3.1）

| 工具 | 作用 |
|---|---|
| `ping` | 检查桥和插件是否在线（不占任务锁） |
| `tabs_context` | 列出当前 Chrome 的标签页 |
| `navigate` | 打开网址（只读导航，不提交表单、不花钱） |
| `read_page` | 读当前页标题、URL 和正文摘要 |
| `list_models` | 列出 Gemini 网页版模型菜单：中文标签 + 代号（Hydrogen/Neon/Carbon）+ 是否当前选中 + 是否带锁；不改选择 |
| `ask_gemini` | 向网页版 Gemini 提问，等回答完成取回 `{answer, model, elapsed_ms}`；超时未答完返回 `{status:"pending", task_id}`。可选 `model` 参数（代号或中文标签，如 `Neon` / `日常帮助`，推荐高模型 Neon；带锁的模型会直接报错）和 `thinking` 参数（思考等级，如 `高`） |
| `get_answer` | 按 `task_id` 取回之前提问的结果 |

多 Profile 路由：每个工具都能传 `browser` 参数（Chrome 身份的 id、别名或唯一子串），多个 Chrome 身份同时跑也不会串号。

## Muse 直接指挥 Gemini（v0.2 新增）

Antigravity 先放一边：现在 Muse 自己当控制者，直接指挥网页版 Gemini。Muse 在云端，连不上你电脑本地的桥，所以中间加了一条 GitHub 任务通道——Muse 写任务，你电脑上的小脚本（muse-runner，我的手）定时去取，调桥问 Gemini，答案写回仓库，Muse 再取回来用。

```
Muse（云端） --写任务--> GitHub 私有仓库 tasks/pending/<id>.json
muse-runner（你电脑） --每 60 秒取任务--> 桥 127.0.0.1:8765 --ask_gemini--> Gemini 网页版
muse-runner --写答案--> tasks/done/<id>.answer.json（失败写 tasks/failed/）
Muse（云端） --读答案--> tasks/done/<id>.answer.json
```

任务文件格式（Muse 写）：

```json
{"id": "task_001", "prompt": "用一句话解释什么是黑洞", "model": "Neon", "created_by": "muse", "created_at": "2026-11-21T12:00:00.000Z"}
```

- `model` 可不填，不填默认用 **Neon**（当前账号上已解锁的最高模型；Carbon 带锁，指定它会直接报错）。
- `timeout_ms` 可不填（默认 180000，即 3 分钟；超过 240 秒的提问，runner 会改走任务轮询取回）。

答案文件格式（runner 写）：

```json
{"id": "task_001", "answer": "……", "model": "gemini-web", "elapsed_ms": 6500, "asked_model": "Neon", "answered_model": "Neon", "answered_at": "2026-11-21T12:01:00.000Z"}
```

每天的用量记在 `tasks/log/YYYY-MM-DD.json`（每条任务一行：id、状态、耗时、用的模型）。

### 一次性设置（在你电脑上做一次）

> **现在推荐：直接双击仓库根目录的 `一键启动.bat`**（见下面「一键启动与自动更新」一节）。它会自动完成更新、打包插件、启动桥和 runner、打开装了插件的那个 Chrome。下面的手动命令只在排障时用。

```bash
# 1. 在 GitHub 网页上建一个 classic PAT：
#    Settings -> Developer settings -> Personal access tokens -> Tokens (classic)
#    -> Generate new token (classic)，只勾 scope: repo
# 2. 把令牌存进本地配置（粘贴时不回显，存完不打印，只放本机 config.json）
node bin/yixiubridge.mjs github-token

# 3. 启动桥服务（前台运行；另开一个终端）
node bin/yixiubridge.mjs bridge

# 4. 启动 runner（前台运行；再另开一个终端；默认每 60 秒轮询一次）
node bin/yixiubridge.mjs runner
#    改轮询间隔：node bin/yixiubridge.mjs runner --interval 30
```

之后只要桥、插件、runner 都在跑，Muse 写个任务文件就能指挥 Gemini，不用人盯着。runner 一次只做一个任务（最老的先做）；桥没启动、插件没连上、浏览器正忙时，任务留在原地等下一轮，不会丢；令牌不对会在日志里报 401，不会把令牌打出来。

> 令牌只存在你电脑 `~/.yixiubridge/config.json` 的 `github_token` 字段里（文件权限 0600），只发给 api.github.com。想收回就去 GitHub 网页删掉那个 PAT，或删 config.json 里这一行。详见 [SECURITY.md](SECURITY.md)。

## 一键启动与自动更新（v0.3 新增，v0.3.1 修第 7 步，v0.3.2 改查 Preferences 是错方向，v0.3.3 改回 Secure Preferences）

**v0.3.3 不用再手动更新。** 你电脑里已经有 0.3.2 的一键启动.bat，直接双击它就行：它会下载 0.3.3 覆盖，下载完新版启动脚本自动接管继续执行（一次双击跑完新逻辑；直接跑安装目录脚本时交接跳过的 bug 已修）。之后每次也只需要双击它：检查 Node →（有令牌就）下载最新版覆盖 → 打包插件 → 重启桥 → 启动 runner（更新后空闲时自动重启为新版）→ 打开装了插件的那个 Chrome 到 Gemini。不用再跑命令、不用再手动重载插件、不用再手动下载 ZIP。

v0.3.1 修了第 7 步找 Chrome 的两个 bug：(1) 扫描结果误存在 PowerShell 自动变量 `$matches` 里，被 `-match` 改写成空对象，导致身份名为空、chrome.exe 路径为 Null——现在改用普通变量，且全脚本不再用 `-match`；(2) Chrome 运行时 `Secure Preferences` 可能读不到，旧脚本静默跳过——现在读不到会告警并列出哪些身份读不到，还多了 `Local Extension Settings\<扩展 ID>` 这条证据；一个身份都匹配不到时绝不乱开浏览器。报错也改实话实说了：会写明第几步失败、桥和 runner 各自起了没有。

v0.3.3 更正了第 7 步的证据来源：0.3.2 说解压扩展只记在 `Preferences` 里是错的——Chrome 把扩展安装记录记在 `Secure Preferences`（`extensions.settings.<扩展 ID>`，`location` + `path` 字段）；用户的 Profile 21 的 `Preferences` 文件里根本没有 `extensions.settings` 这个键。现在主证据改回 `Secure Preferences`，`Local Extension Settings\<扩展 ID>` 作补充，`Preferences` 只作弱信号。匹配时还会把 `Secure Preferences` 里的加载路径打印出来，能确认 Chrome 实际加载的是不是更新脚本维护的那份；扫了几个 User Data 目录、几个身份的两个文件各有几个可读也会打印，找不到时从输出就能分清是“读到了、没有 ID”还是“根本读不到”。**破案：0.3.1 扫 72 个身份 0 匹配的原因找到了——之前全仓库用的扩展 ID 是 33 个字符（多了一个 f，看截图时读错的），而 Chrome 扩展 ID 永远是 32 个字符，那个字符串永远匹配不到；真实 ID 是 `alcjfcjfkhfacgofhgoenljfenbcgcel`，Profile 21 的 `Secure Preferences` 里确实有这条记录（location 4，path 正是安装目录），这次更新后应该能直接定位到。**

工作原理：

- `一键启动.bat` 把 `scripts/update-and-start.ps1` 复制到 `%TEMP%` 后再执行——这样解压覆盖仓库文件夹时，不会动到正在运行的脚本自身。下载完如果新版脚本变了，会比对哈希、改用新版脚本继续执行（一次双击跑完新逻辑，不用双击两次）。
- 更新用 GitHub 令牌（只从本机 `~/.yixiubridge/config.json` 读，`Authorization` 头只发给 `codeload.github.com`，绝不打印）下载 main 分支 ZIP；没有令牌就跳过更新、只启动服务，并明说原因。
- 桥的 `/status` 多了一个 `disk_version` 字段，每次调用都现读磁盘上的 `package.json`（不是启动时缓存的版本）。插件 service worker 用 `chrome.alarms` 每 60 秒查一次：如果磁盘版本比插件当前版本新、且不是上次已自动重载过的版本，就调 `chrome.runtime.reload()` 自动重载插件。更新完一分钟内插件自己变成最新版，不用手动重载。
- 重启桥时只停占 8765 端口的 **Node** 进程；如果端口被别的程序占了，不停它、只提示。启动 runner 前先看锁文件对应的进程还活不活着：没在跑就新起一个；在跑、且本次更新过，就只在桥显示空闲（无任务在跑）时重启它，让它跑新代码——有任务在跑或桥没响应时不重启，等下次双击；重启前还等 5 秒复核一次。没更新过时在跑就跳过。

### 多 Chrome 身份：只动装了插件的那一个

用户电脑上有多个 Chrome 身份，Gemini 和 YixiuBridge 只装在其中一个上。一键启动**绝不会**无条件打开默认 Chrome，也**绝不会**杀 chrome.exe、关任何窗口：

1. **绝不写死路径。** 每次运行时动态发现：先找 `chrome.exe`（注册表 App Paths、`(Get-Command chrome).Path`、标准路径，Program Files 与 Program Files (x86) 都查，正式版/Beta/Canary 各通道都查），再扫 `%LOCALAPPDATA%\Google\Chrome\User Data` 下各身份文件夹的 `Secure Preferences`（主证据：Chrome 把扩展安装记录记在这里，`extensions.settings.<扩展 ID>`，`location` + `path` 字段）、`Local Extension Settings\<扩展 ID>` 目录（补充证据）和 `Preferences`（弱信号：有些 Chromium 系浏览器记在这里，Chrome 不记——2026-11-21 真机验证，Profile 21 的 `Preferences` 里根本没有 `extensions.settings` 这个键），找含有扩展 ID `alcjfcjfkhfacgofhgoenljfenbcgcel` 的身份目录名（如 `Profile 21`）。用户随时加新账号、新浏览器也不怕。选中身份时会把匹配证据和扩展加载路径都打印出来。
2. **只开那一个。** 用 `chrome.exe --profile-directory="<找到的目录名>" https://gemini.google.com` 启动；如果该身份的 Chrome 已在运行，这条命令只会把标签页交给已有的那个实例，不会动别的身份。启动前先查已有 `chrome.exe` 进程的命令行是否已含该身份目录，已在运行就不重复开。
3. **多个身份都装了插件时**：优先选已有进程在运行的那个匹配身份；都没在运行就选匹配身份里 `Preferences` 最近修改的那个；选了哪个、为什么都写进日志。上次选中的身份目录会存在 `~/.yixiubridge/config.json` 的 `last_chrome_profile` 里，但**只做平局时的参考**——每次运行都重新扫描，以新扫描结果为准，新加的账号以新结果为准。
4. **定位不到时**：不启动任何浏览器，只完成磁盘更新 + 桥与 runner 的重启，并打印一句清楚的话，让用户自己打开平时用 Gemini 的那个 Chrome。插件靠定时自检会自动重载，任务会等插件连上再做，不会丢。

> 侧边栏显示的本机身份别名（如 `Profile-akm8rx` / `Profile-trz39v`）是每个 Chrome 身份第一次装插件时随机生成的、存在该身份 `chrome.storage.local` 里的 `yixiubridge.profile`，只有重装插件或换 Chrome 身份时才会变——它只是个显示名，更新脚本定位身份时从来不用它，只用稳定的扩展 ID 和身份目录名。

## 项目结构

```
extension/            Chrome MV3 插件（service worker + content script + 侧边栏）
kernel/shared/        协议常量（端口、超时、配对窗口）
kernel/control/host/  MCP 工具目录 —— 两端唯一的事实来源
kernel/adapters/      每个网页模型一个适配器文件（gemini-web.js 是第一个）
host/                 本地桥服务（HTTP+SSE，127.0.0.1:8765）+ MCP stdio 服务器 + 信任注册表 + muse-runner（GitHub 任务通道）
bin/                  命令行：install / config / status / bridge / mcp / pair / github-token / runner
tests/                Node 原生测试：模拟插件 + 模拟 Gemini 页面，无需真浏览器
```

详见 [ARCHITECTURE.md](ARCHITECTURE.md)；安全模型见 [SECURITY.md](SECURITY.md)。

## 测试

```bash
npm test          # Node 原生测试：适配器 + 全链路协议（模拟插件与模拟页面）
npm run check     # node --check 全部 JS 文件
```

## 已知限制（诚实说明）

- **已在真实 gemini.google.com 上验证过**：2026-11-21 在用户真机上跑通，ask_gemini 问答闭环 6.5 秒取回答案。模型菜单是按用户当天截图的真实菜单做的（自动 / 日常帮助 Hydrogen / 更深入的分析 Neon / 代码和复杂工作 Carbon（带锁）+ 思考等级子菜单）；但网页版 UI 随时会改，选择器带多重兜底和明确报错，第一次在真机上跑之后如果菜单变了，需要按实际 UI 调选择器。
- Carbon 在用户账号上带锁（疑似需付费订阅）：指定它会直接报错，不会硬点。
- 网页版 UI 会改：某个站挂了只影响它自己的适配器文件，其他模型不受影响。
- 网页版模型有频率限制，不能高频刷；验证码、登录过期要人来处理，插件不会硬闯。

## 路线图

- v0.2（已做完）：`list_models` + `ask_gemini` 选模型/思考等级 + muse-runner（Muse 经 GitHub 任务通道直接指挥 Gemini）
- v0.3（已做完）：Gemini 发送按钮修复（按 `arrow_upward` 图标定位 + 放宽搜索 + 失败自带诊断）+ 一键更新/启动（双击 `一键启动.bat`）+ 插件自动重载（`disk_version` + alarms 自检）
- v0.3.1（已做完）：修一键启动第 7 步（`$matches` 自动变量 bug、Secure Preferences 读不到时告警 + `Local Extension Settings` 第二证据、找不到身份绝不乱开浏览器、报错按步骤如实汇报）+ 下载后新版脚本自动接管 + **版本自检**（见下）
- v0.3.2（已做完）：修一键启动第 7 步的证据来源（解压扩展不在 Secure Preferences 里，主证据改查 `Preferences` 的 `extensions.settings.<ID>`，location 4 + path；匹配时打印加载路径与匹配证据；扫描统计可自诊）+ 发送按钮找不到时先按回车再报错（回车发出就继续等答案；报错再加箭头图标祖先链诊断）
- v0.3.3（已做完）：修 -006 假阳性（confirmSent 只认正在生成或输入框清空，回答只读真正回答容器、首页提示词永不算答案，收不到回答就报“no response appeared”；回车加固为完整 keydown+keypress+keyup；runner 加幂等守卫，done/failed 已存在就不重复提问）+ 修直接跑安装目录脚本时交接永远跳过的哈希 bug（下载前先算哈希）+ 扫描证据改回 Secure Preferences 为主（0.3.2 改查 Preferences 是错方向，Profile 21 的 Preferences 里根本没有 extensions.settings 键）+ **修扩展 ID 写错（之前全仓库用的 33 字符 ID 多了一个 f，改回 32 位真实 ID `alcjfcjfkhfacgofhgoenljfenbcgcel`——0/72 扫描破案，Profile 21 的 Secure Preferences 里确实有这条记录，location 4，path 正是安装目录）** + 更新后 runner 空闲时自动重启为新版
- v0.4：Claude / ChatGPT 网页版适配器 + 任务路由表（按任务类型选模型）+ 肌肉记忆（重复任务省 token）
- v0.5：接进 Muse 团队 —— 桥服务放 VPS，每位组长一个 Chrome Profile，操作留审计日志

## 版本自检（v0.3.1 新增）

起因：2026-11-21 任务 -003 失败的报错和 0.2.0 一字不差——Gemini 标签页里跑的还是旧适配器，尽管侧边栏显示 0.3.0、标签页也刷新过。Chrome 在插件重载后不会给已开的标签页重注内容脚本，旧适配器就一直跑着，而报错里看不出版本，只能靠猜。

现在不用再猜：

- **每次提问都带版本号**：适配器在每次 `ask` / `list_models` 的返回和报错里都带 `adapter_version`（和发布版本号一致）；失败文件的 `error` 里也会写 `[adapter_version: 0.2.0]`。
- **提问前先握手**：`ask` / `list_models` 之前先 ping 标签页里的内容脚本，同时核对内容脚本版本和适配器版本。版本对不上、或脚本根本不回答（插件重载后旧脚本已失效），就自动刷新该标签页**一次**再试；刷新后还不行才报错，绝不循环刷。
- **runner 日志里写明版本**：每个任务开始前记一行 `bridge v0.3.1 (disk v0.3.1), 1 extension connected — asking task …`；答完（或失败）后把 `adapter_version` 也写进完成文件、失败文件和每日用量日志；桥版本和适配器版本不一样时，日志里明确打一行 `⚠ 版本不一致：bridge v0.3.1，但 Gemini 适配器 v0.2.0 — …请双击 一键启动.bat 更新（或关闭 Gemini 标签页重开一个）后再试。`

如果你在日志或失败文件里看到 `版本不一致`，意思就是：标签页里的适配器是旧的。双击一次 `一键启动.bat`（它会更新并重启桥和 runner，插件一分钟内自动重载），再不行就关掉 Gemini 标签页重开一个。
