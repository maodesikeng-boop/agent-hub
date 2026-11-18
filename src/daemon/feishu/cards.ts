// 卡片（docs/feishu-design.md「拍板卡」「访客权限」）：账本里等用户拍板的东西画成飞书卡片 JSON 2.0，按钮回传的值在这里编解码。
// 不变量：
// - 卡片的真相在账本（AskMeta、router_items、user_blockers、任务图门禁），飞书卡片只是投影；回答一律走账本原有的接口，
//   账本推 message.updated / router.item.updated 后再把卡片改成“已定案”，网页和飞书点哪边都一样；
// - 按钮值只带编号，不带选项原文；处理时照账本现状重新校验；
// - 所有卡片 schema 为 "2.0"、update_multi 为 true（流式更新文本不支持独享卡片）。
import type { AskMeta, ConversationId, Message, MessageId, PmId, RouterItemId, TaskGraphId, TaskNodeKey } from "../../shared/domain.ts";
import type { FeishuChatId, FeishuGuestTier, FeishuTriggerMode } from "../../shared/feishu.ts";
import type { RouterItem } from "../../shared/router.ts";
import type { UserBlockerId } from "../../shared/user-blockers.ts";

/** 卡片 JSON 2.0（只在这一层拼，序列化后交给传输层）。 */
export interface FeishuCardJson {
  schema: "2.0";
  config: Record<string, unknown>;
  header?: Record<string, unknown>;
  body: { elements: Record<string, unknown>[] };
}

/** 流式卡片里正文那个 markdown 组件的 element_id，流式更新文本按它找。 */
export const FEISHU_STREAM_ELEMENT_ID = "reply";
/** 流式卡片里停止按钮的 element_id，定稿时删掉。 */
export const FEISHU_STOP_ELEMENT_ID = "stop";

/** 一张卡对应账本里的哪样东西，决定点了按钮调哪个账本接口。 */
export type FeishuCardRef =
  | { kind: "ask"; askMessageId: MessageId }
  | { kind: "gate"; askMessageId: MessageId; graphId: TaskGraphId; nodeKey: TaskNodeKey }
  | { kind: "blocker"; askMessageId: MessageId; blockerId: UserBlockerId }
  | { kind: "router_item"; itemId: RouterItemId };

/** 按钮回传的动作。 */
export type FeishuActionValue =
  /** 选一个选项（检查点卡的“通过 / 打回”也是选项）；表单里的补充说明一起回传。 */
  | { kind: "choose"; card: FeishuCardRef; optionIndex: number }
  /** 没有选项的提问：只交补充说明。 */
  | { kind: "submit_note"; card: FeishuCardRef }
  | { kind: "blocker_done"; card: Extract<FeishuCardRef, { kind: "blocker" }> }
  | { kind: "stop"; conversationId: ConversationId }
  /** 群里那张“访客权限”卡上的按钮。 */
  | { kind: "set_policy"; pmId: PmId; triggerMode?: FeishuTriggerMode; guestTier?: FeishuGuestTier };

/** 后置：返回放进按钮 behaviors.callback.value 的对象。decodeFeishuActionValue(encode(v)) 深等于 v。 */
export function encodeFeishuActionValue(value: FeishuActionValue): Record<string, unknown> {
  throw new Error("未实现");
}

/** 后置：形状对返回动作，不对（被改过、老版本的卡）返回 null。 */
export function decodeFeishuActionValue(raw: unknown): FeishuActionValue | null {
  throw new Error("未实现");
}

/** 卡片在飞书里的样子：等拍板、已定案（谁、选了什么、补充说明）、被项目经理关掉或替换。 */
export type FeishuCardState =
  | { kind: "pending" }
  | { kind: "answered"; chosenOption: string | null; note: string | null; byName: string }
  | { kind: "closed" };

/**
 * 前置：message 是 askOf(message) 不为 null 的项目经理消息，ask 是它的 meta。
 * 后置：pending 时卡片里有一个表单：“补充说明”输入框和选项按钮（推荐项排第一、标“推荐”），点哪个选项都连同输入框一起回传；
 * 检查点卡是“通过 / 打回”，提醒卡是“已处理”；answered / closed 时没有按钮，写明结论。交付物不放进卡片（files.ts 单独发）。
 */
export function renderAskCard(message: Message, ask: AskMeta, state: FeishuCardState): FeishuCardJson {
  throw new Error("未实现");
}

/**
 * 后置：总助单聊里的一条：简报是摘要；带 askMessageId 的拍板项写一行摘要和“去项目群拍板”按钮（打开那个群，不重复放选项）；
 * 没有 askMessageId 的拍板项带选项按钮。
 */
export function renderRouterItem(item: RouterItem, pmChatId: FeishuChatId | null): FeishuCardJson {
  throw new Error("未实现");
}

/**
 * 流式回复卡片：一个 element_id 为 FEISHU_STREAM_ELEMENT_ID 的 markdown 组件，withStop 时下面一个停止按钮。
 * 后置：streaming 为 true 时 config.streaming_mode 为 true，streaming_config 照 FEISHU_STREAM_PRINT_* 设，摘要是正文开头一行。
 */
export function renderReplyCard(input: { conversationId: ConversationId; text: string; streaming: boolean; withStop: boolean }): FeishuCardJson {
  throw new Error("未实现");
}

/**
 * 群里有访客加入时发的“访客权限”卡：写明当前唤醒方式和档位，按钮切换（只认主人）。
 * 后置：当前选中的档位和唤醒方式按钮是禁用的样子；mentionOnlyForced 为 true（应用没开 im:message.group_msg）时不给切回 auto。
 */
export function renderChatPolicyCard(input: {
  pmId: PmId;
  triggerMode: FeishuTriggerMode;
  guestTier: FeishuGuestTier;
  mentionOnlyForced: boolean;
}): FeishuCardJson {
  throw new Error("未实现");
}
