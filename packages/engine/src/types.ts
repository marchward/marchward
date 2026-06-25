/**
 * @marchward/engine — Core type definitions
 *
 * These types define the contract for Marchward's runtime authority system.
 * They are shared across proxy, API, dashboard, and SDKs.
 */

// ─── Decision Outcomes ───────────────────────────────────────────────

/** The four possible outcomes of a Marchward authorization decision. */
export type DecisionOutcome =
  | "ALLOW"
  | "BLOCK"
  | "ESCALATE"
  | "ALLOW_WITH_CONDITIONS";

/**
 * Terminal fallback applied when evaluation completes without any rule
 * matching and no threshold being exceeded.
 *
 *   - "ALLOW"    — implicit allowlist (default; same as Marchward v0 behavior).
 *                  Agents can do anything unless a rule blocks it.
 *   - "ESCALATE" — default-ask. Unknown tool calls escalate to a human
 *                  reviewer. Rules are still honored; only the fallback
 *                  path flips from allow to escalate.
 *   - "BLOCK"    — default-deny / allowlist. Agents can only do what a
 *                  rule explicitly allows. Strictest setting, appropriate
 *                  for high-stakes agents (payments, prod deploys, etc.).
 *
 * Missing / undefined on an in-memory PolicyBundle is treated as "ALLOW"
 * for backward compatibility with pre-default-deny call sites.
 */
export type DefaultAction = "ALLOW" | "ESCALATE" | "BLOCK";

/** Governance modes controlling how Marchward handles decisions. */
export type GovernanceMode =
  | "HIC"   // Human In Control — strict blocking, maximum safety
  | "HITL"  // Human In The Loop — escalate edge cases to humans
  | "HOTL"; // Human On The Loop — monitor + conditional approvals

// ─── Authorization Request ───────────────────────────────────────────

/** A tool call that an agent wants to execute. */
export interface ToolCall {
  /** Name of the tool being invoked (e.g., "send_payment", "deploy") */
  toolName: string;
  /** Arguments being passed to the tool */
  arguments: Record<string, unknown>;
}

/** Information about the agent making the request. */
export interface AgentInfo {
  agentId: string;
  agentVersion?: string;
}

/** Contextual information about the request environment. */
export interface RequestContext {
  /** Identity of the user the agent is acting on behalf of */
  userId?: string;
  /** Role or permission level (e.g., "admin", "support", "billing") */
  role?: string;
  /** Account tier for the organization */
  accountTier?: string;
  /** Unique session identifier */
  sessionId?: string;
  /** Execution environment */
  environment?: "production" | "staging" | "development" | "test";
  /** Any additional context key-value pairs */
  [key: string]: unknown;
}

/** Signal scores provided by the agent or upstream systems. */
export interface Signals {
  /** Risk score from 0.0 (safe) to 1.0 (dangerous) */
  riskScore?: number;
  /** Confidence score from 0.0 (uncertain) to 1.0 (certain) */
  confidence?: number;
  /** Any additional signal key-value pairs */
  [key: string]: unknown;
}

/** Reference to the policy bundle to evaluate against. */
export interface PolicyBundleRef {
  /** Policy bundle identifier */
  id: string;
  /** Policy bundle version */
  version: string;
}

/** A complete authorization request submitted to Marchward. */
export interface AuthorizeRequest {
  /** Unique request identifier (caller-generated) */
  requestId: string;
  /** ISO 8601 timestamp of the request */
  timestamp: string;
  /** The tool call to authorize */
  toolCall: ToolCall;
  /** Agent making the request */
  agent: AgentInfo;
  /** Request context */
  context: RequestContext;
  /** Signal scores */
  signals: Signals;
  /** Policy bundle to evaluate against */
  policyBundle: PolicyBundleRef;
  /** Governance mode for this request */
  mode: GovernanceMode;
  /** N12 trust resolution inputs (optional — absent = gated default). */
  trust?: TrustResolution;
}

// ─── N12 Protections v2: trust resolution (migration 052) ───────────

/** Per-service trust level. Absent/gated = current default behavior. */
export type ServiceTrustLevel = "gated" | "trusted" | "locked";

/** Per-function posture override — the exception path. */
export type FunctionPosture = "allow" | "escalate" | "block";

/**
 * Inputs the engine consults BEFORE rule evaluation, per the locked
 * resolution order: function override > service trust level >
 * risk-tier default (i.e. the bundle's rules). Cost cap is orthogonal
 * and enforced outside the engine.
 *
 * Product principle (locked 2026-06-10): "trusted" never disables the
 * Shield — irreversible-tier calls fall through to rule evaluation
 * regardless of trust level. Only an explicit per-function override
 * can change the posture of an irreversible function.
 */
