import type { AgentSessionRow, PmMode, WorkerId, WorkerRecord } from "../../../shared/domain.ts";
import type { HubArgs, HubResult, WorkerHubStatus } from "../../../shared/hub.ts";
import type { LaunchContext } from "../../../shared/ledger.ts";
import { WORKER_LIST_RECENT_ENDED } from "../../../shared/limits.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { isAgentVendor } from "../../../shared/vendors.ts";
import { readWorkerCapabilities } from "../capability-rows.ts";
import { toWorkerRecord } from "../rows.ts";
import type { WorkerDbRow } from "../rows.ts";
import { agentSettingOf } from "../worker-view.ts";
import { isWorktreeCleaned } from "./cleanup.ts";
import { mainFolderOf, projectRow, workerRow, workerSession } from "./ctx.ts";
import { describeWorkspace, worktreeLabel } from "./text.ts";
import type { PmCaller, WorkersCtx } from "./types.ts";

/** Ended Workers are capped at WORKER_LIST_RECENT_ENDED so hundreds of entries do not flood the PM context; recency uses updated_at, not id. */
export function list(w: WorkersCtx, caller: PmCaller, _args?: HubArgs<"worker.list">): HubResult<"worker.list"> {
  const all = w.db.all<WorkerDbRow>("SELECT * FROM workers WHERE pm_id = ? ORDER BY id", caller.pmId);
  if (all.length === 0) return { text: "你还没有派过 Worker。", data: { workers: [] } };
  const endedLatestFirst = all.filter((x) => x.status === "ended").sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
  const hidden = new Set(endedLatestFirst.slice(WORKER_LIST_RECENT_ENDED));
  const rows = hidden.size === 0 ? all : all.filter((x) => !hidden.has(x));
  const lines = rows.map((x) => {
    const session = workerSession(w, x);
    const where = x.workspace === "worktree" ? worktreeLabel(x) : "主文件夹";
    const state = x.status === "ended" ? "已收工" : w.sessions.liveOf(session.id).activity === "preparing" ? "准备中" : "进行中";
    const shown = agentSettingOf(w.ctx, session);
    const setting = `模型 ${shown.model} · 思考程度 ${shown.effort}`;
    return `#${x.id} ${x.title} · ${state} · ${where} · ${setting}${x.readonly === 1 ? " · 只读" : ""}`;
  });
  if (hidden.size > 0) {
    lines.push(`（另有 ${hidden.size} 个更早收工的 Worker 没列出：用 \`${HUB_COMMAND} worker search <关键词>\` 搜，或 \`${HUB_COMMAND} worker show <编号>\` 看）`);
  }
  return { text: `你派出的 Worker：\n${lines.join("\n")}`, data: { workers: rows.map(toWorkerRecord) } };
}

function upstreamLines(upstream: NonNullable<WorkerHubStatus["taskGraph"]>["upstream"]): string {
  return upstream
    .map((u) => {
      if (u.skipped) return `- ${u.key}（${u.title}）：${u.summary ?? "已跳过"}`;
      const parts = [`- ${u.key}（${u.title}）`];
      if (u.summary) parts.push(`摘要：${u.summary}`);
      if (u.branch) parts.push(`分支：${u.branch}`);
      if (u.prUrl) parts.push(`PR：${u.prUrl}`);
      if (u.reportFile) parts.push(`完整汇报：${u.reportFile}`);
      return parts.join(" · ");
    })
    .join("\n");
}

