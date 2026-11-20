// 双机组网：Tokyo 持飞书中心租约，MacBook Pro 非中心跑项目经理。Mac 账本里的总助卡片要由 Mac 直发共享总助单聊，
// 用户在单聊里点按钮经 Tokyo 转回 Mac 结案；欢迎语和新电脑加入卡只由中心发一次。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceId } from "../../shared/api.ts";
import { askOf, type MessageId, type PmId, type SessionId, type WorkerId } from "../../shared/domain.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import type { DeviceFingerprint, MeshApprovalView } from "../../shared/mesh.ts";
import { AGENT_VENDORS } from "../../shared/vendors.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { createModelCatalogs, type ModelCatalogs } from "../driver/model-catalog.ts";
import { createResolveFolder } from "../ledger/files.ts";
import { createLedger, type SqliteLedger } from "../ledger/index.ts";
import type { CenterLease } from "../mesh/lease.ts";
import { openDatabase } from "../store/db.ts";
import { createSessionStore, type Db } from "../store/index.ts";
import { migrate } from "../store/migrate.ts";
import { createFeishuAccountBot, feishuForwardedEventSchema, type FeishuAccountBot, type FeishuAccountMeshPort } from "./account-bot.ts";
import { decodeFeishuActionValue, type FeishuCardJson } from "./cards.ts";
import { FEISHU_GROUP_MSG_SCOPE, FEISHU_REQUIRED_SCOPES } from "./scopes.ts";
import { createFeishuService, type FeishuService, type FeishuServiceMeshHooks } from "./service.ts";
import { createFeishuStore, type FeishuPostRef } from "./store.ts";
import { createFakeFeishu, type FakeFeishu } from "./test-helpers.ts";

const TOKYO = "11111111-1111-4111-8111-111111111111" as DeviceId;
const MAC = "22222222-bbbb-4222-8222-222222222222" as DeviceId;
const JOINER = "33333333-3333-4333-8333-333333333333";
const OWNER = "ou_owner1";
const NAMES: Record<string, string> = { [TOKYO]: "Tokyo", [MAC]: "MacBook Pro" };

interface Node {
  db: Db;
  ledger: SqliteLedger;
  service: FeishuService;
  root: string;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  meshListeners.clear();
  while (cleanups.length > 0) await cleanups.pop()!();
});

const lease = (holding: boolean): CenterLease => ({ holding: () => holding, holder: () => TOKYO, refresh: () => {}, onChange: () => () => {}, close: async () => {} });

const meshListeners = new Set<() => void>();

function approvalHooks(): FeishuServiceMeshHooks {
  const approval: MeshApprovalView = {
    requestId: JOINER,
    device: { id: JOINER, name: "家用机", platform: "win32", fingerprint: "b".repeat(64) as DeviceFingerprint },
    requestedAt: 1000,
    expiresAt: 601_000,
    sas: null,
  };
  return {
    activeDevices: () => 2,
    onAppChanged: () => {},
    onChatsSynced: () => {},
    approvals: () => ({ approvals: [approval], joinedIds: new Set([TOKYO, MAC]) }),
    beginApproval: async () => {},
    answerApproval: async () => {},
    onChange: (fn) => {
      meshListeners.add(fn);
      return () => meshListeners.delete(fn);
    },
  };
}