export interface TrustResolution {
  /** Trust level for the called service (from service_trust). */
  serviceTrustLevel?: ServiceTrustLevel;
  /** Posture override for the exact function called (function_overrides). */
  functionOverride?: FunctionPosture;
  /** Risk tier of this call (same value stuffed into signals.serviceRiskTier). */
  serviceRiskTier?: string;
  /**
   * N12 phase 3 dry-run: when true, trust/override resolution is
   * COMPUTED but NOT enforced — the engine decides as if gated and
   * records WOULD_<DECISION>_<REASON> reason codes for what the
   * configured posture would have done.
   */
  evaluateMode?: boolean;
}

// ─── Authorization Response ──────────────────────────────────────────

/** The response returned after evaluating an authorization request. */
export interface AuthorizeResponse {
  /** Unique decision identifier (Marchward-generated) */
  decisionId: string;
  /** The authorization outcome */
  result: DecisionOutcome;
  /** Machine-readable reason codes */
  reasonCodes: string[];
  /** Human-readable explanations for the decision */
  explanation: string[];
  /** Conditions that must be met (for ALLOW_WITH_CONDITIONS) */
  conditions?: string[];
  /** Policy context used for the evaluation */
  policyContext: {
    policyBundleId: string;
    version: string;
  };
  /** Recommended next action */
  recommendedNext?: string;
  /** ISO-8601 timestamp of when the decision was made */
  timestamp: string;
  /** Duration of evaluation in milliseconds */
  evaluationDurationMs: number;
}

// ─── Policy Bundle ───────────────────────────────────────────────────

/** Comparison operators for rule conditions. */
export type RuleOperator =
  | "gt" | "gte" | "lt" | "lte" | "eq" | "neq"
  | "in" | "not_in"
  | "contains" | "not_contains"
  | "matches"    // regex match
  | "exists" | "not_exists";

/** A single condition within a rule. */
export interface RuleCondition {
  /** Dot-notation path to the field to check (e.g., "toolCall.arguments.amount") */
  field: string;
  /** Comparison operator */
  operator: RuleOperator;
  /** Value to compare against */
  value: unknown;
}

/** Action to take when a rule matches. */
export type RuleAction = "ALLOW" | "BLOCK" | "ESCALATE" | "ALLOW_WITH_CONDITIONS" | "FLAG";

/** A single policy rule. */
export interface PolicyRule {
  /** Unique rule identifier (e.g., "H001", "H002") */
  ruleId: string;
  /** Human-readable description of what this rule checks */
  description: string;
  /** Which tool(s) this rule applies to. "*" means all tools. */
  tools: string[];
  /** Conditions that must ALL be true for this rule to match */
  conditions: RuleCondition[];
  /** Action to take when the rule matches */
  action: RuleAction;
  /** Priority (lower = evaluated first). Rules are short-circuit. */
  priority: number;
  /** Whether this rule is active */
  enabled: boolean;
}

/** Global thresholds for the policy bundle. */
export interface PolicyThresholds {
  /** Minimum confidence required for auto-allow (0.0 - 1.0) */
  confidenceMin: number;
  /** Risk score above which to block (0.0 - 1.0) */
  riskBlock: number;
  /** Risk score above which to escalate (0.0 - 1.0) */
  riskEscalate: number;
}

/** Role-based access configuration. */
export interface RoleConfig {
  /** Roles allowed to use this policy's tools */
  allowedRoles: string[];
  /** Per-role overrides for thresholds */
  roleOverrides?: Record<string, Partial<PolicyThresholds>>;
}

/** A complete, versioned policy bundle. */
export interface PolicyBundle {
  /** Unique bundle identifier */
  policyBundleId: string;
  /** Semantic version */
  version: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** Default governance mode */
  defaultMode: GovernanceMode;
  /**
   * Terminal fallback when no rule matches and no threshold is exceeded.
   * Optional for backward compatibility — callers that don't set it get
   * "ALLOW" (pre-default-deny behavior). See DefaultAction for the
   * meaning of each value.
   */
  defaultAction?: DefaultAction;
  /** Global thresholds */
  thresholds: PolicyThresholds;
  /** Role configuration */
  roles: RoleConfig;
  /** Ordered list of rules */
  rules: PolicyRule[];
  /** Policy status: draft, active, or inactive */
  status?: "draft" | "active" | "inactive";
  /** Whether this version is currently active (derived from status) */
  isActive?: boolean;
  /**
   * Optional per-policy LLM cost cap in USD per `costWindowMinutes`.
   * NULL/undefined means "use the env-var default" (the host-configured per-agent cap).
   * Read at execute-time by `llmCostTracker.check()` to override the
   * per-agent threshold for agents bound to this policy. Added in
   * migration 038.
   */
  costCapUsd?: number;
  /**
   * Optional cost-window length in minutes paired with `costCapUsd`.
   * NULL/undefined means "use the env-var default" (the host-configured cost window).
   * Migration 038.
   */
  costWindowMinutes?: number;
  /** ISO 8601 timestamp of creation */
  createdAt: string;
  /** ISO 8601 timestamp of last update */
  updatedAt: string;
}

