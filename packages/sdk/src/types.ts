/**
 * @marchward/sdk — SDK-specific types
 *
 * Re-exports engine types that consumers need, plus SDK-specific
 * configuration and response wrapper types.
 */

// Re-export the engine types that SDK consumers need
export type {
  DecisionOutcome,
  GovernanceMode,
  ToolCall,
  AgentInfo,
  RequestContext,
  Signals,
  PolicyBundleRef,
  AuthorizeRequest,
  AuthorizeResponse,
  PolicyBundle,
  PolicyRule,
  PolicyThresholds,
  RoleConfig,
  RuleCondition,
  RuleOperator,
  RuleAction,
  DecisionRecord,
  EvaluationResult,
  RuleHit,
} from "@marchward/engine";

// ─── SDK Configuration ──────────────────────────────────────────────

export interface MarchwardClientConfig {
  /** Marchward API base URL (e.g. "https://api.marchward.ai") */
  apiUrl: string;

  /** Marchward API key (e.g. "mw_abc123...") */
  apiKey: string;

  /** Request timeout in ms (default: 10000) */
  timeout?: number;

  /** Retry configuration */
  retry?: RetryConfig;

  /** Default agent info to include in all requests */
  defaultAgent?: {
    agentId: string;
    agentVersion?: string;
  };

  /** Default governance mode for all requests */
  defaultMode?: "HIC" | "HITL" | "HOTL";

  /** Default role for context */
  defaultRole?: string;

  /** Custom fetch implementation (for testing or custom transports) */
  fetch?: typeof globalThis.fetch;

  /**
   * Idempotency-Key behavior for POST /v1/execute.
   *
   * - `auto` (default): SDK sets `Idempotency-Key: ${requestId}` on every
   *   `execute()` call so retries return the cached response instead of
   *   creating a duplicate review + pending_execution. This is the
   *   recommended setting.
   * - `manual`: SDK does not set the header. Callers that want
   *   idempotency must add the header themselves via a custom `fetch`.
   * - `off`: same as `manual`. Provided as a more explicit name when the
   *   intent is "I have application-level dedup elsewhere."
   */
  idempotency?: "auto" | "manual" | "off";
}

export interface RetryConfig {
  /** Max number of retries (default: 2) */
  maxRetries: number;
  /** Initial backoff in ms (default: 200) */
  initialBackoffMs?: number;
  /** Backoff multiplier (default: 2) */
  multiplier?: number;
  /** Retry on these HTTP status codes (default: [502, 503, 504]) */
  retryOnStatus?: number[];
}

// ─── Authorize Input (simplified) ───────────────────────────────────

/** Simplified authorize input — the SDK fills in defaults. */
export interface AuthorizeInput {
  /** Tool name being called */
  toolName: string;

  /** Tool arguments */
  arguments?: Record<string, unknown>;

  /** Policy bundle ID to evaluate against */
  policyBundleId: string;

  /** Policy version (optional, uses latest if omitted) */
  policyVersion?: string;

  /** Override agent info for this request */
  agent?: {
    agentId: string;
    agentVersion?: string;
  };

  /** Request context */
  context?: Record<string, unknown>;

  /** Signal scores */
  signals?: {
    riskScore?: number;
    confidence?: number;
    [key: string]: unknown;
  };

  /** Override governance mode for this request */
  mode?: "HIC" | "HITL" | "HOTL";

  /** Caller-provided request ID (auto-generated if omitted) */
  requestId?: string;
}

// ─── Decision Query ─────────────────────────────────────────────────

