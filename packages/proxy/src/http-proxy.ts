/**
 * @marchward/proxy — HTTP Reverse Proxy
 *
 * A transparent HTTP reverse proxy that evaluates every incoming request
 * against a Marchward policy before forwarding to the upstream service.
 *
 * Use cases:
 * - LangChain / OpenAI agents making REST tool calls
 * - Custom agent frameworks calling internal APIs
 * - Any HTTP-based tool invocation that needs governance
 *
 * Flow:
 *   Agent → HTTP Proxy → [Policy Evaluation] → Upstream API
 *                                ↓ (if blocked)
 *                         403 + Marchward error body
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { URL } from "node:url";
import type {
  HttpProxyConfig,
  HttpProxyEvent,
  ExtractedToolCall,
  MarchwardErrorBody,
} from "./http-types.js";
import type { ProxyConfig } from "./types.js";
import { PolicyEvaluator } from "./evaluator.js";
import { Logger } from "./logger.js";
import { LocalCostCap } from "./cost-cap.js";

// ─── Hop-by-hop headers (must not be forwarded) ────────────────────

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

// ─── HTTP Proxy ────────────────────────────────────────────────────

export class MarchwardHttpProxy {
  private config: HttpProxyConfig;
  private server: Server | null = null;
  private evaluator: PolicyEvaluator;
  private logger: Logger;
  private eventListeners: Array<(event: HttpProxyEvent) => void> = [];
  /** Local inference cost cap, when `config.costCapUsd` is set. Null = disabled. */
  private costCap: LocalCostCap | null = null;

  constructor(config: HttpProxyConfig) {
    this.config = config;
    this.logger = new Logger(config.logLevel ?? "info");

    if (config.costCapUsd && config.costCapUsd > 0) {
      this.costCap = new LocalCostCap({
        costCapUsd: config.costCapUsd,
        windowMinutes: config.costWindowMinutes,
      });
    }

    // Build a ProxyConfig compatible with PolicyEvaluator
    const evalConfig: ProxyConfig = {
      command: "",        // not used for HTTP proxy
      args: [],           // not used for HTTP proxy
      policyBundleId: config.policyBundleId,
      policyVersion: config.policyVersion,
      agentId: config.agentId,
      mode: config.mode,
      defaultRole: config.defaultRole,
      localMode: config.localMode,
      localPolicy: config.localPolicy,
      marchwardApiUrl: config.marchwardApiUrl,
      marchwardApiKey: config.marchwardApiKey,
      logLevel: config.logLevel,
    };

    this.evaluator = new PolicyEvaluator(evalConfig, this.logger);
  }

  /**
   * Subscribe to proxy events (for programmatic use / dashboards).
   */
  onEvent(listener: (event: HttpProxyEvent) => void): void {
    this.eventListeners.push(listener);
  }

  private emit(event: HttpProxyEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors crash the proxy
      }
    }
    this.logEvent(event);
  }

  /**
   * Start the HTTP proxy server.
   */
  async start(): Promise<void> {
    const host = this.config.host ?? "127.0.0.1";
    const port = this.config.port;

    this.printBanner();

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error(`Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal proxy error" }));
        }
      });
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        this.emit({
          type: "http_proxy_started",
          timestamp: new Date().toISOString(),
          detail: `Listening on ${host}:${port}`,
        });
        resolve();
      });

      this.server!.on("error", (err) => {
        reject(err);
      });
    });
  }

  /**
   * Stop the proxy server.
   */
  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.emit({
            type: "http_proxy_stopped",
            timestamp: new Date().toISOString(),
          });
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the server address (useful for tests).
   */
  address(): { host: string; port: number } | null {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") {
      return { host: addr.address, port: addr.port };
    }
    return null;
  }

  // ─── Request Handler ─────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    this.emit({
      type: "http_request_received",
      timestamp: new Date().toISOString(),
      method,
      path: url,
    });

    // ── Health check ────────────────────────────────────────────────
    if (url === "/_marchward/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        proxy: "marchward-http-proxy",
        upstream: this.config.upstreamUrl,
        policyBundleId: this.config.policyBundleId,
      }));
      return;
    }

    // ── Passthrough paths ───────────────────────────────────────────
    if (this.isPassthrough(url)) {
      this.emit({
        type: "http_request_passthrough",
        timestamp: new Date().toISOString(),
        method,
        path: url,
      });
      await this.forwardRequest(req, res, url);
      return;
    }

    // ── Read request body ───────────────────────────────────────────
    let body: unknown = undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await this.readBody(req);
    }

    // ── Extract tool call ───────────────────────────────────────────
    const extracted = this.extractToolCall(method, url, req.headers as Record<string, string | string[] | undefined>, body);

    if (!extracted) {
      // Can't determine tool name — forward as passthrough
      this.logger.debug(`No tool extracted for ${method} ${url}, forwarding as passthrough`);
      await this.forwardRequest(req, res, url, body);
      return;
    }

    // ── Evaluate against policy ─────────────────────────────────────
    try {
      const { response: decision } = await this.evaluator.evaluate({
        name: extracted.toolName,
        arguments: extracted.arguments,
      });

      const durationMs = Date.now() - startTime;

      switch (decision.result) {
        case "ALLOW":
        case "ALLOW_WITH_CONDITIONS": {
          // Local inference cost-cap trip — the self-host equivalent of the
          // hosted 429. Enforced on spend accumulated from prior forwarded
          // LLM responses; once window spend reaches the cap, block.
          if (this.costCap) {
            const cap = this.costCap.check();
            if (!cap.allowed) {
              this.emit({
                type: "http_request_cost_capped",
                timestamp: new Date().toISOString(),
                toolName: extracted.toolName,
                decision: "BLOCK",
                method,
                path: url,
                durationMs,
                detail: `Inference cost cap reached: $${cap.currentCostUsd.toFixed(4)} ≥ $${cap.capUsd} in window`,
              });
              res.writeHead(429, {
                "Content-Type": "application/json",
                "X-Marchward-Decision": "BLOCK",
                "Retry-After": String(Math.ceil(cap.windowMs / 1000)),
              });
              res.end(JSON.stringify({
                error: "Inference cost cap reached",
                code: "MARCHWARD_COST_CAP",
                toolName: extracted.toolName,
                decision: "BLOCK",
                currentCostUsd: cap.currentCostUsd,
                capUsd: cap.capUsd,
                windowMs: cap.windowMs,
              }));
              break;
            }
          }

          this.emit({
            type: "http_request_allowed",
            timestamp: new Date().toISOString(),
            toolName: extracted.toolName,
            decision: decision.result,
            method,
            path: url,
            durationMs,
          });

          // Forward to upstream
          await this.forwardRequest(req, res, url, body);

          this.emit({
            type: "http_request_completed",
            timestamp: new Date().toISOString(),
            toolName: extracted.toolName,
            method,
            path: url,
            statusCode: res.statusCode,
            durationMs: Date.now() - startTime,
          });
          break;
        }

        case "BLOCK": {
          this.emit({
            type: "http_request_blocked",
            timestamp: new Date().toISOString(),
            toolName: extracted.toolName,
            decision: "BLOCK",
            method,
            path: url,
            durationMs,
            detail: decision.explanation?.join("; "),
          });

          const errorBody: MarchwardErrorBody = {
            error: `Tool call "${extracted.toolName}" was blocked by policy`,
            code: "MARCHWARD_BLOCKED",
            toolName: extracted.toolName,
            decision: "BLOCK",
            reasons: decision.reasonCodes,
            explanation: decision.explanation,
            decisionId: decision.decisionId,
          };

          res.writeHead(403, {
            "Content-Type": "application/json",
            "X-Marchward-Decision": "BLOCK",
            "X-Marchward-Decision-Id": decision.decisionId ?? "",
          });
          res.end(JSON.stringify(errorBody));
          break;
        }

        case "ESCALATE": {
          this.emit({
            type: "http_request_escalated",
            timestamp: new Date().toISOString(),
            toolName: extracted.toolName,
            decision: "ESCALATE",
            method,
            path: url,
            durationMs,
            detail: decision.explanation?.join("; "),
          });

          const escalateBody: MarchwardErrorBody = {
            error: `Tool call "${extracted.toolName}" requires human approval`,
            code: "MARCHWARD_ESCALATED",
            toolName: extracted.toolName,
            decision: "ESCALATE",
            reasons: decision.reasonCodes,
            explanation: decision.explanation,
            decisionId: decision.decisionId,
          };

          res.writeHead(202, {
            "Content-Type": "application/json",
            "X-Marchward-Decision": "ESCALATE",
            "X-Marchward-Decision-Id": decision.decisionId ?? "",
          });
          res.end(JSON.stringify(escalateBody));
          break;
        }

        default: {
          // Unknown decision — fail closed
          this.logger.warn(`Unknown decision "${decision.result}" — blocking`);
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "Unknown policy decision — blocked by default",
            code: "MARCHWARD_UNKNOWN_DECISION",
            toolName: extracted.toolName,
            decision: decision.result,
          }));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Policy evaluation failed: ${msg}`);

      this.emit({
        type: "http_request_error",
        timestamp: new Date().toISOString(),
        toolName: extracted.toolName,
        method,
        path: url,
        detail: msg,
      });

      // Fail closed — block on error
      res.writeHead(503, {
        "Content-Type": "application/json",
        "X-Marchward-Decision": "BLOCK",
      });
      res.end(JSON.stringify({
        error: "Policy evaluation failed — blocked by default",
        code: "MARCHWARD_EVAL_ERROR",
        toolName: extracted.toolName,
        decision: "BLOCK",
        explanation: [msg],
      }));
    }
  }

  // ─── Tool Extraction ─────────────────────────────────────────────

  private extractToolCall(
    method: string,
    url: string,
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): ExtractedToolCall | null {
    const strategy = this.config.toolExtraction;

    switch (strategy) {
      case "path":
        return this.extractFromPath(url, body);

      case "header":
        return this.extractFromHeader(headers, body);

      case "body":
        return this.extractFromBody(body);

      case "custom": {
        if (!this.config.customExtractor) {
          this.logger.error("Custom extraction strategy requires customExtractor function");
          return null;
        }
        return this.config.customExtractor({ method, url, headers, body });
      }

      default:
        return this.extractFromPath(url, body);
    }
  }

  /**
   * Path-based extraction: POST /tools/send_email → tool "send_email"
   */
  private extractFromPath(url: string, body: unknown): ExtractedToolCall | null {
    const prefix = this.config.pathPrefix ?? "/tools";
    const pathname = new URL(url, "http://localhost").pathname;

    if (!pathname.startsWith(prefix + "/")) {
      return null;
    }

    const toolName = pathname.slice(prefix.length + 1).split("/")[0];
    if (!toolName) return null;

    return {
      toolName: decodeURIComponent(toolName),
      arguments: (body && typeof body === "object" ? body : {}) as Record<string, unknown>,
    };
  }

  /**
   * Header-based extraction: X-Marchward-Tool: send_email
   */
  private extractFromHeader(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): ExtractedToolCall | null {
    const toolHeader = headers["x-marchward-tool"];
    const toolName = Array.isArray(toolHeader) ? toolHeader[0] : toolHeader;

    if (!toolName) return null;

    return {
      toolName,
      arguments: (body && typeof body === "object" ? body : {}) as Record<string, unknown>,
    };
  }

  /**
   * Body-based extraction. Supports multiple formats:
   * - Marchward format:   { toolName: "send_email", arguments: {...} }
   * - OpenAI format:  { name: "send_email", arguments: {...} }
   * - Wrapped format: { tool_call: { name: "...", arguments: {...} } }
   */
  private extractFromBody(body: unknown): ExtractedToolCall | null {
    if (!body || typeof body !== "object") return null;

    const b = body as Record<string, unknown>;

    // Marchward native format
    if (typeof b["toolName"] === "string") {
      return {
        toolName: b["toolName"] as string,
        arguments: (b["arguments"] as Record<string, unknown>) ?? {},
      };
    }

    // OpenAI / generic format
    if (typeof b["name"] === "string") {
      let args = b["arguments"];
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      return {
        toolName: b["name"] as string,
        arguments: (args as Record<string, unknown>) ?? {},
      };
    }

    // Wrapped format (e.g. from LangChain)
    const toolCall = b["tool_call"] as Record<string, unknown> | undefined;
    if (toolCall && typeof toolCall === "object") {
      const name = (toolCall["name"] ?? toolCall["toolName"]) as string | undefined;
      if (name) {
        return {
          toolName: name,
          arguments: (toolCall["arguments"] as Record<string, unknown>) ?? {},
        };
      }
    }

    return null;
  }

  // ─── Request Forwarding ──────────────────────────────────────────

  private async forwardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    body?: unknown,
  ): Promise<void> {
    const upstream = new URL(path, this.config.upstreamUrl);
    const method = req.method ?? "GET";

    // Build headers, filtering out hop-by-hop
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase()) && value) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
    }

    // Add upstream host
    headers["host"] = upstream.host;

    // Add extra headers from config
    if (this.config.extraHeaders) {
      Object.assign(headers, this.config.extraHeaders);
    }

    // Add Marchward tracing header
    headers["x-marchward-proxy"] = "http/1.0";

    const fetchOpts: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.config.timeout ?? 30_000),
    };

    // Attach body for non-GET/HEAD requests
    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      fetchOpts.body = typeof body === "string" ? body : JSON.stringify(body);
      if (!headers["content-type"]) {
        headers["content-type"] = "application/json";
      }
    } else if (method !== "GET" && method !== "HEAD") {
      // Stream the raw body if we didn't read it
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      if (chunks.length > 0) {
        fetchOpts.body = Buffer.concat(chunks);
      }
    }

    try {
      const upstreamRes = await fetch(upstream.toString(), fetchOpts);

      // Forward status code
      res.writeHead(upstreamRes.status, Object.fromEntries(
        [...upstreamRes.headers.entries()].filter(
          ([key]) => !HOP_BY_HOP.has(key.toLowerCase()),
        ),
      ));

      // Response body. When a local cost cap is active and the upstream
      // returned JSON, buffer it to extract token usage (Anthropic/OpenAI
      // shapes) for cost accounting, then forward unchanged. Everything else
      // (non-JSON, streamed/SSE bodies, or no cap) streams through untouched.
      const contentType = upstreamRes.headers.get("content-type") ?? "";
      if (this.costCap && contentType.includes("application/json")) {
        const buf = Buffer.from(await upstreamRes.arrayBuffer());
        try {
          this.costCap.recordFromResponse(JSON.parse(buf.toString("utf-8")));
        } catch {
          // Not parseable / not an LLM response — recording is additive, never a gate.
        }
        res.write(buf);
        res.end();
      } else if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } finally {
          reader.releaseLock();
        }
        res.end();
      } else {
        res.end();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Upstream request failed: ${msg}`);

      this.emit({
        type: "http_upstream_error",
        timestamp: new Date().toISOString(),
        method,
        path,
        detail: msg,
      });

      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Upstream request failed",
          code: "MARCHWARD_UPSTREAM_ERROR",
          detail: msg,
        }));
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private isPassthrough(url: string): boolean {
    const paths = this.config.passthroughPaths ?? [];
    const pathname = new URL(url, "http://localhost").pathname;
    return paths.some((p) => pathname === p || pathname.startsWith(p + "/"));
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (!raw) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          // Not JSON — return raw string
          resolve(raw);
        }
      });
      req.on("error", reject);
    });
  }

  // ─── Logging ─────────────────────────────────────────────────────

  private printBanner(): void {
    const RESET = "\x1b[0m";
    const BOLD = "\x1b[1m";
    const DIM = "\x1b[2m";
    const GREEN = "\x1b[32m";
    const CYAN = "\x1b[36m";

    console.error(`
  ${BOLD}╔═══════════════════════════════════════════╗
  ║       ${GREEN}MARCHWARD HTTP PROXY${RESET}${BOLD}  v0.1.0          ║
  ╚═══════════════════════════════════════════╝${RESET}

  ${DIM}Upstream:${RESET}    ${this.config.upstreamUrl}
  ${DIM}Policy:${RESET}      ${this.config.policyBundleId}
  ${DIM}Mode:${RESET}        ${this.config.mode ?? "HITL"}
  ${DIM}Extraction:${RESET}  ${this.config.toolExtraction}
  ${DIM}Listen:${RESET}      ${CYAN}http://${this.config.host ?? "127.0.0.1"}:${this.config.port}${RESET}
`);
  }

  private logEvent(event: HttpProxyEvent): void {
    const RESET = "\x1b[0m";
    const BOLD = "\x1b[1m";
    const DIM = "\x1b[2m";
    const RED = "\x1b[31m";
    const GREEN = "\x1b[32m";
    const YELLOW = "\x1b[33m";
    const BLUE = "\x1b[34m";
    const CYAN = "\x1b[36m";
    const GRAY = "\x1b[90m";

    const ts = new Date().toISOString().slice(11, 23);
    const tool = event.toolName ? `${CYAN}${event.toolName}${RESET}` : "";
    const route = event.method && event.path ? `${DIM}${event.method} ${event.path}${RESET}` : "";

    switch (event.type) {
      case "http_proxy_started":
        console.error(`\n  ${GREEN}${BOLD}🛡️  Marchward HTTP Proxy active${RESET}\n`);
        break;

      case "http_proxy_stopped":
        console.error(`\n  ${DIM}HTTP Proxy stopped.${RESET}\n`);
        break;

      case "http_request_received":
        this.logger.debug(`→ ${event.method} ${event.path}`);
        break;

      case "http_request_allowed":
        console.error(
          `${GRAY}${ts}${RESET} ${GREEN}${BOLD} ✓ ${RESET} ${GREEN}ALLOW${RESET} ${tool} ${route}` +
          (event.durationMs != null ? ` ${DIM}(${event.durationMs}ms)${RESET}` : ""),
        );
        break;

      case "http_request_blocked":
        console.error(
          `${GRAY}${ts}${RESET} ${RED}${BOLD} ✗ ${RESET} ${RED}BLOCK${RESET} ${tool} ${route}` +
          (event.detail ? ` — ${event.detail}` : ""),
        );
        break;

      case "http_request_escalated":
        console.error(
          `${GRAY}${ts}${RESET} ${YELLOW}${BOLD} ⚠ ${RESET} ${YELLOW}ESCALATE${RESET} ${tool} ${route}` +
          (event.detail ? ` — ${event.detail}` : ""),
        );
        break;

      case "http_request_passthrough":
        this.logger.debug(`⤳ Passthrough ${event.method} ${event.path}`);
        break;

      case "http_request_completed":
        this.logger.debug(
          `← ${event.statusCode} ${event.toolName}` +
          (event.durationMs != null ? ` (${event.durationMs}ms)` : ""),
        );
        break;

      case "http_request_error":
        console.error(
          `${GRAY}${ts}${RESET} ${RED}${BOLD}ERR${RESET} ${tool} ${route} — ${event.detail ?? "unknown"}`,
        );
        break;

      case "http_upstream_error":
        console.error(
          `${GRAY}${ts}${RESET} ${RED}${BOLD}ERR${RESET} Upstream: ${event.detail ?? "unknown"}`,
        );
        break;
    }
  }
}
