import { createAppApprovalBroker } from "../../app-approvals/broker.ts";
import { createAppApprovalStore } from "../app-approvals.ts";
import { enqueueSystemWakeupIn } from "../system-wakeups.ts";
import { workerRow, workerSession } from "./ctx.ts";
import type { WorkersCtx } from "./types.ts";

export function createWorkerAppApprovals(getWorkers: () => WorkersCtx, ctx: WorkersCtx["ctx"]) {
  let listener: ((id: number) => void) | undefined;
  const store = createAppApprovalStore({
    ctx,
    hasLiveRequests: (id) => broker.hasLiveRequests(id),
    onRowChangedIn: (p, id) => p.after.push(() => listener?.(id)),
    insertCardMessageIn(p, input) {
      const { sessions, messages } = getWorkers();
      const session = sessions.currentSession(input.conversationId);
      if (session === null) return null;
      return messages.insertAskMessage(p, session, input.text, undefined, { appApprovalRef: input.ref }).id;
    },
    settleCardMessageIn: (p, id, outcome) => getWorkers().messages.settleAskIn(p, id, outcome),
    notifyWorkerIn(p, workerId, text, approvalId) {
      const workers = getWorkers();
      const worker = workerRow(workers, workerId);
      if (worker === null || worker.status !== "open") return;
      enqueueSystemWakeupIn(ctx, p, workerSession(workers, worker), {
        conversationId: worker.worker_conversation_id, source: "app_approval", ref: String(approvalId), text,
      });
    },
  });
  const broker = createAppApprovalBroker({
    store,
    now: ctx.now,
    workerIdOf: ({ sessionId }) => ctx.db.get<{ workerId: number }>(
      "SELECT worker_id AS workerId FROM agent_sessions WHERE id = ? AND role = 'worker' AND worker_id IS NOT NULL", sessionId,
    )?.workerId ?? null,
    onRowChanged(next) {
      listener = next;
      return () => { listener = undefined; };
    },
  });
  return { store, broker };
}
