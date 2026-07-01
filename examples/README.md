# Marchward examples

Runnable, zero-setup demos of the open engine.

## quickstart.mjs: govern an agent in 30 seconds (no account, no network)

Runs three agent tool calls through a local policy and prints the decisions,
then shows the tamper-evident audit chain catching an edit.

```bash
cd examples
npm install
node quickstart.mjs
```

Expected output: a safe call is **ALLOW**ed, a `delete_database` call is
**ESCALATE**d for human approval, an over-budget `send_payment` is **BLOCK**ed,
the audit chain verifies intact, and a tampered record is detected.

This uses only `@marchward/engine` (the deterministic decision engine + hash-chain
audit). To put Marchward in front of a real MCP server or HTTP agent, see
`@marchward/proxy` in the root README.

## langgraph_governed_agent.py: wire Marchward into a LangGraph agent

The integration pattern for the LangGraph/LangChain crowd: a tool routed through
`marchward.execute()` so a destructive call is gated (allow / escalate / block)
before it runs, with the real credential injected server-side.

```bash
pip install marchward langchain-core
export MARCHWARD_API_KEY=mw_...     # free at https://marchward.ai
python langgraph_governed_agent.py
```
