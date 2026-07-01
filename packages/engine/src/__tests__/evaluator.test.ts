import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authorize, evaluate, verifyChain, GENESIS_HASH } from "../index.js";
import type {
  AuthorizeRequest,
  PolicyBundle,
  GovernanceMode,
} from "../index.js";

// ─── Test Fixtures ───────────────────────────────────────────────────

/** A balanced financial policy bundle for testing. */
const FINANCIAL_POLICY: PolicyBundle = {
  policyBundleId: "financial_policy",
  version: "1.0.0",
  name: "Financial Operations Policy",
  description: "Governs payment, refund, and financial tool calls",
  defaultMode: "HITL",
  thresholds: {
    confidenceMin: 0.80,
    riskBlock: 0.70,
    riskEscalate: 0.35,
  },
  roles: {
    allowedRoles: ["admin", "billing", "support"],
    roleOverrides: {
      support: {
        riskBlock: 0.50, // Stricter for support role
      },
    },
  },
  rules: [
    {
      ruleId: "H001",
      description: "Block payments over $50,000",
      tools: ["send_payment"],
      conditions: [
        { field: "toolCall.arguments.amount", operator: "gt", value: 50000 },
      ],
      action: "BLOCK",
      priority: 1,
      enabled: true,
    },
    {
      ruleId: "H002",
      description: "Escalate payments over $10,000",
      tools: ["send_payment"],
      conditions: [
        { field: "toolCall.arguments.amount", operator: "gt", value: 10000 },
      ],
      action: "ESCALATE",
      priority: 2,
      enabled: true,
    },
    {
      ruleId: "H003",
      description: "Escalate refunds over $5,000",
      tools: ["issue_refund"],
      conditions: [
        { field: "toolCall.arguments.amount", operator: "gt", value: 5000 },
      ],
      action: "ESCALATE",
      priority: 3,
      enabled: true,
    },
    {
      ruleId: "H004",
      description: "Flag production deployments for monitoring",
      tools: ["deploy"],
      conditions: [
        { field: "toolCall.arguments.environment", operator: "eq", value: "production" },
      ],
      action: "ALLOW_WITH_CONDITIONS",
      priority: 4,
      enabled: true,
    },
    {
      ruleId: "H005",
      description: "Block if tool arguments contain SQL injection patterns",
      tools: ["*"],
      conditions: [
        { field: "toolCall.arguments.query", operator: "matches", value: "(?i)(drop|delete|truncate)\\s+(table|database)" },
      ],
      action: "BLOCK",
      priority: 0, // Highest priority
      enabled: true,
    },
  ],
  createdAt: "2026-03-10T00:00:00Z",
  updatedAt: "2026-03-10T00:00:00Z",
};

