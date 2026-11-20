import { randomInt } from "node:crypto";
import {
  parseFeishuOpenId,
  type FeishuBindCodeResponse,
  type FeishuChatPolicyRequest,
  type FeishuChatTarget,
  type FeishuChatView,
  type FeishuConnectionState,
  type FeishuStatusView,
} from "../../shared/feishu.ts";
import { FEISHU_BIND_CODE_TTL_MS } from "../../shared/limits.ts";
import type { FeishuPeerAppSync } from "./account-bot.ts";
import { handleError } from "./api.ts";
import { adoptRouterChat, deleteChat, ensureRouterChat, syncChats } from "./chat-sync.ts";
import { broadcastPeerApp, checkScopes, connectWith, forgetPreviousApp, syncTransport } from "./connection.ts";
import { displayOwner, errorText, isCenter, isReady, owner, type FeishuContext } from "./context.ts";
import { retrySyncLater, settleIdle } from "./lanes.ts";
import { refreshPolicyCard } from "./settings-cards.ts";
import { FEISHU_APP_ADDONS, feishuAppPreset } from "./scopes.ts";
import { removeFeishuSecrets, writeFeishuSecrets, type FeishuSecrets } from "./secrets.ts";
import type { registerFeishuApp } from "./sdk.ts";
import { FeishuSetupError, type FeishuSetupService } from "./setup.ts";
import type { FeishuChatBinding } from "./store.ts";
import { FeishuRegistrationError } from "./transport.ts";

type ConfiguredSync = Extract<FeishuPeerAppSync, { kind: "configured" }>;

function connectionState(ctx: FeishuContext): FeishuConnectionState {
  if (ctx.app.registration !== null) return "registering";
  const app = ctx.store.app();
  if (ctx.link.secrets === null || app === null) return "unconfigured";
  if (!app.enabled) return "disabled";
  if (ctx.link.authFailed) return "auth_failed";
  if (!isReady(ctx)) return "connecting";
  if (app.ownerOpenId === null) return "awaiting_owner";
  if (ctx.link.missing.length > 0) return "needs_permission";
  return "connected";
}

function chatView(ctx: FeishuContext, chat: FeishuChatBinding): FeishuChatView | null {
  if (chat.target.kind === "pm" && chat.target.pmId === null) return null;
  const o = owner(ctx);
  const guests = (ctx.directory.peekMembers(chat.chatId) ?? []).filter((m) => m.openId !== o).length;
  return {
    chatId: chat.chatId,
    target: chat.target as FeishuChatTarget,
    name: chat.name,
    mode: guests > 0 ? "shared" : "solo",
    triggerMode: chat.triggerMode,
    guestTier: chat.guestTier,
    guestCount: guests,
    archived: chat.archivedAt !== null,
  };
}

function status(ctx: FeishuContext): FeishuStatusView {
  const app = ctx.store.app();
  const registration = ctx.app.registration;
  return {
    state: connectionState(ctx),
    brand: app?.brand ?? ctx.link.secrets?.brand ?? null,
    appId: app?.appId ?? null,
    botName: app?.botName ?? null,
    ownerOpenId: app?.ownerOpenId ?? null,
    ownerName: app?.ownerOpenId ? displayOwner(ctx) : null,
    registration: registration === null ? null : { url: registration.url, expiresAt: registration.expiresAt },
    missing: [...ctx.link.missing],
    lastError: ctx.link.lastError,
    ...(ctx.options.lease !== undefined ? { hosting: isCenter(ctx) } : {}),
    chats: ctx.store.chats().flatMap((c) => (c.target.kind === "router" && !isCenter(ctx) ? [] : (chatView(ctx, c) ?? []))),
  };
}

function abortRegistration(ctx: FeishuContext) {
  ctx.app.registration?.abort.abort();
  ctx.app.registration = null;
}

async function finishRegistration(ctx: FeishuContext, abort: AbortController, result: Awaited<ReturnType<typeof registerFeishuApp>>) {
  if (abort.signal.aborted) return;
  ctx.life.connectingCount++;
  ctx.app.registration = null;
  try {
    await connectWith(ctx, { brand: result.brand, appId: result.appId, appSecret: result.appSecret }, parseFeishuOpenId(result.scannerOpenId));
  } catch (error) {
    handleError(ctx, error);
  } finally {
    ctx.life.connectingCount--;
    settleIdle(ctx);
  }
}

