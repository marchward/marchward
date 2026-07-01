# What's open and what's commercial

Marchward is open-core. The engine and SDK are fully functional open source. The commercial product is the hosted control plane that an organization runs Marchward with at scale.

## Open source (Apache-2.0), self-hostable
- The **enforcement engine** (`@marchward/engine`): policy-based tool-call authorization (ALLOW / ESCALATE / BLOCK), risk classification by resolved action, and the approval-gate decision.
- The **local governor** (`@marchward/proxy`): wraps any MCP or HTTP agent, enforces policy on your own machine, and mediates credentials from your own local secret store. The agent holds only the Marchward key; the proxy injects the real credential, so the agent never holds it.
- The **tamper-evident audit primitive**: hash-chain append plus local verification, so the tamper-evident claim is something anyone can check.
- The **SDKs** (`marchward`, `@marchward/sdk`).

A solo developer can self-host this and govern their own agent: gate and block tool calls by policy, and keep a verifiable local audit log. It is complete and useful on its own.

> Two precisions, stated plainly:
> - The **inference cost cap** is enforced locally in the open proxy (single-process rolling-window accounting). The hosted plane adds cross-agent and cross-tenant aggregation, so a cap can span many agents and machines.
> - The **service-to-endpoint resolver** (the curated verified-connector catalog and server-side credential injection) is part of the hosted execute path. The open proxy governs MCP and HTTP calls directly and mediates from your own local store, so it does not need the managed resolver.

## Commercial (hosted control plane)
- **Enforced inference cost cap** across an agent or tenant.
- **Managed verified-connector catalog**: curated, tested service definitions with server-side resolve, inject, and execute.
- **Managed credential vault**: envelope-encrypted storage, rotation, team sharing, and audited access. (Credential mediation itself is open and self-hostable from your own local store; the managed vault is the hosted option.)
- **Audit-as-a-service**: retained, queryable, exportable, monitored audit chains.
- **Multi-tenancy** (row-level isolation), **SSO and RBAC**.
- **Approval and escalation workflows** with the hosted review UI.
- **Telemetry, digests, alerting**, and **managed operations with SLAs**.

The open engine and SDK give an individual developer a complete, self-hostable tool. The hosted plane adds what an organization needs to run it across a team: a managed vault, multi-tenancy, retained audit, workflows, and support.