/** Helper to create a request with defaults. */
function makeRequest(overrides: Partial<AuthorizeRequest> = {}): AuthorizeRequest {
  return {
    requestId: "req_test_001",
    timestamp: new Date().toISOString(),
    toolCall: {
      toolName: "send_payment",
      arguments: { amount: 500, currency: "USD", reason: "payment" },
    },
    agent: { agentId: "test_agent", agentVersion: "1.0" },
    context: { userId: "user_123", role: "billing", sessionId: "sess_abc" },
    signals: { riskScore: 0.10, confidence: 0.95 },
    policyBundle: { id: "financial_policy", version: "1.0.0" },
    mode: "HITL" as GovernanceMode,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("Marchward Engine — Core Evaluation", () => {
  it("should ALLOW a low-risk, high-confidence, small payment", () => {
    const request = makeRequest();
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ALLOW");
    assert.equal(result.terminationReason, "ALL_RULES_PASSED");
    assert.ok(result.durationMs >= 0);
  });

  it("should BLOCK payments over $50,000 (rule H001)", () => {
    const request = makeRequest({
      toolCall: {
        toolName: "send_payment",
        arguments: { amount: 75000, currency: "USD" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "BLOCK");
    assert.equal(result.terminationReason, "RULE_BLOCK");
    assert.ok(result.reasonCodes.includes("RULE_H001"));
  });

  it("should ESCALATE payments between $10,000–$50,000 (rule H002)", () => {
    const request = makeRequest({
      toolCall: {
        toolName: "send_payment",
        arguments: { amount: 25000, currency: "USD" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ESCALATE");
    assert.ok(result.reasonCodes.includes("RULE_H002"));
  });

  it("should ESCALATE refunds over $5,000 (rule H003)", () => {
    const request = makeRequest({
      toolCall: {
        toolName: "issue_refund",
        arguments: { amount: 8000, orderId: "ord_123" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ESCALATE");
    assert.ok(result.reasonCodes.includes("RULE_H003"));
  });

  it("should ALLOW_WITH_CONDITIONS for production deployments (rule H004)", () => {
    const request = makeRequest({
      toolCall: {
        toolName: "deploy",
        arguments: { buildId: "build_123", environment: "production" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ALLOW_WITH_CONDITIONS");
    assert.equal(result.terminationReason, "CONDITIONS_APPLIED");
    assert.ok(result.conditions.length > 0);
  });

  it("should ALLOW staging deployments without conditions", () => {
    const request = makeRequest({
      toolCall: {
        toolName: "deploy",
        arguments: { buildId: "build_123", environment: "staging" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ALLOW");
  });
});

describe("Marchward Engine — Threshold Checks", () => {
  it("should BLOCK when risk score exceeds block threshold", () => {
    const request = makeRequest({
      signals: { riskScore: 0.85, confidence: 0.95 },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "BLOCK");
    assert.equal(result.terminationReason, "RISK_THRESHOLD");
    assert.ok(result.reasonCodes.includes("RISK_ABOVE_BLOCK_THRESHOLD"));
  });

  it("should ESCALATE when risk score exceeds escalate threshold", () => {
    const request = makeRequest({
      signals: { riskScore: 0.45, confidence: 0.95 },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ESCALATE");
    assert.equal(result.terminationReason, "RISK_THRESHOLD");
  });

  it("should ESCALATE when confidence is below minimum", () => {
    const request = makeRequest({
      signals: { riskScore: 0.10, confidence: 0.60 },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ESCALATE");
    assert.equal(result.terminationReason, "CONFIDENCE_THRESHOLD");
    assert.ok(result.reasonCodes.includes("CONFIDENCE_BELOW_MINIMUM"));
  });

  it("should apply role-specific threshold overrides (support gets stricter risk)", () => {
    // Support role has riskBlock: 0.50 (stricter than default 0.70)
    const request = makeRequest({
      context: { userId: "user_123", role: "support", sessionId: "sess_abc" },
      signals: { riskScore: 0.55, confidence: 0.95 },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "BLOCK");
    assert.equal(result.terminationReason, "RISK_THRESHOLD");
  });

  it("should NOT block admin at same risk level that blocks support", () => {
    const request = makeRequest({
      context: { userId: "user_123", role: "admin", sessionId: "sess_abc" },
      signals: { riskScore: 0.55, confidence: 0.95 },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    // Admin doesn't have stricter overrides, so 0.55 is between escalate (0.35) and block (0.70)
    assert.equal(result.decision, "ESCALATE");
  });
});

describe("Marchward Engine — Role Authorization", () => {
  it("should ESCALATE when role is not in allowed list", () => {
    const request = makeRequest({
      context: { userId: "user_123", role: "intern", sessionId: "sess_abc" },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ESCALATE");
    assert.equal(result.terminationReason, "ROLE_UNAUTHORIZED");
  });

  it("should ESCALATE when role is missing", () => {
    const request = makeRequest({
      context: { userId: "user_123", sessionId: "sess_abc" },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ESCALATE");
    assert.equal(result.terminationReason, "ROLE_UNAUTHORIZED");
  });

  it("should allow when role checking is disabled", () => {
    const request = makeRequest({
      context: { userId: "user_123", role: "intern", sessionId: "sess_abc" },
    });
    const result = evaluate(request, FINANCIAL_POLICY, { enforceRoles: false });

    assert.equal(result.decision, "ALLOW");
  });
});

describe("Marchward Engine — Fail-Closed Behavior", () => {
  it("should ESCALATE when toolName is missing", () => {
    const request = makeRequest({
      toolCall: { toolName: "", arguments: {} },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ESCALATE");
    assert.equal(result.terminationReason, "MISSING_FIELDS");
  });

  it("should ESCALATE when agentId is missing", () => {
    const request = makeRequest({
      agent: { agentId: "" },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ESCALATE");
    assert.equal(result.terminationReason, "MISSING_FIELDS");
  });
});

describe("Marchward Engine — Governance Modes", () => {
  it("HIC mode: should convert ESCALATE to BLOCK", () => {
    const request = makeRequest({
      mode: "HIC",
      toolCall: {
        toolName: "send_payment",
        arguments: { amount: 25000, currency: "USD" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    // H002 would normally escalate, but HIC blocks
    assert.equal(result.decision, "BLOCK");
    assert.equal(result.terminationReason, "MODE_OVERRIDE");
  });

  it("HIC mode: should convert ALLOW_WITH_CONDITIONS to ESCALATE", () => {
    const request = makeRequest({
      mode: "HIC",
      toolCall: {
        toolName: "deploy",
        arguments: { buildId: "build_123", environment: "production" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ESCALATE");
    assert.equal(result.terminationReason, "MODE_OVERRIDE");
  });

  it("HIC mode: should still ALLOW clean requests", () => {
    const request = makeRequest({ mode: "HIC" });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ALLOW");
  });

  it("HOTL mode: should convert threshold BLOCK to ALLOW_WITH_CONDITIONS", () => {
    const request = makeRequest({
      mode: "HOTL",
      signals: { riskScore: 0.85, confidence: 0.95 },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    // Risk score would normally block, but HOTL allows with conditions
    assert.equal(result.decision, "ALLOW_WITH_CONDITIONS");
    assert.equal(result.terminationReason, "MODE_OVERRIDE");
  });

  it("HOTL mode: should still BLOCK on hard rule matches", () => {
    const request = makeRequest({
      mode: "HOTL",
      toolCall: {
        toolName: "send_payment",
        arguments: { amount: 75000, currency: "USD" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    // H001 is a hard rule block — stays blocked even in HOTL
    assert.equal(result.decision, "BLOCK");
  });

  it("HOTL mode: should convert ESCALATE to ALLOW_WITH_CONDITIONS", () => {
    const request = makeRequest({
      mode: "HOTL",
      toolCall: {
        toolName: "send_payment",
        arguments: { amount: 25000, currency: "USD" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ALLOW_WITH_CONDITIONS");
    assert.equal(result.terminationReason, "MODE_OVERRIDE");
  });

  it("HITL mode: should pass through decisions unchanged", () => {
    const request = makeRequest({
      mode: "HITL",
      toolCall: {
        toolName: "send_payment",
        arguments: { amount: 25000, currency: "USD" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    // HITL is the natural mode — escalate stays escalate
    assert.equal(result.decision, "ESCALATE");
  });
});

describe("Marchward Engine — Regex Rule (H005)", () => {
  it("should BLOCK SQL injection patterns", () => {
    const request = makeRequest({
      toolCall: {
        toolName: "run_query",
        arguments: { query: "DROP TABLE users" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "BLOCK");
    assert.ok(result.reasonCodes.includes("RULE_H005"));
  });

  it("should ALLOW safe queries", () => {
    const request = makeRequest({
      toolCall: {
        toolName: "run_query",
        arguments: { query: "SELECT * FROM orders WHERE id = 123" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    assert.equal(result.decision, "ALLOW");
  });
});

describe("Marchward Engine — Full Authorization Flow", () => {
  it("should produce a complete response and decision record", () => {
    const request = makeRequest();
    const { response, record } = authorize(request, FINANCIAL_POLICY);

    // Response
    assert.ok(response.decisionId.startsWith("dec_"));
    assert.equal(response.result, "ALLOW");
    assert.ok(Array.isArray(response.reasonCodes));
    assert.ok(Array.isArray(response.explanation));
    assert.equal(response.policyContext.policyBundleId, "financial_policy");
    assert.ok(response.evaluationDurationMs >= 0);

    // Record
    assert.equal(record.decisionId, response.decisionId);
    assert.equal(record.requestId, "req_test_001");
    assert.equal(record.evaluation.decision, "ALLOW");
    assert.ok(record.integrity.recordHash.startsWith("sha256:"));
    assert.ok(record.integrity.inputsHash.startsWith("sha256:"));
    assert.equal(record.integrity.prevHash, GENESIS_HASH);
  });

  it("should build a verifiable hash chain across multiple decisions", () => {
    const requests = [
      makeRequest({ requestId: "req_1" }),
      makeRequest({ requestId: "req_2", toolCall: { toolName: "send_payment", arguments: { amount: 25000 } } }),
      makeRequest({ requestId: "req_3" }),
    ];

    let prevHash = GENESIS_HASH;
    const records = [];

    for (const req of requests) {
      const { record } = authorize(req, FINANCIAL_POLICY, {}, prevHash);
      records.push(record);
      prevHash = record.integrity.recordHash;
    }

    // Verify chain integrity
    const brokenAt = verifyChain(
      records.map((r) => ({
        integrity: r.integrity,
        decisionId: r.decisionId,
        decision: r.outcome.decision,
        reasonCodes: r.outcome.reasonCodes,
        timestamp: r.timestamp,
      })),
    );

    assert.equal(brokenAt, -1, "Chain should be valid (no broken links)");
  });

  it("should detect tampering in the hash chain", () => {
    const requests = [
      makeRequest({ requestId: "req_1" }),
      makeRequest({ requestId: "req_2" }),
      makeRequest({ requestId: "req_3" }),
    ];

    let prevHash = GENESIS_HASH;
    const records = [];

    for (const req of requests) {
      const { record } = authorize(req, FINANCIAL_POLICY, {}, prevHash);
      records.push(record);
      prevHash = record.integrity.recordHash;
    }

    // Tamper with the second record
    records[1].outcome.decision = "ALLOW";
    records[1].outcome.reasonCodes = ["TAMPERED"];

    const chainData = records.map((r) => ({
      integrity: r.integrity,
      decisionId: r.decisionId,
      decision: r.outcome.decision,
      reasonCodes: r.outcome.reasonCodes,
      timestamp: r.timestamp,
    }));

    const brokenAt = verifyChain(chainData);

    assert.ok(brokenAt >= 0, "Should detect the tampered record");
  });
});

describe("Marchward Engine — Rule Priority", () => {
  it("should evaluate rules in priority order (lower number = first)", () => {
    // H005 (priority 0) should fire before H001 (priority 1)
    const request = makeRequest({
      toolCall: {
        toolName: "send_payment",
        arguments: { amount: 75000, query: "DROP TABLE payments" },
      },
    });
    const result = evaluate(request, FINANCIAL_POLICY);

    // Should hit H005 (SQL injection, priority 0) before H001 (amount, priority 1)
    assert.equal(result.decision, "BLOCK");
    assert.ok(result.reasonCodes.includes("RULE_H005"));
  });
});

describe("Marchward Engine — Disabled Rules", () => {
  it("should skip disabled rules", () => {
    const policyWithDisabled: PolicyBundle = {
      ...FINANCIAL_POLICY,
      rules: FINANCIAL_POLICY.rules.map((r) =>
        r.ruleId === "H001" ? { ...r, enabled: false } : r,
      ),
    };

    const request = makeRequest({
      toolCall: {
        toolName: "send_payment",
        arguments: { amount: 75000, currency: "USD" },
      },
    });
    const result = evaluate(request, policyWithDisabled);

    // H001 is disabled, so H002 (escalate > $10k) should trigger instead
    assert.equal(result.decision, "ESCALATE");
    assert.ok(result.reasonCodes.includes("RULE_H002"));
    assert.ok(!result.reasonCodes.includes("RULE_H001"));
  });
});

// ─── Default Action (default-deny policy mode) ────────────────────────

/**
 * Policy bundle with a single, narrow ALLOW rule and NO other rules.
 * Used to exercise the fallback path: any tool call that isn't
 * `read_user` will land in the fallback with no rule matching.
 */
function makeNarrowAllowlistPolicy(
  defaultAction: PolicyBundle["defaultAction"],
): PolicyBundle {
  return {
    policyBundleId: "narrow_allowlist",
    version: "1.0.0",
    name: "Narrow allowlist for default-action tests",
    defaultMode: "HITL",
    defaultAction,
    thresholds: {
      confidenceMin: 0.0,
      riskBlock: 1.0,
      riskEscalate: 1.0,
    },
    roles: {
      allowedRoles: ["*"],
    },
    rules: [
      {
        ruleId: "ALLOW_READ_USER",
        description: "Explicitly allow the safe read_user tool",
        tools: ["read_user"],
        conditions: [],
        action: "ALLOW",
        priority: 1,
        enabled: true,
      },
    ],
    createdAt: "2026-04-11T00:00:00Z",
    updatedAt: "2026-04-11T00:00:00Z",
  };
}

describe("Marchward Engine — Default Action (default-deny mode)", () => {
  it("falls back to ALLOW when defaultAction is 'ALLOW'", () => {
    const policy = makeNarrowAllowlistPolicy("ALLOW");
    const request = makeRequest({
      toolCall: { toolName: "unknown_tool", arguments: {} },
    });

    const result = evaluate(request, policy);

    assert.equal(result.decision, "ALLOW");
    assert.equal(result.terminationReason, "ALL_RULES_PASSED");
    assert.ok(!result.reasonCodes.includes("DEFAULT_DENY"));
    assert.ok(!result.reasonCodes.includes("DEFAULT_ESCALATE"));
  });

  it("falls back to ESCALATE when defaultAction is 'ESCALATE'", () => {
    const policy = makeNarrowAllowlistPolicy("ESCALATE");
    const request = makeRequest({
      toolCall: { toolName: "unknown_tool", arguments: {} },
    });

    const result = evaluate(request, policy);

    assert.equal(result.decision, "ESCALATE");
    assert.equal(result.terminationReason, "DEFAULT_ESCALATE");
    assert.ok(result.reasonCodes.includes("DEFAULT_ESCALATE"));
    assert.ok(
      result.explanations.some((e) =>
        e.toLowerCase().includes("policy defaults to escalating"),
      ),
    );
  });

  it("falls back to BLOCK when defaultAction is 'BLOCK' (default-deny)", () => {
    const policy = makeNarrowAllowlistPolicy("BLOCK");
    const request = makeRequest({
      toolCall: { toolName: "unknown_tool", arguments: {} },
    });

    const result = evaluate(request, policy);

    assert.equal(result.decision, "BLOCK");
    assert.equal(result.terminationReason, "DEFAULT_DENY");
    assert.ok(result.reasonCodes.includes("DEFAULT_DENY"));
    assert.ok(
      result.explanations.some((e) =>
        e.toLowerCase().includes("allowlist mode"),
      ),
    );
  });

  it("still honors an explicit ALLOW rule when defaultAction is 'BLOCK'", () => {
    const policy = makeNarrowAllowlistPolicy("BLOCK");
    const request = makeRequest({
      toolCall: { toolName: "read_user", arguments: { userId: "u_1" } },
    });

    const result = evaluate(request, policy);

    assert.equal(result.decision, "ALLOW");
    assert.equal(result.terminationReason, "RULE_ALLOW");
    assert.ok(!result.reasonCodes.includes("DEFAULT_DENY"));
  });

  it("still honors an explicit BLOCK rule when defaultAction is 'ALLOW'", () => {
    const policy: PolicyBundle = {
      ...makeNarrowAllowlistPolicy("ALLOW"),
      rules: [
        {
          ruleId: "BLOCK_DROP_TABLE",
          description: "Block DROP TABLE",
          tools: ["*"],
          conditions: [
            {
              field: "toolCall.arguments.query",
              operator: "matches",
              value: "(?i)drop\\s+table",
            },
          ],
          action: "BLOCK",
          priority: 1,
          enabled: true,
        },
      ],
    };
    const request = makeRequest({
      toolCall: {
        toolName: "run_sql",
        arguments: { query: "DROP TABLE users" },
      },
    });

    const result = evaluate(request, policy);

    assert.equal(result.decision, "BLOCK");
    assert.equal(result.terminationReason, "RULE_BLOCK");
  });

  it("still short-circuits on risk threshold when defaultAction is 'ALLOW'", () => {
    const policy: PolicyBundle = {
      ...makeNarrowAllowlistPolicy("ALLOW"),
      thresholds: { confidenceMin: 0.0, riskBlock: 0.5, riskEscalate: 0.3 },
    };
    const request = makeRequest({
      toolCall: { toolName: "unknown_tool", arguments: {} },
      signals: { riskScore: 0.9, confidence: 1.0 },
    });

    const result = evaluate(request, policy);

    assert.equal(result.decision, "BLOCK");
    assert.equal(result.terminationReason, "RISK_THRESHOLD");
    // Risk threshold takes precedence over the default-allow fallback.
    assert.ok(!result.reasonCodes.includes("DEFAULT_DENY"));
  });

  it("defaults to ALLOW when defaultAction is undefined (backward compat)", () => {
    const policy: PolicyBundle = {
      ...makeNarrowAllowlistPolicy("ALLOW"),
    };
    // Intentionally strip defaultAction to simulate a legacy PolicyBundle
    // constructed before the default-deny feature shipped.
    delete (policy as { defaultAction?: unknown }).defaultAction;

    const request = makeRequest({
      toolCall: { toolName: "unknown_tool", arguments: {} },
    });

    const result = evaluate(request, policy);

    assert.equal(result.decision, "ALLOW");
    assert.equal(result.terminationReason, "ALL_RULES_PASSED");
  });

  it("DEFAULT_DENY stays a hard BLOCK in HOTL mode", () => {
    // A customer who opts into default-deny AND monitor-mode has
    // picked two things that pull in opposite directions. The
    // default-deny signal wins because it's a policy-level choice,
    // while HOTL is a pod-level observability knob.
    const policy = makeNarrowAllowlistPolicy("BLOCK");
    const request = makeRequest({
      toolCall: { toolName: "unknown_tool", arguments: {} },
      mode: "HOTL",
    });

    const result = evaluate(request, policy);

    assert.equal(result.decision, "BLOCK");
    assert.equal(result.terminationReason, "DEFAULT_DENY");
  });

  it("DEFAULT_ESCALATE becomes BLOCK in HIC mode", () => {
    // HIC converts all escalations to blocks, including the
    // default-ask fallback. Consistent with HIC's existing behavior
    // on RULE_ESCALATE and RISK_THRESHOLD escalations.
    const policy = makeNarrowAllowlistPolicy("ESCALATE");
    const request = makeRequest({
      toolCall: { toolName: "unknown_tool", arguments: {} },
      mode: "HIC",
    });

    const result = evaluate(request, policy);

    assert.equal(result.decision, "BLOCK");
    assert.equal(result.terminationReason, "MODE_OVERRIDE");
  });

  it("DEFAULT_ESCALATE stays ESCALATE in HITL mode (user can still review)", () => {
    const policy = makeNarrowAllowlistPolicy("ESCALATE");
    const request = makeRequest({
      toolCall: { toolName: "unknown_tool", arguments: {} },
      mode: "HITL",
    });

    const result = evaluate(request, policy);

    assert.equal(result.decision, "ESCALATE");
    assert.equal(result.terminationReason, "DEFAULT_ESCALATE");
  });
});

// ─── Risk-tier signal (Signals decision 20, wedge branch 3) ─────────

describe("Marchward Engine — signals.serviceRiskTier conditions", () => {
  const RISK_TIER_POLICY: PolicyBundle = {
    policyBundleId: "marchward/require-approval-for-irreversible",
    version: "1.0.0",
    name: "Require approval for irreversible operations",
    description: "Mirrors the wedge starter policy.",
    defaultMode: "HITL",
    defaultAction: "ALLOW",
    thresholds: { confidenceMin: 0, riskBlock: 1.0, riskEscalate: 1.0 },
    roles: { allowedRoles: [] },
    rules: [
      {
        ruleId: "irreversible-escalate",
        description: "Escalate any call where the service classifies the tool as irreversible.",
        tools: ["*"],
        conditions: [
          {
            field: "signals.serviceRiskTier",
            operator: "eq",
            value: "irreversible",
          },
        ],
        action: "ESCALATE",
        priority: 10,
        enabled: true,
      },
    ],
    createdAt: "2026-05-14T00:00:00Z",
    updatedAt: "2026-05-14T00:00:00Z",
  };

  it("ESCALATEs when signals.serviceRiskTier === 'irreversible'", () => {
    const request = makeRequest({
      toolCall: { toolName: "github.repos.delete", arguments: { owner: "x", repo: "y" } },
      signals: { riskScore: 0.1, confidence: 0.95, serviceRiskTier: "irreversible" },
    });

    const result = evaluate(request, RISK_TIER_POLICY);
    assert.equal(result.decision, "ESCALATE");
  });

  it("ALLOWs when signals.serviceRiskTier === 'reversible_write'", () => {
    const request = makeRequest({
      toolCall: { toolName: "anthropic.messages.create", arguments: { model: "claude-haiku-4" } },
      signals: { riskScore: 0.1, confidence: 0.95, serviceRiskTier: "reversible_write" },
    });

    const result = evaluate(request, RISK_TIER_POLICY);
    assert.equal(result.decision, "ALLOW");
  });

  it("ALLOWs when signals.serviceRiskTier === 'read_only'", () => {
    const request = makeRequest({
      toolCall: { toolName: "github.repos.get", arguments: { owner: "x", repo: "y" } },
      signals: { riskScore: 0.1, confidence: 0.95, serviceRiskTier: "read_only" },
    });

    const result = evaluate(request, RISK_TIER_POLICY);
    assert.equal(result.decision, "ALLOW");
  });

  it("ALLOWs when signals.serviceRiskTier is missing entirely", () => {
    // Defensive: a request that somehow reaches the engine without the
    // server-side risk-tier injection should still ALLOW under the
    // irreversible-only policy. The starter rule should not match an
    // undefined field.
    const request = makeRequest({
      toolCall: { toolName: "some.tool", arguments: {} },
      signals: { riskScore: 0.1, confidence: 0.95 },
    });

    const result = evaluate(request, RISK_TIER_POLICY);
    assert.equal(result.decision, "ALLOW");
  });
});
