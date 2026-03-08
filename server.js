/**
 * OpenClaw WebUI - WebSocket 直连模式
 *
 * 通过 WebSocket Gateway 直接通信，实现零延迟流式响应
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const WebSocket = require('ws');

const app = express();

// ==================== 环境配置 ====================
const PORT = parseInt(process.env.PORT, 10) || 3000;
const GATEWAY_HOST = process.env.GATEWAY_HOST || 'localhost';
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT, 10) || 18789;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';

// 目录配置 - 全部使用项目目录，避免 systemd ProtectHome 限制
const DATA_DIR = path.join(__dirname, 'data');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');  // Session ID 映射
const DEVICE_FILE = path.join(DATA_DIR, 'device.json');
const UPLOAD_DIR = path.join(os.tmpdir(), 'openclaw_uploads');
const HISTORY_DIR = path.join(__dirname, 'sessions');  // 聊天历史存储目录

// 确保目录存在
[SESSION_DIR, UPLOAD_DIR, HISTORY_DIR, DATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ==================== Ed25519 密钥工具 ====================

const ED25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
]);

function base64UrlEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}

function derivePublicKeyRaw(publicKeyPem) {
  const publicKeyObj = crypto.createPublicKey(publicKeyPem);
  const der = publicKeyObj.export({ type: 'spki', format: 'der' });
  return der.slice(-32);
}

function deriveDeviceIdFromPublicKey(publicKeyPem) {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(signature);
}

// ==================== 设备身份管理 ====================

let deviceIdentity = null;
let gatewayToken = GATEWAY_TOKEN;

function loadOrCreateDeviceIdentity() {
  // 先尝试加载现有的 WebUI 专用设备
  if (fs.existsSync(DEVICE_FILE)) {
    try {
      deviceIdentity = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8'));
      console.log(`[设备] 已加载 WebUI 设备: ${deviceIdentity.deviceId}`);
      return deviceIdentity;
    } catch (e) {
      console.error('[设备] 加载失败，将重新生成');
    }
  }

  // 尝试复用 OpenClaw CLI 的设备身份（已配对）
  const openclawIdentityFile = path.join(os.homedir(), '.openclaw', 'identity', 'device.json');
  const openclawPairedFile = path.join(os.homedir(), '.openclaw', 'devices', 'paired.json');

  if (fs.existsSync(openclawIdentityFile) && fs.existsSync(openclawPairedFile)) {
    try {
      const identity = JSON.parse(fs.readFileSync(openclawIdentityFile, 'utf8'));
      const paired = JSON.parse(fs.readFileSync(openclawPairedFile, 'utf8'));

      if (paired[identity.deviceId]?.approvedScopes) {
        deviceIdentity = {
          deviceId: identity.deviceId,
          publicKeyPem: identity.publicKeyPem,
          privateKeyPem: identity.privateKeyPem,
          approvedScopes: paired[identity.deviceId].approvedScopes,
          source: 'openclaw-cli'
        };

        // 保存到 WebUI 目录
        fs.writeFileSync(DEVICE_FILE, JSON.stringify(deviceIdentity, null, 2));
        console.log(`[设备] 复用 OpenClaw CLI 设备: ${deviceIdentity.deviceId}`);
        return deviceIdentity;
      }
    } catch (e) {
      console.error('[设备] 复用 CLI 身份失败:', e.message);
    }
  }

  // 生成新的 Ed25519 密钥对
  console.log('[设备] 生成新的 Ed25519 密钥对...');
  const keyPair = crypto.generateKeyPairSync('ed25519');

  const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyRaw = derivePublicKeyRaw(publicKeyPem);
  const deviceId = crypto.createHash('sha256').update(publicKeyRaw).digest('hex');

  deviceIdentity = {
    deviceId,
    publicKeyPem,
    privateKeyPem,
    publicKeyBase64Url: base64UrlEncode(publicKeyRaw),
    approvedScopes: [
      'operator.read',
      'operator.write',
      'operator.admin',
      'operator.approvals',
      'operator.pairing'
    ],
    source: 'webui-generated',
    createdAtMs: Date.now()
  };

  // 保存设备身份
  fs.writeFileSync(DEVICE_FILE, JSON.stringify(deviceIdentity, null, 2));
  console.log(`[设备] 已生成新设备: ${deviceId}`);

  // 尝试自动配对
  try {
    console.log(`[设备] 尝试自动配对...`);
    execSync(`openclaw devices approve ${deviceId}`, { stdio: 'inherit' });
    console.log(`[设备] 配对请求已发送`);
  } catch (e) {
    console.error(`[设备] 自动配对失败，请手动执行: openclaw devices approve ${deviceId}`);
  }

  return deviceIdentity;
}

// ==================== 配置加载 ====================

let agents = [];

function loadConfig() {
  const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (config.agents?.list) {
      agents = config.agents.list.map(agent => ({
        id: agent.id,
        name: agent.name,
        emoji: agent.identity?.emoji || '🤖',
        identityName: agent.identity?.name || agent.name,
        model: agent.model?.primary || ''
      }));
    }

    if (!gatewayToken && config.gateway?.auth?.token) {
      gatewayToken = config.gateway.auth.token;
    }

    console.log(`[配置] 加载了 ${agents.length} 个 Agent`);
  } catch (error) {
    console.error(`[配置] 加载失败: ${error.message}`);
  }
}

// ==================== Session 管理 ====================

let agentSessions = {};
const SESSION_FILE = path.join(SESSION_DIR, 'sessions.json');

function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      agentSessions = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      console.log(`[Session] 加载了 ${Object.keys(agentSessions).length} 个 Session`);
    }
  } catch (error) {
    agentSessions = {};
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(agentSessions, null, 2));
  } catch (error) {}
}

function getOrCreateSessionId(agentId) {
  if (!agentSessions[agentId]) {
    agentSessions[agentId] = `webui_${agentId}_${Date.now()}`;
    saveSessions();
  }
  return agentSessions[agentId];
}

function resetSessionId(agentId) {
  agentSessions[agentId] = `webui_${agentId}_${Date.now()}`;
  saveSessions();
}

// ==================== 聊天历史持久化存储 ====================

function getHistoryFilePath(agentId) {
  return path.join(HISTORY_DIR, `${agentId}.json`);
}

function saveChatHistory(agentId, history) {
  try {
    const filePath = getHistoryFilePath(agentId);
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf8');
    console.log(`[History] 保存 ${agentId} 聊天历史: ${history.length} 条消息`);
  } catch (e) {
    console.error(`[History] 保存失败: ${e.message}`);
  }
}

function loadChatHistory(agentId) {
  try {
    const filePath = getHistoryFilePath(agentId);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error(`[History] 加载失败: ${e.message}`);
  }
  return [];
}

function clearChatHistory(agentId) {
  try {
    const filePath = getHistoryFilePath(agentId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[History] 清空 ${agentId} 聊天历史`);
    }
  } catch (e) {
    console.error(`[History] 清空失败: ${e.message}`);
  }
}

// ==================== WebSocket Gateway 客户端 ====================

class GatewayClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.sessionKey = null;
    this.reconnectTimer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const wsUrl = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`;  // 不需要 /ws 路径
      console.log(`[WS] 连接: ${wsUrl}`);

      // 设置 connect 请求的 pending promise
      this.pendingRequests.set('connect', { resolve, reject });

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[WS] 连接已建立');
        this.connected = true;
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[WS] 连接关闭: code=${code}, reason=${reason.toString() || '无'}`);
        this.connected = false;
        this.authenticated = false;

        // 拒绝所有待处理的请求
        for (const [id, pending] of this.pendingRequests.entries()) {
          pending.reject(new Error('连接已关闭'));
        }
        this.pendingRequests.clear();

        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error(`[WS] 错误: ${err.message}`);
        reject(err);
      });

      // 超时处理
      setTimeout(() => {
        if (!this.authenticated && this.pendingRequests.has('connect')) {
          this.pendingRequests.delete('connect');
          reject(new Error('认证超时'));
        }
      }, 15000);
    });
  }

  handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.error('[WS] JSON 解析失败');
      return;
    }

    // 处理 connect.challenge 事件
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      this.handleChallenge(msg.payload);
      return;
    }

    // 处理响应
    if (msg.type === 'res') {
      if (msg.id === '1' && this.pendingRequests.has('connect')) {
        // connect 响应
        if (msg.error) {
          console.error('[WS] 认证失败:', msg.error);
          const pending = this.pendingRequests.get('connect');
          this.pendingRequests.delete('connect');
          pending?.reject?.(new Error(msg.error.message || '认证失败'));
        } else {
          console.log('[WS] ✅ 认证成功');
          this.authenticated = true;
          this.sessionKey = msg.payload?.sessionKey || null;
          const pending = this.pendingRequests.get('connect');
          this.pendingRequests.delete('connect');
          pending?.resolve?.(true);
        }
        return;
      }

      // 处理其他请求的响应
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        // 对于流式请求，收到 started 响应后保留 pending 以便处理后续事件
        if (pending.isStreaming && msg.payload?.status === 'started') {
          console.log(`[WS] 流式请求已开始: runId=${msg.payload.runId}`);
          // 不删除 pending，等待流式事件
          return;
        }
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || '请求失败'));
        } else {
          pending.resolve(msg.payload);
        }
      }
      return;
    }

    // 处理聊天事件（流式响应）
    if (msg.type === 'event' && (msg.event === 'chat' || msg.event === 'agent')) {
      this.handleChatEvent(msg);
      return;
    }
  }

  handleChallenge(payload) {
    const { nonce } = payload;
    console.log(`[WS] 收到 challenge, nonce: ${nonce.substring(0, 16)}...`);

    const signedAtMs = Date.now();
    // 使用与 CLI 相同的 clientId 和 clientMode
    const clientId = 'cli';
    const clientMode = 'cli';
    const role = 'operator';
    const platform = process.platform;
    const deviceFamily = '';

    // 构建签名 payload (v3 格式) - 必须与 CLI 完全一致
    const signPayload = [
      'v3',
      deviceIdentity.deviceId,
      clientId,
      clientMode,
      role,
      deviceIdentity.approvedScopes.join(','),
      String(signedAtMs),
      gatewayToken,
      nonce,
      platform,
      deviceFamily
    ].join('|');

    const signature = signDevicePayload(deviceIdentity.privateKeyPem, signPayload);
    const publicKeyBase64Url = base64UrlEncode(derivePublicKeyRaw(deviceIdentity.publicKeyPem));

    const connectReq = {
      type: 'req',
      id: '1',
      method: 'connect',
      params: {  // 使用 params 而不是 payload
        minProtocol: 3,  // Gateway 期望协议版本 3
        maxProtocol: 3,
        client: {
          id: clientId,
          version: '1.0.0',
          platform: platform,
          mode: clientMode
        },
        caps: [],
        auth: {
          token: gatewayToken
        },
        role: role,
        scopes: deviceIdentity.approvedScopes,
        device: {
          id: deviceIdentity.deviceId,
          publicKey: publicKeyBase64Url,
          signature: signature,
          signedAt: signedAtMs,
          nonce: nonce
        }
      }
    };

    console.log('[WS] 发送认证请求...');
    this.ws.send(JSON.stringify(connectReq));
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.connected) {
        console.log('[WS] 尝试重连...');
        this.connect().catch(e => console.error('[WS] 重连失败:', e.message));
      }
    }, 5000);
  }

  // 发送 /hello 指令触发 agent 打招呼（用于 reset 后）
  sendHello(agentId, sessionId, res) {
    return new Promise((resolve, reject) => {
      if (!this.authenticated) {
        reject(new Error('WebSocket 未认证'));
        return;
      }

      const reqId = String(++this.requestId);

      // 存储响应流以供流式事件使用
      this.pendingRequests.set(reqId, {
        resolve,
        reject,
        res,
        isStreaming: true
      });

      const sessionKey = `agent:${agentId}:${sessionId}`;

      // 发送 /hello 指令
      const chatReq = {
        type: 'req',
        id: reqId,
        method: 'chat.send',
        params: {
          sessionKey: sessionKey,
          message: '/hello',
          idempotencyKey: `${Date.now()}-hello`
        }
      };

      console.log(`[WS] 发送 /hello: sessionKey=${sessionKey}`);

      // 设置 SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      this.ws.send(JSON.stringify(chatReq));

      // 超时处理
      setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          this.pendingRequests.delete(reqId);
          reject(new Error('请求超时'));
        }
      }, 60000);
    });
  }

  // 发送聊天消息
  sendChat(agentId, message, sessionId, res) {
    return new Promise((resolve, reject) => {
      if (!this.authenticated) {
        reject(new Error('WebSocket 未认证'));
        return;
      }

      const reqId = String(++this.requestId);

      // 存储响应流以供流式事件使用
      this.pendingRequests.set(reqId, {
        resolve,
        reject,
        res,
        isStreaming: true
      });

      // 构建 sessionKey: agent:{agentId}:{sessionId}
      const sessionKey = `agent:${agentId}:${sessionId}`;

      // 构建 chat.send 请求 (遵循 Gateway schema)
      const chatReq = {
        type: 'req',
        id: reqId,
        method: 'chat.send',
        params: {
          sessionKey: sessionKey,
          message: message,
          idempotencyKey: `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`
        }
      };

      console.log(`[WS] 发送 chat.send: sessionKey=${sessionKey}`);

      // 设置 SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      this.ws.send(JSON.stringify(chatReq));

      // 超时处理
      setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          this.pendingRequests.delete(reqId);
          reject(new Error('请求超时'));
        }
      }, 300000); // 5分钟超时
    });
  }

  handleChatEvent(msg) {
    // 查找对应的响应流
    for (const [reqId, pending] of this.pendingRequests.entries()) {
      if (!pending.isStreaming || !pending.res) continue;

      const res = pending.res;
      const payload = msg.payload || {};

      // 只处理 agent 事件的 stream: assistant（delta 是增量文本）
      // 不处理 chat 事件，因为 chat.message.content 是全量文本，会导致重复
      if (msg.event === 'agent') {
        if (payload.stream === 'assistant') {
          // 流式增量文本
          const delta = payload.data?.delta || '';
          if (delta) {
            res.write(`data: ${JSON.stringify({
              choices: [{ delta: { content: delta } }]
            })}\n\n`);
          }
        } else if (payload.stream === 'lifecycle' && payload.data?.phase === 'end') {
          // 流结束
          res.write('data: [DONE]\n\n');
          res.end();
          this.pendingRequests.delete(reqId);
        }
      }

      // 处理 chat 事件的状态（仅用于错误/中止，不发送文本内容）
      if (msg.event === 'chat') {
        if (payload.state === 'error') {
          const errorMsg = payload.errorMessage || '未知错误';
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { content: `\n\n❌ 错误: ${errorMsg}` } }]
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          this.pendingRequests.delete(reqId);
        } else if (payload.state === 'aborted') {
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { content: '\n\n⚠️ 请求已中止' } }]
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          this.pendingRequests.delete(reqId);
        }
      }
    }
  }

  // 发送请求并等待响应
  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.authenticated) {
        reject(new Error('WebSocket 未认证'));
        return;
      }

      const reqId = String(++this.requestId);

      this.pendingRequests.set(reqId, { resolve, reject });

      const req = {
        type: 'req',
        id: reqId,
        method: method,
        params: params  // 使用 params 而不是 payload
      };

      this.ws.send(JSON.stringify(req));

      // 超时
      setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          this.pendingRequests.delete(reqId);
          reject(new Error('请求超时'));
        }
      }, 30000);
    });
  }
}

// ==================== 智能指令路由器 ====================

/**
 * 解析斜杠指令
 * 返回 { isCommand: boolean, command: string|null, args: string }
 */
