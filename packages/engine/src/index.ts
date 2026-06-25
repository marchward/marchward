/**
 * @marchward/engine — Runtime authority engine for autonomous systems
 *
 * The core decision-making package for Marchward. Pure TypeScript, zero
 * external dependencies, fully deterministic.
 *
 * Usage:
 *   import { authorize, evaluate } from "@marchward/engine";
 *
 *   const { response, record } = authorize(request, policyBundle);
 */

// Core evaluator
export { authorize, evaluate, buildDecisionRecord } from "./evaluator.js";

// Governance modes
export { applyGovernanceMode } from "./modes.js";

// Hash chaining
export {
  sha256,
  hashInputs,
  hashRecord,
  buildIntegrity,
  verifyRecordIntegrity,
  verifyChain,
  GENESIS_HASH,
} from "./hash.js";

// All types
export type {
  // Decision outcomes
  DecisionOutcome,
  DefaultAction,
  GovernanceMode,

  // Authorization request
  ToolCall,
  AgentInfo,
  RequestContext,
  Signals,
  PolicyBundleRef,
  AuthorizeRequest,

  // Authorization response
  AuthorizeResponse,

  // Policy bundle
  RuleOperator,
  RuleCondition,
  RuleAction,
  PolicyRule,
  PolicyThresholds,
  RoleConfig,
  PolicyBundle,

  // Evaluation internals
  RuleHit,
  TerminationReason,
  EvaluationResult,

  // Decision record (audit trail)
  IntegrityRecord,
  DecisionRecord,

  // Configuration
  EngineConfig,
} from "./types.js";
