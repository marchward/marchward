/**
 * @marchward/proxy — JSON-RPC utilities tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseMessage,
  isRequest,
  isResponse,
  isNotification,
  serializeMessage,
  errorResponse,
  toolResultResponse,
} from "../jsonrpc.js";

describe("parseMessage", () => {
  it("parses a valid JSON-RPC request", () => {
    const msg = parseMessage(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file"}}',
    );
    assert.ok(msg);
    assert.equal((msg as { id: number }).id, 1);
    assert.equal((msg as { method: string }).method, "tools/call");
  });

  it("parses a valid JSON-RPC response", () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    assert.ok(msg);
    assert.equal((msg as { id: number }).id, 1);
  });

  it("parses a valid JSON-RPC notification", () => {
    const msg = parseMessage(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    );
    assert.ok(msg);
    assert.equal((msg as { method: string }).method, "notifications/initialized");
  });

  it("returns null for invalid JSON", () => {
    assert.equal(parseMessage("not json"), null);
  });

  it("returns null for non-JSON-RPC JSON", () => {
    assert.equal(parseMessage('{"hello":"world"}'), null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseMessage(""), null);
  });
});

describe("isRequest", () => {
  it("identifies a request (has method + id)", () => {
    const msg = parseMessage(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
    )!;
    assert.equal(isRequest(msg), true);
  });

  it("rejects a notification (method but no id)", () => {
    const msg = parseMessage(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    )!;
    assert.equal(isRequest(msg), false);
  });

  it("rejects a response", () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"result":{}}')!;
    assert.equal(isRequest(msg), false);
  });
});

describe("isResponse", () => {
  it("identifies a success response", () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')!;
    assert.equal(isResponse(msg), true);
  });

  it("identifies an error response", () => {
    const msg = parseMessage(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Invalid"}}',
    )!;
    assert.equal(isResponse(msg), true);
  });

  it("rejects a request", () => {
    const msg = parseMessage(
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    )!;
    assert.equal(isResponse(msg), false);
  });
});

describe("isNotification", () => {
  it("identifies a notification (method, no id)", () => {
    const msg = parseMessage(
      '{"jsonrpc":"2.0","method":"notifications/progress"}',
    )!;
    assert.equal(isNotification(msg), true);
  });

  it("rejects a request (has id)", () => {
    const msg = parseMessage(
      '{"jsonrpc":"2.0","id":5,"method":"tools/list"}',
    )!;
    assert.equal(isNotification(msg), false);
  });
});

describe("serializeMessage", () => {
  it("serializes and terminates with newline", () => {
    const result = serializeMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "test",
    });
    assert.ok(result.endsWith("\n"));
    assert.deepEqual(JSON.parse(result.trim()), {
      jsonrpc: "2.0",
      id: 1,
      method: "test",
    });
  });
});

describe("errorResponse", () => {
  it("creates a properly formatted error response", () => {
    const resp = errorResponse(42, -32600, "Invalid Request");
    assert.equal(resp.jsonrpc, "2.0");
    assert.equal(resp.id, 42);
    assert.equal(resp.error?.code, -32600);
    assert.equal(resp.error?.message, "Invalid Request");
  });

  it("includes optional data", () => {
    const resp = errorResponse(1, -32000, "Custom", { detail: "extra" });
    assert.deepEqual(resp.error?.data, { detail: "extra" });
  });
});

describe("toolResultResponse", () => {
  it("creates a tool result response", () => {
    const resp = toolResultResponse(7, "Hello from tool");
    assert.equal(resp.jsonrpc, "2.0");
    assert.equal(resp.id, 7);
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    assert.equal(result.content[0]!.type, "text");
    assert.equal(result.content[0]!.text, "Hello from tool");
    assert.equal(result.isError, false);
  });

  it("marks error results", () => {
    const resp = toolResultResponse(8, "Error occurred", true);
    const result = resp.result as { isError: boolean };
    assert.equal(result.isError, true);
  });
});
