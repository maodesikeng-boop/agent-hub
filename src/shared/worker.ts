// Worker 的汇报（m3-plan 第 2.5 节）：格式说明、解析、回到项目经理那一行的写法、分支名。
// 格式说明（给 Worker 的提示词用）和解析函数放在一起，改格式只改这里。
import { agentTextOf } from "./attachments.ts";
import { truncateChars } from "./domain.ts";
import type { Message, WorkerId, WorkerEvent, WorkerLineStatus } from "./domain.ts";
import { WORKER_BRANCH_SLUG_CHARS, WORKER_LINE_SUMMARY_CHARS } from "./limits.ts";
import { WORKER_BRANCH_PREFIX } from "./names.ts";

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

/**
 * ok：认出了汇报，摘要等是完整的（不截断，原文另外整段交给项目经理）。
 * unformatted：没按格式，summary 是原文第一行不空的那行，压过空白、按 WORKER_LINE_SUMMARY_CHARS 截断（全是空白就是空串），
 * 账本放进那一行的 WorkerMessageMeta.summary。
 */
export type ParsedWorkerReport = { kind: "ok"; report: WorkerReport } | { kind: "unformatted"; summary: string };

type FieldKey = "状态" | "摘要" | "提交" | "测试" | "问题";
/**
 * 一项的开头：行首可以有 Markdown 的列表符号、引用（- * > 和空白），名字可以加粗（**状态**: 或 **状态:**），冒号全角半角都行。
 */
const FIELD_LINE = /^[-*>\s]*(?:\*\*)?(状态|摘要|提交|测试|问题)\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*)$/u;
/** 状态值首尾的标点、符号（“做完了。”“「做完了」”“**做完了**”）。 */
const EDGE_PUNCTUATION = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;
/** 提交写“无”，或者“无”后面跟着说明（“无（没提交）”“无，只读调查”）：都当没有提交。提交号不会以“无”开头。 */
const NO_COMMIT = "无";

/** 压空白：连续的空白（含换行）变成一个空格，去首尾。 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** 原文第一行不空的那行，压过空白、截断：没按格式时那一行的摘要。 */
function firstLineSummary(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return truncateChars(collapseWhitespace(line), WORKER_LINE_SUMMARY_CHARS);
}

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
 * 每项一行 `名字: 值`（Markdown 的列表、引用、加粗写法也认，见 FIELD_LINE），首尾空白去掉；
 * 不以这五个名字开头的行接在上一项后面（换行连着）。状态值去掉首尾的标点再比。
 * 状态不是三种之一、没写摘要 → unformatted。提交、测试、问题可以不写。
 */
export function parseWorkerReport(text: string): ParsedWorkerReport {
  const normalized = text.replaceAll("\r\n", "\n");
  const block = lastBlock(normalized);
  const unformatted = (): ParsedWorkerReport => ({ kind: "unformatted", summary: firstLineSummary(normalized) });
  if (block === null) return unformatted();
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
  const statusText = field("状态").replace(EDGE_PUNCTUATION, "");
  const status = WORKER_REPORT_STATUSES.find((s) => WORKER_REPORT_STATUS_LABELS[s] === statusText);
  const summary = field("摘要");
  if (status === undefined || summary === "") return unformatted();
  const commit = field("提交");
  return {
    kind: "ok",
    report: { status, summary, commit: commit === "" || commit.startsWith(NO_COMMIT) ? null : commit, tests: field("测试"), questions: field("问题") },
  };
}

/** 交给项目经理的汇报的开头（设计第 7.3 节的来源标签）：“【Worker #3 · 修 X 的汇报】”。 */
export function workerReportHeader(workerId: WorkerId, title: string): string {
  return `【Worker #${workerId} · ${title} 的汇报】`;
}

/**
 * 用户在网页的 Worker 页面直接对它说的话，交给项目经理时的开头（来源标签）：
 * “【用户直接对 Worker #3 · 修 X 说的话（Worker 已收到）】”。
 */
export function userToWorkerHeader(workerId: WorkerId, title: string): string {
  return `【用户直接对 Worker #${workerId} · ${title} 说的话（Worker 已收到）】`;
}

/** 用户直接对 Worker 说的话写给 Worker 时的开头；项目经理的话不带标签。 */
export const USER_TO_WORKER_TAG = "【用户直接对你说】";

/**
 * 一条消息写给 agent 的内容（session.send 的处理函数用，交给 DriverSendInput 的 text、prefixes）：
 * - text：用户写的字 + 附件的完整路径（attachments.ts 的 agentTextOf），原文以 / 开头的照样以 / 开头；
 * - prefixes：Worker 对话里用户说的（sender user、带 workerId）带 USER_TO_WORKER_TAG，驱动层把它放在原文前面单独一块
 *   （原文单独放最后一块，/ 命令才会被展开，见 docs/composer-commands.md 的 T4）；别的没有标签。
 * 库里存的是原文，网页照原文显示。
 */
export function deliveryParts(message: Pick<Message, "workerId" | "sender" | "text" | "meta">): { prefixes: string[]; text: string } {
  const text = agentTextOf(message);
  return { prefixes: message.workerId !== null && message.sender === "user" ? [USER_TO_WORKER_TAG] : [], text };
}

const EVENT_LABELS: Readonly<Record<Exclude<WorkerEvent, "report">, string>> = {
  started: "已派出",
  turn_failed: "这一轮没做完",
  worktree_failed: "建 worktree 失败",
  ended: "已收工",
  user_message: "你对它说",
};

/**
 * 项目经理对话里那一行给人看的字：“Worker「标题」状态：摘要”。参数就是 WorkerMessageMeta 里的这几项。
 * 网页直接显示它；只读的“已派出”后面带“（只读）”。摘要的空白（含换行）压成一个空格，超过 WORKER_LINE_SUMMARY_CHARS 个字符截断。
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
  const summary = line.summary === null ? "" : truncateChars(collapseWhitespace(line.summary), WORKER_LINE_SUMMARY_CHARS);
  const detail = summary === "" ? "" : `：${summary}`;
  return `Worker「${line.title}」${state}${suffix}${detail}`;
}

/**
 * Worker 的分支名 hub/<编号>-<短名>（设计 7.7）。短名取标题：先 NFC（é 不拆成 e + 附加符号），小写，
 * 字母、数字（含中文）、组合用的附加符号（\p{M}，梵文等要靠它）以外的连成一个 -，
 * 去掉首尾的 -，最多 WORKER_BRANCH_SLUG_CHARS 个字符；什么都不剩就只有 hub/<编号>。
 * 结果一定是合法的 git 分支名（不含空白、~^:?*[\ 、..、@{）。
 */
export function workerBranchName(workerId: WorkerId, title: string): string {
  const slug = [...title.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")]
    .slice(0, WORKER_BRANCH_SLUG_CHARS)
    .join("")
    .replace(/-+$/, "");
  return slug === "" ? `${WORKER_BRANCH_PREFIX}${workerId}` : `${WORKER_BRANCH_PREFIX}${workerId}-${slug}`;
}
