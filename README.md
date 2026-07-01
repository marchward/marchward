<p align="center"><strong>Marchward</strong> · runtime authority for AI agents</p>

# Marchward

**Govern what your AI agents are allowed to _do_.** Marchward is one open layer that sits in front of an agent's tool calls and enforces four controls before any action runs, then writes a tamper-evident record of every decision. Self-hostable, Apache-2.0, framework-agnostic.

- **Credential mediation.** The agent holds one Marchward key, never your real GitHub, Stripe, or database credentials. The real secret is injected at execution, and the agent never sees it.
- **Inference spend cap.** A hard ceiling on agent spend, so a runaway loop can't drain a budget.
- **Approval gates.** Irreversible actions pause for a human instead of running unattended.
- **Tamper-evident audit.** Every decision appends to a hash-chained log you can verify offline. Provable, not just logged.

Most tools in this space cover one of these. Marchward brings all four together in one place, open and self-hostable.

> Output guardrails check what an agent _says_ (toxicity, PII, topic). Marchward governs what an agent _does_ (spend, delete, act). A check on the agent's output cannot stop an agent that still holds the keys and can make a different call. Marchward governs the action itself.

Built for teams already running agents in production (LangGraph, LangChain, raw SDKs, any MCP server, or one HTTP call from any runtime) who need an agent to be autonomous without being able to drain a budget, take an irreversible action unattended, or act without an audit trail.

## Quickstart: govern an agent in 60 seconds (fully local, no account)

`marchward-proxy` wraps any MCP server as a child process and evaluates every `tools/call` against your policy before it runs (block, allow, or pause for human approval), entirely on your machine, with your own credentials.

```bash
# Write a policy (escalate anything destructive, allow the rest)
cat > policy.json <<'EOF'
{ "rules": [
  { "match": { "toolPattern": "*delete*" }, "decision": "ESCALATE" },
  { "match": { "toolPattern": "*" },        "decision": "ALLOW"   }
]}
EOF

# Put Marchward in front of your agent's MCP server, local mode, no API
npx -p @marchward/proxy marchward-proxy \
  --command "node my-mcp-server.js" \
  --policy-file ./policy.json \
  --local
```

Every tool call your agent makes now passes through policy first, and lands in a local tamper-evident (hash-chained) audit log you can verify offline. No account, no network call to us.

Prefer the SDK? `pip install marchward` and wrap calls with `marchward.execute()`. Point it at your own self-hosted setup, or at the managed plane (below).

## What's open vs. what's hosted

The open packages in this repo are a **fully functional self-host governor**. Some operational features need shared state and run on the hosted plane (free tier, no card):

| | Open (self-host, this repo) | Hosted plane (Marchward Cloud) |
|---|---|---|
| Execution control: allow / block / **escalate** tool calls by policy | yes | yes |
| Local governor (MCP/HTTP intercept, your own credentials) | yes | yes |
| **Tamper-evident audit**: hash-chain primitive + offline verify | yes | retained, queryable, monitored |
| Approval-gate **decision** | yes | + managed **workflow** (notify, approve, resume) |
| **Inference cost cap** | local accounting | enforced (rolling-window spend) |
| **Credential mediation** (agent holds one key, real cred injected, the agent never sees it) | yes, from your own local secret store | yes, managed vault |
| Managed credential vault, multi-tenancy, SSO/RBAC | no | yes |

So: **self-host this** for execution control, credential mediation from your own local store, a local cost cap, and a local audit log; **add the free hosted tier** for the managed credential vault (rotation, team sharing), approval workflows, retained audit-as-a-service, and cross-agent enforcement. Same engine underneath. The proxy's `--remote` mode just points at the plane.

## How it works

1. Your agent makes a tool call (MCP, HTTP, or via the SDK).
2. Marchward evaluates it against your policy. Risk is judged by the **resolved action**: any destructive operation (a `DELETE`, a flagged destructive `POST`) is gated regardless of what the tool is _named_, so a custom-named destructive tool cannot slip past.
3. The decision, **ALLOW / ESCALATE / BLOCK**, is enforced before the call runs and appended to a hash-chained audit log.
4. Credential mediation means your agent holds only a Marchward key. The proxy injects the real service credential (from your own local store when self-hosted, or the managed vault on the hosted plane), so a rogue "different tool call" cannot misuse a credential the agent never held.

## Packages
- **`@marchward/engine`**: the deterministic decision engine + hash-chain audit primitive (zero dependencies).
- **`@marchward/proxy`**: the local governor (MCP + HTTP), `--local` or `--remote`.
- **`@marchward/sdk`** (TypeScript) and **`marchward`** (Python, on PyPI): clients.

## Project
- **Contributing:** [`CONTRIBUTING.md`](./CONTRIBUTING.md) (DCO sign-off, `git commit -s`)
- **Security:** [`SECURITY.md`](./SECURITY.md) · **Conduct:** [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) · **Governance:** [`GOVERNANCE.md`](./GOVERNANCE.md)
- **Trademark:** [`TRADEMARK.md`](./TRADEMARK.md). The code is open (Apache-2.0); the name is not.
- **What's open vs. commercial:** [`OPEN-VS-COMMERCIAL.md`](./OPEN-VS-COMMERCIAL.md) · our [licensing commitment](./LICENSING-COMMITMENT.md) (the engine stays open, no relicensing rug-pull).
- **License:** Apache-2.0.
- **Hosted free tier:** https://app.marchward.ai/signup (500 decisions/mo, no card).
