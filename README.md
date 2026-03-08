# OpenClaw WebUI

极简局域网对话 WebUI，用于与 OpenClaw Gateway 进行交互。

## 功能特点

- 从 OpenClaw 配置文件自动加载 Agent 列表
- **WebSocket 直连 Gateway** - 实时双向通信，零延迟流式响应
- 服务端持久化聊天历史 - 跨设备同步
- 流式 Markdown 渲染
- 支持斜杠命令 (`/reset`, `/new`, `/status` 等)
- 文件上传支持
- 响应式设计，支持移动端

## 系统要求

- **操作系统**: Ubuntu / Debian
- **Node.js**: 16.0 或更高版本
- **依赖**: OpenClaw Gateway 运行中（默认端口 18789）

## 快速安装

### 方式一：一键安装（推荐）

```bash
# 进入项目目录
cd openclaw-web

# 执行安装脚本
./install.sh
```

安装脚本会自动：
1. 检测系统环境
2. 安装 Node.js（如未安装）
3. 安装项目依赖
4. 创建 .env 配置文件
5. 配置 systemd 服务
6. 启动服务并设置开机启动

### 方式二：手动安装

```bash
# 安装依赖
npm install

# 复制配置文件
cp .env.example .env

# 编辑配置（可选）
nano .env

# 启动服务
npm start
```

### 服务管理命令

```bash
# 查看服务状态
systemctl status openclaw-webui

# 查看实时日志
journalctl -u openclaw-webui -f

# 重启服务
systemctl restart openclaw-webui

# 停止服务
systemctl stop openclaw-webui

# 卸载服务
./install.sh --uninstall
```

启动后访问：
- 本地: http://localhost:3000
- 局域网: http://<服务器IP>:3000

## 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                      用户浏览器                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  public/index.html (单页应用)                        │   │
│  │  - Tailwind CSS 样式 (CDN)                          │   │
│  │  - Markdown 渲染 (marked + highlight.js)            │   │
│  │  - SSE 流式接收                                      │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP API
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    server.js (Express)                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  智能指令路由器                                       │   │
│  │  /help, /status, /clear → 本地响应                   │   │
│  │  /reset, /new         → sessions.reset + /hello     │   │
│  │  其他                 → 透传 Gateway                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                              │                              │
│                              │ WebSocket 直连               │
│                              ▼                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  GatewayClient                                       │   │
│  │  - Ed25519 设备签名认证                              │   │
│  │  - chat.send 请求                                    │   │
│  │  - 流式事件处理                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  聊天历史存储 (sessions/*.json)                       │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ ws://localhost:18789
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  OpenClaw Gateway                           │
└─────────────────────────────────────────────────────────────┘
```

## 通信方式

WebUI 使用 **WebSocket** 直接连接 OpenClaw Gateway：

- 连接地址: `ws://localhost:18789`
- 协议版本: 3
- 认证方式: Token + Ed25519 设备签名

### 支持的命令

| 命令 | 处理方式 | 说明 |
|------|----------|------|
| `/help` | 本地响应 | 显示帮助信息 |
| `/status` | 本地响应 | 显示连接状态 |
| `/clear` | 本地响应 | 清空聊天历史 |
| `/reset` `/new` | Gateway RPC + /hello | 重置会话并触发 agent 打招呼 |
| 其他 | 透传 Gateway | 由 Agent 处理 |

## 配置说明

WebUI 会自动从 `~/.openclaw/openclaw.json` 读取配置，包括：

- Agent 列表 (`agents.list`)
- Gateway Token (`gateway.auth.token`)

### 设备身份

WebUI 复用 OpenClaw CLI 的设备身份：
- 身份文件: `~/.openclaw/identity/device.json`
- 或自动生成新设备: `~/.openclaw-webui/device.json`

## 目录结构

```
openclaw-web/
├── install.sh          # 一键安装脚本
├── server.js           # 主服务端
├── public/
│   └── index.html      # 前端单页应用
├── sessions/           # 聊天历史存储目录
│   ├── main.json       # main agent 聊天记录
│   └── ...
├── package.json        # 依赖配置
├── .env.example        # 环境变量示例
├── README.md           # 项目说明
├── CLAUDE.md           # Claude Code 指引
└── PROJECT_HANDOVER.md # 项目交接文档
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/agents` | GET | 获取 Agent 列表 |
| `/api/status` | GET | 获取 WebSocket 连接状态 |
| `/api/chat` | POST | 发送聊天消息 |
| `/api/history/:agentId` | GET | 获取聊天历史 |
| `/api/history/:agentId` | POST | 保存聊天历史 |
| `/api/history/:agentId` | DELETE | 清空聊天历史 |
| `/api/history-counts` | GET | 获取所有 Agent 聊天记录条数 |
| `/api/session/:agentId` | GET | 获取 Session ID |
| `/api/session/reset` | POST | 重置 Session |

## 故障排除

### 无法加载 Agent 列表

检查配置文件路径是否正确：`~/.openclaw/openclaw.json`

### WebSocket 连接失败

1. 确认 OpenClaw Gateway 正在运行
2. 检查端口是否正确（默认 18789）
3. 验证设备是否已配对（首次使用需执行 `openclaw devices approve <deviceId>`）

### 消息重复显示

确保只使用 `agent` 事件的 `data.delta`，不要使用 `chat` 事件的 `message.content`

## 技术栈

- 后端: Node.js + Express + ws
- 前端: 原生 HTML/CSS/JavaScript
- 通信: WebSocket (Gateway Protocol v3)
- 认证: Ed25519 签名
- UI: Tailwind CSS (CDN)
- Markdown: marked + highlight.js (CDN)

## 许可证

MIT