// 出站投影（docs/feishu-design.md）：账本的一条变化要不要在飞书里体现、体现成什么。只决定“要什么”，不发请求。
// 不变量：
// - 账本是唯一的真相：飞书里机器人发的每条消息都对应账本里的一样东西（feishu_posts 的 ref），反过来不要求；
// - 所有消息都发在主聊天流里，不发话题回复，不引用回复；
// - 遵守静默规矩：工具调用、Worker 汇报行、Worker 对话、后台写交接、只给人看的系统消息都不发；
// - 网页上发的用户消息照样镜像到群里（标明“网页”），两边看到的对话一致；从飞书来的用户消息不再镜像回去。
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Change } from "../../shared/api.ts";
import { askOf, isHandoverTraffic, userMessageDedupeKey, type ConversationId, type Message, type MessageId, type PmId } from "../../shared/domain.ts";
import type { Deliverable } from "../../shared/deliverables.ts";
import { feishuOriginOf } from "../../shared/feishu.ts";
import { FEISHU_CARD_MARKDOWN_JSON_BYTES, FEISHU_CARD_MAX_CHARS, FEISHU_CATCHUP_MAX_MESSAGES, FEISHU_FENCE_INFO_MAX_CHARS, FEISHU_FENCE_MARKER_MAX_CHARS } from "../../shared/limits.ts";
import type { RouterCommandRecord, RouterItem } from "../../shared/router.ts";
import { parseLocalHref, sentFilesOf, type SentFile } from "../../shared/sent-files.ts";
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
  limit = FEISHU_CATCHUP_MAX_MESSAGES,
): { intents: FeishuOutboundIntent[]; omitted: number; lastMessageId: MessageId | null } {
  const lastMessageId = messages.length === 0 ? null : Math.max(...messages.map((m) => m.id));
  const all = messages.filter((m) => m.conversationId === conversationId).flatMap(messageIntents);
  const kept = all.slice(-limit);
  return { intents: kept, omitted: all.length - kept.length, lastMessageId };
}

/** 从 start 起最多取 chars 个字、转成 JSON 字符串后最多 bytes 字节，返回结束下标（不含）。 */
function markdownWindow(text: string, start: number, chars: number, bytes: number): number {
  let end = start;
  while (end < text.length && chars > 0) {
    const code = text.codePointAt(end)!;
    const width = code > 0xffff ? 2 : 1;
    const escapedBytes = code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13
      ? 2 : code < 32 || (code >= 0xd800 && code <= 0xdfff) ? 6 : code < 0x80 ? 1 : code < 0x800 ? 2 : width === 2 ? 4 : 3;
    if (escapedBytes > bytes) break;
    bytes -= escapedBytes;
    chars--;
    end += width;
  }
  return end;
}

/** 后置：text 的前缀，最多 chars 个字、转成 JSON 字符串后最多 bytes 字节（不含两边引号）。 */
export function feishuMarkdownFit(text: string, chars: number, bytes: number): string {
  return text.slice(0, markdownWindow(text, 0, chars, bytes));
}

/** 流式卡片上推的正文：前 FEISHU_CARD_MAX_CHARS 字按 feishuCardMarkdown 换过图片和本机链接。 */
export function feishuMarkdownPrefix(text: string): string {
  const fit = (t: string) => feishuMarkdownFit(t, FEISHU_CARD_MAX_CHARS, FEISHU_CARD_MARKDOWN_JSON_BYTES);
  return fit(feishuCardMarkdown(fit(text)));
}

interface MdastNode {
  type: string;
  url?: string;
  alt?: string | null;
  children?: MdastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);
