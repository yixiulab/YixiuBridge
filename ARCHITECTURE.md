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

`kernel/control/host/tools.js` 定义全部 8 个 MCP 工具（`ping`、`tabs_context`、`navigate`、`read_page`、`list_models`、`ask_gemini`、`get_answer`、`recover_last_answer`）。MCP 服务器用它生成 `tools/list`，插件后台用它校验 `tool_call`。加工具只改这一个文件，两边自动同步。

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

**找不到按钮时先按回车（v0.3.2）**：2026-11-21 任务 -005 的报错终于带上了 `[adapter_version: 0.3.1]`（新适配器已在标签页里跑），但分层搜索全试过仍找不到按钮，26 个按钮的 dump 里也没有发送箭头——可见的蓝色箭头根本不是 `<button>`（可能是带点击处理的 div/自定义元素，或在 shadow root 里）。所以 `ask()` 在找不到按钮时不再直接报错：先对输入框按一次回车（已有的 `dispatchEnter`），再用已有的 `confirmSent` 验证是否发出；发出就和点按钮成功一样继续等答案；回车也没发出才报错（注明「按钮未找到，回车也未发出」）。

**回车验证的假阳性（v0.3.3，任务 -006）**：0.3.2 的回车 fallback “成功”了，但答案是 Gemini 首页的提示词（“需要我为你做些什么？/ 考考我莎士比亚的知识……”）——消息根本没发出。根因是 `confirmSent` 的第三条证据“回答文字变了”：首页回车后重渲染，提示词文字一变就被当成“已发出”；`waitForCompletion` 又把首页文字当答案稳定返回。三层修复：(1) `confirmSent` 只认强证据——正在生成（Stop 按钮在）或输入框已清空，文字变化永不算数；(2) `getLatestResponseText` 只读真正回答容器（优先限定在 conversation 容器内），首页 hero 问候和建议 chips 一律过滤，首页无对话时返回空；(3) `waitForCompletion` 以填问题前拍的基线为准，只认基线之后新出现/变化的回答文字，从未出现新文字就报明确的 `gemini no response appeared`（带 adapter_version），永不把首页文字当答案。`dispatchEnter` 同时加固：先 focus 输入框，再发完整 keydown + keypress + keyup（key/code 'Enter'、keyCode 13、bubbles、cancelable）到可编辑元素本身。`tests/home-screen.test.mjs` 用首页 mock 覆盖了这四种情形：回车不提交就快速失败、只变文字不算发出、输入框清空却无回答就报 no response appeared、回车真提交就端到端成功。

**回答检测按真实结构走（v0.3.6，任务 -009）**：-009 的问题已发出、Gemini 已回答（用户截图为证），适配器却报 `gemini no response appeared`。根因在作用域，不在回答选择器本身：`responseScope()` 用 `[data-test-id="conversation"]` 当对话容器，但真实页面上这个选择器匹配的是**侧边栏对话列表的链接**（`a[data-test-id="conversation"]`，每条保存的对话一个），所以 0.3.3 起每次回答查询都在一条 20 来字的侧边栏链接里找回答，当然什么都找不到；而 mock 自己发明了这个选择器当对话容器，测试从没发现。修复：(1) 作用域改成真实历史容器 `infinite-scroller.chat-history` / `[data-test-id="chat-history-container"]`，再退 `main` / `body`；(2) 回答检测分层——第一层按真实结构找每轮的 `<model-response>` 及其内层 markdown（`structured-content-container.model-response-text > .markdown.markdown-main-panel`，每轮一个 `div.conversation-container`），第二层是旧的 `.model-response-text` / `[class*="response-content"]` / `[class*="markdown"]` / `message-content` 兜底；(3) 一轮只取最内层文字（leaf-most：`model-response` 本身在其内层 markdown 存在时被丢掉，避免一轮返回两次文字）；(4) 结果按文档顺序排，不按选择器分组排，否则旧轮的兜底元素会排到新轮的结构元素后面、`getLatestResponseText` 会取错。首页守卫不变（hero 提示词永不算答案，侧边栏标题匹配不到任何一层）。`tests/real-structure.test.mjs`（新增）用真实结构 mock 覆盖：-009 复现（代码块答案完整返回）、Neon 选模型 + 检测、侧边栏标题永不算回答、一轮只出一份文字、多轮取最新、带侧边栏的首页仍返回空。`tests/mock-gemini-page.html` 也改成了真实结构。Fake DOM 的标签解析顺带修了自定义元素：标签名允许连字符（`model-response`、`user-query`、`infinite-scroller`、`structured-content-container` 之前解析失败、选择器被静默跳过）。

**失败自带对话结构诊断（v0.3.6）**：`waitForCompletion` 报 `no response appeared` 时，错误里追加一段对话结构 dump（约 2000 字符上限）：各响应形元素的个数（`model-response` / `user-query` / `div.conversation-container` / `.markdown` / `.model-response-text` / `message-content`）、正在用的作用域、最后最多 3 轮的形状（标签、类名、data-test-id、role、子元素标签、约 60 字文字片段）。只写结构，不写整页文字、不写答案本身。下次再 miss，失败文件本身就能说明是哪一层漏了，不用再问用户截图。

## 一键更新与自动更新（v0.3）

```
双击 一键启动.bat
  -> 把 scripts/update-and-start.ps1 复制到 %TEMP% 后执行（脚本自身不被覆盖）
  -> 检查 node；读 ~/.yixiubridge/config.json 的 github_token
  -> 用令牌从 codeload.github.com 下载 main 分支 ZIP，解压覆盖安装目录
  -> node scripts/package-extension.mjs（重新打包插件）
  -> 重启桥（只停 8765 端口上的 Node 进程）、启动 runner（没在跑就新起一个；在跑、且本次更新过，只在桥显示空闲时重启它跑新代码——有任务在跑或桥没响应时不重启，等下次双击）
  -> 定位装了插件的 Chrome 身份，只开那一个到 gemini.google.com（见下节）
```