export interface DecisionQuery {
  /** Filter by outcome */
  outcome?: string;
  /** Filter by tool name */
  tool?: string;
  /** Filter by agent ID */
  agent?: string;
  /** Filter from date (ISO 8601) */
  from?: string;
  /** Filter to date (ISO 8601) */
  to?: string;
  /** Max results (default: 50) */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

export interface DecisionListResponse {
  decisions: unknown[];
  total: number;
  limit: number;
  offset: number;
}

// ─── Policy Types ───────────────────────────────────────────────────

export interface PolicyListResponse {
  policies: unknown[];
  total: number;
}

export interface CreatePolicyInput {
  policyBundleId: string;
  version: string;
  name: string;
  description?: string;
  defaultMode: "HIC" | "HITL" | "HOTL";
  thresholds: {
    confidenceMin: number;
    riskBlock: number;
    riskEscalate: number;
  };
  roles: {
    allowedRoles: string[];
    roleOverrides?: Record<string, unknown>;
  };
  rules: unknown[];
  /** Save as draft or active (default: active) */
  status?: "draft" | "active";
}

export interface UpdatePolicyInput {
  name?: string;
  description?: string;
  defaultMode?: "HIC" | "HITL" | "HOTL";
  thresholds?: {
    confidenceMin: number;
    riskBlock: number;
    riskEscalate: number;
  };
  roles?: {
    allowedRoles: string[];
    roleOverrides?: Record<string, unknown>;
  };
  rules?: unknown[];
}

// ─── Health ─────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  timestamp: string;
  database?: string;
  [key: string]: unknown;
}

// ─── Reviews (HITL) ─────────────────────────────────────────────────

export type ReviewStatus = "pending" | "approved" | "rejected" | "expired";

