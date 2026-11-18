// 入站分流（docs/feishu-design.md「唤醒规则」「访客权限」）：一条飞书消息或一次按钮点击，交给总助、交给项目经理、
// 记成背景、拒绝，还是不理。
// 主客权限的硬边界在这里和账本两处：总助单聊、设置只认主人；访客能不能拍板、停止、发附件看本群档位（feishuGuestMay）；
// 访客的话触发的轮次里越界的 hub 命令由账本按 meta.origin 再拦一次（shared/feishu.ts 的 feishuGuestTurnBlockReason）。
// 不变量：这里不做 I/O、不读别的状态；成员、显示名、绑定、群策略都由调用方查好放进上下文。
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
import type { FeishuInbound, FeishuInboundAction, FeishuInboundFile } from "./inbound.ts";

type InboundMessage = Extract<FeishuInbound, { kind: "message" }>;

const NOT_YOUR_ASSISTANT = "这是主人的私人助手，只听主人的。";
const GUEST_SLASH = "以“/”开头的命令只有主人能用。";
const FILES_ONLY_TEXT = "（发了文件）";
export const OWNER_ONLY_DECIDE = "只有主人能拍板";
export const OWNER_ONLY_STOP = "只有主人能停止";
export const OWNER_ONLY_SETTINGS = "只有主人能改设置";
const NOTE_REQUIRED = "先在输入框里写点什么再提交";

export interface FeishuRoutingContext {
  /** 还没认主人时是 null：只认单聊里的绑定码，别的都不理。 */
  ownerOpenId: FeishuOpenId | null;
  /** 这个会话绑的是谁；单聊里主人发的是 router；不是 Fusa 的群是 null。 */
  binding: { target: FeishuChatTarget; archived: boolean } | null;
  mode: FeishuChatMode;
  triggerMode: FeishuTriggerMode;
  guestTier: FeishuGuestTier;
  /** 应用没开 im:message.group_msg：不管 triggerMode，一律按 mention_only。 */
  mentionOnlyForced: boolean;
  /** 发言人的显示名（调用方已查好、截好长度）。 */
  speakerName: string;
  /** 这个群上次唤醒以来记下的背景（调用方从 FeishuContextWindows 取，送达时才清）。 */
  pendingContext: readonly FeishuContextLine[];
  /** 单聊里的文字是不是当前有效的绑定码。 */
  isBindCode: (text: string) => boolean;
}

export type FeishuMessageRoute =
  | { kind: "bind_owner"; openId: FeishuOpenId }
  | {
      kind: "deliver";
      target: FeishuChatTarget;
      text: string;
      origin: FeishuMessageOrigin;
      /** 要下载、放进附件的文件；本档访客不能发附件时不收，记在 droppedFiles。 */
      files: FeishuInboundFile[];
      droppedFiles: number;
    }
  /** 不唤醒，记成背景，下次唤醒时捎上。 */
  | { kind: "context"; line: FeishuContextLine }
  /** 拒绝：在原会话回一句只说给这个人的提示（单聊直接回；群里 @他）。 */
  | { kind: "reject"; openId: FeishuOpenId; reason: string }
  | { kind: "ignore" };

/**
 * 前置：message 已过 parseFeishuEvent。
 * 后置（按顺序，命中即返回）：
 * - 单聊：没认主人且文字是有效绑定码 → bind_owner；主人 → deliver 给总助；别人 → reject（“这是 X 的私人助手”）；
 * - 不是 Fusa 的群，或还没认主人 → ignore；记录已归档（群已解散，迟到的事件）→ ignore；话题里的话 → ignore；
 * - 项目群里主人或访客发的话，是否唤醒按 wakes(ctx, mentionedBot) 定：
 *   - 唤醒：deliver，origin 带 mode、guestTier 和 ctx.pendingContext；
 *   - 不唤醒：context；
 * - 访客：observer 档一律不唤醒，说的话照样记成背景，主人下次唤醒时捎上；以“/”开头的文字 → reject（厂商斜杠命令只给主人）；
 *   本档不能 send_files 时文件不收，droppedFiles 记个数。
 */
