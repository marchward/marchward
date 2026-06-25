/**
 * @marchward/sdk — TypeScript SDK for the Marchward authorization API
 *
 * @example
 * ```typescript
 * import { MarchwardClient } from "@marchward/sdk";
 *
 * const marchward = new MarchwardClient({
 *   apiUrl: "https://api.marchward.ai",
 *   apiKey: "mw_your_key_here",
 *   defaultAgent: { agentId: "my-agent" },
 * });
 *
 * // Authorize a tool call
 * const decision = await marchward.authorize({
 *   toolName: "send_payment",
 *   arguments: { amount: 500, to: "vendor@example.com" },
 *   policyBundleId: "financial-controls",
 * });
 *
 * // Quick boolean check
 * const allowed = await marchward.isAllowed({ ... });
 *
 * // Authorize + execute in one call
 * const { decision, result } = await marchward.authorizeAndExecute(
 *   { toolName: "send_email", arguments: { to: "user@co.com" }, policyBundleId: "email-policy" },
 *   () => emailService.send({ to: "user@co.com", body: "Hello" }),
 * );
 * ```
 */

export { MarchwardClient } from "./client.js";

/**
 * Alias for `MarchwardClient`, the cleaner import shape:
 *
 *   import { Marchward } from "@marchward/sdk";
 *   const marchward = new Marchward({ apiKey: process.env.MARCHWARD_API_KEY });
 *
 * Existing `MarchwardClient` consumers continue to work unchanged.
 */
export { MarchwardClient as Marchward } from "./client.js";

// ─── Error Classes ──────────────────────────────────────────────────

export {
  MarchwardError,
  MarchwardApiError,
  MarchwardTimeoutError,
  MarchwardRetryError,
} from "./errors.js";


// ─── Types ──────────────────────────────────────────────────────────

export type {
  MarchwardClientConfig,
  AuthorizeInput,
  DecisionQuery,
  DecisionListResponse,
  PolicyListResponse,
  CreatePolicyInput,
  UpdatePolicyInput,
  HealthResponse,
  RetryConfig,
  // Reviews
  Review,
  ReviewQuery,
  ReviewListResponse,
  ReviewResolution,
  ReviewStatsResponse,
  ReviewStatus,
  // Policy Packs
  PolicyPack,
  PackSlot,
  PackCategory,
  PackListResponse,
  PackInstallRequest,
  PackInstallResponse,
  // Policy Changelog & Versioning
  PolicyChangelogAction,
  PolicyChangelogEntry,
  PolicyVersionSummary,
  PolicyVersionListResponse,
  PolicyChangelogResponse,
  RevertPolicyInput,
  // Execute / Executions (Phase 4 v1)
  ExecuteInput,
  ExecuteResponse,
  ExecutionStatus,
  ExecutionResult,
  InjectionStrategy,
  // Inference (wedge v1 — May 14 2026)
  InferenceInput,
  InferenceResponse,
  InferenceProvider,
} from "./types.js";

// Re-export engine types that SDK consumers commonly need
export type {
  DecisionOutcome,
  GovernanceMode,
  AuthorizeResponse,
  PolicyBundle,
  PolicyRule,
  DecisionRecord,
} from "./types.js";
