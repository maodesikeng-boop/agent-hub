import type { Attachment } from "../../shared/attachments.ts";
import { userMessageDedupeKey, type PmId } from "../../shared/domain.ts";
import { feishuDisplayName, type FeishuChatTarget, type FeishuOpenId } from "../../shared/feishu.ts";
import { ConversationNotFoundError, LedgerRequestError } from "../../shared/ledger.ts";
import { MAX_UPLOAD_BYTES } from "../../shared/limits.ts";
import { sendText } from "./api.ts";
import { applyChatGone, bindRouterChat } from "./chat-sync.ts";
import { broadcastPeerApp } from "./connection.ts";
import { displayOwner, isReady, owner, type FeishuContext } from "./context.ts";
import { noteInboundQueueDrop } from "./inbound-catchup.ts";
import { parseFeishuEvent, type FeishuInbound } from "./inbound.ts";
import { admitInbound, requestControl } from "./lanes.ts";
import { activeTarget, conversationOfPm } from "./projection.ts";
import { GUEST_NO_FILES, routeFeishuMessage, type FeishuMessageRoute } from "./routing.ts";
import { offerPolicyCard, postPolicyCard, postRouterSettingsCard, refreshCatalogsInBackground } from "./settings-cards.ts";
import type { FeishuChatBinding } from "./store.ts";
import { FEISHU_CLIENT_PREFIX } from "./text-cards.ts";
import type { FeishuRawEvent } from "./transport.ts";

type InboundMessage = Extract<FeishuInbound, { kind: "message" }>;
type DeliverRoute = Extract<FeishuMessageRoute, { kind: "deliver" }>;

interface MessageScene {
  message: InboundMessage;
  chat: FeishuChatBinding | null;
  target: FeishuChatTarget | null;
  owner: FeishuOpenId | null;
  t: number;
  queuedAt: number | null;
  recordSeen: () => void;
}

interface Delivery {
  clientId: string;
  text: string;
  attachments: Attachment[];
}

const missedFilesText = (names: readonly string[]) =>
  `没收下：${names.map((n) => `「${n}」`).join("、")}（超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB 或下载失败），压小一点重发试试。`;

export function feishuLocalStamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const formatOfflineQueuedPrefix = (queuedAt: number) => `（离线期间 ${feishuLocalStamp(queuedAt)} 发的）`;

export function onRawEvent(ctx: FeishuContext, raw: FeishuRawEvent, queuedAt: number | null) {
  const app = ctx.store.app();
  if (app === null) return;
  const event = parseFeishuEvent(raw, app.botOpenId);
  if (event === null || ctx.life.closed) return;
  if (event.kind === "chat_gone") {
    applyChatGone(ctx, event.chatId);
    return;
  }
  const limit = event.kind === "message" ? ctx.inbound.limit : Math.floor(ctx.inbound.limit / 2);
  if (admitInbound(ctx, event.chatId, () => handleInbound(ctx, event, queuedAt), limit)) return;
  if (isReady(ctx) && !ctx.life.closed && event.kind === "message") {
    if (event.at > 0) noteInboundQueueDrop(ctx, event.chatId, event.at);
    ctx.log(`飞书：实时入站队列已满 chatId=${event.chatId} dropped=1 limit=${limit} firstDroppedId=${event.messageId}`);
  }
  ctx.directory.markAllStale();
  ctx.link.lastError = "飞书入站队列已满，请重发未收到回复的消息";
}

export async function handleInbound(ctx: FeishuContext, event: Exclude<FeishuInbound, { kind: "chat_gone" }>, queuedAt: number | null) {
  const o = owner(ctx);
  switch (event.kind) {
    case "members_added": {
      ctx.directory.applyJoined(event.chatId, event.openIds.map((openId) => ({ openId, name: "" })), ctx.now());
      const chat = ctx.store.chatById(event.chatId);
      const target = activeTarget(ctx, chat);
      const firstGuest =
        target?.kind === "pm" && o !== null && event.openIds.some((id) => id !== o) && ctx.store.postOf({ kind: "chat_policy", pmId: target.pmId }) === null;
      if (chat !== null && firstGuest) await postPolicyCard(ctx, chat, `fusa-p-${chat.chatId}`);
      return;
    }
    case "members_removed":
      ctx.directory.applyLeft(event.chatId, event.openIds, ctx.now());
      return;
    case "chat_renamed":
      if (ctx.store.chatById(event.chatId) !== null) ctx.store.renameChat(event.chatId, event.name, null, ctx.now());
      return;
    case "message":
      return handleMessage(ctx, event, queuedAt);
  }
}

