# OpenClaw WebUI 项目交接文档

> 最后更新: 2026-03-07
> 项目状态: 核心功能已完成，可正常使用

---

## 一、项目概述

OpenClaw WebUI 是一个极简的局域网聊天 Web 界面，用于与 OpenClaw Gateway 进行交互。

**核心特性：**
- 多 Agent 支持（Agent 列表从配置文件自动加载）
- Agent 独立的本地持久化会话（localStorage）
- 流式响应显示（SSE）
- 图片和文档上传支持（本地文件落盘 + 路径注入）
- 历史记录懒加载（优化长对话渲染性能）

**技术栈：**
- 后端: Node.js + Express（无框架，原生实现）
- 前端: 原生 HTML/CSS/JavaScript + Tailwind CSS (CDN)
- 通信: OpenAI 兼容 REST API + SSE 流式响应
- 无构建步骤，开箱即用

---

## 二、关键架构决策

### 2.1 通信方式：OpenAI 兼容 API + SSE

**为什么不用 WebSocket？**
- Gateway WebSocket 协议需要设备签名认证（device signature）
- 需要处理 `connect.challenge` 事件，提供公钥、签名等
- 即使配置 `dangerouslyDisableDeviceAuth: true` 也无法绕过
- 实现复杂度高，且 OpenAI 兼容 API 已足够满足需求

**最终方案：**
```
Endpoint: POST http://localhost:18789/v1/chat/completions
Headers:
  Content-Type: application/json
  Authorization: Bearer <gateway-token>
  x-openclaw-agent-id: <agent-id>  // 强制 Agent 路由
Body:
  {
    "model": "openclaw:<agent-id>",  // 必须加 openclaw: 前缀
    "messages": [{ "role": "user", "content": "..." }],
    "stream": true
  }
```

### 2.2 Agent 路由机制

**踩坑记录：**
- 直接传递 `"model": "zhaobiao"` 会被误认为未知 LLM 模型，fallback 到默认 Agent
- **解决方案：** 两个关键改动：
  1. model 字段加上 `openclaw:` 前缀：`"model": "openclaw:zhaobiao"`
  2. 添加专属请求头：`"x-openclaw-agent-id": "zhaobiao"`

### 2.3 Session 管理：完全交给 Gateway

**核心发现：**
- OpenClaw Gateway 维护原生 Session，按 Agent ID 隔离
- 前端只需发送当前消息，Gateway 自动维护上下文
- 切换 Agent 时 Session 独立，不会串台

**请求格式：**
```javascript
// 前端只发送当前消息，不发送历史
{
  agentId: "main",
  message: "你好"
}
```

### 2.4 文件上传：本地文件落盘 + 路径注入

**踩坑记录：**
- OpenAI 标准的 `content: [{ type: 'image_url', ... }]` 格式在 Gateway 中被静默丢弃
- 百炼 Coding Plan 不支持通过 API 传递图片

**最终方案：**
1. 前端将文件转为 Base64，发送 `{ agentId, message, fileBase64, fileName }`
2. 后端将文件保存到 `/tmp/openclaw_uploads/`
3. 路径注入到消息：
   ```
   [系统提示：用户上传了附件文件，请使用你内置的工具读取此本地文件的绝对路径并进行分析: /tmp/openclaw_uploads/xxx.pdf]
   ```
4. Agent 读取本地文件进行分析

---

## 三、文件结构

```
openclaw-web/
├── server.js              # 后端服务（Express）
├── public/
│   └── index.html         # 前端单页应用（包含 CSS/JS）
├── package.json           # 依赖配置
├── .env.example           # 环境变量模板
├── .env                   # 环境变量配置（不提交到 Git）
├── .gitignore             # Git 忽略规则
├── CLAUDE.md              # Claude Code 开发指南
├── PROJECT_HANDOVER.md    # 本交接文档
└── README.md              # 项目说明
```

