// hub worker show / log（给项目经理看 Worker 在干什么、是不是卡住了）：从账本取，不去解析各家厂商的原始日志。
// - 状态、进程、最后一次有动静：agent_sessions 那一行和内存里的会话状态（sessions.ts 的 LiveSession）；
// - 一步一步干了什么、一轮的开始和结局：session_steps（steps.ts，三家驱动的事件到账本都是通用的）；
// - 后台任务个数：驱动层的 background.changed（只有 claude 有这个信号，别家不显示这一项）；
// - 动作文案、数字和用时的写法：和网页同一套（shared/step-labels.ts、shared/count-format.ts）。
// 只写给项目经理看的话；Worker 的命令行、回复里的密钥、令牌入库前已经遮掉（steps.ts、redact.ts）。
import type { AgentSessionRow, SessionId, WorkerRecord } from "../../shared/domain.ts";
import { formatCount } from "../../shared/count-format.ts";
import type { HubArgs, HubResult, WorkerLogStep, WorkerPr } from "../../shared/hub.ts";
import type { HubCallContext } from "../../shared/ledger.ts";
import { WORKER_LOG_DEFAULT_STEPS, WORKER_LOG_MAX_STEPS, WORKER_STALL_HINT_MS, WORKER_VIEW_TEXT_MAX_CHARS } from "../../shared/limits.ts";
import { formatDuration } from "../../shared/step-labels.ts";
import { agentEffortOf, effortLabel, vendorLabel } from "../../shared/vendors.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { fail } from "./context.ts";
import type { LedgerContext } from "./context.ts";
import type { WorkerDbRow } from "./rows.ts";
import { toWorkerRecord } from "./rows.ts";
import { workerStatsLines } from "./worker-stats.ts";
import type { LiveSession } from "./sessions.ts";
import type { LedgerSteps, StepRow } from "./steps.ts";

/** 没有数据时占位（docs/ui-standard.md 第 13 条）。 */
const NO_DATA = "—";

const pad = (n: number) => String(n).padStart(2, "0");
/** 本机时间“时:分:秒”：log 每一行的开头。 */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 超长的截断加省略号。 */
export function clipText(text: string, max = WORKER_VIEW_TEXT_MAX_CHARS): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** 一轮：从 turn_started 到 turn_ended；还没结束 end 是 null。 */
interface Turn {
  startedAt: number | null;
  rows: StepRow[];
  end: StepRow | null;
}

