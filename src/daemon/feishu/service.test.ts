// 用假的传输层（FeishuTransport）和真的账本跑，不连飞书。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askOf, type ConversationId, type Message, type PmId, type SessionId, type WorkerId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { FeishuCardId, FeishuChatId, FeishuMessageId } from "../../shared/feishu.ts";
import { lookKey, resolvePmLook, type SlimeLook } from "../../shared/slimes.ts";
import {
  FEISHU_CARD_MAX_CHARS,
  FEISHU_CARDKIT_BUDGET_PER_SECOND,
  FEISHU_CATCHUP_MAX_MESSAGES,
  FEISHU_CHAT_SENDS_PER_SECOND,
  FEISHU_CONTROL_RETRY_MS,
  FEISHU_INBOUND_CATCHUP_CONCURRENCY,
  FEISHU_INBOUND_CATCHUP_MAX_MESSAGES,
  FEISHU_INBOUND_CATCHUP_MAX_PAGES,
  FEISHU_INBOUND_CATCHUP_WINDOW_MS,
  FEISHU_INBOUND_QUEUE_MAX,
  FEISHU_OUTBOUND_QUEUE_MAX,
  FEISHU_POLICY_CARD_COOLDOWN_MS,
  FEISHU_STREAM_RENEW_MS,
  FEISHU_STREAM_FLUSH_MS,
  MAX_UPLOAD_BYTES,
} from "../../shared/limits.ts";
import type { RouterCommandRecord } from "../../shared/router.ts";
import { bundledModelCatalog } from "../../shared/vendors.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { createResolveFolder } from "../ledger/files.ts";
import { createLedger, type SqliteLedger } from "../ledger/index.ts";
import { openDatabase } from "../store/db.ts";
import type { Db } from "../store/index.ts";
import { createSessionStore } from "../store/index.ts";
import { migrate } from "../store/migrate.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { decodeFeishuActionValue } from "./cards.ts";
import { feishuChatMarker } from "./chats.ts";
import { FEISHU_GROUP_MSG_SCOPE, FEISHU_REQUIRED_SCOPES } from "./scopes.ts";
import { renderFeishuAvatar } from "./avatars.ts";
import { createFeishuService, type FeishuService } from "./service.ts";
import { FeishuSetupError } from "./setup.ts";
import { createFeishuStore } from "./store.ts";
import { createFakeFeishu, type FakeFeishu } from "./test-helpers.ts";
import type { FeishuApiResult, FeishuMethod, FeishuRawEvent } from "./transport.ts";

const OWNER = "ou_owner";
const GUEST = "ou_guest";
const DEVICE = { id: "11111111-2222-3333-4444-555555555555", name: "测试机" };

let root: string;
let dataHome: string;
let db: Db;
let ledger: SqliteLedger;
let fake: FakeFeishu;
let svc: FeishuService;
let routerCalls: { clientId: string; text: string }[];
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
let zhou: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
let seq = 0;

function makeService(overrides: Partial<Parameters<typeof createFeishuService>[0]> = {}) {
  return createFeishuService({
    db,
    ledger,
    router: {
      submitCommand: async (input) => {
        routerCalls.push({ clientId: input.clientId, text: input.text });
        const { command } = ledger.createRouterCommand({ clientId: input.clientId, inputText: input.text, vendor: "claude", status: "planning" });
        return ledger.updateRouterCommand(command.id, { status: "answered", plan: { intent: "answer", reply: `总助回：${input.text}`, actions: [] } }) as RouterCommandRecord;
      },
    },
    secretsFile: join(dataHome, "state", "feishu-secrets.json"),
    uploadsDir: join(dataHome, "uploads"),
    sentFilesDir: join(dataHome, "sent-files"),
    device: DEVICE,
    log: () => {},
    createTransport: () => fake,
    register: async ({ handlers }) => {
      handlers.onUrl({ url: "https://open.feishu.cn/qr/xyz", expiresAt: Date.now() + 600_000 });
      return { brand: "feishu", appId: "cli_test", appSecret: "super-secret-value", scannerOpenId: OWNER };
    },
    ...overrides,
  });
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "feishu-svc-")));
  dataHome = join(root, ".agent-hub");
  mkdirSync(join(dataHome, "state"), { recursive: true });
  db = openDatabase(join(root, "hub.sqlite"));
  migrate(db);
  ledger = createLedger(db, {
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    userHome: root,
    osSandboxed: () => true,
    worktreesDir: join(dataHome, "worktrees"),
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
  });
  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
  const b = ledger.createPm({ name: "阿周", mode: "manage_only", persona: "" });
  lin = { pmId: a.pm.id, conversationId: a.conversation.id, sessionId: a.sessionId };
  zhou = { pmId: b.pm.id, conversationId: b.conversation.id, sessionId: b.sessionId };
  fake = createFakeFeishu();
  fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
  routerCalls = [];
  svc = makeService();
});

afterEach(async () => {
  await svc.close();
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const store = () => createFeishuStore(db);
/** 项目经理现在的形象（账本建项目经理时分的，和网页头像同一只）。 */
const lookOf = (pmId: number): SlimeLook => resolvePmLook(ledger.snapshot().pms.find((p) => p.id === pmId)!);
const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await svc.idle();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await svc.idle();
};
async function connect(service = svc) {
  await service.start();
  await service.setup.startRegistration();
  await vi.waitFor(() => expect(service.setup.status().state).toBe("connected"));
  await settle();
}
const chatOf = (pmId: PmId): FeishuChatId => store().chatOfTarget({ kind: "pm", pmId })!.chatId;
const routerChat = (): FeishuChatId => store().chatOfTarget({ kind: "router" })!.chatId;
const say = (chatId: string, text: string, opts: { sender?: string; mention?: boolean; p2p?: boolean; files?: { type: "image" | "file" | "audio" | "video" | "sticker"; fileKey: string; fileName: string | null }[] } = {}) => {
  const messageId = `om_in${++seq}`;
  fake.event({
    type: "im.message.receive_v1",
    messageId,
    chatId,
    chatType: opts.p2p ? "p2p" : "group",
    senderOpenId: opts.sender ?? OWNER,
    senderType: "user",
    content: text,
    mentionedBot: opts.mention ?? false,
    threadId: null,
    resources: opts.files ?? [],
    createTime: Date.now(),
  });
  return messageId;
};
const join_ = (chatId: string, openId = GUEST, name = "李四") => {
  fake.chats.get(chatId)!.members.push({ member_id: openId, name });
  fake.event({ type: "im.chat.member.user.added_v1", chatId, openIds: [openId] });
};
const leave = (chatId: string, openId = GUEST) => {
  const chat = fake.chats.get(chatId)!;
  chat.members = chat.members.filter((m) => m.member_id !== openId);
  fake.event({ type: "im.chat.member.user.deleted_v1", chatId, openIds: [openId] });
};
const userMessages = (conversationId: ConversationId): Message[] =>
  db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? AND sender = 'user' ORDER BY id", conversationId).map((r) => ledger.getMessage(r.id)!);
const ev = (sessionId: SessionId, event: DriverEvent) => ledger.applyDriverEvent(sessionId, event);
const running = (sessionId: SessionId) => createSessionStore(db).update(sessionId, { status: "running" });
const cardsSentTo = (chatId: string) =>
  fake.calls.filter((c) => c.method === "message.create" && c.args.receive_id === chatId).map((c) => JSON.parse(String(c.args.content)) as Record<string, unknown>);
const cardJsonOf = (data: string) => JSON.parse(data) as { body: { elements: Record<string, unknown>[] }; config: Record<string, unknown> };
const buttonValues = (cardData: string) => {
  const out: unknown[] = [];
  const visit = (els: Record<string, unknown>[]) => {
    for (const el of els) {
      if (el.tag === "button") out.push(decodeFeishuActionValue((el.behaviors as { type: string; value?: unknown }[]).find((b) => b.type === "callback")?.value));
      if (Array.isArray(el.elements)) visit(el.elements as Record<string, unknown>[]);
      if (Array.isArray(el.columns)) visit(el.columns as Record<string, unknown>[]);
    }
  };
  visit(cardJsonOf(cardData).body.elements);
  return out.filter((v) => v !== null);
};
/** 卡片里嵌的图片（img 元素）的图片编号。 */
const imgKeysOf = (cardData: string) => {
  const out: string[] = [];
  const visit = (els: Record<string, unknown>[]) => {
    for (const el of els) {
      if (el.tag === "img" && typeof el.img_key === "string") out.push(el.img_key);
      if (Array.isArray(el.elements)) visit(el.elements as Record<string, unknown>[]);
    }
  };
  visit(cardJsonOf(cardData).body.elements);
  return out;
};
const cardIdsCreated = () =>
  fake.calls.filter((c) => c.method === "card.create").map((c, i) => ({ data: String(c.args.data), index: i }));
/** 群里最近一张建出来时在流式的卡（带停止按钮的回复卡）的消息。 */
const streamCardMessage = (chatId: string) =>
  fake.sent.findLast((entry) => {
    const cardId = (JSON.parse(entry.content) as { data?: { card_id?: string } }).data?.card_id;
    const data = cardId === undefined ? undefined : fake.cards.get(cardId);
    return entry.chatId === chatId && data !== undefined && cardJsonOf(data).config.streaming_mode === true;
  });
const click = (chatId: string, feishuMessageId: string, value: unknown, operator = OWNER, note: string | null = null) =>
  fake.click({ messageId: feishuMessageId, chatId, operatorOpenId: operator, value, formValue: note === null ? null : { note } });
const chooseOption = (chatId: string, feishuMessageId: string, value: unknown, option: string, operator = OWNER) =>
  fake.click({ messageId: feishuMessageId, chatId, operatorOpenId: operator, value, option, formValue: null });
async function askInGroupFor(who: typeof lin, options = ["要", "不要"]) {
  const askId = ledger.hubCall(who.sessionId, "ask", { text: "要不要上线？", options }).data.messageId;
  await settle();
  return askId;
}
const postOfAsk = (askMessageId: number) => store().postOf({ kind: "message", messageId: askMessageId, part: 0 })!;
const postOfRouterItem = (itemId: number) => store().postOf({ kind: "router_item", itemId })!;
const itemOfAsk = (askMessageId: number) => db.get<{ id: number; status: string }>("SELECT id, status FROM router_items WHERE ask_message_id = ?", askMessageId)!;

describe("createFeishuService：接入与建群", () => {
  it("扫码接入后给每个未归档项目经理建私有对话群：群名是项目经理名字、头像是它的水果、主人是群主、群说明带标记", async () => {
    ledger.archivePm(zhou.pmId);
    await connect();
    const creates = fake.callsOf("chat.create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      name: "小林",
      owner_id: OWNER,
      user_id_list: [OWNER],
      chat_type: "private",
      group_message_type: "chat",
      set_bot_manager: true,
      edit_permission: "only_owner",
    });
    expect(creates[0]!.description).toContain(feishuChatMarker(DEVICE.id, lin.pmId));
    const avatarUploads = fake.calls.filter((c) => c.method === "uploadImage");
    expect(avatarUploads).toHaveLength(1);
    const linImage = await renderFeishuAvatar(lookOf(lin.pmId));
    expect(avatarUploads[0]!.args).toMatchObject({ imageType: "avatar", data: linImage.png });
    expect(creates[0]!.avatar).toBe(store().avatarKey(lookOf(lin.pmId), linImage.sha256));
    expect(store().chatOfTarget({ kind: "router" })).not.toBeNull();
  });

  it("已建的群：头像图片换了（记下的哈希和现在的图不同）重传一次、原地换群头像，不重建群、不动群名", async () => {
    await connect();
    const chatId = chatOf(lin.pmId);
    const look = lookOf(lin.pmId);
    const hash = (await renderFeishuAvatar(look)).sha256;
    expect(store().chatById(chatId)?.avatarLook).toEqual(look);
    // 模拟升级前：群上挂的是旧图（上传记录是另一张图的哈希），用户还在飞书里改过群名
    db.run("UPDATE feishu_chats SET name = '用户改的群名' WHERE chat_id = ?", chatId);
    db.run("UPDATE feishu_avatars SET content_sha256 = 'old-image', image_key = 'img_old' WHERE look = ?", lookKey(look));
    const before = { creates: fake.callsOf("chat.create").length, uploads: fake.calls.filter((c) => c.method === "uploadImage").length, updates: fake.callsOf("chat.update").length };
    await svc.setup.resync();
    await settle();
    const updates = fake.callsOf("chat.update").slice(before.updates);
    expect(updates).toEqual([{ chat_id: chatId, avatar: store().avatarKey(look, hash) }]);
    expect(updates[0]!.avatar).not.toBe("img_old");
    expect(fake.calls.filter((c) => c.method === "uploadImage")).toHaveLength(before.uploads + 1);
    expect(fake.callsOf("chat.create")).toHaveLength(before.creates);
    expect(store().chatById(chatId)).toMatchObject({ avatarLook: look, name: "用户改的群名" });
    await svc.setup.resync();
    await settle();
    expect(fake.callsOf("chat.update")).toHaveLength(before.updates + 1);
  });

  /** 模拟升级：两个群上挂的都是旧图，重启后第一次对齐要原地换两个群的头像。 */
  async function restartWithStaleAvatars(before: () => void) {
    await connect();
    await svc.close();
    db.run("DELETE FROM feishu_avatars");
    before();
    svc = makeService();
    await svc.start();
    await vi.waitFor(() => expect(svc.setup.status().state).toBe("connected"));
    await settle();
  }

  it("换头像时前面的群在离线期间被解散（232011）：记成已解散并重建，后面的群照常换头像，别的群出站不断", async () => {
    let linChat = "" as FeishuChatId;
    let zhouChat = "" as FeishuChatId;
    await restartWithStaleAvatars(() => {
      linChat = chatOf(lin.pmId);
      zhouChat = chatOf(zhou.pmId);
      fake.chats.delete(linChat);
    });
    expect(fake.callsOf("chat.update").filter((c) => c.chat_id === linChat)).toHaveLength(1);
    expect(store().chatById(linChat)?.archivedAt).not.toBeNull();
    const rebuilt = chatOf(lin.pmId);
    expect(rebuilt).not.toBe(linChat);
    expect(fake.chats.has(rebuilt)).toBe(true);
    expect(store().chatById(zhouChat)?.avatarLook).toEqual(lookOf(zhou.pmId));
    const sentBefore = cardsSentTo(zhouChat).length;
    ledger.postUserMessage({ conversationId: zhou.conversationId, clientId: "web-after-gone", text: "正常群还能收到消息吗" });
    await settle();
    expect(cardsSentTo(zhouChat).length).toBeGreaterThan(sentBefore);
  });

  it("换头像被飞书拒收（如没有改群信息的权限）：记日志、当作换过，不反复撞；后面的群照常换", async () => {
    let linChat = "" as FeishuChatId;
    let zhouChat = "" as FeishuChatId;
    await restartWithStaleAvatars(() => {
      linChat = chatOf(lin.pmId);
      zhouChat = chatOf(zhou.pmId);
      fake.failNext["chat.update"] = { code: 232018, msg: "no permission to update chat", httpStatus: 400 };
    });
    const updates = fake.callsOf("chat.update");
    expect(updates.map((c) => c.chat_id)).toEqual([linChat, zhouChat]);
    expect(store().chatById(linChat)?.avatarLook).toEqual(lookOf(lin.pmId));
    expect(store().chatById(zhouChat)?.avatarLook).toEqual(lookOf(zhou.pmId));
    expect(svc.setup.status().lastError).toContain("232018");
    await svc.setup.resync();
    await settle();
    expect(fake.callsOf("chat.update")).toHaveLength(updates.length);
  });

  it("换头像碰上单群暂时性错误：其余群照常换、出站不断，失败的群隔一会儿重试补上", async () => {
    let linChat = "" as FeishuChatId;
    let zhouChat = "" as FeishuChatId;
    await restartWithStaleAvatars(() => {
      linChat = chatOf(lin.pmId);
      zhouChat = chatOf(zhou.pmId);
      fake.failNext["chat.update"] = new Error("socket hang up");
    });
    expect(store().chatById(zhouChat)?.avatarLook).toEqual(lookOf(zhou.pmId));
    const sentBefore = cardsSentTo(zhouChat).length;
    ledger.postUserMessage({ conversationId: zhou.conversationId, clientId: "web-after-flaky", text: "正常群还能收到消息吗" });
    await settle();
    expect(cardsSentTo(zhouChat).length).toBeGreaterThan(sentBefore);
    await vi.waitFor(() => expect(store().chatById(linChat)?.avatarLook).toEqual(lookOf(lin.pmId)), { timeout: FEISHU_CONTROL_RETRY_MS * 3 });
    expect(fake.callsOf("chat.update").filter((c) => c.chat_id === linChat)).toHaveLength(2);
  });

  it("建群请求带同一个 uuid；崩在建好还没记下之间，重启后按群说明的标记认回来，不多建", async () => {
    await connect();
    const first = fake.callsOf("chat.create");
    expect(first).toHaveLength(2);
    const uuidLin = first.find((c) => c.name === "小林")!.uuid;
    // 模拟“建好了还没记下”：删掉记录再重启
    db.run("DELETE FROM feishu_chats WHERE target = 'pm'");
    await svc.close();
    svc = makeService();
    await svc.start();
    await vi.waitFor(() => expect(svc.setup.status().state).toBe("connected"));
    await settle();
    expect(fake.callsOf("chat.create")).toHaveLength(2);
    expect(fake.chats.size).toBe(2);
    expect(store().chats().filter((c) => c.target.kind === "pm")).toHaveLength(2);
    expect(uuidLin.length).toBeLessThanOrEqual(50);
    const adopted = chatOf(lin.pmId);
    expect(store().chatById(adopted)?.lastMessageId).toBe(0);
    fake.handlers!.onDisconnected("暂时离线");
    ev(lin.sessionId, { type: "agent.text", uuid: "adopted-offline", text: "认回空群后补发", at: Date.now() });
    fake.handlers!.onConnected();
    await settle();
    expect(fake.sent.find((entry) => entry.chatId === adopted && entry.content.includes("认回空群后补发"))).toBeDefined();
  });

  it("新建项目经理建群、改名改群名；重复收到同一变化不多建群", async () => {
    await connect();
    const created = ledger.createPm({ name: "新来的", mode: "manage_only", persona: "" });
    await settle();
    expect(fake.callsOf("chat.create").map((c) => c.name)).toContain("新来的");
    db.run("UPDATE pms SET name = '改了名' WHERE id = ?", created.pm.id);
    await svc.setup.resync();
    await settle();
    expect(fake.callsOf("chat.update").some((c) => c.chat_id === chatOf(created.pm.id) && c.name === "改了名")).toBe(true);
    await svc.setup.resync();
    await svc.setup.resync();
    expect(fake.callsOf("chat.create")).toHaveLength(3);
  });

  it("项目经理归档时解散群；取消归档时新建一个群，唤醒方式和访客档位沿用归档前的；删掉时解散群、删记录", async () => {
    await connect();
    const before = chatOf(lin.pmId);
    await svc.setup.setChatPolicy({ pmId: lin.pmId, triggerMode: "mention_only", guestTier: "observer" });
    ledger.archivePm(lin.pmId);
    await settle();
    expect(fake.callsOf("chat.delete")).toEqual([{ chat_id: before }]);
    expect(store().chatOfTarget({ kind: "pm", pmId: lin.pmId })!.archivedAt).not.toBeNull();
    ledger.unarchivePm(lin.pmId);
    await settle();
    const after = store().chatOfTarget({ kind: "pm", pmId: lin.pmId })!;
    expect(after.chatId).not.toBe(before);
    expect(after).toMatchObject({ archivedAt: null, triggerMode: "mention_only", guestTier: "observer" });
    const uuids = fake.callsOf("chat.create").filter((c) => c.name === "小林").map((c) => c.uuid);
    expect(new Set(uuids).size).toBe(2);
    ledger.archivePm(zhou.pmId);
    await settle();
    ledger.purgeExpiredArchivedPms(Date.now() + 8 * 24 * 60 * 60 * 1000);
    await settle();
    expect(store().chatOfTarget({ kind: "pm", pmId: zhou.pmId })).toBeNull();
    expect(store().chats().some((c) => c.target.kind === "pm" && c.target.pmId === null)).toBe(false);
  });

  it("群被别人解散或机器人被移出后，下一次对齐重建群", async () => {
    await connect();
    const gone = chatOf(lin.pmId);
    fake.chats.delete(gone);
    fake.event({ type: "im.chat.disbanded_v1", chatId: gone });
    await settle();
    const rebuilt = chatOf(lin.pmId);
    expect(rebuilt).not.toBe(gone);
    fake.chats.delete(rebuilt);
    fake.event({ type: "im.chat.member.bot.deleted_v1", chatId: rebuilt });
    await settle();
    expect(chatOf(lin.pmId)).not.toBe(rebuilt);
    const uuids = fake.callsOf("chat.create").filter((c) => c.name === "小林").map((c) => c.uuid);
    expect(new Set(uuids).size).toBe(3);
  });

  it("没配过凭证时 start 不连飞书，网页和 agent 照常", async () => {
    await svc.start();
    expect(svc.setup.status().state).toBe("unconfigured");
    expect(fake.calls).toEqual([]);
    expect(fake.handlers).toBeNull();
    const posted = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "web-1", text: "网页照常" });
    expect(ledger.getMessage(posted.messageId)?.text).toBe("网页照常");
  });

  it("凭证失效时状态变 auth_failed，不重试，不往账本抛错", async () => {
    await connect();
    fake.failNext["chat.create"] = new (await import("./transport.ts")).FeishuAuthError(99991663, "token invalid");
    expect(() => ledger.createPm({ name: "又一个", mode: "manage_only", persona: "" })).not.toThrow();
    await settle();
    expect(svc.setup.status().state).toBe("auth_failed");
    expect(svc.setup.status().lastError).toContain("凭证失效");
    const callsAfterFailure = fake.calls.length;
    expect(fake.calls.at(-1)?.method).toBe("chat.create");
    ledger.createPm({ name: "再一个", mode: "manage_only", persona: "" });
    ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "web-after-auth", text: "网页照常" });
    await settle();
    expect(fake.calls.length).toBe(callsAfterFailure);
  });
});