- **自我更新交接（v0.3.3 修 bug）**：下载完如果新版脚本变了，旧脚本比对哈希、改用新版脚本继续执行（`-SkipUpdate -Updated` 接管，不重复下载）。哈希必须拿**下载前**算好的那份比——直接跑安装目录里的脚本时，运行中的脚本和安装目录里的脚本是同一个文件，下载后再算哈希永远相等，交接永远跳过（2026-11-21 真机验证：下载了 0.3.2，却一直跑 0.3.1 的逻辑）。

- **runner 更新后重启（v0.3.4 修）**：0.3.3 的 `-Updated` 开关在真机上失效了——17:17 那次双击实际跑的是下载前的 0.3.2 脚本（交接还没发生），它没有 `-Updated` 可传，新脚本就以 `$updateHappened = $false` 跑完，只打印“runner 已在运行，跳过。”，侧边栏一直显示旧版 `muse-runner/0.3.0`。v0.3.4 改用文件时间兜底：`host\muse-runner.mjs`、`kernel\shared\constants.js` 任一文件比 runner 进程启动时间晚，就判它跑的是旧版，空闲时重启。每次双击都会重新解压、文件时间刷新，所以即使没发新版也可能判“旧”而重启一次——无害（空闲时才重启，任务在跑时不动）。

- **锁文件与心跳（v0.3.4，任务 -008）**：runner 死掉后锁文件 `muse-runner.lock` 留在原地，旧逻辑只看锁文件里的 PID 活不活——PID 被复用时还会误判“在运行”，新 runner 永远起不来，-008 八分钟没人接。v0.3.4 改成心跳证明活着：活着的 runner 每 30 秒刷新 `muse-runner.heartbeat`（`{pid, at}`）；锁 PID 死了直接接管；PID 活着但心跳超过 3 分钟没刷新（挂住、旧版没心跳、或 PID 被复用）也接管，并在日志里写明原因；只有心跳新鲜才拒绝启动。锁文件本身保持“第一行就是裸 PID”的格式不变（第 6 步的 PowerShell 靠 `^\d+$` 读它）。第 6 步同样只认进程：锁文件存在不算数，锁文件里的 PID 必须是活着的 node 进程才算“runner 在运行”。接管时不杀旧进程——停一个挂住的 runner 是更新脚本的事（它先核对进程名再停），短暂双 runner 时桥的控制者锁 + 幂等守卫会拦住重复提问。

- **runner 日志写文件（v0.3.4）**：runner 是最小化启动的，死掉/卡住时没有任何窗口可看。`runRunner` 的每条日志现在同时追加到 `~/.yixiubridge/muse-runner.log`（1 MiB 时轮转成 `.log.1`），一键启动第 6 步结束时也会把这个路径打印出来。

- **config.json 保护（v0.3.4，真机事故）**：2026-11-21 17:17 一键启动的第 7 步把本次选中的 Chrome 身份写进 `config.json` 当缓存时，把里面保存的 `github_token` 弄丢了——runner 一直在内存里用旧令牌所以没感觉，直到它死掉、重启时才报“no github_token”，-008 因此八分钟没人接。旧写法的两个毛病：(1) 读/解析失败就拿空对象覆盖原文件；(2) Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会带 BOM，Node 的 `JSON.parse` 读到 BOM 直接报错，令牌明明在文件里、runner 也认不出来。v0.3.4 四层防护：读不到/读到空/解析失败/解析后没有属性时直接放弃写，绝不覆盖已有文件；写之前先备份 `config.json.bak`；写临时文件再 `Move-Item` 原子改名；用 `UTF8Encoding($false)` 无 BOM 写 UTF-8；写完读回来核对原来有的顶层键（尤其 `github_token`）都在，少了就从备份恢复。`host/muse-runner.mjs` 的 `loadConfig` 也容忍开头的 BOM，`saveConfig` 改成临时文件 + 改名的原子写（它本来就是合并式写入，不会丢字段）。

- 桥的 `/status` 返回 `disk_version`：每次调用都现读磁盘上的 `package.json`，不是启动时缓存的版本。
- 插件 service worker 的 1 分钟 `yixiubridge-keepalive` alarm 每次也调 `checkForUpdate()`：取 `/status`，用 `kernel/shared/constants.js` 的 `compareSemver` 比较 `disk_version` 和 `chrome.runtime.getManifest().version`，磁盘更新、且不等于 `chrome.storage.local` 里记的 `yixiubridge.lastAutoReloadVersion` 时，记下版本再 `chrome.runtime.reload()`。正在跑任务时跳过检查，避免中途重载。
- `extension/background/router.js` 的 `_pingContentScript` 会回报内容脚本的版本（`CONTENT_VERSION`）**和适配器版本**（`ADAPTER_VERSION`，内容脚本从适配器文件读）：两个版本缺失或不符就是 stale；脚本答了但不认识 ping（pre-0.3.0 的旧脚本）也是 stale；脚本根本不回答（插件重载后旧脚本已失效）同样触发。`_ensureGeminiTab` 遇到 stale 或无应答时重载一次 Gemini 标签页再继续，重载后还 stale/无应答就明确报错，绝不循环刷。Chrome 重载插件时不会重新注入旧标签页的内容脚本，这一步就是为它准备的——2026-11-21 的 -003 任务就是旧适配器在标签页里继续跑、报错却和 0.2.0 一字不差，才加了这层自检。
- **版本自检（v0.3.1）**：适配器的每次 `ask` / `listModels` 返回和报错都带 `adapter_version`（`kernel/adapters/gemini-web.js` 的 `ADAPTER_VERSION`，和发布版本号一致，测试里会核对五处版本一致）；router 把它存进任务对象，`ask_gemini` 失败时以 `[adapter_version: X]` 的形式写进报错字符串（桥的报错通道是纯文本，版本号只能这样带过去）；runner 在每次提问前记桥的版本（`/status` 的 `version` + `disk_version`），答完把 `adapter_version` 写进完成/失败文件和每日日志，两者不一致时在日志里打一行 `⚠ 版本不一致` 并提示双击一键启动更新或重开标签页。

