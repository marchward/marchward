/**
 * @marchward/proxy — JSON-RPC message parsing and serialization
 *
 * Handles reading newline-delimited JSON-RPC messages from stdio streams
 * and writing them back out.
 */

import type { Readable, Writable } from "node:stream";
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./types.js";

/**
 * Parse a single line of JSON into a JSON-RPC message.
 * Returns null if the line is not valid JSON-RPC.
 */
export function parseMessage(line: string): JsonRpcMessage | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed && parsed.jsonrpc === "2.0") {
      return parsed as JsonRpcMessage;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a message is a JSON-RPC request (has method and id).
 */
export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

/**
 * Check if a message is a JSON-RPC response (has result or error, and id).
 */
export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return ("result" in msg || "error" in msg) && "id" in msg;
}

/**
 * Check if a message is a JSON-RPC notification (has method but no id).
 */
export function isNotification(msg: JsonRpcMessage): boolean {
  return "method" in msg && !("id" in msg);
}

/**
 * Serialize a message to a JSON string (newline-terminated).
 */
export function serializeMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * Write a JSON-RPC message to a writable stream.
 */
export function writeMessage(stream: Writable, msg: JsonRpcMessage): void {
  stream.write(serializeMessage(msg));
}

/**
 * Create a JSON-RPC error response.
 */
export function errorResponse(
  id: number | string,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  };
}

/**
 * Create a JSON-RPC success response with MCP tool result format.
 */
export function toolResultResponse(
  id: number | string,
  text: string,
  isError: boolean = false,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      isError,
    },
  };
}

/**
 * Read newline-delimited JSON-RPC messages from a readable stream.
 * Calls the handler for each complete message.
 */
export function createMessageReader(
  stream: Readable,
  handler: (msg: JsonRpcMessage, raw: string) => void,
): void {
  let buffer = "";

  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      const msg = parseMessage(line);
      if (msg) {
        handler(msg, line);
      }
    }
  });
}
