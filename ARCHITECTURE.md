# YixiuBridge — 架构（一页纸）

## 三层结构

```
┌──────────────────┐   stdio MCP    ┌──────────────────────┐   SSE 推送    ┌─────────────────────┐
│  AI 客户端        │ ◄────────────► │  host/mcp-server.mjs │               │  插件 service worker │
│  (Muse /          │   JSON-RPC     │  host/bridge-server  │ ◄───────────► │  持久 CDP 附着       │
│   Antigravity /   │                │  127.0.0.1:8765      │   POST 回传   │  + content script    │
│   Claude Code…)   │                └──────────────────────┘               └─────────────────────┘
└──────────────────┘                                                              │ 操作真实页面
                                                            ┌─────────────────────┴──────────────┐
                                                            │ gemini.google.com（已登录的 Chrome）│
                                                            └────────────────────────────────────┘
```

零依赖：只用 Node 内置模块 + 原生 JS，不装任何 npm 包。

| 层 | 文件 | 职责 |
|---|---|---|
| 插件后台 | `extension/background/` | 桥客户端（SSE/POST）、CDP 调试器管理、工具路由 |
| 页面脚本 | `extension/content/gemini-content.js` | 常驻 Gemini 页，跑适配器、填问题、等回答、回传结果 |
| 适配器 | `kernel/adapters/gemini-web.js` | Gemini 网页版的选择器 + 完成检测（停止按钮消失 + 文本 2 秒不变） |
| 侧边栏 | `extension/sidepanel/` | 配对提示词、状态、当前控制者、Profile 别名 |
| 本地宿主 | `host/` + `bin/` | MCP stdio 服务器 + HTTP/SSE 桥 + 信任注册表 + CLI |
| 任务通道 | `host/muse-runner.mjs` | 轮询 GitHub tasks/pending，调桥问 Gemini，答案写回 tasks/done（见上节） |
| 共享 | `kernel/shared/constants.js`、`kernel/control/host/tools.js` | 协议常量、工具目录（两端唯一的事实来源） |

## 工具目录是唯一的事实来源

`kernel/control/host/tools.js` 定义全部 7 个 MCP 工具（`ping`、`tabs_context`、`navigate`、`read_page`、`list_models`、`ask_gemini`、`get_answer`）。MCP 服务器用它生成 `tools/list`，插件后台用它校验 `tool_call`。加工具只改这一个文件，两边自动同步。

## 一次 ask_gemini 的完整链路

```
AI --tools/call--> MCP server --POST /call--> bridge --SSE tool_call--> 插件
插件：找/开 gemini.google.com 标签页 -> content script 跑适配器
  适配器：选模型（可选：开模型菜单 -> 点中目标 -> 校验顶部按钮文字含代号；
        带锁的模型不点，直接报错；不选就用页面当前模型）
        -> 找输入框（多重选择器兜底）-> 填问题（原生 setter + input 事件）
        -> 点发送 -> 每 500ms 检查：停止按钮消失 且 文本 2 秒不变 = 答完
        -> 取最后一段回答
插件 --POST /result--> bridge --MCP 响应--> AI
```

如果答案在 `timeout_s` 内没出完，返回 `{status:"pending", task_id}`，任务继续在后台跑；跑完后插件主动 POST `/task-update`，AI 用 `get_answer(task_id)` 取回。

## 模型选择（v0.2）

菜单结构来自用户 2026-11-21 的真实截图（中文界面）：自动 / 日常帮助（Hydrogen）/ 更深入的分析（Neon，当前选中）/ 代码和复杂工作（Carbon，带锁）+ 思考等级子菜单。顶部切换按钮显示当前模型，如「Neon 高」（模型名 + 思考等级），所以选择校验只用子串匹配，绝不用全等。

- `list_models`：开菜单、读条目、关菜单，不改选择。返回每项的中文标签、代号、是否选中、是否带锁。
- `ask_gemini` 的 `model` 参数：按代号（`Neon`）或中文标签（`日常帮助`）匹配；不传就用页面当前模型。推荐高模型是 Neon（当前账号上已解锁的最高项）。
- 带锁的模型（Carbon）永远不点：直接报错，列出未上锁的选项。
- 切换模型可能在 Gemini 网页版里开启新对话；`ask_gemini` 每次都是独立提问，不依赖历史，所以不受影响。

## 发送按钮发现（v0.3）

