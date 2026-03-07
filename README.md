# OpenClaw WebUI

极简局域网对话 WebUI，用于与 OpenClaw Gateway 进行交互。

## 功能特点

- 从 OpenClaw 配置文件自动加载 Agent 列表
- 支持 Agent 切换
- **WebSocket 连接** - 直接连接 Gateway，支持命令处理
- 流式响应显示
- 支持所有 Gateway 命令（/reset, /new, /status 等）
- 响应式设计，支持移动端

## 系统要求

- Node.js 14.0 或更高版本
- OpenClaw Gateway 运行中（默认端口 18789）

## 安装与运行

```bash
# 进入项目目录
cd openclaw-web

# 安装依赖
npm install

# 启动服务
npm start
```

启动后访问：
- 本地: http://localhost:3000
- 局域网: http://<服务器IP>:3000

## 通信方式

WebUI 使用 **WebSocket** 直接连接 OpenClaw Gateway：

- 连接地址: `ws://localhost:18789`
- 协议: Gateway WebSocket Protocol (TypeBox)
- 主要方法: `chat.send`, `chat.history`, `chat.abort`

### 支持的命令

所有命令由 Gateway 直接处理，不经过 LLM：

- `/reset` 或 `/new` - 重置会话
- `/status` - 显示会话状态
- `/help` - 显示帮助
- `/compact` - 压缩上下文
- `/stop` - 停止当前运行
- `/model` - 切换模型
- `/think` - 设置思考级别
- `/verbose` - 详细模式

完整命令列表参考: https://docs.openclaw.ai/tools/slash-commands

## 配置说明

WebUI 会自动从 `~/.openclaw/openclaw.json` 读取配置，包括：

- Agent 列表 (`agents.list`)
- Gateway Token (`gateway.auth.token`)
- 默认模型 (`agents.defaults.model.primary`)

### 配置文件示例

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "name": "主助手",
        "identity": {
          "name": "小辉",
          "emoji": "💼"
        },
        "model": {
          "primary": "bailian/qwen3.5-plus"
        }
      }
    ]
  },
  "gateway": {
    "port": 18789,
    "auth": {
      "mode": "token",
      "token": "your-token-here"
    }
  }
}
```

## API 端点

### GET /api/agents

返回可用的 Agent 列表。

响应示例：
```json
[
  {
    "id": "main",
    "name": "主助手",
    "emoji": "💼",
    "identityName": "小辉",
    "model": "bailian/qwen3.5-plus"
  }
]
```

### GET /api/config

返回 Gateway WebSocket 连接配置。

响应示例：
```json
{
  "host": "localhost",
  "port": 18789,
  "token": "your-token-here"
}
```

## 自定义配置

如需修改 Gateway 地址，编辑 `server.js` 开头的常量：

```javascript
const GATEWAY_HOST = 'localhost';
const GATEWAY_PORT = 18789;
```

## 故障排除

### 无法加载 Agent 列表

检查配置文件路径是否正确：`~/.openclaw/openclaw.json`

### WebSocket 连接失败

1. 确认 OpenClaw Gateway 正在运行
2. 检查端口是否正确（默认 18789）
3. 验证 Token 是否有效
4. 检查浏览器控制台是否有 WebSocket 错误

### 命令不生效

确保使用 WebSocket 连接（检查连接状态显示为"已连接"）。HTTP API 不支持完整的命令处理。

## 技术栈

- 后端: Node.js + Express
- 前端: 原生 HTML/CSS/JavaScript
- 通信: **WebSocket** (Gateway Protocol)
- UI: Tailwind CSS (CDN)

## 许可证

MIT