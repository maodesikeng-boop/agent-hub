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
import { formatClock, formatLogSteps, type createWorkerActivity } from "./worker-activity.ts";

export const TAKEOVER_TAG = "【系统 · 接手】";

const TAKEOVER_ROWS_SCAN = 50;

export interface TakeoverPredecessor {
  worker: WorkerDbRow;
  session: AgentSessionRow;
  endedNote: string;
}

export interface TakeoverMessageInput {
  graph: { id: number; title: string };
  node: { key: string; title: string; index: number; total: number };
  worker?: { id: WorkerId; title: string };
  predecessors: readonly TakeoverPredecessor[];
  workspaceNote: string;
  task?: string | null;
  upstreamHandoff?: string | null;
  pmNote: string | null;
}

export type FindTranscript = (ref: { vendor: string; vendorSessionId: string; cwd: string }) => string | null;

function keepTail(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `…${chars.slice(chars.length - Math.max(0, max - 1)).join("")}`;
}

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

export function createLedgerTakeover(ctx: Pick<LedgerContext, "db">, activityOf: ReturnType<typeof createWorkerActivity>, options: { findTranscript?: FindTranscript } = {}) {
  const { db } = ctx;
  const findTranscript = options.findTranscript ?? (() => null);

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

  const stepsOf = (p: TakeoverPredecessor): { count: number; text: string } => {
    const shown = formatLogSteps(activityOf(p.session.id), null).slice(-TAKEOVER_STEPS_MAX);
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

export function newestFirst(ids: readonly WorkerId[], max: number): WorkerId[] {
  return [...ids].reverse().slice(0, max);
}
