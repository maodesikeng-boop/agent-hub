import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Change } from "../../shared/api.ts";
import { askOf, isHandoverTraffic, type ConversationId, type Message, type MessageId, type PmId } from "../../shared/domain.ts";
import { isLedgerWakeup } from "../../shared/attachments.ts";
import type { Deliverable } from "../../shared/deliverables.ts";
import { feishuOriginOf } from "../../shared/feishu.ts";
import { FEISHU_CARD_MARKDOWN_JSON_BYTES, FEISHU_CARD_MAX_CHARS, FEISHU_CATCHUP_MAX_MESSAGES, FEISHU_FENCE_INFO_MAX_CHARS, FEISHU_FENCE_MARKER_MAX_CHARS } from "../../shared/limits.ts";
import type { RouterCommandRecord, RouterItem } from "../../shared/router.ts";
import { parseLocalHref, sentFilesOf, type SentFile } from "../../shared/sent-files.ts";
import { describeStep, STEP_TEXT } from "../../shared/step-labels.ts";
import type { FeishuChatBinding } from "./store.ts";

export type FeishuOutboundIntent =
  | { kind: "sync_chats" }
  | { kind: "stream"; conversationId: ConversationId; text: string }
  | { kind: "working"; conversationId: ConversationId; status: string }
  | { kind: "agent_text"; conversationId: ConversationId; message: Message; files: SentFile[] }
  | { kind: "turn_end"; conversationId: ConversationId }
  | { kind: "turn_failed"; conversationId: ConversationId; message: Message }
  | { kind: "mirror_user"; conversationId: ConversationId; message: Message }
  | { kind: "ask_card"; conversationId: ConversationId; message: Message; deliverables: Deliverable[] }
  | { kind: "ask_updated"; conversationId: ConversationId; message: Message }
  | { kind: "ask_settled"; conversationId: ConversationId; message: Message }
  | { kind: "router_ask"; message: Message }
  | { kind: "router_item"; item: RouterItem }
  | { kind: "router_command"; command: RouterCommandRecord }
  | { kind: "refresh_policy_card"; pmId: PmId }
  | { kind: "refresh_router_settings_card" };

export interface FeishuProjectionContext {
  chatOfConversation(conversationId: ConversationId): FeishuChatBinding | null;
  routerChat(): FeishuChatBinding | null;
  pmOfConversation(conversationId: ConversationId): PmId | null;
  awaitingUser(conversationId: ConversationId): boolean;
}

export function projectFeishuChange(change: Change, ctx: FeishuProjectionContext): FeishuOutboundIntent[] {
  switch (change.type) {
    case "pm.created":
    case "pm.removed":
      return [{ kind: "sync_chats" }];
    case "pm.updated":
      return [{ kind: "sync_chats" }, { kind: "refresh_policy_card", pmId: change.data.pm.id }];
    case "router.settings.updated":
      return ctx.routerChat() === null ? [] : [{ kind: "refresh_router_settings_card" }];
    case "session.status": {
      const { conversationId, pmId, streamingText, status, activity, step } = change.data.session;
      if (conversationId === null || pmId === null || ctx.chatOfConversation(conversationId) === null) return [];
      if (typeof streamingText === "string" && streamingText !== "") return [{ kind: "stream", conversationId, text: streamingText }];
      // A turn ends when activity returns to idle while the process keeps running, or when the session ends.
      if (status !== "running" || activity === "idle") return [{ kind: "turn_end", conversationId }];
      if ((activity !== "working" && activity !== "stopping") || !ctx.awaitingUser(conversationId)) return [];
      return [{ kind: "working", conversationId, status: `${activity === "stopping" ? STEP_TEXT.stopping : describeStep(step)}…` }];
    }
    case "message.created":
      return createdMessageIntents(change.data.message, ctx);
    case "message.updated": {
      const { message } = change.data;
      if (isFailedUserTurn(message)) return ctx.chatOfConversation(message.conversationId) === null ? [] : [{ kind: "turn_failed", conversationId: message.conversationId, message }];
      const ask = askOf(message);
      if (ask === null || (ctx.chatOfConversation(message.conversationId) === null && ctx.routerChat() === null)) return [];
      if (ask.answered === true || ask.closed === true) {
        return [{ kind: "ask_settled", conversationId: message.conversationId, message }];
      }
      return ask.blockerRef !== undefined || ask.sandboxApprovalRef !== undefined ? [{ kind: "ask_updated", conversationId: message.conversationId, message }] : [];
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

function isFailedUserTurn(message: Message): boolean {
  return message.status === "failed" && message.sender === "user" && message.workerId === null && message.kind === "text" && !isLedgerWakeup(message);
}

const ROUTER_COMMAND_DONE: ReadonlySet<RouterCommandRecord["status"]> = new Set(["answered", "dispatched", "failed"]);

function isRouterSyncedAsk(message: Message): boolean {
  if (message.workerId !== null || message.kind !== "text" || message.sender !== "agent" || isHandoverTraffic(message)) return false;
  const ask = askOf(message);
  return ask !== null && (ask.gateRef !== undefined || ask.blockerRef !== undefined || ask.sandboxApprovalRef !== undefined);
}

function createdMessageIntents(message: Message, ctx: FeishuProjectionContext): FeishuOutboundIntent[] {
  const pmIntents = ctx.chatOfConversation(message.conversationId) === null ? [] : messageIntents(message);
  const syncToRouter = ctx.routerChat() !== null && ctx.pmOfConversation(message.conversationId) !== null && isRouterSyncedAsk(message);
  return syncToRouter ? [...pmIntents, { kind: "router_ask", message }] : pmIntents;
}

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
  if (message.sender === "user" && !isLedgerWakeup(message) && feishuOriginOf(message) === null) {
    return [{ kind: "mirror_user", conversationId, message }];
  }
  return [];
}

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

export function feishuMarkdownFit(text: string, chars: number, bytes: number): string {
  return text.slice(0, markdownWindow(text, 0, chars, bytes));
}

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
// Card Markdown only accepts uploaded image keys; any other image URL fails the whole card with 200570.
const FEISHU_IMAGE_KEY = /^img_[\w-]+$/;
const WEB_URL = /^https?:\/\//i;
const MAY_CONTAIN_LINK = /\]\(|\]\[|<[a-z][a-z0-9+.-]*:/i;

const fileNameOf = (path: string) => path.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? "";

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
