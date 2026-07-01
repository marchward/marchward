/**
 * @marchward/engine — N12 trust resolution tests (2026-06-10)
 *
 * Pins the locked resolution order: per-function override > service
 * trust level > rule evaluation (risk-tier defaults). And the product
 * principle: "trusted" NEVER disables the Shield — irreversible-tier
 * calls fall through to rules regardless of trust level.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../index.js";
import type { AuthorizeRequest, PolicyBundle, GovernanceMode } from "../index.js";

/** Minimal bundle with a Shield-style rule: escalate when the call's
 *  risk tier (stuffed into signals.serviceRiskTier) is irreversible. */
const SHIELD_POLICY: PolicyBundle = {
  policyBundleId: "shield_test",
  version: "1.0.0",
  name: "Shield test bundle",
  description: "Escalates irreversible-tier calls",
  defaultMode: "HITL",
  thresholds: { confidenceMin: 0, riskBlock: 1, riskEscalate: 1 },
  roles: { allowedRoles: ["*"] },
  rules: [
    {
      ruleId: "irreversible-escalate",
      description: "Irreversible actions require approval",
      tools: ["*"],
      conditions: [
        { field: "signals.serviceRiskTier", operator: "eq", value: "irreversible" },
      ],
      action: "ESCALATE",
      priority: 10,
      enabled: true,
    },
    {
      ruleId: "noisy-escalate-everything",
      description: "A non-Shield rule that escalates reversible writes (the kind 'trusted' should bypass)",
      tools: ["*"],
      conditions: [
        { field: "signals.serviceRiskTier", operator: "eq", value: "reversible_write" },
      ],
      action: "ESCALATE",
      priority: 20,
      enabled: true,
    },
  ],
  createdAt: "2026-06-10T00:00:00Z",
  updatedAt: "2026-06-10T00:00:00Z",
};

function makeRequest(
  riskTier: string,
  trust?: AuthorizeRequest["trust"],
): AuthorizeRequest {
  return {
    requestId: "req_trust_test",
    timestamp: new Date().toISOString(),
    toolCall: { toolName: "github.branches.delete", arguments: {} },
    agent: { agentId: "test_agent" },
    context: { executionGateway: true } as AuthorizeRequest["context"],
    signals: { serviceRiskTier: riskTier } as AuthorizeRequest["signals"],
    policyBundle: { id: "shield_test", version: "1.0.0" },
    mode: "HITL" as GovernanceMode,
    trust: trust ? { serviceRiskTier: riskTier, ...trust } : undefined,
  };
}

describe("N12: gated (default) — unchanged behavior", () => {
  it("no trust input: irreversible escalates via the Shield rule", () => {
    const r = evaluate(makeRequest("irreversible"), SHIELD_POLICY);
    assert.equal(r.decision, "ESCALATE");
    assert.equal(r.terminationReason, "RULE_ESCALATE");
  });

  it("explicit gated: rules still run (reversible hits the noisy rule)", () => {
    const r = evaluate(
      makeRequest("reversible_write", { serviceTrustLevel: "gated" }),
      SHIELD_POLICY,
    );
    assert.equal(r.decision, "ESCALATE");
    assert.equal(r.terminationReason, "RULE_ESCALATE");
  });
});

describe("N12: trusted — bypasses rules EXCEPT for irreversible", () => {
  it("trusted + reversible_write → ALLOW (SERVICE_TRUSTED)", () => {
    const r = evaluate(
      makeRequest("reversible_write", { serviceTrustLevel: "trusted" }),
      SHIELD_POLICY,
    );
    assert.equal(r.decision, "ALLOW");
    assert.equal(r.terminationReason, "SERVICE_TRUSTED");
    assert.ok(r.reasonCodes.includes("SERVICE_TRUSTED"));
  });

  it("trusted + read_only → ALLOW", () => {
    const r = evaluate(
      makeRequest("read_only", { serviceTrustLevel: "trusted" }),
      SHIELD_POLICY,
    );
    assert.equal(r.decision, "ALLOW");
  });

  it("PRODUCT PRINCIPLE: trusted + irreversible STILL escalates (Shield survives)", () => {
    const r = evaluate(
      makeRequest("irreversible", { serviceTrustLevel: "trusted" }),
      SHIELD_POLICY,
    );
    assert.equal(r.decision, "ESCALATE");
    assert.equal(
      r.terminationReason,
      "RULE_ESCALATE",
      "irreversible must fall through to rule evaluation, not be trusted-allowed",
    );
  });

  it("trusted does NOT bypass risk-score thresholds (orthogonal axis)", () => {
    const req = makeRequest("reversible_write", { serviceTrustLevel: "trusted" });
    req.signals = { ...req.signals, riskScore: 0.99 } as AuthorizeRequest["signals"];
    const policy = {
      ...SHIELD_POLICY,
      thresholds: { confidenceMin: 0, riskBlock: 0.9, riskEscalate: 0.5 },
    };
    const r = evaluate(req, policy);
    assert.equal(r.decision, "BLOCK");
    assert.equal(r.terminationReason, "RISK_THRESHOLD");
  });
});

