import { existsSync } from "node:fs";
import type { AgentSessionRow, PmId } from "../../../shared/domain.ts";
import type { CapabilityKey, WorkerCapabilities } from "../../../shared/pm-capabilities.ts";
import type { ProjectCard } from "../../../shared/hub.ts";
import type { HubCallContext } from "../../../shared/ledger.ts";
import { workerWorktreePath } from "../../../shared/paths.ts";
import { UserBlockedError, userBlockerKindOf } from "../../../shared/user-blockers.ts";
import { AGENT_VENDORS, bundledModelCatalog, checkEffort, checkModel, checkModelEffort, effortsFor, isAgentVendor, normalizeEffortInput, splitModelEffort, type AgentVendor } from "../../../shared/vendors.ts";
import { workerBranchName } from "../../../shared/worker.ts";
import { writeWorkerCapabilities } from "../capability-rows.ts";
import { fail } from "../context.ts";
import type { Pending } from "../context.ts";
import { toConversation } from "../rows.ts";
import type { ConversationDbRow, ProjectDbRow, WorkerDbRow } from "../rows.ts";
import { hasGitCommitSync } from "../task-graph-handoff.ts";
import { workerRow } from "./ctx.ts";
import { enqueueFirstTurn, enqueueWorkerTask, insertLine, insertPmMessage } from "./lines.ts";
import { holdWorkerForSandboxIn } from "./sandbox.ts";
import { gitFailed, taskDedupeKey } from "./text.ts";
import { startMaxTime } from "./timers.ts";
import type { WorkersCtx } from "./types.ts";

export type WorkspaceProbe = { isRepoWithCommit: boolean; hasUncommittedChanges: boolean };

export type InheritedWorkspace = { branch: string; worktreePath: string; baseCommit: string };

export const reusableWorktree = (worker: WorkerDbRow, projectId: number): boolean =>
  worker.workspace === "worktree" &&
  worker.project_id === projectId &&
  worker.base_commit !== null &&
  worker.worktree_path !== null &&
  worker.worktree_path !== "" &&
  worker.branch !== null &&
  existsSync(worker.worktree_path);

export function probeWorkspaceForStep(
  w: WorkersCtx,
  projectId: number,
  mainFolder: string,
  context: HubCallContext | undefined,
  allowSyncFallback: boolean,
): WorkspaceProbe {
  if (context?.workspace !== undefined) {
    if (context.workspace.kind === "failed") throw gitFailed(context.workspace.error);
    return context.workspace;
  }
  if (!allowSyncFallback) {
    throw new Error("worker.start without noWorktree needs context.workspace (probe the main folder first)");
  }
  const hadWorktree =
    w.db.get("SELECT 1 AS x FROM workers WHERE project_id = ? AND workspace = 'worktree' AND base_commit IS NOT NULL LIMIT 1", projectId) !==
    undefined;
  return {
    isRepoWithCommit: hadWorktree || hasGitCommitSync(mainFolder),
    hasUncommittedChanges: false,
  };
}

export function checkTargetVendorUsable(w: WorkersCtx, vendor: AgentVendor): void {
  const kind = userBlockerKindOf(w.ctx.vendorAvailability(vendor));
  if (kind !== null) throw new UserBlockedError({ kind, vendor, device: w.ctx.deviceName() });
}

export const assertAgentVendor = (vendor: string): void => {
  if (!isAgentVendor(vendor)) throw fail("invalid", `厂商只能是 ${AGENT_VENDORS.join("、")}`);
};

type ModelEffort = { model: string | null; effort: string | null };
export function resolveWorkerModelEffort(w: WorkersCtx, input: {
  vendor: AgentVendor;
  model: string | null;
  effort: string | null | undefined;
  defaults: ModelEffort | null;
}) {
  const { vendor, model, effort, defaults } = input;
  const catalog = w.ctx.modelCatalog(vendor);
  const normalizedEffort = normalizeEffortInput(vendor, effort ?? null, catalog);
  const badSetting = checkModel(vendor, model) ?? checkEffort(vendor, normalizedEffort, catalog) ?? checkModelEffort(vendor, model, normalizedEffort, catalog);
  if (badSetting !== null) throw fail("invalid", badSetting);
  const overrides = splitModelEffort(vendor, model, normalizedEffort, catalog);
  const inherited = splitModelEffort(vendor, defaults?.model ?? null, defaults?.effort ?? null, catalog);
  const effectiveModel = overrides.model ?? inherited.model;
  const canInheritEffort = effort === undefined && effortsFor(catalog ?? bundledModelCatalog(vendor), effectiveModel).length !== 0;
  const effective = { model: effectiveModel, effort: overrides.effort ?? (canInheritEffort ? inherited.effort : null) };
  const problem = checkModelEffort(vendor, effective.model, effective.effort, catalog);
  if (problem !== null) throw fail("invalid", problem);
  return { overrides, effective };
}

