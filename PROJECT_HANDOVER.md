# OpenClaw WebUI 项目交接文档

> 最后更新: 2026-03-08

## 一、技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Node.js + Express |
| WebSocket | `ws` 库 |
| 前端 | 原生 HTML/CSS/JS + Tailwind CSS (CDN) |
| Markdown | `marked` + `highlight.js` (CDN) |
| 认证 | Ed25519 签名 (Node.js crypto) |
| 存储 | JSON 文件 (sessions/*.json) |
| 依赖 | express, ws, dotenv |

## 二、核心架构

```
┌─────────────────────────────────────────────────────────────┐
│                      用户浏览器                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  index.html (单页应用)                               │   │
│  │  - Tailwind CSS 样式                                 │   │
│  │  - Markdown 渲染 (marked + highlight.js)             │   │
│  │  - SSE 流式接收                                       │   │
│  │  - WebSocket 状态显示                                │   │
│  │  - 聊天记录条数显示                                   │   │
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
│  │  - 流式事件处理 (agent 事件)                         │   │
│  │  - 自动重连机制                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  聊天历史存储 (sessions/*.json)                       │   │
│  │  - 每个 Agent 独立文件                                │   │
│  │  - 服务端持久化，跨设备同步                           │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ ws://localhost:18789
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  OpenClaw Gateway                           │
│  端口: 18789                                                │
│  认证: Token + 设备签名                                     │
└─────────────────────────────────────────────────────────────┘
```

## 三、已实现功能

### 3.1 WebSocket 直连
- **文件**: `server.js` GatewayClient 类
- **认证**: Ed25519 设备签名 (v3 格式)
- **协议**: Gateway Protocol v3
- **特性**: 自动重连、心跳检测

### 3.2 智能指令路由器
- **文件**: `server.js` handleSlashCommand() 函数
- **处理逻辑**:
  - `/help` → 本地构建帮助文档
  - `/status` `/whoami` → 本地构建状态信息
  - `/reset` `/new` → sessions.reset RPC + 发送 /hello 触发 agent 打招呼
  - `/clear` → 清空聊天历史（不重置 Session）

### 3.3 流式响应
- **文件**: `server.js` handleChatEvent() 函数
- **要点**:
  - 只处理 `agent` 事件的 `data.delta`（增量文本）
  - 不处理 `chat` 事件的 `message.content`（全量文本）
  - SSE 格式输出

### 3.4 聊天历史持久化
- **存储位置**: `sessions/{agentId}.json`
- **API 端点**:
  - `GET /api/history/:agentId` - 获取历史
  - `POST /api/history/:agentId` - 保存历史
  - `DELETE /api/history/:agentId` - 清空历史
  - `GET /api/history-counts` - 获取所有 Agent 条数

### 3.5 前端功能
- 流式 Markdown 渲染
- 懒加载历史消息
- 文件上传支持
- WebSocket 状态显示（侧边栏底部）
- 聊天记录条数显示（Agent 名称下方）

## 四、关键踩坑记录

### 4.1 WebSocket 协议

| 问题 | 解决方案 |
|------|----------|
| `invalid request frame` | 使用 `params` 而不是 `payload` |
| `protocol mismatch` | 设置 `minProtocol: 3, maxProtocol: 3` |
| 连接被拒绝 | 使用根路径 `ws://localhost:18789`（不带 `/ws`）|

### 4.2 流式响应

| 问题 | 解决方案 |
|------|----------|
| 消息重复累加 | 只用 `agent` 事件的 `data.delta`，不用 `chat` 事件 |
| 指令卡死 | `/help` 等指令不能透传，必须本地处理 |
| /reset 后无打招呼 | reset 后需发送 `/hello` 触发 agent 主动回复 |

### 4.3 设备认证

```javascript
// deviceId 计算
const publicKeyRaw = derivePublicKeyRaw(publicKeyPem);  // SPKI DER 最后 32 字节
const deviceId = crypto.createHash('sha256').update(publicKeyRaw).digest('hex');

// 签名 payload 格式 (v3)
const payload = [
  'v3', deviceId, clientId, clientMode, role,
  scopes.join(','), String(signedAtMs), token, nonce, platform, deviceFamily
].join('|');
```

## 五、核心红线

1. **禁止透传斜杠指令** - `/help`、`/status` 等会导致 Gateway 无响应
2. **禁止使用 chat 事件的 content** - 是全量文本，会导致消息重复
3. **禁止修改协议版本** - 必须是 v3
4. **禁止使用 payload 字段** - 必须用 params
5. **清空对话不重置 Session** - 只删除聊天历史文件

## 六、配置文件

### Gateway 配置 (`~/.openclaw/openclaw.json`)
```json
{
  "gateway": {
    "port": 18789,
    "auth": { "token": "your-token" },
    "controlUi": {
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "allowInsecureAuth": true,
      "dangerouslyDisableDeviceAuth": true
    }
  }
}
```

### 设备身份 (`~/.openclaw/identity/device.json`)
```json
{
  "deviceId": "hex-string",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----...",
  "privateKeyPem": "-----BEGIN PRIVATE KEY-----..."
}
```

## 七、API 端点汇总

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

## 八、常用命令

```bash
# 启动服务
cd /home/th001/openclaw-web && node server.js

# 查看 Gateway 状态
systemctl --user status openclaw-gateway.service

# 查看实时日志
journalctl --user -u openclaw-gateway.service -f

# 检查 WebSocket 连接
curl http://localhost:3000/api/status
```

## 九、文件结构

```
/home/th001/openclaw-web/
├── server.js           # 主服务端（WebSocket + Express）
├── public/
│   └── index.html      # 前端单页应用
├── sessions/           # 聊天历史存储目录
│   ├── main.json
│   ├── web.json
│   └── ...
├── package.json        # 依赖: express, ws, dotenv
├── .env.example        # 环境变量示例
├── README.md           # 项目说明
├── CLAUDE.md           # Claude Code 指引
└── PROJECT_HANDOVER.md # 本文档
```