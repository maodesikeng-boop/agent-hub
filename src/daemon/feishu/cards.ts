import { z } from "zod";
import { CONFIRM_CHECKPOINT_OPTIONS } from "../../shared/domain.ts";
import type { AskMeta, ConversationId, Message, MessageId, PmId, RouterItemId, TaskGraphId, TaskNodeKey } from "../../shared/domain.ts";
import { FEISHU_GUEST_TIERS, FEISHU_TRIGGER_MODES } from "../../shared/feishu.ts";
import type { FeishuChatId, FeishuGuestTier, FeishuTriggerMode } from "../../shared/feishu.ts";
import { FEISHU_CARD_MAX_BYTES, FEISHU_CARD_MAX_CHARS, FEISHU_STREAM_PRINT_FREQUENCY_MS, FEISHU_STREAM_PRINT_STEP } from "../../shared/limits.ts";
import type { MeshApprovalView } from "../../shared/mesh.ts";
import type { RouterItem, RouterSettings } from "../../shared/router.ts";
import type { UserBlockerId } from "../../shared/user-blockers.ts";
import type { ModelCatalog } from "../../shared/vendors.ts";
import {
  buildPmModelSection,
  buildRouterModelSection,
  FEISHU_MODEL_FIELDS,
  type FeishuModelField,
  type FeishuModelSectionView,
  type FeishuPmModelView,
  type FeishuSelectOption,
} from "./model-picker.ts";
import { feishuCardMarkdown, feishuMarkdownFit } from "./outbound.ts";

export interface FeishuCardJson {
  schema: "2.0";
  config: Record<string, unknown>;
  header?: Record<string, unknown>;
  body: { elements: Record<string, unknown>[] };
}

export const FEISHU_STREAM_ELEMENT_ID = "reply";
export const FEISHU_STOP_ELEMENT_ID = "stop";

export type FeishuCardRef =
  | { kind: "ask"; askMessageId: MessageId }
  | { kind: "gate"; askMessageId: MessageId; graphId: TaskGraphId; nodeKey: TaskNodeKey }
  | { kind: "blocker"; askMessageId: MessageId; blockerId: UserBlockerId }
  | { kind: "router_item"; itemId: RouterItemId };

export type FeishuActionValue =
  | { kind: "choose"; card: FeishuCardRef; optionIndex: number }
  | { kind: "submit_note"; card: FeishuCardRef }
  | { kind: "blocker_done"; card: Extract<FeishuCardRef, { kind: "blocker" }> }
  | { kind: "stop"; conversationId: ConversationId }
  | { kind: "set_policy"; pmId: PmId; triggerMode?: FeishuTriggerMode; guestTier?: FeishuGuestTier }
  | { kind: "set_pm_model"; pmId: PmId; field: FeishuModelField }
  | { kind: "set_router_model"; field: FeishuModelField }
  | { kind: "mesh_approval"; step: "begin" | "match" | "mismatch"; requestId: string };

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
  z.object({ kind: z.literal("set_pm_model"), pmId: id, field: z.enum(FEISHU_MODEL_FIELDS) }),
  z.object({ kind: z.literal("set_router_model"), field: z.enum(FEISHU_MODEL_FIELDS) }),
  z.object({ kind: z.literal("mesh_approval"), step: z.enum(["begin", "match", "mismatch"]), requestId: z.string().min(1).max(64) }),
]);

export function encodeFeishuActionValue(value: FeishuActionValue): Record<string, unknown> {
  return { [ACTION_MARKER]: ACTION_VERSION, ...value };
}

export function decodeFeishuActionValue(raw: unknown): FeishuActionValue | null {
  if (typeof raw !== "object" || raw === null || (raw as Record<string, unknown>)[ACTION_MARKER] !== ACTION_VERSION) return null;
  const parsed = actionValueSchema.safeParse(raw);
  return parsed.success ? (parsed.data as FeishuActionValue) : null;
}

export type FeishuAttachmentView =
  | { kind: "image"; name: string; imageKey: string }
  | { kind: "uploading"; name: string }
  | { kind: "sent"; name: string }
  | { kind: "failed"; name: string }
  | { kind: "too_large"; name: string; bytes: number };

const megabytes = (bytes: number) => `${Math.ceil(bytes / 1024 / 1024)} MB`;