2026-11-21 真机上的一次失败：模型已选好 Neon、问题已填进输入框、蓝色发送箭头肉眼可见且可用，但适配器报 `send button not found`。用户右键检查给出的真实结构是关键：发送按钮是 Angular Material 按钮，**本身没有能命中的 aria-label**，里面装了一个 `<mat-icon data-mat-icon-name="arrow_upward" fonticon="arrow_upward">`。之前的 7 个选择器全靠 aria-label，所以全 miss。

`kernel/adapters/gemini-web.js` 的 `findSendButton(boxEl)` 现在是分层发现，返回 `{el, selector, candidates}`：

1. **图标优先**：`[data-mat-icon-name*="arrow_up"]`（兜底 `[fonticon*="arrow_up"]`）定位图标，取 `.closest('button')`（Fake DOM 里有 `closest` 的兜底实现）；
2. 原来的 7 个选择器（aria-label / data-test-id / class）；
3. 放宽搜索：`title` 含发送/Send/提交/Submit、`aria-label` 含提交/Submit、`data-test-id` 含 send、`class` 含 send；
4. `role="button"` 且文字像发送；
5. 按钮里的内联 SVG 箭头图标。

多个候选时按可见 > 可用 > 离输入框最近排序；只剩不可用候选时也返回它，让 `ask()` 明确报错「按钮不可用」而不是「找不到」。选模型后 `ask()` 先关模型菜单（Esc，必要时点回模型切换按钮）再等 300ms 让 DOM 稳定下来，然后才找输入框和发送按钮——菜单没关干净时按钮可能被遮住或重渲染。

**失败自带诊断**：找不到按钮时，错误里除了列出试过的所有选择器，还附上输入框附近最多 10 个按钮的 dump（每个：标签、aria-label、title、class、data-test-id、role、图标名、可见文字、是否不可用，按离输入框由近到远排；一个按钮都没有就明说）。下次再失败，不用用户再右键检查，报错本身就能定位。

## 一键更新与自动更新（v0.3）

```
双击 一键启动.bat
  -> 把 scripts/update-and-start.ps1 复制到 %TEMP% 后执行（脚本自身不被覆盖）
  -> 检查 node；读 ~/.yixiubridge/config.json 的 github_token
  -> 用令牌从 codeload.github.com 下载 main 分支 ZIP，解压覆盖安装目录
  -> node scripts/package-extension.mjs（重新打包插件）
  -> 重启桥（只停 8765 端口上的 Node 进程）、启动 runner（锁文件进程活着就跳过）
  -> 定位装了插件的 Chrome 身份，只开那一个到 gemini.google.com（见下节）
```

- 桥的 `/status` 返回 `disk_version`：每次调用都现读磁盘上的 `package.json`，不是启动时缓存的版本。
- 插件 service worker 的 1 分钟 `yixiubridge-keepalive` alarm 每次也调 `checkForUpdate()`：取 `/status`，用 `kernel/shared/constants.js` 的 `compareSemver` 比较 `disk_version` 和 `chrome.runtime.getManifest().version`，磁盘更新、且不等于 `chrome.storage.local` 里记的 `yixiubridge.lastAutoReloadVersion` 时，记下版本再 `chrome.runtime.reload()`。正在跑任务时跳过检查，避免中途重载。
- `extension/background/router.js` 的 `_pingContentScript` 会回报内容脚本的版本（`CONTENT_VERSION`）：版本缺失或不符就是 stale，`_ensureGeminiTab` 会重载一次 Gemini 标签页再继续；重载后还 stale 就明确报错。Chrome 重载插件时不会重新注入旧标签页的内容脚本，这一步就是为它准备的。

## 多 Chrome 身份定位（v0.3，`scripts/update-and-start.ps1` 步骤 7）

只动装了 YixiuBridge 扩展的那一个 Chrome 身份，绝不写死路径：