describe("createFeishuService：唤醒规则", () => {
  it("群里只有主人时，主人不 @机器人 说的话进账本，发给 agent 时没有署名", async () => {
    await connect();
    say(chatOf(lin.pmId), "看看登录页");
    await settle();
    const [m] = userMessages(lin.conversationId);
    expect(m?.text).toBe("看看登录页");
    expect(ledger.deliveryOf(m!).prefixes.join("\n")).not.toContain("【飞书");
  });

  it("拉进访客后，没 @机器人 的话不进账本，记成背景；@机器人 的那句进账本，带署名和之前的背景，背景随后清空", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    join_(chat);
    await settle();
    say(chat, "先看注册页", { sender: GUEST });
    say(chat, "好，顺便看登录");
    await settle();
    expect(userMessages(lin.conversationId)).toHaveLength(0);
    say(chat, "开始吧", { mention: true });
    await settle();
    const [m] = userMessages(lin.conversationId);
    const prefixes = ledger.deliveryOf(m!).prefixes.join("\n");
    expect(prefixes).toMatch(/^【飞书 · .+（主人）】/);
    expect(prefixes).toContain("群里之前的讨论");
    expect(prefixes).toContain("李四（访客）：先看注册页");
    say(chat, "再看下首页", { mention: true });
    await settle();
    const second = userMessages(lin.conversationId)[1]!;
    expect(ledger.deliveryOf(second).prefixes.join("\n")).not.toContain("群里之前的讨论");
  });

  it("访客离开后自动回到单人直聊", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    join_(chat);
    await settle();
    say(chat, "没 @ 的话");
    await settle();
    expect(userMessages(lin.conversationId)).toHaveLength(0);
    leave(chat);
    await settle();
    say(chat, "又只剩我了");
    await settle();
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["又只剩我了"]);
  });

  it("群设成 mention_only 后，只有主人一人时也要 @机器人", async () => {
    await connect();
    await svc.setup.setChatPolicy({ pmId: lin.pmId, triggerMode: "mention_only" });
    say(chatOf(lin.pmId), "不 @");
    await settle();
    expect(userMessages(lin.conversationId)).toHaveLength(0);
    say(chatOf(lin.pmId), "@ 了", { mention: true });
    await settle();
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["@ 了"]);
  });

  it("应用没开 im:message.group_msg 时所有群按 mention_only，群设置卡不给切回 auto", async () => {
    fake.granted = [...FEISHU_REQUIRED_SCOPES];
    await connect();
    say(chatOf(lin.pmId), "不 @");
    await settle();
    expect(userMessages(lin.conversationId)).toHaveLength(0);
    join_(chatOf(lin.pmId));
    await settle();
    const policy = cardIdsCreated().find((c) => c.data.includes("群设置"))!;
    const values = buttonValues(policy.data);
    expect(values).not.toContainEqual({ kind: "set_policy", pmId: lin.pmId, triggerMode: "auto" });
  });

  it("同一条飞书消息重推只进账本一次", async () => {
    await connect();
    const raw: FeishuRawEvent = {
      type: "im.message.receive_v1",
      messageId: "om_dup",
      chatId: chatOf(lin.pmId),
      chatType: "group",
      senderOpenId: OWNER,
      senderType: "user",
      content: "只要一次",
      mentionedBot: false,
      threadId: null,
      resources: [],
      createTime: Date.now(),
    };
    fake.event(raw);
    fake.event(raw);
    await settle();
    fake.event(raw);
    await settle();
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["只要一次"]);
  });
});

describe("createFeishuService：访客权限", () => {
  it("第一个访客进群时群里发一张群设置卡；主人点按钮改档位，访客点收到 toast、档位不变", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    join_(chat);
    join_(chat, "ou_guest2", "王五");
    await settle();
    const policyCards = cardIdsCreated().filter((c) => c.data.includes("群设置"));
    expect(policyCards).toHaveLength(1);
    const post = store().postOf({ kind: "chat_policy", pmId: lin.pmId })!;
    const toCollab = { fusa: 1, kind: "set_policy", pmId: lin.pmId, guestTier: "collaborator" };
    expect(click(chat, post.messageId, toCollab, GUEST).toast?.content).toBe("只有主人能改设置");
    await settle();
    expect(store().chatOfTarget({ kind: "pm", pmId: lin.pmId })!.guestTier).toBe("chat_only");
    expect(cardIdsCreated().filter((c) => c.data.includes("群设置"))).toHaveLength(1);
    expect(click(chat, post.messageId, toCollab, OWNER).toast?.type).toBe("success");
    await settle();
    expect(store().chatOfTarget({ kind: "pm", pmId: lin.pmId })!.guestTier).toBe("collaborator");
    expect(fake.callsOf("card.update").some((u) => u.card_id === post.cardId && u.card.data.includes("协作者"))).toBe(true);
  });

  it("chat_only 档访客点拍板、停止只收到 toast，账本不变；发的文件不收", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    join_(chat);
    await settle();
    const askId = await askInGroupFor(lin);
    const post = postOfAsk(askId);
    const choose = { fusa: 1, kind: "choose", card: { kind: "ask", askMessageId: askId }, optionIndex: 0 };
    expect(click(chat, post.messageId, choose, GUEST).toast?.content).toBe("只有主人能拍板");
    expect(click(chat, post.messageId, { fusa: 1, kind: "stop", conversationId: lin.conversationId }, GUEST).toast?.content).toBe("只有主人能停止");
    expect(askOf(ledger.getMessage(askId)!)?.answered).toBeUndefined();
    fake.resources.set("file_g", Buffer.from("guest file"));
    say(chat, "看这个", { sender: GUEST, mention: true, files: [{ type: "file", fileKey: "file_g", fileName: "g.txt" }] });
    await settle();
    const [m] = userMessages(lin.conversationId).filter((x) => x.text === "看这个");
    expect(m?.meta?.attachments).toBeUndefined();
    expect(fake.calls.some((c) => c.method === "downloadResource")).toBe(false);
  });

  it("collaborator 档访客点拍板记进账本，点停止能停，发的文件收成附件", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    await svc.setup.setChatPolicy({ pmId: lin.pmId, guestTier: "collaborator" });
    join_(chat);
    await settle();
    const askId = await askInGroupFor(lin);
    const post = postOfAsk(askId);
    const stops: ConversationId[] = [];
    ledger.onStopRequested((e) => stops.push(e.conversationId));
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    expect(click(chat, post.messageId, { fusa: 1, kind: "choose", card: { kind: "ask", askMessageId: askId }, optionIndex: 1 }, GUEST).toast?.type).toBe("success");
    expect(askOf(ledger.getMessage(askId)!)).toMatchObject({ answered: true, chosenOption: "不要" });
    ev(lin.sessionId, { type: "agent.text_delta", delta: "正在处理", at: Date.now() });
    await settle();
    const sent = streamCardMessage(chat)!;
    expect(click(chat, sent.messageId, { fusa: 1, kind: "stop", conversationId: lin.conversationId }, GUEST).toast?.content).toBe("正在停");
    expect(stops).toEqual([lin.conversationId]);
    fake.resources.set("file_c", Buffer.from("collab file"));
    say(chat, "附件给你", { sender: GUEST, mention: true, files: [{ type: "file", fileKey: "file_c", fileName: "c.txt" }] });
    await settle();
    const m = userMessages(lin.conversationId).find((x) => x.text === "附件给你")!;
    expect((m.meta?.attachments as { name: string }[])[0]!.name).toBe("c.txt");
  });

  it("只接受当前群实际发出的卡片，归档与删除即时拒绝回调", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    const ask = await askInGroupFor(lin);
    const post = postOfAsk(ask);
    const choose = { fusa: 1, kind: "choose", card: { kind: "ask", askMessageId: ask }, optionIndex: 0 };
    expect(click(chatOf(zhou.pmId), post.messageId, choose).toast?.type).toBe("warning");
    expect(click(chat, "om_fixture_unknown", choose).toast?.type).toBe("warning");
    await svc.setup.setChatPolicy({ pmId: lin.pmId, guestTier: "collaborator" });
    const routerPost = postOfRouterItem(itemOfAsk(ask).id);
    expect(click(routerChat(), routerPost.messageId, choose, GUEST).toast?.type).toBe("warning");
    ledger.archivePm(lin.pmId);
    expect(click(chat, post.messageId, choose).toast?.type).toBe("warning");
    expect(click(routerChat(), routerPost.messageId, choose).toast?.type).toBe("warning");
    ledger.purgeExpiredArchivedPms(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(click(chat, post.messageId, choose).toast?.type).toBe("warning");
    expect(click(routerChat(), routerPost.messageId, choose).toast?.type).toBe("warning");
    expect(ledger.getMessage(ask)).toBeNull();
  });

  it("observer 档访客 @机器人 也不唤醒；主人下次唤醒时，访客说的话作为背景一起交给项目经理", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    await svc.setup.setChatPolicy({ pmId: lin.pmId, guestTier: "observer" });
    join_(chat);
    await settle();
    say(chat, "我只是看看", { sender: GUEST, mention: true });
    await settle();
    expect(userMessages(lin.conversationId)).toHaveLength(0);
    say(chat, "继续", { mention: true });
    await settle();
    const [m] = userMessages(lin.conversationId);
    expect(ledger.deliveryOf(m!).prefixes.join("\n")).toContain("李四（访客）：我只是看看");
  });

  it("任何档访客的话触发的那一轮里项目经理调 project.attach 被账本拒绝", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    join_(chat);
    await settle();
    for (const tier of ["chat_only", "collaborator"] as const) {
      await svc.setup.setChatPolicy({ pmId: lin.pmId, guestTier: tier });
      say(chat, `帮我挂载文件夹 ${tier}`, { sender: GUEST, mention: true });
      await settle();
      const m = userMessages(lin.conversationId).find((x) => x.text.endsWith(tier))!;
      running(lin.sessionId);
      ev(lin.sessionId, { type: "message.delivered", messageIds: [m.id], at: Date.now() });
      ev(lin.sessionId, { type: "message.processing", messageIds: [m.id], at: Date.now() });
      expect(() => ledger.hubCall(lin.sessionId, "project.attach", { path: root } as never)).toThrow(/访客/);
      ev(lin.sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [m.id], durationMs: 1, at: Date.now() });
    }
  });

  it("别人私聊机器人被拒，不进总助", async () => {
    await connect();
    say("oc_stranger", "你好", { sender: GUEST, p2p: true });
    await settle();
    expect(routerCalls).toEqual([]);
    const reply = fake.callsOf("message.create").find((c) => c.receive_id === "oc_stranger");
    expect(JSON.parse(reply!.content).text).toContain("私人助手");
  });
});