function makeNode(deviceId: DeviceId, fake: FakeFeishu, holding: boolean, models?: ModelCatalogs): Node {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "router-mesh-")));
  const dataHome = join(root, ".agent-hub");
  mkdirSync(join(dataHome, "state"), { recursive: true });
  const db = openDatabase(join(root, "hub.sqlite"));
  migrate(db);
  const ledger = createLedger(db, {
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    userHome: root,
    osSandboxed: () => true,
    worktreesDir: join(dataHome, "worktrees"),
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    ...(models ? { models } : {}),
  });
  const service = createFeishuService({
    db,
    ledger,
    ...(models ? { models } : {}),
    router: null,
    secretsFile: join(dataHome, "state", "feishu-secrets.json"),
    uploadsDir: join(dataHome, "uploads"),
    sentFilesDir: join(dataHome, "sent-files"),
    device: { id: deviceId, name: NAMES[deviceId]! },
    lease: lease(holding),
    mesh: approvalHooks(),
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
  return { db, ledger, service, root };
}

function makeRepo(node: Node, name: string): string {
  const repo = join(node.root, name);
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  git("init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git("add", ".");
  git("commit", "-m", "init");
  return repo;
}

function finishWorkerTurn(node: Node, workerId: WorkerId) {
  const ws = node.db.get<{ id: SessionId; conversation_id: number }>(
    "SELECT id, conversation_id FROM agent_sessions WHERE worker_id = ? ORDER BY generation DESC LIMIT 1",
    workerId,
  )!;
  const input = node.db.get<{ id: MessageId }>("SELECT id FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') ORDER BY id DESC LIMIT 1", ws.conversation_id)!;
  const sessions = createSessionStore(node.db);
  sessions.update(ws.id, { status: "running", pid: 60_000 + workerId });
  const at = Date.now();
  const report = [REPORT_START, "状态: 做完了", "摘要: 方案就绪", "提交: 无", "PR: 无", "测试: 无", "偏离: 无", "交棒: 无", "文件: 无", "问题: 无", REPORT_END].join("\n");
  node.ledger.applyDriverEvent(ws.id, { type: "message.delivered", messageIds: [input.id], at });
  node.ledger.applyDriverEvent(ws.id, { type: "message.processing", messageIds: [input.id], at: at + 1 });
  node.ledger.applyDriverEvent(ws.id, { type: "agent.text", uuid: `w-${workerId}`, text: report, at: at + 2 });
  node.ledger.applyDriverEvent(ws.id, { type: "turn.ended", ok: true, interrupted: false, messageIds: [input.id], durationMs: 10, at: at + 3 });
  sessions.update(ws.id, { status: "ended", pid: null });
}

async function twoDevices() {
  const fake = createFakeFeishu();
  fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
  const models = createModelCatalogs({
    sources: Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, { parse: () => null, query: async () => null, availabilityOf: () => (vendor === "claude" ? "signed_out" : "available") }])),
    log: () => {},
  });
  models.report("claude", "signed_out");
  cleanups.push(() => models.close());
  const tokyo = makeNode(TOKYO, fake, true);
  const mac = makeNode(MAC, fake, false, models);
  const online = { mac: true };
  const forwarded: DeviceId[] = [];
  const bots = new Map<DeviceId, FeishuAccountBot>();
  const meshOf = (selfId: DeviceId): FeishuAccountMeshPort => ({
    selfId,
    deviceName: (id) => NAMES[id] ?? null,
    isOnline: (id) => (id === MAC ? online.mac : true),
    post: async (id, _path, body) => {
      forwarded.push(id);
      return bots.get(id)!.acceptForwarded(feishuForwardedEventSchema.parse(body));
    },
    onOnline: () => () => {},
  });
  for (const [id, node] of [[TOKYO, tokyo], [MAC, mac]] as const) {
    const bot = createFeishuAccountBot({ mesh: meshOf(id), local: node.service, inbox: null, log: () => {} });
    bots.set(id, bot);
    node.service.useAccountBot(bot);
    cleanups.push(() => bot.close());
  }
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      for (const node of [tokyo, mac]) {
        await node.ledger.settleDriverEvents();
        await node.service.idle();
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await tokyo.service.start();
  await mac.service.start();
  await tokyo.service.setup.startRegistration();
  await vi.waitFor(() => expect(tokyo.service.setup.status().state).toBe("connected"));
  await settle();
  await mac.service.applyPeerApp(tokyo.service.exportPeerApp()!);
  await settle();
  for (const fn of meshListeners) fn();
  await settle();
  const routerChatId = createFeishuStore(tokyo.db).chatOfTarget({ kind: "router" })!.chatId;
  return { fake, tokyo, mac, models, online, forwarded, settle, routerChatId };
}

type Devices = Awaited<ReturnType<typeof twoDevices>>;

