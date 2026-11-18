// 卡片（docs/feishu-design.md「拍板卡」「访客权限」）：账本里等用户拍板的东西画成飞书卡片 JSON 2.0，按钮回传的值在这里编解码。
// 不变量：
// - 卡片的真相在账本（AskMeta、router_items、user_blockers、任务图门禁），飞书卡片只是投影；回答一律走账本原有的接口，
//   账本推 message.updated / router.item.updated 后再把卡片改成“已定案”，网页和飞书点哪边都一样；
// - 按钮值只带编号，不带选项原文；处理时照账本现状重新校验；
// - 所有卡片 schema 为 "2.0"、update_multi 为 true（流式更新文本不支持独享卡片）。
import { z } from "zod";
import { CONFIRM_CHECKPOINT_OPTIONS } from "../../shared/domain.ts";
import type { AskMeta, ConversationId, Message, MessageId, PmId, RouterItemId, TaskGraphId, TaskNodeKey } from "../../shared/domain.ts";
import { FEISHU_GUEST_TIERS, FEISHU_TRIGGER_MODES } from "../../shared/feishu.ts";
import type { FeishuChatId, FeishuGuestTier, FeishuTriggerMode } from "../../shared/feishu.ts";
import { FEISHU_CARD_MAX_BYTES, FEISHU_CARD_MAX_CHARS, FEISHU_STREAM_PRINT_FREQUENCY_MS, FEISHU_STREAM_PRINT_STEP } from "../../shared/limits.ts";
import type { RouterItem } from "../../shared/router.ts";
import type { UserBlockerId } from "../../shared/user-blockers.ts";
import { feishuCardMarkdown, feishuMarkdownFit } from "./outbound.ts";

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

/** 按钮值里的版本标记：以后改形状时换版本，老卡片的点击解不出来，回“这张卡已过期”。 */
const ACTION_MARKER = "fusa";
const ACTION_VERSION = 1;

const id = z.number().int().nonnegative();
const askRef = z.object({ kind: z.literal("ask"), askMessageId: id }).strict();
const gateRef = z.object({ kind: z.literal("gate"), askMessageId: id, graphId: id, nodeKey: z.string().min(1) }).strict();
const blockerRef = z.object({ kind: z.literal("blocker"), askMessageId: id, blockerId: id }).strict();
const routerItemRef = z.object({ kind: z.literal("router_item"), itemId: id }).strict();
const cardRef = z.discriminatedUnion("kind", [askRef, gateRef, blockerRef, routerItemRef]);
const actionValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choose"), card: cardRef, optionIndex: id }),
  z.object({ kind: z.literal("submit_note"), card: cardRef }),
  z.object({ kind: z.literal("blocker_done"), card: blockerRef }),
  z.object({ kind: z.literal("stop"), conversationId: id }),
  z
    .object({ kind: z.literal("set_policy"), pmId: id, triggerMode: z.enum(FEISHU_TRIGGER_MODES).optional(), guestTier: z.enum(FEISHU_GUEST_TIERS).optional() })
    .refine((v) => v.triggerMode !== undefined || v.guestTier !== undefined),
]);

/** 后置：返回放进按钮 behaviors.callback.value 的对象。decodeFeishuActionValue(encode(v)) 深等于 v。 */
export function encodeFeishuActionValue(value: FeishuActionValue): Record<string, unknown> {
  return { [ACTION_MARKER]: ACTION_VERSION, ...value };
}

/** 后置：形状对返回动作，不对（被改过、老版本的卡）返回 null。 */
export function decodeFeishuActionValue(raw: unknown): FeishuActionValue | null {
  if (typeof raw !== "object" || raw === null || (raw as Record<string, unknown>)[ACTION_MARKER] !== ACTION_VERSION) return null;
  const parsed = actionValueSchema.safeParse(raw);
  return parsed.success ? (parsed.data as FeishuActionValue) : null;
}

/** 卡片在飞书里的样子：等拍板、已定案（谁、选了什么、补充说明）、被项目经理关掉或替换。 */
export type FeishuCardState =
  | { kind: "pending" }
  | { kind: "answered"; chosenOption: string | null; note: string | null; byName: string }
  | { kind: "closed" };

/** 补充说明输入框在表单里的 name，点按钮时连同表单回传（FeishuRawCardAction.formValue）。 */
export const FEISHU_NOTE_FIELD = "note";
const FORM_NAME = "answer";

