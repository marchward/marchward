// Marchward quickstart, run agent tool calls through the policy engine,
// locally, no account, no network. Shows ALLOW / ESCALATE / BLOCK and the
// tamper-evident audit chain.
//
//   cd examples && npm install && node quickstart.mjs

import { authorize, verifyChain, GENESIS_HASH } from "@marchward/engine";
import { randomUUID } from "node:crypto";

// A tiny policy: block big payments, pause destructive calls for a human,
// allow everything else.
const policy = {
  policyBundleId: "demo",
  version: "1.0.0",
  name: "Quickstart demo policy",
  defaultMode: "HITL",
  defaultAction: "ALLOW",
  thresholds: { confidenceMin: 0, riskBlock: 1, riskEscalate: 1 },
  roles: { allowedRoles: ["*"] },
  rules: [
    {
      ruleId: "block-big-payments",
      description: "Block payments over $1,000",
      tools: ["send_payment"],
      conditions: [{ field: "toolCall.arguments.amount", operator: "gt", value: 1000 }],
      action: "BLOCK",
      priority: 5,
      enabled: true,
    },
    {
      ruleId: "gate-destructive",
      description: "Destructive actions need human approval",
      tools: ["*"],
      conditions: [{ field: "toolCall.toolName", operator: "contains", value: "delete" }],
      action: "ESCALATE",
      priority: 10,
      enabled: true,
    },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const makeRequest = (toolName, args = {}) => ({
  requestId: randomUUID(),
  timestamp: new Date().toISOString(),
  toolCall: { toolName, arguments: args },
  agent: { agentId: "demo-agent" },
  context: { environment: "production" },
  signals: {},
  policyBundle: { id: policy.policyBundleId, version: policy.version },
  mode: "HITL",
});

const calls = [
  ["list_files", {}],
  ["delete_database", { name: "prod" }],
  ["send_payment", { amount: 5000, to: "acct_x" }],
];

console.log("\nMarchward engine, local policy decisions:\n");
let prevHash = GENESIS_HASH;
const records = [];
for (const [toolName, args] of calls) {
  const { response, record } = authorize(makeRequest(toolName, args), policy, {}, prevHash);
  console.log(`  ${response.result.padEnd(9)} ${toolName.padEnd(16)} ${response.explanation[0] ?? ""}`);
  records.push(record);
  prevHash = record.integrity.recordHash;
}

const view = records.map((r) => ({
  integrity: r.integrity,
  decisionId: r.decisionId,
  decision: r.outcome.decision,
  reasonCodes: r.outcome.reasonCodes,
  timestamp: r.timestamp,
}));
console.log(`\n  audit chain: ${verifyChain(view) === -1 ? "intact" : "BROKEN"}`);

// Pretend someone edits the log to hide the escalation:
view[1].decision = "ALLOW";
const broken = verifyChain(view);
console.log(`  tamper with record #2 -> ${broken !== -1 ? `detected at record ${broken}` : "NOT detected"}\n`);