const postOf = (node: Node, ref: FeishuPostRef) => createFeishuStore(node.db).postOf(ref);
const cardJson = (fake: FakeFeishu, cardId: string | null) => JSON.parse(fake.cards.get(cardId!)!) as FeishuCardJson;
const titleOf = (card: FeishuCardJson) => (card.header?.title as { content: string }).content;

function buttonValues(card: FeishuCardJson): unknown[] {
  const out: unknown[] = [];
  const walk = (elements: Record<string, unknown>[]) => {
    for (const el of elements) {
      if (el.tag === "button") {
        const callback = (el.behaviors as { type: string; value?: unknown }[]).find((b) => b.type === "callback");
        if (callback !== undefined) out.push(callback.value);
      }
      if (Array.isArray(el.elements)) walk(el.elements as Record<string, unknown>[]);
    }
  };
  walk(card.body.elements);
  return out;
}

const routerItemOfAsk = (node: Node, askId: MessageId) => node.db.get<{ id: number }>("SELECT id FROM router_items WHERE ask_message_id = ?", askId)!.id;

function macProject(devices: Devices, name: string): { pmId: PmId; sessionId: SessionId } {
  const created = devices.mac.ledger.createPm({ name, mode: "manage_only", persona: "", folder: makeRepo(devices.mac, name) });
  return { pmId: created.pm.id, sessionId: created.sessionId };
}

async function raiseMacGate(devices: Devices, pm: { sessionId: SessionId }) {
  const graph = devices.mac.ledger.hubCall(pm.sessionId, "graph.create", {
    specJson: JSON.stringify({ title: "检查点图", steps: [{ key: "design", title: "写方案", brief: "出方案", vendor: "codex", confirm: true }] }),
  }).data.graph;
  finishWorkerTurn(devices.mac, graph.nodes[0]!.activeWorkerId!);
  await devices.settle();
  return devices.mac.ledger.hubCall(pm.sessionId, "graph.show", { graphId: graph.id }).data.graph.nodes[0]!.gateAskMessageId!;
}

function click(devices: Devices, messageId: string, value: unknown) {
  return devices.fake.click({ token: "tok", messageId, chatId: devices.routerChatId, operatorOpenId: OWNER, value, formValue: null });
}

