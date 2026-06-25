/**
 * @marchward/engine — Policy evaluator
 *
 * The core decision-making brain of Marchward. Given an authorization request
 * and a policy bundle, it evaluates all rules, checks thresholds, and
 * produces a deterministic decision.
 *
 * Evaluation order (fail-closed, short-circuit):
 * 1. Validate required fields (fail-closed → ESCALATE)
 * 2. Check role authorization
 * 3. Check risk score thresholds
 * 4. Check confidence score thresholds
 * 5. Evaluate policy rules (priority order)
 * 6. Apply governance mode
 * 7. Build decision record
 */

import { randomUUID } from "node:crypto";
import type {
  AuthorizeRequest,
  PolicyBundle,
  EvaluationResult,
  DecisionOutcome,
  GovernanceMode,
  TerminationReason,
  RuleHit,
  RuleCondition,
  PolicyRule,
  DecisionRecord,
  AuthorizeResponse,
  EngineConfig,
} from "./types.js";
import { buildIntegrity, GENESIS_HASH } from "./hash.js";
import { applyGovernanceMode } from "./modes.js";

// ─── Condition Evaluation ────────────────────────────────────────────

/**
 * Resolve a dot-notation field path against the request object.
 * e.g., "toolCall.arguments.amount" → request.toolCall.arguments.amount
 */
