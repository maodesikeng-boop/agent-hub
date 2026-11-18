// 入站解析（docs/feishu-design.md）：长连接送来的原始事件变成领域事件，编号全部品牌化。
// 不变量：
// - 丢掉机器人（含自己）发的消息、外部企业的人、编号形状不对的事件，返回 null，不抛错；
// - 不做 I/O，不读状态。
import { parseFeishuChatId, parseFeishuMessageId, parseFeishuOpenId } from "../../shared/feishu.ts";
import type { FeishuChatId, FeishuMessageId, FeishuOpenId } from "../../shared/feishu.ts";
import { decodeFeishuActionValue, FEISHU_NOTE_FIELD, type FeishuActionValue } from "./cards.ts";
import type { FeishuRawCardAction, FeishuRawEvent } from "./transport.ts";

export interface FeishuInboundFile {
  type: "image" | "file";
  fileKey: string;
  fileName: string | null;
}

export type FeishuInbound =
  | {
      kind: "message";
      messageId: FeishuMessageId;
      chatId: FeishuChatId;
      chatType: "p2p" | "group";
      senderOpenId: FeishuOpenId;
      /** markdown 正文，已去掉 @机器人 的占位。 */
      text: string;
      mentionedBot: boolean;
      /** 发在话题里（Fusa 的群是对话群，正常不会有）。 */
      inThread: boolean;
      /** 图片和文件；语音、视频、表情不收，记在 droppedMedia。 */
      files: FeishuInboundFile[];
      droppedMedia: number;
      at: number;
    }
  | { kind: "members_added"; chatId: FeishuChatId; openIds: FeishuOpenId[] }
  | { kind: "members_removed"; chatId: FeishuChatId; openIds: FeishuOpenId[] }
  /** 机器人被移出群，或群被解散：这个群不再能用。 */
  | { kind: "chat_gone"; chatId: FeishuChatId }
  /** 群名被人在飞书里改了：只更新记录，不改回去。 */
  | { kind: "chat_renamed"; chatId: FeishuChatId; name: string };

export interface FeishuInboundAction {
  messageId: FeishuMessageId;
  chatId: FeishuChatId;
  operatorOpenId: FeishuOpenId;
  value: FeishuActionValue;
  /** 卡片表单里“补充说明”输入框的内容；没填是 null。 */
  note: string | null;
}

/**
 * 后置：按上面的不变量解析；senderType 是 app、编号形状不对时返回 null。
 * 语音、视频、表情包进 droppedMedia，不进 files。
 */
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
        if ((resource.type === "image" || resource.type === "file") && resource.fileKey !== "") {
          files.push({ type: resource.type, fileKey: resource.fileKey, fileName: resource.fileName });
        } else {
          droppedMedia += 1;
        }
      }
      return {
        kind: "message",
        messageId,
        chatId,
        chatType: raw.chatType,
        senderOpenId,
        text: raw.content.trim(),
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

/** 后置：按钮值能被 decodeFeishuActionValue 认出、编号形状对时返回动作；否则 null（被改过、老版本的卡）。 */
export function parseFeishuCardAction(raw: FeishuRawCardAction): FeishuInboundAction | null {
  const messageId = parseFeishuMessageId(raw.messageId);
  const chatId = parseFeishuChatId(raw.chatId);
  const operatorOpenId = parseFeishuOpenId(raw.operatorOpenId);
  const value = decodeFeishuActionValue(raw.value);
  if (messageId === null || chatId === null || operatorOpenId === null || value === null) return null;
  const rawNote = raw.formValue?.[FEISHU_NOTE_FIELD];
  const note = typeof rawNote === "string" && rawNote.trim() !== "" ? rawNote.trim() : null;
  return { messageId, chatId, operatorOpenId, value, note };
}