describe("N12: locked — everything escalates", () => {
  for (const tier of ["read_only", "reversible_write", "irreversible"]) {
    it(`locked + ${tier} → ESCALATE (SERVICE_LOCKED)`, () => {
      const r = evaluate(
        makeRequest(tier, { serviceTrustLevel: "locked" }),
        SHIELD_POLICY,
      );
      assert.equal(r.decision, "ESCALATE");
      assert.equal(r.terminationReason, "SERVICE_LOCKED");
    });
  }
});

describe("N12 P3: evaluate (dry-run) mode", () => {
  it("trusted+evaluate: enforces gated rules but records WOULD_ALLOW", () => {
    const r = evaluate(
      makeRequest("reversible_write", {
        serviceTrustLevel: "trusted",
        evaluateMode: true,
      }),
      SHIELD_POLICY,
    );
    // The noisy gated rule still escalates (enforced)...
    assert.equal(r.decision, "ESCALATE");
    assert.equal(r.terminationReason, "RULE_ESCALATE");
    // ...but the audit row carries the preview.
    assert.ok(r.reasonCodes.includes("EVALUATE_MODE"));
    assert.ok(r.reasonCodes.includes("WOULD_ALLOW_SERVICE_TRUSTED"));
  });

  it("locked+evaluate: read passes as gated, WOULD_ESCALATE recorded", () => {
    const r = evaluate(
      makeRequest("read_only", {
        serviceTrustLevel: "locked",
        evaluateMode: true,
      }),
      SHIELD_POLICY,
    );
    assert.equal(r.decision, "ALLOW", "gated read passes rules");
    assert.ok(r.reasonCodes.includes("WOULD_ESCALATE_SERVICE_LOCKED"));
  });

  it("override block + evaluate: enforced decision is gated, WOULD_BLOCK recorded", () => {
    const r = evaluate(
      makeRequest("read_only", {
        serviceTrustLevel: "gated",
        functionOverride: "block",
        evaluateMode: true,
      }),
      SHIELD_POLICY,
    );
    assert.equal(r.decision, "ALLOW");
    assert.ok(r.reasonCodes.includes("WOULD_BLOCK_FUNCTION_OVERRIDE_BLOCK"));
  });

  it("evaluate with gated default records nothing extra", () => {
    const r = evaluate(
      makeRequest("read_only", { serviceTrustLevel: "gated", evaluateMode: true }),
      SHIELD_POLICY,
    );
    assert.equal(r.decision, "ALLOW");
    assert.ok(!r.reasonCodes.includes("EVALUATE_MODE"), "no posture change = no preview noise");
  });
});

describe("N12: per-function override — wins over trust and rules", () => {
  it("override allow on an IRREVERSIBLE function → ALLOW (the deliberate escape valve)", () => {
    const r = evaluate(
      makeRequest("irreversible", {
        serviceTrustLevel: "gated",
        functionOverride: "allow",
      }),
      SHIELD_POLICY,
    );
    assert.equal(r.decision, "ALLOW");
    assert.equal(r.terminationReason, "FUNCTION_OVERRIDE");
    assert.ok(r.reasonCodes.includes("FUNCTION_OVERRIDE_ALLOW"));
  });

  it("override block wins over trusted", () => {
    const r = evaluate(
      makeRequest("read_only", {
        serviceTrustLevel: "trusted",
        functionOverride: "block",
      }),
      SHIELD_POLICY,
    );
    assert.equal(r.decision, "BLOCK");
    assert.equal(r.terminationReason, "FUNCTION_OVERRIDE");
  });

  it("override escalate on a trusted service = a standing gate", () => {
    const r = evaluate(
      makeRequest("reversible_write", {
        serviceTrustLevel: "trusted",
        functionOverride: "escalate",
      }),
      SHIELD_POLICY,
    );
    assert.equal(r.decision, "ESCALATE");
    assert.equal(r.terminationReason, "FUNCTION_OVERRIDE");
  });
});
