import type { AgentSessionRow, ConversationId, SessionId, WorkerRecord } from "../../shared/domain.ts";
import { formatCount } from "../../shared/count-format.ts";
import type { HubArgs, HubResult, WorkerLogStep, WorkerPr, WorkerPrProbeResult } from "../../shared/hub.ts";
import type { HubCallContext } from "../../shared/ledger.ts";
import { WORKER_LOG_DEFAULT_STEPS, WORKER_RETENTION_DAYS, WORKER_RETENTION_MAX_ENDED, WORKER_STALL_HINT_MS, WORKER_VIEW_TEXT_MAX_CHARS } from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { parseReviewTarget } from "../../shared/review.ts";
import { formatDurationShort } from "../../shared/schedule.ts";
import { formatDuration } from "../../shared/step-labels.ts";
import { agentEffortOf, effortLabel, vendorLabel } from "../../shared/vendors.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { assertHubLimitAmount, fail } from "./context.ts";
import type { LedgerContext } from "./context.ts";
import type { WorkerDbRow } from "./rows.ts";
import { toWorkerRecord } from "./rows.ts";
import { sandboxApprovalPending } from "./sandbox-approvals.ts";
import { formatBackgroundTasksSummary, formatWorkerState, lastTurnOutcomesBySession } from "./worker-state.ts";
import { workerStatsLines } from "./worker-stats.ts";
import { createLedgerWorkerSearch } from "./worker-search.ts";
import type { LiveSession } from "./sessions.ts";
import type { LedgerSteps, StepRow } from "./steps.ts";

const NO_DATA = "—";

const pad = (n: number) => String(n).padStart(2, "0");
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function clipText(text: string, max = WORKER_VIEW_TEXT_MAX_CHARS): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

interface Turn {
  startedAt: number | null;
  rows: StepRow[];
  end: StepRow | null;
}

function turnsOf(rows: StepRow[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const row of rows) {
    if (row.kind === "turn_started") {
      if (current !== null) turns.push(current);
      current = { startedAt: row.at, rows: [], end: null };
    } else if (row.kind === "turn_ended") {
      const turn: Turn = current ?? { startedAt: null, rows: [], end: null };
      turn.end = row;
      turns.push(turn);
      current = null;
    } else {
      current ??= { startedAt: null, rows: [], end: null };
      current.rows.push(row);
    }
  }
  if (current !== null) turns.push(current);
  return turns;
}

const toolCount = (turn: Turn) => turn.rows.filter((r) => r.kind === "tool").length;
const openToolsOf = (turn: Turn): StepRow[] => {
  const done = new Set(turn.rows.filter((r) => r.kind === "tool_result").map((r) => r.tool_use_id));
  return turn.rows.filter((r) => r.kind === "tool" && !done.has(r.tool_use_id));
};
const turnSeconds = (turn: Turn): number | null =>
  turn.end === null ? null : (turn.end.duration_ms ?? (turn.startedAt === null ? null : turn.end.at - turn.startedAt));

function outcomeText(end: StepRow): string {
  if (end.outcome === "ok") return "成功";
  if (end.outcome === "interrupted") return end.summary === null ? "被打断" : `被打断（${clipText(end.summary)}）`;
  return end.summary === null ? "出错" : `出错：${clipText(end.summary)}`;
}

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
  turnMaxTimeOf?: (workerConversationId: ConversationId) => { maxTimeMs: number; startedAt: number } | null;
  isWorktreeCleaned?: (worker: WorkerDbRow) => boolean;
}