function parseCommand(message) {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('/ ')) {
    return { isCommand: false, command: null, args: '' };
  }
  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0]?.toLowerCase() || '';
  const args = parts.slice(1).join(' ');
  return { isCommand: true, command, args };
}

/**
 * 本地构建 /help 响应
 */
function buildHelpResponse() {
  return `ℹ️ **Help**

**Session**
\`/new\` | \`/reset\` | \`/compact\` | \`/stop\`

**Options**
\`/think <level>\` | \`/model <id>\` | \`/verbose on|off\`

**Status**
\`/status\` | \`/whoami\` | \`/context\`

**Skills**
\`/skill <name> [input]\`

More: \`/commands\` for full list`;
}

/**
 * 本地构建 /status 响应
 */
function buildStatusResponse(agentId, sessionId) {
  const wsStatus = gatewayClient.authenticated ? '✅ Connected' : '❌ Disconnected';
  return `📊 **Status**

| Item | Value |
|------|-------|
| Agent | \`${agentId}\` |
| Session | \`${sessionId}\` |
| Gateway | \`${GATEWAY_HOST}:${GATEWAY_PORT}\` |
| WebSocket | ${wsStatus} |
| Mode | WebSocket Direct |`;
}

/**
 * 处理斜杠指令
 * @returns {Object} { handled: boolean, response?: string }
 */