function resolveField(request: AuthorizeRequest, fieldPath: string): unknown {
  const parts = fieldPath.split(".");
  let current: unknown = request;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Evaluate a single rule condition against the request.
 */
function evaluateCondition(
  request: AuthorizeRequest,
  condition: RuleCondition,
): { matched: boolean; reason: string } {
  const fieldValue = resolveField(request, condition.field);

  switch (condition.operator) {
    case "gt":
      if (typeof fieldValue !== "number" || typeof condition.value !== "number") {
        return { matched: false, reason: `${condition.field} is not a number` };
      }
      return {
        matched: fieldValue > condition.value,
        reason: `${condition.field} (${fieldValue}) ${fieldValue > condition.value ? ">" : "≤"} ${condition.value}`,
      };

    case "gte":
      if (typeof fieldValue !== "number" || typeof condition.value !== "number") {
        return { matched: false, reason: `${condition.field} is not a number` };
      }
      return {
        matched: fieldValue >= condition.value,
        reason: `${condition.field} (${fieldValue}) ${fieldValue >= condition.value ? "≥" : "<"} ${condition.value}`,
      };

    case "lt":
      if (typeof fieldValue !== "number" || typeof condition.value !== "number") {
        return { matched: false, reason: `${condition.field} is not a number` };
      }
      return {
        matched: fieldValue < condition.value,
        reason: `${condition.field} (${fieldValue}) ${fieldValue < condition.value ? "<" : "≥"} ${condition.value}`,
      };

    case "lte":
      if (typeof fieldValue !== "number" || typeof condition.value !== "number") {
        return { matched: false, reason: `${condition.field} is not a number` };
      }
      return {
        matched: fieldValue <= condition.value,
        reason: `${condition.field} (${fieldValue}) ${fieldValue <= condition.value ? "≤" : ">"} ${condition.value}`,
      };

    case "eq":
      return {
        matched: fieldValue === condition.value,
        reason: `${condition.field} (${String(fieldValue)}) ${fieldValue === condition.value ? "==" : "!="} ${String(condition.value)}`,
      };

    case "neq":
      return {
        matched: fieldValue !== condition.value,
        reason: `${condition.field} (${String(fieldValue)}) ${fieldValue !== condition.value ? "!=" : "=="} ${String(condition.value)}`,
      };

    case "in": {
      if (!Array.isArray(condition.value)) {
        return { matched: false, reason: `${condition.field}: 'in' requires array value` };
      }
      const isIn = (condition.value as unknown[]).includes(fieldValue);
      return {
        matched: isIn,
        reason: `${condition.field} (${String(fieldValue)}) ${isIn ? "in" : "not in"} [${(condition.value as unknown[]).join(", ")}]`,
      };
    }

    case "not_in": {
      if (!Array.isArray(condition.value)) {
        return { matched: false, reason: `${condition.field}: 'not_in' requires array value` };
      }
      const notIn = !(condition.value as unknown[]).includes(fieldValue);
      return {
        matched: notIn,
        reason: `${condition.field} (${String(fieldValue)}) ${notIn ? "not in" : "in"} [${(condition.value as unknown[]).join(", ")}]`,
      };
    }

    case "contains": {
      if (typeof fieldValue !== "string" || typeof condition.value !== "string") {
        return { matched: false, reason: `${condition.field}: 'contains' requires string values` };
      }
      const has = fieldValue.includes(condition.value);
      return {
        matched: has,
        reason: `${condition.field} ${has ? "contains" : "does not contain"} "${condition.value}"`,
      };
    }

    case "not_contains": {
      if (typeof fieldValue !== "string" || typeof condition.value !== "string") {
        return { matched: false, reason: `${condition.field}: 'not_contains' requires string values` };
      }
      const lacks = !fieldValue.includes(condition.value);
      return {
        matched: lacks,
        reason: `${condition.field} ${lacks ? "does not contain" : "contains"} "${condition.value}"`,
      };
    }

    case "matches": {
      if (typeof fieldValue !== "string" || typeof condition.value !== "string") {
        return { matched: false, reason: `${condition.field}: 'matches' requires string values` };
      }
      try {
        // Support inline (?i) flag by extracting it and using RegExp flags
        let pattern = condition.value;
        let flags = "";
        if (pattern.startsWith("(?i)")) {
          flags = "i";
          pattern = pattern.slice(4);
        }
        const regex = new RegExp(pattern, flags);
        const matches = regex.test(fieldValue);
        return {
          matched: matches,
          reason: `${condition.field} ${matches ? "matches" : "does not match"} /${condition.value}/`,
        };
      } catch {
        return { matched: false, reason: `${condition.field}: invalid regex "${condition.value}"` };
      }
    }

    case "exists":
      return {
        matched: fieldValue !== undefined && fieldValue !== null,
        reason: `${condition.field} ${fieldValue !== undefined && fieldValue !== null ? "exists" : "does not exist"}`,
      };

    case "not_exists":
      return {
        matched: fieldValue === undefined || fieldValue === null,
        reason: `${condition.field} ${fieldValue === undefined || fieldValue === null ? "does not exist" : "exists"}`,
      };

    default:
      return { matched: false, reason: `Unknown operator: ${condition.operator}` };
  }
}

// ─── Rule Evaluation ─────────────────────────────────────────────────

/**
 * Evaluate a single policy rule against the request.
 * A rule matches only if ALL its conditions are true (AND logic).
 */
function evaluateRule(
  request: AuthorizeRequest,
  rule: PolicyRule,
): RuleHit {
  // Check if rule applies to this tool
  if (!rule.tools.includes("*") && !rule.tools.includes(request.toolCall.toolName)) {
    return {
      ruleId: rule.ruleId,
      matched: false,
      matchReason: `Rule does not apply to tool "${request.toolCall.toolName}"`,
      action: rule.action,
    };
  }

  // Evaluate all conditions (AND logic)
  const conditionResults = rule.conditions.map((c) =>
    evaluateCondition(request, c),
  );

  const allMatched = conditionResults.every((r) => r.matched);
  const reasons = conditionResults.map((r) => r.reason);

  return {
    ruleId: rule.ruleId,
    matched: allMatched,
    matchReason: allMatched
      ? `All conditions met: ${reasons.join("; ")}`
      : `Conditions not met: ${reasons.join("; ")}`,
    action: rule.action,
  };
}

// ─── Core Evaluator ──────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<EngineConfig> = {
  failClosed: true,
  enforceRoles: true,
  evaluationTimeoutMs: 5000,
};

