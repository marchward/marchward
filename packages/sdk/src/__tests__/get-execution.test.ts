/**
 * @marchward/sdk — Phase 4 v1 additions: getExecution + auto-Idempotency-Key
 *
 * Tests the SDK surface introduced for the escalation-flow v1 build.
 * Uses a capturing fetch mock to verify the wire-level behavior.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MarchwardClient } from "../client.js";
import type { MarchwardClientConfig, ExecutionResult } from "../types.js";

// ─── Mock fetch ─────────────────────────────────────────────────────

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

function makeClient(
  fetchFn: typeof globalThis.fetch,
  overrides: Partial<MarchwardClientConfig> = {},
): MarchwardClient {
  return new MarchwardClient({
    apiUrl: "https://api.marchward.test",
    apiKey: "mw_test_key_123",
    defaultAgent: { agentId: "test-agent" },
    defaultMode: "HITL",
    timeout: 5000,
    retry: { maxRetries: 0 },
    fetch: fetchFn,
    ...overrides,
  });
}

function getHeader(init: RequestInit, name: string): string | undefined {
  const h = init.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  // Lookup is case-sensitive in plain object; check both casings.
  return h[name] ?? h[name.toLowerCase()];
}

// ─── getExecution ───────────────────────────────────────────────────

describe("MarchwardClient.getExecution", () => {
  it("issues GET /v1/executions/:requestId with the apiUrl base", async () => {
    const pendingResult: ExecutionResult = {
      status: "pending",
      requestId: "req_abc",
      reviewId: "rev_abc",
      pending: {
        expiresAt: "2026-05-12T17:00:00.000Z",
        pollUrl: "https://api.marchward.test/v1/executions/req_abc",
        dashboardUrl: "https://app.marchward.ai/activity?tab=reviews&highlight=rev_abc",
      },
    };
    const { fetch, calls } = capturingFetch(200, pendingResult);
    const client = makeClient(fetch);

    const result = await client.getExecution("req_abc");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.marchward.test/v1/executions/req_abc");
    assert.equal(calls[0]!.init.method, "GET");
    assert.deepEqual(result, pendingResult);
  });

  it("URL-encodes the requestId", async () => {
    const { fetch, calls } = capturingFetch(200, { status: "pending", requestId: "req/with slash" });
    const client = makeClient(fetch);

    await client.getExecution("req/with slash").catch(() => {});

    assert.match(calls[0]!.url, /req%2Fwith%20slash$/);
  });

  it("propagates 404 as MarchwardApiError", async () => {
    const { fetch } = capturingFetch(404, { error: "not_found", message: "No execution found" });
    const client = makeClient(fetch);

    await assert.rejects(
      () => client.getExecution("req_missing"),
      (err: Error) => err.message.includes("No execution found") || err.message.includes("not_found"),
    );
  });

  it("status='approved' result narrows on execution field", async () => {
    const approved: ExecutionResult = {
      status: "approved",
      requestId: "req_x",
      reviewId: "rev_x",
      execution: { statusCode: 201, body: { id: "issue_42" }, headers: {}, durationMs: 145, service: "github" },
      resolution: { reviewer: "marcus@marchward.ai", reviewedAt: "2026-05-11T17:05:00Z", notes: null, channel: "dashboard" },
    };
    const { fetch } = capturingFetch(200, approved);
    const client = makeClient(fetch);
    const result = await client.getExecution("req_x");

    assert.equal(result.status, "approved");
    // Discriminated union: TS narrows execution presence on 'approved'.
    if (result.status === "approved") {
      assert.equal(result.execution?.statusCode, 201);
      assert.deepEqual(result.execution?.body, { id: "issue_42" });
    }
  });
});

// ─── Auto-Idempotency-Key on execute() ──────────────────────────────

describe("execute() — auto Idempotency-Key", () => {
  const escalateBody = {
    decision: "ESCALATE",
    status: "pending",
    requestId: "req_auto_uuid",
    reviewId: "rev_1",
  };

  it("sets Idempotency-Key to the requestId by default", async () => {
    const { fetch, calls } = capturingFetch(202, escalateBody);
    const client = makeClient(fetch);

    await client.execute({
      toolName: "issues.create",
      arguments: { title: "Hello" },
      policyBundleId: "pb_1",
      service: "github",
      downstream: { url: "https://api.github.com/repos/x/issues", method: "POST" },
      requestId: "req_caller_supplied",
    });

    const hdr = getHeader(calls[0]!.init, "Idempotency-Key");
    assert.equal(hdr, "req_caller_supplied", "Idempotency-Key header should default to the requestId");
  });

  it("uses an auto-generated requestId when one isn't supplied", async () => {
    const { fetch, calls } = capturingFetch(202, escalateBody);
    const client = makeClient(fetch);

    await client.execute({
      toolName: "issues.create",
      policyBundleId: "pb_1",
      service: "github",
      downstream: { url: "https://api.github.com/repos/x/issues", method: "POST" },
    });

    const hdr = getHeader(calls[0]!.init, "Idempotency-Key");
    assert.ok(hdr && hdr.length > 0, "Idempotency-Key must be set even without a caller-supplied requestId");
    // The request body should contain the same requestId so retries hit the
    // same idempotency window AND the same review row.
    const bodyStr = calls[0]!.init.body as string | undefined;
    assert.ok(bodyStr);
    const parsed = JSON.parse(bodyStr) as { requestId: string };
    assert.equal(parsed.requestId, hdr, "body.requestId and Idempotency-Key header must match");
  });

  it("omits Idempotency-Key when idempotency: 'manual'", async () => {
    const { fetch, calls } = capturingFetch(202, escalateBody);
    const client = makeClient(fetch, { idempotency: "manual" });

    await client.execute({
      toolName: "issues.create",
      policyBundleId: "pb_1",
      service: "github",
      downstream: { url: "https://api.github.com/repos/x/issues", method: "POST" },
      requestId: "req_x",
    });

    const hdr = getHeader(calls[0]!.init, "Idempotency-Key");
    assert.equal(hdr, undefined, "manual idempotency mode must NOT set the header");
  });

  it("omits Idempotency-Key when idempotency: 'off'", async () => {
    const { fetch, calls } = capturingFetch(202, escalateBody);
    const client = makeClient(fetch, { idempotency: "off" });

    await client.execute({
      toolName: "issues.create",
      policyBundleId: "pb_1",
      service: "github",
      downstream: { url: "https://api.github.com/repos/x/issues", method: "POST" },
    });

    assert.equal(getHeader(calls[0]!.init, "Idempotency-Key"), undefined);
  });

  it("does NOT add Idempotency-Key to non-execute requests (e.g., GET /v1/decisions)", async () => {
    const { fetch, calls } = capturingFetch(200, { decisions: [], total: 0, limit: 50, offset: 0 });
    const client = makeClient(fetch);

    await client.listDecisions();

    assert.equal(getHeader(calls[0]!.init, "Idempotency-Key"), undefined);
  });
});
