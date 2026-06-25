/**
 * @marchward/proxy — Colored terminal logging
 *
 * Provides structured, color-coded log output for proxy events.
 * No external dependencies — uses ANSI escape codes directly.
 */

import type { ProxyEvent } from "./types.js";

// ─── ANSI Colors ────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

// ─── Log Levels ─────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

// ─── Logger ─────────────────────────────────────────────────────────

export class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private timestamp(): string {
    return new Date().toISOString().slice(11, 23);
  }

  private prefix(level: string, color: string): string {
    return `${GRAY}${this.timestamp()}${RESET} ${color}${BOLD}${level}${RESET}`;
  }

  debug(msg: string): void {
    if (this.shouldLog("debug")) {
      console.error(`${this.prefix("DBG", GRAY)} ${DIM}${msg}${RESET}`);
    }
  }

  info(msg: string): void {
    if (this.shouldLog("info")) {
      console.error(`${this.prefix("INF", BLUE)} ${msg}`);
    }
  }

  warn(msg: string): void {
    if (this.shouldLog("warn")) {
      console.error(`${this.prefix("WRN", YELLOW)} ${msg}`);
    }
  }

  error(msg: string): void {
    if (this.shouldLog("error")) {
      console.error(`${this.prefix("ERR", RED)} ${msg}`);
    }
  }

  // ─── Proxy-specific formatters ──────────────────────────────────

  proxyEvent(event: ProxyEvent): void {
    if (!this.shouldLog("info")) return;

    const tool = event.toolName ? `${CYAN}${event.toolName}${RESET}` : "";

    switch (event.type) {
      case "proxy_started":
        console.error(
          `\n  ${GREEN}${BOLD}🛡️  Marchward Proxy active${RESET}` +
          `\n     ${DIM}Intercepting tool calls for policy evaluation${RESET}\n`,
        );
        break;

      case "proxy_stopped":
        console.error(`\n  ${DIM}Proxy stopped.${RESET}\n`);
        break;

      case "tool_call_intercepted":
        console.error(
          `${this.prefix(">>>", MAGENTA)} ${BOLD}Intercepted${RESET} ${tool}`,
        );
        break;

      case "tool_call_allowed":
        console.error(
          `${this.prefix(" ✓ ", GREEN)} ${GREEN}ALLOW${RESET} ${tool}` +
          (event.durationMs != null ? ` ${DIM}(${event.durationMs}ms)${RESET}` : ""),
        );
        break;

      case "tool_call_blocked":
        console.error(
          `${this.prefix(" ✗ ", RED)} ${RED}BLOCK${RESET} ${tool}` +
          (event.detail ? ` — ${event.detail}` : ""),
        );
        break;

      case "tool_call_escalated":
        console.error(
          `${this.prefix(" ⚠ ", YELLOW)} ${YELLOW}ESCALATE${RESET} ${tool}` +
          (event.detail ? ` — ${event.detail}` : ""),
        );
        break;

      case "tool_call_forwarded":
        this.debug(`Forwarded ${event.toolName ?? "message"} to upstream`);
        break;

      case "tool_call_completed":
        this.debug(
          `Completed ${event.toolName ?? "call"}` +
          (event.durationMs != null ? ` (${event.durationMs}ms)` : ""),
        );
        break;

      case "upstream_error":
        console.error(
          `${this.prefix("ERR", RED)} Upstream: ${event.detail ?? "unknown error"}`,
        );
        break;
    }
  }

  banner(config: { command: string; policyBundleId: string; mode?: string }): void {
    console.error(`
  ${BOLD}╔═══════════════════════════════════════════╗
  ║          ${GREEN}MARCHWARD PROXY${RESET}${BOLD}  v0.1.0            ║
  ╚═══════════════════════════════════════════╝${RESET}

  ${DIM}Upstream:${RESET}  ${config.command}
  ${DIM}Policy:${RESET}   ${config.policyBundleId}
  ${DIM}Mode:${RESET}     ${config.mode ?? "HITL"}
`);
  }
}
