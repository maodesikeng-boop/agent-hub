import { agentTextOf } from "./attachments.ts";
import { truncateChars } from "./domain.ts";
import { feishuDeliveryPrefixes, feishuOriginOf } from "./feishu.ts";
import type { Message, WorkerId, WorkerEvent, WorkerLineStatus } from "./domain.ts";
import { WORKER_BRANCH_SLUG_CHARS, WORKER_LINE_SUMMARY_CHARS } from "./limits.ts";
import { WORKER_BRANCH_PREFIX } from "./names.ts";
import { parseReviewCommit, parseReviewVerdict, type ReviewVerdict } from "./review.ts";
import { isAgentVendor } from "./vendors.ts";
import type { AgentVendor } from "./vendors.ts";

export const REPORT_START = "=== 汇报 ===";
export const REPORT_END = "=== 汇报结束 ===";

export const WORKER_REPORT_STATUSES = ["done", "problem", "gave_up"] as const;
export type WorkerReportStatus = (typeof WORKER_REPORT_STATUSES)[number];

export const WORKER_REPORT_STATUS_LABELS: Readonly<Record<WorkerReportStatus, string>> = {
  done: "做完了",
  problem: "有问题",
  gave_up: "放弃了",
};

export const UNFORMATTED_LABEL = "没按格式";

export const WORKER_REPORT_FORMAT = `${REPORT_START}
状态: 做完了 | 有问题 | 放弃了
摘要: 一两句
PR: <链接>（没有写“无”）
提交: <提交号>（没有写“无”）
测试: <跑了什么，结果>
偏离: 无 | <与任务说明或目标不一致的地方>
交棒: 无 | <给下一步接手的人：关键结论、改了哪几处、分支/目录状态与注意事项>
文件: 无 | <交给用户看的文件，一行一个 [标签](绝对路径)：方案、验收结论、截图、录屏（mp4）>
问题: 无 | <要项目经理回答什么、要用户拍板什么（写出选项和你的推荐），或者建议改哪个记忆文件>
${REPORT_END}`;

export interface WorkerReport {
  status: WorkerReportStatus;
  summary: string;
  commit: string | null;
  pr: string | null;
  tests: string;
  deviation: string | null;
  handoff: string;
  questions: string;
  files: string;
  verdict: ReviewVerdict | null;
  verifiedCommit: string | null;
}

export type ParsedWorkerReport = { kind: "ok"; report: WorkerReport } | { kind: "unformatted"; summary: string };

