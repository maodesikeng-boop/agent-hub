// 换人接手同一步（hub worker start --node 给已有前任的图节点派人，docs/orchestration-simplify-design.md 第 5.2、9.4、11 节）：
// 新 Worker 的第一条消息“【系统 · 接手】”。前任的记录都是账本里已经存着的东西，派活时现取现拼，不另存、不缓存：
// - 为什么停：项目经理对话里它最后一行汇报 / 没做完 / 建 worktree 失败（ledger/workers.ts 的 insertLine 写的），再加收工的情况；
// - 每一轮的汇报原文（从新到旧）：同上那几行里 event 是 report 的；
// - 还没来得及汇报的最后几段文字：它自己对话里最后一行汇报之后的 agent 文字；
// - 最后几步操作：session_steps（和 hub worker log 同一个写法，worker-view.ts 的 formatLogSteps）；
// - 厂商原始记录的路径（和 hub worker show 的“原始记录”同一个找法）。
// 上限都在 shared/limits.ts（TAKEOVER_*）：最多带最近 TAKEOVER_PREDECESSORS_MAX 个前任，汇报和最后的文字各前任合计。
import type { AgentSessionRow, WorkerId } from "../../shared/domain.ts";
import {
  TAKEOVER_REPORTS_MAX_CHARS,
  TAKEOVER_STEPS_MAX,
  TAKEOVER_TAIL_TEXT_MAX_CHARS,
} from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { vendorLabel } from "../../shared/vendors.ts";
import { UNFORMATTED_LABEL, WORKER_REPORT_STATUS_LABELS, unwrapWorkerReportText } from "../../shared/worker.ts";
import type { WorkerReportStatus } from "../../shared/worker.ts";
import type { LedgerContext } from "./context.ts";
import type { WorkerDbRow } from "./rows.ts";
import type { LedgerSteps } from "./steps.ts";
import { formatClock, formatLogSteps } from "./worker-view.ts";

/** 第一条消息开头的标签（Worker 提示词里说明了它是什么，prompt.ts 的 workerRoleSection）。 */
export const TAKEOVER_TAG = "【系统 · 接手】";

/** 一次最多从库里读多少条汇报、多少段文字（再多也放不进字数上限，读多了白费）。 */
const TAKEOVER_ROWS_SCAN = 50;

export interface TakeoverPredecessor {
  worker: WorkerDbRow;
  session: AgentSessionRow;
  /** 换人时它的收工情况（workers.ts 定）：比如“换人时它还开着，后台已把它收工”。 */
  endedNote: string;
}

export interface TakeoverMessageInput {
  graph: { id: number; title: string };
  node: { key: string; title: string; index: number; total: number };
  /** 新接手的 Worker 编号与标题。 */
  worker?: { id: WorkerId; title: string };
  /** 从新到旧，最多 TAKEOVER_PREDECESSORS_MAX 个。 */
  predecessors: readonly TakeoverPredecessor[];
  /** 在哪干活的那一句（接手前任的目录、新开的 worktree、主文件夹，以及只读说明）。 */
  workspaceNote: string;
  /** 原始任务说明（由于静态系统提示词不再拼入动态任务，统一在首条消息给出）。 */
  task?: string | null;
  /** 上一步移交来的交棒说明（若有）。 */
  upstreamHandoff?: string | null;
  /** 项目经理的补充（hub worker start --node 的正文），没给是 null。 */
  pmNote: string | null;
}

export type FindTranscript = (ref: { vendor: string; vendorSessionId: string; cwd: string }) => string | null;

/** 从后往前留下最多 max 个字（按 Unicode 码点）；截掉了前面的，开头加省略号。 */
function keepTail(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `…${chars.slice(chars.length - Math.max(0, max - 1)).join("")}`;
}

