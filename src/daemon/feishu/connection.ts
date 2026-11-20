import type { PmId } from "../../shared/domain.ts";
import { parseFeishuAppId, parseFeishuOpenId, type FeishuChatId, type FeishuOpenId } from "../../shared/feishu.ts";
import type { FeishuPeerAppSync } from "./account-bot.ts";
import { api, handleError } from "./api.ts";
import { errorText, isCenter, type FeishuContext } from "./context.ts";
import { createFeishuFileService } from "./files.ts";
import { onRawCardAction } from "./card-actions.ts";
import { onRawEvent } from "./inbound-dispatch.ts";
import { pumpInboundCatchUp, releaseAllInboundGates } from "./inbound-catchup.ts";
import { pumpControl, requestControl, settleIdle } from "./lanes.ts";
import { activeTarget } from "./projection.ts";
import { checkFeishuScopes } from "./scopes.ts";
import { writeFeishuSecrets, type FeishuSecrets } from "./secrets.ts";
import { FeishuSetupError } from "./setup.ts";
import { dropStream } from "./stream-cards.ts";
import { feishuDataOf, type FeishuTransport } from "./transport.ts";

export function ackAllRouterEvents(ctx: FeishuContext) {
  const chat = ctx.store.chatOfTarget({ kind: "router" });
  if (chat === null) return;
  const max = ctx.db.get<{ id: number | null }>("SELECT max(id) AS id FROM feishu_router_events")?.id;
  if (max !== null && max !== undefined) ctx.store.ackRouterEvent(chat.chatId, max, ctx.now());
}

export const localPmChats = (ctx: FeishuContext): { chatId: FeishuChatId; pmId: PmId }[] =>
  ctx.store
    .chats()
    .flatMap((c) => (c.target.kind === "pm" && c.target.pmId !== null && c.archivedAt === null ? [{ chatId: c.chatId, pmId: c.target.pmId }] : []));

export function notifyLocalChats(ctx: FeishuContext) {
  const chats = localPmChats(ctx);
  ctx.app.accountBot?.learnChats(ctx.options.device.id, chats);
  ctx.options.mesh?.onChatsSynced(chats);
}

export function exportPeerApp(ctx: FeishuContext): FeishuPeerAppSync | null {
  const app = ctx.store.app();
  const secrets = ctx.link.secrets;
  if (secrets !== null && app !== null && app.enabled) {
    return {
      kind: "configured",
      brand: app.brand,
      appId: app.appId,
      appSecret: secrets.appSecret,
      botOpenId: app.botOpenId,
      botName: app.botName,
      ownerOpenId: app.ownerOpenId,
      routerChatId: ctx.store.chatOfTarget({ kind: "router" })?.chatId ?? ctx.app.syncedRouterChatId,
      updatedAt: app.updatedAt,
    };
  }
  if (ctx.app.lastDisconnectedAt !== null) {
    return { kind: "disconnected", dissolveChats: ctx.app.lastDissolveChats, updatedAt: ctx.app.lastDisconnectedAt };
  }
  return null;
}

export function broadcastPeerApp(ctx: FeishuContext) {
  const sync = exportPeerApp(ctx);
  if (sync !== null) ctx.options.mesh?.onAppChanged(sync);
}

export function forgetPreviousApp(ctx: FeishuContext) {
  ctx.directory.clear();
  ctx.contexts.clearAll();
  ctx.catchUp.seen.clear();
  ctx.catchUp.cursorHold.clear();
  ctx.catchUp.hadLiveSession = false;
  ctx.app.syncedRouterChatId = null;
}

function stopInboundSession(ctx: FeishuContext) {
  ctx.catchUp.epoch++;
  ctx.catchUp.targetEpoch = 0;
  releaseAllInboundGates(ctx);
}

function clearRetry(ctx: FeishuContext) {
  if (ctx.control.retry !== null) clearTimeout(ctx.control.retry);
  ctx.control.retry = null;
}