export type NewWorkerRows = {
  pmId: PmId;
  project: ProjectDbRow;
  title: string;
  task: string;
  model: string | null;
  effort: string | null;
  readonly: boolean;
  capabilities: WorkerCapabilities;
  workspace: "worktree" | "main";
  inherit: InheritedWorkspace | null;
  review: boolean;
  reviewJson: string | null;
};

/** The id is needed to derive branch and directory, so insert a placeholder that satisfies the CHECK and update it right away. */
export function insertWorkerRowsIn(w: WorkersCtx, p: Pending, n: NewWorkerRows): WorkerDbRow {
  const t = w.now();
  const conversation = toConversation(
    w.db.get<ConversationDbRow>(
      "INSERT INTO conversations (kind, pm_id, project_id, title, created_at) VALUES ('worker', ?, ?, ?, ?) RETURNING *",
      n.pmId,
      n.project.id,
      n.title,
      t,
    )!,
  );
  p.changes.push({ type: "conversation.created", data: { conversation } });
  const id = w.db.run(
    `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, model, effort, readonly, workspace,
                          branch, worktree_path, base_commit, review_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    n.project.id,
    n.pmId,
    n.project.conversation_id,
    conversation.id,
    n.title,
    n.task,
    n.model,
    n.effort,
    n.readonly ? 1 : 0,
    n.workspace,
    n.inherit !== null ? n.inherit.branch : n.workspace === "worktree" ? "" : null,
    n.inherit !== null ? n.inherit.worktreePath : n.workspace === "worktree" ? "" : null,
    n.inherit !== null ? n.inherit.baseCommit : null,
    n.reviewJson,
    t,
    t,
  ).lastInsertRowid;
  writeWorkerCapabilities(w.db, { table: "worker_capabilities", workerId: id }, n.capabilities);
  if (n.workspace === "worktree" && n.inherit === null) {
    w.db.run(
      "UPDATE workers SET branch = ?, worktree_path = ? WHERE id = ?",
      n.review ? null : workerBranchName(id, n.title),
      workerWorktreePath(w.options.worktreesDir, n.project.id, id),
      id,
    );
  }
  return workerRow(w, id)!;
}

export function insertWorkerSessionIn(
  w: WorkersCtx,
  p: Pending,
  worker: WorkerDbRow,
  card: ProjectCard,
  agent: ModelEffort & { vendor: AgentVendor },
): AgentSessionRow {
  return w.sessions.insertSession(p, {
    role: "worker",
    conversationId: worker.worker_conversation_id,
    pmId: null,
    workerId: worker.id,
    cwd: worker.worktree_path ?? card.mainFolder,
    addDirs: worker.workspace === "worktree" ? [] : card.otherFolders,
    generation: 1,
    vendor: agent.vendor,
    model: agent.model,
    effort: agent.effort,
  });
}

export function kickOffWorkerIn(
  w: WorkersCtx,
  p: Pending,
  launch: {
    worker: WorkerDbRow;
    session: AgentSessionRow;
    project: ProjectDbRow;
    firstMessageText: string;
    inherited: boolean;
    maxTimeMs: number;
    sandbox?: { capabilities: readonly CapabilityKey[]; stepId: number | null };
    afterStartedLine?: () => void;
  },
): void {
  const { worker, session } = launch;
  insertPmMessage(w, p, worker, session, launch.firstMessageText, taskDedupeKey(worker.id));
  if (launch.sandbox !== undefined) {
    holdWorkerForSandboxIn(w, p, { worker, session, ...launch.sandbox, maxTimeMs: launch.maxTimeMs });
    launch.afterStartedLine?.();
    return;
  }
  insertLine(w, p, worker, { event: "started", status: null, summary: null, turnMessageId: null, deliver: null });
  launch.afterStartedLine?.();
  if (launch.inherited) {
    enqueueWorkerTask(w, p, worker);
  } else if (worker.workspace === "worktree") {
    w.enqueue(p, { type: "worktree.create", params: { workerId: worker.id } });
    w.projects.syncSessionFolders(launch.project);
  } else {
    enqueueFirstTurn(w, p, worker);
  }
  startMaxTime(w, worker, launch.maxTimeMs);
}