- **发现 chrome.exe**：注册表 App Paths（HKLM + HKCU）→ `(Get-Command chrome).Path` → 标准路径（Program Files / Program Files (x86) / LOCALAPPDATA，正式版、Chrome Beta、Chrome SxS 各通道都查）。按 exe 路径推断它用的 User Data 目录（Beta → `Google\Chrome Beta\User Data`，SxS → `Google\Chrome SxS\User Data`，其余 → `Google\Chrome\User Data`）；同一个 User Data 目录只扫一次。
- **定位身份**：扫各身份文件夹（`Default`、`Profile N`）的 `Secure Preferences`，找含有扩展 ID `alcjfcjfkfhfacgofhgoenljfenbcgcel` 的身份目录名。当前装插件+Gemini 的是 `Profile 21`，但脚本里**不写死**这个名字，每次运行重新发现。
- **多个匹配时的选择**：优先选已有 `chrome.exe` 进程在运行的那个匹配身份（查 `Win32_Process` 的命令行是否含 `--profile-directory="<目录名>"`）；都没在运行就选 `Preferences` 最近修改的那个；修改时间相同（或都没有）时参考 `config.json` 里的 `last_chrome_profile`（上次选中的身份，只做平局参考，每次都重新扫描、以新结果为准）。选了哪个、为什么写进日志。
- **只开那一个**：`chrome.exe --profile-directory="<目录名>" https://gemini.google.com`；已在运行就把标签页交给已有实例。**绝不杀 chrome.exe、绝不关任何窗口。** 定位不到就不启动任何浏览器，只完成磁盘更新 + 桥与 runner 的重启，并打印清楚的话让用户自己打开平时用 Gemini 的那个 Chrome。

## Muse 直接指挥 Gemini（v0.2，GitHub 任务通道）

```
Muse（云端） --PUT tasks/pending/<id>.json--> GitHub 私有仓库
muse-runner（用户电脑，常驻） --每 60 秒 GET tasks/pending--> GitHub
muse-runner --POST /call ask_gemini--> 桥 127.0.0.1:8765 --> 插件 --> Gemini 网页版
muse-runner --PUT tasks/done/<id>.answer.json + DELETE pending--> GitHub
Muse（云端） --GET tasks/done/<id>.answer.json--> GitHub
```

- 任务：`{"id","prompt","model"?, "timeout_ms"?, "created_by":"muse","created_at"}`。不填 `model` 默认 Neon。
- 一次只做一个任务，最老的先做；格式坏的任务进 `tasks/failed/`，不卡住队列。
- 桥没起、插件没连、浏览器正忙：任务留在原地等下一轮，不丢。
- 单次 ask 超过 240 秒走桥的任务轮询（GET `/tasks/:id`），因为桥的一次调用上限是 300 秒。
- 每天的用量记在 `tasks/log/YYYY-MM-DD.json`（id、状态、耗时、模型）。
- runner 只认 `~/.yixiubridge/config.json` 里的 `github_token`；令牌只发给 api.github.com，永不打印。runner 是用户亲手启动的本地可信客户端（clientId `muse-runner/<版本>`），不走 MCP 配对窗口——它根本不是 MCP 客户端。

## 配对流程（30 分钟窗口）

```
用户点侧边栏「复制连接提示词」
  -> 插件 POST /pair/start，桥打开 30 分钟窗口
  -> 用户把提示词粘贴给 AI
  -> AI 按提示词配好 MCP 并 initialize
  -> 桥检查信任：未知客户端 + 窗口未过期未被用 -> 自动信任，窗口被消费
  -> 之后该客户端直连；未知客户端 + 无窗口 -> "not authorized"
```

信任存在 `~/.yixiubridge/trust.json`，按客户端 id（名字+版本）隔离；删掉一行就是撤销。

## 任务锁（一次只允许一个控制者）

桥里只有一个 `controller` 槽。`ping` 和 `get_answer` 不占锁；其他工具调用时：空闲 -> 占锁、执行、释放；正忙且是别人 -> 立即返回 `browser busy` 错误，不排队、不抢占。切换控制者只能等空闲。

## 多 Profile 路由

每个 Chrome 身份都装插件、都连同一个桥，各自上报 `{id, label}`（默认 `Profile-xxxxxx`，侧边栏可改别名）。每个工具的 `browser` 参数按 id / 别名 / 唯一子串匹配；不传就走第一个连上的。匹配到多个会报错让 AI 先问清楚。

侧边栏显示的 Profile 别名（如 `Profile-akm8rx` → `Profile-trz39v`）是每个 Chrome 身份第一次装插件时随机生成的（`Profile-` + 6 位随机字符），存在该身份 `chrome.storage.local` 的 `yixiubridge.profile` 里；只有重装插件（存储被清）或换 Chrome 身份时才会变，不是生成 bug。一键更新脚本定位身份时从来不用这个别名，只用稳定的扩展 ID 和身份目录名。