/** 飞书卡片 Markdown 里图片地址只认上传后拿到的图片编号（img_ 开头），别的一律回 200570。 */
const FEISHU_IMAGE_KEY = /^img_[\w-]+$/;
const WEB_URL = /^https?:\/\//i;
const MAY_CONTAIN_LINK = /\]\(|\]\[|<[a-z][a-z0-9+.-]*:/i;

const fileNameOf = (path: string) => path.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? "";

/**
 * 账本正文 → 飞书卡片能收的 Markdown（docs/feishu-design.md「交付与附件」）。
 * 后置：
 * - 图片地址不是飞书图片编号时不留图片语法：网页图片变成同地址的链接，本机、别的地址和套在链接里的网页图片写成“图片「名字」”；
 * - 指向本机的链接（绝对路径、file://、~/、相对路径，同 parseLocalHref）只留链接文字：手机上点不开，文件本身由 files.ts 单独发；
 * - 网页链接、飞书图片编号、代码块和行内代码里的原样；
 * - 只在这一层改，账本正文不动。
 */
export function feishuCardMarkdown(text: string): string {
  if (!MAY_CONTAIN_LINK.test(text)) return text;
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: MdastNode, inLink: boolean) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === "image" || node.type === "imageReference") {
      const url = node.url ?? "";
      if (FEISHU_IMAGE_KEY.test(url)) return;
      const label = node.alt?.trim() || fileNameOf(url);
      if (WEB_URL.test(url) && !inLink) edits.push({ start, end: start + 1, text: "" });
      else edits.push({ start, end, text: label === "" ? "图片" : `图片「${label}」` });
      return;
    }
    let linked = inLink;
    if (node.type === "link" || node.type === "linkReference") {
      linked = true;
      const children = node.children ?? [];
      const first = children[0]?.position?.start.offset;
      const last = children.at(-1)?.position?.end.offset;
      if (node.type === "link" && parseLocalHref(node.url ?? "") !== null) {
        if (first === undefined || last === undefined) {
          edits.push({ start, end, text: fileNameOf(node.url ?? "") });
          return;
        }
        edits.push({ start, end: first, text: "" }, { start: last, end, text: "" });
      }
    }
    for (const child of node.children ?? []) visit(child, linked);
  };
  visit(markdownParser.parse(text) as MdastNode, false);
  if (edits.length === 0) return text;
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

type Fence = { marker: string; opener: string };

function fenceAtLine(text: string, start: number, open: Fence | null): Fence | null {
  const end = text.indexOf("\n", start);
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(text.slice(start, end === -1 ? undefined : end));
  if (match === null) return open;
  const [, marker, info] = match;
  if (marker === undefined || info === undefined) return open;
  if (open !== null) return marker[0] === open.marker[0] && marker.length >= open.marker.length && info.trim() === "" ? null : open;
  if (marker.length > FEISHU_FENCE_MARKER_MAX_CHARS || (marker[0] === "`" && info.includes("`"))) return null;
  const language = info.trim();
  const suffix = language.length <= FEISHU_FENCE_INFO_MAX_CHARS && /^[\w+.-]*$/.test(language) ? language : "";
  return { marker, opener: `${marker}${suffix}\n` };
}

/**
 * 后置：先按 feishuCardMarkdown 换掉图片和本机链接，再把 Markdown 正文拆成几段，每段字数不超过 FEISHU_CARD_MAX_CHARS、转成 JSON 后不超过 FEISHU_CARD_MARKDOWN_JSON_BYTES；
 * 优先在空行、换行处断。断在代码块里时在断点补闭合围栏、下一段补重新打开的围栏（只照抄有上限的记号和语言名），
 * 所以每段都至少前进一个字。空正文返回空数组。
 */
export function splitFeishuMarkdown(markdown: string): string[] {
  const text = feishuCardMarkdown(markdown);
  const chunks: string[] = [];
  let start = 0;
  let nextLine = 0;
  let open: Fence | null = null;
  const closingReserve = FEISHU_FENCE_MARKER_MAX_CHARS + 4;
  while (start < text.length) {
    const reopen = open?.opener ?? "";
    const chars = FEISHU_CARD_MAX_CHARS - reopen.length;
    const bytes = FEISHU_CARD_MARKDOWN_JSON_BYTES - (reopen === "" ? 0 : reopen.length + 1);
    const full = markdownWindow(text, start, chars, bytes);
    if (full === text.length) {
      chunks.push(reopen + text.slice(start));
      break;
    }
    const limit = markdownWindow(text, start, chars - closingReserve, bytes - closingReserve);
    const min = start + Math.floor((limit - start) / 2);
    const blank = text.lastIndexOf("\n\n", limit - 2);
    const line = text.lastIndexOf("\n", limit - 1);
    const end = blank >= min ? blank + 2 : line >= min ? line + 1 : limit;
    while (nextLine < end) {
      open = fenceAtLine(text, nextLine, open);
      const newline = text.indexOf("\n", nextLine);
      nextLine = newline === -1 ? text.length : newline + 1;
    }
    const piece = text.slice(start, end);
    chunks.push(open === null ? reopen + piece : `${reopen}${piece}${piece.endsWith("\n") ? "" : "\n"}${open.marker}\n`);
    start = end;
  }
  return chunks;
}
