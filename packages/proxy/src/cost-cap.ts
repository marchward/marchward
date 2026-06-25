/**
 * @marchward/proxy — Local cost-cap accounting
 *
 * Self-contained, zero-dependency rolling-window spend tracker so the
 * OPEN self-host stack enforces the inference **cost cap** locally —
 * without the hosted control plane. The engine carries the cost-cap
 * *config* (PolicyBundle.costCapUsd / costWindowMinutes); this module is
 * the local *enforcement* the hosted plane otherwise provides.
 *
 * Mirrors the hosted tracker's pure logic (token extraction, cost
 * estimation, minute-bucketed sliding window) but is intentionally
 * standalone: no DB, no API, no shared state — appropriate for a
 * single-process local governor running with the developer's own creds.
 * In local mode the "agent" is the running process, so spend is tracked
 * under a single key by default (override per-agent if you run several).
 *
 * Token extraction supports Anthropic (`usage.input_tokens`/`output_tokens`)
 * and OpenAI (`usage.prompt_tokens`/`completion_tokens`) response shapes.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface CostRates {
  /** USD per 1K input tokens. */
  input: number;
  /** USD per 1K output tokens. */
  output: number;
}

export interface LocalCostCapOptions {
  /** Spend ceiling in USD per rolling window. Required (from the policy bundle). */
  costCapUsd: number;
  /** Rolling-window length in minutes. Default: 60. */
  windowMinutes?: number;
  /** Cost-per-1K-tokens table, matched by `model.startsWith(prefix)` (first match wins). */
  costPer1kTokens?: Map<string, CostRates>;
  /** Fallback rates for unknown models. */
  defaultCostPer1k?: CostRates;
}

export type CostCheck =
  | { allowed: true; currentCostUsd: number; capUsd: number; windowMs: number }
  | { allowed: false; currentCostUsd: number; capUsd: number; windowMs: number };

// ─── Token extraction ───────────────────────────────────────────────

/**
 * Extract token usage from an LLM response body (Anthropic or OpenAI shape).
 * Returns null if the body doesn't look like an LLM response — the tracker
 * is additive, never a gate on un-parseable bodies.
 */
export function extractTokenUsage(body: unknown): TokenUsage | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;

  const usage = obj.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;

  const model = typeof obj.model === "string" ? obj.model : "unknown";

  // Anthropic format
  if (typeof u.input_tokens === "number" && typeof u.output_tokens === "number") {
    return { inputTokens: u.input_tokens, outputTokens: u.output_tokens, model };
  }
  // OpenAI format
  if (typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") {
    return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, model };
  }
  return null;
}

// ─── Cost estimation ────────────────────────────────────────────────

/** Approximate cost per 1K tokens (USD), conservative (slightly high) to catch overspend early. */
export const DEFAULT_COST_TABLE = new Map<string, CostRates>([
  ["claude-opus-4", { input: 0.015, output: 0.075 }],
  ["claude-sonnet-4", { input: 0.003, output: 0.015 }],
  ["claude-haiku-4", { input: 0.0008, output: 0.004 }],
  ["claude-3-5-sonnet", { input: 0.003, output: 0.015 }],
  ["claude-3-5-haiku", { input: 0.001, output: 0.005 }],
  ["claude-3-opus", { input: 0.015, output: 0.075 }],
  ["gpt-4o", { input: 0.005, output: 0.015 }],
  ["gpt-4-turbo", { input: 0.01, output: 0.03 }],
  ["gpt-4", { input: 0.03, output: 0.06 }],
  ["gpt-3.5", { input: 0.0005, output: 0.0015 }],
]);

/** Conservative fallback for unknown models (assume expensive). */
export const DEFAULT_FALLBACK_COST: CostRates = { input: 0.015, output: 0.075 };

export function estimateCost(
  usage: TokenUsage,
  costTable: Map<string, CostRates> = DEFAULT_COST_TABLE,
  fallback: CostRates = DEFAULT_FALLBACK_COST,
): number {
  let rates = fallback;
  for (const [prefix, r] of costTable) {
    if (usage.model.startsWith(prefix)) {
      rates = r;
      break;
    }
  }
  return (usage.inputTokens / 1000) * rates.input + (usage.outputTokens / 1000) * rates.output;
}

