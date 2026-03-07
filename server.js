/**
 * OpenClaw WebUI - 简化版 HTTP 代理
 *
 * 使用 OpenAI 兼容 API + SSE 流式响应
 * 支持图片上传：本地文件落盘 + 路径注入策略
 *
 * 环境配置：通过 .env 文件或环境变量配置
 * Session 绑定：通过 x-openclaw-session-id header 传递
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const app = express();

// ==================== 环境配置 ====================
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Gateway 配置：从环境变量读取，支持 URL 解析
let GATEWAY_HOST = 'localhost';
let GATEWAY_PORT = 18789;

if (process.env.GATEWAY_URL) {
  try {
    const gatewayUrl = new URL(process.env.GATEWAY_URL);
    GATEWAY_HOST = gatewayUrl.hostname;
    GATEWAY_PORT = parseInt(gatewayUrl.port, 10) || 18789;
  } catch (e) {
    console.error(`[配置] GATEWAY_URL 格式错误: ${process.env.GATEWAY_URL}`);
    console.error(`[配置] 请使用格式: http://host:port`);
    process.exit(1);
  }
}

const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;

if (!GATEWAY_TOKEN) {
  console.error('');
  console.error('========================================');
  console.error('  错误：缺少 GATEWAY_TOKEN 配置');
  console.error('========================================');
  console.error('  请在 .env 文件中设置 GATEWAY_TOKEN');
  console.error('  或通过环境变量 GATEWAY_TOKEN 传入');
  console.error('');
  console.error('  Token 可从以下位置获取：');
  console.error('  ~/.openclaw/openclaw.json -> gateway.auth.token');
  console.error('========================================');
  console.error('');
  process.exit(1);
}

// 上传目录：使用系统临时目录，跨平台兼容
const UPLOAD_DIR = path.join(os.tmpdir(), 'openclaw_uploads');

// Session 存储目录
const SESSION_DIR = path.join(os.homedir(), '.openclaw-webui');

// 请求超时
const REQUEST_TIMEOUT = 120000;

// 确保目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log(`[上传] 创建上传目录: ${UPLOAD_DIR}`);
}
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  console.log(`[Session] 创建 Session 目录: ${SESSION_DIR}`);
}

// ==================== Session 管理 ====================
// 内存中的 Session ID 映射：agentId -> sessionId
let agentSessions = {};

// Session 文件路径
const SESSION_FILE = path.join(SESSION_DIR, 'sessions.json');

/**
 * 加载持久化的 Session ID
 */
function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = fs.readFileSync(SESSION_FILE, 'utf8');
      agentSessions = JSON.parse(data);
      console.log(`[Session] 加载了 ${Object.keys(agentSessions).length} 个 Session`);
    }
  } catch (error) {
    console.error(`[Session] 加载失败: ${error.message}`);
    agentSessions = {};
  }
}

/**
 * 保存 Session ID 到文件
 */
function saveSessions() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(agentSessions, null, 2));
  } catch (error) {
    console.error(`[Session] 保存失败: ${error.message}`);
  }
}

/**
 * 获取或创建 Agent 的 Session ID
 * @param {string} agentId
 * @returns {string} Session ID
 */
function getOrCreateSessionId(agentId) {
  if (!agentSessions[agentId]) {
    // 生成新的 Session ID：webui_<agentId>_<timestamp>
    const sessionId = `webui_${agentId}_${Date.now()}`;
    agentSessions[agentId] = sessionId;
    saveSessions();
    console.log(`[Session] 为 Agent ${agentId} 创建新 Session: ${sessionId}`);
  }
  return agentSessions[agentId];
}

/**
 * 重置 Agent 的 Session ID（清空会话时调用）
 * @param {string} agentId
 * @returns {string} 新的 Session ID
 */
function resetSessionId(agentId) {
  const oldSessionId = agentSessions[agentId];
  const newSessionId = `webui_${agentId}_${Date.now()}`;
  agentSessions[agentId] = newSessionId;
  saveSessions();
  console.log(`[Session] Agent ${agentId} Session 已重置: ${oldSessionId} -> ${newSessionId}`);
  return newSessionId;
}

// 启动时加载 Session
loadSessions();

// ==================== 配置文件读取 ====================
let agents = [];

function loadConfig() {
  const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  try {
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);

    if (config.agents && config.agents.list) {
      agents = config.agents.list.map(agent => ({
        id: agent.id,
        name: agent.name,
        emoji: agent.identity?.emoji || '🤖',
        identityName: agent.identity?.name || agent.name,
        model: agent.model?.primary || config.agents.defaults?.model?.primary || ''
      }));
    }

    console.log(`[配置] 成功加载 ${agents.length} 个 Agent`);
    return true;
  } catch (error) {
    console.error(`[配置] 读取失败: ${error.message}`);
    console.error(`[配置] 配置文件路径: ${configPath}`);
    return false;
  }
}

loadConfig();

// ==================== 中间件 ====================
// 增加请求体大小限制以支持图片上传 (50MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== API 路由 ====================

/**
 * GET /api/agents
 * 返回 Agent 列表
 */
app.get('/api/agents', (req, res) => {
  res.json(agents);
});

/**
 * GET /api/session/:agentId
 * 获取指定 Agent 的 Session ID
 */
