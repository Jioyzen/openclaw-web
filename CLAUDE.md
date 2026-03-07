# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw WebUI is a minimal LAN chat interface for interacting with OpenClaw Gateway. It's a lightweight Node.js/Express application that proxies requests to Gateway's OpenAI-compatible API endpoint.

## Commands

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The server runs on port 3000 by default and listens on all interfaces (`0.0.0.0`).

## Architecture

### Communication: OpenAI-Compatible API + SSE

**Do NOT use WebSocket** - Gateway WebSocket protocol requires device signature authentication that is complex to implement. Instead, use the OpenAI-compatible REST API:

```
Endpoint: POST http://localhost:18789/v1/chat/completions
Headers:
  Content-Type: application/json
  Authorization: Bearer <gateway-token>
Body:
  {
    "model": "<agent-id>",  // IMPORTANT: model field = Agent ID
    "messages": [...],
    "stream": true
  }
```

### Backend (server.js)

Simple Express server with three responsibilities:

1. **Configuration Loading**: Reads `~/.openclaw/openclaw.json` at startup to extract agent list
2. **Static File Serving**: Serves the frontend from `public/`
3. **Chat API**: `POST /api/chat` proxies to Gateway's `/v1/chat/completions` with SSE streaming

### Frontend (public/index.html)

Single-page app with embedded CSS/JS using Tailwind CSS via CDN. No build step required.

Uses `fetch` API with ReadableStream to handle SSE streaming responses from the backend proxy.

### Configuration

The app reads from `~/.openclaw/openclaw.json`:
- `agents.list` - Array of agent definitions (id, name, identity, model)
- `gateway.auth.token` - Bearer token for Gateway API authentication

Gateway connection is configured via constants at the top of `server.js`:
- `GATEWAY_HOST` (default: 'localhost')
- `GATEWAY_PORT` (default: 18789)
- `GATEWAY_TOKEN` - Hardcoded token (should match config file)

## Key Implementation Details

- **model field**: Must use Agent ID (e.g., "main"), NOT model name (e.g., "gpt-4")
- **Slash commands** (`/reset`, `/new`, `/status`, etc.) are handled by Gateway through the API
- Gateway config must enable `gateway.http.endpoints.chatCompletions.enabled: true`

## Development Notes

- No test framework is currently configured
- No linting is configured
- The frontend has no build step - it uses Tailwind CDN and vanilla JS
- `test-ws.js` is a leftover from WebSocket experiments - do not use as reference
- OpenAI API reference: https://docs.openclaw.ai/concepts/openai-api
- Slash commands reference: https://docs.openclaw.ai/tools/slash-commands