function attachmentLine(view: Exclude<FeishuAttachmentView, { kind: "image" }>): string {
  switch (view.kind) {
    case "uploading":
      return `Uploading ${view.name}…`;
    case "sent":
      return `已送达：${view.name}`;
    case "failed":
      return `「${view.name}」没发出去，去网页看`;
    case "too_large":
      return `「${view.name}」有 ${megabytes(view.bytes)}，超过飞书的上限，去网页看`;
  }
}

function attachmentElements(views: readonly FeishuAttachmentView[]): Record<string, unknown>[] {
  const images = views.flatMap((v) =>
    v.kind === "image" ? [{ tag: "img", img_key: v.imageKey, alt: plain(v.name), scale_type: "fit_horizontal", preview: true }] : [],
  );
  const lines = views.flatMap((v) => (v.kind === "image" ? [] : [attachmentLine(v)]));
  return lines.length === 0 ? images : [...images, { tag: "markdown", content: lines.join("\n"), text_size: "notation" }];
}

export type FeishuCardState =
  | { kind: "pending" }
  | { kind: "answered"; chosenOption: string | null; note: string | null; byName: string }
  | { kind: "closed" };

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

function fitBody(markdown: string, build: (body: string) => FeishuCardJson): FeishuCardJson {
  const text = feishuCardMarkdown(markdown);
  const whole = build(text);
  if (feishuMarkdownFit(text, FEISHU_CARD_MAX_CHARS, Infinity).length === text.length && cardBytes(whole) <= FEISHU_CARD_MAX_BYTES) return whole;
  const room = FEISHU_CARD_MAX_BYTES - cardBytes(build(TRUNCATED_NOTE));
  return build(feishuMarkdownFit(text, FEISHU_CARD_MAX_CHARS - TRUNCATED_NOTE.length, room) + TRUNCATED_NOTE);
}

function summaryLine(text: string): string {
  const line = feishuCardMarkdown(text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "");
  return [...line].length > 60 ? `${[...line].slice(0, 59).join("")}…` : line;
}

export function feishuCardRefOf(message: Message, ask: AskMeta): FeishuCardRef {
  if (ask.blockerRef !== undefined) return { kind: "blocker", askMessageId: message.id, blockerId: ask.blockerRef.blockerId };
  if (ask.gateRef !== undefined) return { kind: "gate", askMessageId: message.id, graphId: ask.gateRef.graphId, nodeKey: ask.gateRef.nodeKey };
  return { kind: "ask", askMessageId: message.id };
}

export function feishuAskOptions(ask: AskMeta): readonly string[] {
  if (ask.options !== undefined) return ask.options;
  return ask.gateRef?.checkpoint === true ? CONFIRM_CHECKPOINT_OPTIONS : [];
}

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

export function renderAskCard(message: Message, ask: AskMeta, state: FeishuCardState, attachments: readonly FeishuAttachmentView[] = []): FeishuCardJson {
  return askCard(message, ask, state, attachments, []);
}

function askCard(
  message: Message,
  ask: AskMeta,
  state: FeishuCardState,
  attachments: readonly FeishuAttachmentView[],
  extra: Record<string, unknown>[],
  pmName?: string,
): FeishuCardJson {
  const base = askTitle(ask);
  const title = pmName !== undefined && pmName.trim() !== "" ? `${base.title} · ${pmName.trim()}` : base.title;
  const { template } = base;
  const ref = feishuCardRefOf(message, ask);
  const rest = [
    ...attachmentElements(attachments),
    ...(state.kind === "pending" ? pendingElements(ref, ask, feishuAskOptions(ask), ask.recommended) : settledElements(state)),
    ...extra,
  ];
  return fitBody(message.text, (body) => card({ title, template, summary: message.text, elements: [markdown(body), ...rest] }));
}

export function renderRouterAskCard(
  message: Message,
  ask: AskMeta,
  state: FeishuCardState,
  pmChatId: FeishuChatId | null,
  attachments: readonly FeishuAttachmentView[] = [],
  pmName?: string,
): FeishuCardJson {
  const openChat = pmChatId === null ? [] : [linkButton("打开项目群", feishuChatAppLink(pmChatId))];
  return askCard(message, ask, state, attachments, openChat, pmName);
}

