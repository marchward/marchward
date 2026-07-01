/**
 * @marchward/sdk — Client unit tests
 *
 * Tests the MarchwardClient against a mock fetch implementation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MarchwardClient } from "../client.js";
import { MarchwardApiError, MarchwardTimeoutError } from "../errors.js";

// ─── Mock Fetch ─────────────────────────────────────────────────────

function mockFetch(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): typeof globalThis.fetch {
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(
      status === 204 ? null : JSON.stringify(body),
      {
        status,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
    );
  };
}

function capturingFetch(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(
      status === 204 ? null : JSON.stringify(body),
      { status, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetch: fn, calls };
}

function client(fetchFn: typeof globalThis.fetch): MarchwardClient {
  return new MarchwardClient({
    apiUrl: "https://api.marchward.test",
    apiKey: "mw_test_key_123",
    defaultAgent: { agentId: "test-agent" },
    defaultMode: "HITL",
    defaultRole: "assistant",
    timeout: 5000,
    retry: { maxRetries: 0 },
    fetch: fetchFn,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("MarchwardClient", () => {
  describe("constructor", () => {
    it("requires apiUrl", () => {
      assert.throws(
        () => new MarchwardClient({ apiUrl: "", apiKey: "mw_x" }),
        /apiUrl is required/,
      );
    });

    it("requires apiKey", () => {
      assert.throws(
        () => new MarchwardClient({ apiUrl: "https://api.test", apiKey: "" }),
        /apiKey is required/,
      );
    });

    it("strips trailing slash from apiUrl", async () => {
      const { fetch: f, calls } = capturingFetch(200, { status: "ok" });
      const c = new MarchwardClient({
        apiUrl: "https://api.test///",
        apiKey: "mw_key",
        retry: { maxRetries: 0 },
        fetch: f,
      });
      await c.health();
      assert.ok(calls[0]!.url.startsWith("https://api.test/health"));
    });
  });

  describe("authorize()", () => {
    it("sends correct request and parses response", async () => {
      const mockResponse = {
        decisionId: "dec_123",
        result: "ALLOW",
        reasonCodes: ["ALL_RULES_PASSED"],
        explanation: ["No blocking rules matched"],
        policyContext: { policyBundleId: "test-policy", version: "1" },
        evaluationDurationMs: 2,
      };

      const { fetch: f, calls } = capturingFetch(200, mockResponse);
      const c = client(f);

      const result = await c.authorize({
        toolName: "send_payment",
        arguments: { amount: 100 },
        policyBundleId: "test-policy",
      });

      assert.equal(result.result, "ALLOW");
      assert.equal(result.decisionId, "dec_123");

      // Verify request shape
      const body = JSON.parse(calls[0]!.init.body as string);
      assert.equal(body.toolCall.toolName, "send_payment");
      assert.equal(body.toolCall.arguments.amount, 100);
      assert.equal(body.agent.agentId, "test-agent");
      assert.equal(body.policyBundle.id, "test-policy");
      assert.equal(body.mode, "HITL");
      assert.equal(body.context.role, "assistant");
    });

    it("uses per-request agent override", async () => {
      const { fetch: f, calls } = capturingFetch(200, { result: "ALLOW" });
      const c = client(f);

      await c.authorize({
        toolName: "test",
        policyBundleId: "p1",
        agent: { agentId: "custom-agent", agentVersion: "2.0" },
      });

      const body = JSON.parse(calls[0]!.init.body as string);
      assert.equal(body.agent.agentId, "custom-agent");
      assert.equal(body.agent.agentVersion, "2.0");
    });

    it("requires agent info", async () => {
      const c = new MarchwardClient({
        apiUrl: "https://api.test",
        apiKey: "mw_key",
        retry: { maxRetries: 0 },
        fetch: mockFetch(200, {}),
        // No defaultAgent
      });

      await assert.rejects(
        () => c.authorize({ toolName: "test", policyBundleId: "p1" }),
        /agent is required/,
      );
    });

    it("sends authorization header", async () => {
      const { fetch: f, calls } = capturingFetch(200, { result: "ALLOW" });
      const c = client(f);
      await c.authorize({ toolName: "test", policyBundleId: "p1" });

      const headers = calls[0]!.init.headers as Record<string, string>;
      assert.equal(headers["Authorization"], "Bearer mw_test_key_123");
    });
  });

  describe("isAllowed()", () => {
    it("returns true for ALLOW", async () => {
      const c = client(mockFetch(200, { result: "ALLOW" }));
      const allowed = await c.isAllowed({ toolName: "test", policyBundleId: "p1" });
      assert.equal(allowed, true);
    });

    it("returns true for ALLOW_WITH_CONDITIONS", async () => {
      const c = client(mockFetch(200, { result: "ALLOW_WITH_CONDITIONS" }));
      const allowed = await c.isAllowed({ toolName: "test", policyBundleId: "p1" });
      assert.equal(allowed, true);
    });

    it("returns false for BLOCK", async () => {
      const c = client(mockFetch(200, { result: "BLOCK" }));
      const allowed = await c.isAllowed({ toolName: "test", policyBundleId: "p1" });
      assert.equal(allowed, false);
    });

    it("returns false for ESCALATE", async () => {
      const c = client(mockFetch(200, { result: "ESCALATE" }));
      const allowed = await c.isAllowed({ toolName: "test", policyBundleId: "p1" });
      assert.equal(allowed, false);
    });
  });

  describe("authorizeAndExecute()", () => {
    it("executes function when allowed", async () => {
      const c = client(mockFetch(200, { result: "ALLOW", decisionId: "dec_1" }));
      let executed = false;

      const { decision, result } = await c.authorizeAndExecute(
        { toolName: "test", policyBundleId: "p1" },
        () => { executed = true; return 42; },
      );

      assert.equal(executed, true);
      assert.equal(result, 42);
      assert.equal(decision.result, "ALLOW");
    });

    it("skips function when blocked", async () => {
      const c = client(mockFetch(200, { result: "BLOCK", decisionId: "dec_2" }));
      let executed = false;

      const { decision, result } = await c.authorizeAndExecute(
        { toolName: "test", policyBundleId: "p1" },
        () => { executed = true; return 42; },
      );

      assert.equal(executed, false);
      assert.equal(result, null);
      assert.equal(decision.result, "BLOCK");
    });
  });

  describe("decisions", () => {
    it("getDecision() fetches by ID", async () => {
      const { fetch: f, calls } = capturingFetch(200, { decision: { id: "dec_123" } });
      const c = client(f);
      const d = await c.getDecision("dec_123");
      assert.deepEqual(d, { id: "dec_123" });
      assert.ok(calls[0]!.url.includes("/v1/decisions/dec_123"));
    });

    it("listDecisions() sends query params", async () => {
      const { fetch: f, calls } = capturingFetch(200, {
        decisions: [], total: 0, limit: 50, offset: 0,
      });
      const c = client(f);
      await c.listDecisions({ outcome: "BLOCK", tool: "send_payment", limit: 10 });
      assert.ok(calls[0]!.url.includes("outcome=BLOCK"));
      assert.ok(calls[0]!.url.includes("tool=send_payment"));
      assert.ok(calls[0]!.url.includes("limit=10"));
    });
  });

  describe("policies", () => {
    it("listPolicies() works", async () => {
      const c = client(mockFetch(200, { policies: [{ id: "p1" }], total: 1 }));
      const result = await c.listPolicies();
      assert.equal(result.total, 1);
    });

    it("getPolicy() fetches by ID", async () => {
      const { fetch: f, calls } = capturingFetch(200, { policy: { id: "p1" } });
      const c = client(f);
      await c.getPolicy("financial-controls");
      assert.ok(calls[0]!.url.includes("/v1/policies/financial-controls"));
    });

    it("createPolicy() sends POST", async () => {
      const { fetch: f, calls } = capturingFetch(201, { policy: { id: "p1" } });
      const c = client(f);
      await c.createPolicy({
        policyBundleId: "test",
        version: "1",
        name: "Test",
        defaultMode: "HITL",
        thresholds: { confidenceMin: 0.7, riskBlock: 0.9, riskEscalate: 0.7 },
        roles: { allowedRoles: ["admin"] },
        rules: [],
      });
      assert.equal(calls[0]!.init.method, "POST");
    });

    it("deactivatePolicy() sends DELETE", async () => {
      const { fetch: f, calls } = capturingFetch(204, null);
      const c = client(f);
      await c.deactivatePolicy("test", "1");
      assert.equal(calls[0]!.init.method, "DELETE");
      assert.ok(calls[0]!.url.includes("version=1"));
    });
  });

  describe("health()", () => {
    it("returns health response", async () => {
      const c = client(mockFetch(200, { status: "ok", timestamp: "2026-03-12T00:00:00Z" }));
      const h = await c.health();
      assert.equal(h.status, "ok");
    });
  });

  describe("error handling", () => {
    it("throws MarchwardApiError on 401", async () => {
      const c = client(mockFetch(401, { error: "unauthorized", message: "Invalid API key" }));
      await assert.rejects(
        () => c.health(),
        (err: MarchwardApiError) => {
          assert.equal(err.statusCode, 401);
          assert.equal(err.isAuthError, true);
          return true;
        },
      );
    });

    it("throws MarchwardApiError on 404", async () => {
      const c = client(mockFetch(404, { error: "not_found", message: "Not found" }));
      await assert.rejects(
        () => c.getDecision("missing"),
        (err: MarchwardApiError) => {
          assert.equal(err.isNotFound, true);
          return true;
        },
      );
    });

    it("throws MarchwardApiError on 500", async () => {
      const c = client(mockFetch(500, { error: "server_error", message: "Oops" }));
      await assert.rejects(
        () => c.health(),
        (err: MarchwardApiError) => {
          assert.equal(err.isServerError, true);
          return true;
        },
      );
    });
  });

  describe("retries", () => {
    it("retries on 503", async () => {
      let callCount = 0;
      const retryFetch = async () => {
        callCount++;
        if (callCount < 3) {
          return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
        }
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      };

      const c = new MarchwardClient({
        apiUrl: "https://api.test",
        apiKey: "mw_key",
        retry: { maxRetries: 3, initialBackoffMs: 10 },
        fetch: retryFetch,
      });

      const h = await c.health();
      assert.equal(h.status, "ok");
      assert.equal(callCount, 3);
    });

    it("does not retry on 400", async () => {
      let callCount = 0;
      const noRetryFetch = async () => {
        callCount++;
        return new Response(
          JSON.stringify({ error: "bad_request", message: "Bad" }),
          { status: 400 },
        );
      };

      const c = new MarchwardClient({
        apiUrl: "https://api.test",
        apiKey: "mw_key",
        retry: { maxRetries: 3, initialBackoffMs: 10 },
        fetch: noRetryFetch,
      });

      await assert.rejects(() => c.health());
      assert.equal(callCount, 1); // No retries for 4xx
    });
  });
});
