/**
 * @marchward/proxy — Core MCP proxy
 *
 * Spawns an upstream MCP server as a child process and transparently
 * intercepts stdio communication. When a `tools/call` JSON-RPC request
 * is detected, the proxy evaluates it against the configured policy before
 * deciding whether to forward or block.
 *
 * All other MCP traffic (initialize, resources/*, prompts/*, etc.) is
 * forwarded untouched.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type {
  ProxyConfig,
  ProxyEvent,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolCallParams,
  McpToolDefinition,
} from "./types.js";
import {
  parseMessage,
  isRequest,
  isResponse,
  serializeMessage,
  createMessageReader,
  errorResponse,
  toolResultResponse,
} from "./jsonrpc.js";
import { PolicyEvaluator } from "./evaluator.js";
import { Logger } from "./logger.js";

// ─── MCP Methods ────────────────────────────────────────────────────

const MCP_TOOLS_CALL = "tools/call";
const MCP_TOOLS_LIST = "tools/list";

// ─── Proxy ──────────────────────────────────────────────────────────

export class MarchwardProxy {
  private config: ProxyConfig;
  private upstream: ChildProcess | null = null;
  private evaluator: PolicyEvaluator;
  private logger: Logger;
  private eventListeners: Array<(event: ProxyEvent) => void> = [];
  private pendingRequests = new Map<
    number | string,
    { toolName: string; startTime: number }
  >();
  /** Track tools/list request IDs so we can capture responses */
  private pendingToolsListIds = new Set<number | string>();
  /** Previously registered tool names (for diff detection) */
  private knownToolNames = new Set<string>();

  constructor(config: ProxyConfig) {
    this.config = config;
    this.logger = new Logger(config.logLevel ?? "info");
    this.evaluator = new PolicyEvaluator(config, this.logger);
  }

  /**
   * Subscribe to proxy events (for programmatic use / dashboards).
   */
  onEvent(listener: (event: ProxyEvent) => void): void {
    this.eventListeners.push(listener);
  }

  private emit(event: ProxyEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors crash the proxy
      }
    }
    this.logger.proxyEvent(event);
  }

  /**
   * Start the proxy: spawn upstream, wire stdio, begin intercepting.
   */
  async start(): Promise<void> {
    this.logger.banner({
      command: `${this.config.command} ${this.config.args.join(" ")}`,
      policyBundleId: this.config.policyBundleId,
      mode: this.config.mode,
    });

    // Merge environment variables
    const env = {
      ...process.env,
      ...(this.config.env ?? {}),
    };

    // Spawn the upstream MCP server
    this.upstream = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    if (!this.upstream.stdout || !this.upstream.stdin || !this.upstream.stderr) {
      throw new Error("Failed to create stdio pipes for upstream process");
    }

    // ─── Wire stdin → upstream (with interception) ────────────────
    this.wireClientToUpstream(process.stdin);

    // ─── Wire upstream stdout → stdout (passthrough) ──────────────
    this.wireUpstreamToClient(this.upstream.stdout);

    // ─── Forward upstream stderr → our stderr ─────────────────────
    this.upstream.stderr.on("data", (chunk: Buffer) => {
      this.logger.debug(`[upstream stderr] ${chunk.toString().trim()}`);
    });

    // ─── Handle upstream exit ─────────────────────────────────────
    this.upstream.on("exit", (code, signal) => {
      this.emit({
        type: "proxy_stopped",
        timestamp: new Date().toISOString(),
        detail: `Upstream exited (code=${code}, signal=${signal})`,
      });
      process.exit(code ?? 0);
    });

    this.upstream.on("error", (err) => {
      this.emit({
        type: "upstream_error",
        timestamp: new Date().toISOString(),
        detail: err.message,
      });
      process.exit(1);
    });

    // ─── Handle our own signals ───────────────────────────────────
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());

    // Handle stdin closing (client disconnected)
    process.stdin.on("end", () => this.stop());

    this.emit({
      type: "proxy_started",
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Stop the proxy and kill upstream.
   */
  stop(): void {
    if (this.upstream && !this.upstream.killed) {
      this.upstream.kill("SIGTERM");
    }
    this.emit({
      type: "proxy_stopped",
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Client → Upstream (with interception) ──────────────────────

  private wireClientToUpstream(clientStdin: Readable): void {
    createMessageReader(clientStdin, async (msg, raw) => {
      if (isRequest(msg) && msg.method === MCP_TOOLS_CALL) {
        await this.handleToolCall(msg as JsonRpcRequest);
      } else {
        // Track tools/list requests so we can capture the response
        if (isRequest(msg) && msg.method === MCP_TOOLS_LIST) {
          this.pendingToolsListIds.add((msg as JsonRpcRequest).id);
        }
        // Forward everything else untouched
        this.forwardToUpstream(raw);
      }
    });
  }

  // ─── Upstream → Client (passthrough) ────────────────────────────

  private wireUpstreamToClient(upstreamStdout: Readable): void {
    createMessageReader(upstreamStdout, (msg, raw) => {
      const id = "id" in msg ? (msg as JsonRpcRequest).id : undefined;

      // Track completed tool calls
      if (id != null && this.pendingRequests.has(id)) {
        const pending = this.pendingRequests.get(id)!;
        this.pendingRequests.delete(id);
        this.emit({
          type: "tool_call_completed",
          timestamp: new Date().toISOString(),
          toolName: pending.toolName,
          durationMs: Date.now() - pending.startTime,
        });
      }

      // Capture tools/list responses to register tool definitions
      if (id != null && this.pendingToolsListIds.has(id) && isResponse(msg)) {
        this.pendingToolsListIds.delete(id);
        this.captureToolDefinitions(msg as JsonRpcResponse);
      }

      // Forward to client
      process.stdout.write(raw + "\n");
    });
  }

  // ─── Tool Call Interception ─────────────────────────────────────

  private async handleToolCall(request: JsonRpcRequest): Promise<void> {
    const params = request.params as unknown as McpToolCallParams | undefined;
    const toolName = params?.name ?? "unknown";
    const startTime = Date.now();

    this.emit({
      type: "tool_call_intercepted",
      timestamp: new Date().toISOString(),
      toolName,
    });

    try {
      // Evaluate against policy
      const { response: decision } = await this.evaluator.evaluate({
        name: toolName,
        arguments: params?.arguments,
      });

      const durationMs = Date.now() - startTime;

      switch (decision.result) {
        case "ALLOW":
        case "ALLOW_WITH_CONDITIONS": {
          this.emit({
            type: "tool_call_allowed",
            timestamp: new Date().toISOString(),
            toolName,
            decision: decision.result,
            durationMs,
          });

          // Track this request so we can log when the response comes back
          this.pendingRequests.set(request.id, { toolName, startTime });

          // Forward the original request to upstream
          this.forwardToUpstream(serializeMessage(request).trimEnd());
          break;
        }

        case "BLOCK": {
          this.emit({
            type: "tool_call_blocked",
            timestamp: new Date().toISOString(),
            toolName,
            decision: "BLOCK",
            detail: decision.explanation?.join("; "),
          });

          // Send an error response back to the client
          const blockResp = toolResultResponse(
            request.id,
            `[Marchward] Tool call "${toolName}" was blocked by policy.\n` +
            `Reasons: ${decision.explanation?.join(", ") ?? "policy violation"}`,
            true, // isError
          );
          process.stdout.write(serializeMessage(blockResp));
          break;
        }

        case "ESCALATE": {
          this.emit({
            type: "tool_call_escalated",
            timestamp: new Date().toISOString(),
            toolName,
            decision: "ESCALATE",
            detail: decision.explanation?.join("; "),
          });

          // In proxy mode, escalation = block + notify
          // (The dashboard/human-in-the-loop flow is handled at the API level)
          const escalateResp = toolResultResponse(
            request.id,
            `[Marchward] Tool call "${toolName}" requires human approval.\n` +
            `Reasons: ${decision.explanation?.join(", ") ?? "escalation required"}\n` +
            `This call has been held for review.`,
            true, // isError — tells the agent to wait
          );
          process.stdout.write(serializeMessage(escalateResp));
          break;
        }

        default: {
          // Unknown decision — fail closed
          this.logger.warn(`Unknown decision "${decision.result}" — blocking`);
          const fallbackResponse = errorResponse(
            request.id,
            -32000,
            `Policy evaluation returned unknown decision: ${decision.result}`,
          );
          process.stdout.write(serializeMessage(fallbackResponse));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Policy evaluation failed: ${msg}`);

      // Fail closed — block on error
      const errorResp = toolResultResponse(
        request.id,
        `[Marchward] Policy evaluation error: ${msg}`,
        true,
      );
      process.stdout.write(serializeMessage(errorResp));
    }
  }

  // ─── Tool Definition Capture ───────────────────────────────────

  /**
   * Extract tool definitions from a tools/list response and register
   * them with the Marchward API for wizard discovery.
   *
   * Re-scans on every tools/list response. Detects net-new tools by
   * diffing against `knownToolNames` and emits `new_tool_detected`
   * events for each previously unseen tool.
   */
  private captureToolDefinitions(response: JsonRpcResponse): void {
    const result = response.result as { tools?: McpToolDefinition[] } | undefined;
    const tools = result?.tools;
    if (!tools || !Array.isArray(tools) || tools.length === 0) return;

    const agentId = this.config.agentId ?? "unknown";
    const currentNames = new Set(tools.map((t) => t.name));

    // Detect net-new tools (present now but not in previous snapshot)
    const newTools: McpToolDefinition[] = [];
    for (const tool of tools) {
      if (!this.knownToolNames.has(tool.name)) {
        newTools.push(tool);
      }
    }

    // Update the known set to the current snapshot
    this.knownToolNames = currentNames;

    if (newTools.length > 0) {
      this.logger.info(
        `Captured ${tools.length} tools from ${agentId} (${newTools.length} new)`,
      );

      // Emit an event for each new tool
      for (const tool of newTools) {
        this.emit({
          type: "new_tool_detected",
          timestamp: new Date().toISOString(),
          toolName: tool.name,
          detail: `New tool "${tool.name}" detected on agent ${agentId}`,
        });
      }
    } else {
      this.logger.debug(
        `Re-scanned ${tools.length} tools from ${agentId} — no changes`,
      );
    }

    // Always re-register the full set (API upserts, so this is idempotent)
    this.registerToolsWithApi(agentId, tools).catch((err) => {
      this.logger.warn(
        `Failed to register tools: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * POST tool definitions to /v1/tools/register on the Marchward API.
   */
  private async registerToolsWithApi(
    agentId: string,
    tools: McpToolDefinition[],
  ): Promise<void> {
    const apiUrl = this.config.marchwardApiUrl;
    const apiKey = this.config.marchwardApiKey;

    if (!apiUrl || !apiKey) {
      this.logger.debug(
        "Skipping tool registration: no API URL or key configured",
      );
      return;
    }

    const body = {
      agentId,
      projectId: this.config.projectId,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };

    // Wall-clock cap so a hung control-plane call cannot wedge proxy
    // startup. Tool registration is best-effort and the proxy will
    // retry on the next health-check tick.
    const resp = await fetch(`${apiUrl}/v1/tools/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`API returned ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as { registered?: number };

    this.emit({
      type: "tools_registered",
      timestamp: new Date().toISOString(),
      toolCount: data.registered ?? tools.length,
      detail: `Registered ${data.registered ?? tools.length} tools for agent ${agentId}`,
    });
  }

  // ─── Forward to upstream ────────────────────────────────────────

  private forwardToUpstream(raw: string): void {
    if (!this.upstream?.stdin?.writable) {
      this.logger.error("Upstream stdin not writable");
      return;
    }
    this.upstream.stdin.write(raw + "\n");
  }
}