/** 从前往后留下最多 max 个字；截掉了后面的，结尾加省略号。 */
function keepHead(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

const charLength = (text: string) => [...text].length;
const REPORT_SEP = "\n\n---\n\n";
const REPORT_SEP_CHARS = charLength(REPORT_SEP);
const TAIL_SEP = "\n\n";
const TAIL_SEP_CHARS = charLength(TAIL_SEP);
const REASON_SUMMARY_MAX_CHARS = 300;
const oneLineSummary = (text: string): string => keepHead(text.replace(/\s+/g, " ").trim(), REASON_SUMMARY_MAX_CHARS);

const STATUS_LABELS: Readonly<Record<string, string>> = { ...WORKER_REPORT_STATUS_LABELS, unformatted: UNFORMATTED_LABEL };

export function createLedgerTakeover(ctx: Pick<LedgerContext, "db" | "now">, steps: Pick<LedgerSteps, "rows">, options: { findTranscript?: FindTranscript } = {}) {
  const { db, now } = ctx;
  const findTranscript = options.findTranscript ?? (() => null);

  /** 项目经理对话里这个 Worker 那几行（report、turn_failed、worktree_failed），从新到旧。 */
  const outcomeLines = (w: WorkerDbRow, events: readonly string[], limit: number) =>
    db.all<{ id: number; text: string; event: string; status: string | null; summary: string | null }>(
      `SELECT id, text, json_extract(meta, '$.event') AS event, json_extract(meta, '$.status') AS status, json_extract(meta, '$.summary') AS summary
         FROM messages
        WHERE conversation_id = ? AND worker_id = ? AND kind = 'worker' AND json_valid(meta)
          AND json_extract(meta, '$.event') IN (${events.map(() => "?").join(", ")})
        ORDER BY id DESC LIMIT ?`,
      w.pm_conversation_id,
      w.id,
      ...events,
      limit,
    );

  /** 为什么停：最后一行汇报 / 没做完 / 建 worktree 失败，加上收工的情况。 */
  const reasonOf = (p: TakeoverPredecessor): string => {
    const last = outcomeLines(p.worker, ["report", "turn_failed", "worktree_failed"], 1)[0];
    const summary = last?.summary ? oneLineSummary(last.summary) : null;
    let why: string;
    if (last === undefined) why = "它还没交过汇报";
    else if (last.event === "turn_failed") why = `最后一轮没做完：${summary ?? "没有给出原因"}`;
    else if (last.event === "worktree_failed") why = `建 worktree 失败：${summary ?? "没有给出原因"}`;
    else {
      const label = STATUS_LABELS[last.status ?? ""] ?? (last.status as WorkerReportStatus | null) ?? UNFORMATTED_LABEL;
      why = `最后一轮汇报“${label}”${summary ? `：${summary}` : ""}`;
    }
    return `${why}。${p.endedNote}`;
  };

  /** 汇报原文（去掉“【Worker #… 的汇报】”那一行），从新到旧，用掉的字数从 budget 里扣。 */
  const reportsOf = (p: TakeoverPredecessor, budget: { left: number }): string => {
    const rows = outcomeLines(p.worker, ["report"], TAKEOVER_ROWS_SCAN);
    if (rows.length === 0) return "（没有汇报）";
    const parts: string[] = [];
    let skipped = 0;
    for (const row of rows) {
      const sepCost = parts.length === 0 ? 0 : REPORT_SEP_CHARS;
      if (budget.left <= sepCost) {
        skipped++;
        continue;
      }
      const body = unwrapWorkerReportText(p.worker, row.text).trim();
      const shown = keepHead(body, budget.left - sepCost);
      budget.left -= sepCost + charLength(shown);
      parts.push(shown);
    }
    const joined = parts.join(REPORT_SEP);
    if (skipped === 0) return joined;
    const omittedNote = `（更早的 ${skipped} 份汇报放不下了，没带上；要看去翻原始记录）`;
    return joined === "" ? omittedNote : `${joined}${REPORT_SEP}${omittedNote}`;
  };

  /** 最后一行汇报之后它写的文字（还没来得及汇报的），从旧到新，留最后 budget 个字。 */
  const tailTextOf = (p: TakeoverPredecessor, budget: { left: number }): string => {
    const lastReport = outcomeLines(p.worker, ["report"], 1)[0]?.id ?? 0;
    const rows = db.all<{ text: string }>(
      `SELECT text FROM messages
        WHERE conversation_id = ? AND sender = 'agent' AND kind = 'text' AND id > ?
        ORDER BY id DESC LIMIT ?`,
      p.worker.worker_conversation_id,
      lastReport,
      TAKEOVER_ROWS_SCAN,
    );
    const kept: string[] = [];
    for (const row of rows) {
      const text = row.text.trim();
      if (text === "") continue;
      const sepCost = kept.length === 0 ? 0 : TAIL_SEP_CHARS;
      if (budget.left <= sepCost) break;
      const shown = keepTail(text, budget.left - sepCost);
      budget.left -= sepCost + charLength(shown);
      kept.unshift(shown);
    }
    return kept.length === 0 ? "（最后一份汇报之后它没再写什么）" : kept.join(TAIL_SEP);
  };

  /** 最后 TAKEOVER_STEPS_MAX 步操作，hub worker log 的写法（从旧到新）。 */
  const stepsOf = (p: TakeoverPredecessor): { count: number; text: string } => {
    const shown = formatLogSteps(steps.rows(p.session.id), false, now()).slice(-TAKEOVER_STEPS_MAX);
    if (shown.length === 0) return { count: 0, text: "（没有记录到操作）" };
    return { count: shown.length, text: shown.map((s) => `${formatClock(s.at)} ${s.text}`).join("\n") };
  };

  const transcriptOf = (session: AgentSessionRow): string => {
    try {
      return findTranscript({ vendor: session.vendor, vendorSessionId: session.vendorSessionId, cwd: session.cwd }) ?? "找不到";
    } catch {
      return "找不到";
    }
  };

  /** 新 Worker 的第一条消息（设计第 9.4 节的模板；几个前任按从新到旧各出一段）。 */
  const takeoverMessage = (input: TakeoverMessageInput): string => {
    const { graph, node, predecessors } = input;
    const reports = { left: TAKEOVER_REPORTS_MAX_CHARS };
    const tail = { left: TAKEOVER_TAIL_TEXT_MAX_CHARS };
    const many = predecessors.length > 1 ? `（带了最近 ${predecessors.length} 个前任，从新到旧）` : "";
    const who = input.worker ? `你是 Worker #${input.worker.id}（${input.worker.title}），` : "";
    const head =
      `${TAKEOVER_TAG}任务图 #${graph.id}「${graph.title}」第 ${node.index}/${node.total} 步「${node.title}」。` +
      `${who}前任没做完，下面是后台自动带过来的记录${many}。${input.workspaceNote}`;
    const blocks = predecessors.map((p) => {
      const s = stepsOf(p);
      return [
        `## 前任 Worker #${p.worker.id}（${vendorLabel(p.session.vendor)}）停下的原因`,
        reasonOf(p),
        `## 它的汇报（从新到旧）`,
        reportsOf(p, reports),
        `## 它最后说的话`,
        tailTextOf(p, tail),
        `## 它最后 ${s.count} 步操作`,
        s.text,
        `原始记录：${transcriptOf(p.session)}`,
      ].join("\n\n");
    });
    const taskText = input.task?.trim() ?? "";
    const tailParts = [
      `## 你的任务`,
      taskText !== ""
        ? `${taskText}\n\n接着前任的进度做，前任已经做过、验证过的不要从头再来；前任的结论拿不准的先核实（忘了背景可跑 \`${HUB_COMMAND} status\` 查看）。`
        : `接着前任的进度做，前任已经做过、验证过的不要从头再来；前任的结论拿不准的先核实（可跑 \`${HUB_COMMAND} status\` 查看任务说明）。`,
    ];
    if (input.upstreamHandoff && input.upstreamHandoff.trim() !== "") {
      const trimmedUp = input.upstreamHandoff.trim();
      if (trimmedUp.startsWith("## ")) {
        tailParts.push(trimmedUp);
      } else {
        tailParts.push(`## 上一步交给你的话（原样转交）`, trimmedUp);
      }
    }
    if (input.pmNote !== null) tailParts.push(`## 项目经理的补充`, input.pmNote.trim());
    return [head, ...blocks, tailParts.join("\n\n")].join("\n\n");
  };

  return { takeoverMessage };
}

export type LedgerTakeover = ReturnType<typeof createLedgerTakeover>;

/** 给 workers.ts 的：前任按从新到旧排的编号（节点上 worker_ids_json 是从旧到新）。 */
export function newestFirst(ids: readonly WorkerId[], max: number): WorkerId[] {
  return [...ids].reverse().slice(0, max);
}
