// 用假的传输层（FeishuTransport）和真的账本跑，不连飞书。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askOf, type ConversationId, type Message, type PmId, type SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import { pmFruitOf } from "../../shared/fruits.ts";
import {
  FEISHU_CARD_MAX_CHARS,
  FEISHU_CARDKIT_BUDGET_PER_SECOND,
  FEISHU_CATCHUP_MAX_MESSAGES,
  FEISHU_CHAT_SENDS_PER_SECOND,
  FEISHU_STREAM_FLUSH_MS,
} from "../../shared/limits.ts";
import type { RouterCommandRecord } from "../../shared/router.ts";
import { createResolveFolder } from "../ledger/files.ts";
import { createLedger, type SqliteLedger } from "../ledger/index.ts";
import { openDatabase } from "../store/db.ts";
import type { Db } from "../store/index.ts";
import { createSessionStore } from "../store/index.ts";
import { migrate } from "../store/migrate.ts";
import { decodeFeishuActionValue } from "./cards.ts";
import { feishuChatMarker } from "./chats.ts";
import { FEISHU_GROUP_MSG_SCOPE, FEISHU_REQUIRED_SCOPES } from "./scopes.ts";
import { FEISHU_AVATARS_DIR } from "./avatars.ts";
import { createFeishuService, type FeishuService } from "./service.ts";
import { createFeishuStore } from "./store.ts";
import { createFakeFeishu, type FakeFeishu } from "./test-helpers.ts";
import type { FeishuRawEvent } from "./transport.ts";

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
    avatarsDir: FEISHU_AVATARS_DIR,
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
const say = (chatId: string, text: string, opts: { sender?: string; mention?: boolean; p2p?: boolean; files?: { type: "image" | "file"; fileKey: string; fileName: string | null }[] } = {}) => {
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
    }
  };
  visit(cardJsonOf(cardData).body.elements);
  return out.filter((v) => v !== null);
};
const cardIdsCreated = () =>
  fake.calls.filter((c) => c.method === "card.create").map((c, i) => ({ data: String(c.args.data), index: i }));
const click = (chatId: string, feishuMessageId: string, value: unknown, operator = OWNER, note: string | null = null) =>
  fake.click({ messageId: feishuMessageId, chatId, operatorOpenId: operator, value, formValue: note === null ? null : { note } });
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
    expect(String(avatarUploads[0]!.args.path)).toMatch(new RegExp(`${pmFruitOf(lin.pmId)}\\.webp$`));
    expect(creates[0]!.avatar).toBe(store().avatarKey(pmFruitOf(lin.pmId)));
    expect(store().chatOfTarget({ kind: "router" })).not.toBeNull();
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

  it("应用没开 im:message.group_msg 时所有群按 mention_only，访客权限卡不给切回 auto", async () => {
    fake.granted = [...FEISHU_REQUIRED_SCOPES];
    await connect();
    say(chatOf(lin.pmId), "不 @");
    await settle();
    expect(userMessages(lin.conversationId)).toHaveLength(0);
    join_(chatOf(lin.pmId));
    await settle();
    const policy = cardIdsCreated().find((c) => c.data.includes("访客权限"))!;
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
  it("第一个访客进群时群里发一张访客权限卡；主人点按钮改档位，访客点收到 toast", async () => {
    await connect();
    const chat = chatOf(lin.pmId);
    join_(chat);
    join_(chat, "ou_guest2", "王五");
    await settle();
    const policyCards = cardIdsCreated().filter((c) => c.data.includes("访客权限"));
    expect(policyCards).toHaveLength(1);
    const post = store().postOf({ kind: "chat_policy", pmId: lin.pmId })!;
    const toCollab = { fusa: 1, kind: "set_policy", pmId: lin.pmId, guestTier: "collaborator" };
    expect(click(chat, post.messageId, toCollab, GUEST).toast?.content).toBe("只有主人能改设置");
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
    expect(click(chat, post.messageId, { fusa: 1, kind: "stop", conversationId: lin.conversationId }, GUEST).toast?.content).toBe("正在停");
    fake.resources.set("file_c", Buffer.from("collab file"));
    say(chat, "附件给你", { sender: GUEST, mention: true, files: [{ type: "file", fileKey: "file_c", fileName: "c.txt" }] });
    await settle();
    const m = userMessages(lin.conversationId).find((x) => x.text === "附件给你")!;
    expect((m.meta?.attachments as { name: string }[])[0]!.name).toBe("c.txt");
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

  it("主人点停止调 requestStop，回 toast，这一轮停下后卡片收尾", async () => {
    await connect();
    const stops: ConversationId[] = [];
    ledger.onStopRequested((e) => stops.push(e.conversationId));
    running(lin.sessionId);
    ev(lin.sessionId, { type: "turn.started", at: Date.now() });
    delta(lin.sessionId, "写到一半");
    await settle();
    expect(cardIdsCreated()).toHaveLength(1);
    const response = click(chatOf(lin.pmId), "om_streamcard", { fusa: 1, kind: "stop", conversationId: lin.conversationId });
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

  it("项目经理发的文件、卡片的交付物发成群里的图片和文件消息，同一个文件只传一次", async () => {
    await connect();
    const home = join(root, "out");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "shot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    writeFileSync(join(home, "notes.md"), "# 笔记");
    const text = `看图 [截图](${join(home, "shot.png")}) 和 [笔记](${join(home, "notes.md")})`;
    ev(lin.sessionId, { type: "agent.text", uuid: "files1", text, at: Date.now() });
    await settle();
    const kinds = fake.callsOf("message.create").filter((c) => c.receive_id === chatOf(lin.pmId)).map((c) => c.msg_type);
    expect(kinds).toContain("image");
    expect(kinds).toContain("file");
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