/**
 * Evaluate an authorization request against a policy bundle.
 *
 * This is the core function of the Marchward engine. It produces a
 * deterministic evaluation result that can then be used to build
 * a decision record.
 */
export function evaluate(
  request: AuthorizeRequest,
  policy: PolicyBundle,
  config: EngineConfig = {},
): EvaluationResult {
  const startTime = performance.now();
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const ruleHits: RuleHit[] = [];
  const reasonCodes: string[] = [];
  const explanations: string[] = [];
  const conditions: string[] = [];

  // ── Step 1: Validate required fields (fail-closed) ──

  if (cfg.failClosed) {
    if (!request.toolCall?.toolName) {
      return buildResult({
        decision: "ESCALATE",
        ruleHits,
        terminationReason: "MISSING_FIELDS",
        reasonCodes: ["MISSING_TOOL_NAME"],
        explanations: ["Required field 'toolCall.toolName' is missing"],
        conditions,
        mode: request.mode,
        startTime,
      });
    }

    if (!request.agent?.agentId) {
      return buildResult({
        decision: "ESCALATE",
        ruleHits,
        terminationReason: "MISSING_FIELDS",
        reasonCodes: ["MISSING_AGENT_ID"],
        explanations: ["Required field 'agent.agentId' is missing"],
        conditions,
        mode: request.mode,
        startTime,
      });
    }
  }

  // ── Step 2: Check role authorization ──

  if (cfg.enforceRoles && policy.roles.allowedRoles.length > 0) {
    // Wildcard "*" means all roles are permitted — skip role check entirely
    if (!policy.roles.allowedRoles.includes("*")) {
      const role = request.context.role;
      if (!role || !policy.roles.allowedRoles.includes(role)) {
        reasonCodes.push("ROLE_UNAUTHORIZED");
        explanations.push(
          `Role "${role ?? "none"}" is not in allowed roles [${policy.roles.allowedRoles.join(", ")}]`,
        );
        return buildResult({
          decision: "ESCALATE",
          ruleHits,
          terminationReason: "ROLE_UNAUTHORIZED",
          reasonCodes,
          explanations,
          conditions,
          mode: request.mode,
          startTime,
        });
      }
    }
  }

  // ── Step 3: Resolve effective thresholds (with role overrides) ──

  const role = request.context.role;
  const baseThresholds = policy.thresholds;
  const roleOverrides = role ? policy.roles.roleOverrides?.[role] : undefined;
  const thresholds = {
    confidenceMin: roleOverrides?.confidenceMin ?? baseThresholds.confidenceMin,
    riskBlock: roleOverrides?.riskBlock ?? baseThresholds.riskBlock,
    riskEscalate: roleOverrides?.riskEscalate ?? baseThresholds.riskEscalate,
  };

  // ── Step 4: Check risk score thresholds ──

  const riskScore = request.signals.riskScore;
  if (riskScore !== undefined) {
    if (riskScore >= thresholds.riskBlock) {
      reasonCodes.push("RISK_ABOVE_BLOCK_THRESHOLD");
      explanations.push(
        `Risk score (${riskScore}) ≥ block threshold (${thresholds.riskBlock})`,
      );
      return buildResult({
        decision: "BLOCK",
        ruleHits,
        terminationReason: "RISK_THRESHOLD",
        reasonCodes,
        explanations,
        conditions,
        mode: request.mode,
        startTime,
      });
    }

    if (riskScore >= thresholds.riskEscalate) {
      reasonCodes.push("RISK_ABOVE_ESCALATE_THRESHOLD");
      explanations.push(
        `Risk score (${riskScore}) ≥ escalate threshold (${thresholds.riskEscalate})`,
      );
      return buildResult({
        decision: "ESCALATE",
        ruleHits,
        terminationReason: "RISK_THRESHOLD",
        reasonCodes,
        explanations,
        conditions,
        mode: request.mode,
        startTime,
      });
    }
  }

  // ── Step 5: Check confidence thresholds ──

  const confidence = request.signals.confidence;
  if (confidence !== undefined && confidence < thresholds.confidenceMin) {
    reasonCodes.push("CONFIDENCE_BELOW_MINIMUM");
    explanations.push(
      `Confidence (${confidence}) < minimum required (${thresholds.confidenceMin})`,
    );
    return buildResult({
      decision: "ESCALATE",
      ruleHits,
      terminationReason: "CONFIDENCE_THRESHOLD",
      reasonCodes,
      explanations,
      conditions,
      mode: request.mode,
      startTime,
    });
  }

  // ── Step 5.5: N12 trust resolution (override > trust > rules) ──
  //
  // Consulted BEFORE rule evaluation per the locked resolution order:
  // per-function override > service trust level > risk-tier default
  // (the bundle's rules, incl. the Shield). Two invariants:
  //
  //   - "trusted" NEVER short-circuits an irreversible-tier call — it
  //     falls through to the rules so the Shield still gates it. Only
  //     an explicit per-function override can change that.
  //   - Risk/confidence thresholds (steps 4-5) stay ABOVE trust: a
  //     trusted service with an anomalous risk score still escalates.

  const trust = request.trust;

  // Resolve what trust/override say (if anything) WITHOUT returning yet.
  type TrustOutcome = {
    decision: "ALLOW" | "ESCALATE" | "BLOCK";
    terminationReason: "FUNCTION_OVERRIDE" | "SERVICE_LOCKED" | "SERVICE_TRUSTED";
    reasonCode: string;
    explanation: string;
  };
  let trustOutcome: TrustOutcome | null = null;

  if (trust?.functionOverride) {
    const overrideDecision: Record<string, "ALLOW" | "ESCALATE" | "BLOCK"> = {
      allow: "ALLOW",
      escalate: "ESCALATE",
      block: "BLOCK",
    };
    trustOutcome = {
      decision: overrideDecision[trust.functionOverride] ?? "ESCALATE",
      terminationReason: "FUNCTION_OVERRIDE",
      reasonCode: `FUNCTION_OVERRIDE_${trust.functionOverride.toUpperCase()}`,
      explanation: `Per-function override on ${request.toolCall.toolName}: ${trust.functionOverride}`,
    };
  } else if (trust?.serviceTrustLevel === "locked") {
    trustOutcome = {
      decision: "ESCALATE",
      terminationReason: "SERVICE_LOCKED",
      reasonCode: "SERVICE_LOCKED",
      explanation: "Service is locked: every call escalates for human review.",
    };
  } else if (
    trust?.serviceTrustLevel === "trusted" &&
    trust.serviceRiskTier !== "irreversible"
  ) {
    trustOutcome = {
      decision: "ALLOW",
      terminationReason: "SERVICE_TRUSTED",
      reasonCode: "SERVICE_TRUSTED",
      explanation: `Service is trusted: ${trust.serviceRiskTier ?? "non-irreversible"} calls run without rule gating. Irreversible actions still escalate.`,
    };
  }

  if (trustOutcome && trust?.evaluateMode) {
    // Phase 3 dry-run: record what WOULD have happened, then fall
    // through to rule evaluation as if the service were gated. The
    // audit row carries both the enforced decision and the preview.
    reasonCodes.push("EVALUATE_MODE");
    reasonCodes.push(`WOULD_${trustOutcome.decision}_${trustOutcome.reasonCode}`);
    explanations.push(
      `Evaluate mode (dry run): this call would have been ${trustOutcome.decision} by the configured posture (${trustOutcome.explanation}) — enforcing the gated default instead.`,
    );
  } else if (trustOutcome) {
    reasonCodes.push(trustOutcome.reasonCode);
    explanations.push(trustOutcome.explanation);
    return buildResult({
      decision: trustOutcome.decision,
      ruleHits,
      terminationReason: trustOutcome.terminationReason,
      reasonCodes,
      explanations,
      conditions,
      mode: request.mode,
      startTime,
    });
  }

  // ── Step 6: Evaluate policy rules (priority order, short-circuit) ──

  const sortedRules = policy.rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority);

  for (const rule of sortedRules) {
    const hit = evaluateRule(request, rule);
    ruleHits.push(hit);

    if (hit.matched) {
      reasonCodes.push(`RULE_${hit.ruleId}`);
      explanations.push(`Rule ${hit.ruleId}: ${rule.description} — ${hit.matchReason}`);

      switch (hit.action) {
        case "ALLOW":
          // Explicit ALLOW rule — short-circuit with ALLOW decision
          return buildResult({
            decision: "ALLOW",
            ruleHits,
            terminationReason: "RULE_ALLOW",
            reasonCodes,
            explanations,
            conditions,
            mode: request.mode,
            startTime,
          });

        case "BLOCK":
          return buildResult({
            decision: "BLOCK",
            ruleHits,
            terminationReason: "RULE_BLOCK",
            reasonCodes,
            explanations,
            conditions,
            mode: request.mode,
            startTime,
          });

        case "ESCALATE":
          return buildResult({
            decision: "ESCALATE",
            ruleHits,
            terminationReason: "RULE_ESCALATE",
            reasonCodes,
            explanations,
            conditions,
            mode: request.mode,
            startTime,
          });

        case "ALLOW_WITH_CONDITIONS":
          conditions.push(rule.description);
          // Don't return — continue evaluating remaining rules
          // (conditions accumulate)
          break;

        case "FLAG":
          // Flag rules add to reason codes but don't change the outcome
          break;
      }
    }
  }

  // ── Step 7: Determine final outcome ──

  if (conditions.length > 0) {
    return buildResult({
      decision: "ALLOW_WITH_CONDITIONS",
      ruleHits,
      terminationReason: "CONDITIONS_APPLIED",
      reasonCodes,
      explanations,
      conditions,
      mode: request.mode,
      startTime,
    });
  }

  // All checks passed — fall through to the policy's default action.
  //
  // `defaultAction` was added to PolicyBundle for the default-deny /
  // default-ask feature. The three possible values map cleanly onto the
  // existing DecisionOutcome / TerminationReason space:
  //
  //   "ALLOW"    → ALLOW    + ALL_RULES_PASSED   (Marchward v0 behavior)
  //   "ESCALATE" → ESCALATE + DEFAULT_ESCALATE   (default-ask / HITL-ish)
  //   "BLOCK"    → BLOCK    + DEFAULT_DENY       (default-deny / allowlist)
  //
  // Treat missing / undefined as "ALLOW" so hand-built PolicyBundle
  // objects in tests and older callers don't regress.
  const defaultAction = policy.defaultAction ?? "ALLOW";

  if (defaultAction === "BLOCK") {
    return buildResult({
      decision: "BLOCK",
      ruleHits,
      terminationReason: "DEFAULT_DENY",
      reasonCodes: [...reasonCodes, "DEFAULT_DENY"],
      explanations: [
        ...explanations,
        "No rule explicitly allowed this tool call; policy defaults to block (allowlist mode).",
      ],
      conditions,
      mode: request.mode,
      startTime,
    });
  }

  if (defaultAction === "ESCALATE") {
    return buildResult({
      decision: "ESCALATE",
      ruleHits,
      terminationReason: "DEFAULT_ESCALATE",
      reasonCodes: [...reasonCodes, "DEFAULT_ESCALATE"],
      explanations: [
        ...explanations,
        "No rule matched this tool call; policy defaults to escalating unknown calls to a human reviewer.",
      ],
      conditions,
      mode: request.mode,
      startTime,
    });
  }

  // defaultAction === "ALLOW" — original pre-default-deny behavior.
  return buildResult({
    decision: "ALLOW",
    ruleHits,
    terminationReason: "ALL_RULES_PASSED",
    reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["ALL_CLEAR"],
    explanations: explanations.length > 0
      ? explanations
      : ["All policy checks passed"],
    conditions,
    mode: request.mode,
    startTime,
  });
}