export function renderRouterItem(
  item: RouterItem,
  ask: { message: Message; meta: AskMeta } | null,
  state: FeishuCardState,
  pmChatId: FeishuChatId | null,
  attachments: readonly FeishuAttachmentView[] = [],
): FeishuCardJson {
  const openChat = pmChatId === null ? [] : [linkButton("打开项目群", feishuChatAppLink(pmChatId))];
  if (item.kind === "report") {
    return fitBody(item.summary, (body) => card({ title: "简报", template: "turquoise", summary: item.summary, elements: [markdown(body), ...openChat] }));
  }
  if (ask !== null) return askCard(ask.message, ask.meta, state, attachments, openChat);
  const ref: FeishuCardRef = { kind: "router_item", itemId: item.id };
  const text = item.context.trim() === "" ? item.question : `${item.question}\n\n${item.context}`;
  const rest = [...(state.kind === "pending" ? pendingElements(ref, null, item.options, undefined) : settledElements(state)), ...openChat];
  return fitBody(text, (body) => card({ title: "等你确定", template: "blue", summary: item.question, elements: [markdown(body), ...rest] }));
}

export function renderReplyCard(input: {
  conversationId: ConversationId;
  text: string;
  streaming: boolean;
  withStop: boolean;
  attachments?: readonly FeishuAttachmentView[];
}): FeishuCardJson {
  const attachments = attachmentElements(input.attachments ?? []);
  const elements: Record<string, unknown>[] = input.text === "" && attachments.length > 0 ? [...attachments] : [markdown(input.text, FEISHU_STREAM_ELEMENT_ID), ...attachments];
  if (input.withStop) {
    elements.push(button({ text: "停止", type: "danger", elementId: FEISHU_STOP_ELEMENT_ID, value: { kind: "stop", conversationId: input.conversationId } }));
  }
  return {
    schema: "2.0",
    config: {
      // Streaming text updates reject exclusive cards, so every card is shared.
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

export const TRIGGER_LABELS: Readonly<Record<FeishuTriggerMode, string>> = { auto: "自动", mention_only: "仅 @ 唤醒" };
const TRIGGER_DESCRIPTIONS: Readonly<Record<FeishuTriggerMode, string>> = {
  auto: "群里只有你时直接说，有别人时要 @机器人",
  mention_only: "不管几个人，都要 @机器人 才回",
};
export const TIER_LABELS: Readonly<Record<FeishuGuestTier, string>> = { chat_only: "仅对话", collaborator: "协作者", observer: "只读" };
const TIER_DESCRIPTIONS: Readonly<Record<FeishuGuestTier, string>> = {
  collaborator: "可对话、发文件、点拍板卡与停止",
  chat_only: "只能文字聊天，不收文件",
  observer: "只旁听，@机器人 也不唤醒",
};
const TIER_ORDER: readonly FeishuGuestTier[] = ["collaborator", "chat_only", "observer"];

function choiceRow(choices: readonly { text: string; chosen: boolean; value: FeishuActionValue }[]): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: choices.map((c) => ({
      tag: "column",
      width: "auto",
      elements: [button({ text: c.chosen ? `✓ ${c.text}` : c.text, type: c.chosen ? "primary" : "default", value: c.value })],
    })),
  };
}

const HR = { tag: "hr" };

function selectRow(input: {
  label: string;
  initialOption: string;
  options: readonly FeishuSelectOption[];
  value: FeishuActionValue;
}): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: [
      {
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [markdown(input.label)],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [
          {
            tag: "select_static",
            width: "fill",
            initial_option: input.initialOption,
            options: input.options.map((o) => ({ text: plain(o.label), value: o.value })),
            behaviors: callback(input.value),
          },
        ],
      },
    ],
  };
}

function modelSectionElements(
  section: FeishuModelSectionView,
  actionFor: (field: FeishuModelField) => FeishuActionValue,
): Record<string, unknown>[] {
  return [
    markdown(`**模型与思考程度**\n${section.summary}`),
    ...section.selects.map((s) => selectRow({ label: s.label, initialOption: s.initialOption, options: s.options, value: actionFor(s.field) })),
    ...(section.fixedEffortNote !== null ? [markdown(section.fixedEffortNote)] : []),
  ];
}

