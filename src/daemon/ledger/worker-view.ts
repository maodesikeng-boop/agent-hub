import type { AgentSessionRow, ConversationId, SessionId, WorkerRecord } from "../../shared/domain.ts";
import { formatCount } from "../../shared/count-format.ts";
import type { HubArgs, HubResult, WorkerPrProbeResult } from "../../shared/hub.ts";
import type { HubCallContext } from "../../shared/ledger.ts";
import { WORKER_LOG_DEFAULT_STEPS, WORKER_LOG_MAX_STEPS, WORKER_RETENTION_DAYS, WORKER_RETENTION_MAX_ENDED, WORKER_STALL_HINT_MS } from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { parseReviewTarget } from "../../shared/review.ts";
import { formatDurationShort } from "../../shared/schedule.ts";
import { formatDuration } from "../../shared/step-labels.ts";
import { agentEffortOf, effortLabel, vendorLabel } from "../../shared/vendors.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { fail } from "./context.ts";
import type { LedgerContext } from "./context.ts";
import type { WorkerDbRow } from "./rows.ts";
import { toWorkerRecord } from "./rows.ts";
import { sandboxApprovalPending } from "./sandbox-approvals.ts";
import { formatBackgroundTasksSummary, formatWorkerState } from "./worker-state.ts";
import { workerStatsLines } from "./worker-stats.ts";
import { createLedgerWorkerSearch } from "./worker-search.ts";
import type { LiveSession } from "./sessions.ts";
import type { LedgerSteps } from "./steps.ts";
import type { LedgerTurns, TurnRecord } from "./turns.ts";
import type { LedgerTurnTools, TurnToolRecord } from "./turn-tools.ts";
import { clipText, createWorkerActivity, formatClock, formatLogSteps, outcomeText } from "./worker-activity.ts";

const NO_DATA = "—";

const pad = (n: number) => String(n).padStart(2, "0");
export function agentSettingOf(
  ctx: Pick<LedgerContext, "modelShortLabel"> & Partial<Pick<LedgerContext, "modelCatalog">>,
  session: Pick<AgentSessionRow, "vendor" | "model" | "effort">,
): { model: string; effort: string } {
  const vendor = session.vendor as AgentVendor;
  const catalog = ctx.modelCatalog?.(vendor) ?? null;
  return {
    model: ctx.modelShortLabel(vendor, session.model),
    effort: effortLabel(agentEffortOf(vendor, session.model, session.effort, catalog), vendor, catalog),
  };
}

export interface WorkerViewDeps {
  ownWorker: (pmId: number, workerId: number) => WorkerDbRow;
  workerSession: (worker: number | WorkerDbRow) => AgentSessionRow;
  notStarted: (worker: WorkerDbRow) => boolean;
  liveOf: (id: SessionId) => LiveSession;
  turns: LedgerTurns;
  tools: LedgerTurnTools;
  activityOf: ReturnType<typeof createWorkerActivity>;
  turnMaxTimeOf?: (workerConversationId: ConversationId) => { maxTimeMs: number; startedAt: number } | null;
  isWorktreeCleaned?: (worker: WorkerDbRow) => boolean;
}

