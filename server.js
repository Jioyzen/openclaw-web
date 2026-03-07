/**
 * OpenClaw WebUI - 简化版 HTTP 代理
 *
 * 使用 OpenAI 兼容 API + SSE 流式响应
 * 支持图片上传：本地文件落盘 + 路径注入策略
 *
 * 环境配置：通过 .env 文件或环境变量配置
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

// 请求超时
const REQUEST_TIMEOUT = 120000;

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log(`[上传] 创建上传目录: ${UPLOAD_DIR}`);
}

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
 * POST /api/chat
 * 代理聊天请求到 Gateway OpenAI 兼容 API
 *
 * 支持任意文件上传：
 * - 纯文本: { agentId, message }
 * - 带文件: { agentId, message, fileBase64, fileName }
 *
 * 文件处理策略：本地文件落盘 + 路径注入
 */
app.post('/api/chat', (req, res) => {
  const { agentId, message, fileBase64, fileName } = req.body;

  if (!agentId || !message) {
    return res.status(400).json({ error: '缺少 agentId 或 message' });
  }

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

  console.log(`[聊天] Agent: ${agentId}, 消息: ${message.substring(0, 50)}...${fileBase64 ? ` [含文件: ${fileName}]` : ''}`);

  // 发送请求到 Gateway
  const gatewayReq = http.request({
    hostname: GATEWAY_HOST,
    port: GATEWAY_PORT,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      'x-openclaw-agent-id': agentId
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
  console.log('========================================');
  console.log('');
});