describe("createFeishuService：群设置卡随叫随到", () => {
  const policyCards = () => cardIdsCreated().filter((c) => c.data.includes("群设置"));
  const policyPost = () => store().postOf({ kind: "chat_policy", pmId: lin.pmId });
  const textsTo = (chatId: string) =>
    fake.callsOf("message.create").filter((c) => c.receive_id === chatId && c.msg_type === "text").map((c) => (JSON.parse(c.content) as { text: string }).text);

  it("主人发「设置」「权限」「@机器人 设置」：照常进账本交给项目经理，不发群设置卡", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    say(chat, "设置");
    say(chat, "模型");
    say(chat, "权限");
    await settle();
    join_(chat);
    await settle();
    const before = policyCards().length;
    say(chat, "设置", { mention: true });
    say(chat, "模型", { mention: true });
    await settle();
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["设置", "模型", "权限", "设置", "模型"]);
    expect(policyCards()).toHaveLength(before);
  });

  it("主人发 /群设置、/设置、/policy、/model、/settings：群底马上发一张新的群设置卡，不进账本、不交给项目经理", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    say(chat, "/群设置");
    await settle();
    expect(policyCards()).toHaveLength(1);
    const first = policyPost()!;
    expect(first.chatId).toBe(chat);
    for (const cmd of ["/policy", "/设置", "/model", "/settings"]) {
      say(chat, cmd, { mention: true });
    }
    await settle();
    expect(policyCards()).toHaveLength(5);
    expect(policyPost()!.messageId).not.toBe(first.messageId);
    expect(fake.sent.at(-1)!.messageId).toBe(policyPost()!.messageId);
    expect(userMessages(lin.conversationId)).toHaveLength(0);
  });

  it("新卡点得动、改完原地刷新；旧卡点了提示去叫新卡，档位不变", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    say(chat, "/群设置");
    await settle();
    const old = policyPost()!;
    say(chat, "/群设置");
    await settle();
    const fresh = policyPost()!;
    const toObserver = { fusa: 1, kind: "set_policy", pmId: lin.pmId, guestTier: "observer" };
    const stale = click(chat, old.messageId, toObserver);
    expect(stale.toast?.type).toBe("warning");
    expect(stale.toast?.content).toContain("/群设置");
    await settle();
    expect(store().chatOfTarget({ kind: "pm", pmId: lin.pmId })!.guestTier).toBe("chat_only");
    expect(click(chat, fresh.messageId, toObserver).toast?.type).toBe("success");
    await settle();
    expect(store().chatOfTarget({ kind: "pm", pmId: lin.pmId })!.guestTier).toBe("observer");
    const update = fake.callsOf("card.update").findLast((u) => u.card_id === fresh.cardId)!;
    expect(update.sequence).toBeGreaterThan(fresh.sequence);
    expect(update.card.data).toContain("✓ 只读");
  });

  it("每发一张新卡就置顶它，并取消上一张设置卡的置顶", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    say(chat, "/群设置");
    await settle();
    const first = policyPost()!.messageId;
    expect(fake.callsOf("pin.create")).toEqual([{ message_id: first }]);
    expect(fake.callsOf("pin.delete")).toEqual([]);
    say(chat, "/群设置");
    await settle();
    const second = policyPost()!.messageId;
    expect(fake.callsOf("pin.create")).toEqual([{ message_id: first }, { message_id: second }]);
    expect(fake.callsOf("pin.delete")).toEqual([{ message_id: first }]);
  });

  it("置顶被飞书拒（缺权限、群里只许群主置顶）：记一行日志，卡照发、照样能用", async () => {
    const lines: string[] = [];
    svc = makeService({ log: (line) => lines.push(line) });
    await connect();
    const chat = chatOf(lin.pmId);
    fake.failNext["pin.create"] = { code: 230027, msg: "Lack of necessary permissions." };
    say(chat, "/群设置");
    await settle();
    expect(policyCards()).toHaveLength(1);
    expect(lines.some((line) => line.includes("置顶") && line.includes("230027"))).toBe(true);
    expect(svc.setup.status().state).toBe("connected");
    const post = policyPost()!;
    expect(click(chat, post.messageId, { fusa: 1, kind: "set_policy", pmId: lin.pmId, guestTier: "collaborator" }).toast?.type).toBe("success");
    fake.failNext["pin.delete"] = new Error("network down");
    say(chat, "/群设置");
    await settle();
    expect(policyCards()).toHaveLength(2);
    expect(store().chatOfTarget({ kind: "pm", pmId: lin.pmId })!.guestTier).toBe("collaborator");
  });

  it("访客发 /群设置：回他只有主人能叫，不发卡、不进账本", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    join_(chat);
    await settle();
    const before = policyCards().length;
    say(chat, "/群设置", { sender: GUEST, mention: true });
    say(chat, "/policy", { sender: GUEST });
    await settle();
    expect(policyCards()).toHaveLength(before);
    expect(userMessages(lin.conversationId)).toHaveLength(0);
    expect(textsTo(chat).filter((t) => t.includes("只有主人"))).toHaveLength(2);
  });

  it("访客发文件被拒（含前面气泡里的待收文件）：提示之外在群底附一张群设置卡；冷却内不再附，过了冷却再附", async () => {
    let offset = 0;
    svc = makeService({ now: () => Date.now() + offset });
    await connect();
    const chat = chatOf(lin.pmId);
    join_(chat);
    await settle();
    const joined = policyCards().length;
    offset += FEISHU_POLICY_CARD_COOLDOWN_MS;
    say(chat, "看这个", { sender: GUEST, mention: true, files: [{ type: "file", fileKey: "file_g1", fileName: "g.txt" }] });
    await settle();
    expect(policyCards()).toHaveLength(joined + 1);
    expect(fake.sent.at(-1)!.messageId).toBe(policyPost()!.messageId);
    say(chat, "", { sender: GUEST, files: [{ type: "file", fileKey: "file_g2", fileName: "h.txt" }] });
    say(chat, "", { sender: GUEST, mention: true });
    await settle();
    expect(policyCards()).toHaveLength(joined + 1);
    expect(textsTo(chat).filter((t) => t.includes("文件不收"))).toHaveLength(2);
    offset += FEISHU_POLICY_CARD_COOLDOWN_MS;
    say(chat, "", { sender: GUEST, files: [{ type: "file", fileKey: "file_g3", fileName: "i.txt" }] });
    say(chat, "", { sender: GUEST, mention: true });
    await settle();
    expect(policyCards()).toHaveLength(joined + 2);
    expect(fake.calls.some((c) => c.method === "downloadResource")).toBe(false);
  });

  it("访客点拍板、停止权限不够：toast 之外附一张群设置卡，冷却内只附一次；主人发 /群设置 不受冷却限制", async () => {
    let offset = 0;
    svc = makeService({ now: () => Date.now() + offset });
    await connect();
    const chat = chatOf(lin.pmId);
    join_(chat);
    await settle();
    offset += FEISHU_POLICY_CARD_COOLDOWN_MS;
    const joined = policyCards().length;
    const askId = await askInGroupFor(lin);
    const post = postOfAsk(askId);
    const choose = { fusa: 1, kind: "choose", card: { kind: "ask", askMessageId: askId }, optionIndex: 0 };
    expect(click(chat, post.messageId, choose, GUEST).toast?.content).toBe("只有主人能拍板");
    await settle();
    expect(policyCards()).toHaveLength(joined + 1);
    expect(click(chat, post.messageId, { fusa: 1, kind: "stop", conversationId: lin.conversationId }, GUEST).toast?.content).toBe("只有主人能停止");
    await settle();
    expect(policyCards()).toHaveLength(joined + 1);
    expect(askOf(ledger.getMessage(askId)!)?.answered).toBeUndefined();
    say(chat, "/群设置");
    await settle();
    expect(policyCards()).toHaveLength(joined + 2);
  });

  it("访客点群设置卡被拒：只 toast，不另附新卡", async () => {
    let offset = 0;
    svc = makeService({ now: () => Date.now() + offset });
    await connect();
    const chat = chatOf(lin.pmId);
    join_(chat);
    await settle();
    offset += FEISHU_POLICY_CARD_COOLDOWN_MS;
    const joined = policyCards().length;
    expect(click(chat, policyPost()!.messageId, { fusa: 1, kind: "set_policy", pmId: lin.pmId, guestTier: "collaborator" }, GUEST).toast?.content).toBe("只有主人能改设置");
    await settle();
    expect(policyCards()).toHaveLength(joined);
  });

  it("主人在群设置卡下拉切厂商、模型、思考程度：账本零交接同步，卡片原地刷新下游选项；单档位模型隐藏思考程度下拉；网页改模型也自动刷卡；访客与旧卡被拒", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    await svc.setup.setChatPolicy({ pmId: lin.pmId, guestTier: "collaborator" });
    say(chat, "/model");
    await settle();
    const oldCard = policyPost()!;
    say(chat, "/设置");
    await settle();
    const post = policyPost()!;

    const vendorAction = { fusa: 1, kind: "set_pm_model", pmId: lin.pmId, field: "vendor" };
    const modelAction = { fusa: 1, kind: "set_pm_model", pmId: lin.pmId, field: "model" };
    const effortAction = { fusa: 1, kind: "set_pm_model", pmId: lin.pmId, field: "effort" };

    expect(chooseOption(chat, post.messageId, vendorAction, "codex", GUEST).toast?.content).toBe("只有主人能改设置");
    expect(ledger.getPersona(lin.pmId).vendor).toBe("claude");

    expect(chooseOption(chat, oldCard.messageId, vendorAction, "codex", OWNER).toast?.content).toContain("已换新");
    expect(ledger.getPersona(lin.pmId).vendor).toBe("claude");

    expect(chooseOption(chat, post.messageId, vendorAction, "codex", OWNER).toast?.type).not.toBe("error");
    await settle();
    expect(ledger.getPersona(lin.pmId)).toMatchObject({ vendor: "codex", model: null, effort: null });
    let latestCard = fake.callsOf("card.update").findLast((u) => u.card_id === post.cardId)!.card.data;
    expect(latestCard).toContain("gpt-6-luna");

    expect(chooseOption(chat, post.messageId, modelAction, "gpt-6-luna", OWNER).toast?.type).toBe("success");
    await settle();
    expect(chooseOption(chat, post.messageId, effortAction, "high", OWNER).toast?.type).toBe("success");
    await settle();
    expect(ledger.getPersona(lin.pmId)).toMatchObject({ vendor: "codex", model: "gpt-6-luna", effort: "high" });

    expect(chooseOption(chat, post.messageId, vendorAction, "agy", OWNER).toast?.type).not.toBe("error");
    await settle();
    expect(chooseOption(chat, post.messageId, modelAction, "gpt-oss-120b", OWNER).toast?.type).toBe("success");
    await settle();
    latestCard = fake.callsOf("card.update").findLast((u) => u.card_id === post.cardId)!.card.data;
    expect(latestCard).toContain("不支持");
    expect(latestCard).not.toContain('"field":"effort"');

    ledger.editPersona(lin.pmId, { vendor: "claude", model: "sonnet", effort: "low" }, { kind: "user" });
    await settle();
    latestCard = fake.callsOf("card.update").findLast((u) => u.card_id === post.cardId)!.card.data;
    expect(latestCard).toContain("Claude");
    expect(latestCard).toContain("sonnet");
  });

  it("切到未登录厂商时当场回 warning toast、账本不变，并重刷卡片把下拉弹回原厂商", async () => {
    const signedOutCodex = { ...bundledModelCatalog("codex"), availability: "signed_out" as const };
    const availableClaude = { ...bundledModelCatalog("claude"), availability: "available" as const };
    let warmed = true;
    svc = makeService({
      models: {
        list: async () => {
          warmed = true;
          return [availableClaude, signedOutCodex];
        },
        current: (v: string) => (!warmed ? null : v === "codex" ? signedOutCodex : availableClaude),
        availability: (v: string) => (!warmed ? "unknown" : v === "codex" ? "signed_out" : "available"),
      } as never,
    });
    await connect();
    const chat = chatOf(lin.pmId);
    say(chat, "/设置");
    await settle();
    const post = policyPost()!;
    const updatesBefore = fake.callsOf("card.update").filter((u) => u.card_id === post.cardId).length;
    const res = chooseOption(chat, post.messageId, { fusa: 1, kind: "set_pm_model", pmId: lin.pmId, field: "vendor" }, "codex", OWNER);
    expect(res.toast?.type).toBe("warning");
    expect(res.toast?.content).toContain("登录");
    await settle();
    expect(ledger.getPersona(lin.pmId).vendor).toBe("claude");
    expect(fake.callsOf("card.update").filter((u) => u.card_id === post.cardId).length).toBeGreaterThan(updatesBefore);

    warmed = false;
    const cold = chooseOption(chat, post.messageId, { fusa: 1, kind: "set_pm_model", pmId: lin.pmId, field: "vendor" }, "codex", OWNER);
    expect(cold.toast?.type).toBe("info");
    await settle();
    expect(ledger.getPersona(lin.pmId).vendor).toBe("claude");
    expect(textsTo(chat).some((t) => t.includes("登录"))).toBe(true);
  });

  it("B1：pm.updated 刷卡与访客被动附卡只读缓存目录不调 models.list，不阻塞出站镜像；主人发 /设置 秒发卡并在后台异步重问一次", async () => {
    const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const slowMs = 350;
    let codexStatus: "signed_out" | "available" = "signed_out";
    const listCalls: unknown[] = [];
    let clock = Date.now();
    const makeCatalog = (v: string) => ({
      ...bundledModelCatalog(v as "claude" | "codex" | "agy"),
      availability: (v === "codex" ? codexStatus : "available") as "available" | "signed_out",
    });
    await svc.close();
    svc = makeService({
      now: () => clock,
      models: {
        list: async (opts?: unknown) => {
          listCalls.push(opts ?? {});
          await waitMs(slowMs);
          codexStatus = "available";
          return ["claude", "codex", "agy"].map(makeCatalog);
        },
        current: (v: string) => (v === "codex" && codexStatus === "signed_out" ? null : makeCatalog(v)),
        availability: (v: string) => (v === "codex" ? codexStatus : "available"),
      } as never,
    });
    await connect();
    const chat = chatOf(lin.pmId);

    join_(chat);
    await settle();
    const passiveCalls = [...listCalls];
    listCalls.length = 0;

    for (let i = 0; i < 3; i++) {
      ledger.editPersona(lin.pmId, { text: `规则 ${i}` }, { kind: "user" });
    }
    const startedAt = Date.now();
    ledger.editPersona(lin.pmId, { text: "紧跟镜像前改一次" }, { kind: "user" });
    ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "web-fast-mirror", text: "不该被慢目录卡住的镜像" });
    await waitMs(80);
    expect(cardsSentTo(chat).some((c) => JSON.stringify(c).includes("不该被慢目录卡住的镜像"))).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(slowMs);
    expect(listCalls).toEqual([]);
    expect(passiveCalls).toEqual([]);

    clock += FEISHU_POLICY_CARD_COOLDOWN_MS + 1_000;
    codexStatus = "signed_out";
    say(chat, "看图", { sender: GUEST, mention: true, files: [{ type: "image", fileKey: "img_b1", fileName: null }] });
    await settle();
    expect(policyCards()).toHaveLength(2);
    expect(listCalls).toEqual([]);

    say(chat, "/设置");
    say(chat, "/群设置");
    await waitMs(80);
    expect(policyCards()).toHaveLength(4);
    const post = policyPost()!;
    expect(fake.cards.get(post.cardId!)).toContain("Codex（未登录）");
    expect(listCalls).toEqual([{ refresh: "unusable" }]);

    await waitMs(slowMs + 80);
    await settle();
    expect(listCalls).toHaveLength(1);
    const refreshed = fake.callsOf("card.update").findLast((u) => u.card_id === post.cardId)?.card.data ?? "";
    expect(refreshed).not.toContain("Codex（未登录）");
  });

  it("N1：切厂商途中再在设置卡下拉换厂商时拦截提示等待本轮结束并弹回下拉，换模型和思考程度照常更新交接目标", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    say(chat, "/设置");
    await settle();
    const post = policyPost()!;

    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    const vendorAction = { fusa: 1, kind: "set_pm_model", pmId: lin.pmId, field: "vendor" };
    const modelAction = { fusa: 1, kind: "set_pm_model", pmId: lin.pmId, field: "model" };

    const switchRes = chooseOption(chat, post.messageId, vendorAction, "codex", OWNER);
    expect(switchRes.toast?.content).toContain("Codex");
    await settle();
    expect(ledger.getPersona(lin.pmId).switchingToVendor).toBe("codex");

    const updatesBefore = fake.callsOf("card.update").filter((u) => u.card_id === post.cardId).length;
    const revertAttempt = chooseOption(chat, post.messageId, vendorAction, "claude", OWNER);
    expect(revertAttempt.toast?.type).toBe("warning");
    expect(revertAttempt.toast?.content).toContain("当前这一轮");
    await settle();
    expect(ledger.getPersona(lin.pmId)).toMatchObject({ vendor: "codex", switchingToVendor: "codex" });
    expect(fake.callsOf("card.update").filter((u) => u.card_id === post.cardId).length).toBeGreaterThan(updatesBefore);

    expect(chooseOption(chat, post.messageId, modelAction, "gpt-6-luna", OWNER).toast?.type).toBe("success");
    await settle();
    expect(ledger.getPersona(lin.pmId)).toMatchObject({ vendor: "codex", model: "gpt-6-luna", switchingToVendor: "codex" });
  });

  it("N3：账本拒收下拉值或冷目录异步改模型报错时，补刷设置卡弹回真实值并在异步路径发提示", async () => {
    let warmed = true;
    const availableClaude = { ...bundledModelCatalog("claude"), availability: "available" as const };
    const availableCodex = { ...bundledModelCatalog("codex"), availability: "available" as const };
    await svc.close();
    svc = makeService({
      models: {
        list: async () => [availableClaude, availableCodex],
        current: (v: string) => (!warmed ? null : v === "codex" ? availableCodex : availableClaude),
        availability: () => "available" as const,
      } as never,
    });
    await connect();
    const chat = chatOf(lin.pmId);
    const rChat = routerChat();
    say(chat, "/设置");
    say(rChat, "/设置", { p2p: true });
    await settle();
    const pmPost = policyPost()!;
    const routerPost = store().postOf({ kind: "router_settings" })!;

    const editSpy = vi.spyOn(ledger, "editPersona").mockImplementationOnce(() => {
      throw new LedgerRequestError("invalid", "账本拒收该模型");
    });
    const pmUpdatesBefore = fake.callsOf("card.update").filter((u) => u.card_id === pmPost.cardId).length;
    const syncReject = chooseOption(chat, pmPost.messageId, { fusa: 1, kind: "set_pm_model", pmId: lin.pmId, field: "model" }, "sonnet", OWNER);
    expect(syncReject.toast).toEqual({ type: "warning", content: "账本拒收该模型" });
    await settle();
    expect(fake.callsOf("card.update").filter((u) => u.card_id === pmPost.cardId).length).toBeGreaterThan(pmUpdatesBefore);

    const routerSpy = vi.spyOn(ledger, "updateRouterSettings").mockImplementationOnce(() => {
      throw new LedgerRequestError("invalid", "总助拒收该档位");
    });
    const routerUpdatesBefore = fake.callsOf("card.update").filter((u) => u.card_id === routerPost.cardId).length;
    const routerReject = chooseOption(rChat, routerPost.messageId, { fusa: 1, kind: "set_router_model", field: "vendor" }, "codex", OWNER);
    expect(routerReject.toast).toEqual({ type: "warning", content: "总助拒收该档位" });
    await settle();
    expect(fake.callsOf("card.update").filter((u) => u.card_id === routerPost.cardId).length).toBeGreaterThan(routerUpdatesBefore);

    warmed = false;
    editSpy.mockImplementationOnce(() => {
      throw new LedgerRequestError("invalid", "冷目录异步拒收");
    });
    const asyncUpdatesBefore = fake.callsOf("card.update").filter((u) => u.card_id === pmPost.cardId).length;
    expect(chooseOption(chat, pmPost.messageId, { fusa: 1, kind: "set_pm_model", pmId: lin.pmId, field: "vendor" }, "codex", OWNER).toast?.type).toBe("info");
    await settle();
    expect(textsTo(chat).some((t) => t.includes("冷目录异步拒收"))).toBe(true);
    expect(fake.callsOf("card.update").filter((u) => u.card_id === pmPost.cardId).length).toBeGreaterThan(asyncUpdatesBefore);

    editSpy.mockRestore();
    routerSpy.mockRestore();
  });

  it("N5：超过保留期执行 prunePosts 后再发 /设置，仍取消上一张设置卡的置顶，不留下双置顶", async () => {
    let clock = 1_000;
    await svc.close();
    svc = makeService({ now: () => clock });
    await connect();
    const chat = chatOf(lin.pmId);
    say(chat, "/设置");
    await settle();
    const firstMsgId = policyPost()!.messageId;

    clock += 15 * 24 * 60 * 60 * 1_000;
    store().prunePosts(clock - 14 * 24 * 60 * 60 * 1_000);
    say(chat, "/设置");
    await settle();
    expect(fake.callsOf("pin.delete")).toContainEqual({ message_id: firstMsgId });
  });
});

describe("createFeishuService：流式、急停与卡片", () => {
  const delta = (sessionId: SessionId, text: string) => ev(sessionId, { type: "agent.text_delta", delta: text, at: Date.now() });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("项目经理回复时在群主聊天流发一张流式卡片，随流式推全文，落库后正文等于账本这段文字、关流式、停止按钮去掉", async () => {
    await connect();
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    delta(lin.sessionId, "我先");
    await settle();
    await wait(FEISHU_STREAM_FLUSH_MS + 50);
    delta(lin.sessionId, "看一下代码");
    await wait(FEISHU_STREAM_FLUSH_MS * 2);
    await settle();
    const streamCard = cardIdsCreated()[0]!;
    expect(cardJsonOf(streamCard.data).config.streaming_mode).toBe(true);
    expect(buttonValues(streamCard.data)).toEqual([{ kind: "stop", conversationId: lin.conversationId }]);
    const pushes = fake.callsOf("card.element.content");
    expect(pushes.at(-1)?.content).toBe("我先看一下代码");
    ev(lin.sessionId, { type: "agent.text", uuid: "u1", text: "我先看一下代码。结论：没问题。", at: Date.now() });
    await settle();
    const final = fake.callsOf("card.update").at(-1)!;
    const finalCard = cardJsonOf(final.card.data);
    expect(finalCard.config.streaming_mode).toBe(false);
    expect(JSON.stringify(finalCard.body)).toContain("我先看一下代码。结论：没问题。");
    expect(buttonValues(final.card.data)).toEqual([]);
    const seqs = [...pushes.map((p) => p.sequence), final.sequence];
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    expect(cardIdsCreated()).toHaveLength(1);
  });

  it("整个流程里假传输层收到的发送都没有 reply_in_thread，也不是回复某条消息", async () => {
    await connect();
    running(lin.sessionId);
    delta(lin.sessionId, "一段话");
    await settle();
    ev(lin.sessionId, { type: "agent.text", uuid: "u2", text: "一段话。", at: Date.now() });
    await askInGroupFor(lin);
    say(chatOf(lin.pmId), "收到");
    ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "web-x", text: "网页说" });
    await settle();
    expect(fake.calls.length).toBeGreaterThan(5);
    for (const call of fake.calls) {
      const text = JSON.stringify(call.args);
      expect(text).not.toContain("reply_in_thread");
      expect(text).not.toContain("root_id");
      expect(text).not.toContain("parent_id");
      expect(call.method).not.toMatch(/reply/);
    }
  });

  it("超过 FEISHU_CARD_MAX_CHARS 的回复定稿成多张卡，拼起来等于账本这段文字", async () => {
    await connect();
    const para = "这是一段比较长的话。".repeat(100);
    const text = Array.from({ length: Math.ceil((FEISHU_CARD_MAX_CHARS * 2.5) / para.length) }, () => para).join("\n\n");
    ev(lin.sessionId, { type: "agent.text", uuid: "long", text, at: Date.now() });
    await settle();
    const sent = cardsSentTo(chatOf(lin.pmId)) as { body?: { elements: { content?: string }[] } }[];
    const bodies = sent.map((c) => c.body?.elements[0]?.content ?? "");
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    expect(bodies.join("")).toBe(text);
  });

  it.each(["card.create", "message.create"] as const)("%s 临时失败后仍能定稿，归档重建后的下一轮发到新群", async (method) => {
    await connect();
    const oldChat = chatOf(lin.pmId);
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    fake.failNext[method] = new Error("临时网络错误");
    delta(lin.sessionId, "临时预览");
    ev(lin.sessionId, { type: "agent.text", uuid: "first-final", text: "失败后仍定稿", at: Date.now() });
    await settle();
    // 开轮时的状态卡建卡失败后，正文来了重新开卡，定稿在新开的这张上
    expect(cardsSentTo(oldChat).some((card) => JSON.stringify(card).includes("失败后仍定稿")) || fake.callsOf("card.update").some((u) => u.card.data.includes("失败后仍定稿"))).toBe(true);
    ledger.archivePm(lin.pmId);
    await settle();
    ledger.unarchivePm(lin.pmId);
    await settle();
    const newChat = chatOf(lin.pmId);
    expect(newChat).not.toBe(oldChat);
    const session = ledger.snapshot().sessions.find((session) => session.conversationId === lin.conversationId && session.status !== "ended")?.sessionId ?? lin.sessionId;
    running(session);
    ev(session, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 1, at: Date.now() });
    ev(session, { type: "turn.started", at: Date.now() });
    delta(session, "新群预览");
    await settle();
    ev(session, { type: "agent.text", uuid: "second-final", text: "只在新群定稿", at: Date.now() });
    await settle();
    expect(fake.callsOf("card.update").some((call) => call.card.data.includes("只在新群定稿"))).toBe(true);
    expect(fake.sent.filter((entry) => entry.chatId === newChat)).toHaveLength(1);
    expect(svc.setup.status().lastError).not.toContain("FOREIGN KEY");
  });

  it("定稿清掉续期计时器，已结束的停止按钮不能影响下一轮", async () => {
    await connect();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const chat = chatOf(lin.pmId);
      running(lin.sessionId);
      ev(lin.sessionId, { type: "turn.started", at: Date.now() });
      delta(lin.sessionId, "开始写");
      await settle();
      const sent = fake.sent.at(-1)!;
      ev(lin.sessionId, { type: "agent.text", uuid: "stopped-final", text: "已经定稿", at: Date.now() });
      await settle();
      expect(click(chat, sent.messageId, { fusa: 1, kind: "stop", conversationId: lin.conversationId }).toast?.type).toBe("warning");
      await vi.advanceTimersByTimeAsync(FEISHU_STREAM_RENEW_MS);
      await settle();
      expect(fake.callsOf("card.settings")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("主人点停止调 requestStop，回 toast，这一轮停下后卡片收尾", async () => {
    await connect();
    const stops: ConversationId[] = [];
    ledger.onStopRequested((e) => stops.push(e.conversationId));
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    delta(lin.sessionId, "写到一半");
    await settle();
    expect(cardIdsCreated()).toHaveLength(1);
    const response = click(chatOf(lin.pmId), fake.sent.at(-1)!.messageId, { fusa: 1, kind: "stop", conversationId: lin.conversationId });
    expect(response.toast?.content).toBe("正在停");
    expect(stops).toEqual([lin.conversationId]);
    ev(lin.sessionId, { type: "turn.ended", ok: false, interrupted: true, messageIds: [], durationMs: 1, at: Date.now() });
    await settle();
    const last = fake.callsOf("card.update").at(-1)!;
    expect(cardJsonOf(last.card.data).config.streaming_mode).toBe(false);
    expect(buttonValues(last.card.data)).toEqual([]);
    expect(last.card.data).toContain("写到一半");
  });

  it("hub ask 的卡片在群里带按钮；主人在飞书点选项后账本记下回答，网页上这张卡同时变成已回答", async () => {
    await connect();
    const askId = await askInGroupFor(lin);
    const post = postOfAsk(askId);
    expect(post.state).toBe("card_pending");
    const created = cardIdsCreated().find((c) => c.data.includes("要不要上线"))!;
    expect(buttonValues(created.data)).toContainEqual({ kind: "choose", card: { kind: "ask", askMessageId: askId }, optionIndex: 0 });
    expect(click(chatOf(lin.pmId), post.messageId, { fusa: 1, kind: "choose", card: { kind: "ask", askMessageId: askId }, optionIndex: 0 }, OWNER, "快点").toast?.type).toBe("success");
    expect(askOf(ledger.getMessage(askId)!)).toMatchObject({ answered: true, chosenOption: "要", answerNote: "快点" });
    await settle();
    expect(postOfAsk(askId).state).toBe("card_settled");
  });

  it("网页上回答的卡片，飞书里那张改成已定案、按钮去掉；改两次结果相同", async () => {
    await connect();
    const askId = await askInGroupFor(lin);
    ledger.answerAsk(askId, { clientId: "web-click", choice: "不要" });
    await settle();
    const update = fake.callsOf("card.update").find((u) => u.card_id === postOfAsk(askId).cardId)!;
    expect(update.card.data).toContain("不要");
    expect(buttonValues(update.card.data)).toEqual([]);
    const updatesBefore = fake.callsOf("card.update").length;
    ledger.answerAsk(askId, { clientId: "web-click", choice: "不要" });
    await svc.setup.resync();
    await settle();
    expect(fake.callsOf("card.update").length).toBe(updatesBefore);
  });

  it("网页上发的用户消息镜像到群里，标明来自网页", async () => {
    await connect();
    ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "web-2", text: "网页里说的话" });
    await settle();
    const mirrored = cardsSentTo(chatOf(lin.pmId)).find((c) => JSON.stringify(c).includes("网页里说的话"))!;
    expect(JSON.stringify(mirrored)).toContain("网页上说");
    say(chatOf(lin.pmId), "飞书里说的话");
    await settle();
    expect(cardsSentTo(chatOf(lin.pmId)).some((c) => JSON.stringify(c).includes("飞书里说的话"))).toBe(false);
  });

  it("项目经理发的图片嵌进回复卡、别的文件紧跟着发成文件消息，同一个文件只传一次", async () => {
    await connect();
    const home = join(root, "out");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "shot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    writeFileSync(join(home, "notes.md"), "# 笔记");
    const text = `看图 [截图](${join(home, "shot.png")}) 和 [笔记](${join(home, "notes.md")})`;
    ev(lin.sessionId, { type: "agent.text", uuid: "files1", text, at: Date.now() });
    await settle();
    const kinds = fake.callsOf("message.create").filter((c) => c.receive_id === chatOf(lin.pmId)).map((c) => c.msg_type);
    expect(kinds).not.toContain("image");
    expect(kinds).toContain("file");
    expect([...fake.cards.values()].some((data) => imgKeysOf(data).length === 1)).toBe(true);
    const uploads = fake.calls.filter((c) => c.method === "uploadFile" || (c.method === "uploadImage" && c.args.imageType === "message")).length;
    await svc.setup.resync();
    await settle();
    expect(fake.calls.filter((c) => c.method === "uploadFile" || (c.method === "uploadImage" && c.args.imageType === "message")).length).toBe(uploads);
    expect(existsSync(join(dataHome, "sent-files"))).toBe(true);
  });

  it("三个项目经理同时流式回复时，每秒卡片接口调用不超过 FEISHU_CARDKIT_BUDGET_PER_SECOND，每个群每秒发送不超过 FEISHU_CHAT_SENDS_PER_SECOND", async () => {
    const third = ledger.createPm({ name: "老王", mode: "manage_only", persona: "" });
    await connect();
    const sessions = [lin.sessionId, zhou.sessionId, third.sessionId];
    for (const s of sessions) running(s);
    const started = Date.now();
    let body = "";
    while (Date.now() - started < 1500) {
      body += "字";
      for (const s of sessions) delta(s, "字");
      await wait(20);
    }
    await wait(FEISHU_STREAM_FLUSH_MS * 2);
    await settle();
    const pushes = fake.calls.filter((c) => c.method === "card.element.content").map((c) => c.at);
    expect(pushes.length).toBeGreaterThan(3);
    for (const t of pushes) expect(pushes.filter((x) => x >= t && x < t + 1000).length).toBeLessThanOrEqual(FEISHU_CARDKIT_BUDGET_PER_SECOND);
    for (const chat of fake.chats.keys()) {
      const sends = fake.calls.filter((c) => c.method === "message.create" && c.args.receive_id === chat).map((c) => c.at);
      for (const t of sends) expect(sends.filter((x) => x >= t && x < t + 1000).length).toBeLessThanOrEqual(FEISHU_CHAT_SENDS_PER_SECOND);
    }
    for (const [i, s] of sessions.entries()) ev(s, { type: "agent.text", uuid: `par${i}`, text: body, at: Date.now() });
    await settle();
    const finals = fake.callsOf("card.update").filter((u) => u.card.data.includes(body));
    expect(finals).toHaveLength(3);
  }, 15_000);
});

