/**
 * @marchward/proxy — Types for JSON-RPC and MCP protocol
 */

// ─── JSON-RPC 2.0 ───────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ─── MCP-Specific Messages ───────────────────────────────────────────

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

// ─── Proxy Configuration ─────────────────────────────────────────────

export interface ProxyConfig {
  /** Command + args to spawn the upstream MCP server */
  command: string;
  args: string[];

  /** Environment variables to pass to the upstream server */
  env?: Record<string, string>;

  /** Marchward API URL for policy evaluation */
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

  /** Project ID for tool registration */
  projectId?: string;

  /** Log level */
  logLevel?: "debug" | "info" | "warn" | "error" | "silent";
}

// ─── Proxy Events ────────────────────────────────────────────────────

export type ProxyEventType =
  | "tool_call_intercepted"
  | "tool_call_allowed"
  | "tool_call_blocked"
  | "tool_call_escalated"
  | "tool_call_forwarded"
  | "tool_call_completed"
  | "tools_registered"
  | "new_tool_detected"
  | "upstream_error"
  | "proxy_started"
  | "proxy_stopped";

export interface ProxyEvent {
  type: ProxyEventType;
  timestamp: string;
  toolName?: string;
  decision?: string;
  decisionId?: string;
  durationMs?: number;
  detail?: string;
  toolCount?: number;
}

/** MCP tool definition from tools/list response */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Project ID for the proxy config */
export interface ProxyProjectConfig {
  /** Project ID for tool registration */
  projectId?: string;
}
