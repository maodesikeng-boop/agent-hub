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
  VENDOR_SWITCH_CONTEXT_MAX_CHARS,
  VENDOR_SWITCH_MESSAGE_SCAN_LIMIT,
  VENDOR_SWITCH_TRANSCRIPTS_MAX,
} from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { isRewoundMessage } from "../../shared/rewind.ts";
import { isAgentVendor, vendorLabel, vendorSpec } from "../../shared/vendors.ts";
import { OMITTED_MARK } from "./handover-recent.ts";

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

export interface CollectedGenerationContext {
  readonly body: string;
  readonly truncated: boolean;
  readonly scannedRows: number;
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

const INCLUDED_SYSTEM_EVENTS: ReadonlySet<SystemMessageMeta["event"]> = new Set([
  "schedule.run",
  "worker.max_time_exceeded",
  "task_graph.ready_to_finish",
  "project.created",
  "folder.attached",
  "folder.detached",
  "schedule.failed",
]);

/** 截取字符串末尾最多 maxUnits 个 UTF-16 码元；若切点落在低位代理项（0xDC00..0xDFFF）上则后移 1 位以保持合法码点。 */
export function sliceTailUtf16Safe(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return "";
  if (text.length <= maxUnits) return text;
  let start = text.length - maxUnits;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

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

/** 按真值表将单条本代消息格式化为继承上下文段落；不纳入的消息返回 null。 */
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
    if (ev === null || !INCLUDED_SYSTEM_EVENTS.has(ev.event)) return null;
    const stripped = stripSystemPrefix(message.text).trim();
    if (stripped === "") return null;
    return stripped.startsWith("【") ? stripped : `【系统通知】${stripped}`;
  }
  return null;
}

/** 倒序流式收集本代消息，按窗口保底字符预算与扫描行数护栏截断并还原为时间正序。 */
export function collectGenerationContext(
  messagesNewestFirst: Iterable<Message>,
  options: {
    targetSessionId: SessionId;
    maxChars?: number;
    maxScanRows?: number;
  },
): CollectedGenerationContext {
  const maxChars = options.maxChars ?? VENDOR_SWITCH_CONTEXT_MAX_CHARS;
  const maxScanRows = options.maxScanRows ?? VENDOR_SWITCH_MESSAGE_SCAN_LIMIT;
  const blocks: string[] = [];
  let used = 0;
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
    const sep = blocks.length > 0 ? 2 : 0;
    const remaining = maxChars - used - sep;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (formatted.length <= remaining) {
      blocks.push(formatted);
      used += sep + formatted.length;
      continue;
    }
    if (remaining > OMITTED_MARK.length) {
      const tail = sliceTailUtf16Safe(formatted, remaining - OMITTED_MARK.length);
      if (tail !== "") blocks.push(`${OMITTED_MARK}${tail}`);
    } else if (blocks.length === 0 && maxChars > 0) {
      const tail = sliceTailUtf16Safe(formatted, maxChars);
      if (tail !== "") blocks.push(tail);
    }
    truncated = true;
    break;
  }

  blocks.reverse();
  return { body: blocks.join("\n\n"), truncated, scannedRows };
}

/** 提取当前记忆代前序会话（输入为从新到旧）的原始记录说明：可读格式列路径，专有/压缩格式标明不可跨厂直读。 */
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

/** 拼装跨厂商切换首轮本代上下文继承说明（不走“交接”概念）。 */
export function buildVendorSwitchPreamble(input: {
  fromVendor: string;
  toVendor: string;
  anchor: GenerationAnchor;
  context: CollectedGenerationContext;
  transcriptSummary: string;
}): string {
  const searchCmds = `\`${HUB_COMMAND} worker search\`、\`${HUB_COMMAND} worker show --task / --report\``;
  const header = [
    `【系统】你还是同一个项目经理，用户刚把你的运行厂商从 ${vendorLabel(input.fromVendor)}（${input.fromVendor}）切换到了 ${vendorLabel(input.toVendor)}（${input.toVendor}）。`,
    "下面按时间顺序完整附上了当前这一代会话迄今的全部上下文（用户那边仍是同一个连续对话，不要向用户提及切换了会话或回复“已接手”，读完直接回应本段末尾的最新消息；历史中提到的他厂专属工具名按你当前可用的工具理解）。",
    `做过的历史任务细节可用 ${searchCmds} 查账本；${input.transcriptSummary}。`,
  ].join("\n");

  const sections = [header];
  if (input.anchor.summaryText !== null && input.anchor.summaryText.trim() !== "") {
    sections.push(`## 本代起点摘要（上次会话换代时保存的背景）\n\n${VENDOR_SWITCH_ANCHOR_HINT}\n\n${input.anchor.summaryText}`);
  }

  const logContent =
    input.context.body === ""
      ? "（本代尚无历史消息）"
      : input.context.truncated
        ? `${VENDOR_SWITCH_TRUNCATED_HINT}\n\n${input.context.body}`
        : input.context.body;
  sections.push(`## 本代完整对话与 Worker 汇报记录\n\n${logContent}`);
  return sections.join("\n\n");
}