describe("createFeishuService：总助单聊", () => {
  it("主人在单聊里说的话交给 submitCommand，结果作为新卡片发在单聊里", async () => {
    await connect();
    say(routerChat(), "今天大家进度怎么样", { p2p: true });
    await settle();
    expect(routerCalls).toEqual([{ clientId: expect.stringMatching(/^feishu:om_in/), text: "今天大家进度怎么样" }]);
    const reply = cardsSentTo(routerChat()).find((c) => JSON.stringify(c).includes("总助回：今天大家进度怎么样"));
    expect(reply).toBeDefined();
    expect(JSON.stringify(reply)).not.toContain("网页上说");
  });

  it("简报发到单聊；带提问卡的拍板项在单聊里也有选项按钮", async () => {
    await connect();
    ledger.hubCall(lin.sessionId, "router.report", { summary: "登录页做完了" } as never);
    const askId = ledger.hubCall(lin.sessionId, "ask", { text: "发版吗？", options: ["发", "不发"] }).data.messageId;
    await settle();
    const routerCards = cardIdsCreated().filter((c) => c.data.includes("登录页做完了") || c.data.includes("发版吗"));
    expect(routerCards.some((c) => c.data.includes("登录页做完了"))).toBe(true);
    const inRouter = postOfRouterItem(itemOfAsk(askId).id);
    expect(inRouter.chatId).toBe(routerChat());
    const routerCard = routerCards.filter((c) => c.data.includes("发版吗")).find((c) => c.data.includes("打开项目群"))!;
    expect(buttonValues(routerCard.data)).toContainEqual({ kind: "choose", card: { kind: "ask", askMessageId: askId }, optionIndex: 0 });
  });

  it("在单聊里点选项后账本记下回答，项目群里那张卡同时改成已定案；反过来在群里点，单聊那条也改", async () => {
    await connect();
    const a1 = await askInGroupFor(lin, ["A", "B"]);
    const routerPost = postOfRouterItem(itemOfAsk(a1).id);
    expect(click(routerChat(), routerPost.messageId, { fusa: 1, kind: "choose", card: { kind: "ask", askMessageId: a1 }, optionIndex: 1 }).toast?.type).toBe("success");
    await settle();
    expect(askOf(ledger.getMessage(a1)!)).toMatchObject({ answered: true, chosenOption: "B" });
    expect(postOfAsk(a1).state).toBe("card_settled");
    expect(postOfRouterItem(itemOfAsk(a1).id).state).toBe("card_settled");
    const a2 = await askInGroupFor(lin, ["C", "D"]);
    expect(click(chatOf(lin.pmId), postOfAsk(a2).messageId, { fusa: 1, kind: "choose", card: { kind: "ask", askMessageId: a2 }, optionIndex: 0 }).toast?.type).toBe("success");
    await settle();
    expect(postOfRouterItem(itemOfAsk(a2).id).state).toBe("card_settled");
    const routerUpdate = fake.callsOf("card.update").find((u) => u.card_id === postOfRouterItem(itemOfAsk(a2).id).cardId)!;
    expect(routerUpdate.card.data).toContain("「C」");
  });

  it("两处都点时后点的那处收到“已经定过了”的 toast，账本只记一次", async () => {
    await connect();
    const askId = await askInGroupFor(lin, ["A", "B"]);
    const value = (i: number) => ({ fusa: 1, kind: "choose", card: { kind: "ask", askMessageId: askId }, optionIndex: i });
    expect(click(chatOf(lin.pmId), postOfAsk(askId).messageId, value(0)).toast?.type).toBe("success");
    const later = click(routerChat(), postOfRouterItem(itemOfAsk(askId).id).messageId, value(1));
    expect(later.toast?.content).toBe("已经定过了");
    expect(askOf(ledger.getMessage(askId)!)?.chosenOption).toBe("A");
    const wakeups = db.all("SELECT id FROM messages WHERE conversation_id = ? AND sender = 'user'", lin.conversationId);
    expect(wakeups).toHaveLength(1);
  });

  it("单聊发 /设置、/model 弹出总助设置卡并置顶；普通「设置」「模型」照常进总助；卡片切 Auto / 厂商 / 模型 / 思考程度与网页双向同步", async () => {
    await connect();
    const chat = routerChat();
    say(chat, "设置", { p2p: true });
    say(chat, "模型", { p2p: true });
    await settle();
    expect(routerCalls.map((c) => c.text)).toEqual(["设置", "模型"]);

    say(chat, "/设置", { p2p: true });
    await settle();
    const first = store().postOf({ kind: "router_settings" })!;
    expect(first.chatId).toBe(chat);
    expect(fake.callsOf("pin.create")).toContainEqual({ message_id: first.messageId });

    say(chat, "/model", { p2p: true });
    await settle();
    const fresh = store().postOf({ kind: "router_settings" })!;
    expect(fresh.messageId).not.toBe(first.messageId);
    expect(fake.callsOf("pin.delete")).toContainEqual({ message_id: first.messageId });
    expect(routerCalls.map((c) => c.text)).toEqual(["设置", "模型"]);

    const vendorAction = { fusa: 1, kind: "set_router_model", field: "vendor" };
    const modelAction = { fusa: 1, kind: "set_router_model", field: "model" };
    const effortAction = { fusa: 1, kind: "set_router_model", field: "effort" };

    expect(chooseOption(chat, first.messageId, vendorAction, "codex", OWNER).toast?.content).toContain("已换新");
    expect(chooseOption(chat, fresh.messageId, vendorAction, "codex", OWNER).toast?.type).toBe("success");
    await settle();
    expect(ledger.getRouterSettings()).toMatchObject({ vendor: "codex", model: "gpt-6-luna", effort: "low" });

    expect(chooseOption(chat, fresh.messageId, modelAction, "gpt-6.1-sol", OWNER).toast?.type).toBe("success");
    await settle();
    expect(chooseOption(chat, fresh.messageId, effortAction, "high", OWNER).toast?.type).toBe("success");
    await settle();
    expect(ledger.getRouterSettings()).toMatchObject({ vendor: "codex", model: "gpt-6.1-sol", effort: "high" });

    expect(chooseOption(chat, fresh.messageId, vendorAction, "-auto", OWNER).toast?.type).toBe("success");
    await settle();
    expect(ledger.getRouterSettings()).toMatchObject({ vendor: null, model: null, effort: null });

    ledger.updateRouterSettings({ vendor: "claude", model: "haiku", effort: "medium" });
    await settle();
    const updated = fake.callsOf("card.update").findLast((u) => u.card_id === fresh.cardId)!.card.data;
    expect(updated).toContain("haiku");
    expect(updated).toContain("medium");
  });
});

describe("createFeishuService：断线与补发", () => {
  it("重连后对一遍群成员，补发离线期间的消息，最多 FEISHU_CATCHUP_MAX_MESSAGES 条，更早的发一行提示", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    fake.handlers!.onDisconnected("网络断了");
    for (let i = 0; i < FEISHU_CATCHUP_MAX_MESSAGES + 3; i++) ev(lin.sessionId, { type: "agent.text", uuid: `off${i}`, text: `离线第${i}条`, at: Date.now() });
    await settle();
    const membersBefore = fake.callsOf("chat.members").length;
    const sentBefore = cardsSentTo(chat).length;
    fake.handlers!.onConnected();
    await settle();
    const sent = cardsSentTo(chat).slice(sentBefore);
    expect(sent.filter((c) => JSON.stringify(c).includes("离线第"))).toHaveLength(FEISHU_CATCHUP_MAX_MESSAGES);
    expect(sent.some((c) => String(c.text ?? "").includes("还有 3 条"))).toBe(true);
    say(chat, "回来了");
    await settle();
    expect(fake.callsOf("chat.members").length).toBeGreaterThan(membersBefore);
    fake.handlers!.onConnected();
    await settle();
    expect(cardsSentTo(chat).filter((c) => JSON.stringify(c).includes("离线第"))).toHaveLength(FEISHU_CATCHUP_MAX_MESSAGES);
  });

  it("重连后把离线期间在网页上回答的卡片改成已定案", async () => {
    await connect();
    const askId = await askInGroupFor(lin);
    fake.handlers!.onDisconnected("网络断了");
    ledger.answerAsk(askId, { clientId: "offline-web", choice: "要" });
    await settle();
    expect(postOfAsk(askId).state).toBe("card_pending");
    fake.handlers!.onConnected();
    await settle();
    expect(postOfAsk(askId).state).toBe("card_settled");
  });

  it("重连补齐总助简报和倒序完成的回复，定案署名保留首位点击者", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    await svc.setup.setChatPolicy({ pmId: lin.pmId, guestTier: "collaborator" });
    join_(chat);
    await settle();
    say(chat, "填充成员名称", { sender: GUEST });
    await settle();
    const askId = await askInGroupFor(lin);
    const card = { kind: "ask", askMessageId: askId };
    const first = { fusa: 1, kind: "choose", card, optionIndex: 0 };
    const groupPost = postOfAsk(askId);
    const routerPost = postOfRouterItem(itemOfAsk(askId).id);
    fake.handlers!.onDisconnected("离线");
    expect(click(chat, groupPost.messageId, first, GUEST).toast?.type).toBe("success");
    expect(click(chat, groupPost.messageId, first, GUEST).toast?.type).toBe("success");
    expect(click(routerChat(), routerPost.messageId, { ...first, optionIndex: 1 }).toast?.content).toBe("已经定过了");
    const older = ledger.createRouterCommand({ clientId: "older", inputText: "先建", vendor: "claude", status: "planning" }).command;
    const newer = ledger.createRouterCommand({ clientId: "newer", inputText: "后建", vendor: "claude", status: "planning" }).command;
    ledger.updateRouterCommand(newer.id, { status: "answered", plan: { intent: "answer", reply: "先完成", actions: [] } });
    ledger.hubCall(lin.sessionId, "router.report", { summary: "离线简报" });
    await svc.close();
    svc = makeService();
    await svc.start();
    await vi.waitFor(() => expect(svc.setup.status().state).toBe("connected"));
    await settle();
    ledger.updateRouterCommand(older.id, { status: "answered", plan: { intent: "answer", reply: "后完成", actions: [] } });
    await settle();
    fake.handlers!.onConnected();
    await settle();
    for (const text of ["先完成", "后完成"]) expect(fake.sent.filter((entry) => entry.content.includes(text))).toHaveLength(1);
    expect(fake.callsOf("card.create").filter((call) => call.data.includes("离线简报"))).toHaveLength(1);
    expect(fake.callsOf("card.update").filter((call) => call.card_id === groupPost.cardId || call.card_id === routerPost.cardId).map((call) => call.card.data))
      .toEqual([expect.stringContaining("李四 选了「要」"), expect.stringContaining("李四 选了「要」")]);
  });

  it("进出队列满载时在各自的上限内处理，账本补齐出站并对齐新项目群", { timeout: 15_000 }, async () => {
    let clock = Date.now();
    svc = makeService({ now: () => (clock += 1_001) });
    await connect();
    const chat = chatOf(lin.pmId);
    for (let i = 0; i < FEISHU_INBOUND_QUEUE_MAX + 9; i++) say(chat, `入站 ${i}`);
    expect(svc.setup.status().lastError).toContain("入站队列已满");
    await settle();
    expect(userMessages(lin.conversationId).filter((message) => message.text.startsWith("入站 "))).toHaveLength(FEISHU_INBOUND_QUEUE_MAX);
    for (let i = 0; i < FEISHU_OUTBOUND_QUEUE_MAX + 7; i++) {
      ev(lin.sessionId, { type: "agent.text", uuid: `load-${i}`, text: `出站 ${i}`, at: Date.now() });
    }
    expect(svc.setup.status().lastError).toContain("出站队列已满");
    const created = ledger.createPm({ name: "满载时创建", mode: "manage_only", persona: "" });
    await settle();
    expect(fake.chats.get(chatOf(created.pm.id))?.name).toBe("满载时创建");
    expect(fake.sent.filter((entry) => entry.chatId === chat && entry.content.includes("出站 "))).toHaveLength(FEISHU_OUTBOUND_QUEUE_MAX + 7);
  });

  it("排队超过 FEISHU_OUTBOUND_QUEUE_MAX 时先合并同一张卡的流式推送，不丢定稿和卡片", async () => {
    await connect();
    running(lin.sessionId);
    // 同一个群的流式推送在队列里只留最新一份
    for (let i = 0; i < 50; i++) ev(lin.sessionId, { type: "agent.text_delta", delta: "字", at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 200));
    ev(lin.sessionId, { type: "agent.text", uuid: "merged", text: "最终正文", at: Date.now() });
    const askId = ledger.hubCall(lin.sessionId, "ask", { text: "合并后还在吗？", options: ["在", "不在"] }).data.messageId;
    await settle();
    expect(fake.callsOf("card.element.content").length).toBeLessThan(50);
    expect(fake.callsOf("card.update").some((u) => u.card.data.includes("最终正文")) || cardsSentTo(chatOf(lin.pmId)).some((c) => JSON.stringify(c).includes("最终正文"))).toBe(true);
    expect(postOfAsk(askId)).not.toBeNull();
  });
});

