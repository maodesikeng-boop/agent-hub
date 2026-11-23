import { normalizeWorkerTitle, utf8Bytes } from "../../../shared/domain.ts";
import type { AgentSessionRow, WorkerId } from "../../../shared/domain.ts";
import type { HubArgs, HubResult, ProjectCard } from "../../../shared/hub.ts";
import type { HubCallContext } from "../../../shared/ledger.ts";
import { MAX_TASK_BYTES, TAKEOVER_PREDECESSORS_MAX } from "../../../shared/limits.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { splitModelEffort, type AgentVendor } from "../../../shared/vendors.ts";
import { SETUP_RECEIPT_NOTE, WORKER_READONLY_NOTE, buildWorkerFirstMessage } from "../../prompt.ts";
import { WORKER_NEEDS_OS_SANDBOX_MESSAGE } from "../../driver/write-scope.ts";
import {
  INHERIT_WORKER_CAPABILITIES,
  blockedWorkerCapabilities,
  workerCapabilitiesOf,
  type CapabilityPolicy,
  type WorkerCapabilities,
} from "../../../shared/pm-capabilities.ts";
import { fail } from "../context.ts";
import type { Pending } from "../context.ts";
import { readPmCapabilityPolicy } from "../pm-capabilities.ts";
import { toWorkerRecord } from "../rows.ts";
import type { ProjectDbRow, WorkerDbRow } from "../rows.ts";
import { renderGraphStepTask } from "../task-graph-handoff.ts";
import type { StepWorkspacePlan, WorkerBindTarget } from "../task-graphs.ts";
import { newestFirst } from "../takeover.ts";
import type { TakeoverPredecessor } from "../takeover.ts";
import { workerRow, workerSession } from "./ctx.ts";
import {
  assertAgentVendor,
  checkTargetVendorUsable,
  checkedModelEffort,
  insertWorkerRowsIn,
  insertWorkerSessionIn,
  kickOffWorkerIn,
  probeWorkspaceForStep,
  reusableWorktree,
  type InheritedWorkspace,
  type WorkspaceProbe,
} from "./create.ts";
import { endOpenUpstreamIn, endWorkerIn, type EndedWorker } from "./lifecycle.ts";
import { isWorkerInFlight } from "./lines.ts";
import { WORKTREE_DIRTY_NOTE, describeWorkspace, newReviewJson, notStarted, validMaxTimeMs, validTask } from "./text.ts";
import type { PmCaller, WorkersCtx } from "./types.ts";

type StartArgs = HubArgs<"worker.start">;
type Takeover = ReturnType<typeof planTakeover>;
type ReviewPlan = Extract<StepWorkspacePlan, { kind: "review" }>;
type UpstreamInherit = Extract<StepWorkspacePlan, { kind: "inherit" }>;
type StartTask = { title: string; task: string; pmNote: string | null; stepHasBrief: boolean };
type StartAgent = { vendor: AgentVendor; model: string | null; effort: string | null; readonly: boolean; capabilities: WorkerCapabilities };
type StartWorkspace = {
  reviewPlan: ReviewPlan | null;
  inherit: WorkerDbRow | null;
  upstreamInherit: UpstreamInherit | null;
  effectiveInherit: (InheritedWorkspace & { fromWorkerId: WorkerId }) | null;
  probe: WorkspaceProbe;
  workspace: "worktree" | "main";
};

function planTakeover(w: WorkersCtx, target: WorkerBindTarget, projectId: number, noWorktree: boolean) {
  const allNewestFirst = newestFirst(target.workerIds, target.workerIds.length)
    .map((id) => workerRow(w, id))
    .filter((x): x is WorkerDbRow => x !== null);
  const predecessors = allNewestFirst.slice(0, TAKEOVER_PREDECESSORS_MAX);
  const inherit = noWorktree ? null : (allNewestFirst.find((x) => reusableWorktree(x, projectId)) ?? null);
  const first = allNewestFirst.at(-1) ?? null;
  const openById = new Map<WorkerId, WorkerDbRow>();
  if (target.activeWorkerId !== null) {
    const active = workerRow(w, target.activeWorkerId);
    if (active !== null && active.status === "open") openById.set(active.id, active);
  }
  for (const x of allNewestFirst) {
    if (x.status === "open") openById.set(x.id, x);
  }
  return { predecessors, inherit, originalTask: first?.task ?? null, openOld: [...openById.values()] };
}

