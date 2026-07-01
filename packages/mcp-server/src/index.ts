#!/usr/bin/env node
/**
 * Marchward MCP Server
 *
 * Exposes Marchward governance operations as MCP tools for AI coding agents.
 * Supports two transports:
 *   - stdio:  Single-user, local. API key from MARCHWARD_API_KEY env var.
 *   - http:   Multi-tenant shared service. Each user passes their own
 *             API key via the Authorization header in their MCP config.
 *             The server holds NO credentials — it's a stateless proxy.
 *
 * Environment variables (TENET_* names still read as a fallback for back-compat):
 *   MARCHWARD_API_URL   — Marchward API base URL (required)
 *   MARCHWARD_API_KEY   — Marchward API key (required for stdio only)
 *   PORT                — HTTP server port (default: 3100, http transport only)
 *   TRANSPORT           — "stdio" or "http" (default: "stdio")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "node:crypto";

import { MarchwardAPIClient } from "./api-client.js";
import { TOOL_DEFINITIONS, createToolHandlers } from "./tools.js";

// ─── Configuration ──────────────────────────────────────────────

const MARCHWARD_API_URL = (process.env.MARCHWARD_API_URL ?? process.env.TENET_API_URL);
const MARCHWARD_API_KEY = (process.env.MARCHWARD_API_KEY ?? process.env.TENET_API_KEY);
const PORT = parseInt(process.env.PORT ?? "3100", 10);
const TRANSPORT = process.env.TRANSPORT ?? "stdio";

// ─── Build Server ───────────────────────────────────────────────

/**
 * Create an MCP server wired to a specific Marchward API client.
 * For stdio: one client per process (key from env).
 * For HTTP: one client per session (key from request headers).
 */
function createMcpServer(apiKey: string): McpServer {
  if (!MARCHWARD_API_URL) {
    throw new Error("MARCHWARD_API_URL environment variable is required");
  }

  const server = new McpServer({
    name: "marchward",
    version: "0.2.1",
  });

  const client = new MarchwardAPIClient({
    apiUrl: MARCHWARD_API_URL,
    apiKey,
  });

  const handlers = createToolHandlers(client);

  // Register each tool with the MCP server
  for (const [key, def] of Object.entries(TOOL_DEFINITIONS)) {
    const handlerFn = handlers[key as keyof typeof handlers];
    if (handlerFn) {
      server.tool(
        def.name,
        def.description,
        def.inputSchema.shape,
        handlerFn as any,
      );
    }
  }

  return server;
}

// ─── stdio Transport (single-user, local) ───────────────────────

async function runStdio() {
  if (!MARCHWARD_API_KEY) {
    throw new Error(
      "MARCHWARD_API_KEY environment variable is required for stdio transport",
    );
  }

  const server = createMcpServer(MARCHWARD_API_KEY);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[marchward-mcp] Running on stdio transport");
}

// ─── HTTP Transport (multi-tenant, shared service) ──────────────

function extractApiKey(req: express.Request): string | null {
  // 1. Check Authorization header (standard MCP auth)
  const auth = req.headers["authorization"];
  if (auth) {
    if (auth.startsWith("Bearer ")) {
      return auth.slice(7);
    }
    if (auth.startsWith("mw_") || auth.startsWith("tnt_")) {
      return auth;
    }
  }

  // 2. Check URL query parameter (for clients like Claude's custom connector
  //    that don't support static Authorization headers — they use OAuth or authless)
  const queryKey = req.query.key as string | undefined;
  if (queryKey?.startsWith("mw_") || queryKey?.startsWith("tnt_")) {
    return queryKey;
  }

  // 3. Fall back to environment variable (single-tenant deployment mode)
  if (MARCHWARD_API_KEY) {
    return MARCHWARD_API_KEY;
  }

  return null;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  apiKey: string;
}

async function runHttp() {
  if (!MARCHWARD_API_URL) {
    throw new Error("MARCHWARD_API_URL environment variable is required");
  }

  const app = express();
  app.use(express.json());

  // Request logging for debugging connector issues
  app.use((req, _res, next) => {
    const hasAuth = !!req.headers["authorization"];
    const hasQueryKey = !!req.query.key;
    const hasEnvKey = !!MARCHWARD_API_KEY;
    console.log(
      `[marchward-mcp] ${req.method} ${req.path} | auth-header: ${hasAuth} | query-key: ${hasQueryKey} | env-fallback: ${hasEnvKey}`,
    );
    next();
  });

  // Track active sessions (transport + the API key they authenticated with)
  const sessions = new Map<string, SessionEntry>();

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // ── Existing session ──────────────────────────────────────
    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId)!;
      await entry.transport.handleRequest(req, res, req.body);
      return;
    }

    // ── New session — extract user's API key from headers ─────
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({
        error: "Missing Authorization header. Include your Marchward API key as: Authorization: Bearer mw_your_key",
      });
      return;
    }

    // Create a server + client scoped to this user's API key
    const server = createMcpServer(apiKey);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    await server.connect(transport);

    // Handle the initial request
    await transport.handleRequest(req, res, req.body);

    // Store session for subsequent requests
    if (transport.sessionId) {
      sessions.set(transport.sessionId, { transport, apiKey });
    }
  });

  // Handle GET for SSE streams
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const entry = sessions.get(sessionId)!;
    await entry.transport.handleRequest(req, res);
  });

  // Handle DELETE for session cleanup
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId)!;
      await entry.transport.close();
      sessions.delete(sessionId);
    }
    res.status(200).json({ ok: true });
  });

  // Health check (no auth required)
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "marchward-mcp-server",
      version: "0.2.1",
      transport: "streamable-http",
      activeSessions: sessions.size,
      marchwardApiUrl: MARCHWARD_API_URL,
    });
  });

  app.listen(PORT, () => {
    console.log(`[marchward-mcp] HTTP server listening on port ${PORT}`);
    console.log(`[marchward-mcp] MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`[marchward-mcp] Health check: http://localhost:${PORT}/health`);
    console.log(`[marchward-mcp] Marchward API: ${MARCHWARD_API_URL}`);
    console.log(`[marchward-mcp] Mode: multi-tenant (API key per session from Authorization header)`);
  });
}

// ─── Entry Point ────────────────────────────────────────────────

async function main() {
  try {
    if (TRANSPORT === "http") {
      await runHttp();
    } else {
      await runStdio();
    }
  } catch (err) {
    console.error("[marchward-mcp] Fatal error:", err);
    process.exit(1);
  }
}

main();