export interface Review {
  id: string;
  decisionId: string;
  status: ReviewStatus;
  toolName: string;
  toolArguments: Record<string, unknown>;
  agentId: string;
  riskScore: number | null;
  reasonCodes: string[];
  context: Record<string, unknown>;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  reviewChannel: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface ReviewQuery {
  /** Filter by status */
  status?: ReviewStatus;
  /** Filter by tool name */
  tool?: string;
  /** Filter by agent ID */
  agent?: string;
  /** Filter from date (ISO 8601) */
  from?: string;
  /** Filter to date (ISO 8601) */
  to?: string;
  /** Max results (default: 50) */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

export interface ReviewListResponse {
  reviews: Review[];
  total: number;
  limit: number;
  offset: number;
}

/** Connector-agnostic resolution input. */
export interface ReviewResolution {
  /** Identity of the reviewer (email, Slack user ID, bot name, etc.) */
  reviewer: string;
  /** Optional notes about the decision */
  notes?: string;
  /** Channel the review came from ("dashboard", "slack", "api", "webhook") */
  channel?: string;
}

export interface ReviewStatsResponse {
  pending: number;
  approved: number;
  rejected: number;
  expired: number;
}

// ─── Policy Packs ──────────────────────────────────────────────────

export type PackCategory =
  | "financial"
  | "infrastructure"
  | "data"
  | "communication"
  | "code"
  | "general";

export interface PackSlot {
  field: string;
  label: string;
  type: "number" | "string" | "string[]";
  default: unknown;
  description: string;
}

export interface PolicyPack {
  packId: string;
  name: string;
  description: string;
  category: PackCategory;
  tags: string[];
  version: string;
  author: string;
  tools: string[];
  ruleCount: number;
  template: {
    defaultMode: "HIC" | "HITL" | "HOTL";
    thresholds: { confidenceMin: number; riskBlock: number; riskEscalate: number };
    roles: { allowedRoles: string[] };
    rules: unknown[];
  };
  customizable: PackSlot[];
}

export interface PackListResponse {
  packs: PolicyPack[];
  total: number;
}

export interface PackInstallRequest {
  overrides?: Record<string, unknown>;
}

export interface PackInstallResponse {
  policy: {
    policyBundleId: string;
    version: string;
    name: string;
  };
  installedFrom: string;
}

// ─── Policy Changelog & Versioning ──────────────────────────────────

export type PolicyStatus = "draft" | "active" | "inactive";

export type PolicyChangelogAction = "created" | "updated" | "deactivated" | "reverted" | "published";

export interface PolicyChangelogEntry {
  id: string;
  policyBundleId: string;
  version: string;
  action: PolicyChangelogAction;
  changedBy: string;
  changeReason?: string;
  changeSummary: string;
  createdAt: string;
}

export interface PolicyVersionSummary {
  version: string;
  isActive: boolean;
  createdAt: string;
  createdBy?: string;
}

export interface PolicyVersionListResponse {
  versions: PolicyVersionSummary[];
  total: number;
}

export interface PolicyChangelogResponse {
  changelog: PolicyChangelogEntry[];
  total: number;
}

export interface RevertPolicyInput {
  targetVersion: string;
  reason?: string;
}

// ─── Execute (Tool Execution Gateway) ────────────────────────────────

/** How credentials are injected into the downstream request. */
export type InjectionStrategy =
  | "header"          // Authorization: Bearer <token>
  | "header_api_key"  // Authorization: <raw_key>
  | "header_custom"   // Custom header
  | "query"           // Query parameter
  | "template";       // {{KEY}} placeholder replacement

export interface ExecuteInput {
  /** Tool name being called */
  toolName: string;

  /** Tool arguments */
  arguments?: Record<string, unknown>;

  /** Policy bundle ID to evaluate against */
  policyBundleId: string;

  /** Policy version (optional, uses latest if omitted) */
  policyVersion?: string;

  /** Override agent info for this request */
  agent?: {
    agentId: string;
    agentVersion?: string;
  };

  /** Request context */
  context?: Record<string, unknown>;

  /** Signal scores */
  signals?: {
    riskScore?: number;
    confidence?: number;
    [key: string]: unknown;
  };

  /** Override governance mode for this request */
  mode?: "HIC" | "HITL" | "HOTL";

  /** Service whose stored credentials should be injected */
  service: string;

  /** The downstream HTTP request to execute */
  downstream: {
    url: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  };

  /** Credential injection strategy (default: header / Bearer token) */
  injection?: {
    strategy: InjectionStrategy;
    headerName?: string;
    paramName?: string;
    credentialField?: string;
  };

  /** Caller-provided request ID (auto-generated if omitted) */
  requestId?: string;
}

// ─── Inference (Phase 1 wedge — May 14 2026) ────────────────────────

/**
 * Provider for `Marchward#inference()`. Determines which downstream URL +
 * service-definition / credential-injection path to use. Both routes
 * go through the same /v1/execute hot path under the hood; the
 * provider just picks the URL and body shape.
 */
export type InferenceProvider = "anthropic" | "openai";

export interface InferenceInput {
  /** "anthropic" or "openai" — selects downstream URL + body shape. */
  provider: InferenceProvider;

  /** Model name passed through to the provider (e.g. "claude-sonnet-4"). */
  model: string;

  /** Messages array, provider-native shape. */
  messages: Array<{ role: string; content: unknown }>;

  /**
   * Any other provider-specific fields (`max_tokens`, `temperature`,
   * `system`, `tools`, etc.) flow through to the downstream body
   * unchanged. The provider validates these.
   */
  [extra: string]: unknown;

  /** Override agent info for this call. */
  agent?: { agentId: string; agentVersion?: string };

  /** Policy bundle to authorize against. */
  policyBundleId?: string;

  /** Policy version (optional, uses latest if omitted). */
  policyVersion?: string;

  /**
   * Max wait for the async downstream call to complete, in ms.
   * Default: 120000 (120s — matches the service-definition timeout
   * for anthropic / openai).
   */
  timeoutMs?: number;

  /** Caller-provided request ID (auto-generated if omitted). */
  requestId?: string;
}

export interface InferenceResponse {
  /** Final execution status — same enum as `ExecutionResult.status`. */
  status: ExecutionStatus;
  /** RequestId, useful for `getExecution()` lookups + idempotent retries. */
  requestId: string;
  /** Decision ID. Always populated except for some pre-policy failures. */
  decisionId?: string;
  /** Engine decision outcome ("ALLOW", "ALLOW_WITH_CONDITIONS", "ESCALATE", "BLOCK"). */
  decision: string;

  /**
   * Provider response body, present when the downstream call ran and
   * returned. May be absent for blocked / expired / pre-flight-failed
   * cases.
   */
  body?: unknown;

  /**
   * Token usage extracted from `body`. Present when `body` is an
   * Anthropic / OpenAI usage-bearing response. Null otherwise.
   */
  tokens?: { input: number; output: number; model: string } | null;
}

export interface ExecuteResponse {
  /** Job ID for async execute — poll GET /v1/jobs/:id for result. */
  jobId?: string;
  /** Job status: pending, running, completed, failed. */
  status?: string;
  decision: string;
  requestId: string;
  decisionId?: string;
  reviewId?: string;
  reasonCodes?: string[];
  message?: string;
  executionError?: string;
  execution?: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    durationMs: number;
    service: string;
  };

  // ─── ESCALATE-path fields (Phase 4 v1 additions) ─────────────────
  // The API populates these when `decision === "ESCALATE"`. Reading them
  // from `ExecuteResponse` is supported but the typed surface is
  // ambiguous — callers should prefer `getExecution(requestId)` which
  // returns the discriminated-union `ExecutionResult` shape.
  /** ISO 8601 expiry for the pending review. */
  expiresAt?: string;
  /** Absolute URL to GET /v1/executions/:requestId. */
  pollUrl?: string;
  /** Dashboard deep-link for the human reviewer. */
  dashboardUrl?: string;
}

// ─── ExecutionResult (discriminated-union state per request) ────────

/**
 * Status taxonomy for {@link ExecutionResult}. The values are stable wire
 * contract; do not rename.
 */
export type ExecutionStatus =
  | "allowed"     // sync ALLOW path — downstream call ran inline at /v1/execute, body NOT re-fetchable from this endpoint
  | "pending"     // ESCALATE — review is open, no downstream call yet
  | "approved"    // ESCALATE → reviewer approved AND downstream returned 2xx
  | "rejected"    // ESCALATE → rejected by reviewer; downstream did NOT run
  | "expired"     // ESCALATE → expiry window elapsed; downstream did NOT run
  | "failed"      // tooling failure (Marchward pre-flight rejection OR approved + non-2xx downstream)
  | "blocked";    // policy BLOCK; downstream did NOT run

/**
 * The canonical state of a tool-call request, returned by
 * `marchward.getExecution(requestId)`. The fields that are present vary by
 * `status`; the TypeScript compiler narrows on `status` in branches.
 */
export interface ExecutionResult {
  status: ExecutionStatus;
  requestId: string;
  decisionId?: string;
  reviewId?: string;

