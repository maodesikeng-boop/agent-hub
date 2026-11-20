import { normalizeWorkerTitle, type WorkerRecord } from "../../../shared/domain.ts";
import { splitModelEffort, type AgentVendor } from "../../../shared/vendors.ts";
import { WORKER_NEEDS_OS_SANDBOX_MESSAGE } from "../../driver/write-scope.ts";
import { fail } from "../context.ts";
import type { Pending } from "../context.ts";
import { toWorkerRecord } from "../rows.ts";
import type { TaskGraphWorkersBridge } from "../task-graphs.ts";
import {
  assertAgentVendor,
  checkTargetVendorUsable,
  checkedModelEffort,
  insertWorkerRowsIn,
  insertWorkerSessionIn,
  kickOffWorkerIn,
  probeWorkspaceForStep,
} from "./create.ts";
import { endOpenUpstreamIn } from "./lifecycle.ts";
import { newReviewJson, validMaxTimeMs, validTask } from "./text.ts";
import type { WorkersCtx } from "./types.ts";

export type DispatchStepInput = Parameters<TaskGraphWorkersBridge["dispatchStepWorkerIn"]>[1];

export function dispatchStepWorkerIn(w: WorkersCtx, p: Pending, input: DispatchStepInput): WorkerRecord {
  w.persona.assertPmNotArchived(input.pmId);
  const project = w.projects.activeProjectOf(input.pmId);
  if (project === null) {
    throw fail("invalid", `项目经理还没有项目，无法自动开工`);
  }
  const title = normalizeWorkerTitle(input.title);
  if (title === null) throw fail("invalid", "步骤标题不能为空或含控制字符");
  const task = validTask(input.task, "步骤任务说明");
  const maxTimeMs = validMaxTimeMs(input.maxTimeMs ?? undefined);

  const vendor: AgentVendor = input.vendor ?? input.pmVendor;
  assertAgentVendor(vendor);
  checkTargetVendorUsable(w, vendor);
  const { model, effort } = checkedModelEffort(w, vendor, input.model, input.effort);

  if (!w.ctx.osSandboxed()) throw fail("invalid", WORKER_NEEDS_OS_SANDBOX_MESSAGE);

  const card = w.projects.projectCard(project);
  const plan = input.workspacePlan;
  const inheritedPlan = plan.kind === "inherit" ? plan : null;
  endOpenUpstreamIn(w, p, plan);
  const probe =
    plan.kind === "inherit" || plan.kind === "review"
      ? { isRepoWithCommit: true, hasUncommittedChanges: false }
      : probeWorkspaceForStep(w, project.id, card.mainFolder, input.context, true);
  const workspace = probe.isRepoWithCommit ? "worktree" : "main";

  const worker = insertWorkerRowsIn(w, p, {
    pmId: input.pmId,
    project,
    title,
    task,
    model,
    effort,
    readonly: input.readonly,
    workspace,
    inherit: inheritedPlan,
    review: plan.kind === "review",
    reviewJson: newReviewJson(plan),
  });
  const inheritedSetting = vendor === input.pmVendor ? splitModelEffort(vendor, input.pmModel, input.pmEffort) : { model: null, effort: null };
  const session = insertWorkerSessionIn(w, p, worker, card, { vendor, model, effort }, inheritedSetting);

  const workerRecord = toWorkerRecord(worker);
  const firstMessageText = input.buildFirstMessage(session.id, inheritedPlan?.fromWorkerId ?? null, workerRecord, card);
  kickOffWorkerIn(w, p, { worker, session, project, firstMessageText, inherited: inheritedPlan !== null, maxTimeMs });
  return workerRecord;
}
