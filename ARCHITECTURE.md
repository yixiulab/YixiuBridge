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
