// 账本一侧接的几处（docs/feishu-design.md「骨架文件」末段）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationId, SessionId } from "../../shared/domain.ts";
import { feishuOriginOf, type FeishuMessageOrigin, type FeishuOpenId } from "../../shared/feishu.ts";
import { FEISHU_POST_RETENTION_MS } from "../../shared/limits.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { dataDirReadScope } from "../../shared/write-scope.ts";
import { dataDirDenyList, toolLayerReadScope } from "../driver/write-scope.ts";
import { resolveHubPaths } from "../../shared/paths.ts";
import { deliveryParts } from "../../shared/worker.ts";
import { runRetentionRound } from "../db-retention.ts";
import { createLedger, type SqliteLedger } from "../ledger/index.ts";
import type { Db } from "../store/index.ts";
import { createSessionStore } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { FeishuChatId, FeishuMessageId } from "../../shared/feishu.ts";
import { createFeishuStore } from "./store.ts";

let db: Db;
let home: string;
let ledger: SqliteLedger;
let conversationId: ConversationId;
let sessionId: SessionId;
let clientSeq = 0;

const origin = (patch: Partial<FeishuMessageOrigin> = {}): FeishuMessageOrigin => ({
  kind: "feishu",
  openId: "ou_guest" as FeishuOpenId,
  name: "李四",
  role: "guest",
  mode: "shared",
  guestTier: "chat_only",
  context: [{ name: "张三", role: "owner", text: "先看注册页", at: 1 }],
  ...patch,
});

beforeEach(() => {
  db = openTestDb();
  home = mkdtempSync(join(tmpdir(), "feishu-wiring-"));
  ledger = createLedger(db, { now: () => 1_000, pmHomeRoot: home });
  const created = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
  conversationId = created.conversation.id;
  sessionId = created.sessionId;
});
afterEach(() => {
  ledger.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const post = (o?: FeishuMessageOrigin, text = "帮我看看") =>
  ledger.postUserMessage({ conversationId, clientId: `c${++clientSeq}`, text, ...(o !== undefined ? { origin: o } : {}) }).messageId;
/** 让这条消息成为项目经理正在处理的这一轮。 */
const processing = (messageId: number) => {
  createSessionStore(db).update(sessionId, { status: "running" });
  ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [messageId], at: 1 });
  ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [messageId], at: 1 });
};

describe("账本接线", () => {
  it("postUserMessage 带 origin 时写进 meta.origin，读回一致", () => {
    const id = post(origin());
    expect(feishuOriginOf(ledger.getMessage(id)!)).toEqual(origin());
    expect(ledger.getMessage(post())!.meta).toBeNull();
  });

  it("deliveryParts 按 meta.origin 调 feishuDeliveryPrefixes，网页消息不变", () => {
    const fromFeishu = ledger.getMessage(post(origin()))!;
    const parts = deliveryParts(fromFeishu);
    expect(parts.prefixes[0]).toBe("【飞书 · 李四（访客）】");
    expect(parts.prefixes[1]).toContain("张三（主人）：先看注册页");
    expect(parts.text).toBe("帮我看看");
    const web = ledger.getMessage(post())!;
    expect(deliveryParts(web)).toEqual({ prefixes: [], text: "帮我看看" });
  });

  it("hubCall 查正在处理的那条用户消息的 origin，访客轮次里本档禁用的命令返回 forbidden 和拒绝原因", () => {
    processing(post(origin({ guestTier: "collaborator" })));
    let error: unknown;
    try {
      ledger.hubCall(sessionId, "persona.edit", { text: "改掉" } as never);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LedgerRequestError);
    expect((error as LedgerRequestError).code).toBe("forbidden");
    expect((error as Error).message).toContain("访客");
    // 本档放行的命令照常
    expect(() => ledger.hubCall(sessionId, "status", {} as never)).not.toThrow();
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [], durationMs: 1, at: 2 });
  });

  it("主人的话、网页的话触发的轮次不拦", () => {
    processing(post(origin({ role: "owner", openId: "ou_owner" as FeishuOpenId })));
    let error: unknown = null;
    try {
      ledger.hubCall(sessionId, "persona.edit", { text: "改掉" } as never);
    } catch (e) {
      error = e;
    }
    expect(String((error as Error | null)?.message ?? "")).not.toContain("访客");
  });

  it("messagesAfter 返回编号大于 after 的消息，从小到大，最多 limit 条", () => {
    const ids = [post(), post(), post(), post()];
    expect(ledger.messagesAfter(conversationId, ids[0]!, 2).map((m) => m.id)).toEqual([ids[1], ids[2]]);
    expect(ledger.messagesAfter(conversationId, ids[3]!, 10)).toEqual([]);
    expect(() => ledger.messagesAfter(9999, 0, 1)).toThrow();
  });

  it("Worker 读不到 state/feishu-secrets.json：数据目录读边界不放行 state/，工具层禁读清单里有整个 state/", () => {
    const paths = resolveHubPaths({}, "/Users/u");
    const launchDir = `${paths.launchDir}/7`;
    const scope = dataDirReadScope({ dataDir: paths.home, launchDir });
    expect(scope.readable.some((p) => paths.feishuSecretsFile.startsWith(`${p}/`))).toBe(false);
    expect(dataDirDenyList(toolLayerReadScope(scope, launchDir), (dir) => (dir === paths.home ? ["state", "worktrees"] : []))).toContain(paths.stateDir);
  });

  it("db-retention 每天清理时调 prunePosts，删掉超过 FEISHU_POST_RETENTION_DAYS 的已定稿记录", async () => {
    const store = createFeishuStore(db);
    store.upsertChat({ chatId: "oc_a" as FeishuChatId, target: { kind: "router" }, name: "总助", label: "总助" }, 0);
    store.savePost({ ref: { kind: "router_command", commandId: 1 }, chatId: "oc_a" as FeishuChatId, messageId: "om_1" as FeishuMessageId, cardId: null, sequence: 0, state: "final" }, 0);
    store.savePost({ ref: { kind: "router_item", itemId: 2 }, chatId: "oc_a" as FeishuChatId, messageId: "om_2" as FeishuMessageId, cardId: null, sequence: 0, state: "card_pending" }, 0);
    const log: string[] = [];
    await runRetentionRound({ ledger, db, feishuPosts: store, log: (l) => log.push(l), now: () => FEISHU_POST_RETENTION_MS + 1 });
    expect(store.postOf({ kind: "router_command", commandId: 1 })).toBeNull();
    expect(store.postOf({ kind: "router_item", itemId: 2 })).not.toBeNull();
    expect(log.some((l) => l.includes("飞书"))).toBe(true);
  });
});
