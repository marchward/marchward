/**
 * @marchward/sdk — Marchward API Client
 *
 * Typed client for the Marchward authorization API. Wraps all endpoints
 * with TypeScript types, automatic retries, and sensible defaults.
 *
 * @example
 * ```typescript
 * import { MarchwardClient } from "@marchward/sdk";
 *
 * const marchward = new MarchwardClient({
 *   apiUrl: "https://api.marchward.ai",
 *   apiKey: "mw_abc123...",
 *   defaultAgent: { agentId: "my-agent" },
 * });
 *
 * // Quick authorize
 * const decision = await marchward.authorize({
 *   toolName: "send_payment",
 *   arguments: { amount: 500, to: "vendor@example.com" },
 *   policyBundleId: "financial-controls",
 * });
 *
 * if (decision.result === "ALLOW") {
 *   await sendPayment(...);
 * }
 * ```
 */

import type { AuthorizeResponse } from "@marchward/engine";
import type {
  MarchwardClientConfig,
  AuthorizeInput,
  DecisionQuery,
  DecisionListResponse,
  PolicyListResponse,
  CreatePolicyInput,
  UpdatePolicyInput,
  HealthResponse,
  Review,
  ReviewQuery,
  ReviewListResponse,
  ReviewResolution,
  ReviewStatsResponse,
  PolicyPack,
  PackListResponse,
  PackInstallRequest,
  PackInstallResponse,
  PolicyVersionListResponse,
  PolicyChangelogResponse,
  ExecuteInput,
  ExecuteResponse,
  ExecutionResult,
  InferenceInput,
  InferenceResponse,
  InferenceProvider,
} from "./types.js";
import { MarchwardApiError, MarchwardTimeoutError, MarchwardRetryError } from "./errors.js";
import { randomUUID } from "node:crypto";

// ─── Client ─────────────────────────────────────────────────────────

export class MarchwardClient {
  private config: Required<
    Pick<MarchwardClientConfig, "apiUrl" | "apiKey" | "timeout">
  > & MarchwardClientConfig;

  private fetchFn: typeof globalThis.fetch;

  constructor(config: MarchwardClientConfig) {
    if (!config.apiUrl) throw new Error("apiUrl is required");
    if (!config.apiKey) throw new Error("apiKey is required");

    this.config = {
      ...config,
      apiUrl: config.apiUrl.replace(/\/+$/, ""), // strip trailing slash
      timeout: config.timeout ?? 10_000,
    };

    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  // ─── Authorization ──────────────────────────────────────────────

  /**
   * Authorize a tool call against a policy.
   * Returns the authorization response with the decision.
   */
  async authorize(input: AuthorizeInput): Promise<AuthorizeResponse> {
    const agent = input.agent ?? this.config.defaultAgent;
    if (!agent) {
      throw new Error(
        "agent is required — provide it in authorize() or set defaultAgent in config",
      );
    }

    const body = {
      requestId: input.requestId ?? randomUUID(),
      toolCall: {
        toolName: input.toolName,
        arguments: input.arguments ?? {},
      },
      agent,
      context: {
        role: this.config.defaultRole,
        ...input.context,
      },
      signals: input.signals ?? {},
      policyBundle: {
        id: input.policyBundleId,
        version: input.policyVersion,
      },
      mode: input.mode ?? this.config.defaultMode,
    };

    return this.request<AuthorizeResponse>("POST", "/v1/authorize", body);
  }

  /**
   * Quick check: is this tool call allowed?
   * Returns true for ALLOW and ALLOW_WITH_CONDITIONS, false otherwise.
   */
  async isAllowed(input: AuthorizeInput): Promise<boolean> {
    const response = await this.authorize(input);
    return response.result === "ALLOW" || response.result === "ALLOW_WITH_CONDITIONS";
  }

  /**
   * Authorize and execute: evaluates the tool call, and if allowed,
   * runs the provided function. Returns null if blocked/escalated.
   */
  async authorizeAndExecute<T>(
    input: AuthorizeInput,
    fn: () => T | Promise<T>,
  ): Promise<{ decision: AuthorizeResponse; result: T | null }> {
    const decision = await this.authorize(input);

    if (decision.result === "ALLOW" || decision.result === "ALLOW_WITH_CONDITIONS") {
      const result = await fn();
      return { decision, result };
    }

    return { decision, result: null };
  }

  // ─── Decisions ──────────────────────────────────────────────────

  /**
   * Get a single decision by ID.
   */
  async getDecision(decisionId: string): Promise<unknown> {
    const res = await this.request<{ decision: unknown }>(
      "GET",
      `/v1/decisions/${encodeURIComponent(decisionId)}`,
    );
    return res.decision;
  }

  /**
   * Query decisions with optional filters.
   */
  async listDecisions(query?: DecisionQuery): Promise<DecisionListResponse> {
    const params = new URLSearchParams();
    if (query?.outcome) params.set("outcome", query.outcome);
    if (query?.tool) params.set("tool", query.tool);
    if (query?.agent) params.set("agent", query.agent);
    if (query?.from) params.set("from", query.from);
    if (query?.to) params.set("to", query.to);
    if (query?.limit != null) params.set("limit", String(query.limit));
    if (query?.offset != null) params.set("offset", String(query.offset));

    const qs = params.toString();
    return this.request<DecisionListResponse>(
      "GET",
      `/v1/decisions${qs ? `?${qs}` : ""}`,
    );
  }

  // ─── Policies ───────────────────────────────────────────────────

  /**
   * List all policy bundles.
   */
  async listPolicies(opts?: {
    activeOnly?: boolean;
    status?: "draft" | "active" | "inactive" | "all";
    limit?: number;
    offset?: number;
  }): Promise<PolicyListResponse> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    else if (opts?.activeOnly === false) params.set("active_only", "false");
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.offset != null) params.set("offset", String(opts.offset));

