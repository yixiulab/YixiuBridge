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
```

## MCP 工具（v0.1.0，MVP）

| 工具 | 作用 |
|---|---|
| `ping` | 检查桥和插件是否在线（不占任务锁） |
| `tabs_context` | 列出当前 Chrome 的标签页 |
| `navigate` | 打开网址（只读导航，不提交表单、不花钱） |
| `read_page` | 读当前页标题、URL 和正文摘要 |
| `ask_gemini` | 向网页版 Gemini 提问，等回答完成取回 `{answer, model, elapsed_ms}`；超时未答完返回 `{status:"pending", task_id}` |
| `get_answer` | 按 `task_id` 取回之前提问的结果 |

多 Profile 路由：每个工具都能传 `browser` 参数（Chrome 身份的 id、别名或唯一子串），多个 Chrome 身份同时跑也不会串号。

## 项目结构

```
extension/            Chrome MV3 插件（service worker + content script + 侧边栏）
kernel/shared/        协议常量（端口、超时、配对窗口）
kernel/control/host/  MCP 工具目录 —— 两端唯一的事实来源
kernel/adapters/      每个网页模型一个适配器文件（gemini-web.js 是第一个）
host/                 本地桥服务（HTTP+SSE，127.0.0.1:8765）+ MCP stdio 服务器 + 信任注册表
bin/                  命令行：install / config / status / bridge / mcp / pair
tests/                Node 原生测试：模拟插件 + 模拟 Gemini 页面，无需真浏览器
```

详见 [ARCHITECTURE.md](ARCHITECTURE.md)；安全模型见 [SECURITY.md](SECURITY.md)。

## 测试

```bash
npm test          # Node 原生测试：适配器 + 全链路协议（模拟插件与模拟页面）
npm run check     # node --check 全部 JS 文件
```

## 已知限制（诚实说明）

- **没有在真实 gemini.google.com 上验证过**：本环境没有已登录的 Gemini 账号，虚拟机出口代理也直连不了该站。`ask_gemini` 的选择器是按 Gemini 网页版 UI 结构尽力写的，带多重兜底和明确报错，但第一次在真机上跑之前，需要在用户自己的 Chrome 里实测并按实际 UI 调选择器。
- 网页版 UI 会改：某个站挂了只影响它自己的适配器文件，其他模型不受影响。
- 网页版模型有频率限制，不能高频刷；验证码、登录过期要人来处理，插件不会硬闯。

## 路线图

- v0.2：Claude / ChatGPT 网页版适配器 + 任务路由表（按任务类型选模型）+ 肌肉记忆（重复任务省 token）+ 额度账本
- v0.3：接进 Muse 团队 —— 桥服务放 VPS，每位组长一个 Chrome Profile，操作留审计日志