## 多 Chrome 身份定位（v0.3，`scripts/update-and-start.ps1` 步骤 7）

只动装了 YixiuBridge 扩展的那一个 Chrome 身份，绝不写死路径：

- **发现 chrome.exe**：注册表 App Paths（HKLM + HKCU）→ `(Get-Command chrome).Path` → 标准路径（Program Files / Program Files (x86) / LOCALAPPDATA，正式版、Chrome Beta、Chrome SxS 各通道都查）。按 exe 路径推断它用的 User Data 目录（Beta → `Google\Chrome Beta\User Data`，SxS → `Google\Chrome SxS\User Data`，其余 → `Google\Chrome\User Data`）；同一个 User Data 目录只扫一次。
- **定位身份**：扫各身份文件夹（`Default`、`Profile N`）的 `Secure Preferences`（主证据：Chrome 把扩展安装记录记在这里，`extensions.settings.<扩展 ID>`，`location` + `path` 字段）、`Local Extension Settings\<扩展 ID>` 目录（补充证据）和 `Preferences`（弱信号：有些 Chromium 系浏览器记在这里；Chrome 不记——2026-11-21 真机验证，Profile 21 的 `Preferences` 里根本没有 `extensions.settings` 这个键，0.3.2 改查 Preferences 是错方向，0.3.3 已改回），找含有扩展 ID `alcjfcjfkhfacgofhgoenljfenbcgcel` 的身份目录名；匹配时把 `Secure Preferences`（没有就从 `Preferences`）里的加载路径打印出来，能确认 Chrome 实际加载的是不是更新脚本维护的那份。当前装插件+Gemini 的是 `Profile 21`，但脚本里**不写死**这个名字，每次运行重新发现。扫描还会打印 User Data 目录数、身份数和两个文件各自可读的身份数，找不到时从输出就能分清是“读到了、没有 ID”还是“根本读不到”。破案：0.3.1 扫 72 个身份 0 匹配的原因是扩展 ID 写错了——之前用的 `alcjfcjfkfhfacgofhgoenljfenbcgcel` 是 33 个字符（多了一个 f，看截图时读错的），Chrome 扩展 ID 永远是 32 个字符；真实 ID 是 `alcjfcjfkhfacgofhgoenljfenbcgcel`，Profile 21 的 `Secure Preferences` 里确实有这条记录（location 4，path 正是安装目录），0.3.3 应能直接定位到。**v0.3.5 补充**：只在文本里含有 ID 不算“已确认”——Chrome 还在 `protection/macs` 里给每个扩展留完整性哈希（ID 作键），记录删了哈希还会留着，子串搜索会把已卸载的身份也算成匹配（0.3.4 真机扫出 2 个匹配、错选 Profile 18 的根因之一）。已确认 = ID 是 `extensions.settings` 的一个键，或有 `Local Extension Settings\<ID>` 目录；只有已确认的才优先选，一个都没有时才退回未确认的，并在输出里明说。加载路径也只来自该 ID 自己的 `extensions.settings` 记录（JSON 按 ID 取键；解析失败才用正则，且只在该记录自己的花括号里找——旧正则兜底没有入口边界，会跨过边界抓隔壁扩展的路径，0.3.4 真机打印了内置 network_speech_synthesis 的路径）；找不到就打印“未知”，绝不拿别的扩展的路径顶替。扫描结果还会写明几个是已确认的。
- **多个匹配时的选择（v0.3.5 改顺序）**：先只在已确认的匹配里选——(a) 优先选已有 `chrome.exe` 进程在运行的那个（查 `Win32_Process` 的命令行；旧判断要求原样含 `--profile-directory="<目录名>"`，但浏览器进程只有最初就是这么启动时才带这个标记，已在运行的 Chrome 里再开身份窗口时没有任何进程带它，判断永远落空——现在放宽了：`=`/空格、引号可有可无、完整路径里的身份目录段也认，`Profile 2` 绝不会误 match `Profile 21`；找不到时只退回后面的规则，绝不当成“没在运行”的证据）；(b) 再优先选加载的扩展正是本机维护那一份的（加载路径与安装目录一致）；(c) 再选 `Preferences` 最近修改的那个；(d) 修改时间相同（或都没有）时参考 `config.json` 里的 `last_chrome_profile`（上次选中的身份，只做平局参考，每次都重新扫描、以新结果为准）。选了哪个、为什么写进日志。第 7 步还会去问桥当前连着几个扩展（只作诊断参考：桥认扩展靠每个身份随机生成的别名，对不回身份目录名，所以不能用来选身份；个数和扫描结果对不上时，输出里能看出来）。
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
- **没插件时 runner 自己开 Chrome（v0.3.7，任务 -010）**：2026-11-21 0.3.6 更新后，19:10 双击一键启动重启了桥，19:11–19:23 runner 每分钟都记“桥通着但没有插件连着”，却什么也没做，环路一直卡着，直到用户 19:27 手动打开 Profile 21 的 Chrome、插件重连，-010 才 43 秒答完。Chrome 关着还是 service worker 没醒，凭当时的日志分不出来——.bat 的控制台输出没留存；但能确定的是缺口：没有任何一个常驻部件会自己恢复。修法：runner 是唯一常驻的部件，有 pending 任务且桥上 0 个插件时，它自己用 `chrome.exe --profile-directory=<身份> https://gemini.google.com` 把浏览器打开（detached，不等它退出）。身份定位复用 chrome-discovery.js 的已确认优先规则（扩展 ID 必须是 `extensions.settings` 的键，或有 `Local Extension Settings/<ID>` 目录；只在文本里出现、如 protection/macs 里的旧哈希，不算已确认、排在已确认的后面；上次选中的 `last_chrome_profile` 是已确认匹配时优先）。节流：同一任务最多开 3 次、每次间隔至少 3 分钟；桥没起时不开；没任务等着时也不开（绝不无故弹浏览器窗口）。开 Chrome 失败不影响任务——任务照旧留 pending。插件侧同时加固：service worker 启动时也建一次 keepalive alarm（`chrome.runtime.reload()` 后 onStartup 不一定触发，没 alarm 的 worker 挂起后永远醒不过来重连）。注意：0.3.7 本身仍需一次双击一键启动才能装上（更新器就是靠双击分发的），装上之后再遇到桥重启没插件，就不用用户手动开 Chrome 了。
- **幂等守卫（v0.3.3）**：runner 先写 `tasks/done/<id>.answer.json`（或失败写 `tasks/failed/`），再删 `tasks/pending/` 里的任务文件。两步之间如果 runner 被停掉（或桥重启），下一轮会看到同一个 pending 任务——守卫先查 done/failed 是否已存在，存在就只删 leftover pending 文件，**不再问 Gemini 第二遍**，已有的答案/失败文件原样不动。问之前先守卫，桥没起时也照样清理。
- **长答案轮询（v0.3.4，任务 -007）**：-007 失败不是因为没发出去——用户截图证明问题已经发出、Gemini 也答完了整段番茄钟代码，只是生成时间超过了 runner 的 240 秒上限，runner 就写了失败文件，答案白白躺在标签页里。根因是桥自己的调用定时器（`timeout_s + 60`）超时时只报一句不带 task_id 的裸错，runner 拿不到 id 就没法找回答案。修复分三层：(1) 插件 router 在提问开始时就把 `{status: 'running'}` 的任务登记到桥的任务库（`/task-update`）；(2) 桥超时时如果已经知道 task_id，就按文档里的 pending 形状返回 `{status: 'pending', task_id}` 而不是裸错（`askTimeoutSlackS` 只给测试用，生产默认值不变）；(3) runner 拿到 pending + task_id 后不再写失败文件，而是每 15 秒轮询 `get_answer(task_id)`，从提问开始算最长等 15 分钟，答出来写 done、真报错写 failed、超时也写 failed——失败文件里永远带 `bridge_task_id`，事后还能手动找回答案。桥没起、没插件、浏览器正忙这类“还没开始”的失败不受影响，照旧留 pending 或写失败。
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

