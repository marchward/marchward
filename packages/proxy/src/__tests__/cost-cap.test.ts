import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractTokenUsage,
  estimateCost,
  LocalCostCap,
  DEFAULT_COST_TABLE,
  DEFAULT_FALLBACK_COST,
} from "../cost-cap.js";

describe("extractTokenUsage", () => {
  it("parses Anthropic shape", () => {
    const u = extractTokenUsage({ model: "claude-sonnet-4", usage: { input_tokens: 100, output_tokens: 50 } });
    assert.deepEqual(u, { inputTokens: 100, outputTokens: 50, model: "claude-sonnet-4" });
  });

  it("parses OpenAI shape", () => {
    const u = extractTokenUsage({ model: "gpt-4o", usage: { prompt_tokens: 200, completion_tokens: 80 } });
    assert.deepEqual(u, { inputTokens: 200, outputTokens: 80, model: "gpt-4o" });
  });

  it("returns null for non-LLM bodies", () => {
    assert.equal(extractTokenUsage(null), null);
    assert.equal(extractTokenUsage({ foo: "bar" }), null);
    assert.equal(extractTokenUsage("not an object"), null);
    assert.equal(extractTokenUsage({ usage: { weird: 1 } }), null);
  });

  it("defaults model to 'unknown' when absent", () => {
    const u = extractTokenUsage({ usage: { input_tokens: 1, output_tokens: 1 } });
    assert.equal(u?.model, "unknown");
  });
});

describe("estimateCost", () => {
  it("uses the matching model prefix (first match wins)", () => {
    // claude-sonnet-4: 0.003 in / 0.015 out per 1K
    const cost = estimateCost({ inputTokens: 1000, outputTokens: 1000, model: "claude-sonnet-4-20250514" });
    assert.ok(Math.abs(cost - (0.003 + 0.015)) < 1e-9);
  });

  it("falls back to the conservative default for unknown models", () => {
    const cost = estimateCost({ inputTokens: 1000, outputTokens: 0, model: "some-new-model" });
    assert.ok(Math.abs(cost - DEFAULT_FALLBACK_COST.input) < 1e-9);
  });

  it("uses the default table when none supplied", () => {
    assert.ok(DEFAULT_COST_TABLE.has("gpt-4o"));
    const cost = estimateCost({ inputTokens: 0, outputTokens: 1000, model: "gpt-4o" });
    assert.ok(Math.abs(cost - 0.015) < 1e-9);
  });
});

describe("LocalCostCap", () => {
  it("rejects a non-positive cap", () => {
    assert.throws(() => new LocalCostCap({ costCapUsd: 0 }));
    assert.throws(() => new LocalCostCap({ costCapUsd: -1 }));
  });

  it("rejects a sub-minute window", () => {
    assert.throws(() => new LocalCostCap({ costCapUsd: 5, windowMinutes: 0 }));
  });

  it("allows while under cap, blocks once spend reaches cap", () => {
    const cap = new LocalCostCap({ costCapUsd: 0.05, windowMinutes: 60 });
    const t0 = 1_000_000_000_000;

    assert.equal(cap.check(t0).allowed, true); // nothing spent yet

    // claude-sonnet-4: 1000 in + 1000 out = $0.018
    cap.record({ inputTokens: 1000, outputTokens: 1000, model: "claude-sonnet-4" }, t0);
    assert.equal(cap.check(t0).allowed, true); // 0.018 < 0.05

    cap.record({ inputTokens: 1000, outputTokens: 1000, model: "claude-sonnet-4" }, t0 + 1000);
    assert.equal(cap.check(t0 + 1000).allowed, true); // 0.036 < 0.05

    cap.record({ inputTokens: 1000, outputTokens: 1000, model: "claude-sonnet-4" }, t0 + 2000);
    const res = cap.check(t0 + 2000); // 0.054 >= 0.05
    assert.equal(res.allowed, false);
    assert.ok(res.currentCostUsd >= res.capUsd);
    assert.equal(res.capUsd, 0.05);
  });

  it("evicts spend outside the rolling window", () => {
    const cap = new LocalCostCap({ costCapUsd: 0.05, windowMinutes: 10 });
    const t0 = 1_000_000_000_000;
    // Spend over the cap...
    cap.record({ inputTokens: 1000, outputTokens: 1000, model: "claude-sonnet-4" }, t0);
    cap.record({ inputTokens: 1000, outputTokens: 1000, model: "claude-sonnet-4" }, t0);
    cap.record({ inputTokens: 1000, outputTokens: 1000, model: "claude-sonnet-4" }, t0);
    assert.equal(cap.check(t0).allowed, false); // 0.054 >= 0.05

    // ...then jump 11 minutes ahead: the window has rolled past it.
    const later = t0 + 11 * 60_000;
    assert.equal(cap.check(later).allowed, true);
    assert.equal(cap.currentSpend(later), 0);
  });

  it("recordFromResponse parses + records, ignores non-LLM bodies", () => {
    const cap = new LocalCostCap({ costCapUsd: 1 });
    const t0 = 1_000_000_000_000;
    const cost = cap.recordFromResponse(
      { model: "gpt-4o", usage: { prompt_tokens: 1000, completion_tokens: 1000 } },
      t0,
    );
    assert.ok(cost > 0);
    assert.equal(cap.recordFromResponse({ not: "an llm response" }, t0), 0);
    assert.ok(Math.abs(cap.currentSpend(t0) - cost) < 1e-9);
  });

  it("tracks separate keys independently (multi-agent in one process)", () => {
    const cap = new LocalCostCap({ costCapUsd: 0.05, windowMinutes: 60 });
    const t0 = 1_000_000_000_000;
    cap.record({ inputTokens: 1000, outputTokens: 1000, model: "claude-opus-4" }, t0, "agent-a"); // $0.09
    assert.equal(cap.check(t0, "agent-a").allowed, false);
    assert.equal(cap.check(t0, "agent-b").allowed, true); // independent
  });
});