const graphStepTask = (bindTarget: WorkerBindTarget, brief: string, pmNote?: string | null): string =>
  renderGraphStepTask({
    goal: bindTarget.graphGoal,
    stepTitle: bindTarget.nodeTitle,
    index: bindTarget.index,
    total: bindTarget.total,
    brief,
    review: bindTarget.review,
    ...(pmNote !== undefined ? { pmNote } : {}),
  });

const pmNoteOf = (args: StartArgs): string | null =>
  typeof args.task === "string" && args.task.trim() !== "" ? validTask(args.task, "项目经理的补充") : null;

function resolveStartTask(args: StartArgs, bindTarget: WorkerBindTarget | undefined, takeover: Takeover | null): StartTask {
  const latest = takeover?.predecessors[0] ?? null;
  const stepHasBrief = bindTarget !== undefined && bindTarget.brief !== null && bindTarget.brief.trim() !== "";
  const rawTitle =
    typeof args.title === "string" && args.title.trim() !== "" ? args.title : (latest?.title ?? bindTarget?.nodeTitle ?? args.title);
  const title = typeof rawTitle === "string" ? normalizeWorkerTitle(rawTitle) : null;
  if (title === null) throw fail("invalid", "Worker 的标题不能是空的，也不能带换行等控制字符");
  if (takeover !== null && takeover.originalTask !== null) {
    const pmNote = pmNoteOf(args);
    const task = pmNote === null ? takeover.originalTask : `${takeover.originalTask.trimEnd()}\n\n## 项目经理的补充（换人接手时）\n\n${pmNote.trim()}`;
    if (utf8Bytes(task) > MAX_TASK_BYTES) {
      throw fail("invalid", `原始任务说明加上补充超过 ${MAX_TASK_BYTES} 字节：补充写短一点，长材料存成文件给路径`);
    }
    return { title, task, pmNote, stepHasBrief };
  }
  if (stepHasBrief && bindTarget !== undefined) {
    const pmNote = pmNoteOf(args);
    const task = graphStepTask(bindTarget, bindTarget.brief!, pmNote);
    if (utf8Bytes(task) > MAX_TASK_BYTES) {
      throw fail("invalid", `步骤任务说明加上补充超过 ${MAX_TASK_BYTES} 字节`);
    }
    return { title, task, pmNote, stepHasBrief };
  }
  return { title, task: validTask(args.task, "任务说明"), pmNote: null, stepHasBrief };
}

function resolveStartAgent(w: WorkersCtx, caller: PmCaller, args: StartArgs, bindTarget: WorkerBindTarget | undefined): StartAgent {
  let vendor = (bindTarget?.vendor ?? caller.vendor) as AgentVendor;
  if (args.vendor !== undefined) {
    assertAgentVendor(args.vendor);
    vendor = args.vendor as AgentVendor;
    checkTargetVendorUsable(w, vendor);
  } else if (bindTarget?.vendor !== null && bindTarget?.vendor !== undefined) {
    assertAgentVendor(bindTarget.vendor);
    checkTargetVendorUsable(w, vendor);
  }
  const reuseStepModel = bindTarget !== undefined && args.vendor === undefined && bindTarget.vendor === vendor;
  const givenModel = typeof args.model === "string" ? args.model.trim() || null : reuseStepModel ? bindTarget.model : null;
  const givenEffort = typeof args.effort === "string" ? args.effort.trim() || null : reuseStepModel ? bindTarget.effort : null;
  const { model, effort } = checkedModelEffort(w, vendor, givenModel, givenEffort);
  const readonly = args.readonly !== undefined ? args.readonly === true : (bindTarget?.readonly ?? false);
  return { vendor, model, effort, readonly, capabilities: resolveStartCapabilities(args, bindTarget) };
}