describe("createFeishuService：单点失败隔离与流式保护", () => {
  /** 飞书对符合条件的请求一直回业务错误（卡片过期、已撤回、内容不合规这类，再发也一样）。 */
  const rejectWhile = (match: (method: FeishuMethod, args: Record<string, unknown>) => boolean, result: FeishuApiResult = { code: 230099, msg: "Failed to create card content, ext=ErrCode: 11310" }) => {
    const original = fake.call.bind(fake);
    fake.call = async (method, args) => {
      if (!match(method, args as unknown as Record<string, unknown>)) return original(method, args);
      fake.calls.push({ method, args: args as unknown as Record<string, unknown>, at: 0 });
      return result;
    };
  };
  const waitRetries = async () => {
    await settle();
    await new Promise((resolve) => setTimeout(resolve, FEISHU_CONTROL_RETRY_MS * 2 + 200));
    await settle();
  };
  const deliveredTo = (pmId: PmId, text: string) => fake.sent.some((s) => s.chatId === chatOf(pmId) && s.content.includes(text));

  it("飞书拒收一张卡时只放弃这一张：别的群照常收，这个群的水位推过去，不反复重试", async () => {
    await connect();
    rejectWhile((method, args) => method === "card.create" && String(args.data).includes("被拒收的提问"));
    const askId = ledger.hubCall(lin.sessionId, "ask", { text: "被拒收的提问", options: ["要", "不要"] }).data.messageId;
    await settle();
    ev(zhou.sessionId, { type: "agent.text", uuid: "zhou-ok", text: "阿周照常回复", at: Date.now() });
    ev(lin.sessionId, { type: "agent.text", uuid: "lin-after", text: "小林后面的话", at: Date.now() });
    await waitRetries();
    expect(deliveredTo(zhou.pmId, "阿周照常回复")).toBe(true);
    expect(deliveredTo(lin.pmId, "小林后面的话")).toBe(true);
    expect(store().chatOfTarget({ kind: "pm", pmId: lin.pmId })!.lastMessageId).toBeGreaterThanOrEqual(askId);
    // 项目群一次、总助单聊一次，之后不再重试
    expect(fake.callsOf("card.create").filter((c) => c.data.includes("被拒收的提问"))).toHaveLength(2);
    expect(svc.setup.status().lastError).not.toContain("ErrCode");
  });

  it("飞书不让再改的待拍板卡（过期、撤回）记成已结算，重连也不再改，不挡别的群", async () => {
    await connect();
    const askId = await askInGroupFor(lin);
    const post = postOfAsk(askId);
    rejectWhile((method, args) => method === "card.update" && args.card_id === post.cardId, { code: 200850, msg: "card is expired" });
    ledger.answerAsk(askId, { clientId: "web-late", choice: "要" });
    ev(zhou.sessionId, { type: "agent.text", uuid: "zhou-ok", text: "阿周照常回复", at: Date.now() });
    await waitRetries();
    expect(postOfAsk(askId).state).toBe("card_settled");
    expect(deliveredTo(zhou.pmId, "阿周照常回复")).toBe(true);
    fake.handlers!.onConnected();
    await settle();
    expect(fake.callsOf("card.update").filter((u) => u.card_id === post.cardId)).toHaveLength(1);
  });

  it("对齐群（建群慢）期间正在流式的回复照常推，一段回复只有一张卡", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    const original = fake.call.bind(fake);
    fake.call = async (method, args) => {
      if (method === "chat.create") await new Promise((resolve) => setTimeout(resolve, 80));
      return original(method, args);
    };
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    ev(lin.sessionId, { type: "agent.text_delta", delta: "前半截", at: Date.now() });
    await settle();
    ledger.createPm({ name: "小美", mode: "manage_only", persona: "" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    ev(lin.sessionId, { type: "agent.text_delta", delta: "中半截", at: Date.now() });
    await settle();
    ev(lin.sessionId, { type: "agent.text", uuid: "lin-1", text: "前半截中半截全文完", at: Date.now() });
    await settle();
    expect(fake.sent.filter((s) => s.chatId === chat)).toHaveLength(1);
    const updates = fake.callsOf("card.update").map((u) => cardJsonOf(u.card.data).body.elements[0]!.content);
    expect(updates).toEqual(["前半截中半截全文完"]);
  });

  it("重连补发时还在写的那一轮不收尾：流式卡留着，落库后定稿在同一张卡上", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    ev(lin.sessionId, { type: "agent.text_delta", delta: "写到一半", at: Date.now() });
    await settle();
    fake.handlers!.onDisconnected("网络抖了一下");
    fake.handlers!.onConnected();
    await settle();
    ev(lin.sessionId, { type: "agent.text", uuid: "lin-2", text: "写到一半，写完了", at: Date.now() });
    await settle();
    expect(fake.sent.filter((s) => s.chatId === chat)).toHaveLength(1);
    expect(fake.callsOf("card.update").map((u) => cardJsonOf(u.card.data).body.elements[0]!.content)).toEqual(["写到一半，写完了"]);
  });

  it("长连接断开和重连都记进日志，重连那行带断了多久", async () => {
    const lines: string[] = [];
    await svc.close();
    svc = makeService({ log: (line) => lines.push(line) });
    await connect();
    expect(lines.filter((line) => line.includes("长连接"))).toEqual([]);
    fake.handlers!.onDisconnected("长连接断了，正在重连");
    expect(lines.filter((line) => line.includes("长连接"))).toEqual(["飞书：长连接断了：长连接断了，正在重连"]);
    fake.handlers!.onConnected();
    await settle();
    expect(lines.filter((line) => line.includes("长连接"))).toHaveLength(2);
    expect(lines.at(-1)).toMatch(/^飞书：长连接已重连，断了 \d+ 秒$/);
  });

  it("重连后总助单聊最多补 FEISHU_CATCHUP_MAX_MESSAGES 条，更早的发一行提示", async () => {
    await connect();
    const chat = routerChat();
    fake.handlers!.onDisconnected("网络断了");
    for (let i = 0; i < FEISHU_CATCHUP_MAX_MESSAGES + 3; i++) ledger.hubCall(lin.sessionId, "router.report", { summary: `离线简报${i}` });
    await settle();
    fake.handlers!.onConnected();
    await settle();
    expect(fake.callsOf("card.create").filter((c) => c.data.includes("离线简报"))).toHaveLength(FEISHU_CATCHUP_MAX_MESSAGES);
    expect(fake.sent.some((s) => s.chatId === chat && s.content.includes("还有 3 条"))).toBe(true);
    fake.handlers!.onConnected();
    await settle();
    expect(fake.callsOf("card.create").filter((c) => c.data.includes("离线简报"))).toHaveLength(FEISHU_CATCHUP_MAX_MESSAGES);
  });

  it("凭证验不过、扫码失败时给人看的话不带飞书或网络的原文", async () => {
    fake.failNext["bot.info"] = { code: 1663, msg: "raw english detail from open platform" };
    const error = await svc.setup.saveCredentials({ brand: "feishu", appId: "cli_manual", appSecret: "secret" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FeishuSetupError);
    expect((error as Error).message).not.toContain("raw english");
    await svc.close();
    svc = makeService({ register: async () => { throw new Error("socket hang up 10.0.0.1:443"); } });
    await svc.start();
    await svc.setup.startRegistration();
    await vi.waitFor(() => expect(svc.setup.status().lastError).not.toBeNull());
    expect(svc.setup.status().lastError).not.toContain("socket");
  });
});

describe("createFeishuService：本机图片、定稿拒收与停机重启收口", () => {
  const delta = (sessionId: SessionId, text: string) => ev(sessionId, { type: "agent.text_delta", delta: text, at: Date.now() });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** 照飞书的规矩：卡片 Markdown 里 ![](...) 的地址不是 img_ 开头的图片编号就回 200570。 */
  const rejectNonImageKeys = () => {
    const original = fake.call.bind(fake);
    fake.call = async (method, args) => {
      if (/!\[[^\]]*\]\((?!img_)[^)]+\)/.test(JSON.stringify(args))) {
        fake.calls.push({ method, args: args as unknown as Record<string, unknown>, at: 0 });
        return { code: 200570, msg: "ErrMsg: card contains invalid image keys; ErrorValue: image key /tmp/reverify/01.png;" };
      }
      return original(method, args);
    };
  };
  const rejected = () => fake.calls.filter((c) => JSON.stringify(c.args).includes("](/tmp")).length;
  const lastUpdateOf = (cardId?: string) => fake.callsOf("card.update").filter((u) => cardId === undefined || u.card_id === cardId).at(-1)!;
  const latestAgentText = (conversationId: ConversationId) =>
    db.get<{ id: number }>("SELECT max(id) AS id FROM messages WHERE conversation_id = ? AND sender = 'agent' AND kind = 'text'", conversationId)!.id;

  it("回复里带本机图片和本机文件链接时，流式推送和定稿都不被飞书拒收，卡片定稿成账本正文", async () => {
    await connect();
    rejectNonImageKeys();
    const body = "复验做完了。\n\n![总助截图](/tmp/reverify/01.png)\n\n- [复验报告](/tmp/reverify/report.md)";
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    delta(lin.sessionId, "复验做完了。\n\n");
    await settle();
    await wait(FEISHU_STREAM_FLUSH_MS + 50);
    delta(lin.sessionId, "![总助截图](/tmp/reverify/01.png)\n\n- [复验报告](/tmp/reverify/report.md)");
    await wait(FEISHU_STREAM_FLUSH_MS * 2);
    await settle();
    ev(lin.sessionId, { type: "agent.text", uuid: "local-image", text: body, at: Date.now() });
    await settle();
    expect(rejected()).toBe(0);
    expect(svc.setup.status().lastError).toBeNull();
    const final = lastUpdateOf();
    expect(cardJsonOf(final.card.data).config.streaming_mode).toBe(false);
    expect(buttonValues(final.card.data)).toEqual([]);
    expect(final.card.data).toContain("总助截图");
    expect(final.card.data).toContain("复验报告");
    expect(store().postOf({ kind: "message", messageId: latestAgentText(lin.conversationId), part: 0 })?.state).toBe("final");
  });

  it("定稿正文被飞书拒收时换成一行说明再收尾：卡片不停在流式，不留停止按钮", async () => {
    await connect();
    const original = fake.call.bind(fake);
    fake.call = async (method, args) => {
      if (method === "card.update" && JSON.stringify(args).includes("飞书不收的正文")) {
        fake.calls.push({ method, args: args as unknown as Record<string, unknown>, at: 0 });
        return { code: 230099, msg: "Failed to create card content" };
      }
      return original(method, args);
    };
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    delta(lin.sessionId, "写到一半");
    await settle();
    ev(lin.sessionId, { type: "agent.text", uuid: "rejected-final", text: "飞书不收的正文", at: Date.now() });
    await settle();
    const last = lastUpdateOf();
    expect(last.card.data).not.toContain("飞书不收的正文");
    expect(last.card.data).toContain("去网页看");
    expect(cardJsonOf(last.card.data).config.streaming_mode).toBe(false);
    expect(buttonValues(last.card.data)).toEqual([]);
    expect(store().postOf({ kind: "message", messageId: latestAgentText(lin.conversationId), part: 0 })?.state).toBe("final");
  });

  it("重启后收掉上一个进程没定稿的流式卡：关流式、去停止按钮、补齐账本里的完整回复，水位已推过也照收", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    await svc.close();
    ev(lin.sessionId, { type: "agent.text", uuid: "left-over", text: "上一个进程的完整回复\n\n![截图](/tmp/reverify/01.png)", at: Date.now() });
    const messageId = latestAgentText(lin.conversationId);
    const cardId = "card_left" as FeishuCardId;
    store().savePost({ ref: { kind: "message", messageId, part: 0 }, chatId: chat, messageId: "om_left" as FeishuMessageId, cardId, sequence: 17, state: "streaming" }, Date.now());
    store().advanceWatermark(chat, { messageId }, Date.now());
    rejectNonImageKeys();
    svc = makeService();
    await svc.start();
    await vi.waitFor(() => expect(svc.setup.status().state).toBe("connected"));
    await settle();
    const last = lastUpdateOf(cardId);
    expect(last.sequence).toBeGreaterThan(17);
    expect(cardJsonOf(last.card.data).config.streaming_mode).toBe(false);
    expect(buttonValues(last.card.data)).toEqual([]);
    expect(last.card.data).toContain("上一个进程的完整回复");
    expect(store().postOf({ kind: "message", messageId, part: 0 })?.state).toBe("final");
    fake.handlers!.onDisconnected("网络抖了一下");
    fake.handlers!.onConnected();
    await settle();
    expect(fake.callsOf("card.update").filter((u) => u.card_id === cardId)).toHaveLength(1);
  });

  it("停机时先排空在途的定稿，再把还在流式的卡收尾，之后才断开", async () => {
    await connect();
    const original = fake.call.bind(fake);
    fake.call = async (method, args) => {
      if (method === "card.update") await wait(30);
      return original(method, args);
    };
    running(lin.sessionId);
    running(zhou.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    ev(zhou.sessionId, { type: "turn.started", at: Date.now() });
    delta(lin.sessionId, "小林写到一半");
    delta(zhou.sessionId, "阿周写到一半");
    await settle();
    expect(cardIdsCreated()).toHaveLength(2);
    ev(lin.sessionId, { type: "agent.text", uuid: "before-close", text: "小林停机前写完的回复", at: Date.now() });
    await svc.close();
    const updates = fake.callsOf("card.update").map((u) => u.card.data);
    const linFinal = updates.find((d) => d.includes("小林停机前写完的回复"));
    const zhouClosed = updates.find((d) => d.includes("阿周写到一半"));
    for (const data of [linFinal, zhouClosed]) {
      expect(data).toBeDefined();
      expect(cardJsonOf(data!).config.streaming_mode).toBe(false);
      expect(buttonValues(data!)).toEqual([]);
    }
    expect(store().postOf({ kind: "message", messageId: latestAgentText(lin.conversationId), part: 0 })?.state).toBe("final");
  });
});