## 在线更新（v0.4.0）

**模块**：`host/online-updater.mjs`（纯函数 + 注入的 fetch/exec/fs，全部可测）。`checkForUpdate` 读远端 `package.json` 比版本；`planUpdate` 拉 main 的 git tree、按本地文件 SHA 算出要改/要新增的清单（`extension/kernel/` 跳过——它是打包产物）；`applyUpdate` 逐文件下载并核对 git blob SHA、staging 目录里 `node --check` + JSON 校验、备份只备份被改的文件（最多留 2 个备份）、再逐文件原子替换；`rollback` 恢复备份并删掉本次新增的文件（Gemini 初稿漏了这一步：新增文件回滚后会残留，Muse 审出后修掉）；`isStableRelease` 查 `builds/builds.json`——只有 channel 是 `stable` 的版本才算稳定版，索引读不到就按“不稳定”处理（fail closed）。

**runner 接入**：`runIdleOnlineUpdate`（`host/muse-runner.mjs`）。只在轮询结果是 `empty`（没有任何待处理任务）且距上次检查满 1 小时才跑；主循环是严格串行的，所以更新永远不可能和提问重叠，不需要互斥标志。流程：确认桥通且插件连着 → 查更新 → 是稳定版才继续 → plan + apply → `host/bridge-restart.mjs` 重启桥（Windows 上用 `netstat -ano` 找 LISTENING 在 :8765 的 PID，`tasklist` 确认是 `node.exe` 才 `taskkill`，再 detached 起新桥，60 秒内验 `/status` 的 version；非 Windows 只写文件不重启桥）→ 失败就 rollback 并拉起旧桥 → 改动里有 `host/muse-runner.mjs` 或 `kernel/shared/constants.js` 就先清锁和心跳、detached 拉起一个自己、`process.exit(0)`。每次检查和更新的结果写 `~/.yixiubridge/last-update.json`（checked_at、local/remoteVersion、updated、version、backupDir、error）。

**搭建库**：`builds/builds.json`，每条一个版本（version、date、channel stable/beta、changes、verified_by_muse）。0.4.0 先标 `beta`，真机验证通过后由 Muse 改成 `stable`，之后 runner 才会自动装它。

**一键启动**：`scripts/update-and-start.ps1` 第 3 步优先走在线更新（`scripts/online-update-cli.mjs`，退出码 0 算成功；CLI 是用户手动跑的，所以不限制 channel，beta 也装）；在线更新失败或模块不存在时退回整包 ZIP 下载。`$downloaded` 为真时自我更新交接照常跑（新版脚本接管）。