// ─── Sliding-window accumulator (minute buckets, lazily evicted) ─────

interface Bucket {
  minuteMs: number;
  costUsd: number;
}

class SlidingWindow {
  private readonly buckets = new Map<string, Bucket[]>();

  record(key: string, costUsd: number, nowMs: number): void {
    const minuteMs = Math.floor(nowMs / 60_000) * 60_000;
    let arr = this.buckets.get(key);
    if (!arr) {
      arr = [];
      this.buckets.set(key, arr);
    }
    const last = arr.length > 0 ? arr[arr.length - 1] : null;
    if (last && last.minuteMs === minuteMs) {
      last.costUsd += costUsd;
    } else {
      arr.push({ minuteMs, costUsd });
    }
  }

  totalCost(key: string, windowMs: number, nowMs: number): number {
    const arr = this.buckets.get(key);
    if (!arr) return 0;
    const cutoff = nowMs - windowMs;
    // Evict fully-expired leading buckets.
    let firstValid = arr.length;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].minuteMs >= cutoff) {
        firstValid = i;
        break;
      }
    }
    if (firstValid > 0) arr.splice(0, firstValid);
    let total = 0;
    for (const b of arr) total += b.costUsd;
    return total;
  }
}

// ─── Local cost cap ─────────────────────────────────────────────────

const DEFAULT_KEY = "__local__";

/**
 * Local, in-process rolling-window cost cap. Construct one per running
 * proxy from the active policy bundle's `costCapUsd` / `costWindowMinutes`.
 *
 * Flow: on each governed LLM response, call `record(usage)`; before
 * allowing the next call, call `check()` — if window spend ≥ cap it
 * returns `allowed: false` and the governor should BLOCK (the local
 * equivalent of the hosted 429 cap trip).
 */
export class LocalCostCap {
  private readonly capUsd: number;
  private readonly windowMs: number;
  private readonly costTable: Map<string, CostRates>;
  private readonly fallback: CostRates;
  private readonly window = new SlidingWindow();

  constructor(opts: LocalCostCapOptions) {
    if (!(opts.costCapUsd > 0)) {
      throw new Error(`costCapUsd must be positive, got ${opts.costCapUsd}`);
    }
    const windowMinutes = opts.windowMinutes ?? 60;
    if (!(windowMinutes >= 1)) {
      throw new Error(`windowMinutes must be >= 1, got ${windowMinutes}`);
    }
    this.capUsd = opts.costCapUsd;
    this.windowMs = windowMinutes * 60_000;
    this.costTable = opts.costPer1kTokens ?? DEFAULT_COST_TABLE;
    this.fallback = opts.defaultCostPer1k ?? DEFAULT_FALLBACK_COST;
  }

  /** Record a usage event from a downstream LLM response. Returns the estimated cost. Never throws. */
  record(usage: TokenUsage, nowMs: number = Date.now(), key: string = DEFAULT_KEY): number {
    const cost = estimateCost(usage, this.costTable, this.fallback);
    this.window.record(key, cost, nowMs);
    return cost;
  }

  /** Convenience: extract usage from a response body and record it. Returns cost, or 0 if not an LLM response. */
  recordFromResponse(body: unknown, nowMs: number = Date.now(), key: string = DEFAULT_KEY): number {
    const usage = extractTokenUsage(body);
    if (!usage) return 0;
    return this.record(usage, nowMs, key);
  }

  /** Check whether spend within the window is still under the cap. allowed=false when spend >= cap. */
  check(nowMs: number = Date.now(), key: string = DEFAULT_KEY): CostCheck {
    const currentCostUsd = this.window.totalCost(key, this.windowMs, nowMs);
    return {
      allowed: currentCostUsd < this.capUsd,
      currentCostUsd,
      capUsd: this.capUsd,
      windowMs: this.windowMs,
    };
  }

  /** Current window spend in USD (for status/telemetry). */
  currentSpend(nowMs: number = Date.now(), key: string = DEFAULT_KEY): number {
    return this.window.totalCost(key, this.windowMs, nowMs);
  }
}