**关键配置文件：**
```
~/.openclaw/openclaw.json  # OpenClaw 主配置（Agent 列表、Gateway Token 等）
.env                       # WebUI 环境配置（Gateway URL、Token 等）
```

---

## 三.五、环境配置与 .env 使用说明

### 配置文件说明

项目使用 `.env` 文件管理环境变量，实现环境解耦和跨平台移植。

### 首次部署步骤

```bash
# 1. 克隆或复制项目到目标机器
cd /path/to/openclaw-web

# 2. 安装依赖
npm install

# 3. 复制环境变量模板
cp .env.example .env

# 4. 编辑 .env 文件，填写实际配置
nano .env
```

### 环境变量说明

| 变量名 | 说明 | 默认值 | 是否必填 |
|--------|------|--------|----------|
| `PORT` | WebUI 监听端口 | `3000` | 否 |
| `GATEWAY_URL` | Gateway 服务地址 | `http://localhost:18789` | 否 |
| `GATEWAY_TOKEN` | Gateway 认证 Token | 无 | **是** |

### 获取 GATEWAY_TOKEN

Token 可从 OpenClaw 配置文件中获取：

```bash
# 方法一：直接查看配置文件
cat ~/.openclaw/openclaw.json | grep -A1 '"auth"' | grep token

# 方法二：使用 jq 工具
cat ~/.openclaw/openclaw.json | jq '.gateway.auth.token'
```

### 完整 .env 示例

```env
# OpenClaw WebUI 环境配置
PORT=3000
GATEWAY_URL=http://localhost:18789
GATEWAY_TOKEN=c46ff6f2b336c4894a2cc89270c572083160a1373db5648f
```

### 跨平台兼容性

- **配置文件路径**：使用 `os.homedir()` 动态获取用户主目录，支持 Linux/macOS/Windows
- **上传目录**：使用 `os.tmpdir()` 获取系统临时目录，跨平台兼容
  - Linux: `/tmp/openclaw_uploads/`
  - macOS: `/var/folders/xxx/openclaw_uploads/`
  - Windows: `C:\Users\xxx\AppData\Local\Temp\openclaw_uploads\`

### 安全注意事项

- `.env` 文件已添加到 `.gitignore`，**不会被提交到 Git**
- 生产环境建议通过环境变量传递敏感配置，而非 `.env` 文件
- 示例：`GATEWAY_TOKEN=xxx PORT=8080 npm start`

---

## 四、已实现功能清单

### 4.1 Agent 管理
- [x] 从 `~/.openclaw/openclaw.json` 自动加载 Agent 列表
- [x] Agent 切换（侧边栏点击）
- [x] Agent 独立的 Session（Gateway 原生支持）
- [x] 有历史记录的 Agent 显示小圆点指示器

### 4.2 会话持久化
- [x] 每个 Agent 独立的 localStorage 存储
- [x] Key 格式：`openclaw_chat_history_<agentId>`
- [x] 刷新页面后恢复历史
- [x] 一键清空对话（删除 localStorage）

### 4.3 历史记录懒加载
- [x] 初始只渲染最后 20 条消息
- [x] 向上滚动加载更多（每次 20 条）
- [x] 滚动位置保持（不跳动）
- [x] API 请求不发送历史（Gateway 维护 Session）

### 4.4 文件上传
- [x] 点击按钮选择文件
- [x] 粘贴图片（Ctrl+V）
- [x] 拖拽上传
- [x] 图片预览
- [x] 文档文件图标显示

**支持的文件类型：**
| 类型 | 扩展名 |
|------|--------|
| 图片 | .jpg, .png, .gif, .webp |
| 文档 | .pdf, .doc, .docx, .xls, .xlsx, .ppt, .pptx |
| 文本 | .txt, .md, .csv, .json, .xml, .html, .log |
| 代码 | .js, .ts, .py, .java, .css, .sql, .yaml |

### 4.5 流式响应
- [x] SSE 流式显示
- [x] 实时滚动到底部
- [x] 加载状态指示

### 4.6 Markdown 渲染
- [x] 助手消息 Markdown 渲染（使用 marked.js）
- [x] 代码语法高亮（使用 highlight.js）
- [x] GFM（GitHub Flavored Markdown）支持
- [x] 表格、列表、引用等格式支持
- [x] 流式响应实时渲染

---

## 五、Gateway 配置要点

### 5.1 启用 OpenAI 兼容 API
```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true }
      }
    }
  }
}
```

### 5.2 Gateway Token
- 配置路径: `gateway.auth.token`
- 用作 Bearer Token 进行 API 认证
- 当前值: `c46ff6f2b336c4894a2cc89270c572083160a1373db5648f`

### 5.3 模型配置（支持 Vision）
```json
{
  "models": {
    "providers": {
      "bailian": {
        "models": [{
          "id": "qwen3.5-plus",
          "input": ["text", "image"],  // 支持图片
          "contextWindow": 1000000
        }]
      }
    }
  }
}
```

---

## 六、API 接口

### GET /api/agents
返回 Agent 列表。
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

### POST /api/chat
发送聊天消息。
```json
// 请求体
{
  "agentId": "main",
  "message": "请描述这张图片",
  "fileBase64": "data:image/jpeg;base64,/9j/...",  // 可选
  "fileName": "photo.jpg"                           // 可选
}