    const qs = params.toString();
    return this.request<PolicyListResponse>(
      "GET",
      `/v1/policies${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Get a specific policy bundle.
   */
  async getPolicy(bundleId: string, version?: string): Promise<unknown> {
    const params = version ? `?version=${encodeURIComponent(version)}` : "";
    const res = await this.request<{ policy: unknown }>(
      "GET",
      `/v1/policies/${encodeURIComponent(bundleId)}${params}`,
    );
    return res.policy;
  }

  /**
   * Create a new policy bundle.
   */
  async createPolicy(input: CreatePolicyInput): Promise<unknown> {
    const res = await this.request<{ policy: unknown }>(
      "POST",
      "/v1/policies",
      input,
    );
    return res.policy;
  }

  /**
   * Update an existing policy bundle.
   */
  async updatePolicy(
    bundleId: string,
    version: string,
    input: UpdatePolicyInput,
  ): Promise<unknown> {
    const res = await this.request<{ policy: unknown }>(
      "PUT",
      `/v1/policies/${encodeURIComponent(bundleId)}?version=${encodeURIComponent(version)}`,
      input,
    );
    return res.policy;
  }

  /**
   * Publish a draft policy bundle → active.
   * Deactivates any previous active version of the same bundle.
   */
  async publishPolicy(bundleId: string, version: string): Promise<unknown> {
    const res = await this.request<{ policy: unknown }>(
      "POST",
      `/v1/policies/${encodeURIComponent(bundleId)}/publish`,
      { version },
    );
    return res.policy;
  }

  /**
   * Deactivate a policy bundle.
   */
  async deactivatePolicy(bundleId: string, version: string, reason?: string): Promise<void> {
    const params = new URLSearchParams({ version });
    if (reason) params.set("reason", reason);
    await this.request(
      "DELETE",
      `/v1/policies/${encodeURIComponent(bundleId)}?${params.toString()}`,
    );
  }

  /**
   * List all versions of a policy bundle.
   */
  async listPolicyVersions(bundleId: string): Promise<PolicyVersionListResponse> {
    return this.request<PolicyVersionListResponse>(
      "GET",
      `/v1/policies/${encodeURIComponent(bundleId)}/versions`,
    );
  }

  /**
   * Get the audit changelog for a policy bundle.
   */
  async getPolicyChangelog(
    bundleId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<PolicyChangelogResponse> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.offset != null) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.request<PolicyChangelogResponse>(
      "GET",
      `/v1/policies/${encodeURIComponent(bundleId)}/changelog${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Revert a policy bundle to a previous version.
   * Creates a new version with the content of the target version.
   */
  async revertPolicy(
    bundleId: string,
    targetVersion: string,
    reason?: string,
  ): Promise<unknown> {
    const res = await this.request<{ policy: unknown }>(
      "POST",
      `/v1/policies/${encodeURIComponent(bundleId)}/revert`,
      { targetVersion, reason },
    );
    return res.policy;
  }

  // ─── Reviews (HITL) ────────────────────────────────────────────

  /**
   * Query reviews with optional filters.
   */
  async listReviews(query?: ReviewQuery): Promise<ReviewListResponse> {
    const params = new URLSearchParams();
    if (query?.status) params.set("status", query.status);
    if (query?.tool) params.set("tool", query.tool);
    if (query?.agent) params.set("agent", query.agent);
    if (query?.from) params.set("from", query.from);
    if (query?.to) params.set("to", query.to);
    if (query?.limit != null) params.set("limit", String(query.limit));
    if (query?.offset != null) params.set("offset", String(query.offset));

    const qs = params.toString();
    return this.request<ReviewListResponse>(
      "GET",
      `/v1/reviews${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Get a single review by ID.
   */
  async getReview(reviewId: string): Promise<Review> {
    const res = await this.request<{ review: Review }>(
      "GET",
      `/v1/reviews/${encodeURIComponent(reviewId)}`,
    );
    return res.review;
  }

  /**
   * Approve a pending review.
   */
  async approveReview(reviewId: string, resolution: ReviewResolution): Promise<Review> {
    const res = await this.request<{ review: Review }>(
      "POST",
      `/v1/reviews/${encodeURIComponent(reviewId)}/approve`,
      resolution,
    );
    return res.review;
  }

  /**
   * Reject a pending review.
   */
  async rejectReview(reviewId: string, resolution: ReviewResolution): Promise<Review> {
    const res = await this.request<{ review: Review }>(
      "POST",
      `/v1/reviews/${encodeURIComponent(reviewId)}/reject`,
      resolution,
    );
    return res.review;
  }

  /**
   * Get review counts by status.
   */
  async getReviewStats(): Promise<ReviewStatsResponse> {
    return this.request<ReviewStatsResponse>("GET", "/v1/reviews/stats");
  }

  // ─── Policy Packs ────────────────────────────────────────────────

  /**
   * List available policy packs.
   */
  async listPacks(category?: string): Promise<PackListResponse> {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    const qs = params.toString();
    return this.request<PackListResponse>(
      "GET",
      `/v1/packs${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Get a single policy pack by ID.
   */
  async getPack(packId: string): Promise<PolicyPack> {
    const res = await this.request<{ pack: PolicyPack }>(
      "GET",
      `/v1/packs/${encodeURIComponent(packId)}`,
    );
    return res.pack;
  }

  /**
   * Install a policy pack (creates a PolicyBundle from the pack template).
   */
  async installPack(
    packId: string,
    overrides?: Record<string, unknown>,
  ): Promise<PackInstallResponse> {
    const body: PackInstallRequest = overrides ? { overrides } : {};
    return this.request<PackInstallResponse>(
      "POST",
      `/v1/packs/${encodeURIComponent(packId)}/install`,
      body,
    );
  }

  // ─── Tool Execution Gateway ─────────────────────────────────────

  /**
   * Execute a tool call through the Marchward gateway.
   *
   * Authorizes the tool call, resolves stored credentials for the
   * specified service, injects them into the downstream request,
   * executes the HTTP call, and returns the result.
   *
   * The agent never sees the downstream service credentials.
   *
   * @example
   * ```typescript
   * const result = await marchward.execute({
   *   toolName: "monitor_rankings",
   *   arguments: { domain: "example.com" },
   *   policyBundleId: "seo-agent-policy",
   *   service: "ahrefs",
   *   downstream: {
   *     url: "https://apiv2.ahrefs.com/keywords-explorer/overview",
   *     method: "POST",
   *     body: { keywords: ["ai governance"] },
   *   },
   * });
   *
   * if (result.execution) {
   *   console.log(result.execution.body);
   * }
   * ```
   */
  async execute(input: ExecuteInput): Promise<ExecuteResponse> {
    const agent = input.agent ?? this.config.defaultAgent;
    if (!agent) {
      throw new Error(
        "agent is required — provide it in execute() or set defaultAgent in config",
      );
    }

    const requestId = input.requestId ?? randomUUID();

    const body = {
      requestId,
      toolCall: {
        toolName: input.toolName,
        arguments: input.arguments ?? {},
      },
      agent,
      context: {
        role: this.config.defaultRole,
        ...input.context,
      },
      signals: input.signals ?? {},
      policyBundle: {
        id: input.policyBundleId,
        version: input.policyVersion,
      },
      mode: input.mode ?? this.config.defaultMode,
      service: input.service,
      downstream: input.downstream,
      injection: input.injection,
    };

    // Auto-idempotency: by default, key off the requestId so retries of
    // the same call dedupe at the API. The middleware caches the original
    // response and replays it; without this, every retry of an ESCALATE
    // creates a new review + new pending_execution row.
    const extraHeaders =
      this.config.idempotency === "manual" || this.config.idempotency === "off"
        ? undefined
        : { "Idempotency-Key": requestId };

    return this.request<ExecuteResponse>("POST", "/v1/execute", body, extraHeaders);
  }

  // ─── Inference (wedge v1 — May 14 2026) ─────────────────────────

  /**
   * Wrap an LLM inference call. Same hot path as `execute()` under the
   * hood — credential mediation, per-agent cost cap, audit log — with a
   * cleaner one-arg shape for the wedge persona ("solo dev wraps one
   * LLM call").
   *
   * @example
   * ```typescript
   * const reply = await marchward.inference({
   *   provider: "anthropic",
   *   model: "claude-sonnet-4-6",
   *   messages: [{ role: "user", content: "Hello" }],
   *   max_tokens: 1024,
   *   policyBundleId: "default",
   * });
   *
   * if (reply.status === "allowed" || reply.status === "approved") {
   *   console.log(reply.body);          // raw provider response
   *   console.log(reply.tokens);         // { input, output, model }
   * }
   * ```
   *
   * Sets `service` to `"anthropic"` or `"openai"`, hard-codes the
   * downstream URL to the provider's chat-completion endpoint, and
   * polls the async job until it terminates (or the configured
   * `timeoutMs` elapses). Provider-specific fields (`system`,
   * `temperature`, `tools`, etc.) flow through `extra` to the
   * downstream body unchanged.
   *
   * Credential model: the customer's Anthropic / OpenAI key is stored
   * in `service_connections` (envelope-encrypted, never visible to the
   * agent). Marchward injects it server-side at call time.
   */
  async inference(input: InferenceInput): Promise<InferenceResponse> {
    const {
      provider,
      model,
      messages,
      agent: agentOverride,
      policyBundleId,
      policyVersion,
      timeoutMs: callTimeoutMs,
      requestId: callerRequestId,
      ...extra
    } = input;

    if (provider !== "anthropic" && provider !== "openai") {
      throw new Error(
        `Unsupported inference provider: ${JSON.stringify(provider)}. ` +
          `Supported: "anthropic", "openai".`,
      );
    }

    if (!policyBundleId) {
      throw new Error(
        "policyBundleId is required for inference() — pick a policy that " +
          "applies to your inference calls (e.g. 'default-inference-policy').",
      );
    }

    const downstream = buildInferenceDownstream(provider, {
      model,
      messages,
      ...(extra as Record<string, unknown>),
    });

    // Synthesize a tool name that policies can match on. Pattern:
    //   inference.<provider>.<endpoint-noun>
    const toolName =
      provider === "anthropic" ? "inference.anthropic.messages" : "inference.openai.chat";

    const executeInput: ExecuteInput = {
      toolName,
      arguments: { model, messages },
      service: provider,
      downstream,
      ...(agentOverride ? { agent: agentOverride } : {}),
      policyBundleId,
      ...(policyVersion ? { policyVersion } : {}),
      ...(callerRequestId ? { requestId: callerRequestId } : {}),
    };

    const submitted = await this.execute(executeInput);

    // Synchronous return path: some BLOCK / pre-flight failures resolve
    // before the async job is created. Surface those without polling.
    if (
      submitted.decision === "BLOCK" ||
      submitted.executionError ||
      (submitted.execution && submitted.execution.body !== undefined)
    ) {
      const body = submitted.execution?.body;
      return {
        status:
          submitted.decision === "BLOCK"
            ? "blocked"
            : submitted.executionError
              ? "failed"
              : "allowed",
        requestId: submitted.requestId,
        decisionId: submitted.decisionId,
        decision: submitted.decision,
        body,
        tokens: body ? extractTokensFromBody(body) : null,
      };
    }

    // Async path: poll getExecution(requestId) until terminal.
    const requestId = submitted.requestId;
    const deadline = Date.now() + (callTimeoutMs ?? 120_000);
    let pollIntervalMs = 200;

    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.getExecution(requestId);
      if (result.status !== "pending") {
        const body = result.execution?.body;
        return {
          status: result.status,
          requestId,
          decisionId: result.decisionId,
          decision: submitted.decision,
          body,
          tokens: body ? extractTokensFromBody(body) : null,
        };
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      // Cap poll interval at 1s
      pollIntervalMs = Math.min(pollIntervalMs * 1.5, 1000);
    }

    throw new MarchwardTimeoutError(callTimeoutMs ?? 120_000);
  }

  // ─── Execution state lookup ─────────────────────────────────────

  /**
   * Fetch the canonical state of a previously-submitted request by its
   * requestId. Works regardless of which process originated the request —
   * an agent that crashed mid-flight can resume from just the requestId.
   *
   * Returns the discriminated-union {@link ExecutionResult} shape;
   * inspect `result.status` to discriminate (allowed / pending /
   * approved / rejected / expired / failed / blocked).
   *
   * @example
   * ```typescript
   * const result = await marchward.getExecution("req_abc123");
   * if (result.status === "approved") {
   *   console.log("Downstream returned:", result.execution?.body);
   * } else if (result.status === "rejected") {
   *   console.log("Reviewer rejected:", result.resolution?.reviewer);
   * }
   * ```
   *
   * @throws MarchwardApiError with statusCode=404 if no decision or pending
   *   execution exists for the given requestId.
   */
  async getExecution(requestId: string): Promise<ExecutionResult> {
    return this.request<ExecutionResult>(
      "GET",
      `/v1/executions/${encodeURIComponent(requestId)}`,
    );
  }

  // ─── Health ─────────────────────────────────────────────────────

  /**
   * Check API health.
   */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  // ─── HTTP Layer ─────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const retryConfig = this.config.retry;
    const maxAttempts = (retryConfig?.maxRetries ?? 2) + 1;
    const retryOnStatus = retryConfig?.retryOnStatus ?? [502, 503, 504];
    const initialBackoff = retryConfig?.initialBackoffMs ?? 200;
    const multiplier = retryConfig?.multiplier ?? 2;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.doRequest<T>(method, path, body, extraHeaders);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry auth errors or client errors (4xx except 429)
        if (err instanceof MarchwardApiError) {
          if (err.statusCode < 500 && err.statusCode !== 429) throw err;
          if (!retryOnStatus.includes(err.statusCode)) throw err;
        }

        // Don't retry on timeout if it's the last attempt
        if (attempt === maxAttempts) break;

        // Backoff
        const delay = initialBackoff * Math.pow(multiplier, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (maxAttempts > 1 && lastError) {
      throw new MarchwardRetryError(maxAttempts, lastError);
    }
    throw lastError;
  }

  private async doRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.config.apiUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "User-Agent": "@marchward/sdk/0.1.0",
      ...(extraHeaders ?? {}),
    };

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.config.timeout),
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new MarchwardTimeoutError(this.config.timeout);
      }
      throw err;
    }

    // No content (204)
    if (res.status === 204) {
      return undefined as T;
    }

    const responseBody = await res.json().catch(() => null);

    if (!res.ok) {
      const errorMessage =
        (responseBody && typeof responseBody === "object" && "message" in responseBody
          ? (responseBody as { message: string }).message
          : null) ?? `HTTP ${res.status}`;

      const errorCode =
        (responseBody && typeof responseBody === "object" && "error" in responseBody
          ? (responseBody as { error: string }).error
          : null) ?? "api_error";

      throw new MarchwardApiError(res.status, errorCode, errorMessage, responseBody);
    }

    return responseBody as T;
  }
}