async function teardownTransport(ctx: FeishuContext) {
  const { link } = ctx;
  const old = link.transport;
  const wasWs = link.wsStarted;
  link.transport = null;
  link.transportKey = null;
  link.files = null;
  link.wsStarted = false;
  link.wsUp = false;
  link.downSince = null;
  link.disconnectError = null;
  link.scopesChecked = false;
  link.scopesInflight = null;
  ctx.approvalCards.clear();
  stopInboundSession(ctx);
  clearRetry(ctx);
  for (const [id, slot] of ctx.streams) dropStream(ctx, id, slot);
  if (old !== null && wasWs) await old.stop().catch((error: unknown) => ctx.log(`飞书：断开时出错：${errorText(error)}`));
}

export async function checkScopes(ctx: FeishuContext) {
  const data = await api(ctx, "application.scopes", {});
  const granted = ((data.scopes as { scope_name?: string; grant_status?: number }[] | undefined) ?? [])
    .filter((s) => s.grant_status === 1 && typeof s.scope_name === "string")
    .map((s) => s.scope_name!);
  const check = checkFeishuScopes(granted);
  ctx.link.missing = check.missing;
  ctx.link.mentionOnly = check.mentionOnly;
  ctx.link.scopesChecked = true;
}

export function ensureScopesChecked(ctx: FeishuContext): Promise<void> {
  const { link } = ctx;
  if (link.scopesChecked) return Promise.resolve();
  link.scopesInflight ??= checkScopes(ctx).finally(() => {
    link.scopesInflight = null;
  });
  return link.scopesInflight;
}

function onConnected(ctx: FeishuContext) {
  const { link, catchUp } = ctx;
  const epoch = ++catchUp.epoch;
  if (link.downSince !== null) {
    catchUp.hadLiveSession = true;
    ctx.log(`飞书：长连接已重连，断了 ${Math.round((ctx.now() - link.downSince) / 1000)} 秒`);
    if (link.disconnectError !== null && link.lastError === link.disconnectError) link.lastError = null;
  }
  link.downSince = null;
  link.disconnectError = null;
  link.wsUp = true;
  link.scopesChecked = false;
  ctx.directory.markAllStale();
  clearRetry(ctx);
  const existingActive = ctx.store.chats().filter((c) => activeTarget(ctx, c) !== null);
  if (existingActive.length > 0) {
    for (const chat of existingActive) catchUp.gateEpochs.set(chat.chatId, epoch);
    catchUp.targetEpoch = epoch;
    pumpInboundCatchUp(ctx);
  } else {
    catchUp.targetEpoch = 0;
    catchUp.hadLiveSession = true;
  }
  requestControl(ctx, "connection");
}

function onDisconnected(ctx: FeishuContext, reason: string) {
  const { link } = ctx;
  if (link.downSince === null) {
    link.downSince = ctx.now();
    ctx.log(`飞书：长连接断了：${reason}`);
  }
  link.wsUp = false;
  link.lastError = link.disconnectError = reason;
  stopInboundSession(ctx);
  ctx.contexts.clearAll();
}

async function startWs(ctx: FeishuContext, transport: FeishuTransport) {
  ctx.link.wsStarted = true;
  try {
    await transport.start({
      onEvent: (raw) => {
        if (ctx.app.accountBot !== null) ctx.app.accountBot.onEvent(raw);
        else onRawEvent(ctx, raw, null);
      },
      onCardAction: (raw) => (ctx.app.accountBot !== null ? ctx.app.accountBot.onCardAction(raw) : onRawCardAction(ctx, raw)),
      onConnected: () => onConnected(ctx),
      onDisconnected: (reason) => onDisconnected(ctx, reason),
    });
  } catch (error) {
    ctx.link.wsStarted = false;
    handleError(ctx, error);
  }
}

async function stopWs(ctx: FeishuContext, transport: FeishuTransport) {
  const { link } = ctx;
  link.wsStarted = false;
  link.wsUp = false;
  link.downSince = null;
  link.disconnectError = null;
  link.scopesChecked = false;
  ctx.approvalCards.clear();
  stopInboundSession(ctx);
  await transport.stop().catch((error: unknown) => ctx.log(`飞书：断开时出错：${errorText(error)}`));
  pumpControl(ctx);
}

