import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceId } from "../../shared/api.ts";
import { parseFeishuChatId, type FeishuChatId } from "../../shared/feishu.ts";
import {
  FEISHU_CARDKIT_MIN_SHARE_PER_SECOND,
  FEISHU_FORWARD_CARD_TIMEOUT_MS,
  FEISHU_MEMBERS_RETRY_MS,
  FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE,
  FEISHU_OFFLINE_INBOX_TTL_MS,
} from "../../shared/limits.ts";
import { createResolveFolder } from "../ledger/files.ts";
import { createLedger } from "../ledger/index.ts";
import { openDatabase } from "../store/db.ts";
import { migrate } from "../store/migrate.ts";
import {
  createFeishuAccountBot,
  createFeishuOfflineInbox,
  feishuCardkitBudgetShare,
  feishuChatOwnerOfDescription,
  feishuForwardedEventSchema,
  feishuOfflineCardToast,
  feishuOfflineNotice,
  routeAccountInbound,
  type FeishuAccountBot,
  type FeishuAccountMeshPort,
  type FeishuForwardedEvent,
  type FeishuLocalInbound,
} from "./account-bot.ts";
import { feishuChatMarker } from "./chats.ts";
import { FEISHU_GROUP_MSG_SCOPE, FEISHU_REQUIRED_SCOPES } from "./scopes.ts";
import { createFeishuService } from "./service.ts";
import { createFeishuStore } from "./store.ts";
import { createFakeFeishu } from "./test-helpers.ts";
import type { FeishuCardActionResponse, FeishuRawCardAction, FeishuRawEvent } from "./transport.ts";

const DEV_A = "11111111-1111-4111-8111-111111111111";
const DEV_B = "22222222-bbbb-4222-8222-222222222222";
const DEV_C = "33333333-3333-4333-8333-333333333333";
const CHAT_B = parseFeishuChatId("oc_chatb1")!;
const CHAT_C = parseFeishuChatId("oc_chatc1")!;
const OWNER = "ou_owner1";

const rawMessage = (chatId: string, messageId: string, content: string, createTime = 1_700_000_000_000): Extract<FeishuRawEvent, { type: "im.message.receive_v1" }> => ({
  type: "im.message.receive_v1",
  messageId,
  chatId,
  chatType: "group",
  senderOpenId: OWNER,
  senderType: "user",
  content,
  mentionedBot: true,
  threadId: null,
  resources: [],
  createTime,
});

const rawCardAction = (chatId: string, messageId = "om_card1"): FeishuRawCardAction => ({
  token: "tok_1",
  messageId,
  chatId,
  operatorOpenId: OWNER,
  value: { fusa: 1, kind: "choose", card: { kind: "ask", askMessageId: 1 }, optionIndex: 0 },
  formValue: null,
});

