/**
 * @marchward/sdk — Inference unit tests
 *
 * Tests `Marchward#inference()` end-to-end against a mock fetch:
 *   - builds the right execute payload for anthropic + openai
 *   - polls getExecution() until terminal
 *   - extracts token usage from anthropic + openai response bodies
 *   - surfaces blocked / failed states without polling
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Marchward } from "../index.js";

// ─── Stub fetch that responds to the SDK's three call shapes ────────

interface StubBehavior {
  /** Response from POST /v1/execute */
  execute: {
    status: number;
    body: unknown;
  };
  /** Response from GET /v1/executions/:requestId, in order. */
  executions?: Array<{ status: number; body: unknown }>;
}

function stubFetch(behavior: StubBehavior) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let executionCallIndex = 0;

  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    calls.push({ url, method, body });

    if (url.includes("/v1/execute") && method === "POST") {
      return new Response(JSON.stringify(behavior.execute.body), {
        status: behavior.execute.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/v1/executions/") && method === "GET") {
      const r =
        behavior.executions?.[executionCallIndex] ??
        behavior.executions?.[behavior.executions.length - 1];
      executionCallIndex += 1;
      if (!r) {
        return new Response(JSON.stringify({ message: "no stub" }), { status: 500 });
      }
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ message: "unhandled stub path" }), { status: 500 });
  };

  return { fetch: fetchFn, calls };
}

function client(fetchFn: typeof globalThis.fetch): Marchward {
  return new Marchward({
    apiUrl: "https://api.marchward.test",
    apiKey: "mw_test_key_inf",
    defaultAgent: { agentId: "test-agent" },
    defaultMode: "HITL",
    timeout: 5000,
    retry: { maxRetries: 0 },
    fetch: fetchFn,
  });
}

// ─── Anthropic happy path ───────────────────────────────────────────

describe("Marchward#inference — Anthropic", () => {
  it("builds the correct execute payload + extracts tokens from response", async () => {
    const { fetch, calls } = stubFetch({
      execute: {
        status: 202,
        body: { decision: "ALLOW", requestId: "req_anth_1", jobId: "job_1" },
      },
      executions: [
        {
          status: 200,
          body: {
            status: "allowed",
            requestId: "req_anth_1",
            decisionId: "dec_1",
            execution: {
              statusCode: 200,
              service: "anthropic",
              headers: {},
              durationMs: 1234,
              body: {
                id: "msg_01",
                model: "claude-sonnet-4-6",
                content: [{ type: "text", text: "Hi there" }],
                usage: { input_tokens: 12, output_tokens: 7 },
              },
            },
          },
        },
      ],
    });

    const t = client(fetch);
    const result = await t.inference({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
      policyBundleId: "default-inference-policy",
    });

    assert.equal(result.status, "allowed");
    assert.equal(result.requestId, "req_anth_1");
    assert.deepEqual(result.tokens, { input: 12, output: 7, model: "claude-sonnet-4-6" });

    // First call: POST /v1/execute
    const submit = calls.find((c) => c.url.endsWith("/v1/execute"));
    assert.ok(submit, "expected a POST to /v1/execute");
    assert.equal(submit.method, "POST");
    const submitBody = submit.body as Record<string, unknown>;
    assert.equal(submitBody["service"], "anthropic");
    // execute() wraps toolName + arguments under `toolCall`
    const toolCall = submitBody["toolCall"] as Record<string, unknown>;
    assert.equal(toolCall["toolName"], "inference.anthropic.messages");

    const downstream = submitBody["downstream"] as Record<string, unknown>;
    assert.equal(downstream["url"], "https://api.anthropic.com/v1/messages");
    assert.equal(downstream["method"], "POST");
    const downstreamHeaders = downstream["headers"] as Record<string, string>;
    assert.equal(downstreamHeaders["anthropic-version"], "2023-06-01");

    const downstreamBody = downstream["body"] as Record<string, unknown>;
    assert.equal(downstreamBody["model"], "claude-sonnet-4-6");
    assert.equal(downstreamBody["max_tokens"], 1024);
    assert.deepEqual(downstreamBody["messages"], [{ role: "user", content: "Hello" }]);
  });
});

// ─── OpenAI happy path ──────────────────────────────────────────────