// ─── Result Builder ──────────────────────────────────────────────────

function buildResult(params: {
  decision: DecisionOutcome;
  ruleHits: RuleHit[];
  terminationReason: TerminationReason;
  reasonCodes: string[];
  explanations: string[];
  conditions: string[];
  mode: GovernanceMode;
  startTime: number;
}): EvaluationResult {
  // Apply governance mode transformations
  const modeResult = applyGovernanceMode(
    params.decision,
    params.terminationReason,
    params.mode,
  );

  const finalExplanations = [...params.explanations];
  if (modeResult.modeAdjusted && modeResult.modeExplanation) {
    finalExplanations.push(modeResult.modeExplanation);
  }

  return {
    decision: modeResult.decision,
    ruleHits: params.ruleHits,
    terminationReason: modeResult.terminationReason,
    reasonCodes: params.reasonCodes,
    explanations: finalExplanations,
    conditions: params.conditions,
    appliedMode: params.mode,
    durationMs: Math.round((performance.now() - params.startTime) * 100) / 100,
  };
}

// ─── Decision Record Builder ─────────────────────────────────────────

/**
 * Build a complete decision record from an evaluation result.
 * This creates the immutable audit trail entry with hash chaining.
 */
export function buildDecisionRecord(
  request: AuthorizeRequest,
  evaluation: EvaluationResult,
  prevHash: string = GENESIS_HASH,
): DecisionRecord {
  const decisionId = `dec_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const timestamp = new Date().toISOString();

  const integrity = buildIntegrity({
    decisionId,
    request,
    decision: evaluation.decision,
    reasonCodes: evaluation.reasonCodes,
    prevHash,
    timestamp,
  });

  return {
    decisionId,
    requestId: request.requestId,
    timestamp,
    toolCall: request.toolCall,
    agent: request.agent,
    context: request.context,
    signals: request.signals,
    policyBundle: request.policyBundle,
    mode: request.mode,
    evaluation,
    outcome: {
      decision: evaluation.decision,
      reasonCodes: evaluation.reasonCodes,
      conditions: evaluation.conditions,
    },
    integrity,
  };
}

// ─── Public API: Authorize ───────────────────────────────────────────

/**
 * The main entry point for the Marchward engine.
 *
 * Given a request and policy bundle, evaluates the request and returns
 * both a response (for the caller) and a decision record (for the audit trail).
 */
export function authorize(
  request: AuthorizeRequest,
  policy: PolicyBundle,
  config: EngineConfig = {},
  prevHash: string = GENESIS_HASH,
): {
  response: AuthorizeResponse;
  record: DecisionRecord;
} {
  const evaluation = evaluate(request, policy, config);
  const record = buildDecisionRecord(request, evaluation, prevHash);

  const response: AuthorizeResponse = {
    decisionId: record.decisionId,
    result: evaluation.decision,
    reasonCodes: evaluation.reasonCodes,
    explanation: evaluation.explanations,
    conditions:
      evaluation.conditions.length > 0 ? evaluation.conditions : undefined,
    policyContext: {
      policyBundleId: request.policyBundle.id,
      version: request.policyBundle.version,
    },
    recommendedNext:
      evaluation.decision === "ESCALATE"
        ? "human_review"
        : evaluation.decision === "BLOCK"
          ? "action_denied"
          : undefined,
    timestamp: request.timestamp,
    evaluationDurationMs: evaluation.durationMs,
  };

  return { response, record };
}