function resolveStartCapabilities(args: StartArgs, bindTarget: WorkerBindTarget | undefined): WorkerCapabilities {
  if (args.caps === undefined && args.allow === undefined) return bindTarget?.capabilities ?? INHERIT_WORKER_CAPABILITIES;
  const caps = workerCapabilitiesOf(args.caps, args.allow);
  if ("error" in caps) throw fail("invalid", caps.error);
  return caps;
}

function resolveStartWorkspace(
  w: WorkersCtx,
  project: ProjectDbRow,
  card: ProjectCard,
  args: StartArgs,
  context: HubCallContext,
  bindTarget: WorkerBindTarget | undefined,
  takeover: Takeover | null,
): StartWorkspace {
  const reviewPlan = bindTarget?.workspacePlan.kind === "review" ? bindTarget.workspacePlan : null;
  if (reviewPlan !== null && args.noWorktree === true) {
    throw fail("invalid", `审查步骤只能在 detached 检出被审分支 ${reviewPlan.branch} 的独立审查目录里干活，不能用 --no-worktree`);
  }
  const inherit = reviewPlan === null ? (takeover?.inherit ?? null) : null;
  const upstreamInherit =
    args.noWorktree !== true && inherit === null && bindTarget?.workspacePlan.kind === "inherit" ? bindTarget.workspacePlan : null;
  const effectiveInherit =
    inherit !== null
      ? { fromWorkerId: inherit.id, worktreePath: inherit.worktree_path!, branch: inherit.branch!, baseCommit: inherit.base_commit! }
      : upstreamInherit;
  let probe: WorkspaceProbe = { isRepoWithCommit: false, hasUncommittedChanges: false };
  if (args.noWorktree !== true && effectiveInherit === null && reviewPlan === null) {
    probe = probeWorkspaceForStep(w, project.id, card.mainFolder, context, bindTarget !== undefined);
  }
  const workspace = effectiveInherit !== null || reviewPlan !== null || probe.isRepoWithCommit ? "worktree" : "main";
  return { reviewPlan, inherit, upstreamInherit, effectiveInherit, probe, workspace };
}

/** Read the predecessor records before closing the old Worker, which is ended as incomplete. */
function endPredecessorsIn(w: WorkersCtx, p: Pending, takeover: Takeover | null, bindTarget: WorkerBindTarget | undefined) {
  let predecessors: TakeoverPredecessor[] | null = null;
  const endedOld: EndedWorker[] = [];
  if (takeover !== null && bindTarget !== undefined) {
    const openIds = new Set(takeover.openOld.map((x) => x.id));
    const inFlightIds = new Set(takeover.openOld.filter((x) => !notStarted(x) && isWorkerInFlight(w, x)).map((x) => x.id));
    predecessors = takeover.predecessors.map((x) => ({
      worker: x,
      session: workerSession(w, x),
      endedNote: openIds.has(x.id)
        ? inFlightIds.has(x.id)
          ? "换人时它还在跑这一轮，后台已打断它，并按“没做完”把它收工（节点不标完成）。"
          : "换人时它还开着（没在跑），后台已按“没做完”把它收工（节点不标完成）。"
        : "它已经收工了。",
    }));
    for (const old of takeover.openOld) {
      endedOld.push(endWorkerIn(w, p, old, { notifyGraph: false }));
    }
  }
  return { predecessors, endedOld };
}

