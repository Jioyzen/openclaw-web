# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw WebUI is a minimal LAN chat interface for interacting with OpenClaw Gateway. It uses **WebSocket direct connection** to Gateway for real-time bidirectional communication with zero-latency streaming responses.

## Commands

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The server runs on port 3000 by default and listens on all interfaces (`0.0.0.0`).

## Architecture

### Communication: WebSocket Direct Connection

The WebUI connects directly to OpenClaw Gateway via WebSocket:

```
ws://localhost:18789
Protocol Version: 3
Authentication: Token + Ed25519 Device Signature
```

### Backend (server.js)

Express server with multiple responsibilities:

1. **Configuration Loading**: Reads `~/.openclaw/openclaw.json` at startup
2. **Static File Serving**: Serves the frontend from `public/`
3. **WebSocket Client**: GatewayClient class manages WebSocket connection
4. **Chat History Storage**: Persists to `sessions/*.json`
5. **Smart Command Router**: Handles slash commands locally or forwards to Gateway

### Frontend (public/index.html)

Single-page app with embedded CSS/JS:

- Tailwind CSS via CDN (no build step)
- Markdown rendering: `marked` + `highlight.js`
- SSE streaming via `fetch` + `ReadableStream`
- Chat history loaded from server API

### Key Components

| Component | File | Description |
|-----------|------|-------------|
| GatewayClient | server.js:227-600 | WebSocket connection, auth, message handling |
| Command Router | server.js:600-730 | Slash command processing |
| History Storage | server.js:230-265 | JSON file persistence per agent |
| SSE Streaming | server.js:520-570 | Convert agent events to SSE format |

## Key Implementation Details

### WebSocket Protocol

- **Protocol Version**: Must use `minProtocol: 3, maxProtocol: 3`
- **Request Format**: `{ type: 'req', id: '...', method: '...', params: {...} }`
- **Use `params`, NOT `payload`**: Gateway schema requires `params`

### Device Authentication

```javascript
// v3 signature format
const signPayload = [
  'v3', deviceId, clientId, clientMode, role,
  scopes.join(','), String(signedAtMs), token, nonce, platform, deviceFamily
].join('|');
```

### Streaming Events

- `agent` event `{ stream: 'assistant', data: { delta: '...' } }` → Send incremental text
- `agent` event `{ stream: 'lifecycle', data: { phase: 'end' } }` → End stream
- **Do NOT use `chat` event content** - it's full text, causes duplication

### /reset Command Behavior

1. Call `sessions.reset` RPC
2. Send `/hello` command to trigger agent greeting
3. New session ID generated locally

### Chat History Storage

- Location: `sessions/{agentId}.json`
- Format: Array of `{ role: 'user'|'assistant', content: '...' }`
- API endpoints: GET/POST/DELETE `/api/history/:agentId`

## Critical Rules

1. **Never forward slash commands blindly** - Some commands (`/help`, `/status`) must be handled locally
2. **Never use `chat` event `message.content`** - It's full text, causes duplication
3. **Always use protocol version 3** - Gateway expects v3
4. **Always use `params` field** - Not `payload`

## Configuration

The app reads from `~/.openclaw/openclaw.json`:
- `agents.list` - Array of agent definitions
- `gateway.auth.token` - Bearer token for Gateway

Device identity is reused from OpenClaw CLI (`~/.openclaw/identity/device.json`) or auto-generated.

## References

- OpenAI API reference: https://docs.openclaw.ai/concepts/openai-api
- Slash commands reference: https://docs.openclaw.ai/tools/slash-commands
- Gateway WebSocket Protocol: https://docs.openclaw.ai