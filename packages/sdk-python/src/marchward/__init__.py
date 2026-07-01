"""
Marchward Python SDK — runtime authority for AI agents.

The wedge persona builds on LangGraph/LangChain (both Python), so this is
the primary, first-class SDK. Mirrors the `/v1/execute` contract and the
TypeScript SDK's `execute()` surface.

Quickstart
----------
    from marchward import MarchwardClient

    marchward = MarchwardClient(api_key="mw_...")  # or MARCHWARD_API_KEY env

    decision = marchward.execute(
        service="github",
        tool_name="github.repos.delete",
        arguments={"owner": "acme", "repo": "old"},
        context={"env": "production"},
    )

    if decision.allowed:
        ...  # safe to proceed
    elif decision.escalated:
        ...  # paused for human approval (decision.review_id)
    elif decision.blocked:
        ...  # refused by policy
"""

from .client import MarchwardClient
from .models import Decision, Outcome
from .errors import MarchwardError, MarchwardAuthError, MarchwardAPIError

__all__ = [
    "MarchwardClient",
    "Decision",
    "Outcome",
    "MarchwardError",
    "MarchwardAuthError",
    "MarchwardAPIError",
]


__version__ = "0.1.4"