export function status(w: WorkersCtx, caller: AgentSessionRow): HubResult<"status"> {
  const worker = workerRow(w, caller.workerId!)!;
  const pm = w.persona.pmRow(worker.pm_id)!;
  const card = w.projects.projectCard(projectRow(w, worker.project_id));
  const graphInfo = w.options.taskGraphs?.workerGraphStatus(worker.id, caller.id);
  const data: WorkerHubStatus = {
    role: "worker",
    pm: { id: pm.id, name: pm.name },
    sessionId: caller.id,
    conversationId: worker.worker_conversation_id,
    worker: toWorkerRecord(worker),
    project: card,
    ...(graphInfo !== undefined ? { taskGraph: graphInfo } : {}),
  };
  const readonly = worker.readonly === 1 ? "只读（只看不改），" : "";
  const head = `你是 Worker #${worker.id}“${worker.title}”，项目经理“${pm.name}”派的，${readonly}${describeWorkspace(worker, card.mainFolder)}。`;
  if (graphInfo === undefined) {
    return { text: `${head}\n\n任务说明：\n${worker.task}`, data };
  }
  const sections = [
    head,
    `所属任务图：#${graphInfo.id}「${graphInfo.title}」· 第 ${graphInfo.stepIndex}/${graphInfo.totalSteps} 步「${graphInfo.stepTitle}」（${graphInfo.stepKey}）`,
  ];
  if (graphInfo.goal) sections.push(`图目标：\n${graphInfo.goal}`);
  sections.push(`本步职责：\n${graphInfo.brief ?? worker.task}`);
  if (graphInfo.upstream.length > 0) sections.push(`上游交棒：\n${upstreamLines(graphInfo.upstream)}`);
  return { text: sections.join("\n\n"), data };
}

export function workerPrTarget(w: WorkersCtx, session: AgentSessionRow | null, workerId: WorkerId): { cwd: string; branch: string } | null {
  if (session === null || session.role !== "pm" || session.pmId === null) return null;
  const worker = workerRow(w, workerId);
  if (worker === null || worker.pm_id !== session.pmId || worker.workspace !== "worktree") return null;
  if (worker.worktree_path === null || worker.branch === null || worker.base_commit === null) return null;
  const cwd = isWorktreeCleaned(w, worker) ? mainFolderOf(w, worker.project_id) : worker.worktree_path;
  return cwd === "" ? null : { cwd, branch: worker.branch };
}

export function workerTranscriptTarget(
  w: WorkersCtx,
  session: AgentSessionRow | null,
  workerId: WorkerId,
): { vendor: string; vendorSessionId: string; cwd: string } | null {
  if (session === null || session.role !== "pm" || session.pmId === null) return null;
  const worker = workerRow(w, workerId);
  if (worker === null || worker.pm_id !== session.pmId) return null;
  const target = workerSession(w, workerId);
  return { vendor: target.vendor, vendorSessionId: target.vendorSessionId, cwd: target.cwd };
}

export function workerStartFolder(w: WorkersCtx, session: AgentSessionRow | null): string | null {
  if (session === null || session.role !== "pm" || session.pmId === null) return null;
  const project = w.projects.activeProjectOf(session.pmId);
  return project === null ? null : w.projects.projectCard(project).mainFolder;
}

function withTakeoverOf(w: WorkersCtx, worker: WorkerDbRow): WorkerRecord {
  const record = toWorkerRecord(worker);
  if (worker.workspace !== "worktree" || worker.worktree_path === null || worker.worktree_path === "") return record;
  const owner = w.db.get<{ id: number }>("SELECT min(id) AS id FROM workers WHERE worktree_path = ?", worker.worktree_path)?.id ?? worker.id;
  return owner === worker.id ? record : { ...record, takeoverOf: owner };
}

function workerCapabilitiesOfRow(w: WorkersCtx, workerId: WorkerId): Pick<LaunchContext, "workerCapabilities"> {
  const caps = readWorkerCapabilities(w.db, { table: "worker_capabilities", workerId });
  return caps.mode === "inherit" ? {} : { workerCapabilities: caps };
}

export function launchContextFor(w: WorkersCtx, session: AgentSessionRow): LaunchContext | null {
  if (session.role !== "worker" || session.workerId === null) return null;
  const worker = workerRow(w, session.workerId);
  if (worker === null) return null;
  const pm = w.persona.pmRow(worker.pm_id)!;
  return {
    sessionId: session.id,
    role: "worker",
    conversationId: worker.worker_conversation_id,
    pm: { id: pm.id, name: pm.name, mode: pm.mode as PmMode, persona: pm.persona ?? "" },
    project: w.projects.projectCard(projectRow(w, worker.project_id)),
    worker: withTakeoverOf(w, worker),
    ...workerCapabilitiesOfRow(w, worker.id),
    ...(isAgentVendor(session.vendor) ? { vendor: session.vendor } : {}),
  };
}
