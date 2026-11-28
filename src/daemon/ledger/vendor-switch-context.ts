import { agentTextOf } from "../../shared/attachments.ts";
import {
  askOf,
  isHandoverTraffic,
  stripSystemPrefix,
  systemEventOf,
  workerEventOf,
  type Message,
  type MessageId,
  type MessageStatus,
  type SessionId,
  type SystemMessageMeta,
  type WorkerEvent,
} from "../../shared/domain.ts";
import {
  VENDOR_SWITCH_CONTEXT_MAX_BYTES,
  VENDOR_SWITCH_MESSAGE_SCAN_LIMIT,
  VENDOR_SWITCH_TRANSCRIPTS_MAX,
} from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { isRewoundMessage } from "../../shared/rewind.ts";
import { isAgentVendor, vendorLabel, vendorSpec } from "../../shared/vendors.ts";

export interface GenerationAnchor {
  readonly summaryText: string | null;
  readonly cutMessageId: MessageId;
  readonly startSessionId: SessionId;
}

export interface PriorSessionTranscriptRef {
  readonly id: SessionId;
  readonly vendor: string;
  readonly vendorSessionId: string;
  readonly cwd: string;
}

export type TranscriptLookup = (ref: { vendor: string; vendorSessionId: string; cwd: string }) => string | null;

export const VENDOR_SWITCH_ANCHOR_HINT =
  "下面的摘要覆盖本代起点之前的历史背景；如与下方的本代对话进展冲突，一律以本代最新对话和实时状态为准。";

export const VENDOR_SWITCH_TRUNCATED_HINT =
  "（注：本代更早的消息因窗口保底上限已省略，以下为离当前最近的内容）";

const TARGET_IN_FLIGHT: ReadonlySet<MessageStatus> = new Set(["queued", "delivered", "processing"]);

const INCLUDED_WORKER_EVENTS: ReadonlySet<WorkerEvent> = new Set([
  "report",
  "turn_failed",
  "worktree_failed",
  "user_message",
]);

export const SYSTEM_EVENT_IN_SWITCH_LOG: Readonly<Record<SystemMessageMeta["event"], boolean>> = {
  "checklist.reminder": false,
  "driver.warning": false,
  "project.created": true,
  "folder.attached": true,
  "folder.detached": true,
  "persona.changed": false,
  "handover.requested": false,
  "session.renewed": false,
  "handover.failed": false,
  "schedule.created": false,
  "schedule.removed": false,
  "schedule.run": true,
  "schedule.failed": true,
  "context.compacted": false,
  "worker.max_time_exceeded": true,
  "worker.background_wait": true,
  "task_graph.ready_to_finish": true,
  "pm.wakeup": true,
};

function formatPmAgentText(message: Message): string {
  const ask = askOf(message);
  if (ask === null) return message.text;
  const statusLabel =
    ask.chosenOption !== undefined ? `已选「${ask.chosenOption}」` : ask.answered === true ? "已回答" : "待用户确认";
  if (ask.options !== undefined && ask.options.length > 0) {
    const optsLabel = ask.options
      .map((opt, idx) => `${idx + 1}. ${opt}${ask.recommended === opt ? "（推荐）" : ""}`)
      .join(" / ");
    const note = `[选项：${optsLabel}；状态：${statusLabel}]`;
    return message.text.trim() === "" ? note : `${message.text}\n${note}`;
  }
  return `${message.text}\n[状态：${statusLabel}]`;
}

export function formatGenerationMessage(message: Message, targetSessionId: SessionId): string | null {
  if (message.status === "queued" || message.status === "cancelled") return null;
  if (message.sessionId === targetSessionId && message.status !== null && TARGET_IN_FLIGHT.has(message.status)) {
    return null;
  }
  if (message.sender === "user") {
    if (message.kind !== "text" || isRewoundMessage(message)) return null;
    return `用户：${agentTextOf(message)}`;
  }
  if (message.sender === "agent") {
    if (message.kind !== "text" || isHandoverTraffic(message)) return null;
    return `你：${formatPmAgentText(message)}`;
  }
  if (message.sender === "system" && message.kind === "worker") {
    const wm = workerEventOf(message);
    if (wm === null || !INCLUDED_WORKER_EVENTS.has(wm.event)) return null;
    return message.text;
  }
  if (message.sender === "system" && message.kind === "text") {
    const ev = systemEventOf(message);
    if (ev === null || !SYSTEM_EVENT_IN_SWITCH_LOG[ev.event]) return null;
    const stripped = stripSystemPrefix(message.text).trim();
    if (stripped === "") return null;
    return stripped.startsWith("【") ? stripped : `【系统通知】${stripped}`;
  }
  return null;
}