describe("createFeishuService：开轮即时反馈、关卡同步与附件分流", () => {
  const delta = (sessionId: SessionId, text: string) => ev(sessionId, { type: "agent.text_delta", delta: text, at: Date.now() });
  const tool = (sessionId: SessionId, name: string, input: unknown = {}) =>
    ev(sessionId, { type: "agent.tool", uuid: `t-${++seq}`, toolUseId: `tu-${seq}`, name, input, at: Date.now() });
  const outDir = () => {
    const home = join(root, "out");
    mkdirSync(home, { recursive: true });
    return home;
  };

  it("用户发消息后项目经理开轮调工具、还没出正文时，群里立即有一张流式状态卡（带停止按钮）；正文到了在同一张卡上定稿，一轮只占一张卡", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    say(chat, "帮我看一下");
    await settle();
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    tool(lin.sessionId, "Bash", { command: "ls" });
    await settle();
    const created = cardIdsCreated();
    expect(created).toHaveLength(1);
    expect(cardJsonOf(created[0]!.data).config.streaming_mode).toBe(true);
    expect(buttonValues(created[0]!.data)).toEqual([{ kind: "stop", conversationId: lin.conversationId }]);
    expect(created[0]!.data).toMatch(/…/);
    ev(lin.sessionId, { type: "agent.text", uuid: "after-tools", text: "查完了：一切正常。", at: Date.now() });
    ev(lin.sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 1, at: Date.now() });
    await settle();
    expect(cardIdsCreated()).toHaveLength(1);
    expect(fake.sent.filter((s) => s.chatId === chat)).toHaveLength(1);
    const final = fake.callsOf("card.update").at(-1)!;
    expect(final.card.data).toContain("查完了：一切正常。");
    expect(cardJsonOf(final.card.data).config.streaming_mode).toBe(false);
    expect(buttonValues(final.card.data)).toEqual([]);
    expect(fake.callsOf("message.delete")).toHaveLength(0);
  });

  it("工具阶段点停止能停下这一轮；整轮没有正文时撤回状态卡，不留残卡", async () => {
    await connect();
    const stops: ConversationId[] = [];
    ledger.onStopRequested((e) => stops.push(e.conversationId));
    say(chatOf(lin.pmId), "跑一下");
    await settle();
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    tool(lin.sessionId, "Bash", { command: "sleep 60" });
    await settle();
    const statusCard = fake.sent.at(-1)!;
    expect(click(chatOf(lin.pmId), statusCard.messageId, { fusa: 1, kind: "stop", conversationId: lin.conversationId }).toast?.content).toBe("正在停");
    expect(stops).toEqual([lin.conversationId]);
    ev(lin.sessionId, { type: "turn.ended", ok: false, interrupted: true, messageIds: [], durationMs: 1, at: Date.now() });
    await settle();
    expect(fake.callsOf("message.delete")).toEqual([{ message_id: statusCard.messageId }]);
  });

  it("撤回被飞书拒绝（超过撤回时限）时把状态卡收成一行说明：关流式、去停止按钮", async () => {
    await connect();
    say(chatOf(lin.pmId), "跑一下");
    await settle();
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    await settle();
    fake.failNext["message.delete"] = { code: 230009, msg: "Message has expired when recall message.", httpStatus: 400 };
    ev(lin.sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 1, at: Date.now() });
    await settle();
    const last = fake.callsOf("card.update").at(-1)!;
    expect(cardJsonOf(last.card.data).config.streaming_mode).toBe(false);
    expect(buttonValues(last.card.data)).toEqual([]);
    expect(last.card.data).not.toMatch(/Working/);
  });

  it("hub ask close 关掉的卡，项目群和总助单聊两处都立即改成已关闭、去掉按钮", async () => {
    await connect();
    const askId = await askInGroupFor(lin, ["A", "B"]);
    const itemId = itemOfAsk(askId).id;
    ledger.hubCall(lin.sessionId, "ask.close", { itemId } as never);
    await settle();
    for (const post of [postOfAsk(askId), postOfRouterItem(itemId)]) {
      expect(post.state).toBe("card_settled");
      const update = fake.callsOf("card.update").filter((u) => u.card_id === post.cardId).at(-1)!;
      expect(buttonValues(update.card.data)).toEqual([]);
    }
  });

  it("交付文件上传又慢又失败时，关卡、后续流式回复照常即时发出，不被上传挡住", async () => {
    await svc.close();
    svc = makeService({ attachWaitMs: 50 });
    await connect();
    const home = outDir();
    writeFileSync(join(home, "big.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fake.beforeUpload = () => gate;
    const askId = ledger.hubCall(lin.sessionId, "ask", { text: "看看这张大图", options: ["通过", "打回"], files: [{ label: "大图", path: join(home, "big.png") }] }).data.messageId;
    await new Promise((resolve) => setTimeout(resolve, 20));
    ledger.hubCall(lin.sessionId, "ask.close", { itemId: itemOfAsk(askId).id } as never);
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    delta(lin.sessionId, "上传没完也照样说话");
    ev(lin.sessionId, { type: "agent.text", uuid: "while-uploading", text: "上传没完也照样说话。", at: Date.now() });
    await vi.waitFor(() => {
      expect(postOfAsk(askId).state).toBe("card_settled");
      expect(fake.callsOf("card.update").some((u) => u.card.data.includes("上传没完也照样说话。"))).toBe(true);
    });
    expect(fake.calls.some((c) => c.method === "uploadImage" && c.args.imageType === "message")).toBe(true);
    expect(fake.callsOf("message.create").some((c) => c.msg_type === "image")).toBe(false);
    release();
    await vi.waitFor(() => expect(fake.callsOf("card.update").some((u) => u.card_id === postOfAsk(askId).cardId && imgKeysOf(u.card.data).length === 1)).toBe(true));
    expect(fake.callsOf("message.create").some((c) => c.msg_type === "image")).toBe(false);
  });

  it("交付文件上传暂时失败时自己重试，不挡文字，最后发出去", async () => {
    await svc.close();
    svc = makeService({ attachWaitMs: 50 });
    await connect();
    const home = outDir();
    writeFileSync(join(home, "shot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    let failures = 2;
    fake.beforeUpload = async () => {
      if (failures-- > 0) throw new Error("socket hang up");
    };
    ev(lin.sessionId, { type: "agent.text", uuid: "flaky", text: `截图 [图](${join(home, "shot.png")})`, at: Date.now() });
    ev(lin.sessionId, { type: "agent.text", uuid: "after-flaky", text: "后面这句不用等", at: Date.now() });
    await settle();
    expect(cardsSentTo(chatOf(lin.pmId)).some((c) => JSON.stringify(c).includes("后面这句不用等"))).toBe(true);
    await vi.waitFor(() => expect(fake.callsOf("card.update").some((u) => imgKeysOf(u.card.data).length === 1)).toBe(true), { timeout: FEISHU_CONTROL_RETRY_MS * 8 });
    expect(fake.callsOf("message.create").filter((c) => c.msg_type === "image")).toHaveLength(0);
  });

  it("mp4、pdf、md 附件都能发出：mp4 发成视频消息，不报 230055", async () => {
    await connect();
    const home = outDir();
    for (const name of ["demo.mp4", "report.pdf", "notes.md"]) writeFileSync(join(home, name), "x");
    const text = ["demo.mp4", "report.pdf", "notes.md"].map((n) => `[${n}](${join(home, n)})`).join(" ");
    ev(lin.sessionId, { type: "agent.text", uuid: "media", text, at: Date.now() });
    await settle();
    await vi.waitFor(() => expect(store().postOf({ kind: "file", messageId: db.get<{ id: number }>("SELECT max(id) AS id FROM messages WHERE sender = 'agent'")!.id, part: 2 })).not.toBeNull());
    const sends = fake.callsOf("message.create").filter((c) => c.receive_id === chatOf(lin.pmId) && c.msg_type !== "interactive");
    expect(sends.map((c) => c.msg_type).sort()).toEqual(["file", "file", "media"]);
    expect(svc.setup.status().lastError).toBeNull();
  });
});

describe("createFeishuService：图文同发、超大图瘦身、重启补传与后台轮次", () => {
  const tool = (sessionId: SessionId, name: string, input: unknown = {}) =>
    ev(sessionId, { type: "agent.tool", uuid: `t-${++seq}`, toolUseId: `tu-${seq}`, name, input, at: Date.now() });
  const outDir = () => {
    const home = join(root, "out");
    mkdirSync(home, { recursive: true });
    return home;
  };
  const png = () => Buffer.from("89504e470d0a1a0a", "hex");
  const latestAgentText = (conversationId: ConversationId) =>
    db.get<{ id: number }>("SELECT max(id) AS id FROM messages WHERE conversation_id = ? AND sender = 'agent' AND kind = 'text'", conversationId)!.id;
  /** 群里每条消息按发出先后：卡片记 card、别的记 msg_type。 */
  const timeline = (chatId: string) =>
    fake.callsOf("message.create").filter((c) => c.receive_id === chatId).map((c) => c.msg_type);
  const allCardData = () => [...fake.cards.values(), ...fake.callsOf("card.update").map((u) => u.card.data)];

  it("回复里的图片随定稿嵌进同一张卡（img 元素），不再单发图片消息；pdf、md、mp4、zip 紧跟在这张卡后面连着发出", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    const home = outDir();
    writeFileSync(join(home, "a.png"), png());
    writeFileSync(join(home, "b.png"), png());
    for (const name of ["report.pdf", "notes.md", "demo.mp4", "bundle.zip"]) writeFileSync(join(home, name), "x");
    const links = ["a.png", "b.png", "report.pdf", "notes.md", "demo.mp4", "bundle.zip"].map((n) => `[${n}](${join(home, n)})`).join("\n");
    ev(lin.sessionId, { type: "agent.text", uuid: "together", text: `做好了，图和文件都在：\n${links}`, at: Date.now() });
    await settle();
    const sent = timeline(chat);
    expect(sent).toEqual(["interactive", "file", "file", "media", "file"]);
    const card = [...fake.cards.values()].find((d) => d.includes("做好了"))!;
    expect(imgKeysOf(card)).toHaveLength(2);
    expect(card).not.toContain("Uploading");
    expect(svc.setup.status().lastError).toBeNull();
  });

  it("提问卡带的图片也嵌进同一张卡、和按钮在一起；点了定案后图片还在", async () => {
    await connect();
    const home = outDir();
    writeFileSync(join(home, "shot.png"), png());
    const askId = ledger.hubCall(lin.sessionId, "ask", { text: "这样改行吗", options: ["行", "不行"], files: [{ label: "截图", path: join(home, "shot.png") }] }).data.messageId;
    await settle();
    const post = postOfAsk(askId);
    const created = fake.cards.get(post.cardId!)!;
    expect(imgKeysOf(created)).toHaveLength(1);
    expect(buttonValues(created).length).toBeGreaterThan(0);
    expect(fake.callsOf("message.create").some((c) => c.msg_type === "image")).toBe(false);
    click(chatOf(lin.pmId), post.messageId, { fusa: 1, kind: "choose", card: { kind: "ask", askMessageId: askId }, optionIndex: 0 });
    await settle();
    const settled = fake.callsOf("card.update").filter((u) => u.card_id === post.cardId).at(-1)!;
    expect(buttonValues(settled.card.data)).toEqual([]);
    expect(imgKeysOf(settled.card.data)).toEqual(imgKeysOf(created));
  });

  it("图和文件超过等待窗口还没传完：卡先发出（写着 Uploading），不挡后面的新消息；传完后图原地嵌回原卡、文件补发并在原卡标注已送达", async () => {
    await svc.close();
    svc = makeService({ attachWaitMs: 50 });
    await connect();
    const chat = chatOf(lin.pmId);
    const home = outDir();
    writeFileSync(join(home, "slow.png"), png());
    writeFileSync(join(home, "big.zip"), "x");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fake.beforeUpload = () => gate;
    ev(lin.sessionId, { type: "agent.text", uuid: "slow", text: `传大文件 [图](${join(home, "slow.png")}) [包](${join(home, "big.zip")})`, at: Date.now() });
    ev(lin.sessionId, { type: "agent.text", uuid: "next", text: "下一句不等上传", at: Date.now() });
    await vi.waitFor(() => expect(cardsSentTo(chat).some((c) => JSON.stringify(c).includes("下一句不等上传"))).toBe(true));
    const host = store().postOf({ kind: "message", messageId: latestAgentText(lin.conversationId) - 1, part: 0 })!;
    expect(host.cardId).not.toBeNull();
    const first = fake.cards.get(host.cardId!)!;
    expect(first).toContain("Uploading slow.png");
    expect(first).toContain("Uploading big.zip");
    expect(imgKeysOf(first)).toEqual([]);
    expect(store().postOf({ kind: "file", messageId: host.ref.kind === "message" ? host.ref.messageId : 0, part: 1 })?.state).toBe("uploading");
    release();
    await vi.waitFor(() => {
      const last = fake.callsOf("card.update").filter((u) => u.card_id === host.cardId).at(-1);
      expect(last).toBeDefined();
      expect(imgKeysOf(last!.card.data)).toHaveLength(1);
      expect(last!.card.data).toContain("已送达");
      expect(last!.card.data).not.toContain("Uploading");
    });
    expect(timeline(chat).filter((t) => t === "file")).toHaveLength(1);
  });

  it("在途附件记在 feishu_posts（uploading）：守护进程重启后自动补传，传完补发文件并改原卡", async () => {
    await svc.close();
    svc = makeService({ attachWaitMs: 50 });
    await connect();
    const chat = chatOf(lin.pmId);
    const home = outDir();
    writeFileSync(join(home, "huge.mp4"), "x");
    fake.beforeUpload = () => new Promise<void>(() => {});
    ev(lin.sessionId, { type: "agent.text", uuid: "restart", text: `视频 [demo](${join(home, "huge.mp4")})`, at: Date.now() });
    const messageId = latestAgentText(lin.conversationId);
    await vi.waitFor(() => expect(store().postOf({ kind: "file", messageId, part: 0 })?.state).toBe("uploading"));
    await svc.close();
    const host = store().postOf({ kind: "message", messageId, part: 0 })!;
    fake.beforeUpload = null;
    svc = makeService({ attachWaitMs: 50 });
    await svc.start();
    await vi.waitFor(() => expect(svc.setup.status().state).toBe("connected"));
    await settle();
    expect(store().postOf({ kind: "file", messageId, part: 0 })?.state).toBe("final");
    expect(timeline(chat).filter((t) => t === "media")).toHaveLength(1);
    const last = fake.callsOf("card.update").filter((u) => u.card_id === host.cardId).at(-1)!;
    expect(last.card.data).toContain("已送达");
    expect(last.card.data).not.toContain("Uploading");
  });

  it("超过 2400px 或 2 MB 的截图上传前缩到最长边 2400，磁盘上的原图不动；别的文件原样上传", async () => {
    const sharp = (await import("sharp")).default;
    await connect();
    const home = outDir();
    const tall = join(home, "tall.png");
    await sharp({ create: { width: 600, height: 4800, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toFile(tall);
    const before = readFileSync(tall);
    writeFileSync(join(home, "notes.md"), "# 笔记");
    const seen: { path: string; width: number; height: number }[] = [];
    fake.beforeUpload = async (input) => {
      if (!("imageType" in input) || !("path" in input)) return;
      const meta = await sharp(input.path).metadata();
      seen.push({ path: input.path, width: meta.width ?? 0, height: meta.height ?? 0 });
    };
    ev(lin.sessionId, { type: "agent.text", uuid: "tall", text: `长截图 [图](${tall}) [笔记](${join(home, "notes.md")})`, at: Date.now() });
    await settle();
    expect(seen).toHaveLength(1);
    expect(Math.max(seen[0]!.width, seen[0]!.height)).toBeLessThanOrEqual(2400);
    expect(Math.max(seen[0]!.width, seen[0]!.height)).toBeGreaterThan(2000);
    expect(readFileSync(tall).equals(before)).toBe(true);
    const md = fake.calls.find((c) => c.method === "uploadFile")!;
    expect(String(md.args.path)).toMatch(/notes\.md$/);
    expect(existsSync(seen[0]!.path) && seen[0]!.path !== tall).toBe(false);
  });

  it("网页上发的带图和文件的用户消息镜像到群里：图嵌在同一张卡，文件紧跟着发", async () => {
    const { saveUpload } = await import("../uploads.ts");
    await connect();
    const chat = chatOf(lin.pmId);
    const photo = await saveUpload(join(dataHome, "uploads"), "photo.png", png());
    const doc = await saveUpload(join(dataHome, "uploads"), "spec.pdf", Buffer.from("%PDF"));
    ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "web-files", text: "看这两个", attachments: [photo, doc] });
    await settle();
    expect(timeline(chat)).toEqual(["interactive", "file"]);
    const mirrored = fake.cards.get([...fake.cards.keys()].find((id) => fake.cards.get(id)!.includes("看这两个"))!)!;
    expect(mirrored).toContain("网页上说");
    expect(imgKeysOf(mirrored)).toHaveLength(1);
  });

  it("飞书里发的富文本（文字 + 多张图 + 视频）完整收成附件，正文里不留占位", async () => {
    await connect();
    fake.resources.set("img_a", png());
    fake.resources.set("img_b", png());
    fake.resources.set("file_v", Buffer.from("mp4"));
    say(chatOf(lin.pmId), '看这两张\n![image](img_a) ![image](img_b)\n<video key="file_v" name="demo.mp4"/>', {
      files: [
        { type: "image", fileKey: "img_a", fileName: null },
        { type: "image", fileKey: "img_b", fileName: null },
        { type: "video", fileKey: "file_v", fileName: "demo.mp4" },
      ],
    });
    await settle();
    const message = userMessages(lin.conversationId).at(-1)!;
    expect(message.text).toBe("看这两张");
    expect((message.meta?.attachments as { name: string }[]).map((a) => a.name)).toEqual([expect.stringMatching(/\.png$/), expect.stringMatching(/\.png$/), "demo.mp4"]);
  });

  it("后台轮次（Worker 汇报、系统唤醒）调工具时不建状态卡，整轮没正文也不撤回任何消息；用户发话的那一轮照常立即有状态卡", async () => {
    await connect();
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    tool(lin.sessionId, "Bash", { command: "hub status" });
    await settle();
    ev(lin.sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 1, at: Date.now() });
    await settle();
    expect(cardIdsCreated()).toHaveLength(0);
    expect(fake.callsOf("message.delete")).toHaveLength(0);
    say(chatOf(lin.pmId), "进展怎么样");
    await settle();
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    tool(lin.sessionId, "Bash", { command: "hub status" });
    await settle();
    expect(cardIdsCreated()).toHaveLength(1);
    expect(buttonValues(cardIdsCreated()[0]!.data)).toEqual([{ kind: "stop", conversationId: lin.conversationId }]);
  });
});

describe("createFeishuService：附件改卡失败重刷、内部唤醒不当用户发话、空入站不投递", () => {
  const tool = (sessionId: SessionId, name: string, input: unknown = {}) =>
    ev(sessionId, { type: "agent.tool", uuid: `t-${++seq}`, toolUseId: `tu-${seq}`, name, input, at: Date.now() });
  const outDir = () => {
    const home = join(root, "out");
    mkdirSync(home, { recursive: true });
    return home;
  };
  const png = () => Buffer.from("89504e470d0a1a0a", "hex");
  const latestAgentText = (conversationId: ConversationId) =>
    db.get<{ id: number }>("SELECT max(id) AS id FROM messages WHERE conversation_id = ? AND sender = 'agent' AND kind = 'text'", conversationId)!.id;
  const updatesOf = (cardId: string | null) => fake.callsOf("card.update").filter((u) => u.card_id === cardId);
  const textsTo = (chatId: string) =>
    fake.callsOf("message.create").filter((c) => c.receive_id === chatId && c.msg_type === "text").map((c) => (JSON.parse(c.content) as { text: string }).text);
  const slowUploads = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fake.beforeUpload = () => gate;
    return () => release();
  };

  it("慢传的图传完、改原卡时网络闪断：之后补发重刷原卡，图嵌回去、Uploading 去掉", async () => {
    await svc.close();
    svc = makeService({ attachWaitMs: 40 });
    await connect();
    writeFileSync(join(outDir(), "slow.png"), png());
    const release = slowUploads();
    ev(lin.sessionId, { type: "agent.text", uuid: "slow-img", text: `截图 [图](${join(root, "out", "slow.png")})`, at: Date.now() });
    const messageId = latestAgentText(lin.conversationId);
    await vi.waitFor(() => expect(store().postOf({ kind: "file", messageId, part: 0 })?.state).toBe("uploading"));
    const host = store().postOf({ kind: "message", messageId, part: 0 })!;
    expect(fake.cards.get(host.cardId!)).toContain("Uploading slow.png");
    fake.failNext["card.update"] = new Error("read ECONNRESET");
    release();
    await vi.waitFor(() => {
      const updates = updatesOf(host.cardId);
      expect(updates.length).toBeGreaterThanOrEqual(2);
      expect(imgKeysOf(updates.at(-1)!.card.data)).toHaveLength(1);
      expect(updates.at(-1)!.card.data).not.toContain("Uploading");
    }, { timeout: FEISHU_CONTROL_RETRY_MS * 4 });
    expect(store().postOf({ kind: "file", messageId, part: 0 })?.state).toBe("final");
  });

  it("慢传的文件已补发、原卡还没改成就停机：重启后重刷原卡标已送达，文件消息不重发", async () => {
    await svc.close();
    svc = makeService({ attachWaitMs: 40 });
    await connect();
    const chat = chatOf(lin.pmId);
    writeFileSync(join(outDir(), "big.zip"), "x");
    const release = slowUploads();
    ev(lin.sessionId, { type: "agent.text", uuid: "slow-zip", text: `打包好了 [包](${join(root, "out", "big.zip")})`, at: Date.now() });
    const messageId = latestAgentText(lin.conversationId);
    await vi.waitFor(() => expect(store().postOf({ kind: "file", messageId, part: 0 })?.state).toBe("uploading"));
    const host = store().postOf({ kind: "message", messageId, part: 0 })!;
    fake.failNext["card.update"] = new Error("read ECONNRESET");
    release();
    await vi.waitFor(() => expect(updatesOf(host.cardId)).toHaveLength(1));
    await svc.close();
    fake.beforeUpload = null;
    svc = makeService({ attachWaitMs: 40 });
    await svc.start();
    await vi.waitFor(() => expect(svc.setup.status().state).toBe("connected"));
    await settle();
    const sentFiles = fake.callsOf("message.create").filter((c) => c.receive_id === chat && c.msg_type === "file");
    expect(sentFiles).toHaveLength(1);
    expect(updatesOf(host.cardId).length).toBeGreaterThanOrEqual(2);
    expect(updatesOf(host.cardId).at(-1)!.card.data).toContain("已送达");
    expect(updatesOf(host.cardId).at(-1)!.card.data).not.toContain("Uploading");
    expect(store().postOf({ kind: "file", messageId, part: 0 })?.state).toBe("final");
  });

  it("拍板定案唤醒项目经理的那一轮：群里不出「网页上说」，不建状态卡，整轮没正文也不撤回", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    const askId = await askInGroupFor(lin, ["A", "B"]);
    expect(click(chat, postOfAsk(askId).messageId, { fusa: 1, kind: "choose", card: { kind: "ask", askMessageId: askId }, optionIndex: 0 }).toast?.type).toBe("success");
    await settle();
    expect(userMessages(lin.conversationId)).toHaveLength(1);
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    tool(lin.sessionId, "Bash", { command: "hub worker start" });
    await settle();
    ev(lin.sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 1, at: Date.now() });
    await settle();
    const everything = [...fake.sent.map((s) => s.content), ...fake.cards.values()].join("\n");
    expect(everything).not.toContain("网页上说");
    expect(streamCardMessage(chat)).toBeUndefined();
    expect(fake.callsOf("message.delete")).toHaveLength(0);
  });

  it("项目群里单发超过上限的视频：回一句没收下，不往项目经理投空消息；带字的照常投递并提示文件没收下", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    fake.resources.set("v_big", Buffer.alloc(MAX_UPLOAD_BYTES + 1));
    say(chat, '<video key="v_big" name="huge.mp4"/>', { files: [{ type: "video", fileKey: "v_big", fileName: "huge.mp4" }] });
    await settle();
    expect(userMessages(lin.conversationId)).toEqual([]);
    expect(textsTo(chat).some((t) => t.includes("huge.mp4"))).toBe(true);
    const missed = textsTo(chat).find((t) => t.includes("huge.mp4"))!;
    expect(missed).toContain("超过 100 MB 或下载失败");
    expect(missed).toContain("压小一点重发试试");
    expect(missed).not.toContain("网页");
    say(chat, '看这个 <video key="v_big" name="again.mp4"/>', { files: [{ type: "video", fileKey: "v_big", fileName: "again.mp4" }] });
    await settle();
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["看这个"]);
    expect(textsTo(chat).some((t) => t.includes("again.mp4"))).toBe(true);
  });

  it("总助单聊里单发下载失败的文件：回一句没收下，不交给总助，不抛错", async () => {
    await connect();
    say(routerChat(), '<file key="file_missing" name="lost.pdf"/>', { p2p: true, files: [{ type: "file", fileKey: "file_missing", fileName: "lost.pdf" }] });
    await settle();
    expect(routerCalls).toEqual([]);
    expect(textsTo(routerChat()).some((t) => t.includes("lost.pdf"))).toBe(true);
  });

  it("chat_only 档访客 @机器人 单发图片：图不收，回他一句，不往项目经理投空消息", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    join_(chat);
    await settle();
    fake.resources.set("img_g", png());
    say(chat, "![image](img_g)", { sender: GUEST, mention: true, files: [{ type: "image", fileKey: "img_g", fileName: null }] });
    await settle();
    expect(userMessages(lin.conversationId)).toEqual([]);
    expect(fake.calls.some((c) => c.method === "downloadResource")).toBe(false);
    expect(textsTo(chat).some((t) => t.includes(GUEST))).toBe(true);
  });

  it("非流式回复只带普通文件、文件消息被飞书拒收：原卡改成写着没发出去", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    writeFileSync(join(outDir(), "report.pdf"), "%PDF");
    const original = fake.call.bind(fake);
    fake.call = async (method, args) => {
      if (method === "message.create" && (args as { msg_type?: string }).msg_type === "file") {
        fake.calls.push({ method, args: args as unknown as Record<string, unknown>, at: 0 });
        return { code: 230028, msg: "The messages do NOT pass the audit.", httpStatus: 400 };
      }
      return original(method, args);
    };
    ev(lin.sessionId, { type: "agent.text", uuid: "pdf-only", text: `报告 [r](${join(root, "out", "report.pdf")})`, at: Date.now() });
    await settle();
    const messageId = latestAgentText(lin.conversationId);
    const host = store().postOf({ kind: "message", messageId, part: 0 })!;
    expect(host.chatId).toBe(chat);
    expect(host.cardId).not.toBeNull();
    expect(updatesOf(host.cardId).at(-1)?.card.data).toContain("「report.pdf」没发出去");
  });

  it("多附件里前一个文件的副本没了：后面附件的编号不变，照样传完、补发", async () => {
    const { resolveUpload } = await import("../uploads.ts");
    const { sentFilesOf } = await import("../../shared/sent-files.ts");
    await svc.close();
    svc = makeService({ attachWaitMs: 40 });
    await connect();
    const chat = chatOf(lin.pmId);
    const home = outDir();
    writeFileSync(join(home, "first.zip"), "1");
    writeFileSync(join(home, "second.zip"), "2");
    const release = slowUploads();
    ev(lin.sessionId, { type: "agent.text", uuid: "two-files", text: `两个包 [1](${join(home, "first.zip")}) [2](${join(home, "second.zip")})`, at: Date.now() });
    const messageId = latestAgentText(lin.conversationId);
    await vi.waitFor(() => expect(store().postOf({ kind: "file", messageId, part: 1 })?.state).toBe("uploading"));
    const firstCopy = resolveUpload(join(dataHome, "sent-files"), sentFilesOf(ledger.getMessage(messageId)!)[0]!.id!)!;
    rmSync(firstCopy.path);
    release();
    await vi.waitFor(() => expect(store().postOf({ kind: "file", messageId, part: 1 })?.state).toBe("final"));
    expect(store().postOf({ kind: "file", messageId, part: 1 })?.mediaKey).not.toBeNull();
    expect(fake.callsOf("message.create").filter((c) => c.receive_id === chat && c.msg_type === "file").length).toBeGreaterThanOrEqual(1);
  });
});

describe("createFeishuService：多人群里前面气泡的文件随 @机器人 交出（「怡然」群）", () => {
  const png = () => Buffer.from("89504e470d0a1a0a", "hex");
  const textsTo = (chatId: string) =>
    fake.callsOf("message.create").filter((c) => c.receive_id === chatId && c.msg_type === "text").map((c) => (JSON.parse(c.content) as { text: string }).text);
  const downloads = () => fake.calls.filter((c) => c.method === "downloadResource").map((c) => c.args as { messageId: string; fileKey: string });
  const attachmentNames = (m: Message | undefined) => ((m?.meta?.attachments ?? []) as { name: string }[]).map((a) => a.name);
  async function mentionOnlyGroupWithGuest() {
    await connect();
    const chat = chatOf(lin.pmId);
    await svc.setup.setChatPolicy({ pmId: lin.pmId, triggerMode: "mention_only" });
    join_(chat, GUEST, "yee");
    await settle();
    return chat;
  }

  it("主人先单发图片和文件（气泡里带不了 @），下一个气泡 @机器人：前面的图和文件下载成附件随这条交给项目经理，之后清空", async () => {
    const chat = await mentionOnlyGroupWithGuest();
    fake.resources.set("img_p", png());
    fake.resources.set("file_p", Buffer.from("%PDF"));
    const imageBubble = say(chat, "![image](img_p)", { files: [{ type: "image", fileKey: "img_p", fileName: null }] });
    const fileBubble = say(chat, '<file key="file_p" name="brief.pdf"/>', { files: [{ type: "file", fileKey: "file_p", fileName: "brief.pdf" }] });
    await settle();
    expect(userMessages(lin.conversationId)).toEqual([]);
    expect(downloads()).toEqual([]);
    say(chat, "test", { mention: true });
    await settle();
    const [m] = userMessages(lin.conversationId);
    expect(m?.text).toBe("test");
    expect(attachmentNames(m)).toEqual([expect.stringMatching(/\.png$/), "brief.pdf"]);
    expect(downloads()).toEqual([
      expect.objectContaining({ messageId: imageBubble, fileKey: "img_p" }),
      expect.objectContaining({ messageId: fileBubble, fileKey: "file_p" }),
    ]);
    say(chat, "再看下首页", { mention: true });
    await settle();
    expect(attachmentNames(userMessages(lin.conversationId)[1])).toEqual([]);
    expect(downloads()).toHaveLength(2);
  });

  it("前面发了图、下一个气泡只 @机器人 没写字：图照样交给项目经理", async () => {
    const chat = await mentionOnlyGroupWithGuest();
    fake.resources.set("img_q", png());
    say(chat, "![image](img_q)", { files: [{ type: "image", fileKey: "img_q", fileName: null }] });
    say(chat, "", { mention: true });
    await settle();
    const [m] = userMessages(lin.conversationId);
    expect(m?.text).toBe("");
    expect(attachmentNames(m)).toEqual([expect.stringMatching(/\.png$/)]);
  });

  it("仅对话档访客先单发图片再 @机器人：图不下载，回她一句怎么开（切到协作者）；被拒的旧图不补收，切到协作者后她重新发的图再 @ 才收下", async () => {
    const chat = await mentionOnlyGroupWithGuest();
    fake.resources.set("img_y", png());
    say(chat, "![image](img_y)", { sender: GUEST, files: [{ type: "image", fileKey: "img_y", fileName: null }] });
    say(chat, "图里这种直给类的文案写一版", { sender: GUEST, mention: true });
    await settle();
    expect(downloads()).toEqual([]);
    const notice = textsTo(chat).find((t) => t.includes(GUEST));
    expect(notice).toContain("协作者");
    expect(attachmentNames(userMessages(lin.conversationId)[0])).toEqual([]);
    const resent = say(chat, "![image](img_y)", { sender: GUEST, files: [{ type: "image", fileKey: "img_y", fileName: null }] });
    await svc.setup.setChatPolicy({ pmId: lin.pmId, guestTier: "collaborator" });
    say(chat, "看这张", { sender: GUEST, mention: true });
    await settle();
    expect(attachmentNames(userMessages(lin.conversationId)[1])).toEqual([expect.stringMatching(/\.png$/)]);
    expect(downloads()).toEqual([expect.objectContaining({ messageId: resent, fileKey: "img_y" })]);
  });

  it("前面的文件下载失败、下一个气泡只 @机器人：只回一次“没收下”，失败的文件不留在近窗里，换发正常文件再 @ 不再重下坏文件", async () => {
    const chat = await mentionOnlyGroupWithGuest();
    const badBubble = say(chat, "![image](img_bad)", { files: [{ type: "image", fileKey: "img_bad", fileName: null }] });
    say(chat, "", { mention: true });
    await settle();
    fake.resources.set("img_good", png());
    const goodBubble = say(chat, "![image](img_good)", { files: [{ type: "image", fileKey: "img_good", fileName: null }] });
    say(chat, "", { mention: true });
    await settle();
    expect(downloads().map((d) => d.messageId)).toEqual([badBubble, goodBubble]);
    expect(textsTo(chat).filter((t) => t.includes("没收下"))).toHaveLength(1);
    expect(attachmentNames(userMessages(lin.conversationId)[0])).toEqual([expect.stringMatching(/\.png$/)]);
  });

  it("仅对话档访客先发图再纯 @ 被拒后，改发纯文字 @：不再重复回“访客发的文件不收”", async () => {
    const chat = await mentionOnlyGroupWithGuest();
    fake.resources.set("img_y", png());
    say(chat, "![image](img_y)", { sender: GUEST, files: [{ type: "image", fileKey: "img_y", fileName: null }] });
    say(chat, "", { sender: GUEST, mention: true });
    await settle();
    expect(textsTo(chat).filter((t) => t.includes("访客发的文件不收"))).toHaveLength(1);
    say(chat, "那我用文字说：写一版文案", { sender: GUEST, mention: true });
    await settle();
    expect(textsTo(chat).filter((t) => t.includes("访客发的文件不收"))).toHaveLength(1);
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["那我用文字说：写一版文案"]);
  });

  it("长连接断开时前面没交出的文件跟背景一起清掉，重连后 @机器人 不再带上", async () => {
    const chat = await mentionOnlyGroupWithGuest();
    fake.resources.set("img_d", png());
    say(chat, "![image](img_d)", { files: [{ type: "image", fileKey: "img_d", fileName: null }] });
    await settle();
    fake.handlers!.onDisconnected("断了");
    fake.handlers!.onConnected();
    await settle();
    say(chat, "看图", { mention: true });
    await settle();
    expect(attachmentNames(userMessages(lin.conversationId)[0])).toEqual([]);
    expect(downloads()).toEqual([]);
  });
});