const plain = (content: string) => ({ tag: "plain_text", content });
const markdown = (content: string, elementId?: string): Record<string, unknown> => ({
  tag: "markdown",
  content,
  ...(elementId !== undefined ? { element_id: elementId } : {}),
});
const callback = (value: FeishuActionValue) => [{ type: "callback", value: encodeFeishuActionValue(value) }];

function button(input: {
  text: string;
  value: FeishuActionValue;
  type?: "primary" | "default" | "danger";
  disabled?: boolean;
  submit?: boolean;
  name?: string;
  elementId?: string;
}): Record<string, unknown> {
  return {
    tag: "button",
    text: plain(input.text),
    type: input.type ?? "default",
    ...(input.disabled === true ? { disabled: true } : {}),
    ...(input.submit === true ? { form_action_type: "submit", name: input.name ?? "submit" } : {}),
    ...(input.elementId !== undefined ? { element_id: input.elementId } : {}),
    behaviors: callback(input.value),
  };
}

function linkButton(text: string, url: string): Record<string, unknown> {
  return { tag: "button", text: plain(text), type: "default", behaviors: [{ type: "open_url", default_url: url }] };
}

/** 手机飞书里点开直接进群（docs/feishu-design.md「需要真机核对」第三条）。 */
export function feishuChatAppLink(chatId: FeishuChatId): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

function card(input: { title: string; template: string; summary: string; elements: Record<string, unknown>[]; config?: Record<string, unknown> }): FeishuCardJson {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: summaryLine(input.summary) }, ...input.config },
    header: { title: plain(input.title), template: input.template },
    body: { elements: input.elements },
  };
}

const TRUNCATED_NOTE = "\n\n……后面太长，完整内容去网页看";
const cardBytes = (c: FeishuCardJson) => Buffer.byteLength(JSON.stringify(c));

/**
 * 正文按 feishuCardMarkdown 换掉图片和本机链接后放进一张卡：放得下原样放；字数超过 FEISHU_CARD_MAX_CHARS，或连同按钮、定案说明超过 FEISHU_CARD_MAX_BYTES 时，
 * 截到放得下并在末尾写明去网页看。build 用给它的正文拼整张卡，正文以外的部分（按钮、说明、摘要）不随正文变。
 */
function fitBody(markdown: string, build: (body: string) => FeishuCardJson): FeishuCardJson {
  const text = feishuCardMarkdown(markdown);
  const whole = build(text);
  if (feishuMarkdownFit(text, FEISHU_CARD_MAX_CHARS, Infinity).length === text.length && cardBytes(whole) <= FEISHU_CARD_MAX_BYTES) return whole;
  const room = FEISHU_CARD_MAX_BYTES - cardBytes(build(TRUNCATED_NOTE));
  return build(feishuMarkdownFit(text, FEISHU_CARD_MAX_CHARS - TRUNCATED_NOTE.length, room) + TRUNCATED_NOTE);
}

/** 卡片摘要（会话列表里看到的那一行）：正文第一行非空的字（图片和本机链接照 feishuCardMarkdown 换过），最多 60 字。 */
function summaryLine(text: string): string {
  const line = feishuCardMarkdown(text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "");
  return [...line].length > 60 ? `${[...line].slice(0, 59).join("")}…` : line;
}

/** 这张提问卡对应账本里的哪样东西。 */
export function feishuCardRefOf(message: Message, ask: AskMeta): FeishuCardRef {
  if (ask.blockerRef !== undefined) return { kind: "blocker", askMessageId: message.id, blockerId: ask.blockerRef.blockerId };
  if (ask.gateRef !== undefined) return { kind: "gate", askMessageId: message.id, graphId: ask.gateRef.graphId, nodeKey: ask.gateRef.nodeKey };
  return { kind: "ask", askMessageId: message.id };
}

/** 提问卡的选项（检查点卡没带选项时是“通过 / 打回”）。 */
export function feishuAskOptions(ask: AskMeta): readonly string[] {
  if (ask.options !== undefined) return ask.options;
  return ask.gateRef?.checkpoint === true ? CONFIRM_CHECKPOINT_OPTIONS : [];
}

/** 卡片在飞书里该画成什么样（账本现状 → FeishuCardState）。byName 是定案人的显示名（飞书里点的是点的人，网页上点的是主人）。 */
export function feishuCardStateOf(ask: AskMeta, byName: string): FeishuCardState {
  if (ask.closed === true) return { kind: "closed" };
  if (ask.answered === true) return { kind: "answered", chosenOption: ask.chosenOption ?? null, note: ask.answerNote ?? null, byName };
  return { kind: "pending" };
}

