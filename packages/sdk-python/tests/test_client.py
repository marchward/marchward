"""
Unit tests for the Marchward Python SDK — no network.

Run:  cd packages/sdk-python && python -m pytest -q
  (or, zero-dep:  python -m unittest discover tests)
"""

import sys
import os
import json
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from marchward import MarchwardClient, Decision, Outcome  # noqa: E402
from marchward.errors import MarchwardAuthError  # noqa: E402


class TestParser(unittest.TestCase):
    def setUp(self):
        self.c = MarchwardClient(api_key="sk_test", api_url="https://example.com")

    def test_nested_allow(self):
        d = self.c._to_decision({"decision": {"outcome": "ALLOW", "id": "dec_1"}}, 200)
        self.assertTrue(d.allowed)
        self.assertFalse(d.escalated)
        self.assertEqual(d.decision_id, "dec_1")

    def test_nested_escalate_with_review(self):
        d = self.c._to_decision(
            {"decision": {"outcome": "ESCALATE", "reviewId": "rev_9", "reasonCodes": ["RULE_irreversible-escalate"]}},
            202,
        )
        self.assertTrue(d.escalated)
        self.assertEqual(d.review_id, "rev_9")
        self.assertIn("RULE_irreversible-escalate", d.reason_codes)

    def test_flat_block_shape(self):
        d = self.c._to_decision(
            {"decision": "BLOCK", "decisionId": "dec_2", "reasonCodes": ["RULE_block-irreversible-on-prod"]},
            403,
        )
        self.assertTrue(d.blocked)
        self.assertEqual(d.decision_id, "dec_2")

    def test_allow_with_conditions_counts_as_allowed(self):
        d = self.c._to_decision({"decision": {"outcome": "ALLOW_WITH_CONDITIONS"}}, 200)
        self.assertTrue(d.allowed)

    def test_unknown_outcome_falls_back_to_status(self):
        # Garbage body, but HTTP 403 → infer BLOCK (fail closed).
        d = self.c._to_decision({}, 403)
        self.assertTrue(d.blocked)
        d2 = self.c._to_decision({}, 202)
        self.assertTrue(d2.escalated)

    def test_outcome_enum(self):
        self.assertEqual(Outcome.ALLOW.value, "ALLOW")
        self.assertEqual(Outcome.ESCALATE.value, "ESCALATE")


