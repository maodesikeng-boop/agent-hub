import type { AgentSessionRow, PmId } from "../../../shared/domain.ts";
import { DEFAULT_WORKER_MAX_TIME_MS } from "../../../shared/limits.ts";
import type { CapabilityInventory, CapabilityKey, WorkerCapabilities } from "../../../shared/pm-capabilities.ts";
import { formatSandboxApprovalRejectedNotice, validateNoOuterSandboxRequest } from "../../../shared/sandbox-approval.ts";
import { isAgentVendor, type AgentVendor } from "../../../shared/vendors.ts";
import { readWorkerCapabilities } from "../capability-rows.ts";
import { fail, type Pending } from "../context.ts";
import { readPmCapabilityPolicy } from "../pm-capabilities.ts";
import type { WorkerDbRow } from "../rows.ts";
import { createSandboxApprovalStore } from "../sandbox-approvals.ts";
import { projectRow, workerRow } from "./ctx.ts";
import { enqueueFirstTurn, enqueueWorkerTask, insertLine } from "./lines.ts";
import { endWorkerIn } from "./lifecycle.ts";
import { notStarted } from "./text.ts";
import { startMaxTime } from "./timers.ts";
import type { WorkersCtx } from "./types.ts";

export function checkSandboxRequest(w: WorkersCtx, pmId: PmId, input: {
  vendor: AgentVendor; readonly: boolean; review: boolean; capabilities: WorkerCapabilities; inventory?: CapabilityInventory;
}) {
  return validateNoOuterSandboxRequest({
    vendor: input.vendor,
    platform: w.options.platform ?? process.platform,
    readonly: input.readonly,
    review: input.review,
    workerCapabilities: input.capabilities,
    pmPolicy: readPmCapabilityPolicy(w.db, pmId),
    inventory: input.inventory,
  });
}

export function requireSandboxRequest(w: WorkersCtx, pmId: PmId, input: Parameters<typeof checkSandboxRequest>[2]): readonly CapabilityKey[] {
  const result = checkSandboxRequest(w, pmId, input);
  if (!result.ok) throw fail("invalid", result.message);
  return result.matchedCapabilities;
}

export function holdWorkerForSandboxIn(w: WorkersCtx, p: Pending, input: {
  worker: WorkerDbRow;
  session: AgentSessionRow;
  capabilities: readonly CapabilityKey[];
  stepId: number | null;
  maxTimeMs: number;
}): void {
  const { worker, session, capabilities, stepId, maxTimeMs } = input;
  if (!isAgentVendor(session.vendor)) throw fail("invalid", "未知的 Worker 厂商");
  w.sandboxApprovals.createPendingIn(p, {
    workerId: worker.id, workerTitle: worker.title, pmId: worker.pm_id, conversationId: worker.pm_conversation_id,
    stepId, vendor: session.vendor, model: session.model, workspace: worker.workspace === "worktree" ? "worktree" : "main", branch: worker.branch,
    capabilities, taskSummary: worker.task, maxTimeMs,
  });
}

export function createWorkerSandboxApprovals(getWorkers: () => WorkersCtx, ctx: WorkersCtx["ctx"]) {
  return createSandboxApprovalStore({
    ctx,
    insertCardMessageIn(p, input) {
      const w = getWorkers();
      const session = w.sessions.currentSession(input.conversationId);
      if (session === null) return null;
      return w.messages.insertAskMessage(p, session, input.text, undefined, {
        sandboxApprovalRef: { approvalId: input.approvalId, workerId: input.workerId },
      }).id;
    },
    settleCardMessageIn: (p, id, outcome) => getWorkers().messages.settleAskIn(p, id, outcome),
    recheckEligible(approval) {
      const w = getWorkers();
      const worker = workerRow(w, approval.workerId);
      if (worker === null) return { ok: false, message: "找不到 Worker" };
      return checkSandboxRequest(w, approval.pmId, {
        vendor: approval.vendor,
        readonly: worker.readonly === 1,
        review: worker.review_json !== null,
        capabilities: readWorkerCapabilities(w.db, { table: "worker_capabilities", workerId: worker.id }),
      });
    },
    onApprovedIn(p, approval) {
      const w = getWorkers();
      const worker = workerRow(w, approval.workerId)!;
      insertLine(w, p, worker, { event: "started", status: null, summary: null, turnMessageId: null, deliver: null });
      w.options.taskGraphs?.onWorkerResumedIn(p, worker.id);
      if (notStarted(worker)) {
        w.enqueue(p, { type: "worktree.create", params: { workerId: worker.id } });
        w.projects.syncSessionFolders(projectRow(w, worker.project_id));
      } else if (worker.workspace === "worktree") {
        enqueueWorkerTask(w, p, worker);
      } else {
        enqueueFirstTurn(w, p, worker);
      }
      const max = w.db.get<{ max_time_ms: number }>("SELECT max_time_ms FROM worker_sandbox_approvals WHERE id = ?", approval.id);
      startMaxTime(w, worker, max?.max_time_ms ?? DEFAULT_WORKER_MAX_TIME_MS);
    },
    onRejectedIn(p, approval) {
      const w = getWorkers();
      const worker = workerRow(w, approval.workerId)!;
      endWorkerIn(w, p, worker, { deliver: formatSandboxApprovalRejectedNotice(approval) });
    },
  });
}
