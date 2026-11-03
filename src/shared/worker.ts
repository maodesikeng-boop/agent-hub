// Worker 的汇报（m3-plan 第 2.5 节）：格式说明、解析、回到项目经理那一行的写法、分支名。
// 格式说明（给 Worker 的提示词用）和解析函数放在一起，改格式只改这里。
import type { TicketId, WorkerEvent, WorkerLineStatus } from "./domain.ts";
import { WORKER_BRANCH_SLUG_CHARS } from "./limits.ts";

export const REPORT_START = "=== 汇报 ===";
export const REPORT_END = "=== 汇报结束 ===";

/** 汇报里“状态”的三种：做完了 / 有问题 / 放弃了。 */
export const WORKER_REPORT_STATUSES = ["done", "problem", "gave_up"] as const;
export type WorkerReportStatus = (typeof WORKER_REPORT_STATUSES)[number];

export const WORKER_REPORT_STATUS_LABELS: Readonly<Record<WorkerReportStatus, string>> = {
  done: "做完了",
  problem: "有问题",
  gave_up: "放弃了",
};

/** 找不到格式、状态写错、没写摘要时那一行写的字。原文照样交给项目经理，由它看原文判断。 */
export const UNFORMATTED_LABEL = "没按格式";

/**
 * Worker 每一轮最后一条回复要以这段结尾（照设计 8.4，删掉了“证据”）。W3 原样放进 Worker 的提示词。
 * 这段本身把状态换成三种之一就能被 parseWorkerReport 认出来。
 */
export const WORKER_REPORT_FORMAT = `${REPORT_START}
状态: 做完了 | 有问题 | 放弃了
摘要: 一两句
提交: <提交号>（没有写“无”）
测试: <跑了什么，结果>
问题: <要项目经理回答什么、要问用户什么，或者建议改哪个记忆文件>
${REPORT_END}`;

export interface WorkerReport {
  status: WorkerReportStatus;
  summary: string;
  /** 写“无”是 null。 */
  commit: string | null;
  /** 没写是空串。 */
  tests: string;
  /** 没写是空串。 */
  questions: string;
}

export type ParsedWorkerReport = { kind: "ok"; report: WorkerReport } | { kind: "unformatted" };

const FIELDS = { 状态: "status", 摘要: "summary", 提交: "commit", 测试: "tests", 问题: "questions" } as const;
type FieldKey = keyof typeof FIELDS;
const FIELD_LINE = /^(状态|摘要|提交|测试|问题)\s*[:：]\s*(.*)$/;
const NO_COMMIT = "无";

/** 最后一段完整的 REPORT_START … REPORT_END 中间的文字；没有返回 null。 */
function lastBlock(text: string): string | null {
  let end = text.lastIndexOf(REPORT_END);
  while (end !== -1) {
    const start = text.lastIndexOf(REPORT_START, end);
    if (start !== -1) return text.slice(start + REPORT_START.length, end);
    end = end === 0 ? -1 : text.lastIndexOf(REPORT_END, end - 1);
  }
  return null;
}

/**
 * 从 Worker 这一轮最后一段文字里找汇报。有好几段取最后一段完整的（有开头也有结尾）。
 * 每项一行 `名字: 值`（全角冒号也认），首尾空白去掉；不以这五个名字开头的行接在上一项后面（换行连着）。
 * 状态不是三种之一、没写摘要 → unformatted。提交、测试、问题可以不写。
 */
export function parseWorkerReport(text: string): ParsedWorkerReport {
  const block = lastBlock(text.replaceAll("\r\n", "\n"));
  if (block === null) return { kind: "unformatted" };
  const values: Partial<Record<FieldKey, string>> = {};
  let current: FieldKey | null = null;
  for (const line of block.split("\n")) {
    const match = FIELD_LINE.exec(line.trim());
    if (match !== null) {
      current = match[1] as FieldKey;
      values[current] = match[2]!;
    } else if (current !== null) {
      values[current] = `${values[current]}\n${line}`;
    }
  }
  const field = (key: FieldKey) => (values[key] ?? "").trim();
  const status = WORKER_REPORT_STATUSES.find((s) => WORKER_REPORT_STATUS_LABELS[s] === field("状态"));
  const summary = field("摘要");
  if (status === undefined || summary === "") return { kind: "unformatted" };
  const commit = field("提交");
  return {
    kind: "ok",
    report: { status, summary, commit: commit === "" || commit === NO_COMMIT ? null : commit, tests: field("测试"), questions: field("问题") },
  };
}

/** 交给项目经理的汇报的开头（设计第 7.3 节的来源标签）：“【Worker #3 · 修 X 的汇报】”。 */
export function workerReportHeader(ticketId: TicketId, title: string): string {
  return `【Worker #${ticketId} · ${title} 的汇报】`;
}

const EVENT_LABELS: Readonly<Record<Exclude<WorkerEvent, "report">, string>> = {
  started: "已派出",
  turn_failed: "这一轮没做完",
  worktree_failed: "建 worktree 失败",
  ended: "已收工",
};

/**
 * 项目经理对话里那一行给人看的字：“Worker · 标题 · 状态：摘要”。参数就是 WorkerMessageMeta 里的这几项。
 * 网页直接显示它；只读的“已派出”后面带“（只读）”。
 */
export function workerLineText(line: {
  title: string;
  event: WorkerEvent;
  status: WorkerLineStatus | null;
  summary: string | null;
  readonly: boolean;
}): string {
  const state =
    line.event === "report"
      ? line.status === null || line.status === "unformatted"
        ? UNFORMATTED_LABEL
        : WORKER_REPORT_STATUS_LABELS[line.status]
      : EVENT_LABELS[line.event];
  const suffix = line.event === "started" && line.readonly ? "（只读）" : "";
  const detail = line.summary === null || line.summary === "" ? "" : `：${line.summary}`;
  return `Worker · ${line.title} · ${state}${suffix}${detail}`;
}

/**
 * Worker 的分支名 hub/<编号>-<短名>（设计 7.7）。短名取标题：小写，字母、数字（含中文）以外的连成一个 -，
 * 去掉首尾的 -，最多 WORKER_BRANCH_SLUG_CHARS 个字符；什么都不剩就只有 hub/<编号>。
 * 结果一定是合法的 git 分支名（不含空白、~^:?*[\ 、..、@{）。
 */
export function workerBranchName(ticketId: TicketId, title: string): string {
  const slug = [...title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")]
    .slice(0, WORKER_BRANCH_SLUG_CHARS)
    .join("")
    .replace(/-+$/, "");
  return slug === "" ? `hub/${ticketId}` : `hub/${ticketId}-${slug}`;
}