class TestModelBExecute(unittest.TestCase):
    """Model-B execute: sends service+tool_name (no downstream), and for an
    async ALLOW polls the job to completion. `_send` is stubbed (no network)."""

    def setUp(self):
        self.c = MarchwardClient(api_key="mw_test", api_url="https://example.com")
        self.sent = []  # records (method, path, body) per _send call

    def _stub_send(self, responses):
        """Return a fake _send that yields the queued (payload, status)
        tuples in order, recording the request each time."""
        queue = list(responses)

        def fake_send(req):
            self.sent.append((req.method, req.full_url, getattr(req, "data", None)))
            return queue.pop(0)

        return fake_send

    def test_execute_sends_model_b_body_no_downstream(self):
        self.c._send = self._stub_send([({"decision": "BLOCK"}, 403)])
        self.c.execute(service="github", tool_name="github.repos.delete",
                       arguments={"owner": "a", "repo": "b"})
        _, url, data = self.sent[0]
        self.assertTrue(url.endswith("/v1/execute"))
        body = json.loads(data)
        self.assertEqual(body["service"], "github")
        self.assertEqual(body["toolCall"]["toolName"], "github.repos.delete")
        self.assertEqual(body["toolCall"]["arguments"], {"owner": "a", "repo": "b"})
        self.assertNotIn("downstream", body)  # Model B: server resolves it

    def test_block_returns_immediately_no_poll(self):
        self.c._send = self._stub_send([({"decision": "BLOCK", "decisionId": "d1"}, 403)])
        d = self.c.execute(service="github", tool_name="github.repos.delete",
                           arguments={"owner": "a", "repo": "b"})
        self.assertTrue(d.blocked)
        self.assertEqual(len(self.sent), 1)  # no job poll

    def test_escalate_returns_immediately_no_poll(self):
        self.c._send = self._stub_send([
            ({"decision": "ESCALATE", "reviewId": "rev_1", "status": "pending"}, 202),
        ])
        d = self.c.execute(service="github", tool_name="github.repos.delete",
                           arguments={"owner": "a", "repo": "b"})
        self.assertTrue(d.escalated)
        self.assertEqual(d.review_id, "rev_1")
        self.assertEqual(len(self.sent), 1)  # ESCALATE has no job

    def test_allow_polls_job_to_completion(self):
        # 202 ALLOW + jobId, then job poll: running → completed.
        self.c._send = self._stub_send([
            ({"jobId": "job_1", "status": "pending", "decision": "ALLOW"}, 202),
            ({"jobId": "job_1", "status": "running", "decision": "ALLOW"}, 202),
            ({"jobId": "job_1", "status": "completed", "decision": "ALLOW",
              "execution": {"status": 200, "body": {"ok": True}}}, 200),
        ])
        self.c.poll_interval = 0  # don't actually sleep in tests
        d = self.c.execute(service="github", tool_name="github.repos.get",
                           arguments={"owner": "a", "repo": "b"})
        self.assertTrue(d.allowed)
        self.assertTrue(d.executed)
        self.assertEqual(d.execution, {"status": 200, "body": {"ok": True}})
        self.assertEqual(d.job_id, "job_1")
        # execute POST + two job GETs that returned pending/running + final = 3?
        # (initial POST is sent[0]; polls are sent[1], sent[2], sent[3])
        self.assertEqual(self.sent[0][1], "https://example.com/v1/execute")
        self.assertTrue(all("/v1/jobs/job_1" in s[1] for s in self.sent[1:]))

    def test_allow_failed_downstream_sets_execution_error(self):
        self.c._send = self._stub_send([
            ({"jobId": "job_2", "status": "pending", "decision": "ALLOW"}, 202),
            ({"jobId": "job_2", "status": "failed", "decision": "ALLOW",
              "executionError": "downstream_error"}, 200),
        ])
        self.c.poll_interval = 0
        d = self.c.execute(service="github", tool_name="github.repos.get", arguments={"owner": "a", "repo": "b"})
        self.assertTrue(d.allowed)
        self.assertFalse(d.executed)  # ran the gate but the call failed
        self.assertEqual(d.execution_error, "downstream_error")

    def test_wait_false_returns_pending_without_polling(self):
        self.c._send = self._stub_send([
            ({"jobId": "job_3", "status": "pending", "decision": "ALLOW"}, 202),
        ])
        d = self.c.execute(service="github", tool_name="github.repos.get",
                           arguments={"owner": "a", "repo": "b"}, wait=False)
        self.assertEqual(d.job_id, "job_3")
        self.assertFalse(d.executed)  # not polled
        self.assertEqual(len(self.sent), 1)

    def test_unknown_tool_400_surfaces_on_decision_not_exception(self):
        # The resolver 400 (unknown_tool) comes back as a non-2xx; the SDK
        # surfaces it on the Decision (blocked via status fallback), not as
        # a raised exception.
        self.c._send = self._stub_send([
            ({"error": "unknown_tool", "message": "no such tool"}, 400),
        ])
        d = self.c.execute(service="github", tool_name="github.bogus", arguments={})
        self.assertEqual(d.http_status, 400)
        self.assertFalse(d.executed)

    def test_executed_property_false_for_allow_without_execution(self):
        from marchward import Decision, Outcome
        d = Decision(outcome=Outcome.ALLOW)
        self.assertTrue(d.allowed)
        self.assertFalse(d.executed)  # ALLOW but nothing ran (e.g. no credential)


class TestConfig(unittest.TestCase):
    def test_missing_key_raises(self):
        old = os.environ.pop("TENET_API_KEY", None)
        try:
            with self.assertRaises(MarchwardAuthError):
                MarchwardClient()
        finally:
            if old:
                os.environ["TENET_API_KEY"] = old

    def test_env_key_and_url(self):
        os.environ["TENET_API_KEY"] = "sk_env"
        os.environ["TENET_API_URL"] = "https://api.example.com/"
        try:
            c = MarchwardClient()
            self.assertEqual(c.api_key, "sk_env")
            self.assertEqual(c.api_url, "https://api.example.com")  # trailing slash stripped
        finally:
            os.environ.pop("TENET_API_KEY", None)
            os.environ.pop("TENET_API_URL", None)


if __name__ == "__main__":
    unittest.main()