function failRegistration(ctx: FeishuContext, abort: AbortController, error: unknown) {
  if (abort.signal.aborted) return;
  ctx.app.registration = null;
  const code = error instanceof FeishuRegistrationError ? error.code : "error";
  ctx.log(`飞书：扫码建应用没成：${errorText(error)}`);
  ctx.link.lastError =
    code === "access_denied" ? "扫码后点了拒绝" : code === "expired_token" ? "二维码过期了，重新扫一次" : "扫码建应用没成，重新扫一次；还不行看日志";
}

async function startRegistration(ctx: FeishuContext): Promise<FeishuStatusView> {
  abortRegistration(ctx);
  const abort = new AbortController();
  let resolveUrl!: () => void;
  const urlReady = new Promise<void>((resolve) => (resolveUrl = resolve));
  const register = await ctx.registerFn();
  const done = register({
    preset: feishuAppPreset(ctx.options.device.name),
    addons: FEISHU_APP_ADDONS,
    signal: abort.signal,
    handlers: {
      onUrl: (info) => {
        if (abort.signal.aborted) return;
        ctx.app.registration = { url: info.url, expiresAt: info.expiresAt, abort };
        resolveUrl();
      },
    },
  });
  void done.then(
    (result) => finishRegistration(ctx, abort, result),
    (error: unknown) => failRegistration(ctx, abort, error),
  );
  await Promise.race([urlReady, done.then(() => undefined, () => undefined)]);
  return status(ctx);
}

function issueBindCode(ctx: FeishuContext): FeishuBindCodeResponse {
  const app = ctx.store.app();
  if (app === null) throw new FeishuSetupError("还没接飞书应用");
  if (app.ownerOpenId !== null) throw new FeishuSetupError("已经认过主人了；要换主人先断开");
  const bindCode = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: ctx.now() + FEISHU_BIND_CODE_TTL_MS };
  ctx.app.bindCode = bindCode;
  return { ...bindCode };
}

function consumeBindCode(ctx: FeishuContext, text: string, at: number): boolean {
  const bindCode = ctx.app.bindCode;
  if (bindCode === null || bindCode.expiresAt <= at || text.trim() !== bindCode.code) return false;
  ctx.app.bindCode = null;
  return true;
}

export async function setChatPolicy(ctx: FeishuContext, input: FeishuChatPolicyRequest): Promise<FeishuChatView> {
  let chat: FeishuChatBinding;
  try {
    const policy = { ...(input.triggerMode ? { triggerMode: input.triggerMode } : {}), ...(input.guestTier ? { guestTier: input.guestTier } : {}) };
    chat = ctx.store.setChatPolicy(input.pmId, policy, ctx.now());
  } catch {
    throw new FeishuSetupError("这个项目经理还没有飞书群");
  }
  await refreshPolicyCard(ctx, input.pmId);
  return chatView(ctx, chat)!;
}

async function resync(ctx: FeishuContext): Promise<FeishuStatusView> {
  if (ctx.link.transport === null || !isReady(ctx)) throw new FeishuSetupError("飞书没连上");
  ctx.directory.markAllStale();
  await checkScopes(ctx);
  await ensureRouterChat(ctx);
  if (!(await syncChats(ctx))) retrySyncLater(ctx);
  return status(ctx);
}

async function disconnectLocal(ctx: FeishuContext, dissolveChats: boolean) {
  abortRegistration(ctx);
  if (dissolveChats && ctx.link.transport !== null) {
    for (const chat of ctx.store.chats()) {
      if (chat.target.kind === "pm" && chat.archivedAt === null) {
        await deleteChat(ctx, chat.chatId).catch((error: unknown) => ctx.log(`飞书：解散群出错：${errorText(error)}`));
      }
    }
  }
  ctx.link.secrets = null;
  ctx.app.bindCode = null;
  ctx.link.lastError = null;
  ctx.link.authFailed = false;
  ctx.link.missing = [];
  ctx.link.mentionOnly = false;
  ctx.app.ownerName = null;
  ctx.app.syncedRouterChatId = null;
  ctx.catchUp.hadLiveSession = false;
  ctx.catchUp.seen.clear();
  ctx.catchUp.cursorHold.clear();
  ctx.options.lease?.refresh();
  await syncTransport(ctx);
  await removeFeishuSecrets(ctx.options.secretsFile);
  ctx.store.clear();
  ctx.directory.clear();
  ctx.contexts.clearAll();
  ctx.catalogRefresh.pms.clear();
  ctx.catalogRefresh.router = false;
}

