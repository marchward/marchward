# Marchward Python SDK

Runtime authority for AI agents. Gate every tool call through a cost cap,
approval gates on irreversible actions, and a tamper-evident audit log.

Zero runtime dependencies (stdlib only), so it drops into any agent environment.

## Install
```bash
pip install marchward
```

## Quickstart
```python
from marchward import MarchwardClient

marchward = MarchwardClient(api_key="mw_...")   # or set MARCHWARD_API_KEY

decision = marchward.execute(
    service="github",
    tool_name="github.repos.delete",
    arguments={"owner": "acme", "repo": "old-experiment"},
    context={"env": "production"},
)

if decision.allowed:
    do_the_delete()
elif decision.escalated:
    print(f"Paused for approval, review {decision.review_id}")
elif decision.blocked:
    print(f"Blocked: {decision.reason_codes}")
```

## With LangGraph or LangChain
```python
from langchain_core.tools import tool
from marchward import MarchwardClient

marchward = MarchwardClient()

@tool
def delete_repo(owner: str, repo: str) -> str:
    """Delete a GitHub repository."""
    d = marchward.execute(service="github", tool_name="github.repos.delete",
                          arguments={"owner": owner, "repo": repo})
    if not d.allowed:
        return f"Refused by Marchward ({d.outcome.value})."
    # ... real delete here ...
    return "deleted"
```

## How it works
You send a logical tool call: `service` plus `tool_name` plus `arguments`. Marchward
resolves the real downstream HTTP request from its tool catalog, governs it,
injects your stored credential server-side, and executes it. Your agent holds
only `MARCHWARD_API_KEY` and never touches downstream credentials. Connect those
once in the dashboard (Settings, Connected services).

## API
- `MarchwardClient(api_key=None, *, api_url=None, default_agent_id="python-sdk", timeout=30.0, poll_timeout=120.0, poll_interval=0.75)`
- `.execute(*, service, tool_name, arguments=None, context=None, agent_id=None, request_id=None, wait=True) -> Decision`
- `.get_job(job_id) -> dict`: poll one async job manually (for `wait=False`).
- `Decision`: `.allowed` / `.escalated` / `.blocked` / `.executed`, plus `.outcome`,
  `.decision_id`, `.review_id`, `.reason_codes`, `.http_status`, `.raw`,
  `.job_id`, `.execution`, `.execution_error`.

## Contract
| HTTP | Outcome | Meaning |
|---|---|---|
| 200/202 + jobId | ALLOW | authorized; downstream runs async, the SDK polls the job and fills `.execution` (set `wait=False` to poll yourself) |
| 202 + reviewId | ESCALATE | held for human approval; auto-executes on approve |
| 403 | BLOCK | refused by policy |
| 401 | (auth error) | `MarchwardAuthError` (bad, missing, or revoked key) |

`.executed` is `True` only when an ALLOW actually ran its downstream. An
ALLOW with no connected credential, a failed downstream, or a still-pending
job is allowed but not executed.

## Risk classification
Risk is classified by the **resolved HTTP method**, not the tool name. Any
`DELETE` (or a flagged destructive `POST` like `stripe.charges.create`) is
treated as irreversible and gated, regardless of what the tool is named, so a
custom-named destructive tool cannot slip past the approval gate.

## Tests
```bash
cd packages/sdk-python && python -m unittest discover -s tests
```