function memoryDb() {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

describe("feishuChatOwnerOfDescription", () => {
  it("认出 feishuChatMarker 写进群说明的设备编号和项目经理编号", () => {
    const desc = `Fusa（Mac）上的项目经理「小林」。\n${feishuChatMarker(DEV_B, 7)}`;
    expect(feishuChatOwnerOfDescription(desc)).toEqual({ deviceId: DEV_B, pmId: 7 });
    expect(feishuChatOwnerOfDescription(`fusa:bad:pm:9\n${feishuChatMarker(DEV_A, 12)}`)).toEqual({ deviceId: DEV_A, pmId: 12 });
  });

  it("没有标记、标记里的设备编号不合法时回 null", () => {
    expect(feishuChatOwnerOfDescription("")).toBeNull();
    expect(feishuChatOwnerOfDescription("普通飞书群")).toBeNull();
    expect(feishuChatOwnerOfDescription("fusa:not-a-uuid:pm:1")).toBeNull();
    expect(feishuChatOwnerOfDescription(`fusa:${DEV_B.toUpperCase()}:pm:1`)).toBeNull();
    expect(feishuChatOwnerOfDescription(`fusa:${DEV_B}:pm:0`)).toBeNull();
  });
});

describe("routeAccountInbound", () => {
  it("总助单聊回 local", () => {
    expect(routeAccountInbound({ kind: "router" }, DEV_A, () => false)).toEqual({ kind: "local" });
  });

  it("归属本机的群回 local", () => {
    expect(routeAccountInbound({ kind: "device", deviceId: DEV_A, pmId: 1 }, DEV_A, () => false)).toEqual({ kind: "local" });
  });

  it("归属别的设备且在线回 forward，离线回 offline", () => {
    expect(routeAccountInbound({ kind: "device", deviceId: DEV_B, pmId: 1 }, DEV_A, (id) => id === DEV_B)).toEqual({
      kind: "forward",
      deviceId: DEV_B,
    });
    expect(routeAccountInbound({ kind: "device", deviceId: DEV_B, pmId: 1 }, DEV_A, () => false)).toEqual({
      kind: "offline",
      deviceId: DEV_B,
    });
  });

  it("认不出的群回 ignore", () => {
    expect(routeAccountInbound({ kind: "unknown" }, DEV_A, () => true)).toEqual({ kind: "ignore" });
  });
});

describe("feishuCardkitBudgetShare", () => {
  it("按设备数平分向下取整", () => {
    expect(feishuCardkitBudgetShare(40, 3)).toBe(13);
  });

  it("平分后不足 FEISHU_CARDKIT_MIN_SHARE_PER_SECOND 时取下限", () => {
    expect(feishuCardkitBudgetShare(40, 20)).toBe(FEISHU_CARDKIT_MIN_SHARE_PER_SECOND);
  });

  it("设备数小于 1 时按 1 算", () => {
    expect(feishuCardkitBudgetShare(40, 0)).toBe(40);
    expect(feishuCardkitBudgetShare(40, -3)).toBe(40);
  });
});

describe("createFeishuOfflineInbox", () => {
  it("按收到的顺序列出一台的暂存", () => {
    const db = memoryDb();
    const inbox = createFeishuOfflineInbox(db);
    expect(inbox.add(DEV_B, CHAT_B, rawMessage(CHAT_B, "om_1", "第一句"), 100)).toBe("queued");
    expect(inbox.add(DEV_C, CHAT_C, rawMessage(CHAT_C, "om_c1", "别的电脑"), 150)).toBe("queued");
    expect(inbox.add(DEV_B, CHAT_B, rawMessage(CHAT_B, "om_2", "第二句"), 200)).toBe("queued");

    const items = inbox.list(DEV_B);
    expect(items.map((x) => [x.event.type === "im.message.receive_v1" ? x.event.messageId : "", x.receivedAt])).toEqual([
      ["om_1", 100],
      ["om_2", 200],
    ]);
    db.close();
  });

  it("同一条飞书消息只存一次", () => {
    const db = memoryDb();
    const inbox = createFeishuOfflineInbox(db);
    expect(inbox.add(DEV_B, CHAT_B, rawMessage(CHAT_B, "om_dup", "重推"), 100)).toBe("queued");
    expect(inbox.add(DEV_B, CHAT_B, rawMessage(CHAT_B, "om_dup", "重推"), 200)).toBe("duplicate");
    expect(inbox.list(DEV_B)).toHaveLength(1);
    db.close();
  });

  it("一台满 FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE 条后回 full，不存", () => {
    const db = memoryDb();
    const inbox = createFeishuOfflineInbox(db);
    for (let i = 0; i < FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE; i++) {
      expect(inbox.add(DEV_B, CHAT_B, rawMessage(CHAT_B, `om_f${i}`, `第${i}`), 100 + i)).toBe("queued");
    }
    expect(inbox.add(DEV_B, CHAT_B, rawMessage(CHAT_B, "om_f0", "第0"), 999)).toBe("duplicate");
    expect(inbox.add(DEV_B, CHAT_B, rawMessage(CHAT_B, "om_overflow", "超了"), 1000)).toBe("full");
    expect(inbox.list(DEV_B)).toHaveLength(FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE);
    expect(inbox.add(DEV_C, CHAT_C, rawMessage(CHAT_C, "om_other", "另一台不受影响"), 1000)).toBe("queued");
    db.close();
  });

  it("expire 删掉超过 FEISHU_OFFLINE_INBOX_TTL_MS 的，按群返回条数", () => {
    const db = memoryDb();
    const inbox = createFeishuOfflineInbox(db);
    const chatB2 = parseFeishuChatId("oc_chatb2")!;
    const base = 1_000_000;
    inbox.add(DEV_B, CHAT_B, rawMessage(CHAT_B, "om_old1", "旧1"), base);
    inbox.add(DEV_B, CHAT_B, rawMessage(CHAT_B, "om_old2", "旧2"), base + 10);
    inbox.add(DEV_B, chatB2, rawMessage(chatB2, "om_old3", "旧3"), base + 20);
    inbox.add(DEV_B, CHAT_B, rawMessage(CHAT_B, "om_fresh", "新"), base + FEISHU_OFFLINE_INBOX_TTL_MS + 500);

    const expired = inbox.expire(base + FEISHU_OFFLINE_INBOX_TTL_MS + 100);
    expect(expired).toEqual(
      expect.arrayContaining([
        { chatId: CHAT_B, deviceId: DEV_B, count: 2 },
        { chatId: chatB2, deviceId: DEV_B, count: 1 },
      ]),
    );
    expect(inbox.list(DEV_B).map((x) => (x.event.type === "im.message.receive_v1" ? x.event.messageId : ""))).toEqual(["om_fresh"]);
    db.close();
  });
});

describe("createFeishuAccountBot", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  function makeMeshHarness(initialOnline: DeviceId[] = [DEV_B]) {
    const online = new Set<DeviceId>(initialOnline);
    const listeners = new Set<(id: DeviceId) => void>();
    const posts: { id: DeviceId; path: string; body: unknown; timeoutMs: number }[] = [];
    let handler: (id: DeviceId, path: string, body: unknown, timeoutMs: number) => Promise<unknown> = async () => ({});
    const names = new Map<DeviceId, string>([
      [DEV_A, "东京"],
      [DEV_B, "Mac"],
      [DEV_C, "家用机"],
    ]);
    const mesh: FeishuAccountMeshPort = {
      selfId: DEV_A,
      deviceName: (id) => names.get(id) ?? null,
      isOnline: (id) => online.has(id),
      post: async (id, path, body, timeoutMs) => {
        posts.push({ id, path, body, timeoutMs });
        return handler(id, path, body, timeoutMs);
      },
      onOnline: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    return {
      mesh,
      posts,
      setHandler: (fn: typeof handler) => {
        handler = fn;
      },
      setOnline: (id: DeviceId, up: boolean) => {
        const was = online.has(id);
        if (up) online.add(id);
        else online.delete(id);
        if (!was && up) for (const fn of listeners) fn(id);
      },
    };
  }

  function makeFakeLocal(descriptions: Record<string, string | null> = {}) {
    const events: { event: FeishuRawEvent; queuedAt: number | null }[] = [];
    const said: { chatId: FeishuChatId; text: string }[] = [];
    let descCalls = 0;
    let descImpl = async (chatId: FeishuChatId): Promise<string | null> => {
      descCalls++;
      return descriptions[chatId] ?? null;
    };
    const local: FeishuLocalInbound = {
      handleEvent: (event, queuedAt) => {
        events.push({ event, queuedAt });
      },
      handleCardAction: async () => ({ toast: { type: "success", content: "本机已处理" } }),
      say: async (chatId, text) => {
        said.push({ chatId, text });
      },
      chatDescription: (chatId) => descImpl(chatId),
    };
    return {
      local,
      events,
      said,
      descCalls: () => descCalls,
      setDescImpl: (fn: typeof descImpl) => {
        descImpl = async (chatId) => {
          descCalls++;
          return fn(chatId);
        };
      },
    };
  }

  async function makeRealRemoteDevice(deviceId: DeviceId, deviceName: string) {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "acct-bot-")));
    const dataHome = join(root, ".agent-hub");
    mkdirSync(join(dataHome, "state"), { recursive: true });
    const db = openDatabase(join(root, "hub.sqlite"));
    migrate(db);
    const ledger = createLedger(db, {
      pmHomeRoot: join(dataHome, "pm-home"),
      dataHome,
      worktreesDir: join(dataHome, "worktrees"),
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
    const created = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
    const fake = createFakeFeishu();
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    const service = createFeishuService({
      db,
      ledger,
      router: null,
      secretsFile: join(dataHome, "state", "feishu-secrets.json"),
      uploadsDir: join(dataHome, "uploads"),
      sentFilesDir: join(dataHome, "sent-files"),
      device: { id: deviceId, name: deviceName },
      log: () => {},
      createTransport: () => fake,
      register: async ({ handlers }) => {
        handlers.onUrl({ url: "https://open.feishu.cn/qr/b", expiresAt: Date.now() + 600_000 });
        return { brand: "feishu", appId: "cli_shared", appSecret: "sec_shared", scannerOpenId: OWNER };
      },
    });
    await service.start();
    await service.setup.startRegistration();
    await vi.waitFor(() => expect(service.setup.status().state).toBe("connected"));
    await service.idle();
    const chatId = createFeishuStore(db).chatOfTarget({ kind: "pm", pmId: created.pm.id })!.chatId;
    const bot: FeishuAccountBot = createFeishuAccountBot({
      mesh: {
        selfId: deviceId,
        deviceName: () => deviceName,
        isOnline: () => false,
        post: async () => ({}),
        onOnline: () => () => {},
      },
      local: service,
      inbox: null,
      log: () => {},
    });
    service.useAccountBot(bot);
    cleanups.push(async () => {
      bot.close();
      await service.close();
      ledger.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    return { db, ledger, service, bot, pmId: created.pm.id, conversationId: created.conversation.id, sessionId: created.sessionId, chatId };
  }

  it("别的设备的群里的消息经组网转给那台，那台账本里只出现一次", async () => {
    const remote = await makeRealRemoteDevice(DEV_B, "Mac");
    const centerDb = memoryDb();
    cleanups.push(() => centerDb.close());
    const h = makeMeshHarness([DEV_B]);
    h.setHandler(async (id, path, body) => {
      expect(id).toBe(DEV_B);
      expect(path).toBe("/api/peer/feishu/inbound");
      return remote.bot.acceptForwarded(body as FeishuForwardedEvent);
    });
    const localA = makeFakeLocal();
    const centerBot = createFeishuAccountBot({
      mesh: h.mesh,
      local: localA.local,
      inbox: createFeishuOfflineInbox(centerDb),
      log: () => {},
    });
    cleanups.push(() => centerBot.close());
    centerBot.learnChats(DEV_B, [{ chatId: remote.chatId, pmId: remote.pmId }]);

    const msg = rawMessage(remote.chatId, "om_once_1", "把首页修一下");
    centerBot.onEvent(msg);
    centerBot.onEvent(msg);
    await vi.waitFor(() => {
      const msgs = remote.ledger.snapshot().conversations.find((c) => c.conversation.id === remote.conversationId)!.messages;
      expect(msgs.filter((m) => m.sender === "user")).toHaveLength(1);
    });
    await remote.service.idle();
    const userMsgs = remote.ledger.snapshot().conversations.find((c) => c.conversation.id === remote.conversationId)!.messages.filter((m) => m.sender === "user");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]!.text).toBe("把首页修一下");
  });

  it("归属设备离线时立刻在群里回 feishuOfflineNotice，并存进暂存箱", async () => {
    const db = memoryDb();
    cleanups.push(() => db.close());
    const inbox = createFeishuOfflineInbox(db);
    const h = makeMeshHarness([]);
    const localA = makeFakeLocal({ [CHAT_B]: feishuChatMarker(DEV_B, 1) });
    const bot = createFeishuAccountBot({ mesh: h.mesh, local: localA.local, inbox, now: () => 5000, log: () => {} });
    cleanups.push(() => bot.close());

    bot.onEvent(rawMessage(CHAT_B, "om_off_1", "离线吩咐一句"));
    bot.onEvent(rawMessage(CHAT_B, "om_off_1", "离线吩咐一句"));
    await vi.waitFor(() => expect(localA.said).toHaveLength(1));
    expect(localA.said[0]).toEqual({ chatId: CHAT_B, text: feishuOfflineNotice("Mac", true) });
    expect(inbox.list(DEV_B)).toHaveLength(1);
  });

  it("暂存箱为 null（不暂存）时只回离线提示", async () => {
    const h = makeMeshHarness([]);
    const localA = makeFakeLocal({ [CHAT_B]: feishuChatMarker(DEV_B, 1) });
    const bot = createFeishuAccountBot({ mesh: h.mesh, local: localA.local, inbox: null, log: () => {} });
    cleanups.push(() => bot.close());

    bot.onEvent(rawMessage(CHAT_B, "om_no_q", "不暂存测试"));
    await vi.waitFor(() => expect(localA.said).toHaveLength(1));
    expect(localA.said[0]).toEqual({ chatId: CHAT_B, text: feishuOfflineNotice("Mac", false) });
  });

  it("归属设备上线后按顺序送达暂存的消息，带上原来收到的时刻，送达后删掉", async () => {
    const db = memoryDb();
    cleanups.push(() => db.close());
    const inbox = createFeishuOfflineInbox(db);
    const h = makeMeshHarness([]);
    const forwarded: FeishuForwardedEvent[] = [];
    h.setHandler(async (_id, _path, body) => {
      forwarded.push(body as FeishuForwardedEvent);
      return {};
    });
    let clock = 10_000;
    const localA = makeFakeLocal({ [CHAT_B]: feishuChatMarker(DEV_B, 1) });
    const bot = createFeishuAccountBot({ mesh: h.mesh, local: localA.local, inbox, now: () => clock, log: () => {} });
    cleanups.push(() => bot.close());

    bot.onEvent(rawMessage(CHAT_B, "om_q1", "第一句"));
    await vi.waitFor(() => expect(inbox.list(DEV_B)).toHaveLength(1));
    clock = 20_000;
    bot.onEvent(rawMessage(CHAT_B, "om_q2", "第二句"));
    await vi.waitFor(() => expect(inbox.list(DEV_B)).toHaveLength(2));

    clock = 30_000;
    h.setOnline(DEV_B, true);
    await vi.waitFor(() => expect(forwarded).toHaveLength(2));
    expect(forwarded.map((f) => (f.kind === "event" && f.event.type === "im.message.receive_v1" ? [f.event.messageId, f.queuedAt] : []))).toEqual([
      ["om_q1", 10_000],
      ["om_q2", 20_000],
    ]);
    expect(inbox.list(DEV_B)).toHaveLength(0);
  });

  it("转发失败按离线处理", async () => {
    const db = memoryDb();
    cleanups.push(() => db.close());
    const inbox = createFeishuOfflineInbox(db);
    const h = makeMeshHarness([DEV_B]);
    h.setHandler(async () => {
      throw new Error("connection reset");
    });
    const localA = makeFakeLocal({ [CHAT_B]: feishuChatMarker(DEV_B, 1) });
    const bot = createFeishuAccountBot({ mesh: h.mesh, local: localA.local, inbox, now: () => 5000, log: () => {} });
    cleanups.push(() => bot.close());

    bot.onEvent(rawMessage(CHAT_B, "om_fail_1", "半路断了"));
    await vi.waitFor(() => expect(localA.said).toHaveLength(1));
    expect(localA.said[0]!.text).toBe(feishuOfflineNotice("Mac", true));
    expect(inbox.list(DEV_B)).toHaveLength(1);
  });

  it("卡片点击转给归属设备，拿回它算出的 toast", async () => {
    const h = makeMeshHarness([DEV_B]);
    const expectedToast: FeishuCardActionResponse = { toast: { type: "success", content: "已定案" } };
    h.setHandler(async (_id, _path, body) => {
      const parsed = feishuForwardedEventSchema.parse(body);
      expect(parsed).toMatchObject({ kind: "card_action", action: { option: "gpt-6-luna" } });
      return expectedToast;
    });
    const localA = makeFakeLocal({ [CHAT_B]: feishuChatMarker(DEV_B, 1) });
    const bot = createFeishuAccountBot({ mesh: h.mesh, local: localA.local, inbox: null, log: () => {} });
    cleanups.push(() => bot.close());

    expect(await bot.onCardAction({ ...rawCardAction(CHAT_B), option: "gpt-6-luna" })).toEqual(expectedToast);
  });

  it("归属设备超过 FEISHU_FORWARD_CARD_TIMEOUT_MS 没回时 toast 写“已收到，正在处理”", async () => {
    vi.useFakeTimers();
    try {
      const h = makeMeshHarness([DEV_B]);
      let finishPost!: (v: unknown) => void;
      h.setHandler(
        () =>
          new Promise((resolve) => {
            finishPost = resolve;
          }),
      );
      const localA = makeFakeLocal({ [CHAT_B]: feishuChatMarker(DEV_B, 1) });
      const bot = createFeishuAccountBot({ mesh: h.mesh, local: localA.local, inbox: null, log: () => {} });
      cleanups.push(() => bot.close());

      const pending = bot.onCardAction(rawCardAction(CHAT_B));
      await vi.advanceTimersByTimeAsync(FEISHU_FORWARD_CARD_TIMEOUT_MS);
      expect(await pending).toEqual({ toast: { type: "info", content: "已收到，正在处理" } });
      finishPost({ toast: { type: "success", content: "迟到的已定案" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("归属设备离线时卡片点击回离线 toast，不暂存", async () => {
    const db = memoryDb();
    cleanups.push(() => db.close());
    const inbox = createFeishuOfflineInbox(db);
    const h = makeMeshHarness([]);
    const localA = makeFakeLocal({ [CHAT_B]: feishuChatMarker(DEV_B, 1) });
    const bot = createFeishuAccountBot({ mesh: h.mesh, local: localA.local, inbox, log: () => {} });
    cleanups.push(() => bot.close());

    expect(await bot.onCardAction(rawCardAction(CHAT_B))).toEqual(feishuOfflineCardToast("Mac"));
    expect(inbox.list(DEV_B)).toHaveLength(0);
  });

  it("缓存里没有的群调 chatDescription 读标记，读到后缓存", async () => {
    const h = makeMeshHarness([DEV_B]);
    let clock = 1_000;
    const localA = makeFakeLocal({ [CHAT_B]: feishuChatMarker(DEV_B, 2) });
    const bot = createFeishuAccountBot({ mesh: h.mesh, local: localA.local, inbox: null, now: () => clock, log: () => {} });
    cleanups.push(() => bot.close());

    bot.onEvent(rawMessage(CHAT_B, "om_c_1", "一"));
    bot.onEvent(rawMessage(CHAT_B, "om_c_2", "二"));
    await vi.waitFor(() => expect(h.posts).toHaveLength(2));
    expect(localA.descCalls()).toBe(1);

    const unknownChat = parseFeishuChatId("oc_unknown1")!;
    localA.setDescImpl(async () => null);
    bot.onEvent(rawMessage(unknownChat, "om_u_1", "甲"));
    await new Promise((r) => setTimeout(r, 20));
    bot.onEvent(rawMessage(unknownChat, "om_u_2", "乙"));
    await new Promise((r) => setTimeout(r, 20));
    expect(localA.descCalls()).toBe(2);
    clock += FEISHU_MEMBERS_RETRY_MS + 1;
    bot.onEvent(rawMessage(unknownChat, "om_u_3", "丙"));
    await new Promise((r) => setTimeout(r, 20));
    expect(localA.descCalls()).toBe(3);
  });

  it("learnChats 只收广播者自己设备编号的群", async () => {
    const h = makeMeshHarness([DEV_B, DEV_C]);
    const localA = makeFakeLocal();
    const bot = createFeishuAccountBot({ mesh: h.mesh, local: localA.local, inbox: null, log: () => {} });
    cleanups.push(() => bot.close());

    bot.learnChats(DEV_B, [{ chatId: CHAT_B, pmId: 1 }]);
    bot.learnChats(DEV_C, [{ chatId: CHAT_B, pmId: 9 }, { chatId: CHAT_C, pmId: 2, ...({ deviceId: DEV_B } as object) }]);

    bot.onEvent(rawMessage(CHAT_B, "om_learn_1", "发给 B"));
    await vi.waitFor(() => expect(h.posts).toHaveLength(1));
    expect(h.posts[0]!.id).toBe(DEV_B);

    bot.onEvent(rawMessage(CHAT_C, "om_learn_2", "伪造的群"));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.posts).toHaveLength(1);
  });

  it("acceptForwarded 把暂存过的消息标上原来的时刻", async () => {
    const remote = await makeRealRemoteDevice(DEV_B, "Mac");
    const queuedAt = Date.UTC(2026, 10, 19, 6, 2, 0);
    await remote.bot.acceptForwarded({
      kind: "event",
      event: rawMessage(remote.chatId, "om_delayed_1", "昨晚合盖时发的话", queuedAt),
      receivedAt: queuedAt + 3_600_000,
      queuedAt,
    });
    await vi.waitFor(() => {
      const msgs = remote.ledger.snapshot().conversations.find((c) => c.conversation.id === remote.conversationId)!.messages;
      expect(msgs.filter((m) => m.sender === "user")).toHaveLength(1);
    });
    const msg = remote.ledger.snapshot().conversations.find((c) => c.conversation.id === remote.conversationId)!.messages.find((m) => m.sender === "user")!;
    expect(msg.text).toMatch(/^（离线期间 \d{2}-\d{2} \d{2}:\d{2} 发的）\n昨晚合盖时发的话$/);
  });
});

describe("feishuOfflineNotice / feishuOfflineCardToast", () => {
  it("暂存时说先存着、上线后自动交给项目经理，不暂存时说上线后再发，都带设备名", () => {
    const queued = feishuOfflineNotice("Mac", true);
    expect(queued).toContain("Mac");
    expect(queued).toContain("先存着");
    expect(queued).toContain("上线后自动交给项目经理");

    const plain = feishuOfflineNotice("Mac", false);
    expect(plain).toContain("Mac");
    expect(plain).toContain("上线后再发");
    expect(plain).not.toContain("先存着");
  });

  it("卡片 toast 写设备离线、上线后再点", () => {
    const res = feishuOfflineCardToast("Mac");
    expect(res.toast?.content).toContain("Mac");
    expect(res.toast?.content).toContain("离线");
    expect(res.toast?.content).toContain("上线后再点");
  });
});
import type { CenterLease } from "../mesh/lease.ts";
import type { DeviceFingerprint, MeshApprovalView } from "../../shared/mesh.ts";
import { decodeFeishuActionValue, type FeishuCardJson } from "./cards.ts";
import { readFeishuSecrets } from "./secrets.ts";

describe("createFeishuService：中心租约、凭证同步与新电脑加入卡", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  function makeFakeLease(initialHolding: boolean) {
    let holding = initialHolding;
    const listeners = new Set<(holder: DeviceId | null) => void>();
    const lease: CenterLease = {
      holding: () => holding,
      holder: () => (holding ? DEV_B : DEV_A),
      refresh: () => {},
      onChange: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      close: async () => {},
    };
    return {
      lease,
      setHolding: (next: boolean) => {
        holding = next;
        for (const fn of listeners) fn(holding ? DEV_B : DEV_A);
      },
    };
  }

  function makeNode(deviceId: DeviceId, deviceName: string, fake: ReturnType<typeof createFakeFeishu>, opts: { lease?: CenterLease; mesh?: Parameters<typeof createFeishuService>[0]["mesh"] } = {}) {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "svc-mesh-")));
    const dataHome = join(root, ".agent-hub");
    mkdirSync(join(dataHome, "state"), { recursive: true });
    const secretsFile = join(dataHome, "state", "feishu-secrets.json");
    const db = openDatabase(join(root, "hub.sqlite"));
    migrate(db);
    const ledger = createLedger(db, {
      pmHomeRoot: join(dataHome, "pm-home"),
      dataHome,
      worktreesDir: join(dataHome, "worktrees"),
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
    const created = ledger.createPm({ name: `项目-${deviceName}`, mode: "manage_only", persona: "" });
    const service = createFeishuService({
      db,
      ledger,
      router: {
        submitCommand: async ({ clientId, text }) =>
          ledger.createRouterCommand({ clientId, inputText: text, vendor: "claude", status: "answered", plan: { intent: "answer", reply: `${deviceName}总助已回`, actions: [] } }).command,
      },
      secretsFile,
      uploadsDir: join(dataHome, "uploads"),
      sentFilesDir: join(dataHome, "sent-files"),
      device: { id: deviceId, name: deviceName },
      ...(opts.lease ? { lease: opts.lease } : {}),
      ...(opts.mesh ? { mesh: opts.mesh } : {}),
      log: () => {},
      createTransport: () => fake,
      register: async ({ handlers }) => {
        handlers.onUrl({ url: "https://open.feishu.cn/qr/m", expiresAt: Date.now() + 600_000 });
        return { brand: "feishu", appId: "cli_shared1", appSecret: "sec_shared_xyz", scannerOpenId: OWNER };
      },
    });
    cleanups.push(async () => {
      await service.close();
      ledger.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    return { db, ledger, service, secretsFile, pmId: created.pm.id, conversationId: created.conversation.id };
  }

  it("非中心不连 WSClient、不把总助对话发到单聊，但照常给本机项目建群并直发出站；接过租约后连上长连接并投影总助", async () => {
    const fakeA = createFakeFeishu();
    fakeA.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    const fakeB = createFakeFeishu();
    fakeB.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    const leaseA = makeFakeLease(true);
    const leaseB = makeFakeLease(false);

    const nodeA = makeNode(DEV_A, "东京", fakeA, { lease: leaseA.lease });
    const nodeB = makeNode(DEV_B, "Mac", fakeB, { lease: leaseB.lease });
    await nodeA.service.start();
    await nodeB.service.start();

    await nodeA.service.setup.startRegistration();
    await vi.waitFor(() => expect(nodeA.service.setup.status().state).toBe("connected"));
    await nodeA.service.idle();
    expect(fakeA.handlers).not.toBeNull();

    const exported = nodeA.service.exportPeerApp()!;
    expect(exported.kind).toBe("configured");
    await nodeB.service.applyPeerApp(exported);
    await nodeB.service.idle();

    expect(fakeB.handlers).toBeNull();
    expect(await readFeishuSecrets(nodeB.secretsFile)).toEqual({ brand: "feishu", appId: "cli_shared1", appSecret: "sec_shared_xyz" });
    expect(nodeB.service.setup.status().state).toBe("connected");
    expect(nodeB.service.localPmChats()).toHaveLength(1);

    const sentBefore = fakeB.sent.length;
    const cmdB1 = nodeB.ledger.createRouterCommand({ clientId: "web-b-1", inputText: "非中心测试", vendor: "claude", status: "planning" }).command;
    nodeB.ledger.updateRouterCommand(cmdB1.id, { status: "answered", plan: { intent: "answer", reply: "不该进单聊", actions: [] } });
    await nodeB.service.idle();
    expect(fakeB.sent).toHaveLength(sentBefore);

    nodeB.ledger.postUserMessage({ conversationId: nodeB.conversationId, clientId: "web-pm-b", text: "本机项目消息" });
    await nodeB.service.idle();
    expect(fakeB.sent.some((s) => s.content.includes("本机项目消息"))).toBe(true);

    leaseA.setHolding(false);
    await nodeA.service.syncLeaseConnection();
    expect(fakeA.handlers).toBeNull();

    leaseB.setHolding(true);
    await nodeB.service.syncLeaseConnection();
    await nodeB.service.idle();
    expect(fakeB.handlers).not.toBeNull();
    expect(fakeB.sent.some((s) => s.content.includes("已接上飞书"))).toBe(false);

    const cmdB2 = nodeB.ledger.createRouterCommand({ clientId: "web-b-2", inputText: "接管后的指令", vendor: "claude", status: "planning" }).command;
    nodeB.ledger.updateRouterCommand(cmdB2.id, { status: "answered", plan: { intent: "answer", reply: "B总助接管回复", actions: [] } });
    await nodeB.service.idle();
    expect(fakeB.sent.some((s) => s.content.includes("B总助接管回复"))).toBe(true);
    expect(fakeB.sent.some((s) => s.content.includes("不该进单聊"))).toBe(false);

    await nodeA.service.setup.disconnect({ dissolveChats: false });
    await nodeB.service.applyPeerApp(nodeA.service.exportPeerApp()!);
    expect(nodeB.service.setup.status().state).toBe("unconfigured");
    expect(await readFeishuSecrets(nodeB.secretsFile)).toBeNull();
  });

  it("中心往总助单聊发新电脑请求加入卡，点核对和一致驱动组网批准并把卡片改成已加入", async () => {
    const fake = createFakeFeishu();
    fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
    const fp = "b".repeat(64) as DeviceFingerprint;
    let approvals: MeshApprovalView[] = [];
    const joinedIds = new Set<string>([DEV_A]);
    const meshListeners = new Set<() => void>();
    const calls: string[] = [];

    const node = makeNode(DEV_A, "东京", fake, {
      mesh: {
        activeDevices: () => joinedIds.size,
        onAppChanged: () => {},
        onChatsSynced: () => {},
        approvals: () => ({ approvals, joinedIds }),
        beginApproval: async (id) => {
          calls.push(`begin:${id}`);
          approvals = approvals.map((a) => (a.requestId === id ? { ...a, sas: "042917" } : a));
          for (const fn of meshListeners) fn();
        },
        answerApproval: async (id, match) => {
          calls.push(`answer:${id}:${String(match)}`);
          approvals = [];
          if (match) joinedIds.add(id);
          for (const fn of meshListeners) fn();
        },
        onChange: (fn) => {
          meshListeners.add(fn);
          return () => meshListeners.delete(fn);
        },
      },
    });
    await node.service.start();
    await node.service.setup.startRegistration();
    await vi.waitFor(() => expect(node.service.setup.status().state).toBe("connected"));
    await node.service.idle();

    approvals = [
      {
        requestId: DEV_C,
        device: { id: DEV_C, name: "家用机", platform: "win32", fingerprint: fp },
        requestedAt: 1000,
        expiresAt: 601_000,
        sas: null,
      },
    ];
    for (const fn of meshListeners) fn();
    await node.service.idle();

    const createdEntry = [...fake.cards.entries()].find(([, json]) => json.includes("家用机"))!;
    expect(createdEntry).toBeDefined();
    const [cardId, initialJson] = createdEntry;
    const sentMsg = fake.sent.find((s) => s.content.includes(cardId))!;
    const beginBtn = (JSON.parse(initialJson) as FeishuCardJson).body.elements.find((e) => e.tag === "button")!;
    const beginVal = ((beginBtn.behaviors as { value: unknown }[])[0]!).value;
    expect(decodeFeishuActionValue(beginVal)).toEqual({ kind: "mesh_approval", step: "begin", requestId: DEV_C });

    const r1 = await fake.click({
      token: "t_begin",
      messageId: sentMsg.messageId,
      chatId: sentMsg.chatId,
      operatorOpenId: OWNER,
      value: beginVal,
      formValue: null,
    });
    expect(r1.toast?.content).toContain("核对码");
    await vi.waitFor(() => expect(calls).toContain(`begin:${DEV_C}`));
    await node.service.idle();

    const sasUpdate = fake.callsOf("card.update").find((u) => u.card_id === cardId && u.card.data.includes("042 917"))!;
    expect(sasUpdate).toBeDefined();
    const matchBtn = (JSON.parse(sasUpdate.card.data) as FeishuCardJson).body.elements.find(
      (e) => e.tag === "button" && (e.text as { content: string }).content === "一致",
    )!;
    const matchVal = ((matchBtn.behaviors as { value: unknown }[])[0]!).value;

    const r2 = await fake.click({
      token: "t_match",
      messageId: sentMsg.messageId,
      chatId: sentMsg.chatId,
      operatorOpenId: OWNER,
      value: matchVal,
      formValue: null,
    });
    expect(r2.toast?.content).toContain("一致");
    await vi.waitFor(() => expect(calls).toContain(`answer:${DEV_C}:true`));
    await node.service.idle();

    const finalUpdate = fake.callsOf("card.update").filter((u) => u.card_id === cardId).at(-1)!;
    expect(finalUpdate.card.data).toContain("已加入");
  });
});
