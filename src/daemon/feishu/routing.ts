import { createHash } from "node:crypto";
import type { PmId } from "../../shared/domain.ts";
import { feishuGuestMay } from "../../shared/feishu.ts";
import type {
  FeishuChatMode,
  FeishuChatTarget,
  FeishuContextLine,
  FeishuGuestTier,
  FeishuMessageOrigin,
  FeishuOpenId,
  FeishuSpeakerRole,
  FeishuTriggerMode,
} from "../../shared/feishu.ts";
import type { FeishuCardRef } from "./cards.ts";
import type { FeishuPendingFile } from "./directory.ts";
import type { FeishuInbound, FeishuInboundAction, FeishuInboundFileRef } from "./inbound.ts";
import type { FeishuModelField } from "./model-picker.ts";

type InboundMessage = Extract<FeishuInbound, { kind: "message" }>;

const NOT_YOUR_ASSISTANT = "这是主人的私人助手，只听主人的。";
const GUEST_SLASH = "以“/”开头的命令只有主人能用。";
export const OWNER_ONLY_SETTINGS_CARD = "设置卡只有主人能叫出来。";
export const GUEST_NO_FILES = "这个群的访客发的文件不收，有事先用文字说。要发文件，请主人在群里的「群设置」卡上切到“协作者”。";
const FILES_ONLY_TEXT = "（发了文件）";
const CONTEXT_WAKE_TEXT = "（@机器人，请看上面的讨论）";
const ONLINE_HINT = "我在，直接 @我 后面说事就行。";
const TOPIC_HINT = "暂不支持在话题里回复，请到群聊主消息流 @我。";
export const OWNER_ONLY_DECIDE = "只有主人能拍板";
export const OWNER_ONLY_STOP = "只有主人能停止";
export const OWNER_ONLY_SETTINGS = "只有主人能改设置";
const NOTE_REQUIRED = "先在输入框里写点什么再提交";

export const FEISHU_SETTINGS_COMMANDS: readonly string[] = ["/群设置", "/设置", "/policy", "/model", "/settings"];

const isSettingsCommand = (message: InboundMessage) => message.files.length === 0 && FEISHU_SETTINGS_COMMANDS.includes(message.text.trim());

export interface FeishuRoutingContext {
  ownerOpenId: FeishuOpenId | null;
  binding: { target: FeishuChatTarget; archived: boolean } | null;
  mode: FeishuChatMode;
  triggerMode: FeishuTriggerMode;
  guestTier: FeishuGuestTier;
  mentionOnlyForced: boolean;
  speakerName: string;
  pendingContext: readonly FeishuContextLine[];
  pendingFiles: readonly FeishuPendingFile[];
  isBindCode: (text: string) => boolean;
}

export type FeishuMessageRoute =
  | { kind: "bind_owner"; openId: FeishuOpenId }
  | {
      kind: "deliver";
      target: FeishuChatTarget;
      text: string;
      origin: FeishuMessageOrigin;
      files: FeishuInboundFileRef[];
      droppedFiles: number;
    }
  | { kind: "context"; line: FeishuContextLine }
  | { kind: "hint"; text: string }
  | { kind: "settings_card" }
  | { kind: "reject"; openId: FeishuOpenId; reason: string; guestDenied?: true }
  | { kind: "ignore" };

export function routeFeishuMessage(message: InboundMessage, ctx: FeishuRoutingContext): FeishuMessageRoute {
  const { ownerOpenId } = ctx;
  const speaker = message.senderOpenId;
  if (message.chatType === "p2p") {
    if (ownerOpenId === null) return ctx.isBindCode(message.text) ? { kind: "bind_owner", openId: speaker } : { kind: "ignore" };
    if (speaker !== ownerOpenId) return { kind: "reject", openId: speaker, reason: NOT_YOUR_ASSISTANT };
    if (!message.inThread && isSettingsCommand(message)) return { kind: "settings_card" };
    if (message.text === "" && message.files.length === 0) return { kind: "ignore" };
    return {
      kind: "deliver",
      target: { kind: "router" },
      text: message.text,
      origin: { kind: "feishu", openId: speaker, name: ctx.speakerName, role: "owner", mode: "solo", guestTier: ctx.guestTier, context: [] },
      files: message.files.map((file) => ({ messageId: message.messageId, file })),
      droppedFiles: 0,
    };
  }
  if (ownerOpenId === null || ctx.binding === null || ctx.binding.archived || ctx.binding.target.kind !== "pm") return { kind: "ignore" };
  const role = feishuSpeakerRole(speaker, ownerOpenId);
  const mayWake = role === "owner" || feishuGuestMay(ctx.guestTier, "talk");
  if (message.inThread) return mayWake && message.mentionedBot ? { kind: "hint", text: TOPIC_HINT } : { kind: "ignore" };
  if (isSettingsCommand(message)) return role === "owner" ? { kind: "settings_card" } : { kind: "reject", openId: speaker, reason: OWNER_ONLY_SETTINGS_CARD };
  const wakes = mayWake && feishuWakes(ctx, message.mentionedBot);
  if (!wakes && message.text === "" && message.files.length === 0) return { kind: "ignore" };
  if (!wakes) return { kind: "context", line: { name: ctx.speakerName, role, text: message.text === "" ? FILES_ONLY_TEXT : message.text, at: message.at } };
  if (role === "guest" && message.text.startsWith("/")) return { kind: "reject", openId: speaker, reason: GUEST_SLASH };
  const mayAttach = (openId: FeishuOpenId) => feishuSpeakerRole(openId, ownerOpenId) === "owner" || feishuGuestMay(ctx.guestTier, "send_files");
  const candidates = [...ctx.pendingFiles, ...message.files.map((file) => ({ messageId: message.messageId, speaker, file }))];
  const files = candidates.filter((c) => mayAttach(c.speaker)).map(({ messageId, file }) => ({ messageId, file }));
  const droppedFiles = mayAttach(speaker) ? 0 : candidates.filter((c) => c.speaker === speaker).length;
  let text = message.text;
  if (text === "" && files.length === 0) {
    const hasDiscussion = ctx.pendingContext.some((line) => line.text !== FILES_ONLY_TEXT);
    if (!message.mentionedBot || !hasDiscussion) {
      if (droppedFiles > 0) return { kind: "reject", openId: speaker, reason: GUEST_NO_FILES, guestDenied: true };
      return message.mentionedBot ? { kind: "hint", text: ONLINE_HINT } : { kind: "ignore" };
    }
    text = CONTEXT_WAKE_TEXT;
  }
  return {
    kind: "deliver",
    target: ctx.binding.target,
    text,
    origin: { kind: "feishu", openId: speaker, name: ctx.speakerName, role, mode: ctx.mode, guestTier: ctx.guestTier, context: [...ctx.pendingContext] },
    files,
    droppedFiles,
  };
}