function takeoverWorkspaceNote(
  worker: WorkerDbRow,
  card: ProjectCard,
  args: StartArgs,
  space: StartWorkspace,
  bindTarget: WorkerBindTarget,
  takeover: Takeover,
): string {
  const { reviewPlan, inherit, upstreamInherit } = space;
  const branches = [...new Set(takeover.predecessors.map((x) => x.branch).filter((b): b is string => b !== null && b !== ""))];
  const branchNote = branches.length === 0 ? "" : `前任的分支 ${branches.join("、")} 还在，要的话自己合进来。`;
  if (reviewPlan !== null) {
    return `你在新开的审查目录 ${worker.worktree_path} 里，detached 在被审分支 ${reviewPlan.branch} 上；前任的审查目录不接手，它的结论和复现看下面的记录。`;
  }
  if (inherit !== null) {
    return `你就在前任 Worker #${inherit.id} 的工作目录 ${inherit.worktree_path} 和分支 ${inherit.branch} 上，没提交的改动都还在，先看 git status 和 git log。`;
  }
  if (upstreamInherit !== null) {
    return `前任没有建成工作目录，你接着用上一步（Worker #${upstreamInherit.fromWorkerId}）的工作目录 ${upstreamInherit.worktreePath} 和分支 ${upstreamInherit.branch}：它的提交、没提交的文件和装好的依赖都在，不要另开分支。${branchNote}`;
  }
  if (args.noWorktree === true) {
    return `这次按项目经理的要求直接在项目主文件夹 ${card.mainFolder} 里干（--no-worktree），没有接手前任的工作目录。${branchNote}`;
  }
  if (space.workspace === "main") {
    return `你在项目主文件夹 ${card.mainFolder} 里干活，和前任是同一个目录，前任没提交的改动也都还在，先看 git status。`;
  }
  if (bindTarget.workspacePlan.kind === "fork") {
    return `前任没有还能接手的工作目录（已清理或没建成），你在新开的 worktree ${worker.worktree_path}（分支 ${worker.branch}）里，从上游分支 ${bindTarget.workspacePlan.baseBranch} 最新提交开始。${branchNote}`;
  }
  return `前任没有还能接手的工作目录（已清理或没建成），你在新开的 worktree ${worker.worktree_path}（分支 ${worker.branch}）里，从主文件夹最后一次提交开始。${branchNote}`;
}

function takeoverBaseTask(bindTarget: WorkerBindTarget, takeover: Takeover, brief: StartTask): string {
  if (brief.stepHasBrief) return graphStepTask(bindTarget, bindTarget.brief!);
  if (takeover.originalTask !== null && !takeover.originalTask.includes("## 你这一步：")) return graphStepTask(bindTarget, takeover.originalTask);
  return takeover.originalTask ?? brief.task;
}

function takeoverMessage(
  w: WorkersCtx,
  start: { worker: WorkerDbRow; session: AgentSessionRow; card: ProjectCard; args: StartArgs; agent: StartAgent; brief: StartTask; space: StartWorkspace },
  bindTarget: WorkerBindTarget,
  takeover: Takeover,
  predecessors: TakeoverPredecessor[],
): string | null {
  const { worker, session, agent, brief, space } = start;
  const baseWorkspaceNote = takeoverWorkspaceNote(worker, start.card, start.args, space, bindTarget, takeover);
  const workspaceNote = agent.readonly ? `${baseWorkspaceNote}\n${WORKER_READONLY_NOTE}` : baseWorkspaceNote;
  const upstreamHandoff = bindTarget.buildUpstreamHandoff(session.id, space.effectiveInherit?.fromWorkerId ?? null);
  return (
    w.options.takeover?.takeoverMessage({
      graph: { id: bindTarget.graphId, title: bindTarget.graphTitle },
      node: { key: bindTarget.nodeKey, title: bindTarget.nodeTitle, index: bindTarget.index, total: bindTarget.total },
      worker: { id: worker.id, title: worker.title },
      predecessors,
      workspaceNote,
      task: takeoverBaseTask(bindTarget, takeover, brief),
      upstreamHandoff,
      pmNote: brief.pmNote,
    }) ?? null
  );
}