async function handleSlashCommand(message, agentId, sessionId, res) {
  const { isCommand, command, args } = parseCommand(message);

  if (!isCommand) {
    return { handled: false };
  }

  // /help - 本地响应
  if (command === 'help') {
    return { handled: true, response: buildHelpResponse() };
  }

  // /status - 本地响应
  if (command === 'status' || command === 'whoami') {
    return { handled: true, response: buildStatusResponse(agentId, sessionId) };
  }

  // /reset 或 /new - 调用 Gateway RPC，然后发送 /hello 触发 agent 打招呼
  if (command === 'reset' || command === 'new') {
    try {
      if (gatewayClient.authenticated) {
        const sessionKey = `agent:${agentId}:${sessionId}`;
        await gatewayClient.request('sessions.reset', {
          key: sessionKey,
          reason: command
        });
        // 本地生成新 session
        resetSessionId(agentId);

        // 发送 /hello 触发 agent 打招呼（流式响应）
        await gatewayClient.sendHello(agentId, agentSessions[agentId], res);
        return { handled: true };  // 响应已在 sendHello 中处理
      } else {
        // WebSocket 未连接，本地重置
        resetSessionId(agentId);
        return { handled: true, response: '🔄 Session has been reset (local).' };
      }
    } catch (e) {
      console.error('[Command] sessions.reset failed:', e.message);
      // 回退到本地重置
      resetSessionId(agentId);
      return { handled: true, response: '🔄 Session has been reset (local fallback).' };
    }
  }

  // /clear - 本地操作，提示前端清屏
  if (command === 'clear') {
    return { handled: true, response: '🧹 Chat cleared.', clearChat: true };
  }

  // 其他指令不拦截，透传给 Gateway
  return { handled: false };
}

