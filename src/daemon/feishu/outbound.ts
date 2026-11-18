// 出站投影（docs/feishu-design.md）：账本的一条变化要不要在飞书里体现、体现成什么。只决定“要什么”，不发请求。
// 不变量：
// - 账本是唯一的真相：飞书里机器人发的每条消息都对应账本里的一样东西（feishu_posts 的 ref），反过来不要求；
// - 所有消息都发在主聊天流里，不发话题回复，不引用回复；
// - 遵守静默规矩：工具调用、Worker 汇报行、Worker 对话、后台写交接、只给人看的系统消息都不发；
// - 网页上发的用户消息照样镜像到群里（标明“网页”），两边看到的对话一致；从飞书来的用户消息不再镜像回去。
import type { Change } from "../../shared/api.ts";
import { askOf, isHandoverTraffic, userMessageDedupeKey, type ConversationId, type Message, type MessageId, type PmId } from "../../shared/domain.ts";
import type { Deliverable } from "../../shared/deliverables.ts";
import { feishuOriginOf } from "../../shared/feishu.ts";
import { FEISHU_CARD_MAX_CHARS, FEISHU_CATCHUP_MAX_MESSAGES } from "../../shared/limits.ts";
import type { RouterCommandRecord, RouterItem } from "../../shared/router.ts";
import { sentFilesOf, type SentFile } from "../../shared/sent-files.ts";
import type { FeishuChatBinding } from "./store.ts";

export type FeishuOutboundIntent =
  /** 账本里的项目经理要对齐一遍（建了、改名、归档、取消归档、删了）。 */
  | { kind: "sync_chats" }
  /** 项目经理正在写的这一段（内存里的流式预览）。text 是到目前为止的全文。 */
  | { kind: "stream"; conversationId: ConversationId; text: string }
  /** 一段文字落库了：流式那张卡定稿，没流式过的直接发。 */
  | { kind: "agent_text"; conversationId: ConversationId; message: Message; files: SentFile[] }
  /** 这一轮结束（会话回到空闲）：收掉还开着的流式卡片。 */
  | { kind: "turn_end"; conversationId: ConversationId }
  /** 网页上发的用户消息。 */
  | { kind: "mirror_user"; conversationId: ConversationId; message: Message }
  /** 新的提问卡。 */
  | { kind: "ask_card"; conversationId: ConversationId; message: Message; deliverables: Deliverable[] }
  /** 提问卡的状态变了（回答了、关掉了、替换了）：项目群里那张卡、总助单聊里引用它的那条一起改成定案的样子。 */
  | { kind: "ask_settled"; conversationId: ConversationId; message: Message }
  /** 总助的卡片：新的简报或拍板项，或它的状态变了。 */
  | { kind: "router_item"; item: RouterItem }
  /** 总助指令有了结果：作为新卡片发在总助单聊里；网页发的指令连同原话一起镜像。 */
  | { kind: "router_command"; command: RouterCommandRecord };

export interface FeishuProjectionContext {
  /** 项目经理对话 → 它的群；不是项目经理对话（Worker 对话）或还没建群是 null。 */
  chatOfConversation(conversationId: ConversationId): FeishuChatBinding | null;
  /** 总助单聊；还没认主人时是 null（认主人后服务按主人 open_id 发第一条，从回包里拿到单聊编号记下）。 */
  routerChat(): FeishuChatBinding | null;
  pmOfConversation(conversationId: ConversationId): PmId | null;
}

/**
 * 后置：按不变量把一条变化变成零个或多个意图：
 * - pm.created / pm.updated / pm.removed → sync_chats；
 * - session.status 带 streamingText 且会话属于有群的项目经理对话 → stream；这一轮结束（activity 回到 idle，或 status 是 ended / broken）→ turn_end；
 * - message.created：项目经理的文字消息 → agent_text（带 meta 里的 SentFile）；askOf 不为 null → ask_card；
 *   没有 origin 的用户消息 → mirror_user；其余 → 无；
 * - message.updated：askOf 不为 null 且已回答或关掉 → ask_settled；
 * - router.item.created / updated → router_item；router.command.updated 且状态是 answered / dispatched / failed → router_command。
 * 没有对应会话的变化一律不出意图。
 */
export function projectFeishuChange(change: Change, ctx: FeishuProjectionContext): FeishuOutboundIntent[] {
  switch (change.type) {
    case "pm.created":
    case "pm.updated":
    case "pm.removed":
      return [{ kind: "sync_chats" }];
    case "session.status": {
      const { conversationId, streamingText, status, activity } = change.data.session;
      if (conversationId === null || ctx.chatOfConversation(conversationId) === null) return [];
      if (typeof streamingText === "string" && streamingText !== "") return [{ kind: "stream", conversationId, text: streamingText }];
      // 一轮结束看 activity 回到 idle（进程还在，status 仍是 running），或会话结束、坏了
      return status === "running" && activity !== "idle" ? [] : [{ kind: "turn_end", conversationId }];
    }
    case "message.created":
      return ctx.chatOfConversation(change.data.message.conversationId) === null ? [] : messageIntents(change.data.message);
    case "message.updated": {
      const { message } = change.data;
      const ask = askOf(message);
      if (ask === null || (ask.answered !== true && ask.closed !== true)) return [];
      return ctx.chatOfConversation(message.conversationId) === null && ctx.routerChat() === null ? [] : [{ kind: "ask_settled", conversationId: message.conversationId, message }];
    }
    case "router.item.created":
    case "router.item.updated":
      return ctx.routerChat() === null ? [] : [{ kind: "router_item", item: change.data.item }];
    case "router.command.updated": {
      const { command } = change.data;
      return ctx.routerChat() !== null && ROUTER_COMMAND_DONE.has(command.status) ? [{ kind: "router_command", command }] : [];
    }
    default:
      return [];
  }
}