export function collectGenerationEntriesNewestFirst(
  messagesNewestFirst: Iterable<Message>,
  options: {
    targetSessionId: SessionId;
    maxBytes?: number;
    maxScanRows?: number;
  },
): { entries: string[]; truncated: boolean; scannedRows: number } {
  const maxBytes = options.maxBytes ?? VENDOR_SWITCH_CONTEXT_MAX_BYTES;
  const maxScanRows = options.maxScanRows ?? VENDOR_SWITCH_MESSAGE_SCAN_LIMIT;
  const entries: string[] = [];
  let collectedBytes = 0;
  let scannedRows = 0;
  let truncated = false;

  for (const message of messagesNewestFirst) {
    if (scannedRows >= maxScanRows) {
      truncated = true;
      break;
    }
    scannedRows += 1;
    const formatted = formatGenerationMessage(message, options.targetSessionId);
    if (formatted === null) continue;
    entries.push(formatted);
    collectedBytes += (entries.length > 1 ? 2 : 0) + Buffer.byteLength(formatted, "utf8");
    // Keep one entry past maxBytes so assembleBudgetedPreamble observes truncation and can tail-slice it.
    if (collectedBytes > maxBytes) {
      truncated = true;
      break;
    }
  }
  return { entries, truncated, scannedRows };
}

export function describeGenerationTranscripts(
  priorSessionsNewestFirst: readonly PriorSessionTranscriptRef[],
  findTranscript: TranscriptLookup,
): string {
  const chronological = priorSessionsNewestFirst.slice(0, VENDOR_SWITCH_TRANSCRIPTS_MAX).reverse();
  if (chronological.length === 0) {
    return "本代前序会话的原始记录：本代暂无前序会话记录";
  }
  const readablePaths: string[] = [];
  const unreadableVendors: string[] = [];
  for (const s of chronological) {
    const label = `${vendorLabel(s.vendor)}（${s.vendor}）`;
    const portable = !isAgentVendor(s.vendor) || vendorSpec(s.vendor).handover?.transcriptPortable !== false;
    if (!portable) {
      if (!unreadableVendors.includes(label)) unreadableVendors.push(label);
      continue;
    }
    const path = findTranscript({ vendor: s.vendor, vendorSessionId: s.vendorSessionId, cwd: s.cwd });
    if (path !== null) {
      readablePaths.push(`${label}：${path}`);
    }
  }
  if (readablePaths.length > 0 && unreadableVendors.length === 0) {
    return `本代前序会话的原始记录（如需核对工具输出原文可按路径查阅）：${readablePaths.join("；")}`;
  }
  if (readablePaths.length > 0 && unreadableVendors.length > 0) {
    return `本代前序会话的原始记录：可读记录——${readablePaths.join("；")}；另 ${unreadableVendors.join("、")} 的会话格式不可跨厂商直接读取`;
  }
  if (unreadableVendors.length > 0) {
    return `本代前序会话的原始记录：${unreadableVendors.join("、")} 的会话格式不可跨厂商直接读取，请直接依据下方本代完整记录与账本命令处理`;
  }
  return "本代前序会话的原始记录：未找到本机记录文件，请直接依据下方本代完整记录与账本命令处理";
}

export function vendorSwitchPreambleHeader(input: {
  fromVendor: string;
  toVendor: string;
  hasSkills: boolean;
  transcriptSummary: string;
}): string {
  const searchCmds = `\`${HUB_COMMAND} worker search\`、\`${HUB_COMMAND} worker show --task / --report\``;
  return [
    `【系统】你还是同一个项目经理，用户刚把你的运行厂商从 ${vendorLabel(input.fromVendor)}（${input.fromVendor}）切换到了 ${vendorLabel(input.toVendor)}（${input.toVendor}）。`,
    `下面${input.hasSkills ? "先附上上一个会话加载过的技能索引，再" : ""}按时间顺序完整附上了当前这一代会话迄今的全部上下文（用户那边仍是同一个连续对话，不要向用户提及切换了会话或回复“已接手”，读完直接回应本段末尾的最新消息；历史中提到的他厂专属工具名按你当前可用的工具理解）。`,
    `做过的历史任务细节可用 ${searchCmds} 查账本；${input.transcriptSummary}。`,
  ].join("\n");
}