/**
 * SSE 流式发送文本
 */
function streamSSE(res, text) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({
    choices: [{ delta: { content: text } }]
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// ==================== 初始化 ====================

const gatewayClient = new GatewayClient();

async function initialize() {
  // 加载配置
  loadConfig();

  // 加载或创建设备身份
  loadOrCreateDeviceIdentity();

  // 加载 sessions
  loadSessions();

  // 连接 WebSocket Gateway
  try {
    await gatewayClient.connect();
    console.log('[初始化] WebSocket Gateway 连接成功');
  } catch (e) {
    console.error('[初始化] WebSocket Gateway 连接失败:', e.message);
    console.log('[初始化] 将在后台重试...');
  }
}

// ==================== Express 路由 ====================

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/agents', (req, res) => res.json(agents));

// 聊天历史 API
app.get('/api/history/:agentId', (req, res) => {
  const { agentId } = req.params;
  const history = loadChatHistory(agentId);
  res.json({ agentId, history });
});

app.post('/api/history/:agentId', (req, res) => {
  const { agentId } = req.params;
  const { history } = req.body;
  if (!Array.isArray(history)) {
    return res.status(400).json({ error: 'history 必须是数组' });
  }
  saveChatHistory(agentId, history);
  res.json({ success: true, agentId, count: history.length });
});

app.delete('/api/history/:agentId', (req, res) => {
  const { agentId } = req.params;
  clearChatHistory(agentId);
  res.json({ success: true, agentId });
});

app.get('/api/session/:agentId', (req, res) => {
  res.json({ agentId: req.params.agentId, sessionId: agentSessions[req.params.agentId] || null });
});

app.get('/api/status', (req, res) => {
  res.json({
    gateway: `${GATEWAY_HOST}:${GATEWAY_PORT}`,
    mode: 'WebSocket 直连',
    wsConnected: gatewayClient.authenticated
  });
});

// 获取所有 agent 的聊天记录条数
app.get('/api/history-counts', (req, res) => {
  const counts = {};
  agents.forEach(agent => {
    const history = loadChatHistory(agent.id);
    counts[agent.id] = history.length;
  });
  res.json(counts);
});

app.post('/api/session/reset', (req, res) => {
  const { agentId } = req.body;
  if (!agentId) return res.status(400).json({ error: '缺少 agentId' });
  resetSessionId(agentId);
  res.json({ agentId, sessionId: agentSessions[agentId] });
});

app.post('/api/chat', async (req, res) => {
  const { agentId, message, fileBase64, fileName, sessionId: clientSessionId } = req.body;

  if (!agentId || !message) {
    return res.status(400).json({ error: '缺少 agentId 或 message' });
  }

  const sessionId = clientSessionId || getOrCreateSessionId(agentId);

  // 智能指令路由器
  const cmdResult = await handleSlashCommand(message, agentId, sessionId, res);
  if (cmdResult.handled) {
    streamSSE(res, cmdResult.response);
    return;
  }

  // 文件处理
  let finalMessage = message;
  if (fileBase64 && fileName) {
    try {
      const matches = fileBase64.match(/^data:[^;]+;base64,(.+)$/);
      const base64Data = matches ? matches[1] : fileBase64;
      const ext = path.extname(fileName) || '.bin';
      const filePath = path.join(UPLOAD_DIR, `${Date.now()}_${crypto.randomUUID().substring(0, 8)}${ext}`);
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
      finalMessage = message + `\n\n[附件: ${filePath}]`;
      console.log(`[上传] 文件已保存: ${filePath}`);
    } catch (e) {}
  }

  console.log(`[聊天] Agent: ${agentId}, Session: ${sessionId}`);

  // 检查 WebSocket 连接
  if (!gatewayClient.authenticated) {
    // 回退到 REST API
    console.log('[聊天] WebSocket 未连接，回退到 REST API...');
    sendChatViaREST(agentId, finalMessage, sessionId, res);
    return;
  }

  try {
    await gatewayClient.sendChat(agentId, finalMessage, sessionId, res);
  } catch (e) {
    console.error('[聊天] WebSocket 发送失败:', e.message);
    // 回退到 REST API
    sendChatViaREST(agentId, finalMessage, sessionId, res);
  }
});

// REST API 回退
function sendChatViaREST(agentId, message, sessionId, res) {
  const http = require('http');

  const requestBody = {
    model: agentId,
    messages: [{ role: 'user', content: message }],
    stream: true
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${gatewayToken}`,
    'x-openclaw-session-id': sessionId
  };

  const options = {
    hostname: GATEWAY_HOST,
    port: GATEWAY_PORT,
    path: '/v1/chat/completions',
    method: 'POST',
    headers
  };

  console.log(`[REST] 发送请求: agent=${agentId}, session=${sessionId}`);

  const req = http.request(options, (proxyRes) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    proxyRes.on('data', (chunk) => res.write(chunk));
    proxyRes.on('end', () => res.end());
    proxyRes.on('error', (err) => {
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: `\n\n❌ 错误: ${err.message}` } }]
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  req.on('error', (err) => {
    console.error(`[REST] 请求失败: ${err.message}`);
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: `\n\n❌ 错误: 无法连接到 Gateway` } }]
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  req.write(JSON.stringify(requestBody));
  req.end();
}

// ==================== 启动服务器 ====================

initialize().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('========================================');
    console.log('  OpenClaw WebUI 已启动');
    console.log('========================================');
    console.log(`  地址: http://localhost:${PORT}`);
    console.log(`  Gateway: ${GATEWAY_HOST}:${GATEWAY_PORT}`);
    console.log(`  模式: WebSocket 直连 (REST API 回退)`);
    console.log(`  设备: ${deviceIdentity?.deviceId || '未初始化'}`);
    console.log('========================================');
    console.log('');
  });
}).catch(err => {
  console.error('[启动] 初始化失败:', err.message);
  process.exit(1);
});