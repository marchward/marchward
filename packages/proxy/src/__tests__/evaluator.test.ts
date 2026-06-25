/**
 * @marchward/proxy — PolicyEvaluator tests (local mode)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PolicyEvaluator } from "../evaluator.js";
import { Logger } from "../logger.js";
import type { ProxyConfig } from "../types.js";

// ─── Test policy bundle (matches engine's PolicyBundle type) ────────

const testPolicy = {
  policyBundleId: "test-policy",
  version: "1",
  name: "Test Policy",
  defaultMode: "HITL" as const,
  thresholds: {
    confidenceMin: 0.7,
    riskBlock: 0.9,
    riskEscalate: 0.7,
  },
  roles: {
    allowedRoles: ["assistant"],
    roleOverrides: {},
  },
  rules: [
    {
      ruleId: "block-delete",
      description: "Block delete operations",
      tools: ["*"],
      priority: 100,
      conditions: [
        {
          field: "toolCall.toolName",
          operator: "contains" as const,
          value: "delete",
        },
      ],
      action: "BLOCK" as const,
      enabled: true,
    },
    {
      ruleId: "allow-read",
      description: "Allow read operations",
      tools: ["*"],
      priority: 50,
      conditions: [
        {
          field: "toolCall.toolName",
          operator: "contains" as const,
          value: "read",
        },
      ],
      action: "FLAG" as const,
      enabled: true,
    },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeConfig(overrides?: Partial<ProxyConfig>): ProxyConfig {
  return {
    command: "echo",
    args: ["test"],
    policyBundleId: "test-policy",
    localMode: true,
    localPolicy: testPolicy,
    mode: "HITL",
    defaultRole: "assistant",
    logLevel: "silent",
    ...overrides,
  };
}

describe("PolicyEvaluator (local mode)", () => {
  it("blocks a delete tool call", async () => {
    const config = makeConfig();
    const logger = new Logger("silent");
    const evaluator = new PolicyEvaluator(config, logger);

    const result = await evaluator.evaluate({
      name: "delete_file",
      arguments: { path: "/etc/passwd" },
    });

    assert.equal(result.response.result, "BLOCK");
    assert.ok(result.record);
  });

  it("allows a read tool call (no blocking rules match)", async () => {
    const config = makeConfig();
    const logger = new Logger("silent");
    const evaluator = new PolicyEvaluator(config, logger);

    const result = await evaluator.evaluate({
      name: "read_file",
      arguments: { path: "/tmp/test.txt" },
    });

    assert.equal(result.response.result, "ALLOW");
    assert.ok(result.record);
  });

  it("allows unknown tools via default (all rules passed)", async () => {
    const config = makeConfig();
    const logger = new Logger("silent");
    const evaluator = new PolicyEvaluator(config, logger);

    const result = await evaluator.evaluate({
      name: "list_directory",
      arguments: {},
    });

    assert.equal(result.response.result, "ALLOW");
  });

  it("blocks when no policy is loaded", async () => {
    const config = makeConfig({ localPolicy: undefined });
    const logger = new Logger("silent");
    const evaluator = new PolicyEvaluator(config, logger);

    const result = await evaluator.evaluate({
      name: "anything",
    });

    assert.equal(result.response.result, "BLOCK");
    assert.ok(result.response.explanation?.some((r: string) => r.includes("No policy")));
  });

  it("maintains hash chain across evaluations", async () => {
    const config = makeConfig();
    const logger = new Logger("silent");
    const evaluator = new PolicyEvaluator(config, logger);

    const result1 = await evaluator.evaluate({ name: "read_a" });
    const result2 = await evaluator.evaluate({ name: "read_b" });

    // Each should have a record with integrity
    assert.ok(result1.record?.integrity);
    assert.ok(result2.record?.integrity);

    // Second should chain to first
    assert.equal(
      result2.record!.integrity!.prevHash,
      result1.record!.integrity!.recordHash,
    );
  });

  it("blocks when remote config missing in remote mode", async () => {
    const config = makeConfig({
      localMode: false,
      marchwardApiUrl: undefined,
      marchwardApiKey: undefined,
    });
    const logger = new Logger("silent");
    const evaluator = new PolicyEvaluator(config, logger);

    const result = await evaluator.evaluate({ name: "test" });

    assert.equal(result.response.result, "BLOCK");
    assert.ok(result.response.explanation?.some((r: string) => r.includes("API not configured")));
  });
});
