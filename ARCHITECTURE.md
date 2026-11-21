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
| 共享 | `kernel/shared/constants.js`、`kernel/control/host/tools.js` | 协议常量、工具目录（两端唯一的事实来源） |

## 工具目录是唯一的事实来源

`kernel/control/host/tools.js` 定义全部 6 个 MCP 工具（`ping`、`tabs_context`、`navigate`、`read_page`、`ask_gemini`、`get_answer`）。MCP 服务器用它生成 `tools/list`，插件后台用它校验 `tool_call`。加工具只改这一个文件，两边自动同步。

## 一次 ask_gemini 的完整链路

```
AI --tools/call--> MCP server --POST /call--> bridge --SSE tool_call--> 插件
插件：找/开 gemini.google.com 标签页 -> content script 跑适配器
  适配器：找输入框（多重选择器兜底）-> 填问题（原生 setter + input 事件）
        -> 点发送 -> 每 500ms 检查：停止按钮消失 且 文本 2 秒不变 = 答完
        -> 取最后一段回答
插件 --POST /result--> bridge --MCP 响应--> AI
```

如果答案在 `timeout_s` 内没出完，返回 `{status:"pending", task_id}`，任务继续在后台跑；跑完后插件主动 POST `/task-update`，AI 用 `get_answer(task_id)` 取回。

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
