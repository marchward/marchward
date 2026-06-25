"""
MarchwardClient — the primary Python entry point.

Zero runtime dependencies (stdlib urllib) so it drops into any agent
environment without dependency conflicts. Speaks the Model-B contract:

    client.execute(service="github", tool_name="github.repos.delete",
                   arguments={"owner": "acme", "repo": "old"})

You send a logical tool call (service + tool_name + arguments); Marchward
resolves the real downstream HTTP request, governs it, injects the
credential server-side, executes it, and returns the result. The agent
never holds downstream credentials.

Response model (matches /v1/execute):
    403 BLOCK                 -> Decision(blocked)            [immediate]
    202 ESCALATE + reviewId   -> Decision(escalated)          [immediate]
    202 ALLOW  + jobId        -> poll GET /v1/jobs/:id until terminal,
                                 then Decision(allowed) with .execution set
    401                       -> MarchwardAuthError
    5xx / unknown_tool etc.   -> MarchwardAPIError / surfaced on the Decision

ALLOW is asynchronous server-side (Marchward fires the downstream in the
background and hands back a jobId). By default execute() polls that job to
completion so callers get the result synchronously; pass wait=False to get
the pending Decision back immediately and poll yourself.
"""

from __future__ import annotations

import json
import os
import time
import uuid
import urllib.request
import urllib.error
from typing import Any

from .models import Decision, Outcome
from .errors import MarchwardAuthError, MarchwardAPIError

# Identify as the Marchward SDK, not the stdlib default. urllib's default
# `Python-urllib/3.x` User-Agent is fingerprinted and BANNED by Cloudflare's
# browser-integrity check (returns "error code: 1010" — the request never
# reaches the API). A normal product UA passes. This matters for real
# customers too: agent SDKs on stdlib HTTP must not look like a bot.
_USER_AGENT = "marchward-python-sdk/0.1"
_DEFAULT_API_URL = "https://api.marchward.ai"
_DEFAULT_TIMEOUT = 30.0
_DEFAULT_POLL_TIMEOUT = 120.0
_DEFAULT_POLL_INTERVAL = 0.75