/** 按 turn_started、turn_ended 切成一轮一轮。 */
function turnsOf(rows: StepRow[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const row of rows) {
    if (row.kind === "turn_started") {
      if (current !== null) turns.push(current);
      current = { startedAt: row.at, rows: [], end: null };
    } else if (row.kind === "turn_ended") {
      // 一轮的开头被清掉了（只留最近的若干条）或没记到：没有开始时间
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
/** 调了、结果还没回来的工具，按调用顺序。 */
const openToolsOf = (turn: Turn): StepRow[] => {
  const done = new Set(turn.rows.filter((r) => r.kind === "tool_result").map((r) => r.tool_use_id));
  return turn.rows.filter((r) => r.kind === "tool" && !done.has(r.tool_use_id));
};
const turnSeconds = (turn: Turn): number | null =>
  turn.end === null ? null : (turn.end.duration_ms ?? (turn.startedAt === null ? null : turn.end.at - turn.startedAt));

/** 一轮是怎么结束的：成功 / 被打断 / 出错：原因。 */
function outcomeText(end: StepRow): string {
  if (end.outcome === "ok") return "成功";
  if (end.outcome === "interrupted") return end.summary === null ? "被打断" : `被打断（${clipText(end.summary)}）`;
  return end.summary === null ? "出错" : `出错：${clipText(end.summary)}`;
}

/**
 * Worker 实际用的模型和思考程度，hub worker list、show 共用，和网页右栏、资料页同一个写法：模型写显示名，
 * agy 的模型和思考程度分开写（老数据里写在模型 ID 末尾的也拆开）；思考程度“默认”时厂商没告诉我们实际是哪一档
 * （ModelCatalog 里没有），只能写默认。
 */
export function agentSettingOf(ctx: Pick<LedgerContext, "modelShortLabel">, session: Pick<AgentSessionRow, "vendor" | "model" | "effort">): { model: string; effort: string } {
  const vendor = session.vendor as AgentVendor;
  return { model: ctx.modelShortLabel(vendor, session.model), effort: effortLabel(agentEffortOf(vendor, session.model, session.effort)) };
}

export interface WorkerViewDeps {
  ownWorker: (pmId: number, workerId: number) => WorkerDbRow;
  workerSession: (workerId: number) => AgentSessionRow;
  /** 在 worktree 里干活、还没开工（workers.ts 的 notStarted）。 */
  notStarted: (worker: WorkerDbRow) => boolean;
  liveOf: (id: SessionId) => LiveSession;
}

export function createLedgerWorkerView(ctx: LedgerContext, steps: LedgerSteps, deps: WorkerViewDeps) {
  const { now } = ctx;
  const { ownWorker, workerSession, notStarted, liveOf } = deps;

  /** 状态：已收工、准备中、在干活、空闲等验收。 */
  const stateOf = (worker: WorkerDbRow, live: LiveSession, lastEnded: Turn | null): string => {
    if (worker.status === "ended") return "已收工";
    if (live.activity === "preparing" || notStarted(worker)) return "准备中";
    if (live.activity !== "idle") return "在干活";
    const end = lastEnded?.end;
    if (end === undefined || end === null) return "空闲，还没开始第一轮";
    return end.outcome === "ok" ? "空闲，等验收" : end.outcome === "interrupted" ? "空闲，上一轮被打断了" : "空闲，上一轮出错了";
  };

  /** 现在在干什么（一句话）；已收工的没有。 */
  const doingOf = (worker: WorkerDbRow, live: LiveSession, current: Turn | null, lastEnded: Turn | null): string | null => {
    if (worker.status === "ended") return null;
    if (live.activity === "preparing") return "在跑项目的准备命令，跑完才开工";
    if (notStarted(worker)) return "worktree 还没建好，没开工";
    if (live.activity === "stopping") return "正在停下来";
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
      // 连着的几次思考算一次，从第一次起算
      let since = last.at;
      for (let i = current.rows.length - 1; i >= 0 && current.rows[i]!.kind === "thinking"; i--) since = current.rows[i]!.at;
      return `在思考，已 ${formatDuration(t - since)}`;
    }
    if (last?.kind === "text") return "在写回复";
    return "在想下一步";
  };

  const show = (caller: { pmId: number }, args: HubArgs<"worker.show">, context: HubCallContext): HubResult<"worker.show"> => {
    const worker = ownWorker(caller.pmId, args.workerId);
    const session = workerSession(worker.id);
    const live = liveOf(session.id);
    const turns = turnsOf(steps.rows(session.id));
    const last = turns.at(-1);
    const current = last !== undefined && last.end === null ? last : null;
    const lastEnded = [...turns].reverse().find((turn) => turn.end !== null) ?? null;
    const t = now();

    const state = stateOf(worker, live, lastEnded);
    const setting = agentSettingOf(ctx, session);
    const lines: string[] = [];
    lines.push(`Worker #${worker.id}“${worker.title}”：${state}${worker.readonly === 1 ? "，只读" : ""}`);
    lines.push(`厂商 ${vendorLabel(session.vendor)}，模型 ${setting.model}，思考程度 ${setting.effort}`);

    const alive = session.pid !== null;
    const quiet = session.lastEventAt === null ? "还没有过动静" : `最后一次有动静是 ${formatDuration(t - session.lastEventAt)} 前`;
    lines.push(`进程${alive ? "在跑" : "没在跑"}，${quiet}`);

    const doing = doingOf(worker, live, current, lastEnded);
    if (doing !== null) {
      const stalled =
        live.activity === "working" &&
        (current === null || openToolsOf(current).length === 0) &&
        session.lastEventAt !== null &&
        t - session.lastEventAt > WORKER_STALL_HINT_MS;
      lines.push(`现在：${doing}${stalled ? `（超过 ${formatDuration(WORKER_STALL_HINT_MS)} 没动静，可能卡住了）` : ""}`);
    }

    if (current !== null && worker.status !== "ended") {
      const ran = current.startedAt === null ? "" : `跑了 ${formatDuration(t - current.startedAt)}，`;
      lines.push(`这一轮${ran}走了 ${toolCount(current)} 步`);
    }
    if (lastEnded?.end) {
      const seconds = turnSeconds(lastEnded);
      const took = seconds === null ? "" : `，用了 ${formatDuration(seconds)}`;
      lines.push(`上一轮：${outcomeText(lastEnded.end)}${took}，走了 ${toolCount(lastEnded)} 步`);
    } else {
      lines.push("上一轮：还没有");
    }

    const parts: string[] = [];
    // 后台任务：只有给这个信号的厂商（claude）才有数；进程不在了就没有
    if (alive && live.backgroundTasks !== undefined) parts.push(`后台任务 ${live.backgroundTasks} 个`);
    parts.push(`对话 ${session.usage.context > 0 ? `${formatCount(session.usage.context)} context` : NO_DATA}`);
    lines.push(parts.join("，"));

    lines.push(
      worker.workspace === "worktree"
        ? `分支 ${worker.branch}，worktree ${worker.worktree_path}`
        : `在项目主文件夹里干活（没有单独的分支和 worktree）`,
    );
    if (context.pr !== undefined) lines.push(prLine(context.pr));
    lines.push(`原始记录：${context.transcript ?? "找不到"}`);

    return { text: lines.join("\n"), data: { worker: toWorkerRecord(worker) as WorkerRecord } };
  };

  /** log 的一行：时间 + 动作。 */
  const logSteps = (rows: StepRow[], open: boolean): WorkerLogStep[] => {
    const t = now();
    const out: WorkerLogStep[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      switch (row.kind) {
        case "tool": {
          const back = rows.slice(i + 1).find((r) => r.kind === "tool_result" && r.tool_use_id === row.tool_use_id);
          const what = clipText(row.summary ?? row.name ?? "");
          let tail = "";
          if (back !== undefined) {
            const ms = back.at - row.at;
            if (ms >= 1_000) tail = `（用了 ${formatDuration(ms)}）`;
          } else if (open && !rows.slice(i + 1).some((r) => r.kind === "turn_ended")) {
            tail = `（还在跑，已 ${formatDuration(t - row.at)}）`;
          } else {
            tail = "（没等到结果）";
          }
          out.push({ at: row.at, kind: "tool", text: `${what}${tail}` });
          break;
        }
        case "thinking": {
          // 连着的几次思考合成一行：到下一步出现为止
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
  };

  /** --stats：所有换过代的会话里账本留着的全部步骤，汇成几行。 */
  const stats = (worker: WorkerDbRow, args: HubArgs<"worker.log">): HubResult<"worker.log"> => {
    if (args.last !== undefined) throw fail("invalid", "--stats 汇总全部步骤，不能和 --last 一起用");
    const sessions = ctx.db
      .all<{ id: SessionId }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation", worker.worker_conversation_id)
      .map((s) => steps.rows(s.id));
    const name = `Worker #${worker.id}“${worker.title}”`;
    const text = sessions.every((rows) => rows.length === 0)
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
    const session = workerSession(worker.id);
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

  return { show, log };
}

const PR_STATE_LABELS: Readonly<Record<string, string>> = { OPEN: "开着", MERGED: "已合并", CLOSED: "已关闭" };
function prLine(pr: WorkerPr): string {
  return `PR #${pr.number}（${PR_STATE_LABELS[pr.state] ?? pr.state}）${pr.url}`;
}
