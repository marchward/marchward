/**
 * @marchward/proxy — Public API
 *
 * Exports proxy classes and types for programmatic use.
 *
 * Two proxy modes:
 * - MarchwardProxy:     MCP stdio proxy (intercepts JSON-RPC tools/call)
 * - MarchwardHttpProxy: HTTP reverse proxy (intercepts REST API tool calls)
 *
 * For CLI usage, run `marchward-proxy` (MCP) or `marchward-http-proxy` (HTTP).
 */

// ─── MCP Proxy ──────────────────────────────────────────────────────

export { MarchwardProxy } from "./proxy.js";

// ─── HTTP Proxy ─────────────────────────────────────────────────────

export { MarchwardHttpProxy } from "./http-proxy.js";

// ─── Back-compat aliases (pre-Marchward names; deprecated) ───

// ─── Shared ─────────────────────────────────────────────────────────

export { PolicyEvaluator } from "./evaluator.js";
export { Logger } from "./logger.js";

// ─── Local cost cap ─────────────────────────────────────────────────

export {
  LocalCostCap,
  extractTokenUsage,
  estimateCost,
  DEFAULT_COST_TABLE,
  DEFAULT_FALLBACK_COST,
} from "./cost-cap.js";
export type { TokenUsage, CostRates, LocalCostCapOptions, CostCheck } from "./cost-cap.js";

// ─── MCP Types ──────────────────────────────────────────────────────

export type {
  ProxyConfig,
  ProxyEvent,
  ProxyEventType,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  McpToolCallParams,
  McpToolResult,
} from "./types.js";

// ─── HTTP Types ─────────────────────────────────────────────────────

export type {
  HttpProxyConfig,
  HttpProxyEvent,
  HttpProxyEventType,
  ExtractedToolCall,
  ToolExtractionStrategy,
  ToolExtractorFn,
  MarchwardErrorBody,
} from "./http-types.js";

// ─── Shared Types ───────────────────────────────────────────────────

export type { EvalResult } from "./evaluator.js";
export type { LogLevel } from "./logger.js";
