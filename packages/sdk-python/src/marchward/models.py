"""Typed result objects for Marchward decisions."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Outcome(str, Enum):
    """The governance outcome for a tool call."""

    ALLOW = "ALLOW"
    ALLOW_WITH_CONDITIONS = "ALLOW_WITH_CONDITIONS"
    ESCALATE = "ESCALATE"
    BLOCK = "BLOCK"


@dataclass
class Decision:
    """The result of a `marchward.execute()` call.

    The boolean helpers (`allowed` / `escalated` / `blocked`) are the
    ergonomic surface most agent code branches on; the raw fields are
    there when you need them.
    """

    outcome: Outcome
    decision_id: str | None = None
    review_id: str | None = None
    reason_codes: list[str] = field(default_factory=list)
    http_status: int = 0
    raw: dict[str, Any] = field(default_factory=dict)
    # ── Model-B async-execute fields ────────────────────────────────────
    # For ALLOW, the downstream runs asynchronously: `job_id` identifies the
    # async job; after the SDK polls it to completion, `execution` holds the
    # downstream result ({status, headers, body, durationMs}). On a failed
    # downstream (or unmet binding / poll timeout), `execution_error` is set.
    job_id: str | None = None
    execution: dict[str, Any] | None = None
    execution_error: str | None = None

    # ── Ergonomic branch helpers ───────────────────────────────────────
    @property
    def allowed(self) -> bool:
        return self.outcome in (Outcome.ALLOW, Outcome.ALLOW_WITH_CONDITIONS)

    @property
    def escalated(self) -> bool:
        return self.outcome == Outcome.ESCALATE

    @property
    def blocked(self) -> bool:
        return self.outcome == Outcome.BLOCK

    @property
    def executed(self) -> bool:
        """True only if the downstream actually ran (ALLOW + a completed
        execution with no error). An ALLOW with no connected credential, a
        failed downstream, or a still-pending job is NOT executed."""
        return self.allowed and self.execution is not None and self.execution_error is None

    def __str__(self) -> str:
        bits = [self.outcome.value]
        if self.review_id:
            bits.append(f"review={self.review_id}")
        if self.reason_codes:
            bits.append(f"reasons={','.join(self.reason_codes)}")
        return f"Decision({' '.join(bits)})"