export function routeFeishuMessage(message: InboundMessage, ctx: FeishuRoutingContext): FeishuMessageRoute {
  const { ownerOpenId } = ctx;
  const speaker = message.senderOpenId;
  if (message.chatType === "p2p") {
    if (ownerOpenId === null) return ctx.isBindCode(message.text) ? { kind: "bind_owner", openId: speaker } : { kind: "ignore" };
    if (speaker !== ownerOpenId) return { kind: "reject", openId: speaker, reason: NOT_YOUR_ASSISTANT };
    if (message.text === "" && message.files.length === 0) return { kind: "ignore" };
    return {
      kind: "deliver",
      target: { kind: "router" },
      text: message.text,
      origin: { kind: "feishu", openId: speaker, name: ctx.speakerName, role: "owner", mode: "solo", guestTier: ctx.guestTier, context: [] },
      files: message.files,
      droppedFiles: 0,
    };
  }
  if (ownerOpenId === null || ctx.binding === null || ctx.binding.archived || ctx.binding.target.kind !== "pm" || message.inThread) return { kind: "ignore" };
  if (message.text === "" && message.files.length === 0) return { kind: "ignore" };
  const role = feishuSpeakerRole(speaker, ownerOpenId);
  const line: FeishuContextLine = { name: ctx.speakerName, role, text: message.text === "" ? FILES_ONLY_TEXT : message.text, at: message.at };
  if (role === "guest" && !feishuGuestMay(ctx.guestTier, "talk")) return { kind: "context", line };
  if (!feishuWakes(ctx, message.mentionedBot)) return { kind: "context", line };
  if (role === "guest" && message.text.startsWith("/")) return { kind: "reject", openId: speaker, reason: GUEST_SLASH };
  const filesAllowed = role === "owner" || feishuGuestMay(ctx.guestTier, "send_files");
  return {
    kind: "deliver",
    target: ctx.binding.target,
    text: message.text,
    origin: { kind: "feishu", openId: speaker, name: ctx.speakerName, role, mode: ctx.mode, guestTier: ctx.guestTier, context: [...ctx.pendingContext] },
    files: filesAllowed ? message.files : [],
    droppedFiles: filesAllowed ? 0 : message.files.length,
  };
}

/**
 * 后置：auto 档下 solo 返回 true，shared 只有 mentionedBot 为 true 才返回 true；mention_only 或 mentionOnlyForced 时只看 mentionedBot。
 * 这是“单人群直聊，拉人进群后自动切 @机器人 才触发”的唯一实现。
 */
export function feishuWakes(ctx: Pick<FeishuRoutingContext, "mode" | "triggerMode" | "mentionOnlyForced">, mentionedBot: boolean): boolean {
  if (!mentionedBot && ctx.triggerMode === "auto" && !ctx.mentionOnlyForced) return ctx.mode === "solo";
  return mentionedBot;
}

export type FeishuActionRoute =
  | { kind: "answer"; card: FeishuCardRef; optionIndex: number | null; note: string | null; clientId: string; byOpenId: FeishuOpenId }
  | { kind: "blocker_done"; card: Extract<FeishuCardRef, { kind: "blocker" }> }
  | { kind: "stop"; target: FeishuChatTarget }
  | { kind: "set_policy"; pmId: PmId; triggerMode?: FeishuTriggerMode; guestTier?: FeishuGuestTier }
  /** 拒绝：toast 给点的人看。 */
  | { kind: "reject"; toast: string }
  | { kind: "ignore" };

/**
 * 后置：还没认主人 → ignore；set_policy 只认主人；访客点 choose / submit_note / blocker_done 看 feishuGuestMay(tier, "answer_card")，
 * 点 stop 看 feishuGuestMay(tier, "stop")，不允许时 reject（“只有主人能拍板 / 停止”）。
 * answer 的 clientId 由这张卡的消息编号、点的人和动作派生：同一次点击重投得到同一个 clientId，账本按它幂等。
 */
export function routeFeishuAction(action: FeishuInboundAction, ctx: Pick<FeishuRoutingContext, "ownerOpenId" | "binding" | "guestTier">): FeishuActionRoute {
  const { ownerOpenId, binding } = ctx;
  if (ownerOpenId === null || binding === null || binding.archived) return { kind: "ignore" };
  const role = feishuSpeakerRole(action.operatorOpenId, ownerOpenId);
  const guest = role === "guest";
  const { value } = action;
  if (guest && (binding.target.kind === "router" || value.kind === "set_policy")) return { kind: "reject", toast: OWNER_ONLY_SETTINGS };
  switch (value.kind) {
    case "set_policy":
      return {
        kind: "set_policy",
        pmId: value.pmId,
        ...(value.triggerMode !== undefined ? { triggerMode: value.triggerMode } : {}),
        ...(value.guestTier !== undefined ? { guestTier: value.guestTier } : {}),
      };
    case "stop":
      if (guest && !feishuGuestMay(ctx.guestTier, "stop")) return { kind: "reject", toast: OWNER_ONLY_STOP };
      return { kind: "stop", target: binding.target };
    case "blocker_done":
      if (guest && !feishuGuestMay(ctx.guestTier, "answer_card")) return { kind: "reject", toast: OWNER_ONLY_DECIDE };
      return { kind: "blocker_done", card: value.card };
    case "choose":
    case "submit_note": {
      if (guest && (value.card.kind === "router_item" || !feishuGuestMay(ctx.guestTier, "answer_card"))) return { kind: "reject", toast: OWNER_ONLY_DECIDE };
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

/** 后置：openId 是主人返回 owner，否则 guest。ownerOpenId 为 null 时一律 guest。 */
export function feishuSpeakerRole(openId: FeishuOpenId, ownerOpenId: FeishuOpenId | null): FeishuSpeakerRole {
  return ownerOpenId !== null && openId === ownerOpenId ? "owner" : "guest";
}