function recordSeen(ctx: FeishuContext, message: InboundMessage) {
  const { catchUp } = ctx;
  catchUp.seen.set(message.messageId, true);
  const holdAt = catchUp.cursorHold.get(message.chatId);
  if (message.at > 0 && !catchUp.gateEpochs.has(message.chatId) && (holdAt === undefined || message.at < holdAt) && ctx.store.chatById(message.chatId) !== null) {
    ctx.store.saveInboundCursor(message.chatId, { lastInboundAt: message.at, lastMessageId: message.messageId }, ctx.now());
  }
}

const isBindCode = (ctx: FeishuContext, text: string) => {
  const code = ctx.app.bindCode;
  return code !== null && code.expiresAt > ctx.now() && text.trim() === code.code;
};

async function handleMessage(ctx: FeishuContext, message: InboundMessage, queuedAt: number | null) {
  if (ctx.catchUp.seen.has(message.messageId)) return;
  const o = owner(ctx);
  const t = ctx.now();
  if (message.chatType === "p2p" && o !== null && message.senderOpenId === o && ctx.store.chatOfTarget({ kind: "router" }) === null) {
    bindRouterChat(ctx, message.chatId, t);
  }
  const chat = ctx.store.chatById(message.chatId);
  const target = activeTarget(ctx, chat);
  const scene: MessageScene = { message, chat, target, owner: o, t, queuedAt, recordSeen: () => recordSeen(ctx, message) };
  const group = message.chatType === "group" && target?.kind === "pm";
  const mode = group && o !== null ? await ctx.directory.modeOf(message.chatId, o, message.senderOpenId, t) : "solo";
  if (message.chatType === "p2p" && message.senderOpenId === o && target?.kind !== "router") {
    scene.recordSeen();
    return;
  }
  const speakerName = group ? await ctx.directory.nameOf(message.chatId, message.senderOpenId, "", t) : message.senderOpenId === o ? displayOwner(ctx) : "";
  const route = routeFeishuMessage(message, {
    ownerOpenId: o,
    binding: group ? { target, archived: false } : null,
    mode,
    triggerMode: chat?.triggerMode ?? "auto",
    guestTier: chat?.guestTier ?? "chat_only",
    mentionOnlyForced: ctx.link.mentionOnly,
    speakerName: feishuDisplayName(speakerName),
    pendingContext: ctx.contexts.peek(message.chatId, t),
    pendingFiles: ctx.contexts.peekFiles(message.chatId, t),
    isBindCode: (text) => isBindCode(ctx, text),
  });
  await applyMessageRoute(ctx, scene, route);
}

async function bindOwner(ctx: FeishuContext, message: InboundMessage, openId: FeishuOpenId, t: number) {
  ctx.app.bindCode = null;
  ctx.store.bindOwner(openId, t);
  bindRouterChat(ctx, message.chatId, t, { lastInboundAt: message.at > 0 ? message.at : t, lastMessageId: message.messageId });
  ctx.catchUp.seen.set(message.messageId, true);
  await sendText(ctx, { chatId: message.chatId }, "认好了：你是这个机器人的主人。在这里和总助说话；每个项目经理会有自己的项目群。");
  broadcastPeerApp(ctx);
  requestControl(ctx, "sync");
}

async function applyMessageRoute(ctx: FeishuContext, scene: MessageScene, route: FeishuMessageRoute) {
  const { message, chat, target } = scene;
  switch (route.kind) {
    case "ignore":
      scene.recordSeen();
      return;
    case "bind_owner":
      return bindOwner(ctx, message, route.openId, scene.t);
    case "reject":
      await sendText(ctx, { chatId: message.chatId }, message.chatType === "p2p" ? route.reason : `<at user_id="${route.openId}"></at> ${route.reason}`);
      if (route.reason === GUEST_NO_FILES) ctx.contexts.dropFiles(message.chatId, (file) => file.speaker === route.openId);
      if (route.guestDenied === true) await offerPolicyCard(ctx, message.chatId);
      scene.recordSeen();
      return;
    case "settings_card":
      if (chat !== null && target !== null) {
        if (target.kind === "pm") await postPolicyCard(ctx, chat);
        else await postRouterSettingsCard(ctx, chat);
        refreshCatalogsInBackground(ctx, target);
      }
      scene.recordSeen();
      return;
    case "context":
      ctx.contexts.add(message.chatId, route.line, message.files.map((file) => ({ messageId: message.messageId, speaker: message.senderOpenId, file, at: message.at })));
      scene.recordSeen();
      return;
    case "deliver":
      return deliver(ctx, scene, route);
  }
}