type FieldKey = "状态" | "摘要" | "提交" | "PR" | "测试" | "偏离" | "交棒" | "文件" | "问题" | "结论" | "验证提交";
const FIELD_LINE = /^([-*>\s]*)(?:\*\*)?(状态|摘要|提交|PR|pr|测试|偏离|交棒|文件|问题|结论|验证提交)\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*)$/u;
const CODE_FENCE_OPEN = /^\s*(`{3,}|~{3,})/u;
const EDGE_PUNCTUATION = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;
const NO_COMMIT = "无";
const NO_PR_PREFIX = /^无(?:$|[（(\s，,。；;：:—-])/u;
const NONE_WORDS = new Set(["无", "没有", "暂无", "none", "n/a"]);
const NONE_WITH_PAREN = /^无\s*[（(][^）)\r\n]*[）)][。.\s]*$/u;
const HTTP_URL_IN_TEXT = /https?:\/\/[^\s<>)"'）\]】]+/iu;

export function isReportFieldNone(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return true;
  if (NONE_WITH_PAREN.test(trimmed)) return true;
  const stripped = trimmed.replace(EDGE_PUNCTUATION, "").trim().toLowerCase();
  return stripped === "" || NONE_WORDS.has(stripped);
}

export function hasReportQuestion(questions: string): boolean {
  return !isReportFieldNone(questions);
}

export function extractReportPrUrl(pr: string | null | undefined): string | null {
  if (!pr) return null;
  const match = HTTP_URL_IN_TEXT.exec(pr.trim());
  if (match === null) return null;
  const url = match[0].replace(/[.,;。，；!！?？]+$/u, "");
  return /^https?:\/\/\S+$/iu.test(url) ? url : null;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function firstLineSummary(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return truncateChars(collapseWhitespace(line), WORKER_LINE_SUMMARY_CHARS);
}

function lastBlock(text: string): string | null {
  let end = text.lastIndexOf(REPORT_END);
  while (end !== -1) {
    const start = text.lastIndexOf(REPORT_START, end);
    if (start !== -1) return text.slice(start + REPORT_START.length, end);
    end = end === 0 ? -1 : text.lastIndexOf(REPORT_END, end - 1);
  }
  return null;
}

export function parseWorkerReport(text: string): ParsedWorkerReport {
  const normalized = text.replaceAll("\r\n", "\n");
  const block = lastBlock(normalized);
  const unformatted = (): ParsedWorkerReport => ({ kind: "unformatted", summary: firstLineSummary(normalized) });
  if (block === null) return unformatted();
  const values: Partial<Record<FieldKey, string>> = {};
  let current: FieldKey | null = null;
  let topStyle: { indent: number; hasBullet: boolean; hasQuote: boolean } | null = null;
  let inFence: { char: "`" | "~"; len: number } | null = null;
  for (const line of block.split("\n")) {
    if (inFence !== null) {
      if (current !== null) values[current] = `${values[current]}\n${line}`;
      const trimmed = line.trim();
      if (
        trimmed.length >= inFence.len &&
        [...trimmed].every((ch) => ch === inFence!.char)
      ) {
        inFence = null;
      }
      continue;
    }
    if (current !== null) {
      const openFence = CODE_FENCE_OPEN.exec(line);
      if (openFence !== null) {
        const marker = openFence[1]!;
        inFence = { char: marker[0] as "`" | "~", len: marker.length };
        values[current] = `${values[current]}\n${line}`;
        continue;
      }
    }
    const match = FIELD_LINE.exec(line.trimEnd());
    if (match !== null) {
      const prefix = match[1]!;
      const leadingWs = prefix.match(/^\s*/u)?.[0] ?? "";
      const indent = leadingWs.replace(/\t/g, "  ").length;
      const hasBullet = /[-*]/u.test(prefix);
      const hasQuote = prefix.includes(">");
      const isNestedContinuation =
        topStyle !== null &&
        current !== null &&
        (indent > topStyle.indent ||
          (!topStyle.hasBullet && hasBullet) ||
          (!topStyle.hasQuote && hasQuote));
      if (current !== null && isNestedContinuation) {
        values[current] = `${values[current]}\n${line}`;
      } else {
        if (topStyle === null) {
          topStyle = { indent, hasBullet, hasQuote };
        } else if (indent < topStyle.indent) {
          topStyle.indent = indent;
        }
        const rawKey = match[2]!;
        current = (rawKey.toUpperCase() === "PR" ? "PR" : rawKey) as FieldKey;
        values[current] = match[3]!;
      }
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
  const commitStripped = commit.replace(EDGE_PUNCTUATION, "").trim();
  const parsedCommit =
    commit === "" ||
    commitStripped === "" ||
    commit.startsWith(NO_COMMIT) ||
    NONE_WORDS.has(commitStripped.toLowerCase())
      ? null
      : commit;
  const prRaw = field("PR");
  const prStripped = prRaw.replace(EDGE_PUNCTUATION, "").trim();
  const pr =
    prRaw === "" || prStripped === "" || NO_PR_PREFIX.test(prRaw) || NONE_WORDS.has(prStripped.toLowerCase())
      ? null
      : prRaw;
  const filesRaw = field("文件");
  const deviationRaw = field("偏离");
  const deviation = isReportFieldNone(deviationRaw) ? null : deviationRaw;
  return {
    kind: "ok",
    report: {
      status,
      summary,
      commit: parsedCommit,
      pr,
      tests: field("测试"),
      deviation,
      handoff: field("交棒"),
      questions: field("问题"),
      files: isReportFieldNone(filesRaw) ? "" : filesRaw,
      verdict: parseReviewVerdict(field("结论")),
      verifiedCommit: parseReviewCommit(field("验证提交")),
    },
  };
}

export function workerReportHeader(workerId: WorkerId, title: string): string {
  return `【Worker #${workerId} · ${title} 的汇报】`;
}

const GRAPH_WAIT_ENVELOPE_HEAD = /^【任务图 #\d+[^\n]*等你处理】[^\n]*\n\n/u;
const GRAPH_WAIT_ENVELOPE_TAIL = /\n\n(?:回答或打回|换人)：[^\n]+。$/u;

export function unwrapWorkerReportText(worker: { id: WorkerId; title: string }, text: string): string {
  const head = `${workerReportHeader(worker.id, worker.title)}\n\n`;
  let body = text.startsWith(head) ? text.slice(head.length) : text;
  if (GRAPH_WAIT_ENVELOPE_HEAD.test(body)) {
    body = body.replace(GRAPH_WAIT_ENVELOPE_HEAD, "").replace(GRAPH_WAIT_ENVELOPE_TAIL, "");
  }
  return body;
}

export const USER_TO_WORKER_TAG = "【用户直接对你说】";

export interface WorkerPick {
  vendor: AgentVendor;
  model: string | null;
  effort: string | null;
}

export const WORKER_PICK_NOTE_START = "【用户指定：";

export function workerPickNote(pick: WorkerPick): string {
  const flags = [`--vendor ${pick.vendor}`, ...(pick.model === null ? [] : [`--model ${pick.model}`]), ...(pick.effort === null ? [] : [`--effort ${pick.effort}`])];
  return `${WORKER_PICK_NOTE_START}这条消息里派的 Worker 用 ${flags.join(" ")}】`;
}

export function workerPickOf(message: { meta: Record<string, unknown> | null }): WorkerPick | null {
  const raw = message.meta?.workerPick;
  if (typeof raw !== "object" || raw === null) return null;
  const { vendor, model, effort } = raw as Record<string, unknown>;
  if (!isAgentVendor(vendor) || (model !== null && typeof model !== "string") || (effort !== null && typeof effort !== "string")) return null;
  return { vendor, model, effort };
}

export function deliveryParts(message: Pick<Message, "workerId" | "sender" | "text" | "meta">): { prefixes: string[]; text: string } {
  const text = agentTextOf(message);
  const prefixes: string[] = [];
  if (message.sender === "user") {
    if (message.workerId !== null) prefixes.push(USER_TO_WORKER_TAG);
    const pick = workerPickOf(message);
    if (pick !== null) prefixes.push(workerPickNote(pick));
    const origin = feishuOriginOf(message);
    if (origin !== null) prefixes.push(...feishuDeliveryPrefixes(origin));
  }
  if (message.sender === "system" && typeof message.meta?.directChatSummary === "string") prefixes.push(message.meta.directChatSummary);
  return { prefixes, text };
}

const EVENT_LABELS: Readonly<Record<Exclude<WorkerEvent, "report">, string>> = {
  started: "已派出",
  turn_failed: "这一轮没做完",
  worktree_failed: "建 worktree 失败",
  ended: "已收工",
  user_message: "你对它说",
};

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

export function workerBranchName(workerId: WorkerId, title: string): string {
  const slug = [...title.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")]
    .slice(0, WORKER_BRANCH_SLUG_CHARS)
    .join("")
    .replace(/-+$/, "");
  return slug === "" ? `${WORKER_BRANCH_PREFIX}${workerId}` : `${WORKER_BRANCH_PREFIX}${workerId}-${slug}`;
}