class MarchwardClient:
    """Client for the Marchward runtime-authority API.

    Args:
        api_key: Your Marchward API key (``mw_...``). Falls back to the
            ``MARCHWARD_API_KEY`` env var.
        api_url: API base URL. Falls back to ``TENET_API_URL`` env var,
            then the production default.
        default_agent_id: Agent identity attached to every call. Defaults
            to ``"default"`` — the agent every tenant auto-provisions and
            that the dashboard binds connected services to. Override only
            if you created a differently-named agent and bound your
            credentials to it (otherwise credential resolution won't find
            a binding and calls return 403 credential_not_found).
        timeout: Per-request timeout in seconds.
        poll_timeout: Max seconds to wait for an async ALLOW job to finish.
        poll_interval: Seconds between job polls.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        api_url: str | None = None,
        default_agent_id: str = "default",
        timeout: float = _DEFAULT_TIMEOUT,
        poll_timeout: float = _DEFAULT_POLL_TIMEOUT,
        poll_interval: float = _DEFAULT_POLL_INTERVAL,
    ) -> None:
        self.api_key = api_key or (os.environ.get("MARCHWARD_API_KEY") or os.environ.get("TENET_API_KEY"))
        if not self.api_key:
            raise MarchwardAuthError(
                "No API key. Pass api_key=... or set the MARCHWARD_API_KEY (or legacy TENET_API_KEY) env var."
            )
        self.api_url = (api_url or (os.environ.get("MARCHWARD_API_URL") or os.environ.get("TENET_API_URL")) or _DEFAULT_API_URL).rstrip("/")
        self.default_agent_id = default_agent_id
        self.timeout = timeout
        self.poll_timeout = poll_timeout
        self.poll_interval = poll_interval

    # ──────────────────────────────────────────────────────────────────
    def execute(
        self,
        *,
        service: str,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
        agent_id: str | None = None,
        request_id: str | None = None,
        wait: bool = True,
    ) -> Decision:
        """Authorize + execute a tool call through Marchward (Model B).

        Sends `service` + `tool_name` + `arguments`; Marchward resolves the
        downstream call from its tool catalog. Returns a :class:`Decision`.
        Never raises on a normal governance outcome (ALLOW/ESCALATE/BLOCK)
        — only on auth/transport errors.

        When the outcome is ALLOW, the downstream runs asynchronously
        server-side. With ``wait=True`` (default) this polls the job to
        completion and attaches the result to ``decision.execution``. With
        ``wait=False`` you get the pending Decision immediately (poll the
        job yourself via ``get_job(decision.job_id)``).
        """
        rid = request_id or str(uuid.uuid4())
        body = json.dumps(
            {
                "requestId": rid,
                "service": service,
                "toolCall": {"toolName": tool_name, "arguments": arguments or {}},
                "agent": {"agentId": agent_id or self.default_agent_id},
                "context": context or {},
            }
        ).encode()

        payload, status = self._post("/v1/execute", body, idempotency_key=rid)
        decision = self._to_decision(payload, status)

        # ALLOW arrives as 202 + jobId (async downstream). Poll unless the
        # caller opted out. ESCALATE/BLOCK are terminal and have no job.
        job_id = payload.get("jobId") if isinstance(payload, dict) else None
        decision.job_id = job_id if isinstance(job_id, str) else None
        if wait and decision.job_id and status == 202 and decision.allowed:
            return self._await_job(decision)

        return decision

    # ──────────────────────────────────────────────────────────────────
    def get_job(self, job_id: str) -> dict[str, Any]:
        """Poll a single async job once. Returns the raw job payload
        (`status` is one of pending / running / completed / failed)."""
        payload, _ = self._get(f"/v1/jobs/{job_id}")
        return payload if isinstance(payload, dict) else {}

    # ── Internals ──────────────────────────────────────────────────────
    def _await_job(self, decision: Decision) -> Decision:
        """Poll GET /v1/jobs/:id until the downstream call terminates,
        then fold the result into the Decision."""
        assert decision.job_id is not None
        deadline = time.monotonic() + self.poll_timeout
        while True:
            payload, status = self._get(f"/v1/jobs/{decision.job_id}")
            job_status = payload.get("status") if isinstance(payload, dict) else None

            if job_status in ("completed", "failed"):
                decision.http_status = status
                decision.raw = payload
                if job_status == "completed":
                    decision.execution = payload.get("execution")
                else:
                    decision.execution_error = payload.get("executionError") or "downstream_failed"
                return decision

            if time.monotonic() >= deadline:
                decision.execution_error = "poll_timeout"
                return decision

            time.sleep(self.poll_interval)

    def _post(self, path: str, body: bytes, *, idempotency_key: str | None = None):
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": _USER_AGENT,
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        req = urllib.request.Request(f"{self.api_url}{path}", data=body, headers=headers, method="POST")
        return self._send(req)

    def _get(self, path: str):
        req = urllib.request.Request(
            f"{self.api_url}{path}",
            headers={"Authorization": f"Bearer {self.api_key}", "User-Agent": _USER_AGENT},
            method="GET",
        )
        return self._send(req)

    def _send(self, req: urllib.request.Request):
        _debug = (os.environ.get("MARCHWARD_DEBUG") or os.environ.get("TENET_DEBUG"))
        if _debug:
            body_preview = (req.data or b"").decode("utf-8", "replace")[:300]
            print(f"[marchward] → {req.method} {req.full_url}")
            print(f"[marchward]   headers: { {k: ('***' if k.lower()=='authorization' else v) for k,v in req.headers.items()} }")
            print(f"[marchward]   body: {body_preview}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = json.loads(resp.read() or b"{}")
                if _debug:
                    print(f"[marchward] ← {resp.status} {json.dumps(payload)[:400]}")
                return payload, resp.status
        except urllib.error.HTTPError as e:
            raw = e.read() or b"{}"
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {}
            status = e.code
            if _debug:
                print(f"[marchward] ← {status} (raw: {raw.decode('utf-8','replace')[:400]})")
            if status == 401:
                raise MarchwardAuthError("Marchward rejected the API key (401).") from e
            if status >= 500:
                raise MarchwardAPIError(
                    f"Marchward API error ({status}).", status=status, body=raw.decode("utf-8", "replace")
                ) from e
            # 4xx governance outcomes (403 BLOCK) + resolver 4xx (400
            # unknown_tool etc.) arrive here as HTTPError; fall through so
            # the caller sees them on the Decision rather than as an
            # exception.
            return payload, status
        except urllib.error.URLError as e:
            raise MarchwardAPIError(f"Could not reach Marchward at {self.api_url}: {e}") from e

    # ──────────────────────────────────────────────────────────────────
    @staticmethod
    def _to_decision(payload: dict[str, Any], status: int) -> Decision:
        # The API returns the outcome either at the top level (`decision`
        # string + `decisionId`) or nested under `decision`; handle both.
        decision_obj = payload.get("decision")
        if isinstance(decision_obj, dict):
            outcome_str = decision_obj.get("outcome") or decision_obj.get("decision")
            decision_id = decision_obj.get("decisionId") or decision_obj.get("id")
            review_id = decision_obj.get("reviewId")
            reasons = decision_obj.get("reasonCodes") or decision_obj.get("reason_codes") or []
        else:
            outcome_str = decision_obj if isinstance(decision_obj, str) else payload.get("outcome")
            decision_id = payload.get("decisionId")
            review_id = payload.get("reviewId")
            reasons = payload.get("reasonCodes") or payload.get("reason_codes") or []

        try:
            outcome = Outcome(outcome_str)
        except (ValueError, TypeError):
            # No recognizable outcome — infer from HTTP status as a fallback.
            outcome = {200: Outcome.ALLOW, 202: Outcome.ESCALATE, 403: Outcome.BLOCK}.get(
                status, Outcome.BLOCK
            )

        return Decision(
            outcome=outcome,
            decision_id=decision_id,
            review_id=review_id,
            reason_codes=list(reasons),
            http_status=status,
            raw=payload,
            execution_error=(
                payload.get("executionError") if isinstance(payload, dict) else None
            ),
        )
