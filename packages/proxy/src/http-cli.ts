#!/usr/bin/env node
/**
 * @marchward/proxy — HTTP Proxy CLI entry point
 *
 * Usage:
 *   marchward-http-proxy --upstream http://localhost:8080 \
 *                    --port 4000 \
 *                    --policy-bundle my-policy \
 *                    --extraction path
 *
 *   # Local mode (no API, engine-only):
 *   marchward-http-proxy --upstream http://api.example.com \
 *                    --port 4000 \
 *                    --policy-file ./policy.json \
 *                    --local
 *
 *   # Header-based extraction:
 *   marchward-http-proxy --upstream http://localhost:8080 \
 *                    --port 4000 \
 *                    --policy-bundle payment-policy \
 *                    --extraction header \
 *                    --api-url http://localhost:3100 \
 *                    --api-key mw_abc123
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";
import type { HttpProxyConfig } from "./http-types.js";
import { MarchwardHttpProxy } from "./http-proxy.js";

// Load .env from project root
dotenvConfig({ path: resolve(process.cwd(), ".env") });

// ─── Argument Parsing ───────────────────────────────────────────────

function parseArgs(argv: string[]): HttpProxyConfig {
  const args = argv.slice(2);
  const opts: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = "true";
      }
    }
  }

  // ─── Required options ─────────────────────────────────────────────
  const upstreamUrl = opts["upstream"];
  if (!upstreamUrl) {
    printUsage();
    process.exit(1);
  }

  const port = parseInt(opts["port"] ?? "4000", 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${opts["port"]}`);
    process.exit(1);
  }

  // ─── Policy ───────────────────────────────────────────────────────
  const policyBundleId =
    opts["policy-bundle"] ?? opts["policy"] ?? "default";

  // ─── Local policy file ────────────────────────────────────────────
  let localPolicy: unknown = undefined;
  const policyFile = opts["policy-file"];
  if (policyFile) {
    try {
      const raw = readFileSync(resolve(process.cwd(), policyFile), "utf-8");
      localPolicy = JSON.parse(raw);
    } catch (err) {
      console.error(`Failed to load policy file: ${policyFile}`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  const isLocal = opts["local"] === "true" || !!policyFile;

  // ─── Extraction strategy ──────────────────────────────────────────
  const extraction = parseExtraction(opts["extraction"]);

  // ─── Passthrough paths ────────────────────────────────────────────
  const passthroughPaths = opts["passthrough"]
    ? opts["passthrough"].split(",").map((p) => p.trim())
    : undefined;

  // ─── Build config ─────────────────────────────────────────────────
  const config: HttpProxyConfig = {
    port,
    host: opts["host"] ?? "127.0.0.1",
    upstreamUrl,
    toolExtraction: extraction,
    pathPrefix: opts["path-prefix"] ?? "/tools",
    policyBundleId,
    policyVersion: opts["policy-version"],
    agentId: opts["agent-id"] ?? (process.env["MARCHWARD_AGENT_ID"] ?? process.env["TENET_AGENT_ID"]),
    mode: parseMode(opts["mode"]),
    defaultRole: opts["role"] ?? "assistant",
    localMode: isLocal,
    localPolicy,
    marchwardApiUrl:
      opts["api-url"] ?? (process.env["MARCHWARD_API_URL"] ?? process.env["TENET_API_URL"]) ?? "http://localhost:3100",
    marchwardApiKey: opts["api-key"] ?? (process.env["MARCHWARD_API_KEY"] ?? process.env["TENET_API_KEY"]),
    logLevel: parseLogLevel(opts["log-level"] ?? opts["verbose"]),
    passthroughPaths,
    timeout: opts["timeout"] ? parseInt(opts["timeout"], 10) : undefined,
  };

  // ─── Extra headers ────────────────────────────────────────────────
  const extraHeaders: Record<string, string> = {};
  for (const [key, val] of Object.entries(opts)) {
    if (key.startsWith("header-") && val) {
      extraHeaders[key.slice(7)] = val;
    }
  }
  if (Object.keys(extraHeaders).length > 0) {
    config.extraHeaders = extraHeaders;
  }

  // ─── Local cost cap (--cost-cap-usd flag, or costCapUsd in the policy file) ──
  const policyObj =
    localPolicy && typeof localPolicy === "object"
      ? (localPolicy as Record<string, unknown>)
      : {};
  const costCapRaw =
    opts["cost-cap-usd"] ??
    (typeof policyObj["costCapUsd"] === "number" ? String(policyObj["costCapUsd"]) : undefined);
  if (costCapRaw) {
    const capUsd = Number.parseFloat(costCapRaw);
    if (Number.isFinite(capUsd) && capUsd > 0) {
      config.costCapUsd = capUsd;
      const winRaw =
        opts["cost-window-minutes"] ??
        (typeof policyObj["costWindowMinutes"] === "number"
          ? String(policyObj["costWindowMinutes"])
          : undefined);
      if (winRaw) {
        const win = Number.parseInt(winRaw, 10);
        if (Number.isFinite(win) && win >= 1) config.costWindowMinutes = win;
      }
    } else {
      console.error(`Invalid --cost-cap-usd: ${costCapRaw} (expected a positive number)`);
      process.exit(1);
    }
  }

  return config;
}

function parseExtraction(
  raw?: string,
): "path" | "header" | "body" | "custom" {
  if (!raw) return "path";
  const lower = raw.toLowerCase();
  if (lower === "path" || lower === "header" || lower === "body" || lower === "custom") {
    return lower;
  }
  console.error(`Invalid extraction strategy: ${raw}. Use path, header, or body.`);
  process.exit(1);
}

function parseMode(
  raw?: string,
): "HIC" | "HITL" | "HOTL" | undefined {
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  if (upper === "HIC" || upper === "HITL" || upper === "HOTL") {
    return upper;
  }
  console.error(`Invalid mode: ${raw}. Use HIC, HITL, or HOTL.`);
  process.exit(1);
}

function parseLogLevel(
  raw?: string,
): "debug" | "info" | "warn" | "error" | "silent" {
  if (!raw) return "info";
  if (raw === "true") return "debug"; // --verbose
  const valid = ["debug", "info", "warn", "error", "silent"];
  if (valid.includes(raw)) return raw as "debug" | "info" | "warn" | "error" | "silent";
  return "info";
}

function printUsage(): void {
  console.error(`
  Usage: marchward-http-proxy --upstream <url> [options]

  Required:
    --upstream <url>        Upstream API base URL to proxy to

  Server:
    --port <port>           Port to listen on (default: 4000)
    --host <host>           Host to bind to (default: 127.0.0.1)

  Tool Extraction:
    --extraction <strategy> How to extract tool names: path, header, body (default: path)
    --path-prefix <prefix>  URL prefix for path extraction (default: /tools)

  Policy:
    --policy-bundle <id>    Policy bundle ID (default: "default")
    --policy-version <ver>  Policy version (default: latest)
    --policy-file <path>    Load policy from JSON file (enables local mode)
    --local                 Run in local mode (engine only, no API)

  Remote mode (default):
    --api-url <url>         Marchward API URL (default: http://localhost:3100)
    --api-key <key>         Marchward API key (or set TENET_API_KEY env var)

  Agent:
    --agent-id <id>         Agent identifier for tracking
    --role <role>           Default agent role (default: "assistant")
    --mode <mode>           Governance mode: HIC, HITL, HOTL

  Cost cap (local, self-host):
    --cost-cap-usd <usd>        Trip (429) once windowed inference spend reaches this cap.
                                Also reads costCapUsd from the --policy-file if set.
    --cost-window-minutes <m>   Rolling-window length for the cost cap (default: 60)

  Other:
    --passthrough <paths>   Comma-separated paths to skip policy evaluation
    --timeout <ms>          Upstream request timeout in ms (default: 30000)
    --log-level <level>     Log level: debug, info, warn, error, silent
    --verbose               Shortcut for --log-level debug
    --header-KEY <value>    Add extra header to upstream requests

  Examples:

    # Path-based extraction (default):
    # Agent calls POST http://localhost:4000/tools/send_email with JSON body
    # Proxy extracts tool "send_email", evaluates, forwards to upstream
    marchward-http-proxy --upstream http://api.example.com \\
                     --port 4000 \\
                     --policy-bundle email-policy \\
                     --api-key mw_abc123

    # Header-based extraction:
    # Agent sends X-Marchward-Tool: send_email header
    marchward-http-proxy --upstream http://api.example.com \\
                     --extraction header \\
                     --policy-file ./policy.json --local

    # Body-based extraction (OpenAI function calling):
    # Agent sends { "name": "send_email", "arguments": {...} }
    marchward-http-proxy --upstream http://api.example.com \\
                     --extraction body \\
                     --policy-bundle payment-policy
  `);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs(process.argv);
  const proxy = new MarchwardHttpProxy(config);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    await proxy.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await proxy.stop();
    process.exit(0);
  });

  await proxy.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