function alreadyDelivered(ctx: FeishuContext, route: DeliverRoute, clientId: string): boolean {
  if (route.target.kind === "router") return ctx.db.get("SELECT 1 FROM router_commands WHERE client_id = ?", clientId) !== undefined;
  const conversationId = conversationOfPm(ctx, route.target.pmId);
  return conversationId !== null && ctx.db.get("SELECT 1 FROM messages WHERE dedupe_key = ?", userMessageDedupeKey(conversationId, clientId)) !== undefined;
}

async function receiveFiles(ctx: FeishuContext, scene: MessageScene, route: DeliverRoute): Promise<Attachment[]> {
  const { message } = scene;
  const attachments: Attachment[] = [];
  const missed: string[] = [];
  for (const { messageId, file } of route.files) {
    const saved = await ctx.link.files?.receive(messageId, file);
    if (saved) attachments.push(saved);
    else missed.push(file.fileName ?? (file.type === "image" ? "图片" : "文件"));
  }
  const handled = new Set(route.files.map(({ messageId }) => messageId));
  ctx.contexts.dropFiles(message.chatId, (file) => handled.has(file.messageId) || (route.droppedFiles > 0 && file.speaker === message.senderOpenId));
  const at = message.chatType === "group" && message.senderOpenId !== scene.owner ? `<at user_id="${message.senderOpenId}"></at> ` : "";
  if (missed.length > 0) await sendText(ctx, { chatId: message.chatId }, `${at}${missedFilesText(missed)}`);
  if (route.droppedFiles > 0) {
    await sendText(ctx, { chatId: message.chatId }, `${at}${GUEST_NO_FILES}`);
    await offerPolicyCard(ctx, message.chatId);
  }
  return attachments;
}

function deliveredText(text: string, queuedAt: number | null): string {
  if (queuedAt === null) return text;
  return text === "" ? formatOfflineQueuedPrefix(queuedAt) : `${formatOfflineQueuedPrefix(queuedAt)}\n${text}`;
}

async function deliverToRouter(ctx: FeishuContext, scene: MessageScene, { clientId, text, attachments }: Delivery) {
  const chatId = scene.message.chatId;
  if (ctx.options.router === null) {
    await sendText(ctx, { chatId }, "总助没开：去网页的总助工作台选一家 agent。");
    scene.recordSeen();
    return;
  }
  try {
    await ctx.options.router.submitCommand({ clientId, text, ...(attachments.length > 0 ? { attachmentIds: attachments.map((a) => a.id) } : {}) });
    scene.recordSeen();
  } catch (error) {
    if (!(error instanceof LedgerRequestError)) throw error;
    await sendText(ctx, { chatId }, `没送到：${error.message}`);
    scene.recordSeen();
  }
}

async function deliverToPm(ctx: FeishuContext, scene: MessageScene, pmId: PmId, origin: DeliverRoute["origin"], { clientId, text, attachments }: Delivery) {
  const chatId = scene.message.chatId;
  const conversationId = activeTarget(ctx, ctx.store.chatById(chatId))?.kind === "pm" ? conversationOfPm(ctx, pmId) : null;
  if (conversationId === null) {
    scene.recordSeen();
    return;
  }
  try {
    ctx.ledger.postUserMessage({ conversationId, clientId, text, ...(attachments.length > 0 ? { attachments } : {}), origin });
    ctx.contexts.clear(chatId);
    scene.recordSeen();
  } catch (error) {
    if (!(error instanceof LedgerRequestError) && !(error instanceof ConversationNotFoundError)) throw error;
    await sendText(ctx, { chatId }, `没送到：${error.message}`);
    scene.recordSeen();
  }
}

async function deliver(ctx: FeishuContext, scene: MessageScene, route: DeliverRoute) {
  const clientId = `${FEISHU_CLIENT_PREFIX}${scene.message.messageId}`;
  if (alreadyDelivered(ctx, route, clientId)) {
    scene.recordSeen();
    return;
  }
  const attachments = await receiveFiles(ctx, scene, route);
  if (route.text === "" && attachments.length === 0) {
    scene.recordSeen();
    return;
  }
  const delivery = { clientId, text: deliveredText(route.text, scene.queuedAt), attachments };
  if (route.target.kind === "router") return deliverToRouter(ctx, scene, delivery);
  return deliverToPm(ctx, scene, route.target.pmId, route.origin, delivery);
}