describe("createFeishuService：检查点拍板卡（含交付物文件附件）同步总助单聊与三端双向收口", () => {
  const pngBytes = () => Buffer.from("89504e470d0a1a0a", "hex");

  function prepareRepo(): string {
    const repo = join(root, "checkpoint-repo");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    git("init", "-b", "main");
    writeFileSync(join(repo, "README.md"), "# repo\n");
    git("add", ".");
    git("commit", "-m", "init");
    ledger.hubCall(lin.sessionId, "project.create", { name: "检查点项目", folder: repo });
    return repo;
  }

  function finishWorkerTurn(workerId: WorkerId, filesLines: string, summary = "方案就绪"): void {
    const ws = db.get<{ id: number; conversation_id: number }>(
      "SELECT id, conversation_id FROM agent_sessions WHERE worker_id = ? ORDER BY generation DESC LIMIT 1",
      workerId,
    )!;
    const input = db.get<{ id: number }>(
      "SELECT id FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') ORDER BY id DESC LIMIT 1",
      ws.conversation_id,
    )!;
    const ss = createSessionStore(db);
    ss.update(ws.id, { status: "running", pid: 60_000 + workerId });
    const at = Date.now();
    ev(ws.id, { type: "message.delivered", messageIds: [input.id], at });
    ev(ws.id, { type: "message.processing", messageIds: [input.id], at: at + 1 });
    const reply = [
      REPORT_START,
      "状态: 做完了",
      `摘要: ${summary}`,
      "提交: abc1234",
      "PR: 无",
      "测试: pnpm typecheck 通过",
      "偏离: 无",
      "交棒: 无",
      `文件: ${filesLines}`,
      "问题: 无",
      REPORT_END,
    ].join("\n");
    ev(ws.id, { type: "agent.text", uuid: `w-${workerId}-${++seq}`, text: reply, at: at + 2 });
    ev(ws.id, { type: "turn.ended", ok: true, interrupted: false, messageIds: [input.id], durationMs: 10, at: at + 3 });
    ss.update(ws.id, { status: "ended", pid: null });
  }

  async function raiseCheckpointWithDeliverables() {
    const repo = prepareRepo();
    writeFileSync(join(repo, "plan.md"), "# 方案详情\n");
    writeFileSync(join(repo, "preview.png"), pngBytes());
    const graph = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "检查点任务图",
        steps: [
          { key: "design", title: "写方案", brief: "出方案", confirm: true },
          { key: "impl", title: "实现", brief: "写代码", deps: ["design"] },
        ],
      }),
    }).data.graph;
    const w1 = graph.nodes.find((n) => n.key === "design")!.activeWorkerId!;
    finishWorkerTurn(w1, `\n- [方案文档](${join(repo, "plan.md")})\n- [界面预览](${join(repo, "preview.png")})`);
    await settle();
    const refreshed = ledger.hubCall(lin.sessionId, "graph.show", { graphId: graph.id }).data.graph;
    const askMsgId = refreshed.nodes.find((n) => n.key === "design")!.gateAskMessageId!;
    return { graphId: graph.id, askMsgId, pmChatId: chatOf(lin.pmId), rChatId: routerChat() };
  }

  it("confirm: true 检查点拍板卡连同步骤交付物截图与文件同步推到飞书总助单聊，文件只上传一次；总助单聊点通过后两边同步收口且不重复触发下游", async () => {
    await connect();
    const uploadsBefore = fake.calls.filter((c) => c.method === "uploadFile" || (c.method === "uploadImage" && c.args.imageType === "message")).length;
    const { graphId, askMsgId, pmChatId, rChatId } = await raiseCheckpointWithDeliverables();

    const groupPost = postOfAsk(askMsgId);
    const routerPost = store().postOf({ kind: "router_ask", messageId: askMsgId });
    expect(routerPost).not.toBeNull();
    expect(routerPost?.chatId).toBe(rChatId);
    expect(routerPost?.state).toBe("card_pending");

    const groupCard = fake.cards.get(groupPost.cardId!)!;
    const routerCard = fake.cards.get(routerPost!.cardId!)!;
    expect(imgKeysOf(groupCard)).toHaveLength(1);
    expect(imgKeysOf(routerCard)).toEqual(imgKeysOf(groupCard));
    expect(routerCard).toContain("打开项目群");
    expect(fake.callsOf("message.create").filter((c) => c.receive_id === pmChatId && c.msg_type === "file")).toHaveLength(1);
    expect(fake.callsOf("message.create").filter((c) => c.receive_id === rChatId && c.msg_type === "file")).toHaveLength(1);
    const msgImageUploads = fake.calls.slice(uploadsBefore).filter((c) => c.method === "uploadImage" && c.args.imageType === "message");
    const fileUploads = fake.calls.slice(uploadsBefore).filter((c) => c.method === "uploadFile");
    expect(msgImageUploads).toHaveLength(1);
    expect(fileUploads).toHaveLength(1);

    const passAction = { fusa: 1, kind: "choose", card: { kind: "gate", askMessageId: askMsgId, graphId, nodeKey: "design" }, optionIndex: 0 };
    expect(click(rChatId, routerPost!.messageId, passAction).toast?.type).toBe("success");
    await settle();
    expect(postOfAsk(askMsgId).state).toBe("card_settled");
    expect(store().postOf({ kind: "router_ask", messageId: askMsgId })?.state).toBe("card_settled");
    for (const cid of [groupPost.cardId!, routerPost!.cardId!]) {
      const last = fake.callsOf("card.update").filter((u) => u.card_id === cid).at(-1)!;
      expect(buttonValues(last.card.data)).toEqual([]);
      expect(last.card.data).toContain("已定案");
    }
    const implNode = ledger.hubCall(lin.sessionId, "graph.show", { graphId }).data.graph.nodes.find((n) => n.key === "impl")!;
    expect(implNode.activeWorkerId).not.toBeNull();
    const implWorkerId = implNode.activeWorkerId;

    const dup = click(pmChatId, groupPost.messageId, passAction);
    expect(dup.toast).toEqual({ type: "info", content: "已经定过了" });
    expect(ledger.hubCall(lin.sessionId, "graph.show", { graphId }).data.graph.nodes.find((n) => n.key === "impl")!.activeWorkerId).toBe(implWorkerId);
  });

  it("在项目群点打回、在网页上拍板或取消任务图（含断线期间网页处理后重连）时，总助单聊与项目群两边的检查点卡均实时同步收口", async () => {
    await connect();
    const first = await raiseCheckpointWithDeliverables();
    const rejectAction = { fusa: 1, kind: "choose", card: { kind: "gate", askMessageId: first.askMsgId, graphId: first.graphId, nodeKey: "design" }, optionIndex: 1 };
    expect(click(first.pmChatId, postOfAsk(first.askMsgId).messageId, rejectAction, OWNER, "补一段边界说明").toast?.type).toBe("success");
    await settle();
    expect(postOfAsk(first.askMsgId).state).toBe("card_settled");
    expect(store().postOf({ kind: "router_ask", messageId: first.askMsgId })?.state).toBe("card_settled");

    const w1 = ledger.hubCall(lin.sessionId, "graph.show", { graphId: first.graphId }).data.graph.nodes.find((n) => n.key === "design")!.activeWorkerId!;
    finishWorkerTurn(w1, "无", "已补充边界说明");
    await settle();
    const secondAskId = ledger.hubCall(lin.sessionId, "graph.show", { graphId: first.graphId }).data.graph.nodes.find((n) => n.key === "design")!.gateAskMessageId!;
    expect(secondAskId).not.toBe(first.askMsgId);
    expect(store().postOf({ kind: "router_ask", messageId: secondAskId })?.state).toBe("card_pending");

    fake.handlers!.onDisconnected("offline during web decide");
    ledger.decideTaskNode(first.graphId, "design", { clientId: "web-reject-2", choice: "打回", note: "再补一处" });
    fake.handlers!.onConnected();
    await settle();
    expect(postOfAsk(secondAskId).state).toBe("card_settled");
    expect(store().postOf({ kind: "router_ask", messageId: secondAskId })?.state).toBe("card_settled");

    finishWorkerTurn(w1, "无", "第三版就绪");
    await settle();
    const thirdAskId = ledger.hubCall(lin.sessionId, "graph.show", { graphId: first.graphId }).data.graph.nodes.find((n) => n.key === "design")!.gateAskMessageId!;
    expect(store().postOf({ kind: "router_ask", messageId: thirdAskId })?.state).toBe("card_pending");

    ledger.cancelTaskGraph(first.graphId, { reason: "直接取消" });
    await settle();
    expect(postOfAsk(thirdAskId).state).toBe("card_settled");
    expect(store().postOf({ kind: "router_ask", messageId: thirdAskId })?.state).toBe("card_settled");
    const routerSettled = fake.callsOf("card.update").filter((u) => u.card_id === store().postOf({ kind: "router_ask", messageId: thirdAskId })!.cardId).at(-1)!;
    expect(routerSettled.card.data).toContain("已关闭");
    expect(buttonValues(routerSettled.card.data)).toEqual([]);
  });
});

