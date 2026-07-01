#!/usr/bin/env node
/**
 * @marchward/proxy — CLI entry point
 *
 * Usage:
 *   marchward-proxy --command "npx -y @modelcontextprotocol/server-filesystem /tmp" \
 *               --policy-bundle my-policy \
 *               --mode HITL
 *
 *   # Local mode (no API, engine-only):
 *   marchward-proxy --command "node my-mcp-server.js" \
 *               --policy-file ./policy.json \
 *               --local
 *
 *   # Remote mode (via Marchward API):
 *   marchward-proxy --command "node my-mcp-server.js" \
 *               --policy-bundle payment-policy \
 *               --api-url http://localhost:3100 \
 *               --api-key mw_abc123
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";
import type { ProxyConfig } from "./types.js";
import { MarchwardProxy } from "./proxy.js";

// Load .env from project root
dotenvConfig({ path: resolve(process.cwd(), ".env") });

// ─── Argument Parsing ───────────────────────────────────────────────

function parseArgs(argv: string[]): ProxyConfig {
  const args = argv.slice(2);
  const opts: Record<string, string> = {};
  const positional: string[] = [];

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
    } else {
      positional.push(arg);
    }
  }

  // ─── Resolve command ────────────────────────────────────────────
  const commandStr = opts["command"];
  if (!commandStr) {
    printUsage();
    process.exit(1);
  }

  const parts = commandStr.split(/\s+/);
  const command = parts[0]!;
  const commandArgs = parts.slice(1);

  // ─── Policy ─────────────────────────────────────────────────────
  const policyBundleId =
    opts["policy-bundle"] ?? opts["policy"] ?? "default";

  // ─── Local policy file ──────────────────────────────────────────
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

  // ─── Build config ───────────────────────────────────────────────
  const config: ProxyConfig = {
    command,
    args: commandArgs,
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
  };

  // ─── Pass-through environment ───────────────────────────────────
  const envPairs: Record<string, string> = {};
  for (const [key, val] of Object.entries(opts)) {
    if (key.startsWith("env-") && val) {
      envPairs[key.slice(4)] = val;
    }
  }
  if (Object.keys(envPairs).length > 0) {
    config.env = envPairs;
  }

  return config;
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
  Usage: marchward-proxy --command "<mcp-server-command>" [options]

  Required:
    --command <cmd>         MCP server command to proxy (e.g. "node server.js")

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

  Other:
    --log-level <level>     Log level: debug, info, warn, error, silent
    --verbose               Shortcut for --log-level debug
    --env-KEY <value>       Pass environment variable to upstream server
  `);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs(process.argv);
  const proxy = new MarchwardProxy(config);
  await proxy.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