app.get('/api/session/:agentId', (req, res) => {
  const { agentId } = req.params;
  const sessionId = agentSessions[agentId] || null;
  res.json({ agentId, sessionId });
});

/**
 * POST /api/session/reset
 * 重置指定 Agent 的 Session（清空会话时调用）
 */
app.post('/api/session/reset', (req, res) => {
  const { agentId } = req.body;

  if (!agentId) {
    return res.status(400).json({ error: '缺少 agentId' });
  }

  const newSessionId = resetSessionId(agentId);
  res.json({ agentId, sessionId: newSessionId, message: 'Session 已重置' });
});

/**
 * POST /api/chat
 * 代理聊天请求到 Gateway OpenAI 兼容 API
 *
 * 支持任意文件上传：
 * - 纯文本: { agentId, message }
 * - 带文件: { agentId, message, fileBase64, fileName }
 *
 * Session 绑定：通过 x-openclaw-session-id header 传递
 */
app.post('/api/chat', (req, res) => {
  const { agentId, message, fileBase64, fileName, sessionId: clientSessionId } = req.body;

  if (!agentId || !message) {
    return res.status(400).json({ error: '缺少 agentId 或 message' });
  }

  // 获取 Session ID（优先使用客户端传递的，否则获取或创建）
  const sessionId = clientSessionId || getOrCreateSessionId(agentId);

  let finalMessage = message;

  // 处理文件：文件落盘 + 路径注入
  if (fileBase64 && fileName) {
    try {
      // 提取 Base64 数据（移除 data:xxx;base64, 前缀）
      let base64Data = fileBase64;
      let fileExt = path.extname(fileName).toLowerCase();

      // 如果是 Data URL 格式，提取纯 Base64
      const matches = fileBase64.match(/^data:[^;]+;base64,(.+)$/);
      if (matches) {
        base64Data = matches[1];
      }

      // 确保文件扩展名有效
      if (!fileExt || fileExt === '.') {
        fileExt = '.bin';
      }

      // 生成唯一文件名（保留原始扩展名）
      const uniqueName = `${Date.now()}_${crypto.randomUUID().substring(0, 8)}${fileExt}`;
      const filePath = path.join(UPLOAD_DIR, uniqueName);

      // 解码并保存文件
      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(filePath, buffer);

      console.log(`[上传] 文件已保存: ${filePath} (${buffer.length} bytes, 类型: ${fileExt})`);

      // 路径注入 - 通用模板
      finalMessage = message + `\n\n[系统提示：用户上传了附件文件，请使用你内置的工具读取此本地文件的绝对路径并进行分析: ${filePath}]`;

    } catch (error) {
      console.error(`[上传] 文件保存失败: ${error.message}`);
      // 继续发送纯文本消息
    }
  }

  // 构建请求体 - 纯文本格式
  const requestBody = {
    model: `openclaw:${agentId}`,
    messages: [{ role: 'user', content: finalMessage }],
    stream: true
  };

  console.log(`[聊天] Agent: ${agentId}, Session: ${sessionId}, 消息: ${message.substring(0, 50)}...${fileBase64 ? ` [含文件: ${fileName}]` : ''}`);

  // 发送请求到 Gateway
  const gatewayReq = http.request({
    hostname: GATEWAY_HOST,
    port: GATEWAY_PORT,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      'x-openclaw-agent-id': agentId,
      'x-openclaw-session-id': sessionId  // 关键：绑定 Session
    },
    timeout: REQUEST_TIMEOUT
  }, (gatewayRes) => {
    if (gatewayRes.statusCode !== 200) {
      let errorBody = '';
      gatewayRes.on('data', chunk => errorBody += chunk);
      gatewayRes.on('end', () => {
        console.error(`[错误] Gateway ${gatewayRes.statusCode}: ${errorBody}`);
        res.status(gatewayRes.statusCode).json({
          error: `Gateway 错误: ${gatewayRes.statusCode}`,
          details: errorBody
        });
      });
      return;
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 直接转发流式数据
    gatewayRes.pipe(res);

    gatewayRes.on('end', () => {
      console.log(`[聊天] 响应完成`);
    });
  });

  gatewayReq.on('error', (error) => {
    console.error(`[错误] 连接失败: ${error.message}`);
    res.status(502).json({ error: `无法连接 Gateway: ${error.message}` });
  });

  gatewayReq.on('timeout', () => {
    console.error(`[错误] 请求超时`);
    gatewayReq.destroy();
    res.status(504).json({ error: 'Gateway 请求超时' });
  });

  gatewayReq.write(JSON.stringify(requestBody));
  gatewayReq.end();
});

// ==================== 启动服务器 ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log('  OpenClaw WebUI 已启动');
  console.log('========================================');
  console.log(`  本地访问: http://localhost:${PORT}`);
  console.log(`  局域网访问: http://<服务器IP>:${PORT}`);
  console.log(`  Gateway API: http://${GATEWAY_HOST}:${GATEWAY_PORT}/v1/chat/completions`);
  console.log(`  上传目录: ${UPLOAD_DIR}`);
  console.log(`  Session 目录: ${SESSION_DIR}`);
  console.log('========================================');
  console.log('');
});