/**
 * @marchward/proxy — HTTP reverse proxy types
 *
 * Configuration and event types for the HTTP proxy mode.
 * The HTTP proxy sits between AI agents making REST API calls
 * and the upstream service, evaluating each call against policy.
 */

// ─── Tool Extraction ────────────────────────────────────────────────

/**
 * Strategy for extracting tool name + arguments from an HTTP request.
 *
 * - "path":   Tool name comes from the URL path, e.g. POST /tools/send_email
 *             Arguments are the JSON request body.
 *
 * - "header": Tool name comes from the X-Marchward-Tool header.
 *             Arguments are the JSON request body.
 *
 * - "body":   Tool name + arguments extracted from the JSON body.
 *             Expects { toolName: string, arguments: Record<string, unknown> }
 *             or OpenAI function calling format { name: string, arguments: ... }
 *
 * - "custom": User-provided extraction function.
 */
export type ToolExtractionStrategy = "path" | "header" | "body" | "custom";

/** Extracted tool call information from an HTTP request. */
export interface ExtractedToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
}

/** Custom extractor function signature. */
export type ToolExtractorFn = (req: {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}) => ExtractedToolCall | null;

// ─── HTTP Proxy Configuration ───────────────────────────────────────

export interface HttpProxyConfig {
  /** Port to listen on */
  port: number;

  /** Host to bind to (default: "127.0.0.1") */
  host?: string;

  /** Upstream base URL to forward allowed requests to */
  upstreamUrl: string;

  /** How to extract tool name from incoming requests */
  toolExtraction: ToolExtractionStrategy;

  /**
   * Path prefix to strip before extracting tool name.
   * e.g. "/tools" means POST /tools/send_email → tool "send_email"
   * Default: "/tools"
   */
  pathPrefix?: string;

  /** Custom extractor function (required when toolExtraction === "custom") */
  customExtractor?: ToolExtractorFn;

  /** Marchward API URL for remote policy evaluation */
  marchwardApiUrl?: string;

  /** Marchward API key for authentication */
  marchwardApiKey?: string;

  /** Policy bundle ID to evaluate against */
  policyBundleId: string;

  /** Policy bundle version (optional, uses latest if omitted) */
  policyVersion?: string;

  /** Agent ID for tracking */
  agentId?: string;

  /** Default governance mode */
  mode?: "HIC" | "HITL" | "HOTL";

  /** Default role */
  defaultRole?: string;

  /** Whether to run in local mode (engine only, no API calls) */
  localMode?: boolean;

  /** Policy bundle for local mode evaluation */
  localPolicy?: unknown;

  /** Log level */
  logLevel?: "debug" | "info" | "warn" | "error" | "silent";

  /**
   * Passthrough paths that skip policy evaluation entirely.
   * e.g. ["/health", "/openapi.json"]
   */
  passthroughPaths?: string[];

  /** Request timeout in ms (default: 30000) */
  timeout?: number;

  /** Headers to forward to upstream (default: all except hop-by-hop) */
  forwardHeaders?: string[];

  /** Additional headers to add to upstream requests */
  extraHeaders?: Record<string, string>;

  /**
   * Local inference cost cap (USD) per rolling window. When set, the proxy
   * tracks token spend from JSON LLM responses it forwards and trips
   * (HTTP 429) once window spend reaches the cap — the self-host equivalent
   * of the hosted cost cap. Typically sourced from the policy bundle's
   * `costCapUsd`. Omit to disable local cost tracking.
   */
  costCapUsd?: number;

  /** Rolling-window length (minutes) for `costCapUsd`. Default: 60. */
  costWindowMinutes?: number;
}

// ─── HTTP Proxy Events ──────────────────────────────────────────────

export type HttpProxyEventType =
  | "http_proxy_started"
  | "http_proxy_stopped"
  | "http_request_received"
  | "http_request_allowed"
  | "http_request_blocked"
  | "http_request_cost_capped"
  | "http_request_escalated"
  | "http_request_forwarded"
  | "http_request_completed"
  | "http_request_passthrough"
  | "http_request_error"
  | "http_upstream_error";

export interface HttpProxyEvent {
  type: HttpProxyEventType;
  timestamp: string;
  toolName?: string;
  decision?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;
  detail?: string;
}

// ─── Marchward Error Response ───────────────────────────────────────────

export interface MarchwardErrorBody {
  error: string;
  code: string;
  toolName: string;
  decision: string;
  reasons?: string[];
  explanation?: string[];
  decisionId?: string;
}