**Gemini 写稿的两个教训（040-001/040-003）**：(1) 回稿在传输里丢了模板字符串的反引号（`` ` ``）和块注释的 `/*` 开头——`const portSuffix = :${port};`、`['/FI', PID eq ${pid}, ...]`、`log(在线更新...${msg})` 这样直接粘贴是语法错误，接入时必须逐行补回，`node --check` 是最后一道关；(2) 040-003 的 runner 接入稿有 4 处逻辑错：`Boolean(processOneTask(...))` 恒为真（它返回对象，空闲是 `res.status === 'empty'`）、`hasPendingTasks` 读的是本地根本不存在的 `tasks/pending` 目录、`loadConfig` 忘加 `await`、清理函数引用了不存在的 `loopTimer`/`lockFile`——Muse 按真实代码重写了接入层，没照抄。

## 思考等级改为非致命（v0.4.2）

0.4.1 让 runner 每次都传 `thinking: 高`，适配器 `selectThinkingLevel` 选完后验按钮文字（须含“高”），验不过就让整个问答失败。真机上两次探针都栽在这儿：第一次是模型选择器找不到（瞬时），第二次选完 高 后按钮仍显示 “Neon”（`gemini thinking level did not stick`），任务直接失败。根因是等级只是偏好、不是问答的前提——0.4.1 之前 runner 从不碰这个设置，问答一直正常。修法：`selectThinkingLevel` 的错误分两类——`invalid-level`（等级名本身不在菜单里，调用方错，照常快速失败）、`apply-failed`（子菜单找不到、点不中、按钮文字不变，UI 问题）；`askImpl` 里只有前者才失败，后者记成 `thinkingWarning`、照常问答，成功结果里带上它；等级验证改为 2 秒内轮询（400ms 读一次不准）。runner 把 `thinkingWarning` 接进 done 文件（`thinking_warning` 字段），所以 done 文件里 `asked_thinking: 高` 配上 `thinking_warning` 才诚实。注意：这只修了“问答不被等级卡住”，等级本身在真机上到底生效没有、按钮为什么不显示 高，仍待拿真实 DOM 证据再查。**同一版还修了模型菜单**：2026-11-22 凌晨 verify3、verify4 两次都死在 `openModelMenu`——点一次、等 400ms、菜单没出现就判失败。改成点一次后 2 秒内轮询（200ms 一次），没开再点一次、再轮询 2 秒；两次都开不了才报错。冷标签页第一次点击被吞掉、菜单开得慢，都能扛住。

## 在线更新后重打包 + 内容脚本无应答时开新页（v0.4.3）

0.4.2 自动装上后问答仍失败，根因是打包缺口：`host/online-updater.mjs` 的 `SKIP_PREFIXES` 跳过 `extension/kernel/`（git 忽略的打包产物），更新后适配器还停在 0.4.1，路由器版本握手（content 与 adapter 版本都须等于扩展版本）永远过不去。修法：runner 的 `runIdleOnlineUpdate` 在 `applyUpdate` 成功后跑 `node scripts/package-extension.mjs` 重打 `extension/kernel/`，打包失败则回滚；桥重启失败回滚后也重打一次（恢复旧适配器）。`repackageExtension` 是可注入的（`packager` 参数），脚本不存在时安静跳过（老安装/测试）。同版还修了路由器：标签页重载后内容脚本仍无应答（verify6/verify7，孤儿脚本、废弃/报错页）时开一个新 Gemini 标签页再试一次；找标签页优先用当前活动页（后台页可能被 Memory Saver 废弃）。2026-11-22 08:53 探针 verify11 成功（Neon、思考高、13 秒回 OK，桥与适配器均为 0.4.3），203 测试全过。

**教训（2026-11-22，用户亲口要求记下、以后不能再出现）**：(1) 在线更新必须包含打包产物——设计时先列出更新程序碰不到的文件，逐个给再生办法；(2) 验证要对准事实本身：思考等级用按钮文字子串匹配验证会误报——verify11 的 done 文件写 高、无警告，但用户截图证明回复 OK 的对话里思考等级打勾的是低。按钮文字是派生显示，真正选中的状态是菜单里打勾项；验证必须读打勾项，汇报要分清“要的”和“实际用的”；(3) 发稳定版要算准 runner 的检查节拍——每小时一次，“无更新”的检查也会把计时重置一小时，0.4.3 同步时 runner 刚查完，结果等了一小时、最后只能让用户双击 .bat；(4) 探针失败先读错误语义（"still an old version" 直接点明适配器过期），不要先猜测 tab/网络；(5) 不要给保证不了的时间承诺。

## 思考等级验证改读菜单打勾项（v0.4.4）

verify11 的 done 文件写 `asked_thinking: 高`、`thinking_warning: null`，但用户截图证明回复 OK 的对话里思考等级打勾的是 **低**。根因：0.4.2 的验证是读按钮文字子串——按钮一闪显示 高 就算通过，但按钮文字在真机上不可靠（常只显示模型名 "Neon"，不带等级），且选中的状态本身在菜单里。修法：`selectThinkingLevel` 选完后调用新增的 `readSelectedThinkingLevel()`，重新打开模型菜单 → 点开 思考等级 子菜单 → 读 `parseModelItem.selected`（aria-checked / 打勾标记）真正打勾的那一项；打勾是 高 才算成功，返回里带 `applied`；打勾是别的等级 → `apply-failed`，错误写明实际选中的等级（`selected level is "中"`），`applied` 记下来；读不到打勾项 → `apply-failed`（无法确认）。`askImpl` 把实际用的等级放进结果 `appliedThinking`，runner 接进 done 文件 `applied_thinking` 和用量日志——done 文件从此同时记“要的”和“实际用的”，两者对不上时一眼就能看出来。204 测试全过。注意：这次修的是验证的诚实性；如果真机上选 高 后打勾项仍是 低（等级本身没 stuck 住，或 Gemini 问完就重置回 低），探针的 `applied_thinking` 会如实写 低，届时再查是选不中还是问完重置。

## 路由器不再丢思考等级字段（v0.4.5）

0.4.4 装上后探针 verify13 的 done 文件写 `applied_thinking: null`、`thinking_warning: null`——适配器算出了等级，但字段在路由器里丢了两处：`onAskResult` 存任务时只存了 answer/model/elapsedMs/adapterVersion 这 4 个字段，`_askGemini` 返回时又新建了一个只有 answer/model/elapsed_ms/task_id/adapter_version 的对象。两处都只传固定字段，`thinkingWarning` 与 `appliedThinking` 根本到不了桥和 runner（0.4.2 的 `thinkingWarning` 也一直是这么丢的，只是从没在真机成功回包里出现过，没人发现）。修法：`onAskResult` 存任务时带上 `thinkingWarning` 与 `appliedThinking`，`_askGemini` 返回时也带上——直通（/call 直接返回）与轮询（task_update → get_answer）两条路都通了。新增 router 测试：内容脚本回包带这两个字段时，`handle` 的返回与 `get_answer` 的存档里都有。205 测试全过。教训：加新字段要沿整条链路数一遍（适配器 → 路由器存档 → 路由器返回 → 桥 → runner → done 文件），只在两头改、中间丢了，等于没改。

## 思考等级选不中时重试（v0.4.6）

0.4.5 终于让 done 文件说了实话：探针 verify14 写 `applied_thinking: 低`、警告“选了 高 但打勾的是 低”——等级是真的没粘住，不是验证在撒谎。根因：真机页面常吞掉子菜单上的第一次点击（和 0.4.2 模型菜单第一次点击被吞是同一个毛病）。修法：`selectThinkingLevel` 改成点一次、验打勾项、没粘住就重新找、再点，最多 3 次；3 次都不粘才报警告（错误写明试了 3 次）。点等级的步骤抽成 `clickThinkingLevelItem`，方便循环调用。Mock 加 `levelClicksToStick`（第几次点击才粘住）模拟吞点击；新增测试：第一次被吞、第二次粘住时照常问答且 `appliedThinking` 为 高、无警告；永远不粘时 3 次后警告、照常问答。206 测试全过。注意：如果 3 次重试后真机上还是 低，说明不是吞点击，而是点击本身没点中可选项（或页面要真人手势），届时要改点击方式（对子元素派发完整指针事件序列），不要再加重试次数。

## 思考等级改真人式点击 + 更新检查改 2 分钟（v0.4.7）

verify15 证明重试也不管用：0.4.6 试了 3 次，`applied_thinking` 还是 低。不是吞点击，是裸 `.click()` 只派发一个 click 事件，思考等级子菜单项根本不认——发送按钮、模型菜单都认 `.click()`，唯独等级项不认。修法：新增 `clickElement`，对等级项派发真人点击的全序列 pointerdown → mousedown → pointerup → mouseup → click（bubbles、cancelable、button 0）；窗口没有 MouseEvent 时（测试）回退到 `.click()`。同版还按用户建议把 runner 空闲更新检查从 1 小时改成 2 分钟——原来每同步一个新版都要等一小时才自动装，测试循环太慢；2 分钟后新稳定版不用双击也能自己装上（runner 本来每 60 秒就轮询一次任务，2 分钟查一次更新不增加多少开销）。注意：如果真人式点击后还是 低，下一步是点子元素（菜单项里的 radio/input）而不是容器本身。

## 思考等级改点子元素（v0.4.8）

verify16 证明真人式点击也不管用：0.4.7 试了 3 次全序列，`applied_thinking` 还是 低。根因换了一个：可选项（radio）藏在菜单项里面，点容器根本够不着它——事件只往上冒、不往下传，容器上的点击永远传不到里面的 radio 上。修法：新增 `findLevelClickTarget`，按顺序找：菜单项里面的 `input[type="radio"]` / `[role="radio"]` / `mat-radio-button`，再找最深的含等级文字的元素（常在 radio 的 label 里，点它能激活 radio），最后才点容器本身。Mock 加 `levelRadioInside`（radio 在菜单项里面、只有点 radio 才生效）模拟真机；新增测试：radio 在里面时照常问答且 `appliedThinking` 为 高、无警告。207 测试全过。注意：如果点子元素后还是 低，下一步是键盘操作（focus 后按 Enter/Space）或读页面真实结构再定，不要再换点击目标。

## 思考等级改键盘选（v0.4.9）

verify17（0.4.8）回 OK，但思考等级这一步根本没走到：警告是“model menu did not open”，`applied_thinking` 为 null——菜单那次没打开，是偶发的，所以 0.4.8 的点子元素还没在真机上真正试过。用户亲眼看到的关键现象是：思考等级子菜单弹得出、就是选不上——点鼠标这条路在真机上走不通。修法：新增 `activateLevelByKeyboard`，聚焦目标后按 Enter（菜单项）或空格（radio），这是和鼠标点击完全不同的输入路径，Angular Material 菜单认键盘；重试 3 次里第 1、3 次用键盘，第 2 次保留鼠标点击当后备。Mock 加 `levelClickDead`（鼠标点击完全无效、只有键盘能选）模拟真机；新增测试：点击无效时键盘照常选上且 `appliedThinking` 为 高、无警告。208 测试全过。

## 思考等级改方向键走菜单（v0.4.10）

用户的方法：子菜单默认第一项，下两下到高，按回车选中——用菜单自己的方向键导航，而不是去点某个具体元素。修法：新增 `navigateToLevelByArrows`，聚焦当前打勾项，按上下键走到目标项、按回车；顺序从页面实时读（levels 数组），不写死，所以不管页面把等级排成 低/中/高 还是 高/中/低 都能走到；重试 3 次里第 1、3 次用方向键，第 2 次用聚焦+回车（v0.4.9），鼠标点击当最后后备。Mock 的等级顺序改成 低/中/高（和高在第三位、两下能到相符），子菜单加共享的 focusedIdx 和方向键处理；新增测试：点击无效、从 低 出发两下到 高、回车选中，`appliedThinking` 为 高、无警告。209 测试全过。注意：如果方向键也不管用，下一步是用浏览器调试接口发真人点击（CDP Input.dispatchMouseEvent，带真实坐标、isTrusted 为真），不要再换合成事件。

## 思考等级改 CDP 真实点击（v0.4.11）

方向键也不管用（verify19：0.4.10 回 OK 但 `applied_thinking` 仍是 低）——鼠标点击、真人式点击、点子元素、聚焦+回车、方向键导航，六种合成输入全试过都不粘。用户让去问老师（Gemini），老师的答案：最可能的原因是内容脚本隔离世界（ISOLATED World）——内容脚本的 `new MouseEvent` 在页面 Angular 代码里 `instanceof window.MouseEvent` 返回 false、直接被丢弃；也可能页面校验了 `isTrusted` 或菜单项依赖真实指针进入才更新内部状态。localStorage/URL 参数/内部 API 都不可行（配置在内存 Service 状态里、刷新会被服务端偏好覆盖；RPC 字段是私有协议常变）；劫持 `addEventListener` 伪造 isTrusted 不推荐（副作用大）。

修法（老师给的方案，原样落地）：改用 CDP `Input.dispatchMouseEvent` 发真实点击（isTrusted 为真）。链路：适配器打开子菜单、找到目标项后，先走注入的 `requestTrustedClick`（内容脚本 `chrome.runtime.sendMessage` 到后台）；后台 service worker 用现成的 `DebuggerManager` attach 到该标签页（`chrome.debugger`，manifest 里早已有 debugger 权限），等 150ms 让调试横幅把视口顶下去、布局稳定，再发 `measure-thinking-item` 让内容脚本量目标项中心坐标（`getBoundingClientRect`，视口 CSS 像素，不乘 devicePixelRatio、不加滚动），然后按 mouseMoved → mousePressed → mouseReleased 三步发 CDP 事件（各隔 40ms），最后 detach。合成点击/键盘/方向键全部保留当后备（CDP 不可用或失败时用，比如 DevTools 正开着、attach 失败）。新增：`DebuggerManager.trustedClick`、`measureThinkingLevelItem`（适配器，暴露给内容脚本）、内容脚本的 `requestTrustedClick`（15 秒超时防挂起）与 `measure-thinking-item` 处理、后台的 `yixiubridge-trusted-click` 处理。Mock 的等级项加 `__trustedClick`（绕过 levelSticks/levelClickDead，直接应用等级，模拟 CDP 真实点击）；FakeElement 加 `getBoundingClientRect`（固定矩形，中心 160,218）。新增测试：合成全无效时 CDP 点击照常选上 `appliedThinking` 为 高、无警告；`trustedClick` 发出 mouseMoved/Pressed/Released 三步且参数正确。211 测试全过。

## 思考等级改精确匹配（v0.4.12）

CDP 真实点击也粘不住（verify23：0.4.11 回 OK 但 `applied_thinking` 仍是 低；verify24 连模型菜单都没打开，`applied_thinking` 为 null）——这时用户把浏览器控制（Muse for Chrome）交给了我，我直接进真机 Gemini 看到了子菜单的真实结构：三项都是 `role="menuitemradio"`（`aria-checked` 判选中），**里面没有任何 radio/input/mat-radio-button**（0.4.8 的前提是错的——项本身就是可点的 menuitemradio），文字是“等级 + 描述”两行：低 快速、高效 / 中 深度适中 / 高 超级详尽，顺序就是 低/中/高；选中态只看 `aria-checked`，未选中项根本没有勾选标记节点。另查实一个关键事实：**思考等级是按对话的**——浏览器直接点的高只在当前对话生效，新对话默认回 低，所以桥每次问答都必须自己能粘住。

根因（这才是 0.4.4 以来全军覆没的真正原因）：等级匹配用子串（`t.indexOf(want) !== -1`）。“高”是“高效”的子串——低的描述是“快速、高效”，找 高 时先匹配到 低，于是每次都点在已选中的 低 上，CDP 点的也是 低（measure 和 click 两处都用子串）。Mock 从没捉住它，因为 mock 的等级项只有名字、没有描述。

修法：新增 `levelLabelOf(el)`——把项文字按空白切词，取首个恰好是 低/中/高 的词（“高效”不是“高”，不会误 match；打勾项前缀的“已选中”也不是等级名）；measure、click、读取选中态三处全改精确匹配；`findLevelClickTarget` 的子元素查找也改精确匹配。Mock 补上真实描述（等级项文字改成“等级 + 描述”）、角色改成 `menuitemradio`；新增回归测试：要 高 时断言 `appliedThinking` 为 高。已证实：旧子串逻辑下 model-select 有 5 个测试失败（新 mock 捉住了它），改精确匹配后 212 测试全过。

## 答案取不回时先恢复，不要写失败（v0.4.13）

2026-11-22 14:08 用户下令先解决的问题：老师明明在 Gemini 标签页里回答了，桥却报失败、Muse 取不回答案。teacher-testpc-002（13:51）和 003（14:06）都报 `This operation was aborted`，001（13:38）报 `send did not register`；用户 14:00 的截图证明完整回答就在页面里，桥报的失败是假的——和 2026-11-21 番茄钟 -007 同模式。

根因有两条。第一条在 runner：`createBridgeCaller.ask()` 的 fetch abort 是 `min((timeoutS + 90)s, 300s)`——300 秒的任务 5 分钟就 abort 掉到桥 `/call` 的请求，报错是 DOM AbortError 的标准文案 `This operation was aborted`，此时还没拿到 `task_id`，没法轮询，答案在标签页里也被丢掉；桥自己的定时器本会在 ~300 秒返回 pending + task_id，但 runner 的 abort 先一步把它掐断了。第二条在适配器：发送只有 click + Enter 各一次就判死刑，真实页面两者都被忽略（teacher-001：提示还留在输入框里）。

修法（四层）：(1) abort 对齐总预算——`abortMs` 改成 `overallCapMs`（15 分钟），fetch 不再在桥回 pending 之前先断；桥的定时器 ~300 秒回 pending + task_id 后 `pollTask` 接着轮询，abort 只在桥本身挂住时才触发兜底。(2) 新增 `recover_last_answer` 工具（第 8 个 MCP 工具）：桥端不占任务锁（60 秒上限），路由器用 `_findGeminiTab` 直接找标签页、**绝不重载**（重载会毁掉要找回的答案），内容脚本调适配器 `recoverLastAnswer(prompt)` 读当前页最后一条完整回答，不重新发问。适配器的守卫：有本轮 baseline 时只认本轮新出现/变化的回答；没有 baseline 时要求最新一条 user-query 必须带有本次 prompt；回答还在流式时拒绝；三者都过才返回。`recovered` 字段沿适配器 → 路由器存档/返回 → 桥 → runner → done 文件全程直通（0.4.5 的教训：字段必须沿链路数一遍）。runner 在 `ask` 失败后先调一次恢复接口，取到就写 done（`recovered: true`），取不到才写 failed。(3) 发送改多路重试：先聚焦输入框、确认没有菜单遮挡（菜单还开着就先关掉），再依次试普通点击、回车、CDP 真实点击（`requestTrustedSendClick`，复用 0.4.11 的 `Input.dispatchMouseEvent` 路径，内容脚本 `measure-send-button` 量发送按钮中心）、完整指针序列（`clickElement`），仍不成功才轮询恢复 1 秒再判失败。(4) `pollTask` 改先读状态再看 deadline：卡在 deadline 整点答完的任务也不再被丢掉。

Mock 同步：`FakeWindow` 补 `MouseEvent`/`PointerEvent`（`clickElement` 的指针序列在测试里真正走通）；mock 发送按钮新增 `sendNeedsPointerSequence`（裸点击被忽略、只有指针序列能发）、`sendStartsOnTrustedClick`（只有 CDP 真实点击能发）、`sendStartsLateMs`（点击后延迟才开始流式，发送检查全部误判、只能靠恢复）；`startStreaming` 在默认结构里也建 user-query turn（和真实页面一致，恢复才能凭它证明 prompt 已发出）。新增 `tests/recover.test.mjs`（适配器恢复的守卫 + 路由器恢复不重载标签页），runner 测试补 abort 对齐与三路恢复（abort 后取到 → done、send 未注册后取到 → done、取不到 → failed），send-button 测试补指针序列与 CDP 真实点击发送。

## 恢复改轮询 5 分钟（v0.4.14）

2026-11-22 18:15 teacher-testpc-004 暴露：0.4.13 的恢复只试一次——答案还在流式就拒绝、答案晚到几分钟也取不回，失败文件已写完才到。改成失败后轮询 5 分钟（每 15 秒一次，直到答案出现）；失败文件记 `recover_error` 和 `recover_attempts`，下次诊断直接读原因不再猜；提示匹配加前后容错（“你说”前缀、截断显示）。verify30 真机证实：`recovered: true`，第一次没取到、轮询后从标签页里取回来了，答案和老师 18:05 贴的全文一致。注：0.4.14 发版时 builds.json 漏记了这一条（2026-11-22 20:20 查实远程 builds.json 只到 0.4.13），0.4.15 补记。

## 任务进度可见 + 恢复不再丢标签页里的答案（v0.4.15）

2026-11-22 20:20 用户下令：把所有任务停掉、重新发一个任务，任务必须有看得见的进度（能看到它在跑、任务已领取、到什么程度），老师已经回答出来了、取不到就是桥的问题，必须优化好、能正常取到老师回答的内容。

两件事。第一，进度可见：runner 在 `tasks/status/<id>.json` 里按阶段写状态——`claimed`（已领取，附桥版本与扩展数）→ `sending`（发送中，附模型与思考等级）→ `waiting`（等 Gemini 回答，附 bridge task_id，`ask` 进轮询时由 `onProgress` 回调触发）→ `retrieving`（取答案，附失败原因）→ `done` / `failed`（终态）。每阶段带时间戳与 detail，写失败绝不拖垮任务（best-effort，记日志继续跑）；done / failed 文件也带完整 `stages` 历史。进度文件就在仓库里，`tasks/status/<id>.json` 直接能看；Muse 读它向用户报进度。

第二，取答案可靠：(1) 模型选择按钮找不到时不再一次判死——`openModelMenu` 先等 15 秒（每 500 毫秒找一次），冷标签页/页面未渲染完就直接失败正是 teacher-003 的死法（20:18，`gemini model picker button not found`，问题根本没发出去，恢复 21 次都说“the prompt was never sent”）。(2) 恢复不再因匹配不上就丢答案：`recoverLastAnswer` 无 baseline 且 prompt 对不上最新 user-query 时，改成把标签页里最新一条完整回答取回来、标 `unmatched: true`（明说没对上号），只有标签页里根本没有回答、或答案还在流式时才继续拒绝。`unmatched` 沿内容脚本 → 路由器 → runner 全程直通，done 文件记 `recovered_unmatched: true`，读者一看就知道这条答案没验过号、可能属于另一道题。用户原话：老师已经回答出来了、取不到就是桥的问题——桥宁可把答案取回来标明出处，也不再把用户已经能看到的答案丢掉。

测试：恢复的 3 个旧测试改按新行为断言（不匹配时返回 unmatched 而不是拒绝）；runner 新增进度测试（状态文件阶段序列 claimed→sending→done，done 文件带 stages；失败后恢复 unmatched 时阶段为 claimed→sending→retrieving→done，`recovered_unmatched: true`）；模型选择新增“按钮晚出现 300 毫秒也能找到”的重试测试。`taskFilePaths` 新增 `status` 一项。

## 计划：更新检查改 30 分钟（v0.4.16，待 0.4.15 真机验证通过后做）

2026-11-22 20:55 用户定：0.4.15 还没在真机上测过，等测完、没问题的话，0.4.16 把 runner 空闲更新检查
`UPDATE_CHECK_INTERVAL_MS` 从 2 分钟改成 30 分钟。2 分钟是测试时才设的（用户 2026-11-22 09:27 建议，
为的是新版几分钟内自己装上）；正常用太勤（一小时查 30 次，一天 720 次，全是“已经是最新”）。
也不回 1 小时：0.4.3 时 1 小时吃过亏（检查刚跑完没更新、计时重置，又等一小时，最后还是用户双击 .bat）。
30 分钟是中间值：新稳定版最多半小时自己装上，一天只查 48 次；检查本身很轻（空闲时才查，两次小请求，
GitHub 限额一小时 5000 次，30 次/小时连零头都不到）。条件：0.4.15 真机验证通过后再改。
