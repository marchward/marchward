/**
 * @marchward/proxy — Policy evaluation bridge
 *
 * Supports two modes:
 * - Local: runs engine directly in-process (zero latency, no API dependency)
 * - Remote: calls Marchward API for evaluation (centralized audit, shared policy)
 */

import {
  authorize as engineAuthorize,
  GENESIS_HASH,
  type AuthorizeRequest,
  type AuthorizeResponse,
  type DecisionRecord,
  type PolicyBundle,
  type GovernanceMode,
  type EngineConfig,
} from "@marchward/engine";

import type { ProxyConfig, McpToolCallParams } from "./types.js";
import { Logger } from "./logger.js";
import { randomUUID } from "node:crypto";

// ─── Result type ────────────────────────────────────────────────────

export interface EvalResult {
  response: AuthorizeResponse;
  record?: DecisionRecord;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Build a synthetic BLOCK response for error/fallback cases. */
function blockResponse(reason: string, policyBundleId: string): AuthorizeResponse {
  return {
    decisionId: `dec_fallback_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
    result: "BLOCK",
    reasonCodes: ["PROXY_ERROR"],
    explanation: [reason],
    policyContext: {
      policyBundleId,
      version: "0",
    },
    timestamp: new Date().toISOString(),
    evaluationDurationMs: 0,
  };
}

// ─── Evaluator ──────────────────────────────────────────────────────

export class PolicyEvaluator {
  private config: ProxyConfig;
  private logger: Logger;
  private prevHash: string = GENESIS_HASH;

  constructor(config: ProxyConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Evaluate a tool call against the current policy.
   * Routes to local engine or remote API based on config.
   */
  async evaluate(tool: McpToolCallParams): Promise<EvalResult> {
    if (this.config.localMode) {
      return this.evaluateLocal(tool);
    }
    return this.evaluateRemote(tool);
  }

  // ─── Local evaluation ─────────────────────────────────────────────

  private evaluateLocal(tool: McpToolCallParams): EvalResult {
    const policy = this.config.localPolicy as PolicyBundle | undefined;

    if (!policy) {
      this.logger.error("Local mode requires a policy bundle (--policy-file)");
      return {
        response: blockResponse("No policy loaded", this.config.policyBundleId),
      };
    }

    const request: AuthorizeRequest = {
      requestId: randomUUID(),
      timestamp: new Date().toISOString(),
      toolCall: {
        toolName: tool.name,
        arguments: tool.arguments ?? {},
      },
      agent: {
        agentId: this.config.agentId ?? "proxy-agent",
      },
      context: {
        role: this.config.defaultRole ?? "assistant",
        sessionId: `proxy-${Date.now()}`,
      },
      signals: {},
      policyBundle: {
        id: this.config.policyBundleId,
        version: this.config.policyVersion ?? "latest",
      },
      mode: (this.config.mode ?? "HITL") as GovernanceMode,
    };

    const engineConfig: EngineConfig = {
      failClosed: true,
      enforceRoles: true,
    };

    const { response, record } = engineAuthorize(
      request,
      policy,
      engineConfig,
      this.prevHash,
    );

    // Advance the hash chain
    if (record.integrity) {
      this.prevHash = record.integrity.recordHash;
    }

    return { response, record };
  }

  // ─── Remote evaluation (via Marchward API) ────────────────────────────

  private async evaluateRemote(tool: McpToolCallParams): Promise<EvalResult> {
    const apiUrl = this.config.marchwardApiUrl;
    const apiKey = this.config.marchwardApiKey;

    if (!apiUrl || !apiKey) {
      this.logger.error("Remote mode requires --api-url and --api-key");
      return {
        response: blockResponse("API not configured", this.config.policyBundleId),
      };
    }

    const body = {
      toolCall: {
        toolName: tool.name,
        arguments: tool.arguments ?? {},
      },
      agent: {
        agentId: this.config.agentId ?? "proxy-agent",
      },
      context: {
        role: this.config.defaultRole ?? "assistant",
        sessionId: `proxy-${Date.now()}`,
      },
      signals: {},
      policyBundle: {
        id: this.config.policyBundleId,
        version: this.config.policyVersion,
      },
      mode: this.config.mode ?? "HITL",
    };

    try {
      // Wall-clock cap so a hung control-plane call cannot block a
      // tool invocation forever. The evaluator falls through to
      // blockResponse() on timeout, which is the safe default.
      const res = await fetch(`${apiUrl}/v1/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });

      if (!res.ok) {
        const errBody = await res.text();
        this.logger.error(`API returned ${res.status}: ${errBody}`);
        return {
          response: blockResponse(`API error: ${res.status}`, this.config.policyBundleId),
        };
      }

      const response = (await res.json()) as AuthorizeResponse;
      return { response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`API request failed: ${msg}`);
      return {
        response: blockResponse(`API unreachable: ${msg}`, this.config.policyBundleId),
      };
    }
  }
}