const USER_TYPED_PREFIX = userMessageDedupeKey(0, "").split(":")[0]! + ":";
const ROUTER_COMMAND_DONE: ReadonlySet<RouterCommandRecord["status"]> = new Set(["answered", "dispatched", "failed"]);

/** 有群的项目经理对话里的一条消息要在群里体现成什么（补发也走它）。 */
function messageIntents(message: Message): FeishuOutboundIntent[] {
  const { conversationId } = message;
  if (message.workerId !== null || message.kind !== "text") return [];
  if (message.sender === "agent") {
    if (isHandoverTraffic(message)) return [];
    const ask = askOf(message);
    if (ask !== null) return [{ kind: "ask_card", conversationId, message, deliverables: ask.deliverables ?? [] }];
    if (message.text.trim() === "" && sentFilesOf(message).length === 0) return [];
    return [{ kind: "agent_text", conversationId, message, files: sentFilesOf(message) }];
  }
  // 只镜像用户在网页上打的字（去重键是 userMessageDedupeKey 的 client:）；拍板唤醒这类账本代发的用户消息不镜像
  if (message.sender === "user" && message.dedupeKey.startsWith(USER_TYPED_PREFIX) && feishuOriginOf(message) === null) {
    return [{ kind: "mirror_user", conversationId, message }];
  }
  return [];
}

/**
 * 重连或重启后补发：项目经理群里 lastMessageId 之后、属于这个对话的消息（调用方按编号从小到大给）。
 * 后置：最多 FEISHU_CATCHUP_MAX_MESSAGES 条意图（取最新的）；更早还有的，omitted 写条数，调用方发一行“还有 N 条，去网页看”。
 */
export function catchUpIntents(
  conversationId: ConversationId,
  messages: readonly Message[],
): { intents: FeishuOutboundIntent[]; omitted: number; lastMessageId: MessageId | null } {
  const lastMessageId = messages.length === 0 ? null : Math.max(...messages.map((m) => m.id));
  const all = messages.filter((m) => m.conversationId === conversationId).flatMap(messageIntents);
  const kept = all.slice(-FEISHU_CATCHUP_MAX_MESSAGES);
  return { intents: kept, omitted: all.length - kept.length, lastMessageId };
}

/**
 * 后置：把 Markdown 正文按 FEISHU_CARD_MAX_CHARS 拆成几段，优先在空行、换行处断，不在代码块中间断
 * （必须断时在断点补上闭合和重新打开的代码围栏）。空正文返回空数组。拼回去等于原文（去掉补的围栏）。
 * 每段都是前一段的独立续写，不依赖流式前缀：流式卡片超长时前一张定稿，后面的发新卡。
 */
const CLOSE_FENCE_RESERVE = 16;

/** 在窗口里找最靠后的空行，其次换行，都没有就整段切。返回切点（不含）。 */
function breakPoint(window: string): number {
  const min = Math.floor(window.length / 2);
  const blank = window.lastIndexOf("\n\n");
  if (blank >= min) return blank + 2;
  const line = window.lastIndexOf("\n");
  if (line >= min) return line + 1;
  return window.length;
}

/** 这段文字结束时还开着的代码围栏：marker 是 ``` 或 ~~~ 那串记号，line 是整行（带语言名，重新打开时照抄）。没有是 null。 */
function openFenceAfter(text: string): { marker: string; line: string } | null {
  let open: { marker: string; line: string } | null = null;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m === null) continue;
    const marker = m[1]!;
    if (open === null) open = { marker, line: line.trim() };
    else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && line.trim() === marker) open = null;
  }
  return open;
}

export function splitFeishuMarkdown(text: string): string[] {
  if (text === "") return [];
  const chunks: string[] = [];
  let rest = text;
  let reopen = "";
  while (rest !== "") {
    const body = reopen + rest;
    if ([...body].length <= FEISHU_CARD_MAX_CHARS) {
      chunks.push(body);
      break;
    }
    // 留出补闭合围栏的位置
    const budget = FEISHU_CARD_MAX_CHARS - [...reopen].length - CLOSE_FENCE_RESERVE;
    const window = [...rest].slice(0, budget).join("");
    let piece = rest.slice(0, breakPoint(window));
    // 断在代码块里时退到行尾，补的闭合围栏单独占一行
    if (openFenceAfter(reopen + piece) !== null && !piece.endsWith("\n") && piece.includes("\n")) piece = piece.slice(0, piece.lastIndexOf("\n") + 1);
    rest = rest.slice(piece.length);
    const fence = openFenceAfter(reopen + piece);
    chunks.push(fence === null ? reopen + piece : `${reopen + piece}${piece.endsWith("\n") ? "" : "\n"}${fence.marker}\n`);
    reopen = fence === null ? "" : `${fence.line}\n`;
  }
  return chunks;
}