function capabilitiesReceiptNote(caps: WorkerCapabilities, project: CapabilityPolicy): string {
  if (caps.mode === "inherit") return "";
  if (caps.mode === "none") return "。它不带外接能力（不挂 MCP、Skill、连接器；读写文件、终端和 hub 照常）";
  const blocked = blockedWorkerCapabilities(project, caps);
  const mounted = caps.allow.filter((key) => !blocked.includes(key));
  const head = mounted.length === 0 ? "。点名的外接能力一项都挂不上，等于不带" : `。外接能力只挂 ${mounted.join("、")}`;
  const blockedNote = blocked.length === 0 ? "" : `；${blocked.join("、")} 在这个项目的能力设置里是关的，挂不上，要用先请用户在项目资料页的 Capabilities 里打开`;
  return `${head}${blockedNote}`;
}

function startReceipt(
  w: WorkersCtx,
  worker: WorkerDbRow,
  project: ProjectDbRow,
  card: ProjectCard,
  args: StartArgs,
  start: { agent: StartAgent; brief: StartTask; space: StartWorkspace },
  handover: { bindTarget: WorkerBindTarget | undefined; takeover: Takeover | null; endedOld: EndedWorker[] },
): string {
  const { id, title } = worker;
  const { agent, brief, space } = start;
  const { bindTarget, takeover, endedOld } = handover;
  const notes: string[] = [];
  if (takeover !== null && bindTarget !== undefined) {
    const old =
      endedOld.length === 0
        ? ""
        : `已先把节点上还挂着的 ${endedOld.map((e) => `Worker #${e.ended.id}${e.interrupted ? "（打断了它正在跑的那一轮）" : ""}`).join("、")} 收工，节点不标完成；`;
    notes.push(
      `${old}已派出 Worker #${id}“${title}”接手任务图 #${bindTarget.graphId} 的节点「${bindTarget.nodeKey}」，${describeWorkspace(worker, card.mainFolder)}` +
        `。前任（最近 ${takeover.predecessors.length} 个）的汇报、最后的文字、最后几步操作和原始记录路径已自动放进它的第一条消息${brief.pmNote === null ? "" : "，你的正文作为补充放在最后"}`,
    );
    if (space.inherit !== null) notes.push(`；它接着用前任 Worker #${space.inherit.id} 的工作目录和分支，前任会话结束后它才开工`);
  } else {
    notes.push(`已派出 Worker #${id}“${title}”，${describeWorkspace(worker, card.mainFolder)}`);
  }
  if (space.workspace === "main" && args.noWorktree !== true) notes.push("（主文件夹不是有提交的 git 仓库，所以没建 worktree）");
  if (agent.readonly) notes.push("。它是只读的，只看不改");
  notes.push(capabilitiesReceiptNote(agent.capabilities, readPmCapabilityPolicy(w.db, worker.pm_id)));
  notes.push(`。它每做完一轮，汇报会自动发给你；打回用 ${HUB_COMMAND} worker send ${id} --stdin，收工用 ${HUB_COMMAND} worker end ${id}。`);
  const freshWorktree = space.workspace === "worktree" && space.effectiveInherit === null;
  if (freshWorktree && project.setup_command !== null) notes.push(SETUP_RECEIPT_NOTE);
  if (freshWorktree && space.probe.hasUncommittedChanges) notes.push(WORKTREE_DIRTY_NOTE);
  return notes.join("");
}

function firstMessageOf(
  w: WorkersCtx,
  start: { worker: WorkerDbRow; session: AgentSessionRow; card: ProjectCard; args: StartArgs; agent: StartAgent; brief: StartTask; space: StartWorkspace },
  bindTarget: WorkerBindTarget | undefined,
  takeover: Takeover | null,
  predecessors: TakeoverPredecessor[] | null,
): string {
  const takeoverText =
    takeover !== null && bindTarget !== undefined && predecessors !== null ? takeoverMessage(w, start, bindTarget, takeover, predecessors) : null;
  if (takeoverText !== null) return takeoverText;
  const { brief } = start;
  const workerRecord = toWorkerRecord(start.worker);
  if (bindTarget === undefined) return buildWorkerFirstMessage({ project: start.card, worker: workerRecord, task: brief.task });
  return bindTarget.buildFirstMessage(start.session.id, {
    inheritedFromWorkerId: start.space.effectiveInherit?.fromWorkerId ?? null,
    worker: workerRecord,
    project: start.card,
    task: brief.stepHasBrief ? brief.task : graphStepTask(bindTarget, brief.task),
  });
}