describe("双机组网下的总助单聊", () => {
  it("非中心 Mac 账本里的简报、拍板卡、检查点卡、阻塞卡都由 Mac 直发共享总助单聊并带上项目名和发卡设备；欢迎语与新电脑加入卡只有中心发一次", async () => {
    const devices = await twoDevices();
    const { fake, mac, tokyo, routerChatId } = devices;
    const hub = macProject(devices, "agent-hub");
    const site = macProject(devices, "官网");
    await devices.settle();

    mac.ledger.hubCall(hub.sessionId, "router.report", { summary: "Mac 登录页做完了" } as never);
    const askId = mac.ledger.hubCall(hub.sessionId, "ask", { text: "Mac 发版吗？", options: ["发", "不发"] }).data.messageId;
    const gateAskId = await raiseMacGate(devices, hub);
    mac.ledger.hubCall(site.sessionId, "graph.create", { specJson: JSON.stringify({ title: "阻塞图", steps: [{ key: "s1", title: "第一步", brief: "做", vendor: "claude" }] }) });
    await devices.settle();
    const blockerAskId = mac.db.get<{ message_id: MessageId }>("SELECT message_id FROM user_blocker_cards")!.message_id;

    const reportItem = mac.db.get<{ id: number }>("SELECT id FROM router_items WHERE kind = 'report'")!.id;
    const posts = {
      report: postOf(mac, { kind: "router_item", itemId: reportItem }),
      decision: postOf(mac, { kind: "router_item", itemId: routerItemOfAsk(mac, askId) }),
      gate: postOf(mac, { kind: "router_ask", messageId: gateAskId }),
      blocker: postOf(mac, { kind: "router_ask", messageId: blockerAskId }),
    };
    for (const post of Object.values(posts)) {
      expect(post?.chatId).toBe(routerChatId);
      expect(fake.sent.some((s) => s.messageId === post!.messageId && s.chatId === routerChatId)).toBe(true);
    }
    expect(titleOf(cardJson(fake, posts.report!.cardId))).toBe("简报 · agent-hub");
    expect(titleOf(cardJson(fake, posts.decision!.cardId))).toBe("等你确定 · agent-hub");
    expect(titleOf(cardJson(fake, posts.gate!.cardId))).toBe("检查点 · agent-hub");
    expect(titleOf(cardJson(fake, posts.blocker!.cardId))).toBe("要你动手 · 官网");
    for (const post of [posts.decision, posts.gate, posts.blocker]) {
      const values = buttonValues(cardJson(fake, post!.cardId)).map(decodeFeishuActionValue);
      expect(values.length).toBeGreaterThan(0);
      expect(values.every((v) => v !== null && "d" in v && v.d === MAC)).toBe(true);
    }
    expect([...createFeishuStore(tokyo.db).pendingCards(null)]).toEqual([]);

    expect(fake.sent.filter((s) => s.content.includes("已接上飞书"))).toHaveLength(1);
    expect([...fake.cards.values()].filter((json) => json.includes("家用机"))).toHaveLength(1);
  });

  it("在总助单聊点 Mac 发的拍板卡、检查点卡：Tokyo 按按钮里的设备转给 Mac 结案并改卡；Mac 离线回离线提示；不带设备的旧卡仍由 Tokyo 本地处理", async () => {
    const devices = await twoDevices();
    const { fake, mac, routerChatId } = devices;
    const hub = macProject(devices, "agent-hub");
    await devices.settle();

    const askId = mac.ledger.hubCall(hub.sessionId, "ask", { text: "Mac 发版吗？", options: ["发", "不发"] }).data.messageId;
    await devices.settle();
    const decision = postOf(mac, { kind: "router_item", itemId: routerItemOfAsk(mac, askId) })!;
    const [choose] = buttonValues(cardJson(fake, decision.cardId));
    expect((await click(devices, decision.messageId, choose)).toast?.type).toBe("success");
    await devices.settle();
    expect(devices.forwarded).toEqual([MAC]);
    expect(askOf(mac.ledger.getMessage(askId)!)?.answered).toBe(true);
    expect(postOf(mac, { kind: "router_item", itemId: routerItemOfAsk(mac, askId) })?.state).toBe("card_settled");
    expect(fake.callsOf("card.update").filter((u) => u.card_id === decision.cardId).at(-1)?.card.data).toContain("已定案");

    const gateAskId = await raiseMacGate(devices, hub);
    const gate = postOf(mac, { kind: "router_ask", messageId: gateAskId })!;
    const [pass] = buttonValues(cardJson(fake, gate.cardId));
    expect((await click(devices, gate.messageId, pass)).toast?.type).toBe("success");
    await devices.settle();
    expect(askOf(mac.ledger.getMessage(gateAskId)!)?.answered).toBe(true);
    expect(postOf(mac, { kind: "router_ask", messageId: gateAskId })?.state).toBe("card_settled");

    const laterAsk = mac.ledger.hubCall(hub.sessionId, "ask", { text: "Mac 再确认一次？", options: ["好", "不好"] }).data.messageId;
    await devices.settle();
    const later = postOf(mac, { kind: "router_item", itemId: routerItemOfAsk(mac, laterAsk) })!;
    const [laterChoose] = buttonValues(cardJson(fake, later.cardId));
    devices.online.mac = false;
    const offline = await click(devices, later.messageId, laterChoose);
    expect(offline.toast).toEqual({ type: "warning", content: "「MacBook Pro」离线，上线后再点" });
    expect(askOf(mac.ledger.getMessage(laterAsk)!)?.answered).not.toBe(true);

    const { d: _issuer, ...legacy } = decodeFeishuActionValue(laterChoose) as { d?: string };
    devices.online.mac = true;
    const stale = await click(devices, later.messageId, { fusa: 1, ...legacy });
    expect(stale.toast?.type).toBe("warning");
    expect(devices.forwarded).toEqual([MAC, MAC]);
    expect(askOf(mac.ledger.getMessage(laterAsk)!)?.answered).not.toBe(true);
    expect(routerChatId).toBe("oc_p2p" as FeishuChatId);
  });
});