export function renderChatPolicyCard(input: {
  pmId: PmId;
  agent: FeishuPmModelView;
  catalogs: readonly ModelCatalog[];
  triggerMode: FeishuTriggerMode;
  guestTier: FeishuGuestTier;
  mentionOnlyForced: boolean;
}): FeishuCardJson {
  const models = modelSectionElements(buildPmModelSection(input.agent, input.catalogs), (field) => ({
    kind: "set_pm_model",
    pmId: input.pmId,
    field,
  }));
  const trigger: FeishuTriggerMode = input.mentionOnlyForced ? "mention_only" : input.triggerMode;
  const forcedNote = input.mentionOnlyForced ? "\n应用没开收群消息的权限，只能 @机器人。" : "";
  const wake = [
    markdown(`**唤醒方式** · 要不要 @机器人\n当前：**${TRIGGER_LABELS[trigger]}**，${TRIGGER_DESCRIPTIONS[trigger]}${forcedNote}`),
    choiceRow(
      FEISHU_TRIGGER_MODES.filter((mode) => !(input.mentionOnlyForced && mode === "auto")).map((mode) => ({
        text: TRIGGER_LABELS[mode],
        chosen: mode === trigger,
        value: { kind: "set_policy", pmId: input.pmId, triggerMode: mode },
      })),
    ),
  ];
  const tierLines = TIER_ORDER.map((tier) => `${tier === input.guestTier ? "✓" : "·"} **${TIER_LABELS[tier]}**：${TIER_DESCRIPTIONS[tier]}`);
  const members = [
    markdown(`**群成员权限** · 访客能做什么\n当前：**${TIER_LABELS[input.guestTier]}**\n${tierLines.join("\n")}`),
    choiceRow(TIER_ORDER.map((tier) => ({ text: TIER_LABELS[tier], chosen: tier === input.guestTier, value: { kind: "set_policy", pmId: input.pmId, guestTier: tier } }))),
  ];
  const footer = { tag: "markdown", content: "只有主人能改。随时在群里发 /群设置 或 /设置 叫出这张卡。", text_size: "notation" };
  return card({ title: "群设置", template: "grey", summary: "群设置", elements: [...models, HR, ...wake, HR, ...members, HR, footer] });
}

export function renderRouterSettingsCard(input: { settings: RouterSettings; catalogs: readonly ModelCatalog[] }): FeishuCardJson {
  const models = modelSectionElements(buildRouterModelSection(input.settings, input.catalogs), (field) => ({
    kind: "set_router_model",
    field,
  }));
  const footer = { tag: "markdown", content: "只有主人能改。随时在单聊发 /设置 或 /model 叫出这张卡。", text_size: "notation" };
  return card({ title: "总助设置", template: "grey", summary: "总助设置", elements: [...models, HR, footer] });
}

export function unrenderableReplyText(code: number): string {
  return `这段回复飞书显示不了（错误码 ${code}），完整内容去网页看。`;
}

export function renderTextCard(input: { title: string; text: string; template?: string; attachments?: readonly FeishuAttachmentView[] }): FeishuCardJson {
  return card({ title: input.title, template: input.template ?? "wathet", summary: input.text, elements: [markdown(input.text), ...attachmentElements(input.attachments ?? [])] });
}

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

export type FeishuMeshApprovalCardState =
  | { kind: "pending"; approval: MeshApprovalView }
  | { kind: "approved"; deviceName: string }
  | { kind: "closed"; deviceName: string };

export function renderMeshApprovalCard(state: FeishuMeshApprovalCardState): FeishuCardJson {
  if (state.kind === "approved") {
    const text = `**已加入**：「${state.deviceName}」已加入账号。`;
    return card({ title: "新电脑请求加入", template: "green", summary: text, elements: [markdown(text)] });
  }
  if (state.kind === "closed") {
    const text = `**已结束**：「${state.deviceName}」的加入请求已取消或过期。`;
    return card({ title: "新电脑请求加入", template: "grey", summary: text, elements: [markdown(text)] });
  }
  const { requestId, device, sas } = state.approval;
  const platform = PLATFORM_LABELS[device.platform] ?? device.platform;
  if (sas === null) {
    const text = `「${device.name}」（${platform}）请求加入你的账号。`;
    return card({
      title: "新电脑请求加入",
      template: "blue",
      summary: text,
      elements: [markdown(text), button({ text: "核对", type: "primary", value: { kind: "mesh_approval", step: "begin", requestId } })],
    });
  }
  const formattedSas = `${sas.slice(0, 3)} ${sas.slice(3)}`;
  const text = `「${device.name}」（${platform}）正在核对。\n\n**核对码**：\`${formattedSas}\`\n\n确认那台屏幕上的 6 位数一致后再点“一致”。`;
  return card({
    title: "新电脑请求加入",
    template: "blue",
    summary: `核对码 ${formattedSas}`,
    elements: [
      markdown(text),
      button({ text: "一致", type: "primary", value: { kind: "mesh_approval", step: "match", requestId } }),
      button({ text: "不一致", type: "danger", value: { kind: "mesh_approval", step: "mismatch", requestId } }),
    ],
  });
}