  /** Present for "allowed" and "approved". Also present on "failed" when the failure was a downstream non-2xx (so the agent can inspect the raw response). */
  execution?: {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
    durationMs: number;
    service: string;
  };

  /** Present for "pending". */
  pending?: {
    expiresAt: string;
    pollUrl: string;
    dashboardUrl: string;
  };

  /** Present for "approved", "rejected", "expired" — describes who/when/how. */
  resolution?: {
    reviewer: string | null;
    reviewedAt: string | null;
    notes: string | null;
    channel: string | null;
  };

  /** Present for "rejected". */
  rejection?: {
    reason: "rejected_by_reviewer";
    notes?: string;
  };

  /** Present for "failed". */
  failure?: {
    reason:
      | "credential_not_found"
      | "ssrf_blocked"
      | "template_placeholder_in_body"
      | "downstream_error"
      | "downstream_unreachable"
      | "timeout"
      | "other";
    message: string;
    /** HTTP status code from downstream when reason="downstream_error". */
    downstreamStatus?: number;
  };

  /** Present for "blocked". */
  blocked?: {
    reasonCodes: string[];
    conditions?: unknown;
  };
}

// ─── Errors ─────────────────────────────────────────────────────────

export interface MarchwardApiError {
  error: string;
  message: string;
  statusCode: number;
}