export function createLedgerWorkerView(ctx: LedgerContext, steps: LedgerSteps, deps: WorkerViewDeps) {
  const { db, now } = ctx;
  const { ownWorker, workerSession, notStarted, liveOf, turns, tools, activityOf, turnMaxTimeOf, isWorktreeCleaned } = deps;
  const workerSearch = createLedgerWorkerSearch(ctx);

  const doingOf = ({ worker, live, current, lastEnded, open }: {
    worker: WorkerDbRow;
    live: LiveSession;
    current: TurnRecord | null;
    lastEnded: TurnRecord | null;
    open: readonly TurnToolRecord[];
  }): string | null => {
    if (worker.status === "ended") return null;
    if (live.activity === "preparing") return "在跑项目的准备命令，跑完才开工";
    if (notStarted(worker)) return "worktree 还没建好，没开工";
    if (live.activity === "stopping") return "正在停下来";
    if (live.activity === "background") return `这一轮做完了，在等放到后台的 ${live.backgroundTasks ?? 0} 个命令跑完，跑完它接着做、做完再汇报`;
    if (current === null && live.activity === "idle") {
      if (lastEnded === null) return "没在干活，等项目经理（或用户）发话";
      if (lastEnded.outcome === "ok") return "没在干活，等项目经理验收或发下一条";
      if (lastEnded.outcome === "interrupted") return "没在干活：上一轮被打断了，等项目经理（或用户）发话";
      if (lastEnded.outcome === "empty_recovery") return "没在干活：重启后重发的这一轮没有产出";
      return "没在干活：上一轮出错了，等项目经理处理";
    }
    if (live.apiRetry) return `在等接口重试（第 ${live.apiRetry.attempt}/${live.apiRetry.maxRetries} 次）`;
    if (current === null) return "刚开始这一轮";
    const t = now();
    const running = open.filter((tool) => tool.status === "running");
    const active = running.at(-1);
    if (active !== undefined) {
      const more = running.length > 1 ? `，同时有 ${running.length} 个工具在跑` : "";
      return `${clipText(active.summary ?? active.name)}，已跑 ${formatDuration(t - (active.startedAt ?? active.recordedAt))}${more}`;
    }
    const pending = open.at(-1);
    if (pending !== undefined) return `${clipText(pending.summary ?? pending.name)}，等待开始`;

    const cutoff = tools.lastActivityAt(current.id) ?? current.startedAt;
    const recent = steps.rows(current.sessionId, cutoff);
    const last = recent.at(-1);
    if (last?.kind === "thinking") {
      let since = last.at;
      for (let i = recent.length - 2; i >= 0; i--) {
        const row = recent[i];
        if (row?.kind !== "thinking") break;
        since = row.at;
      }
      return `在思考，已 ${formatDuration(t - since)}`;
    }
    return last?.kind === "text" ? "在写回复" : "在想下一步";
  };

  const purgedNote = (worker: WorkerDbRow): string | null => {
    const purgedAt = db.get<{ purged_at: number | null }>("SELECT purged_at FROM conversation_purges WHERE conversation_id = ?", worker.worker_conversation_id)?.purged_at ?? null;
    if (purgedAt === null) return null;
    const d = new Date(purgedAt);
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return (
      `对话已按保留期清理（已收工 Worker 的对话最多留 ${WORKER_RETENTION_DAYS} 天、只留最近 ${WORKER_RETENTION_MAX_ENDED} 个，${day} 清的）：消息、步骤日志已删；` +
      `任务说明和每轮汇报还在，用 \`${HUB_COMMAND} worker show ${worker.id} --task\` / \`--report\` 看，也能 \`${HUB_COMMAND} worker search\` 搜到`
    );
  };

  const show = (caller: { pmId: number }, args: HubArgs<"worker.show">, context: HubCallContext): HubResult<"worker.show"> => {
    const worker = ownWorker(caller.pmId, args.workerId);
    if (args.task === true && args.report !== undefined) throw fail("invalid", "--task 和 --report 只能用一个");
    if (args.task === true) return { text: worker.task, data: { worker: toWorkerRecord(worker) as WorkerRecord } };
    if (args.report !== undefined) return { text: workerSearch.reportText(worker, args.report), data: { worker: toWorkerRecord(worker) as WorkerRecord } };
    const session = workerSession(worker);
    const live = liveOf(session.id);
    const purged = purgedNote(worker);
    const current = purged === null ? turns.runningTurnOf(session.id) : null;
    const lastEnded = purged === null ? turns.lastEndedTurnOf(session.id) : null;
    const open = current === null ? [] : tools.openToolsOf(current.id);
    const t = now();

    const awaitingSandbox = worker.status !== "ended" && sandboxApprovalPending(db, worker.id);
    const state = formatWorkerState({
      status: worker.status, sandboxApprovalPending: awaitingSandbox, notStarted: notStarted(worker), live,
      lastTurnOutcome: lastEnded?.outcome ?? null, runningTurn: current !== null,
      lastEventAt: session.lastEventAt, now: t,
    });
    const setting = agentSettingOf(ctx, session);
    const lines: string[] = [];
    lines.push(`Worker #${worker.id}“${worker.title}”：${state}${worker.readonly === 1 ? "，只读" : ""}`);
    lines.push(`厂商 ${vendorLabel(session.vendor)}，模型 ${setting.model}，思考程度 ${setting.effort}`);

    const alive = session.pid !== null;
    const quiet = session.lastEventAt === null ? "还没有过动静" : `最后一次有动静是 ${formatDuration(t - session.lastEventAt)} 前`;
    lines.push(`进程${alive ? "在跑" : "没在跑"}，${quiet}`);

    const doing = awaitingSandbox ? null : doingOf({ worker, live, current, lastEnded, open });
    if (doing !== null) {
      const stalled =
        live.activity === "working" &&
        open.length === 0 &&
        session.lastEventAt !== null &&
        t - session.lastEventAt > WORKER_STALL_HINT_MS;
      lines.push(`现在：${doing}${stalled ? `（超过 ${formatDuration(WORKER_STALL_HINT_MS)} 没动静，可能卡住了）` : ""}`);
    }

    const maxTime = turnMaxTimeOf?.(worker.worker_conversation_id) ?? null;
    const maxTimeSummary =
      maxTime === null
        ? ""
        : t - maxTime.startedAt < maxTime.maxTimeMs
          ? `最大时间 ${formatDurationShort(maxTime.maxTimeMs)}，剩余 ${formatDuration(maxTime.maxTimeMs - (t - maxTime.startedAt))}`
          : `最大时间 ${formatDurationShort(maxTime.maxTimeMs)}，已超时`;
    if (worker.status !== "ended" && current !== null) {
      const resumed = current.cause === "recovery" ? "（守护进程重启后重发）" : "";
      lines.push(`这一轮跑了 ${formatDuration(t - current.startedAt)}，走了 ${tools.count(current.id)} 步${resumed}`);
    }
    if (maxTimeSummary && worker.status !== "ended" && !notStarted(worker)) {
      lines.push(`时间预算：${maxTimeSummary}（从派活时起算，重启不重置）`);
    }
    if (lastEnded !== null) {
      const took = lastEnded.durationMs === null ? "" : `，用了 ${formatDuration(lastEnded.durationMs)}`;
      lines.push(`上一轮：${outcomeText(lastEnded)}${took}，走了 ${tools.count(lastEnded.id)} 步`);
    } else if (purged === null) {
      lines.push("上一轮：还没有");
    }

    const parts: string[] = [];
    if (alive && live.backgroundTasks !== undefined) parts.push(`后台任务 ${live.backgroundTasks} 个`);
    parts.push(`对话 ${session.usage.context > 0 ? `${formatCount(session.usage.context)} context` : NO_DATA}`);
    lines.push(parts.join("，"));
    if (worker.status !== "ended" && live.backgroundTaskList?.length) lines.push(...formatBackgroundTasksSummary(live.backgroundTaskList, t));

    lines.push(
      worker.workspace === "worktree"
        ? `${worker.review_json !== null ? `审查分支 ${parseReviewTarget(worker.review_json)!.branch}（detached）` : `分支 ${worker.branch}`}，worktree ${worker.worktree_path}${isWorktreeCleaned?.(worker) ? "（已自动清理）" : ""}`
        : `在项目主文件夹里干活（没有单独的分支和 worktree）`,
    );
    if (context.pr !== undefined && context.pr !== null) lines.push(prLine(context.pr));
    else if (context.prError) lines.push(`PR 查不了（${context.prError}）`);
    lines.push(`原始记录：${context.transcript ?? "找不到"}`);
    if (purged !== null) lines.push(purged);

    return { text: lines.join("\n"), data: { worker: toWorkerRecord(worker) as WorkerRecord } };
  };

  const stats = (worker: WorkerDbRow, args: HubArgs<"worker.log">): HubResult<"worker.log"> => {
    if (args.last !== undefined) throw fail("invalid", "--stats 汇总全部步骤，不能和 --last 一起用");
    const name = `Worker #${worker.id}“${worker.title}”`;
    const purged = purgedNote(worker);
    if (purged !== null) return { text: `${name}：${purged}。`, data: { worker: toWorkerRecord(worker), steps: [] } };
    const sessions = ctx.db
      .all<{ id: SessionId }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", worker.worker_conversation_id)
      .map((s) => activityOf(s.id));
    const text = sessions.every(({ events }) => events.length === 0)
      ? `${name}还没有记录到任何一步。`
      : `${name}账本里留着的全部步骤（${sessions.length} 个会话）：\n${workerStatsLines(sessions).join("\n")}`;
    return { text, data: { worker: toWorkerRecord(worker), steps: [] } };
  };

  const log = (caller: { pmId: number }, args: HubArgs<"worker.log">): HubResult<"worker.log"> => {
    const worker = ownWorker(caller.pmId, args.workerId);
    if (args.stats === true) return stats(worker, args);
    const last = args.last ?? WORKER_LOG_DEFAULT_STEPS;
    if (!Number.isSafeInteger(last) || last < 1 || last > WORKER_LOG_MAX_STEPS) {
      throw fail("invalid", `--last 要写 1 到 ${WORKER_LOG_MAX_STEPS} 之间的整数`);
    }
    const purged = purgedNote(worker);
    if (purged !== null) return { text: `Worker #${worker.id}“${worker.title}”：${purged}。`, data: { worker: toWorkerRecord(worker), steps: [] } };
    const session = workerSession(worker);
    const open = turns.runningTurnOf(session.id) !== null;
    const shown = formatLogSteps(activityOf(session.id), open ? now() : null).slice(-last);
    const head = `Worker #${worker.id}“${worker.title}”最近 ${shown.length} 步（从旧到新）：`;
    const text =
      shown.length === 0
        ? `Worker #${worker.id}“${worker.title}”还没有记录到任何一步。`
        : `${head}\n${shown.map((s) => `${formatClock(s.at)} ${s.text}`).join("\n")}`;
    return { text, data: { worker: toWorkerRecord(worker), steps: shown } };
  };

  return { show, log, search: workerSearch.search };
}

const PR_STATE_LABELS: Readonly<Record<string, string>> = { OPEN: "开着", MERGED: "已合并", CLOSED: "已关闭" };
function prLine(pr: NonNullable<WorkerPrProbeResult>): string {
  if ("unavailable" in pr) return `PR 查不了（${pr.unavailable}）`;
  return `PR #${pr.number}（${PR_STATE_LABELS[pr.state] ?? pr.state}）${pr.url}`;
}