// 响应：SSE 流
data: {"choices":[{"delta":{"content":"这是..."}}]}
```

---

## 七、已踩的坑

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| WebSocket 直连失败 | 需要设备签名认证 | 改用 OpenAI 兼容 REST API |
| 所有 Agent 都路由到 main | model 字段缺少前缀 | 加 `openclaw:` 前缀 + `x-openclaw-agent-id` header |
| 图片无法识别 | OpenAI Vision 格式不支持 | 本地文件落盘 + 路径注入 |
| 请求体过大报错 | Express 默认限制 | 设置 `limit: '50mb'` |
| Gateway 启动失败 | 配置文件有无效 key | 运行 `openclaw doctor --fix` |

---

## 八、常用命令

```bash
# 启动 WebUI
cd /home/th001/openclaw-web && npm start

# 启动 Gateway
openclaw gateway

# 查看 Gateway 状态
systemctl --user status openclaw-gateway.service

# 重启 Gateway
systemctl --user restart openclaw-gateway.service

# 修复配置
openclaw doctor --fix

# 测试 API
curl -X POST http://localhost:18789/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "x-openclaw-agent-id: main" \
  -d '{"model": "openclaw:main", "messages": [{"role": "user", "content": "你好"}]}'
```

---

## 九、待开发功能（可选）

- [ ] 多文件同时上传
- [ ] 消息编辑/删除
- [ ] 对话导出
- [ ] 语音输入/输出
- [ ] 主题切换（深色模式）
- [ ] LaTeX 数学公式渲染

---

## 十、关键代码位置

| 功能 | 文件 | 位置 |
|------|------|------|
| 后端 API 路由 | `server.js` | 第 89-196 行 |
| 文件落盘逻辑 | `server.js` | 第 99-132 行 |
| 前端发送消息 | `index.html` | `sendMessage()` 函数 |
| 文件处理 | `index.html` | `addAttachment()` 函数 |
| 历史懒加载 | `index.html` | `renderVisibleMessages()` 函数 |
| LocalStorage | `index.html` | `saveHistory()`, `loadHistory()` 函数 |

---

## 十一、联系方式

- OpenClaw 文档: https://docs.openclaw.ai
- WebSocket 协议参考: https://docs.openclaw.ai/concepts/typebox
- Slash 命令参考: https://docs.openclaw.ai/tools/slash-commands
- OpenAI API 参考: https://docs.openclaw.ai/concepts/openai-api