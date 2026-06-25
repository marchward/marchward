/**
 * Lightweight Marchward API client for the MCP server.
 *
 * We don't import the full SDK to keep dependencies minimal.
 * This makes HTTP calls directly to the Marchward API.
 */

export interface MarchwardConfig {
  apiUrl: string;
  apiKey: string;
  timeout?: number;
}

export class MarchwardAPIClient {
  private apiUrl: string;
  private apiKey: string;
  private timeout: number;

  constructor(config: MarchwardConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 10_000;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          `Marchward API ${method} ${path} returned ${res.status}: ${JSON.stringify(data)}`,
        );
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Core Governance ──────────────────────────────────────────

  async authorize(input: {
    toolName: string;
    arguments?: Record<string, unknown>;
    policyBundleId?: string;
    agentId?: string;
    mode?: string;
    context?: Record<string, unknown>;
    signals?: Record<string, unknown>;
  }) {
    return this.request<Record<string, unknown>>("POST", "/v1/authorize", {
      toolCall: {
        toolName: input.toolName,
        arguments: input.arguments ?? {},
      },
      // Only include policyBundle if explicitly provided — otherwise let
      // the API auto-resolve from the API key → agent → policy chain.
      policyBundle: input.policyBundleId ? { id: input.policyBundleId } : undefined,
      agent: input.agentId ? { agentId: input.agentId } : undefined,
      mode: input.mode,
      context: input.context,
      signals: input.signals,
    });
  }

  async execute(input: {
    toolName: string;
    arguments?: Record<string, unknown>;
    policyBundleId: string;
    agentId: string;
    service: string;
    downstream: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      body?: unknown;
    };
    mode?: string;
  }) {
    return this.request<Record<string, unknown>>("POST", "/v1/execute", {
      toolCall: {
        toolName: input.toolName,
        arguments: input.arguments ?? {},
      },
      policyBundle: { id: input.policyBundleId },
      agent: { agentId: input.agentId },
      service: input.service,
      downstream: input.downstream,
      mode: input.mode,
    });
  }

  // ─── Agent Registry ───────────────────────────────────────────

  async createAgent(input: {
    name: string;
    description?: string;
    agentId?: string;
  }) {
    return this.request<Record<string, unknown>>("POST", "/v1/agents", input);
  }

  async listAgents() {
    return this.request<Record<string, unknown>>("GET", "/v1/agents");
  }

  async getAgent(agentId: string) {
    return this.request<Record<string, unknown>>(
      "GET",
      `/v1/agents/${agentId}`,
    );
  }

  async bindPolicy(agentId: string, policyBundleId: string) {
    return this.request<Record<string, unknown>>(
      "POST",
      `/v1/agents/${agentId}/bind-policy`,
      { policyBundleId },
    );
  }

  // ─── Decisions ────────────────────────────────────────────────

  async listDecisions(query?: {
    agentId?: string;
    toolName?: string;
    result?: string;
    limit?: number;
    offset?: number;
  }) {
    const params = new URLSearchParams();
    if (query?.agentId) params.set("agentId", query.agentId);
    if (query?.toolName) params.set("toolName", query.toolName);
    if (query?.result) params.set("result", query.result);
    if (query?.limit) params.set("limit", String(query.limit));
    if (query?.offset) params.set("offset", String(query.offset));

    const qs = params.toString();
    return this.request<Record<string, unknown>>(
      "GET",
      `/v1/decisions${qs ? `?${qs}` : ""}`,
    );
  }

  // ─── Coverage Check ───────────────────────────────────────────

  async checkCoverage(agentId: string) {
    // Get agent's registered tools
    const agent = await this.getAgent(agentId);
    const registeredTools = (agent as any).tools ?? [];

    // Get recent decisions for this agent
    const decisions = await this.listDecisions({
      agentId,
      limit: 200,
    });
    const decisionList = (decisions as any).decisions ?? [];

    // Find unique tool names that have produced decisions
    const observedTools = new Set<string>();
    for (const d of decisionList) {
      if (d.toolName) observedTools.add(d.toolName);
    }

    // Compare declared vs observed
    const declaredToolNames = registeredTools.map(
      (t: any) => t.name ?? t.toolName ?? t,
    );
    const covered = declaredToolNames.filter((t: string) =>
      observedTools.has(t),
    );
    const uncovered = declaredToolNames.filter(
      (t: string) => !observedTools.has(t),
    );
    const undeclaredButObserved = [...observedTools].filter(
      (t) => !declaredToolNames.includes(t),
    );

    const totalDeclared = declaredToolNames.length;
    const coveragePercent =
      totalDeclared > 0
        ? Math.round((covered.length / totalDeclared) * 100)
        : 0;

    return {
      agentId,
      totalDeclaredTools: totalDeclared,
      totalObservedTools: observedTools.size,
      coveragePercent,
      coveredTools: covered,
      uncoveredTools: uncovered,
      undeclaredButObserved,
      totalDecisionsAnalyzed: decisionList.length,
      summary:
        totalDeclared === 0
          ? `Agent "${agentId}" has no declared tools. Cannot calculate coverage.`
          : coveragePercent === 100
            ? `Agent "${agentId}" has 100% governance coverage (${totalDeclared}/${totalDeclared} tools producing decisions).`
            : `Agent "${agentId}" has ${coveragePercent}% governance coverage (${covered.length}/${totalDeclared} tools). Missing: ${uncovered.join(", ")}`,
    };
  }

  // ─── Health ───────────────────────────────────────────────────

  async health() {
    return this.request<Record<string, unknown>>("GET", "/health");
  }
}
