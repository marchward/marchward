"""
Govern a LangGraph agent's tool calls with Marchward.

The pattern: every tool your agent can call is routed through `marchward.execute()`,
which decides ALLOW / ESCALATE / BLOCK *before* the action runs, injects the real
credential server-side, and writes a tamper-evident audit record. Your agent only
ever holds a Marchward key, never the real GitHub/Stripe/DB credential.

Requirements:
  pip install marchward langchain-core
  export MARCHWARD_API_KEY=mw_...        # free at https://marchward.ai

Run:
  python langgraph_governed_agent.py
"""

import os
from marchward import MarchwardClient
from langchain_core.tools import tool

marchward = MarchwardClient()  # reads MARCHWARD_API_KEY from the environment


@tool
def delete_repo(owner: str, repo: str) -> str:
    """Delete a GitHub repository. Governed by Marchward before it runs."""
    d = marchward.execute(
        service="github",
        tool_name="github.repos.delete",
        arguments={"owner": owner, "repo": repo},
        context={"env": "production"},
    )
    if d.blocked:
        return f"Blocked by policy: {', '.join(d.reason_codes) or 'destructive action'}"
    if d.escalated:
        return f"Paused for human approval (review {d.review_id}); it runs on approve."
    if d.executed:
        return "Deleted. The real credential was injected server-side; the agent never held it."
    return f"Allowed but not executed ({d.outcome.value}) - connect a GitHub credential in the dashboard."


# Drop `delete_repo` into any LangGraph agent, e.g.:
#
#   from langgraph.prebuilt import create_react_agent
#   from langchain_openai import ChatOpenAI
#   agent = create_react_agent(ChatOpenAI(model="gpt-4o"), tools=[delete_repo])
#   agent.invoke({"messages": [("user", "delete the acme/old-experiment repo")]})
#
# Marchward gates the delete before it runs. Below we invoke the tool directly so
# you can see the governance decision without wiring up an LLM:

if __name__ == "__main__":
    if not os.environ.get("MARCHWARD_API_KEY"):
        raise SystemExit("Set MARCHWARD_API_KEY (free at https://marchward.ai) and rerun.")
    print(delete_repo.invoke({"owner": "acme", "repo": "old-experiment"}))
