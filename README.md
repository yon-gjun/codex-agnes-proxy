# Codex Agnes Proxy

**让 OpenAI Codex CLI 无缝接入 Agnes-2.0-Flash 大模型**

一个轻量级的 Node.js 代理服务器，用于将 OpenAI Codex CLI 的 Responses API 请求实时转换为 Agnes AI 的 Chat Completions 接口，并以 SSE 流式事件格式回传，从而绕过协议不兼容问题，让 Codex 可以连接非标准 OpenAI 兼容的模型端点。

## 解决的问题

| 痛点 | 说明 |
|------|------|
| **协议不匹配** | Codex CLI v0.138+ 只使用 OpenAI `Responses API` (`POST /v1/responses`)，而许多后端（包括 Agnes）只支持 `Chat Completions` |
| **硬编码流式** | Codex 始终发送 `stream: true`，如果收到非 SSE 格式的响应就会报 `stream disconnected before completion` 且重试 |
| **厂商锁定** | 通常只能用 `OPENAI_API_KEY` 配合官方 API，本代理让你可以自由选择兼容模型 |

## 架构

```
┌────────────────────────────────────────────────────────────────┐
│                     macOS / Windows / Linux                     │
│                                                                 │
│  +──────────────+     HTTP POST      +────────────────────+     │
│  │              │   /v1/responses    │                    │     │
│  │  Codex CLI   │ ──────────────────→│  Codex Agnes Proxy │     │
│  │              │                    │  (localhost:15721)  │     │
│  │  cc switch   │←──────────────────│                    │     │
│  │  proxy       │   SSE Events      │                    │     │
│  +──────┬───────+                    +─────────┬──────────+     │
│         │                                        │              │
│         │                                HTTPS POST             │
│         │                              /v1/chat/completions     │
│         │                                        │              │
│         │                              +─────────▼──────────+   │
│         │                              │                    │   │
│         │                              │   Agnes AI API     │   │
│         │                              │  (Agnes-2.0-Flash) │   │
│         │                              │                    │   │
│         │                              +────────────────────+   │
│         │                                                       │
│         │  +──────────────+                                     │
│         └──│  cc switch   │  ← 将 Codex 的请求重定向到本地      │
│            │  (config)    │     127.0.0.1:15721                 │
│            +──────────────+                                     │
└────────────────────────────────────────────────────────────────┘
```

## 快速开始

### 前提条件

- **Node.js** v18+（推荐 v20/v22/v24）
- **OpenAI Codex CLI** 已安装并配置好 `cc switch`

### 1. 获取 Agnes API Key

先前往 [Agnes AI 官网](https://agnes-ai.com) 注册账号并申请 API Key：

1. 打开 [apihub.agnes-ai.com](https://apihub.agnes-ai.com) 或 `https://agnes-ai.com`
2. 注册/登录账号
3. 进入 **API Keys** 管理页面
4. 创建一个新 Key（建议设置额度或用量限制）
5. 复制 Key 备用

> Agnes-2.0-Flash 是性价比很高的模型，具体价格请查阅官网定价页面。

### 2. 克隆仓库

```bash
git clone https://github.com/yon-gjun/codex-agnes-proxy.git
cd codex-agnes-proxy
```

### 3. 配置 API Key（重要）

代理通过环境变量 `AGNES_API_KEY` 读取你的密钥。请**不要**直接修改代码文件。

**Windows（CMD）：**
```cmd
set AGNES_API_KEY=sk-your-key-here
node codex-agnes-proxy.js
```

**Windows（PowerShell）：**
```powershell
$env:AGNES_API_KEY="sk-your-key-here"
node codex-agnes-proxy.js
```

**macOS / Linux：**
```bash
export AGNES_API_KEY="sk-your-key-here"
node codex-agnes-proxy.js
```

> 💡 **Tip：** 可以把环境变量写到 shell 配置文件（`~/.bashrc`、`~/.zshrc`、Windows 用户环境变量等）里，避免每次手动输入。

看到如下输出即启动成功：

```
codex-agnes-proxy on http://127.0.0.1:15721/v1/responses
```

> **Windows 用户** 也可以用 `start-proxy.bat` 后台静默启动（需先在 bat 中设置 KEY）。

### 4. 配置 Codex CLI

编辑 `~/.codex/config.toml`，确保以下内容：

```toml
[models.proxied]
provider = "switch"
wire_protocol = "responses"
instructions = "You are a helpful AI coding assistant."  # 可自定义
requires_openai_auth = false
```

并将 cc switch 的 API Base 指向本地代理：

```bash
# 用 cc switch 的 proxy 子命令或配置文件设置
cc switch codex proxy set LOCAL http://127.0.0.1:15721
cc switch codex proxy use LOCAL
```

### 5. 验证

```bash
codex doctor    # 确认连接正常
codex exec      # 开始编码
```

## 配置说明

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `AGNES_API_KEY` | **（必填，无默认值）** | 你的 Agnes API 密钥，通过环境变量传入 |
| `LISTEN_PORT` | `15721` | 代理监听端口（可选覆盖） |
| `AGNES_HOST` | `apihub.agnes-ai.com` | Agnes API 地址（可选覆盖） |

> ⚠️ 本项目**不包含任何 API Key**，使用时需自行向 Agnes AI 申请。API Key 仅保存在你的本地环境变量中，不上传至任何第三方。

## 工作原理

1. **接收请求** - 代理监听 `127.0.0.1:15721`，接受 Codex 发来的 `POST /v1/responses`
2. **格式转换** - 将 Responses API 的 `input`、`instructions`、`tools` 字段映射为 Chat Completions 的 `messages`、`tools`
3. **调用 Agnes** - 通过 HTTPS 向 `apihub.agnes-ai.com/v1/chat/completions` 发送 POST
4. **响应包装** - 将 Agnes 返回的 JSON 拆分为一系列 SSE 事件：`response.created` → `output_item.added` → `content_part.added` → `output_text.delta` → `response.completed` → `[DONE]`
5. **Codex 消费** - Codex 收到标准的 SSE 流式事件，认为自己在与标准的 OpenAI Responses API 交互

## 支持的功能

- ✅ `POST /v1/responses` - 主入口
- ✅ `POST /v1/chat/completions` - 透传到 Agnes（兼容其他工具）
- ✅ SSE 流式事件包装（Codex 硬编码 `stream: true`）
- ✅ Tool/Function Calling
- ✅ CORS 支持
- ✅ `GET /` 健康检查

## 已知限制

- 不支持图片/多模态输入（Agnes-2.0-Flash 接口限制）
- 不支持实时流式逐 token 输出（非技术限制，可改进）
- Codex 仅支持 `cc switch` 的 `responses` wire protocol（v0.138+）

## 许可证

本项目基于 **MIT** 开源协议。详见 [LICENSE](./LICENSE)。

---

**#codex-cli #agnes-ai #ai-proxy #openai-responses-api #开发者工具**

**如果这个项目帮到了你，请给一个 ⭐ Star！**
