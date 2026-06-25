/**
 * @marchward/engine — Governance mode logic
 *
 * Governance modes determine how Marchward handles decisions:
 *
 * HIC  (Human In Control)  — Maximum safety. Blocks anything that isn't
 *                             explicitly allowed. Escalations become blocks.
 *
 * HITL (Human In The Loop)  — Edge cases go to humans. Escalations create
 *                             pending approvals. Blocks stay as blocks.
 *
 * HOTL (Human On The Loop)  — Monitor mode. Would-be blocks become
 *                             ALLOW_WITH_CONDITIONS (logged but not blocked).
 *                             Only hard blocks remain.
 */

import type {
  DecisionOutcome,
  GovernanceMode,
  EvaluationResult,
  TerminationReason,
} from "./types.js";

/**
 * Apply governance mode transformations to a raw evaluation result.
 *
 * The policy evaluator produces a "raw" decision based purely on rules
 * and thresholds. The governance mode then adjusts that decision based
 * on the desired level of human oversight.
 */
export function applyGovernanceMode(
  rawDecision: DecisionOutcome,
  rawTerminationReason: TerminationReason,
  mode: GovernanceMode,
): {
  decision: DecisionOutcome;
  terminationReason: TerminationReason;
  modeAdjusted: boolean;
  modeExplanation?: string;
} {
  switch (mode) {
    case "HIC":
      return applyHIC(rawDecision, rawTerminationReason);
    case "HITL":
      return applyHITL(rawDecision, rawTerminationReason);
    case "HOTL":
      return applyHOTL(rawDecision, rawTerminationReason);
  }
}

/**
 * HIC — Human In Control
 *
 * The strictest mode. Only explicit ALLOWs pass through.
 * Everything else becomes a BLOCK. No escalation — if there's doubt, block it.
 */
function applyHIC(
  rawDecision: DecisionOutcome,
  rawTerminationReason: TerminationReason,
): ReturnType<typeof applyGovernanceMode> {
  if (rawDecision === "ALLOW") {
    return {
      decision: "ALLOW",
      terminationReason: rawTerminationReason,
      modeAdjusted: false,
    };
  }

  if (rawDecision === "ALLOW_WITH_CONDITIONS") {
    // HIC doesn't trust conditional allows — escalate them
    return {
      decision: "ESCALATE",
      terminationReason: "MODE_OVERRIDE",
      modeAdjusted: true,
      modeExplanation:
        "HIC mode: conditional allows require human approval",
    };
  }

  if (rawDecision === "ESCALATE") {
    // HIC converts escalations to blocks — no waiting for humans
    return {
      decision: "BLOCK",
      terminationReason: "MODE_OVERRIDE",
      modeAdjusted: true,
      modeExplanation:
        "HIC mode: escalations are blocked (maximum safety)",
    };
  }

  // BLOCK stays BLOCK
  return {
    decision: "BLOCK",
    terminationReason: rawTerminationReason,
    modeAdjusted: false,
  };
}

/**
 * HITL — Human In The Loop
 *
 * The balanced mode. ALLOWs pass through, BLOCKs stay blocked,
 * and edge cases (ESCALATE, ALLOW_WITH_CONDITIONS) go to humans.
 * This is the default mode for most deployments.
 */
function applyHITL(
  rawDecision: DecisionOutcome,
  rawTerminationReason: TerminationReason,
): ReturnType<typeof applyGovernanceMode> {
  // HITL is the "natural" mode — raw decisions pass through mostly as-is
  if (rawDecision === "ALLOW") {
    return {
      decision: "ALLOW",
      terminationReason: rawTerminationReason,
      modeAdjusted: false,
    };
  }

  if (rawDecision === "BLOCK") {
    return {
      decision: "BLOCK",
      terminationReason: rawTerminationReason,
      modeAdjusted: false,
    };
  }

  if (rawDecision === "ESCALATE") {
    return {
      decision: "ESCALATE",
      terminationReason: rawTerminationReason,
      modeAdjusted: false,
    };
  }

  // ALLOW_WITH_CONDITIONS passes through in HITL
  return {
    decision: "ALLOW_WITH_CONDITIONS",
    terminationReason: rawTerminationReason,
    modeAdjusted: false,
  };
}

/**
 * HOTL — Human On The Loop
 *
 * The most permissive mode. Used for monitoring/observation.
 * Would-be escalations become ALLOW_WITH_CONDITIONS.
 * Only explicit BLOCKs from hard rules remain as blocks.
 * Everything else is allowed (but logged for review).
 */
function applyHOTL(
  rawDecision: DecisionOutcome,
  rawTerminationReason: TerminationReason,
): ReturnType<typeof applyGovernanceMode> {
  if (rawDecision === "ALLOW") {
    return {
      decision: "ALLOW",
      terminationReason: rawTerminationReason,
      modeAdjusted: false,
    };
  }

  if (
    rawDecision === "BLOCK" &&
    (rawTerminationReason === "RULE_BLOCK" ||
      rawTerminationReason === "DEFAULT_DENY")
  ) {
    // Hard rule blocks and allowlist-mode default-deny both stay as
    // blocks in HOTL. DEFAULT_DENY represents an explicit policy-level
    // choice ("agent can only do what I allowed"), which overrides the
    // pod-level HOTL "soften everything" intent.
    return {
      decision: "BLOCK",
      terminationReason: rawTerminationReason,
      modeAdjusted: false,
    };
  }

  if (rawDecision === "BLOCK") {
    // Threshold-based blocks become conditional allows in HOTL
    return {
      decision: "ALLOW_WITH_CONDITIONS",
      terminationReason: "MODE_OVERRIDE",
      modeAdjusted: true,
      modeExplanation:
        "HOTL mode: block converted to conditional allow for monitoring",
    };
  }

  if (rawDecision === "ESCALATE") {
    // Escalations become conditional allows in HOTL
    return {
      decision: "ALLOW_WITH_CONDITIONS",
      terminationReason: "MODE_OVERRIDE",
      modeAdjusted: true,
      modeExplanation:
        "HOTL mode: escalation converted to conditional allow for monitoring",
    };
  }

  // ALLOW_WITH_CONDITIONS stays as-is
  return {
    decision: "ALLOW_WITH_CONDITIONS",
    terminationReason: rawTerminationReason,
    modeAdjusted: false,
  };
}