function askTitle(ask: AskMeta): { title: string; template: string } {
  if (ask.blockerRef !== undefined) return { title: "要你动手", template: "orange" };
  if (ask.gateRef?.checkpoint === true) return { title: "检查点", template: "purple" };
  return { title: "等你确定", template: "blue" };
}

function settledElements(state: Exclude<FeishuCardState, { kind: "pending" }>): Record<string, unknown>[] {
  if (state.kind === "closed") return [markdown("**已关闭**：项目经理关掉或替换了这张卡")];
  const lines = [state.chosenOption !== null ? `**已定案**：${state.byName} 选了「${state.chosenOption}」` : `**已定案**：${state.byName} 回复了`];
  if (state.note !== null) lines.push(`补充说明：${state.note}`);
  return [markdown(lines.join("\n"))];
}

/** 等拍板时的按钮：选项按钮（推荐项排第一、标推荐）和补充说明输入框放在一个表单里；提醒卡只有“已处理”。 */
function pendingElements(ref: FeishuCardRef, ask: AskMeta | null, options: readonly string[], recommended: string | undefined): Record<string, unknown>[] {
  if (ref.kind === "blocker") return [button({ text: "已处理", type: "primary", value: { kind: "blocker_done", card: ref } })];
  const rec = recommended === undefined ? -1 : options.indexOf(recommended);
  const order = rec < 0 ? options.map((_, i) => i) : [rec, ...options.map((_, i) => i).filter((i) => i !== rec)];
  const buttons =
    options.length === 0
      ? [button({ text: "提交", type: "primary", submit: true, value: { kind: "submit_note", card: ref } })]
      : order.map((i) =>
          button({
            text: i === rec ? `${options[i]!}（推荐）` : options[i]!,
            type: i === rec ? "primary" : "default",
            submit: true,
            name: `option_${i}`,
            value: { kind: "choose", card: ref, optionIndex: i },
          }),
        );
  const placeholder = ask?.gateRef?.checkpoint === true ? "打回时写清要改什么（选填）" : "补充说明（选填）";
  return [
    {
      tag: "form",
      name: FORM_NAME,
      elements: [{ tag: "input", name: FEISHU_NOTE_FIELD, placeholder: plain(placeholder), max_length: 1000 }, ...buttons],
    },
  ];
}

/**
 * 前置：message 是 askOf(message) 不为 null 的项目经理消息，ask 是它的 meta。
 * 后置：pending 时卡片里有一个表单：“补充说明”输入框和选项按钮（推荐项排第一、标“推荐”），点哪个选项都连同输入框一起回传；
 * 检查点卡是“通过 / 打回”，提醒卡是“已处理”；answered / closed 时没有按钮，写明结论。交付物不放进卡片（files.ts 单独发）。
 */
export function renderAskCard(message: Message, ask: AskMeta, state: FeishuCardState): FeishuCardJson {
  return askCard(message, ask, state, []);
}

/** 提问卡，正文下面的按钮和说明之后再接 extra（总助单聊里的“打开项目群”）；正文按 fitBody 放。 */
function askCard(message: Message, ask: AskMeta, state: FeishuCardState, extra: Record<string, unknown>[]): FeishuCardJson {
  const { title, template } = askTitle(ask);
  const ref = feishuCardRefOf(message, ask);
  const rest = [...(state.kind === "pending" ? pendingElements(ref, ask, feishuAskOptions(ask), ask.recommended) : settledElements(state)), ...extra];
  return fitBody(message.text, (body) => card({ title, template, summary: message.text, elements: [markdown(body), ...rest] }));
}

/**
 * 总助单聊里的一条。
 * 前置：ask 是 item 引用的那张提问卡（item 带 askMessageId 时调用方从账本取来），没有引用是 null。
 * 后置：简报是摘要和“打开项目群”按钮；带 ask 的拍板项和项目群里那张卡用同一个 FeishuCardRef（kind ask / gate / blocker），
 * 选项、补充说明和定案样子都照 renderAskCard，另加“打开项目群”按钮；没有 ask 的拍板项用 kind router_item 的选项按钮。
 * 两处卡片点哪一处都走同一个账本接口，定案后两处一起改。
 */