async function disconnect(ctx: FeishuContext, dissolveChats: boolean): Promise<FeishuStatusView> {
  await disconnectLocal(ctx, dissolveChats);
  ctx.app.lastDisconnectedAt = ctx.now();
  ctx.app.lastDissolveChats = dissolveChats;
  broadcastPeerApp(ctx);
  return status(ctx);
}

export function createSetupService(ctx: FeishuContext): FeishuSetupService {
  return {
    status: () => status(ctx),
    startRegistration: () => startRegistration(ctx),
    cancelRegistration() {
      abortRegistration(ctx);
      return status(ctx);
    },
    async saveCredentials(input) {
      await connectWith(ctx, { brand: input.brand, appId: input.appId.trim(), appSecret: input.appSecret.trim() }, null);
      return status(ctx);
    },
    issueBindCode: () => issueBindCode(ctx),
    consumeBindCode: (text, at) => consumeBindCode(ctx, text, at),
    setChatPolicy: (input) => setChatPolicy(ctx, input),
    resync: () => resync(ctx),
    disconnect: (input) => disconnect(ctx, input.dissolveChats),
  };
}

function adoptSyncedRouterChat(ctx: FeishuContext, sync: ConfiguredSync) {
  if (sync.routerChatId === null || ctx.store.chatOfTarget({ kind: "router" }) !== null) return;
  ctx.app.syncedRouterChatId = sync.routerChatId;
  adoptRouterChat(ctx, sync.routerChatId);
}

function sameApp(ctx: FeishuContext, sync: ConfiguredSync): boolean {
  const cur = ctx.store.app();
  const secrets = ctx.link.secrets;
  return (
    cur !== null &&
    secrets !== null &&
    cur.enabled &&
    cur.appId === sync.appId &&
    cur.brand === sync.brand &&
    secrets.appSecret === sync.appSecret &&
    cur.botOpenId === sync.botOpenId &&
    cur.botName === sync.botName &&
    cur.ownerOpenId === sync.ownerOpenId
  );
}

async function applyPeerDisconnect(ctx: FeishuContext, sync: Extract<FeishuPeerAppSync, { kind: "disconnected" }>) {
  const cur = ctx.store.app();
  if (cur !== null && sync.updatedAt < cur.updatedAt) return;
  ctx.app.lastDisconnectedAt = Math.max(ctx.app.lastDisconnectedAt ?? 0, sync.updatedAt);
  ctx.app.lastDissolveChats = sync.dissolveChats;
  if (cur === null && ctx.link.secrets === null) return;
  await disconnectLocal(ctx, sync.dissolveChats);
  broadcastPeerApp(ctx);
}

export async function applyPeerApp(ctx: FeishuContext, sync: FeishuPeerAppSync) {
  if (sync.kind === "disconnected") return applyPeerDisconnect(ctx, sync);
  if (ctx.app.lastDisconnectedAt !== null && sync.updatedAt < ctx.app.lastDisconnectedAt) return;
  if (sameApp(ctx, sync)) {
    adoptSyncedRouterChat(ctx, sync);
    return;
  }
  const cur = ctx.store.app();
  ctx.app.lastDisconnectedAt = null;
  const nextSecrets: FeishuSecrets = { brand: sync.brand, appId: sync.appId, appSecret: sync.appSecret };
  await writeFeishuSecrets(ctx.options.secretsFile, nextSecrets);
  ctx.link.secrets = nextSecrets;
  if (cur !== null && cur.appId !== sync.appId) forgetPreviousApp(ctx);
  const stamp = Math.max(ctx.now(), sync.updatedAt);
  ctx.store.saveApp({ appId: sync.appId, brand: sync.brand, botOpenId: sync.botOpenId, botName: sync.botName, ownerOpenId: sync.ownerOpenId }, stamp);
  ctx.store.setEnabled(true, stamp);
  adoptSyncedRouterChat(ctx, sync);
  ctx.link.lastError = null;
  ctx.link.authFailed = false;
  ctx.options.lease?.refresh();
  await syncTransport(ctx);
  broadcastPeerApp(ctx);
}