describe("createFeishuService：启动与断线重连入站主动补拉（Inbound catch-up）", () => {
  const pngBytes = () => Buffer.from("89504e470d0a1a0a", "hex");
  const attachmentNames = (m: Message | undefined) => ((m?.meta?.attachments as { name: string }[] | undefined) ?? []).map((a) => a.name);

  function offlineUserMessage(
    chatId: string,
    text: string,
    opts: {
      messageId?: string;
      sender?: string;
      mention?: boolean;
      p2p?: boolean;
      createTime?: number;
      files?: { type: "image" | "file" | "audio" | "video" | "sticker"; fileKey: string; fileName: string | null }[];
    } = {},
  ) {
    const event = {
      type: "im.message.receive_v1" as const,
      messageId: opts.messageId ?? `om_missed_${++seq}`,
      chatId,
      chatType: (opts.p2p ? "p2p" : "group") as "p2p" | "group",
      senderOpenId: opts.sender ?? OWNER,
      senderType: "user" as const,
      content: text,
      mentionedBot: opts.mention ?? false,
      threadId: null,
      resources: opts.files ?? [],
      createTime: opts.createTime ?? Date.now(),
    };
    fake.recordMessage(event);
    return event;
  }

  it("20 秒闪断重连主动补拉总助单聊与项目群漏收消息，过滤机器人自身消息，且先于重连瞬间的第二条实时消息按时间顺序入库", async () => {
    let clockNow = 1_730_000_000_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({ now: () => clockNow });
    await connect();
    const pmChat = chatOf(lin.pmId);
    const rChat = routerChat();

    clockNow += 5_000;
    fake.handlers!.onDisconnected("network drop");
    clockNow += 5_000;
    offlineUserMessage(pmChat, "断网期间第一条", { createTime: clockNow });
    offlineUserMessage(rChat, "断网期间问总助", { p2p: true, createTime: clockNow + 100 });
    fake.recordMessage({
      type: "im.message.receive_v1",
      messageId: "om_bot_noise",
      chatId: pmChat,
      chatType: "group",
      senderOpenId: "ou_bot",
      senderType: "app",
      content: "机器人自己的卡片",
      mentionedBot: false,
      threadId: null,
      resources: [],
      createTime: clockNow + 200,
    });

    clockNow += 15_000;
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    fake.beforeListMessages = () => listGate;
    fake.handlers!.onConnected();
    fake.event({
      type: "im.message.receive_v1",
      messageId: "om_live_second",
      chatId: pmChat,
      chatType: "group",
      senderOpenId: OWNER,
      senderType: "user",
      content: "重连瞬间第二条",
      mentionedBot: false,
      threadId: null,
      resources: [],
      createTime: clockNow + 50,
    });
    fake.beforeListMessages = null;
    releaseList();
    await settle();

    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["断网期间第一条", "重连瞬间第二条"]);
    expect(routerCalls.map((c) => c.text)).toEqual(["断网期间问总助"]);
  });

  it("多人群断线期间跨气泡发图片 + @机器人 补拉生效；飞书稍后 WebSocket 迟到重推同一 message_id 100% 幂等跳过，守护进程重启冷启动同样按游标补拉并按唯一键去重", async () => {
    let clockNow = 1_730_000_100_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({ now: () => clockNow });
    await connect();
    const chat = chatOf(lin.pmId);
    join_(chat);
    await settle();

    clockNow += 3_000;
    fake.handlers!.onDisconnected("drop");
    fake.resources.set("img_catchup", pngBytes());
    const imgEv = offlineUserMessage(chat, "![image](img_catchup)", {
      messageId: "om_catch_img",
      createTime: clockNow + 1_000,
      files: [{ type: "image", fileKey: "img_catchup", fileName: null }],
    });
    const wakeEv = offlineUserMessage(chat, "看下这张断网发的图", {
      messageId: "om_catch_wake",
      mention: true,
      createTime: clockNow + 2_000,
    });
    const settingsEv = offlineUserMessage(chat, "/群设置", {
      messageId: "om_catch_settings",
      createTime: clockNow + 3_000,
    });
    const policyCardsBefore = cardIdsCreated().filter((c) => c.data.includes("群设置")).length;

    clockNow += 10_000;
    fake.handlers!.onConnected();
    await settle();

    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["看下这张断网发的图"]);
    expect(attachmentNames(userMessages(lin.conversationId)[0])).toEqual([expect.stringMatching(/\.png$/)]);
    const downloadsAfterCatchUp = fake.calls.filter((c) => c.method === "downloadResource").length;
    expect(downloadsAfterCatchUp).toBe(1);
    const policyCardsAfterCatchUp = cardIdsCreated().filter((c) => c.data.includes("群设置")).length;
    expect(policyCardsAfterCatchUp).toBe(policyCardsBefore + 1);

    clockNow += 15_000;
    fake.event(imgEv);
    fake.event(wakeEv);
    fake.event(settingsEv);
    await settle();
    expect(userMessages(lin.conversationId)).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === "downloadResource")).toHaveLength(downloadsAfterCatchUp);
    expect(cardIdsCreated().filter((c) => c.data.includes("群设置"))).toHaveLength(policyCardsAfterCatchUp);

    await svc.close();
    clockNow += 5_000;
    offlineUserMessage(chatOf(zhou.pmId), "重启空档发给阿周", { messageId: "om_restart_zhou", createTime: clockNow });
    clockNow += 2_000;
    svc = makeService({ now: () => clockNow });
    await svc.start();
    await vi.waitFor(() => expect(svc.setup.status().state).toBe("connected"));
    await settle();
    expect(userMessages(zhou.conversationId).map((m) => m.text)).toEqual(["重启空档发给阿周"]);
    expect(userMessages(lin.conversationId)).toHaveLength(1);
  });

  it("遵守最大回溯时间窗与单群分页条数硬上限：超窗旧消息不拉，极端刷屏只按页数上限取最新窗口消息", async () => {
    let clockNow = 1_730_001_000_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({ now: () => clockNow });
    await connect();
    const linChat = chatOf(lin.pmId);
    const zhouChat = chatOf(zhou.pmId);

    fake.handlers!.onDisconnected("long offline");
    offlineUserMessage(zhouChat, "太久以前的消息", { createTime: clockNow + 5_000 });
    clockNow += FEISHU_INBOUND_CATCHUP_WINDOW_MS + 60_000;
    offlineUserMessage(zhouChat, "窗口内的新消息", { createTime: clockNow - 10_000 });

    const totalSpam = FEISHU_INBOUND_CATCHUP_MAX_MESSAGES + 35;
    for (let i = 1; i <= totalSpam; i++) {
      offlineUserMessage(linChat, `刷屏-${i}`, { createTime: clockNow - (totalSpam - i + 1) * 100 });
    }

    fake.handlers!.onConnected();
    await settle();

    expect(userMessages(zhou.conversationId).map((m) => m.text)).toEqual(["窗口内的新消息"]);
    const linCalls = fake.callsOf("message.list").filter((c) => c.container_id === linChat);
    expect(linCalls.length).toBeLessThanOrEqual(FEISHU_INBOUND_CATCHUP_MAX_PAGES);
    const delivered = userMessages(lin.conversationId).map((m) => m.text);
    expect(delivered).toHaveLength(FEISHU_INBOUND_CATCHUP_MAX_MESSAGES);
    expect(delivered[0]).toBe("刷屏-36");
    expect(delivered.at(-1)).toBe(`刷屏-${totalSpam}`);
  });

  it("缺少读群历史消息权限或单群接口报错时隔离单群静默降级记结构化日志，不阻塞总助单聊与其他群；并发多次闪断重连同一时间只跑一轮补拉", async () => {
    let clockNow = 1_730_002_000_000;
    const logs: string[] = [];
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES];
    svc = makeService({ now: () => clockNow, log: (line) => logs.push(line) });
    await connect();
    const linChat = chatOf(lin.pmId);
    const zhouChat = chatOf(zhou.pmId);
    const rChat = routerChat();

    clockNow += 3_000;
    fake.handlers!.onDisconnected("drop 1");
    offlineUserMessage(linChat, "缺群权限时的群消息", { mention: true, createTime: clockNow + 1_000 });
    offlineUserMessage(rChat, "缺群权限时的总助单聊消息", { p2p: true, createTime: clockNow + 1_500 });
    clockNow += 5_000;
    fake.handlers!.onConnected();
    await settle();
    expect(routerCalls.map((c) => c.text)).toEqual(["缺群权限时的总助单聊消息"]);
    expect(svc.setup.status().lastError).toBeNull();
    expect(logs.some((l) => l.includes(linChat))).toBe(true);

    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    fake.failListForChat.set(linChat, { code: 230027, msg: "Lack of necessary permissions", httpStatus: 400 });
    clockNow += 5_000;
    fake.handlers!.onDisconnected("drop 2");
    offlineUserMessage(linChat, "lin 报错被隔离", { createTime: clockNow + 1_000 });
    offlineUserMessage(zhouChat, "zhou 正常补拉", { createTime: clockNow + 1_500 });

    const activeByChat = new Map<string, number>();
    let maxSameChatConcurrent = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let gated = true;
    fake.beforeListMessages = async (args) => {
      const nextCount = (activeByChat.get(args.container_id) ?? 0) + 1;
      activeByChat.set(args.container_id, nextCount);
      maxSameChatConcurrent = Math.max(maxSameChatConcurrent, nextCount);
      if (gated) {
        gated = false;
        await firstGate;
      }
      activeByChat.set(args.container_id, (activeByChat.get(args.container_id) ?? 1) - 1);
    };
    clockNow += 5_000;
    fake.handlers!.onConnected();
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.handlers!.onConnected();
    fake.handlers!.onConnected();
    releaseFirst();
    await settle();
    fake.beforeListMessages = null;

    expect(maxSameChatConcurrent).toBe(1);
    expect(userMessages(zhou.conversationId).map((m) => m.text)).toEqual(["zhou 正常补拉"]);
    expect(logs.some((l) => l.includes("230027") && l.includes(linChat))).toBe(true);
    expect(svc.setup.status().state).toBe("connected");

    say(linChat, "实时消息正常收");
    await settle();
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["实时消息正常收"]);
  });

  it("R1 补拉 listMessages 在途时再次断线：拉到的消息未入队时不推进游标，下次重连完整补回", async () => {
    let clockNow = 1_730_010_000_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({ now: () => clockNow });
    await connect();
    const linChat = chatOf(lin.pmId);
    clockNow += 5_000;
    fake.handlers!.onDisconnected("drop 1");
    offlineUserMessage(linChat, "断网第一条", { createTime: clockNow + 1_000 });
    offlineUserMessage(linChat, "断网第二条", { createTime: clockNow + 90_000 });
    clockNow += 120_000;
    let dropped = false;
    fake.beforeListMessages = async (args) => {
      if (!dropped && args.container_id === linChat) {
        dropped = true;
        fake.handlers!.onDisconnected("drop 2 during catch-up");
      }
    };
    fake.handlers!.onConnected();
    await settle();
    fake.beforeListMessages = null;
    clockNow += 5_000;
    fake.handlers!.onConnected();
    await settle();
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["断网第一条", "断网第二条"]);
  });

  it("R2 补拉已入队、处理到一半又断线：未处理的剩余消息不推进游标，下次重连全部找回", async () => {
    let clockNow = 1_730_020_000_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    let first = true;
    svc = makeService({
      now: () => clockNow,
      router: {
        submitCommand: async (input) => {
          routerCalls.push({ clientId: input.clientId, text: input.text });
          if (first) {
            first = false;
            fake.handlers!.onDisconnected("drop while draining catch-up");
          }
          const { command } = ledger.createRouterCommand({ clientId: input.clientId, inputText: input.text, vendor: "claude", status: "planning" });
          return ledger.updateRouterCommand(command.id, { status: "answered", plan: { intent: "answer", reply: "ok", actions: [] } }) as RouterCommandRecord;
        },
      },
    });
    await connect();
    const rChat = routerChat();
    first = true;
    routerCalls = [];
    clockNow += 5_000;
    fake.handlers!.onDisconnected("drop 1");
    offlineUserMessage(rChat, "r1", { p2p: true, createTime: clockNow + 1_000 });
    offlineUserMessage(rChat, "r2", { p2p: true, createTime: clockNow + 5_000 });
    offlineUserMessage(rChat, "r3", { p2p: true, createTime: clockNow + 100_000 });
    clockNow += 120_000;
    fake.handlers!.onConnected();
    await settle();
    clockNow += 5_000;
    fake.handlers!.onConnected();
    await settle();
    expect(routerCalls.map((c) => c.text)).toEqual(["r1", "r2", "r3"]);
  });

  it("R3 停机时补拉在途：排空或重启后漏收消息不丢失且不重复", async () => {
    let clockNow = 1_730_030_000_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({ now: () => clockNow });
    await connect();
    const linChat = chatOf(lin.pmId);
    clockNow += 5_000;
    fake.handlers!.onDisconnected("drop");
    offlineUserMessage(linChat, "停机前漏收", { createTime: clockNow + 1_000 });
    clockNow += 10_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fake.beforeListMessages = async (args) => { if (args.container_id === linChat) await gate; };
    fake.handlers!.onConnected();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closing = svc.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await closing;
    fake.beforeListMessages = null;
    await new Promise((resolve) => setTimeout(resolve, 20));
    clockNow += 2_000;
    svc = makeService({ now: () => clockNow });
    await svc.start();
    await vi.waitFor(() => expect(svc.setup.status().state).toBe("connected"));
    await settle();
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["停机前漏收"]);
  });

  it("入站队列满导致补拉部分丢弃时按时间先入最早消息、记结构化日志并冻结游标，后续实时消息不跨过缺口，下次重连完整补回", async () => {
    let clockNow = 1_730_035_000_000;
    const logs: string[] = [];
    let releaseRouter!: () => void;
    const routerGate = new Promise<void>((resolve) => { releaseRouter = resolve; });
    let blockRouter = false;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({
      now: () => clockNow,
      log: (line) => logs.push(line),
      router: {
        submitCommand: async (input) => {
          if (blockRouter) await routerGate;
          const { command } = ledger.createRouterCommand({ clientId: input.clientId, inputText: input.text, vendor: "claude", status: "planning" });
          if (input.text.startsWith("占坑-")) return command;
          return ledger.updateRouterCommand(command.id, { status: "answered", plan: { intent: "answer", reply: "ok", actions: [] } }) as RouterCommandRecord;
        },
      },
    });
    await connect();
    const rChat = routerChat();
    const linChat = chatOf(lin.pmId);

    blockRouter = true;
    for (let i = 0; i < FEISHU_INBOUND_QUEUE_MAX - 1; i++) {
      clockNow += 10;
      fake.event({
        type: "im.message.receive_v1",
        messageId: `om_fill_${i}`,
        chatId: rChat,
        chatType: "p2p",
        senderOpenId: OWNER,
        senderType: "user",
        content: `占坑-${i}`,
        mentionedBot: false,
        threadId: null,
        resources: [],
        createTime: clockNow,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    clockNow += 5_000;
    fake.handlers!.onDisconnected("drop while full");
    offlineUserMessage(linChat, "队列满第一条", { createTime: clockNow + 1_000 });
    offlineUserMessage(linChat, "队列满第二条", { createTime: clockNow + 80_000 });
    clockNow += 100_000;
    fake.handlers!.onConnected();
    await vi.waitFor(() => expect(logs.some((l) => l.includes(linChat) && l.includes("dropped=1"))).toBe(true));
    expect(svc.setup.status().lastError).toContain("入站队列已满");

    blockRouter = false;
    releaseRouter();
    await settle();
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["队列满第一条"]);

    clockNow += 60_000;
    fake.event({
      type: "im.message.receive_v1",
      messageId: "om_after_overflow",
      chatId: linChat,
      chatType: "group",
      senderOpenId: OWNER,
      senderType: "user",
      content: "溢出后实时消息",
      mentionedBot: false,
      threadId: null,
      resources: [],
      createTime: clockNow,
    });
    await settle();

    fake.handlers!.onDisconnected("drop 2");
    clockNow += 5_000;
    fake.handlers!.onConnected();
    await settle();
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["队列满第一条", "溢出后实时消息", "队列满第二条"]);
  });

  it("R4 升级 0041 后首次启动（会话游标为空）建立当前时刻锚点，不重放过去 15 分钟的非幂等 /群设置", async () => {
    let clockNow = 1_730_040_000_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({ now: () => clockNow });
    await connect();
    const linChat = chatOf(lin.pmId);
    clockNow += 60_000;
    fake.event({ type: "im.message.receive_v1", messageId: "om_rv_settings", chatId: linChat, chatType: "group", senderOpenId: OWNER, senderType: "user", content: "/群设置", mentionedBot: false, threadId: null, resources: [], createTime: clockNow });
    await settle();
    const before = cardIdsCreated().filter((c) => c.data.includes("群设置")).length;
    await svc.close();
    db.run("DELETE FROM feishu_inbound_cursors");
    clockNow += 60_000;
    svc = makeService({ now: () => clockNow });
    await svc.start();
    await vi.waitFor(() => expect(svc.setup.status().state).toBe("connected"));
    await settle();
    expect(cardIdsCreated().filter((c) => c.data.includes("群设置"))).toHaveLength(before);
  });

  it("多群重连按 FEISHU_INBOUND_CATCHUP_CONCURRENCY 并发补拉，避免串行长队阻塞末尾群实时消息", async () => {
    const extraCount = 35;
    const pms: { pmId: PmId; conversationId: ConversationId }[] = [];
    for (let i = 0; i < extraCount; i++) {
      const p = ledger.createPm({ name: `并发${i}`, mode: "manage_only", persona: "" });
      pms.push({ pmId: p.pm.id, conversationId: p.conversation.id });
    }
    await svc.close();
    fake = createFakeFeishu();
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService();
    await connect();
    const lastPm = pms.at(-1)!;
    const lastChat = chatOf(lastPm.pmId);

    let inFlight = 0;
    let peakConcurrent = 0;
    fake.handlers!.onDisconnected("drop");
    fake.beforeListMessages = async () => {
      inFlight++;
      peakConcurrent = Math.max(peakConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 25));
      inFlight--;
    };
    const t0 = Date.now();
    fake.handlers!.onConnected();
    fake.event({
      type: "im.message.receive_v1",
      messageId: "om_live_last_concurrent",
      chatId: lastChat,
      chatType: "group",
      senderOpenId: OWNER,
      senderType: "user",
      content: "末尾群实时消息",
      mentionedBot: false,
      threadId: null,
      resources: [],
      createTime: Date.now(),
    });
    await vi.waitFor(() => expect(userMessages(lastPm.conversationId).map((m) => m.text)).toEqual(["末尾群实时消息"]), {
      timeout: 10_000,
      interval: 10,
    });
    const waited = Date.now() - t0;
    fake.beforeListMessages = null;
    await settle();

    expect(peakConcurrent).toBeGreaterThan(1);
    expect(peakConcurrent).toBeLessThanOrEqual(FEISHU_INBOUND_CATCHUP_CONCURRENCY);
    expect(waited).toBeLessThan(650);
  });

  it("N1 第一轮补拉还在跑时又闪断并重连：第一轮整轮收尾不得放开第二次重连加的闸门，避免实时消息抢跑跳过两段断线消息", async () => {
    let clockNow = 1_730_090_000_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({ now: () => clockNow });
    await connect();
    const linChat = chatOf(lin.pmId);
    const rChat = routerChat();
    clockNow += 5_000;
    fake.handlers!.onDisconnected("drop 1");
    offlineUserMessage(linChat, "第一次断网", { createTime: clockNow + 1_000 });
    clockNow += 60_000;
    let releaseRouter!: () => void;
    const routerHold = new Promise<void>((r) => { releaseRouter = r; });
    let linFirst = true;
    let routerFirst = true;
    let linReturned!: () => void;
    const linDone = new Promise<void>((r) => { linReturned = r; });
    fake.beforeListMessages = async (args) => {
      if (args.container_id === rChat && routerFirst) {
        routerFirst = false;
        await routerHold;
      }
      if (args.container_id === linChat && linFirst) {
        linFirst = false;
        fake.handlers!.onDisconnected("drop 2 during catch-up");
        offlineUserMessage(linChat, "第二次断网", { createTime: clockNow + 1_000 });
        clockNow += 60_000;
        linReturned();
      }
    };
    fake.handlers!.onConnected();
    await linDone;
    await new Promise((r) => setTimeout(r, 20));
    const origCall = fake.call.bind(fake);
    fake.call = (async (method: string, args: unknown) => {
      if (method === "application.scopes") await new Promise((r) => setTimeout(r, 100));
      return origCall(method as never, args as never);
    }) as typeof fake.call;
    fake.handlers!.onConnected();
    fake.event({
      type: "im.message.receive_v1",
      messageId: "om_n1_live",
      chatId: linChat,
      chatType: "group",
      senderOpenId: OWNER,
      senderType: "user",
      content: "重连后实时",
      mentionedBot: false,
      threadId: null,
      resources: [],
      createTime: clockNow,
    });
    releaseRouter();
    await settle();
    fake.beforeListMessages = null;
    fake.call = origCall;
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["第一次断网", "第二次断网", "重连后实时"]);
    clockNow += 5_000;
    fake.handlers!.onDisconnected("drop 3");
    clockNow += 5_000;
    fake.handlers!.onConnected();
    await settle();
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["第一次断网", "第二次断网", "重连后实时"]);
  });

  it("N1b 第一轮整轮尚未结束时先返回的单会话 finally 不得提前放开第二次重连加的该会话闸门", async () => {
    let clockNow = 1_730_100_000_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({ now: () => clockNow });
    await connect();
    const linChat = chatOf(lin.pmId);
    const zhouChat = chatOf(zhou.pmId);
    const rChat = routerChat();
    clockNow += 5_000;
    fake.handlers!.onDisconnected("drop 1");
    offlineUserMessage(linChat, "第一次断网", { createTime: clockNow + 1_000 });
    clockNow += 80_000;

    let releaseLin!: () => void;
    const linHold = new Promise<void>((r) => { releaseLin = r; });
    let releaseZhou!: () => void;
    const zhouHold = new Promise<void>((r) => { releaseZhou = r; });
    let linFirst = true;
    let zhouFirst = true;
    let routerFirst = true;
    let bothHeld = 0;
    let notifyHeld!: () => void;
    const heldReady = new Promise<void>((r) => { notifyHeld = r; });
    let droppedInRouter!: () => void;
    const routerDropped = new Promise<void>((r) => { droppedInRouter = r; });
    fake.beforeListMessages = async (args) => {
      if (args.container_id === linChat && linFirst) {
        linFirst = false;
        if (++bothHeld === 2) notifyHeld();
        await linHold;
      }
      if (args.container_id === zhouChat && zhouFirst) {
        zhouFirst = false;
        if (++bothHeld === 2) notifyHeld();
        await zhouHold;
      }
      if (args.container_id === rChat && routerFirst) {
        routerFirst = false;
        await heldReady;
        fake.handlers!.onDisconnected("drop 2 while lin and zhou still in flight");
        clockNow += 80_000;
        offlineUserMessage(linChat, "第二次断网", { createTime: clockNow + 1_000 });
        clockNow += 60_000;
        droppedInRouter();
      }
    };

    fake.handlers!.onConnected();
    await routerDropped;
    await new Promise((r) => setTimeout(r, 15));
    const origCall = fake.call.bind(fake);
    fake.call = (async (method: string, args: unknown) => {
      if (method === "application.scopes") await new Promise((r) => setTimeout(r, 80));
      return origCall(method as never, args as never);
    }) as typeof fake.call;
    fake.handlers!.onConnected();
    fake.event({
      type: "im.message.receive_v1",
      messageId: "om_n1b_live",
      chatId: linChat,
      chatType: "group",
      senderOpenId: OWNER,
      senderType: "user",
      content: "重连后实时",
      mentionedBot: false,
      threadId: null,
      resources: [],
      createTime: clockNow,
    });
    releaseLin();
    await new Promise((r) => setTimeout(r, 30));
    fake.beforeListMessages = null;
    releaseZhou();
    await settle();
    fake.call = origCall;
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["第一次断网", "第二次断网", "重连后实时"]);
  });

  it("N1c 未经 onDisconnected 直接连续触发 onConnected 时，第一轮旧时间窗在途请求返回后不得放闸门漏掉空档消息", async () => {
    let clockNow = 1_730_110_000_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({ now: () => clockNow });
    await connect();
    const linChat = chatOf(lin.pmId);
    clockNow += 5_000;
    fake.handlers!.onDisconnected("drop 1");
    offlineUserMessage(linChat, "第一段漏收", { createTime: clockNow + 1_000 });
    clockNow += 60_000;

    let releaseLin!: () => void;
    const linHold = new Promise<void>((r) => { releaseLin = r; });
    let linEntered!: () => void;
    const linReady = new Promise<void>((r) => { linEntered = r; });
    let linFirst = true;
    fake.beforeListMessages = async (args) => {
      if (args.container_id === linChat && linFirst) {
        linFirst = false;
        linEntered();
        await linHold;
      }
    };

    fake.handlers!.onConnected();
    await linReady;
    clockNow += 90_000;
    offlineUserMessage(linChat, "重握手空档漏收", { createTime: clockNow });
    clockNow += 60_000;
    const origCall = fake.call.bind(fake);
    fake.call = (async (method: string, args: unknown) => {
      if (method === "application.scopes") await new Promise((r) => setTimeout(r, 50));
      return origCall(method as never, args as never);
    }) as typeof fake.call;
    fake.handlers!.onConnected();
    fake.event({
      type: "im.message.receive_v1",
      messageId: "om_n1c_live",
      chatId: linChat,
      chatType: "group",
      senderOpenId: OWNER,
      senderType: "user",
      content: "重握手后实时",
      mentionedBot: false,
      threadId: null,
      resources: [],
      createTime: clockNow,
    });
    fake.beforeListMessages = null;
    releaseLin();
    await settle();
    fake.call = origCall;
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["第一段漏收", "重握手空档漏收", "重握手后实时"]);
  });

  it("N1d 总助单聊在补拉期间二次闪断重连，不因首轮收尾误放闸门而漏收主人指令", async () => {
    let clockNow = 1_730_120_000_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({ now: () => clockNow });
    await connect();
    const linChat = chatOf(lin.pmId);
    const zhouChat = chatOf(zhou.pmId);
    const rChat = routerChat();
    routerCalls = [];
    clockNow += 5_000;
    fake.handlers!.onDisconnected("drop 1");
    offlineUserMessage(rChat, "总助断网指令一", { p2p: true, createTime: clockNow + 1_000 });
    clockNow += 60_000;

    let releaseZhou!: () => void;
    const zhouHold = new Promise<void>((r) => { releaseZhou = r; });
    let zhouEntered!: () => void;
    const zhouReady = new Promise<void>((r) => { zhouEntered = r; });
    let linFirst = true;
    let zhouFirst = true;
    let linDone!: () => void;
    const linDropped = new Promise<void>((r) => { linDone = r; });
    fake.beforeListMessages = async (args) => {
      if (args.container_id === zhouChat && zhouFirst) {
        zhouFirst = false;
        zhouEntered();
        await zhouHold;
      }
      if (args.container_id === linChat && linFirst) {
        linFirst = false;
        await zhouReady;
        fake.handlers!.onDisconnected("drop 2");
        offlineUserMessage(rChat, "总助断网指令二", { p2p: true, createTime: clockNow + 1_000 });
        clockNow += 60_000;
        linDone();
      }
    };

    fake.handlers!.onConnected();
    await linDropped;
    await new Promise((r) => setTimeout(r, 15));
    const origCall = fake.call.bind(fake);
    fake.call = (async (method: string, args: unknown) => {
      if (method === "application.scopes") await new Promise((r) => setTimeout(r, 60));
      return origCall(method as never, args as never);
    }) as typeof fake.call;
    fake.handlers!.onConnected();
    fake.event({
      type: "im.message.receive_v1",
      messageId: "om_n1d_live",
      chatId: rChat,
      chatType: "p2p",
      senderOpenId: OWNER,
      senderType: "user",
      content: "总助实时指令三",
      mentionedBot: false,
      threadId: null,
      resources: [],
      createTime: clockNow,
    });
    fake.beforeListMessages = null;
    releaseZhou();
    await settle();
    fake.call = origCall;
    expect(routerCalls.map((c) => c.text)).toEqual(["总助断网指令一", "总助断网指令二", "总助实时指令三"]);
  });

  it("N1e 连续三次闪断重连跨三代交错：前两轮收尾均不得放开第三代闸门，三段断网消息全部找回", async () => {
    let clockNow = 1_730_130_000_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({ now: () => clockNow });
    await connect();
    const linChat = chatOf(lin.pmId);
    const rChat = routerChat();
    clockNow += 5_000;
    fake.handlers!.onDisconnected("drop 1");
    offlineUserMessage(linChat, "断网一", { createTime: clockNow + 1_000 });
    clockNow += 60_000;

    let releaseR1!: () => void;
    const holdR1 = new Promise<void>((r) => { releaseR1 = r; });
    let releaseR2!: () => void;
    const holdR2 = new Promise<void>((r) => { releaseR2 = r; });
    let routerRound = 0;
    let linRound = 0;
    let drop2Done!: () => void;
    const drop2Ready = new Promise<void>((r) => { drop2Done = r; });
    let drop3Done!: () => void;
    const drop3Ready = new Promise<void>((r) => { drop3Done = r; });
    fake.beforeListMessages = async (args) => {
      if (args.container_id === rChat) {
        routerRound++;
        if (routerRound === 1) await holdR1;
        else if (routerRound === 2) await holdR2;
      }
      if (args.container_id === linChat) {
        linRound++;
        if (linRound === 1) {
          fake.handlers!.onDisconnected("drop 2");
          offlineUserMessage(linChat, "断网二", { createTime: clockNow + 1_000 });
          clockNow += 60_000;
          drop2Done();
        } else if (linRound === 2) {
          fake.handlers!.onDisconnected("drop 3");
          offlineUserMessage(linChat, "断网三", { createTime: clockNow + 1_000 });
          clockNow += 60_000;
          drop3Done();
        }
      }
    };

    fake.handlers!.onConnected();
    await drop2Ready;
    await new Promise((r) => setTimeout(r, 15));
    fake.handlers!.onConnected();
    releaseR1();
    await drop3Ready;
    await new Promise((r) => setTimeout(r, 15));
    const origCall = fake.call.bind(fake);
    fake.call = (async (method: string, args: unknown) => {
      if (method === "application.scopes") await new Promise((r) => setTimeout(r, 60));
      return origCall(method as never, args as never);
    }) as typeof fake.call;
    fake.handlers!.onConnected();
    fake.event({
      type: "im.message.receive_v1",
      messageId: "om_n1e_live",
      chatId: linChat,
      chatType: "group",
      senderOpenId: OWNER,
      senderType: "user",
      content: "三次重连实时",
      mentionedBot: false,
      threadId: null,
      resources: [],
      createTime: clockNow,
    });
    fake.beforeListMessages = null;
    releaseR2();
    await settle();
    fake.call = origCall;
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["断网一", "断网二", "断网三", "三次重连实时"]);
  });

  it("N1f 短时二次闪断重连落在 30 秒重叠窗口内时，不得因首轮误放闸门导致补拉队列失活或实时消息乱序抢跑", async () => {
    let clockNow = 1_730_140_000_000;
    await svc.close();
    fake = createFakeFeishu({ clock: () => clockNow });
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    svc = makeService({ now: () => clockNow });
    await connect();
    const linChat = chatOf(lin.pmId);
    const rChat = routerChat();
    clockNow += 3_000;
    fake.handlers!.onDisconnected("short drop 1");
    offlineUserMessage(linChat, "先发的断网一", { createTime: clockNow + 1_000 });
    clockNow += 5_000;

    let releaseRouter!: () => void;
    const routerHold = new Promise<void>((r) => { releaseRouter = r; });
    let linFirst = true;
    let routerFirst = true;
    let linDone!: () => void;
    const linDropped = new Promise<void>((r) => { linDone = r; });
    fake.beforeListMessages = async (args) => {
      if (args.container_id === rChat && routerFirst) {
        routerFirst = false;
        await routerHold;
      }
      if (args.container_id === linChat && linFirst) {
        linFirst = false;
        fake.handlers!.onDisconnected("short drop 2");
        offlineUserMessage(linChat, "再发的断网二", { createTime: clockNow + 1_000 });
        clockNow += 5_000;
        linDone();
      }
    };

    fake.handlers!.onConnected();
    await linDropped;
    await new Promise((r) => setTimeout(r, 15));
    const origCall = fake.call.bind(fake);
    fake.call = (async (method: string, args: unknown) => {
      if (method === "application.scopes") await new Promise((r) => setTimeout(r, 60));
      return origCall(method as never, args as never);
    }) as typeof fake.call;
    fake.handlers!.onConnected();
    fake.event({
      type: "im.message.receive_v1",
      messageId: "om_n1f_live",
      chatId: linChat,
      chatType: "group",
      senderOpenId: OWNER,
      senderType: "user",
      content: "最后发的实时三",
      mentionedBot: false,
      threadId: null,
      resources: [],
      createTime: clockNow,
    });
    fake.beforeListMessages = null;
    releaseRouter();
    const settled = await Promise.race([
      settle().then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 400)),
    ]);
    fake.call = origCall;
    if (!settled) fake.handlers!.onDisconnected("drain deadlocked lane before close");
    expect(userMessages(lin.conversationId).map((m) => m.text)).toEqual(["先发的断网一", "再发的断网二", "最后发的实时三"]);
    expect(settled).toBe(true);
  });
});
