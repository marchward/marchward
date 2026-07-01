/**
 * Marchward MCP Server — Tool definitions
 *
 * Each tool maps to a Marchward API capability. These tools let
 * AI coding agents (Claude, Cursor, Copilot, etc.):
 *   1. Check governance before taking actions (marchward_authorize)
 *   2. Execute actions through Marchward's credential gateway (marchward_execute)
 *   3. Register and manage agents (marchward_register_agent, marchward_list_agents)
 *   4. Inspect decisions (marchward_get_decisions)
 *   5. Check governance coverage (marchward_check_coverage)
 *   6. Bind policies to agents (marchward_bind_policy)
 *
 * Tool names are marchward_* (stable as of v0.2.0). MCP clients discover
 * tools dynamically at runtime; the names are not dual-listed because
 * duplicate tools degrade agent tool-selection.
 */

import { z } from "zod";
import { MarchwardAPIClient } from "./api-client.js";

// ─── Tool Schemas ───────────────────────────────────────────────

export const TOOL_DEFINITIONS = {
  marchward_authorize: {
    name: "marchward_authorize",
    description:
      "Check whether an action is allowed BEFORE the agent takes it. Call this first for any consequential or irreversible action (deploying, committing, publishing, deleting, moving money, calling an external API). Returns ALLOW, BLOCK, ESCALATE, or ALLOW_WITH_CONDITIONS, and writes a tamper-evident audit record. The agent and policy are resolved from your API key, so you usually only pass toolName.",
    inputSchema: z.object({
      toolName: z
        .string()
        .describe(
          "Name of the tool/action being authorized (e.g. 'github_commit', 'railway_deploy', 'notion_update')",
        ),
      arguments: z
        .record(z.unknown())
        .optional()
        .describe("Arguments/parameters for the tool call"),
      policyBundleId: z
        .string()
        .optional()
        .describe("ID of the policy bundle to evaluate against (auto-resolved from API key → agent → policy if omitted)"),
      agentId: z
        .string()
        .optional()
        .describe("Agent ID (auto-resolved from API key if omitted)"),
      mode: z
        .enum(["HIC", "HITL", "HOTL"])
        .optional()
        .describe(
          "Governance mode: HIC (human-in-command), HITL (human-in-the-loop), HOTL (human-on-the-loop)",
        ),
      context: z
        .record(z.unknown())
        .optional()
        .describe("Additional context for policy evaluation"),
    }),
  },

  marchward_execute: {
    name: "marchward_execute",
    description:
      "Run an action through Marchward's credential-mediated gateway. Marchward evaluates policy, injects the real downstream credential server-side (the agent never holds it), enforces the cost cap and approval gates, then makes the call and records it. Use this for any call to a service whose credentials Marchward manages (GitHub, Stripe, Notion, etc.).",
    inputSchema: z.object({
      toolName: z
        .string()
        .describe("Name of the tool/action being executed"),
      arguments: z
        .record(z.unknown())
        .optional()
        .describe("Arguments for the tool call"),
      policyBundleId: z
        .string()
        .describe("Policy bundle ID to evaluate against"),
      agentId: z.string().describe("Agent ID making the request"),
      service: z
        .string()
        .describe(
          "Service name for credential injection (e.g. 'github', 'railway', 'notion')",
        ),
      downstream: z.object({
        url: z.string().describe("Full URL for the downstream API call"),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .describe("HTTP method"),
        headers: z
          .record(z.string())
          .optional()
          .describe("Additional headers"),
        body: z.unknown().optional().describe("Request body"),
      }),
      mode: z.enum(["HIC", "HITL", "HOTL"]).optional(),
    }),
  },

  marchward_register_agent: {
    name: "marchward_register_agent",
    description:
      "Register a new agent with Marchward so it is governed from its first action. Returns the agent record and its Marchward API key — the only credential the agent should hold. Call this when building or deploying a new agent.",
    inputSchema: z.object({
      name: z.string().describe("Human-readable name for the agent"),
      description: z
        .string()
        .optional()
        .describe("Description of what the agent does"),
      agentId: z
        .string()
        .optional()
        .describe(
          "Custom agent ID (auto-generated from name if omitted)",
        ),
    }),
  },

  marchward_list_agents: {
    name: "marchward_list_agents",
    description:
      "List the agents registered under your account, with their IDs, status, last-seen time, and bound policy. Use to find an agentId or check what is under governance.",
    inputSchema: z.object({}),
  },

  marchward_get_decisions: {
    name: "marchward_get_decisions",
    description:
      "Review recent governance decisions (the audit trail). Filter by agent, tool name, or outcome (ALLOW/BLOCK/ESCALATE). Use to verify governance is active or to investigate what an agent actually did.",
    inputSchema: z.object({
      agentId: z
        .string()
        .optional()
        .describe("Filter decisions by agent ID"),
      toolName: z
        .string()
        .optional()
        .describe("Filter decisions by tool name"),
      result: z
        .enum(["ALLOW", "BLOCK", "ESCALATE", "ALLOW_WITH_CONDITIONS"])
        .optional()
        .describe("Filter by decision outcome"),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Number of decisions to return (default 20)"),
    }),
  },

  marchward_check_coverage: {
    name: "marchward_check_coverage",
    description:
      "Find governance gaps for an agent by comparing its declared tools against the tools it has actually called. Returns a coverage percentage and the uncovered tools, so ungoverned actions surface before they cause harm. This is the 'Dependabot for governance'.",
    inputSchema: z.object({
      agentId: z.string().describe("Agent ID to check coverage for"),
    }),
  },

  marchward_bind_policy: {
    name: "marchward_bind_policy",
    description:
      "Attach a governance policy to an agent. After binding, every authorize and execute call from that agent is evaluated against this policy.",
    inputSchema: z.object({
      agentId: z.string().describe("Agent ID to bind the policy to"),
      policyBundleId: z.string().describe("Policy bundle ID to bind"),
    }),
  },
} as const;