export function startIn(w: WorkersCtx, p: Pending, caller: PmCaller, args: StartArgs, context: HubCallContext): HubResult<"worker.start"> {
  w.persona.assertPmNotArchived(caller.pmId);
  const project = w.projects.activeProjectOf(caller.pmId);
  if (project === null) throw fail("invalid", `你还没有项目，没法派 Worker：先用 ${HUB_COMMAND} project create --folder <主文件夹> 建一个`);
  const bindTarget =
    args.node !== undefined && args.node.trim() !== "" ? w.options.taskGraphs?.prepareWorkerBind(caller.pmId, args.node, args.graphId) : undefined;
  const takeover =
    bindTarget !== undefined && bindTarget.workerIds.length > 0 ? planTakeover(w, bindTarget, project.id, args.noWorktree === true) : null;
  const brief = resolveStartTask(args, bindTarget, takeover);
  const maxTimeMs = validMaxTimeMs(args.maxTimeMs ?? bindTarget?.maxTimeMs ?? undefined);
  const agent = resolveStartAgent(w, caller, args, bindTarget);
  // Every Worker requires a working OS sandbox; there is no rule-based fallback.
  if (!w.ctx.osSandboxed()) throw fail("invalid", WORKER_NEEDS_OS_SANDBOX_MESSAGE);
  const card = w.projects.projectCard(project);
  const space = resolveStartWorkspace(w, project, card, args, context, bindTarget, takeover);
  const { predecessors, endedOld } = endPredecessorsIn(w, p, takeover, bindTarget);
  if (space.effectiveInherit !== null) {
    // Close leftover open Workers on the taken-over directory first, otherwise waitsForFirstTurn deadlocks.
    endOpenUpstreamIn(w, p, { kind: "inherit", ...space.effectiveInherit });
  } else if (space.reviewPlan !== null) {
    endOpenUpstreamIn(w, p, space.reviewPlan);
  }
  const worker = insertWorkerRowsIn(w, p, {
    pmId: caller.pmId,
    project,
    title: brief.title,
    task: brief.task,
    model: agent.model,
    effort: agent.effort,
    readonly: agent.readonly,
    capabilities: agent.capabilities,
    workspace: space.workspace,
    inherit: space.effectiveInherit,
    review: space.reviewPlan !== null,
    reviewJson: space.reviewPlan === null ? null : newReviewJson(space.reviewPlan),
  });
  const inherited =
    agent.vendor === caller.vendor ? splitModelEffort(agent.vendor, caller.model, caller.effort, w.ctx.modelCatalog(agent.vendor)) : { model: null, effort: null };
  const session = insertWorkerSessionIn(w, p, worker, card, agent, inherited);
  const start = { worker, session, card, args, agent, brief, space };
  const firstMessageText = firstMessageOf(w, start, bindTarget, takeover, predecessors);
  kickOffWorkerIn(w, p, {
    worker,
    session,
    project,
    firstMessageText,
    inherited: space.effectiveInherit !== null,
    maxTimeMs,
    afterStartedLine:
      bindTarget === undefined
        ? undefined
        : () => w.options.taskGraphs?.bindWorkerStartedIn(p, bindTarget, worker.id, { vendor: agent.vendor, model: session.model, effort: session.effort }),
  });
  return { text: startReceipt(w, worker, project, card, args, { agent, brief, space }, { bindTarget, takeover, endedOld }), data: { worker: toWorkerRecord(worker) } };
}