async function ensureHttpTransport(ctx: FeishuContext, secrets: FeishuSecrets): Promise<boolean> {
  const key = `${secrets.brand}\n${secrets.appId}\n${secrets.appSecret}`;
  if (ctx.link.transport !== null && ctx.link.transportKey === key) return false;
  await teardownTransport(ctx);
  const log = (line: string) => ctx.log(`飞书：${line}`);
  const transport = (await ctx.transportFactory())({ brand: secrets.brand, appId: secrets.appId, appSecret: secrets.appSecret, log });
  ctx.link.transport = transport;
  ctx.link.transportKey = key;
  ctx.link.files = createFeishuFileService({ transport, uploadsDir: ctx.options.uploadsDir, log });
  return true;
}

async function doSyncTransport(ctx: FeishuContext) {
  ctx.life.connectingCount++;
  try {
    const app = ctx.store.app();
    const secrets = ctx.link.secrets;
    if (ctx.life.closed || secrets === null || app === null || !app.enabled || ctx.link.authFailed) {
      await teardownTransport(ctx);
      return;
    }
    const createdHttp = await ensureHttpTransport(ctx, secrets);
    const wantWs = isCenter(ctx);
    if (wantWs && !ctx.link.wsStarted) await startWs(ctx, ctx.link.transport!);
    else if (!wantWs && ctx.link.wsStarted) await stopWs(ctx, ctx.link.transport!);
    else if (!wantWs && createdHttp) {
      ctx.directory.markAllStale();
      requestControl(ctx, "connection");
    }
  } finally {
    ctx.life.connectingCount--;
    settleIdle(ctx);
  }
}

export function syncTransport(ctx: FeishuContext): Promise<void> {
  const run = () => doSyncTransport(ctx);
  ctx.life.transportQueue = ctx.life.transportQueue.then(run, run);
  return ctx.life.transportQueue;
}

async function verify(ctx: FeishuContext, s: FeishuSecrets): Promise<{ botOpenId: FeishuOpenId; botName: string }> {
  const t = (await ctx.transportFactory())({ brand: s.brand, appId: s.appId, appSecret: s.appSecret, log: (line) => ctx.log(`飞书：${line}`) });
  try {
    const data = feishuDataOf("bot.info", await t.call("bot.info", {}));
    const bot = (data.bot ?? {}) as { open_id?: string; app_name?: string };
    const botOpenId = parseFeishuOpenId(bot.open_id);
    if (botOpenId === null) throw new FeishuSetupError("飞书没回机器人信息：应用要先开启机器人能力");
    return { botOpenId, botName: bot.app_name ?? "" };
  } catch (error) {
    if (error instanceof FeishuSetupError) throw error;
    ctx.log(`飞书：验凭证没过：${errorText(error)}`);
    throw new FeishuSetupError("凭证不对或应用不可用：核对 App ID 和 App Secret，确认应用已开启机器人能力");
  }
}

export async function connectWith(ctx: FeishuContext, s: FeishuSecrets, ownerOpenId: FeishuOpenId | null) {
  ctx.life.connectingCount++;
  try {
    const appId = parseFeishuAppId(s.appId);
    if (appId === null) throw new FeishuSetupError("App ID 要以 cli_ 开头");
    const bot = await verify(ctx, s);
    await writeFeishuSecrets(ctx.options.secretsFile, s);
    ctx.link.secrets = s;
    ctx.app.lastDisconnectedAt = null;
    const before = ctx.store.app();
    if (before !== null && before.appId !== appId) forgetPreviousApp(ctx);
    ctx.store.saveApp({ appId, brand: s.brand, botOpenId: bot.botOpenId, botName: bot.botName, ownerOpenId }, ctx.now());
    ctx.store.setEnabled(true, ctx.now());
    ctx.link.lastError = null;
    ctx.link.authFailed = false;
    ctx.options.lease?.refresh();
    await syncTransport(ctx);
    broadcastPeerApp(ctx);
  } finally {
    ctx.life.connectingCount--;
    settleIdle(ctx);
  }
}