// ─── Tool Handlers ──────────────────────────────────────────────

export function createToolHandlers(client: MarchwardAPIClient) {
  return {
    async marchward_authorize(args: z.infer<typeof TOOL_DEFINITIONS.marchward_authorize.inputSchema>) {
      const result = await client.authorize(args);
      const decision = (result as any).result ?? (result as any).decision ?? "UNKNOWN";
      const decisionId = (result as any).decisionId ?? "";
      const explanation = (result as any).explanation ?? [];

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                decision,
                decisionId,
                explanation,
                toolName: args.toolName,
                ...(args.policyBundleId ? { policyBundleId: args.policyBundleId } : {}),
                full: result,
              },
              null,
              2,
            ),
          },
        ],
      };
    },

    async marchward_execute(args: z.infer<typeof TOOL_DEFINITIONS.marchward_execute.inputSchema>) {
      const result = await client.execute(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },

    async marchward_register_agent(args: z.infer<typeof TOOL_DEFINITIONS.marchward_register_agent.inputSchema>) {
      const result = await client.createAgent(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Agent "${args.name}" registered successfully.`,
                ...result,
              },
              null,
              2,
            ),
          },
        ],
      };
    },

    async marchward_list_agents(_args: z.infer<typeof TOOL_DEFINITIONS.marchward_list_agents.inputSchema>) {
      const result = await client.listAgents();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },

    async marchward_get_decisions(args: z.infer<typeof TOOL_DEFINITIONS.marchward_get_decisions.inputSchema>) {
      const result = await client.listDecisions(args);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },

    async marchward_check_coverage(args: z.infer<typeof TOOL_DEFINITIONS.marchward_check_coverage.inputSchema>) {
      const result = await client.checkCoverage(args.agentId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },

    async marchward_bind_policy(args: z.infer<typeof TOOL_DEFINITIONS.marchward_bind_policy.inputSchema>) {
      const result = await client.bindPolicy(
        args.agentId,
        args.policyBundleId,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: `Policy "${args.policyBundleId}" bound to agent "${args.agentId}".`,
                ...result,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  };
}