// ─── Inference helpers ──────────────────────────────────────────────

/**
 * Build the downstream-request descriptor for an inference provider.
 * Hardcodes the URL to the provider's chat / messages endpoint and
 * sets the body to the provider-native shape. Credential injection
 * (Anthropic `x-api-key` header / OpenAI `Authorization: Bearer`) is
 * handled server-side per the customer's service_connection config.
 */
function buildInferenceDownstream(
  provider: InferenceProvider,
  body: Record<string, unknown>,
): ExecuteInput["downstream"] {
  if (provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      // anthropic-version is required by the Messages API; not a credential.
      headers: { "anthropic-version": "2023-06-01" },
      body,
    };
  }
  // openai
  return {
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST",
    body,
  };
}

/**
 * Extract token usage from an LLM response body. Mirror of the
 * server-side `extractTokenUsage` in packages/api/src/execute/llm-cost-tracker.ts
 * — kept in lock-step so SDK and API agree on what counts.
 *
 * Returns null if the body doesn't carry usage metadata.
 */
function extractTokensFromBody(
  body: unknown,
): { input: number; output: number; model: string } | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const usage = obj["usage"];
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const model = typeof obj["model"] === "string" ? obj["model"] : "unknown";

  // Anthropic: usage.input_tokens / usage.output_tokens
  if (typeof u["input_tokens"] === "number" && typeof u["output_tokens"] === "number") {
    return {
      input: u["input_tokens"] as number,
      output: u["output_tokens"] as number,
      model,
    };
  }

  // OpenAI: usage.prompt_tokens / usage.completion_tokens
  if (typeof u["prompt_tokens"] === "number" && typeof u["completion_tokens"] === "number") {
    return {
      input: u["prompt_tokens"] as number,
      output: u["completion_tokens"] as number,
      model,
    };
  }

  return null;
}
