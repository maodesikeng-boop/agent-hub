import { parseFeishuChatId, parseFeishuMessageId, parseFeishuOpenId } from "../../shared/feishu.ts";
import type { FeishuChatId, FeishuMessageId, FeishuOpenId } from "../../shared/feishu.ts";
import { decodeFeishuActionValue, FEISHU_NOTE_FIELD, type FeishuActionValue } from "./cards.ts";
import type { FeishuRawCardAction, FeishuRawEvent } from "./transport.ts";

export interface FeishuInboundFile {
  type: "image" | "file";
  fileKey: string;
  fileName: string | null;
}

export interface FeishuInboundFileRef {
  messageId: FeishuMessageId;
  file: FeishuInboundFile;
}

export type FeishuInbound =
  | {
      kind: "message";
      messageId: FeishuMessageId;
      chatId: FeishuChatId;
      chatType: "p2p" | "group";
      senderOpenId: FeishuOpenId;
      text: string;
      mentionedBot: boolean;
      inThread: boolean;
      files: FeishuInboundFile[];
      droppedMedia: number;
      at: number;
    }
  | { kind: "members_added"; chatId: FeishuChatId; openIds: FeishuOpenId[] }
  | { kind: "members_removed"; chatId: FeishuChatId; openIds: FeishuOpenId[] }
  | { kind: "chat_gone"; chatId: FeishuChatId }
  | { kind: "chat_renamed"; chatId: FeishuChatId; name: string };

export interface FeishuInboundAction {
  token?: string;
  messageId: FeishuMessageId;
  chatId: FeishuChatId;
  operatorOpenId: FeishuOpenId;
  value: FeishuActionValue;
  option?: string;
  note: string | null;
}

export function parseFeishuEvent(raw: FeishuRawEvent, botOpenId: FeishuOpenId): FeishuInbound | null {
  const chatId = parseFeishuChatId(raw.chatId);
  if (chatId === null) return null;
  switch (raw.type) {
    case "im.message.receive_v1": {
      const messageId = parseFeishuMessageId(raw.messageId);
      const senderOpenId = parseFeishuOpenId(raw.senderOpenId);
      if (messageId === null || senderOpenId === null || raw.senderType !== "user" || senderOpenId === botOpenId) return null;
      const files: FeishuInboundFile[] = [];
      let droppedMedia = 0;
      for (const resource of raw.resources) {
        if (resource.type === "sticker" || resource.fileKey === "") droppedMedia += 1;
        else if (resource.type === "image") files.push({ type: "image", fileKey: resource.fileKey, fileName: resource.fileName });
        else files.push({ type: "file", fileKey: resource.fileKey, fileName: resource.fileName ?? DEFAULT_NAMES[resource.type]?.(resource.fileKey) ?? null });
      }
      return {
        kind: "message",
        messageId,
        chatId,
        chatType: raw.chatType,
        senderOpenId,
        text: withoutPlaceholders(raw.content, files),
        mentionedBot: raw.mentionedBot,
        inThread: raw.threadId !== null && raw.threadId !== "",
        files,
        droppedMedia,
        at: raw.createTime,
      };
    }
    case "im.chat.member.user.added_v1":
    case "im.chat.member.user.deleted_v1": {
      const openIds = raw.openIds.map(parseFeishuOpenId).filter((id): id is FeishuOpenId => id !== null && id !== botOpenId);
      if (openIds.length === 0) return null;
      return { kind: raw.type === "im.chat.member.user.added_v1" ? "members_added" : "members_removed", chatId, openIds };
    }
    case "im.chat.member.bot.deleted_v1":
    case "im.chat.disbanded_v1":
      return { kind: "chat_gone", chatId };
    case "im.chat.updated_v1":
      return raw.name === null || raw.name.trim() === "" ? null : { kind: "chat_renamed", chatId, name: raw.name.trim() };
  }
}

const DEFAULT_NAMES: Partial<Record<string, (fileKey: string) => string>> = {
  video: (fileKey) => `飞书视频-${fileKey.slice(-8)}.mp4`,
  audio: (fileKey) => `飞书语音-${fileKey.slice(-8)}.opus`,
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function withoutPlaceholders(content: string, files: readonly FeishuInboundFile[]): string {
  if (files.length === 0) return content.trim();
  const keys = files.map((f) => escapeRegExp(f.fileKey)).join("|");
  const placeholder = new RegExp(`!\\[[^\\]]*\\]\\((?:${keys})\\)|<(?:file|video|audio) key="(?:${keys})"[^>]*/>`, "g");
  return content
    .split("\n")
    .flatMap((line) => {
      const left = line.replace(placeholder, "").trimEnd();
      return left.trim() === "" && line.trim() !== "" ? [] : [left];
    })
    .join("\n")
    .trim();
}

export function parseFeishuCardAction(raw: FeishuRawCardAction): FeishuInboundAction | null {
  const messageId = parseFeishuMessageId(raw.messageId);
  const chatId = parseFeishuChatId(raw.chatId);
  const operatorOpenId = parseFeishuOpenId(raw.operatorOpenId);
  const value = decodeFeishuActionValue(raw.value);
  if (messageId === null || chatId === null || operatorOpenId === null || value === null) return null;
  const option = typeof raw.option === "string" && raw.option.trim() !== "" ? raw.option.trim() : null;
  if ((value.kind === "set_pm_model" || value.kind === "set_router_model") && option === null) return null;
  const rawNote = raw.formValue?.[FEISHU_NOTE_FIELD];
  const note = typeof rawNote === "string" && rawNote.trim() !== "" ? rawNote.trim() : null;
  return {
    messageId,
    chatId,
    operatorOpenId,
    value,
    ...(option !== null ? { option } : {}),
    note,
    ...(raw.token ? { token: raw.token } : {}),
  };
}