export function renderRouterItem(
  item: RouterItem,
  ask: { message: Message; meta: AskMeta } | null,
  state: FeishuCardState,
  pmChatId: FeishuChatId | null,
): FeishuCardJson {
  const openChat = pmChatId === null ? [] : [linkButton("打开项目群", feishuChatAppLink(pmChatId))];
  if (item.kind === "report") {
    return fitBody(item.summary, (body) => card({ title: "简报", template: "turquoise", summary: item.summary, elements: [markdown(body), ...openChat] }));
  }
  if (ask !== null) return askCard(ask.message, ask.meta, state, openChat);
  const ref: FeishuCardRef = { kind: "router_item", itemId: item.id };
  const text = item.context.trim() === "" ? item.question : `${item.question}\n\n${item.context}`;
  const rest = [...(state.kind === "pending" ? pendingElements(ref, null, item.options, undefined) : settledElements(state)), ...openChat];
  return fitBody(text, (body) => card({ title: "等你确定", template: "blue", summary: item.question, elements: [markdown(body), ...rest] }));
}

/**
 * 流式回复卡片：一个 element_id 为 FEISHU_STREAM_ELEMENT_ID 的 markdown 组件，withStop 时下面一个停止按钮。
 * 后置：streaming 为 true 时 config.streaming_mode 为 true，streaming_config 照 FEISHU_STREAM_PRINT_* 设，摘要是正文开头一行。
 */
export function renderReplyCard(input: { conversationId: ConversationId; text: string; streaming: boolean; withStop: boolean }): FeishuCardJson {
  const elements: Record<string, unknown>[] = [markdown(input.text, FEISHU_STREAM_ELEMENT_ID)];
  if (input.withStop) {
    elements.push(button({ text: "停止", type: "danger", elementId: FEISHU_STOP_ELEMENT_ID, value: { kind: "stop", conversationId: input.conversationId } }));
  }
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: summaryLine(input.text) },
      ...(input.streaming
        ? {
            streaming_mode: true,
            streaming_config: {
              print_frequency_ms: { default: FEISHU_STREAM_PRINT_FREQUENCY_MS },
              print_step: { default: FEISHU_STREAM_PRINT_STEP },
              print_strategy: "fast",
            },
          }
        : { streaming_mode: false }),
    },
    body: { elements },
  };
}

export const TRIGGER_LABELS: Readonly<Record<FeishuTriggerMode, string>> = { auto: "只有我时直聊，有别人时 @机器人", mention_only: "一直要 @机器人" };
export const TIER_LABELS: Readonly<Record<FeishuGuestTier, string>> = { chat_only: "仅对话", collaborator: "协作者", observer: "只读" };

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
  const trigger: FeishuTriggerMode = input.mentionOnlyForced ? "mention_only" : input.triggerMode;
  const lines = [
    `**唤醒方式**：${TRIGGER_LABELS[trigger]}${input.mentionOnlyForced ? "（应用没开收群消息的权限，只能 @机器人）" : ""}`,
    `**访客权限**：${TIER_LABELS[input.guestTier]}`,
    "只有主人能改。",
  ];
  const triggerButtons = FEISHU_TRIGGER_MODES.filter((mode) => !(input.mentionOnlyForced && mode === "auto")).map((mode) =>
    button({ text: TRIGGER_LABELS[mode], disabled: mode === trigger, type: mode === trigger ? "primary" : "default", value: { kind: "set_policy", pmId: input.pmId, triggerMode: mode } }),
  );
  const tierButtons = FEISHU_GUEST_TIERS.map((tier) =>
    button({ text: TIER_LABELS[tier], disabled: tier === input.guestTier, type: tier === input.guestTier ? "primary" : "default", value: { kind: "set_policy", pmId: input.pmId, guestTier: tier } }),
  );
  return card({ title: "访客权限", template: "grey", summary: "访客权限", elements: [markdown(lines.join("\n")), ...triggerButtons, ...tierButtons] });
}

/** 回复正文被飞书拒收（内容不合规、超限）时卡片上换成的话：卡片照样能关流式、去停止按钮。 */
export function unrenderableReplyText(code: number): string {
  return `这段回复飞书显示不了（错误码 ${code}），完整内容去网页看。`;
}

/** 不再改的一张通知卡：总助指令的结果、网页上发的话的镜像、断线补发的提示。 */
export function renderTextCard(input: { title: string; text: string; template?: string }): FeishuCardJson {
  return card({ title: input.title, template: input.template ?? "wathet", summary: input.text, elements: [markdown(input.text)] });
}