// ─── Evaluation Internals ────────────────────────────────────────────

/** Result of a single rule evaluation. */
export interface RuleHit {
  /** The rule that was evaluated */
  ruleId: string;
  /** Whether the rule's conditions matched */
  matched: boolean;
  /** Human-readable explanation of why it matched (or didn't) */
  matchReason: string;
  /** The action the rule would take (only meaningful if matched) */
  action: RuleAction;
}

/** The reason evaluation terminated. */
export type TerminationReason =
  | "RULE_ALLOW"          // An explicit allow rule matched
  | "RULE_BLOCK"          // A blocking rule matched
  | "RULE_ESCALATE"       // An escalation rule matched
  | "RISK_THRESHOLD"      // Risk score exceeded threshold
  | "CONFIDENCE_THRESHOLD"// Confidence below minimum
  | "ROLE_UNAUTHORIZED"   // Role not in allowed list
  | "MODE_OVERRIDE"       // Governance mode forced the outcome
  | "MISSING_FIELDS"      // Required fields missing (fail-closed)
  | "ALL_RULES_PASSED"    // No rules triggered — defaultAction "ALLOW" fallback
  | "DEFAULT_ESCALATE"    // No rules triggered — defaultAction "ESCALATE" fallback
  | "DEFAULT_DENY"        // No rules triggered — defaultAction "BLOCK" fallback
  | "CONDITIONS_APPLIED"  // Allowed but with conditions
  | "FUNCTION_OVERRIDE"   // N12: per-function posture override decided
  | "SERVICE_LOCKED"      // N12: trust level "locked" forced escalate
  | "SERVICE_TRUSTED";    // N12: trust level "trusted" auto-allowed

/** Complete evaluation result from the engine. */
export interface EvaluationResult {
  /** Final decision outcome */
  decision: DecisionOutcome;
  /** All rules that were evaluated */
  ruleHits: RuleHit[];
  /** Why evaluation terminated */
  terminationReason: TerminationReason;
  /** Machine-readable reason codes */
  reasonCodes: string[];
  /** Human-readable explanations */
  explanations: string[];
  /** Conditions (for ALLOW_WITH_CONDITIONS) */
  conditions: string[];
  /** The governance mode that was applied */
  appliedMode: GovernanceMode;
  /** Duration of evaluation in milliseconds */
  durationMs: number;
}

// ─── Decision Record (Audit Trail) ───────────────────────────────────

/** Integrity hashes for tamper detection. */
export interface IntegrityRecord {
  /** SHA-256 hash of the previous decision record */
  prevHash: string;
  /** SHA-256 hash of this decision record */
  recordHash: string;
  /** SHA-256 hash of the input request */
  inputsHash: string;
}

/** A complete, immutable decision record for the audit trail. */
export interface DecisionRecord {
  /** Unique decision identifier */
  decisionId: string;
  /** Original request identifier */
  requestId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** The tool call that was evaluated */
  toolCall: ToolCall;
  /** Agent that made the request */
  agent: AgentInfo;
  /** Request context */
  context: RequestContext;
  /** Signal scores */
  signals: Signals;
  /** Policy bundle reference */
  policyBundle: PolicyBundleRef;
  /** Governance mode */
  mode: GovernanceMode;
  /** Evaluation result */
  evaluation: EvaluationResult;
  /** Final outcome */
  outcome: {
    decision: DecisionOutcome;
    reasonCodes: string[];
    conditions: string[];
  };
  /** Integrity hashes for tamper detection */
  integrity: IntegrityRecord;
}

// ─── Engine Configuration ────────────────────────────────────────────

/** Configuration options for the Marchward engine. */
export interface EngineConfig {
  /** Whether to fail closed (ESCALATE) on missing required fields. Default: true */
  failClosed?: boolean;
  /** Whether to enforce role checking. Default: true */
  enforceRoles?: boolean;
  /** Maximum evaluation time in ms before timeout. Default: 5000 */
  evaluationTimeoutMs?: number;
}
