# Marchward MCP Server

Govern what an AI coding agent is allowed to **do**, from inside the agent. This is an
[MCP](https://modelcontextprotocol.io) server that exposes [Marchward](https://marchward.ai) governance
operations as tools, so an agent (Claude, Cursor, Copilot, Windsurf, etc.) can check authorization
before it acts, run actions through a credential-mediated gateway, and read its own tamper-evident
audit trail.

Apache-2.0. The agent holds only a Marchward API key; the real downstream credentials are injected
server-side, never by the agent.

## Tools

| Tool | Purpose |
|------|---------|
| `marchward_authorize` | Check whether an action is allowed before the agent takes it (ALLOW / BLOCK / ESCALATE / ALLOW_WITH_CONDITIONS). |
| `marchward_execute` | Run an action through Marchward's credential-mediated gateway. |
| `marchward_register_agent` | Register a new agent so it is governed from its first action. |
| `marchward_list_agents` | List registered agents and their bound policies. |
| `marchward_get_decisions` | Read the governance decision audit trail. |
| `marchward_check_coverage` | Find governance gaps between declared and actually-called tools. |
| `marchward_bind_policy` | Attach a governance policy to an agent. |

## Quick start

You need a Marchward API key (`mw_...`), free at [marchward.ai](https://marchward.ai).

### stdio (Claude Code, Cursor, local)

```json
{
  "mcpServers": {
    "marchward": {
      "command": "npx",
      "args": ["-y", "@marchward/mcp-server"],
      "env": {
        "MARCHWARD_API_URL": "https://api.marchward.ai",
        "MARCHWARD_API_KEY": "mw_your_key_here"
      }
    }
  }
}
```

### Streamable HTTP (remote)

```json
{
  "mcpServers": {
    "marchward": {
      "type": "url",
      "url": "https://mcp.marchward.ai/mcp",
      "headers": { "Authorization": "Bearer mw_your_key_here" }
    }
  }
}
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MARCHWARD_API_URL` | yes | (none) | Marchward API base URL (`https://api.marchward.ai`) |
| `MARCHWARD_API_KEY` | yes (stdio) | (none) | Your Marchward API key (`mw_...`) |
| `TRANSPORT` | no | `stdio` | `stdio` or `http` |
| `PORT` | no | `3100` | HTTP server port (http transport only) |

## Run from source

```bash
npm install
npm run build
MARCHWARD_API_URL=https://api.marchward.ai MARCHWARD_API_KEY=mw_... npm start
```

## How it fits

This server is the agent-facing surface of the Marchward runtime authority. The open governance engine
and proxy live at [github.com/marchward/marchward](https://github.com/marchward/marchward); the hosted
control plane (credential vault, audit-as-a-service, approval workflow) is at
[marchward.ai](https://marchward.ai).