describe("Marchward#inference — OpenAI", () => {
  it("builds the correct execute payload + extracts tokens from openai response", async () => {
    const { fetch, calls } = stubFetch({
      execute: {
        status: 202,
        body: { decision: "ALLOW", requestId: "req_oai_1", jobId: "job_2" },
      },
      executions: [
        {
          status: 200,
          body: {
            status: "approved",
            requestId: "req_oai_1",
            decisionId: "dec_2",
            execution: {
              statusCode: 200,
              service: "openai",
              headers: {},
              durationMs: 567,
              body: {
                id: "chatcmpl_01",
                model: "gpt-4o",
                choices: [{ message: { role: "assistant", content: "Hi" } }],
                usage: { prompt_tokens: 8, completion_tokens: 3 },
              },
            },
          },
        },
      ],
    });

    const t = client(fetch);
    const result = await t.inference({
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.5,
      policyBundleId: "default-inference-policy",
    });

    assert.equal(result.status, "approved");
    assert.deepEqual(result.tokens, { input: 8, output: 3, model: "gpt-4o" });

    const submit = calls.find((c) => c.url.endsWith("/v1/execute"));
    assert.ok(submit);
    const submitBody = submit.body as Record<string, unknown>;
    assert.equal(submitBody["service"], "openai");
    const toolCall = submitBody["toolCall"] as Record<string, unknown>;
    assert.equal(toolCall["toolName"], "inference.openai.chat");

    const downstream = submitBody["downstream"] as Record<string, unknown>;
    assert.equal(downstream["url"], "https://api.openai.com/v1/chat/completions");
    const downstreamBody = downstream["body"] as Record<string, unknown>;
    assert.equal(downstreamBody["temperature"], 0.5);
  });
});

// ─── Polling + terminal-state surfacing ─────────────────────────────

describe("Marchward#inference — polling", () => {
  it("polls until status is non-pending", async () => {
    const { fetch, calls } = stubFetch({
      execute: { status: 202, body: { decision: "ALLOW", requestId: "req_poll", jobId: "j" } },
      executions: [
        { status: 200, body: { status: "pending", requestId: "req_poll", decisionId: "d" } },
        { status: 200, body: { status: "pending", requestId: "req_poll", decisionId: "d" } },
        {
          status: 200,
          body: {
            status: "allowed",
            requestId: "req_poll",
            decisionId: "d",
            execution: {
              statusCode: 200,
              service: "anthropic",
              headers: {},
              durationMs: 100,
              body: {
                model: "claude-haiku-4",
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
          },
        },
      ],
    });

    const t = client(fetch);
    const result = await t.inference({
      provider: "anthropic",
      model: "claude-haiku-4",
      messages: [{ role: "user", content: "hi" }],
      policyBundleId: "p",
      timeoutMs: 5000,
    });

    assert.equal(result.status, "allowed");
    const getExecCalls = calls.filter((c) => c.url.includes("/v1/executions/"));
    assert.ok(getExecCalls.length >= 3, `expected ≥3 poll calls, got ${getExecCalls.length}`);
  });
});

// ─── Blocked / rejected — no polling ────────────────────────────────

describe("Marchward#inference — block / fail", () => {
  it("surfaces BLOCK without polling", async () => {
    const { fetch, calls } = stubFetch({
      execute: {
        status: 200,
        body: {
          decision: "BLOCK",
          requestId: "req_blk",
          decisionId: "d_blk",
          message: "policy blocks model claude-opus-4 for this agent",
        },
      },
    });

    const t = client(fetch);
    const result = await t.inference({
      provider: "anthropic",
      model: "claude-opus-4",
      messages: [{ role: "user", content: "x" }],
      policyBundleId: "p",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.decision, "BLOCK");
    assert.equal(result.body, undefined);
    assert.equal(result.tokens, null);

    const pollCalls = calls.filter((c) => c.url.includes("/v1/executions/"));
    assert.equal(pollCalls.length, 0, "should not poll on BLOCK");
  });
});

// ─── Validation ─────────────────────────────────────────────────────

describe("Marchward#inference — validation", () => {
  it("throws on unsupported provider", async () => {
    const t = client(() => Promise.resolve(new Response("{}", { status: 200 })));

    await assert.rejects(
      t.inference({
        provider: "ollama" as never,
        model: "any",
        messages: [],
        policyBundleId: "p",
      }),
      /Unsupported inference provider/,
    );
  });

  it("throws when policyBundleId is missing", async () => {
    const t = client(() => Promise.resolve(new Response("{}", { status: 200 })));

    await assert.rejects(
      t.inference({
        provider: "anthropic",
        model: "claude-haiku-4",
        messages: [],
      } as never),
      /policyBundleId is required/,
    );
  });
});