export function createLedgerWorkerView(ctx: LedgerContext, steps: LedgerSteps, deps: WorkerViewDeps) {
  const { db, now } = ctx;
  const { ownWorker, workerSession, notStarted, liveOf, turnMaxTimeOf, isWorktreeCleaned } = deps;
  const workerSearch = createLedgerWorkerSearch(ctx);

  const doingOf = (worker: WorkerDbRow, live: LiveSession, current: Turn | null, lastEnded: Turn | null): string | null => {
    if (worker.status === "ended") return null;
    if (live.activity === "preparing") return "在跑项目的准备命令，跑完才开工";
    if (notStarted(worker)) return "worktree 还没建好，没开工";
    if (live.activity === "stopping") return "正在停下来";
    if (live.activity === "background") return `这一轮做完了，在等放到后台的 ${live.backgroundTasks ?? 0} 个命令跑完，跑完它接着做、做完再汇报`;
    const t = now();
    if (live.activity === "idle") {
      const end = lastEnded?.end;
      if (end === undefined || end === null) return "没在干活，等项目经理（或用户）发话";
      if (end.outcome === "ok") return "没在干活，等项目经理验收或发下一条";
      if (end.outcome === "interrupted") return "没在干活：上一轮被打断了，等项目经理（或用户）发话";
      return "没在干活：上一轮出错了，等项目经理处理";
    }
    if (live.apiRetry) return `在等接口重试（第 ${live.apiRetry.attempt}/${live.apiRetry.maxRetries} 次）`;
    if (current === null) return "刚开始这一轮";
    const open = openToolsOf(current);
    const running = open.at(-1);
    if (running !== undefined) {
      const more = open.length > 1 ? `，同时有 ${open.length} 个工具在跑` : "";
      return `${clipText(running.summary ?? running.name ?? "")}，已跑 ${formatDuration(t - running.at)}${more}`;
    }
    const last = current.rows.at(-1);
    if (last?.kind === "thinking") {
      let since = last.at;
      for (let i = current.rows.length - 1; i >= 0 && current.rows[i]!.kind === "thinking"; i--) since = current.rows[i]!.at;
      return `在思考，已 ${formatDuration(t - since)}`;
    }
    if (last?.kind === "text") return "在写回复";
    return "在想下一步";
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
    const turns = purged === null ? turnsOf(steps.rows(session.id)) : [];
    const last = turns.at(-1);
    const current = last !== undefined && last.end === null ? last : null;
    const lastEnded = [...turns].reverse().find((turn) => turn.end !== null) ?? null;
    const t = now();

    const awaitingSandbox = worker.status !== "ended" && sandboxApprovalPending(db, worker.id);
    const state = formatWorkerState({
      status: worker.status, sandboxApprovalPending: awaitingSandbox, notStarted: notStarted(worker), live,
      lastTurnOutcome: lastEnded?.end?.outcome ?? (purged === null ? lastTurnOutcomesBySession(db, [session.id]).get(session.id) ?? null : null),
      lastEventAt: session.lastEventAt, now: t,
    });
    const setting = agentSettingOf(ctx, session);
    const lines: string[] = [];
    lines.push(`Worker #${worker.id}“${worker.title}”：${state}${worker.readonly === 1 ? "，只读" : ""}`);
    lines.push(`厂商 ${vendorLabel(session.vendor)}，模型 ${setting.model}，思考程度 ${setting.effort}`);

    const alive = session.pid !== null;
    const quiet = session.lastEventAt === null ? "还没有过动静" : `最后一次有动静是 ${formatDuration(t - session.lastEventAt)} 前`;
    lines.push(`进程${alive ? "在跑" : "没在跑"}，${quiet}`);

    const doing = awaitingSandbox ? null : doingOf(worker, live, current, lastEnded);
    if (doing !== null) {
      const stalled =
        live.activity === "working" &&
        (current === null || openToolsOf(current).length === 0) &&
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
    if (current !== null && worker.status !== "ended") {
      const ran = current.startedAt === null ? "" : `跑了 ${formatDuration(t - current.startedAt)}，`;
      lines.push(`这一轮${ran}走了 ${toolCount(current)} 步${maxTimeSummary ? `（${maxTimeSummary}）` : ""}`);
    } else if (maxTimeSummary && worker.status !== "ended" && !notStarted(worker)) {
      lines.push(`这一轮：${maxTimeSummary}`);
    }
    if (lastEnded?.end) {
      const seconds = turnSeconds(lastEnded);
      const took = seconds === null ? "" : `，用了 ${formatDuration(seconds)}`;
      lines.push(`上一轮：${outcomeText(lastEnded.end)}${took}，走了 ${toolCount(lastEnded)} 步`);
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

  const logSteps = (rows: StepRow[], open: boolean): WorkerLogStep[] => formatLogSteps(rows, open, now());

  const stats = (worker: WorkerDbRow, args: HubArgs<"worker.log">): HubResult<"worker.log"> => {
    if (args.last !== undefined) throw fail("invalid", "--stats 汇总全部步骤，不能和 --last 一起用");
    const name = `Worker #${worker.id}“${worker.title}”`;
    const purged = purgedNote(worker);
    if (purged !== null) return { text: `${name}：${purged}。`, data: { worker: toWorkerRecord(worker), steps: [] } };
    const sessions = ctx.db
      .all<{ id: SessionId }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", worker.worker_conversation_id)
      .map((s) => steps.rows(s.id));
    const text = sessions.every((rows) => rows.length === 0)
      ? `${name}还没有记录到任何一步。`
      : `${name}账本里留着的全部步骤（${sessions.length} 个会话）：\n${workerStatsLines(sessions).join("\n")}`;
    return { text, data: { worker: toWorkerRecord(worker), steps: [] } };
  };

  const log = (caller: { pmId: number }, args: HubArgs<"worker.log">): HubResult<"worker.log"> => {
    const worker = ownWorker(caller.pmId, args.workerId);
    if (args.stats === true) return stats(worker, args);
    const last = args.last ?? WORKER_LOG_DEFAULT_STEPS;
    if (!Number.isSafeInteger(last) || last < 1) throw fail("invalid", "--last 要写正整数");
    assertHubLimitAmount("worker.logSteps", last);
    const purged = purgedNote(worker);
    if (purged !== null) return { text: `Worker #${worker.id}“${worker.title}”：${purged}。`, data: { worker: toWorkerRecord(worker), steps: [] } };
    const session = workerSession(worker);
    const rows = steps.rows(session.id);
    const open = liveOf(session.id).activity !== "idle" && steps.openTurn(session.id) !== null;
    const shown = logSteps(rows, open).slice(-last);
    const head = `Worker #${worker.id}“${worker.title}”最近 ${shown.length} 步（从旧到新）：`;
    const text =
      shown.length === 0
        ? `Worker #${worker.id}“${worker.title}”还没有记录到任何一步。`
        : `${head}\n${shown.map((s) => `${formatClock(s.at)} ${s.text}`).join("\n")}`;
    return { text, data: { worker: toWorkerRecord(worker), steps: shown } };
  };

  return { show, log, search: workerSearch.search };
}

export function formatLogSteps(rows: StepRow[], open: boolean, t: number): WorkerLogStep[] {
  const resultsByUseId = new Map<string | null, Array<{ row: StepRow; index: number }>>();
  let lastTurnEndedIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.kind === "tool_result") {
      let list = resultsByUseId.get(r.tool_use_id);
      if (list === undefined) {
        list = [];
        resultsByUseId.set(r.tool_use_id, list);
      }
      list.push({ row: r, index: i });
    } else if (r.kind === "turn_ended") {
      lastTurnEndedIndex = i;
    }
  }
  const out: WorkerLogStep[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    switch (row.kind) {
      case "tool": {
        const back = resultsByUseId.get(row.tool_use_id)?.find((m) => m.index > i)?.row;
        const what = clipText(row.summary ?? row.name ?? "");
        let tail = "";
        if (back !== undefined) {
          const ms = back.at - row.at;
          if (ms >= 1_000) tail = `（用了 ${formatDuration(ms)}）`;
        } else if (open && i > lastTurnEndedIndex) {
          tail = `（还在跑，已 ${formatDuration(t - row.at)}）`;
        } else {
          tail = "（没等到结果）";
        }
        out.push({ at: row.at, kind: "tool", text: `${what}${tail}` });
        break;
      }
      case "thinking": {
        let j = i;
        while (j + 1 < rows.length && rows[j + 1]!.kind === "thinking") j++;
        const next = rows[j + 1];
        if (next === undefined) {
          out.push({ at: row.at, kind: "thinking", text: open ? `在思考，已 ${formatDuration(t - row.at)}` : "思考" });
        } else {
          out.push({ at: row.at, kind: "thinking", text: `思考了 ${formatDuration(next.at - row.at)}` });
        }
        i = j;
        break;
      }
      case "text":
        out.push({ at: row.at, kind: "text", text: `回复了一段：${clipText(row.summary ?? "")}` });
        break;
      case "turn_ended":
        out.push({ at: row.at, kind: "turn_ended", text: `这一轮结束：${outcomeText(row)}` });
        break;
      default:
        break;
    }
  }
  return out;
}

const PR_STATE_LABELS: Readonly<Record<string, string>> = { OPEN: "开着", MERGED: "已合并", CLOSED: "已关闭" };
function prLine(pr: NonNullable<WorkerPrProbeResult>): string {
  if ("unavailable" in pr) return `PR 查不了（${pr.unavailable}）`;
  return `PR #${pr.number}（${PR_STATE_LABELS[pr.state] ?? pr.state}）${pr.url}`;
}
