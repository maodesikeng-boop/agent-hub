import type { CapabilityInventory, SandboxApprovalRecord, WorkerCapabilities } from "../src/shared/index.ts";

export const COMPUTER_USE = "mcp:cua_repl";
export const COMPUTER_USE_CAPS: WorkerCapabilities = { mode: "custom", allow: [COMPUTER_USE] };
export const COMPUTER_USE_INVENTORY = {
  scannedAt: 1, truncated: false, groups: [],
  items: [{ key: COMPUTER_USE, kind: "mcp", name: "cua_repl", description: null, groupId: "plugin", vendors: ["codex"],
    plugins: { codex: "unified-computer-use@openai-bundled" } }],
} satisfies CapabilityInventory;

export const SANDBOX_APPROVAL: SandboxApprovalRecord = {
  id: 4, workerId: 5, workerTitle: "Inspect the desktop", pmId: 1, conversationId: 7, messageId: 8, stepId: null,
  vendor: "codex", model: null, workspace: "main", branch: null, capabilities: [COMPUTER_USE], taskSummary: "Inspect a Calculator window",
  status: "approved", decidedBy: "user", decisionClientId: "client", createdAt: 1, decidedAt: 2, revokedAt: null, updatedAt: 2,
};
