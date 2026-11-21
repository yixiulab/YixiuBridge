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

## MCP 工具（v0.3.0）

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

## 一键启动与自动更新（v0.3 新增）

**这次是最后一次手动更新。** 更新到 0.3.0 之后，以后每次只需要双击仓库根目录的 **`一键启动.bat`**，它会自己完成：检查 Node →（有令牌就）下载最新版覆盖 → 打包插件 → 重启桥 → 启动 runner → 打开装了插件的那个 Chrome 到 Gemini。不用再跑命令、不用再手动重载插件。

工作原理：

- `一键启动.bat` 把 `scripts/update-and-start.ps1` 复制到 `%TEMP%` 后再执行——这样解压覆盖仓库文件夹时，不会动到正在运行的脚本自身。
- 更新用 GitHub 令牌（只从本机 `~/.yixiubridge/config.json` 读，`Authorization` 头只发给 `codeload.github.com`，绝不打印）下载 main 分支 ZIP；没有令牌就跳过更新、只启动服务，并明说原因。
- 桥的 `/status` 多了一个 `disk_version` 字段，每次调用都现读磁盘上的 `package.json`（不是启动时缓存的版本）。插件 service worker 用 `chrome.alarms` 每 60 秒查一次：如果磁盘版本比插件当前版本新、且不是上次已自动重载过的版本，就调 `chrome.runtime.reload()` 自动重载插件。更新完一分钟内插件自己变成最新版，不用手动重载。
- 重启桥时只停占 8765 端口的 **Node** 进程；如果端口被别的程序占了，不停它、只提示。启动 runner 前先看锁文件对应的进程还活不活着，活着就跳过。

### 多 Chrome 身份：只动装了插件的那一个

用户电脑上有多个 Chrome 身份，Gemini 和 YixiuBridge 只装在其中一个上。一键启动**绝不会**无条件打开默认 Chrome，也**绝不会**杀 chrome.exe、关任何窗口：

1. **绝不写死路径。** 每次运行时动态发现：先找 `chrome.exe`（注册表 App Paths、`(Get-Command chrome).Path`、标准路径，Program Files 与 Program Files (x86) 都查，正式版/Beta/Canary 各通道都查），再扫 `%LOCALAPPDATA%\Google\Chrome\User Data` 下各身份文件夹的 `Secure Preferences`，找含有扩展 ID `alcjfcjfkfhfacgofhgoenljfenbcgcel` 的身份目录名（如 `Profile 21`）。用户随时加新账号、新浏览器也不怕。
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
- v0.4：Claude / ChatGPT 网页版适配器 + 任务路由表（按任务类型选模型）+ 肌肉记忆（重复任务省 token）
- v0.5：接进 Muse 团队 —— 桥服务放 VPS，每位组长一个 Chrome Profile，操作留审计日志
