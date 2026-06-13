# Codex Agnes 代理 🚀

**让 OpenAI Codex CLI 丝滑接入 Agnes-2.0-Flash 大模型**

> 一个轻量级 Node.js 代理，解决 Codex CLI 与 Agnes AI 之间的协议不兼容问题。不用官方 OpenAI API，也能跑 Codex！

## 为什么你需要这个工具？

**OpenAI Codex CLI**（v0.138+）是一款非常强大的 AI 编程终端助手，但它有一个硬伤——**只支持 OpenAI 的 Responses API**（`POST /v1/responses`）。

而市面上绝大多数模型 API（包括 **[Agnes AI](https://agnes-ai.com) 的 Agnes-2.0-Flash**）只提供标准的 **Chat Completions API**（`POST /v1/chat/completions`）。

这就导致了：
```
❌ Codex CLI ──请求 /v1/responses──→ Agnes API
                                   ↪ "404 Not Found"
```

这个代理就是来解决这个问题的。它在中间做"翻译官"：

```
✅ Codex CLI ──→ 代理 (localhost:15721) ──→ Agnes API
   (Responses)     ↪ 格式转换 ↪        (Chat Completions)
                ←── SSE 事件流 ←──
```

## 核心功能

| 功能 | 描述 |
|------|------|
| 🔄 **协议翻译** | 自动将 Responses API 请求转译为 Chat Completions |
| ⚡ **SSE 流式包装** | 模拟 OpenAI 的流式 SSE 事件，Codex 不再报 `stream disconnected` |
| 🧰 **Tool Calling** | 支持 Function Calling（工具调用） |
| 📡 **兼容透传** | `/v1/chat/completions` 直接透传，不干扰其他工具 |
| ❤️ **健康检查** | `GET /` 返回状态 JSON |
| 🪶 **轻量无依赖** | 纯 Node.js 内置模块，零 npm 依赖 |

## 快速开始

### 环境要求

- ✅ **Node.js** v18+（推荐 v20/v22/v24）
- ✅ **OpenAI Codex CLI** 已安装
- ✅ 一个 **Agnes AI** API Key

### 1️⃣ 获取 Agnes API Key

先前往 **Agnes AI** 官网申请 API Key，这是使用本代理的**唯一前提条件**：

1. 打开 [apihub.agnes-ai.com](https://apihub.agnes-ai.com) 进入 Agnes AI 平台
2. 注册 / 登录你的账号
3. 进入 **API Keys** 管理页面
4. 点击创建新的 API Key
5. 复制 Key（以 `sk-` 开头）备用

> Agnes-2.0-Flash 是性价比很高的模型，具体定价请查阅官网。

### 2️⃣ 下载

```bash
git clone https://github.com/yon-gjun/codex-agnes-proxy.git
cd codex-agnes-proxy
```

或者直接把 `codex-agnes-proxy.js` 下载到本地。

### 3️⃣ 配置 API Key（重要！）

⚠️ **本项目不包含任何 API Key，也绝不会上传你的 Key。**
你需要通过环境变量传入，代理会自动读取。

**Windows（CMD 命令提示符）：**
```cmd
set AGNES_API_KEY=sk-你的-Key-粘贴到这里
node codex-agnes-proxy.js
```

**Windows（PowerShell）：**
```powershell
$env:AGNES_API_KEY="sk-你的-Key-粘贴到这里"
node codex-agnes-proxy.js
```

**macOS / Linux：**
```bash
export AGNES_API_KEY="sk-你的-Key-粘贴到这里"
node codex-agnes-proxy.js
```

> 💡 **省心小技巧：**
> - Windows：把 `AGNES_API_KEY` 添加到系统环境变量（设置 → 系统 → 关于 → 高级系统设置 → 环境变量）
> - macOS/Linux：在 `~/.bashrc` 或 `~/.zshrc` 里加上 `export AGNES_API_KEY="..."`
> - 这样以后每次启动都**不用再手动输入**

启动成功后终端显示：
```
codex-agnes-proxy on http://127.0.0.1:15721/v1/responses
```

> Windows 用户也可以运行 `start-proxy.bat` 后台静默启动。

### 4️⃣ 配置 Codex CLI

编辑 `~/.codex/config.toml`，把模型指向代理：

```toml
[models.proxied]
provider = "switch"
wire_protocol = "responses"
requires_openai_auth = false
# instructions = "You are a coding assistant."  # 可选
```

如果用的是 `cc switch` 工具：

```bash
cc switch codex proxy set LOCAL http://127.0.0.1:15721
cc switch codex proxy use LOCAL
```

### 5️⃣ 验证

```bash
codex doctor     # 检查配置是否正确
codex exec       # 进入 AI 编程模式
```

如果看到 Codex 正常响应你的指令，恭喜你，配置成功！🎉

## 配置参数

所有配置通过**环境变量**传入，无需改代码：

| 环境变量 | 默认值 | 含义 |
|----------|--------|------|
| `AGNES_API_KEY` | **（必填，无默认值）** | 你的 Agnes API 密钥 |
| `LISTEN_PORT` | `15721` | 代理监听端口 |
| `AGNES_HOST` | `apihub.agnes-ai.com` | Agnes API 域名 |

## 工作流程详解

```
Codex CLI                      Proxy                       Agnes API
   │                            │                             │
   │ POST /v1/responses         │                             │
   │ {                          │                             │
   │   model: "...",            │                             │
   │   input: "写一个 Python 脚本", │                          │
   │   stream: true             │                             │
   │ }                          │                             │
   │───────────────────────────→│                             │
   │                            │  POST /v1/chat/completions  │
   │                            │  {                          │
   │                            │    model: "agnes-2.0-flash",│
   │                            │    messages: [...],         │
   │                            │    stream: false            │
   │                            │  }                          │
   │                            │────────────────────────────→│
   │                            │                             │
   │                            │  ←── JSON 200 ─────────────│
   │                            │  {                          │
   │                            │    choices: [{ message: {   │
   │                            │      content: "def ..."     │
   │                            │    }}], usage: {...}        │
   │                            │  }                          │
   │                            │                             │
   │  ←── SSE Event Stream ────│                             │
   │  data: {"type":"response.created",...}                   │
   │  data: {"type":"response.output_item.added",...}         │
   │  data: {"type":"response.content_part.added",...}        │
   │  data: {"type":"response.output_text.delta","delta":"def"}│
   │  data: {"type":"response.completed",...}                 │
   │  data: [DONE]                                             │
   │                            │                             │
```

## 项目结构

```
codex-agnes-proxy/
├── codex-agnes-proxy.js   ← 核心代理程序
├── start-proxy.bat        ← Windows 后台启动脚本
├── README.md              ← 英文说明
├── README_CN.md           ← 中文说明（就是本文件）
├── LICENSE                ← AGPL-3.0 许可证
└── .gitignore             ← Git 忽略规则
```

## FAQ

### Q: 报错 `EADDRINUSE`？
端口被占用了，换个端口：

```bash
# 改 LISTEN_PORT，或者先杀掉旧进程
netstat -ano | findstr :15721
taskkill /PID <PID> /F
```

### Q: Codex 一直重试 `stream disconnected before completion`？
通常是代理还没完全启动就发了请求，等几秒再试。或者重启代理：

```bash
# 先终止旧进程
# Windows
taskkill /F /IM node.exe /FI "WINDOWTITLE eq codex-agnes-proxy"

# macOS/Linux
pkill -f codex-agnes-proxy

# 重新启动
node codex-agnes-proxy.js
```

### Q: 可以用其他模型吗？
可以。设置环境变量 `AGNES_HOST` 和 `AGNES_API_KEY`，把请求目标换成其他兼容 Chat Completions API 的端点即可，无需改代码。

### Q: 这个代理会把我的 API Key 泄露吗？
不会。代理只在本地运行，所有的通信都是通过 HTTPS 加密传输到 Agnes 服务器。API Key 存在你的脚本里，不上传到任何第三方。

## 技术栈

- **Node.js** 内置 `http` + `https` 模块
- **零外部依赖**
- **SSE (Server-Sent Events)** 流式协议
- 支持 **Windows / macOS / Linux**

## 许可证

[MIT](./LICENSE) - 开源自由，欢迎贡献。

## 给个 ⭐ 吧！

如果你觉得这个工具帮到了你，欢迎在 [GitHub](https://github.com/yon-gjun/codex-agnes-proxy) 点个 Star！你的支持是我持续改进的动力 💪

---

**#CodexCLI #AgnesAI #AI编程 #代理工具 #开发者工具 #OpenSource**