export function feishuWakes(ctx: Pick<FeishuRoutingContext, "mode" | "triggerMode" | "mentionOnlyForced">, mentionedBot: boolean): boolean {
  if (!mentionedBot && ctx.triggerMode === "auto" && !ctx.mentionOnlyForced) return ctx.mode === "solo";
  return mentionedBot;
}

export type FeishuActionRoute =
  | { kind: "answer"; card: FeishuCardRef; optionIndex: number | null; note: string | null; clientId: string; byOpenId: FeishuOpenId }
  | { kind: "blocker_done"; card: Extract<FeishuCardRef, { kind: "blocker" }> }
  | { kind: "stop"; target: FeishuChatTarget }
  | { kind: "set_policy"; pmId: PmId; triggerMode?: FeishuTriggerMode; guestTier?: FeishuGuestTier }
  | { kind: "set_pm_model"; pmId: PmId; field: FeishuModelField; option: string }
  | { kind: "set_router_model"; field: FeishuModelField; option: string }
  | { kind: "mesh_approval"; step: "begin" | "match" | "mismatch"; requestId: string }
  | { kind: "reject"; toast: string; guestDenied?: true }
  | { kind: "ignore" };

export function routeFeishuAction(action: FeishuInboundAction, ctx: Pick<FeishuRoutingContext, "ownerOpenId" | "binding" | "guestTier">): FeishuActionRoute {
  const { ownerOpenId, binding } = ctx;
  if (ownerOpenId === null || binding === null || binding.archived) return { kind: "ignore" };
  const role = feishuSpeakerRole(action.operatorOpenId, ownerOpenId);
  const guest = role === "guest";
  const { value } = action;
  if (guest && (binding.target.kind === "router" || value.kind === "set_policy")) return { kind: "reject", toast: OWNER_ONLY_SETTINGS };
  switch (value.kind) {
    case "mesh_approval":
      if (binding.target.kind !== "router") return { kind: "ignore" };
      return { kind: "mesh_approval", step: value.step, requestId: value.requestId };
    case "set_policy":
      return {
        kind: "set_policy",
        pmId: value.pmId,
        ...(value.triggerMode !== undefined ? { triggerMode: value.triggerMode } : {}),
        ...(value.guestTier !== undefined ? { guestTier: value.guestTier } : {}),
      };
    case "set_pm_model":
      if (guest) return { kind: "reject", toast: OWNER_ONLY_SETTINGS };
      if (binding.target.kind !== "pm" || action.option === undefined || action.option.trim() === "") return { kind: "ignore" };
      return { kind: "set_pm_model", pmId: value.pmId, field: value.field, option: action.option.trim() };
    case "set_router_model":
      if (guest) return { kind: "reject", toast: OWNER_ONLY_SETTINGS };
      if (binding.target.kind !== "router" || action.option === undefined || action.option.trim() === "") return { kind: "ignore" };
      return { kind: "set_router_model", field: value.field, option: action.option.trim() };
    case "stop":
      if (guest && !feishuGuestMay(ctx.guestTier, "stop")) return { kind: "reject", toast: OWNER_ONLY_STOP, guestDenied: true };
      return { kind: "stop", target: binding.target };
    case "blocker_done":
      if (guest && !feishuGuestMay(ctx.guestTier, "answer_card")) return { kind: "reject", toast: OWNER_ONLY_DECIDE, guestDenied: true };
      return { kind: "blocker_done", card: value.card };
    case "choose":
    case "submit_note": {
      if (guest && (value.card.kind === "router_item" || !feishuGuestMay(ctx.guestTier, "answer_card"))) return { kind: "reject", toast: OWNER_ONLY_DECIDE, guestDenied: true };
      const optionIndex = value.kind === "choose" ? value.optionIndex : null;
      if (optionIndex === null && action.note === null) return { kind: "reject", toast: NOTE_REQUIRED };
      return {
        kind: "answer",
        card: value.card,
        optionIndex,
        note: action.note,
        clientId: `feishu:${createHash("sha256").update(JSON.stringify([action.messageId, action.operatorOpenId, action.token ?? [optionIndex, action.note]])).digest("hex")}`,
        byOpenId: action.operatorOpenId,
      };
    }
  }
}

export function feishuSpeakerRole(openId: FeishuOpenId, ownerOpenId: FeishuOpenId | null): FeishuSpeakerRole {
  return ownerOpenId !== null && openId === ownerOpenId ? "owner" : "guest";
}
