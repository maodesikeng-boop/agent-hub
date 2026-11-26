import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PmId } from "../../shared/domain.ts";
import { isDeviceId } from "../../shared/api.ts";
import type { FeishuAppId, FeishuCardId, FeishuChatId, FeishuImageKey, FeishuMessageId, FeishuOpenId } from "../../shared/feishu.ts";
import {
  FEISHU_DECISIONS_MAX_ROWS,
  FEISHU_POSTS_MAX_ROWS,
  FEISHU_ROUTER_EVENTS_MAX_ROWS,
  FEISHU_ROUTER_EVENTS_TTL_MS,
  PM_ARCHIVE_RETENTION_MS,
} from "../../shared/limits.ts";
import { createLedger } from "../ledger/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { SlimeLook } from "../../shared/slimes.ts";
import { createFeishuInboundSync } from "./inbound-checkpoint.ts";

const KIWI: SlimeLook = { fruit: "kiwi", color: "kiwi" };
const LIME: SlimeLook = { fruit: "lime", color: "lime" };
import { createFeishuStore, type FeishuStore } from "./store.ts";

let db: Db;
let home: string;
let store: FeishuStore;
let pmA: PmId;
let pmB: PmId;

const APP = "cli_a" as FeishuAppId;
const OWNER = "ou_owner" as FeishuOpenId;
const chat = (s: string) => `oc_${s}` as FeishuChatId;
const om = (s: string) => `om_${s}` as FeishuMessageId;
const count = (table: string) => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;
const saveApp = (appId = APP, ownerOpenId: FeishuOpenId | null = OWNER, botName = "机器人") =>
  store.saveApp({ appId, brand: "feishu", botOpenId: "ou_bot" as FeishuOpenId, botName, ownerOpenId }, 1);

beforeEach(() => {
  db = openTestDb();
  home = mkdtempSync(join(tmpdir(), "feishu-store-"));
  const ledger = createLedger(db, { now: () => 1, pmHomeRoot: home });
  pmA = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" }).pm.id;
  pmB = ledger.createPm({ name: "阿周", mode: "manage_only", persona: "" }).pm.id;
  ledger.close();
  store = createFeishuStore(db);
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const fill = () => {
  saveApp();
  store.upsertChat({ chatId: chat("a"), target: { kind: "pm", pmId: pmA }, name: "小林", label: "小林" }, 1);
  store.savePost({ ref: { kind: "message", messageId: 1, part: 0 }, chatId: chat("a"), messageId: om("1"), cardId: null, sequence: 0, state: "final" }, 1);
  store.saveAvatarKey(KIWI, "img_kiwi" as FeishuImageKey, "h1", 1);
};

describe("createFeishuStore", () => {
  it("saveApp 换了 appId 时四张表在一个事务里清空，主人取入参", () => {
    fill();
    db.run("INSERT INTO feishu_inbound_cursors VALUES (?, ?, ?, ?)", chat("a"), 100, om("in1"), 1);
    const next = saveApp("cli_b" as FeishuAppId, null);
    expect(next).toMatchObject({ appId: "cli_b", ownerOpenId: null });
    expect([count("feishu_chats"), count("feishu_posts"), count("feishu_avatars"), count("feishu_inbound_cursors"), count("feishu_app")]).toEqual([0, 0, 0, 0, 1]);
  });

  it("saveApp 同一个 appId 只更新机器人信息，主人和群保留", () => {
    fill();
    const next = saveApp(APP, "ou_other" as FeishuOpenId, "新名字");
    expect(next).toMatchObject({ botName: "新名字", ownerOpenId: OWNER });
    expect(count("feishu_chats")).toBe(1);
    store.clear();
    saveApp(APP, null);
    expect(saveApp(APP, OWNER).ownerOpenId).toBe(OWNER);
  });

  it("bindOwner 已有主人时原样返回", () => {
    saveApp(APP, null);
    expect(store.bindOwner(OWNER, 2).ownerOpenId).toBe(OWNER);
    expect(store.bindOwner("ou_other" as FeishuOpenId, 3).ownerOpenId).toBe(OWNER);
  });

  it("同一个 target 只有一行；upsertChat 换群编号时清掉旧群的 feishu_posts 和水位、archivedAt 回到 null，唤醒方式和访客档位不动", () => {
    fill();
    store.setChatPolicy(pmA, { triggerMode: "mention_only", guestTier: "observer" }, 2);
    store.advanceWatermark(chat("a"), { messageId: 9 }, 2);
    store.setChatArchived(chat("a"), 500, 3);
    const rebuilt = store.upsertChat({ chatId: chat("a2"), target: { kind: "pm", pmId: pmA }, name: "小林", label: "小林" }, 4);
    expect(rebuilt).toMatchObject({ chatId: "oc_a2", archivedAt: null, lastMessageId: null, triggerMode: "mention_only", guestTier: "observer" });
    expect(count("feishu_chats")).toBe(1);
    expect(store.chatById(chat("a"))).toBeNull();
    store.savePost({ ref: { kind: "message", messageId: 2, part: 0 }, chatId: chat("a2"), messageId: om("2"), cardId: null, sequence: 0, state: "final" }, 4);
    store.upsertChat({ chatId: chat("a3"), target: { kind: "pm", pmId: pmA }, name: "小林", label: "小林" }, 5);
    expect(count("feishu_posts")).toBe(0);
  });

  it("setChatArchived 记下归档时间并删掉这个群的 feishu_posts", () => {
    fill();
    store.setChatArchived(chat("a"), 777, 2);
    expect(store.chatById(chat("a"))?.archivedAt).toBe(777);
    expect(count("feishu_posts")).toBe(0);
  });

  it("setChatPolicy 只改给了的字段，默认 auto / chat_only", () => {
    fill();
    expect(store.chatById(chat("a"))).toMatchObject({ triggerMode: "auto", guestTier: "chat_only" });
    expect(store.setChatPolicy(pmA, { guestTier: "collaborator" }, 2)).toMatchObject({ triggerMode: "auto", guestTier: "collaborator" });
    expect(store.setChatPolicy(pmA, { triggerMode: "mention_only" }, 3)).toMatchObject({ triggerMode: "mention_only", guestTier: "collaborator" });
    expect(() => store.setChatPolicy(pmB, { guestTier: "observer" }, 4)).toThrow();
  });

  it("项目经理删掉后群记录的 pmId 变 null，不跟着删", () => {
    fill();
    const ledger = createLedger(db, { now: () => 1, pmHomeRoot: home });
    ledger.archivePm(pmA);
    expect(ledger.purgeExpiredArchivedPms(1 + PM_ARCHIVE_RETENTION_MS)).toEqual([pmA]);
    ledger.close();
    expect(store.chatById(chat("a"))?.target).toEqual({ kind: "pm", pmId: null });
  });

  it("advanceWatermark 只往大了改", () => {
    fill();
    store.advanceWatermark(chat("a"), { messageId: 10, routerEventId: 3 }, 2);
    store.advanceWatermark(chat("a"), { messageId: 5, routerEventId: 4 }, 3);
    expect(store.chatById(chat("a"))).toMatchObject({ lastMessageId: 10, lastRouterEventId: 4 });
  });

  it("savePost 同一个 ref 覆盖；sequence 比已存的小时抛错", () => {
    fill();
    const ref = { kind: "message" as const, messageId: 5, part: 0 };
    store.savePost({ ref, chatId: chat("a"), messageId: om("5"), cardId: "c1" as FeishuCardId, sequence: 3, state: "streaming" }, 2);
    store.savePost({ ref, chatId: chat("a"), messageId: om("5"), cardId: "c1" as FeishuCardId, sequence: 4, state: "final" }, 3);
    expect(store.postOf(ref)).toMatchObject({ sequence: 4, state: "final", cardId: "c1" });
    expect(() => store.savePost({ ref, chatId: chat("a"), messageId: om("5"), cardId: "c1" as FeishuCardId, sequence: 2, state: "final" }, 4)).toThrow();
  });

  it("postByMessageId 按飞书消息编号找回", () => {
    fill();
    store.savePost({ ref: { kind: "router_item", itemId: 8 }, chatId: chat("a"), messageId: om("ri"), cardId: null, sequence: 0, state: "card_pending" }, 2);
    expect(store.postByMessageId(om("ri"))?.ref).toEqual({ kind: "router_item", itemId: 8 });
    expect(store.postByMessageId(om("none"))).toBeNull();
    expect([...store.pendingCards(pmA)].map((p) => p.ref)).toEqual([{ kind: "router_item", itemId: 8 }]);

    store.upsertChat({ chatId: chat("r"), target: { kind: "router" }, name: "总助", label: "总助" }, 2);
    store.savePost({ ref: { kind: "router_settings" }, chatId: chat("r"), messageId: om("rs1"), cardId: "c_rs" as FeishuCardId, sequence: 1, state: "final" }, 3);
    expect(store.postOf({ kind: "router_settings" })?.messageId).toBe("om_rs1");
    expect(store.postByMessageId(om("rs1"))?.ref).toEqual({ kind: "router_settings" });

    store.savePost({ ref: { kind: "router_ask", messageId: 12 }, chatId: chat("r"), messageId: om("ra1"), cardId: "c_ra" as FeishuCardId, sequence: 0, state: "card_pending" }, 4);
    store.savePost({ ref: { kind: "router_file", messageId: 12, part: 0 }, chatId: chat("r"), messageId: om("ra1"), cardId: "c_ra" as FeishuCardId, sequence: 0, state: "final", mediaKey: "img_x" }, 4);
    expect(store.postByMessageId(om("ra1"))?.ref).toEqual({ kind: "router_ask", messageId: 12 });
    expect([...store.pendingCards(null)].map((p) => p.ref)).toEqual([{ kind: "router_ask", messageId: 12 }]);
  });

  it("reads legacy inbound cursors for active chats and removes them when a chat is deleted", () => {
    fill();
    expect(store.legacyInboundCursors()).toEqual([]);
    db.run("INSERT INTO feishu_inbound_cursors VALUES (?, ?, ?, ?)", chat("a"), 2_000, om("m2"), 2);
    expect(store.legacyInboundCursors()).toEqual([{ chatId: chat("a"), lastInboundAt: 2_000, lastMessageId: om("m2"), updatedAt: 2 }]);
    store.removeChat(chat("a"));
    expect(store.legacyInboundCursors()).toEqual([]);
  });

  it("seeds a missing inbound state file once and leaves legacy SQLite cursors untouched", async () => {
    fill();
    const chatId = chat("a");
    const legacy = { chatId, lastInboundAt: 2_000, lastMessageId: om("m1"), updatedAt: 2 };
    db.run("INSERT INTO feishu_inbound_cursors VALUES (?, ?, ?, ?)", chatId, legacy.lastInboundAt, legacy.lastMessageId, legacy.updatedAt);
    const selfId = "11111111-1111-4111-8111-111111111111";
    if (!isDeviceId(selfId)) throw new Error("Invalid fixture device ID");
    let reads = 0;
    const open = () => createFeishuInboundSync({
      selfId,
      stateFile: join(home, "feishu-inbound.json"),
      initialAppId: APP,
      appCredentials: () => null,
      leaseEpoch: () => null,
      now: () => 3_000,
      log: () => {},
      legacyCursors: () => {
        reads++;
        return store.legacyInboundCursors();
      },
    });
    const upgraded = open();
    expect(upgraded.cursorOf(chatId)).toEqual(legacy);
    upgraded.advanceCursor(chatId, { lastInboundAt: 3_000, lastMessageId: om("m2") });
    await upgraded.close();
    const restarted = open();
    expect(restarted.cursorOf(chatId)?.lastMessageId).toBe(om("m2"));
    expect(reads).toBe(1);
    expect(store.legacyInboundCursors()).toEqual([legacy]);
    await restarted.close();
  });
  it("prunePosts 只删早于 before 的 final / card_settled，等拍板的不删", () => {
    fill();
    store.savePost({ ref: { kind: "message", messageId: 2, part: 0 }, chatId: chat("a"), messageId: om("2"), cardId: null, sequence: 0, state: "card_pending" }, 1);
    store.savePost({ ref: { kind: "message", messageId: 3, part: 0 }, chatId: chat("a"), messageId: om("3"), cardId: null, sequence: 0, state: "card_settled" }, 1);
    store.savePost({ ref: { kind: "message", messageId: 4, part: 0 }, chatId: chat("a"), messageId: om("4"), cardId: null, sequence: 0, state: "final" }, 100);
    store.savePost({ ref: { kind: "chat_policy", pmId: pmA }, chatId: chat("a"), messageId: om("p_old"), cardId: "c_p" as FeishuCardId, sequence: 2, state: "final" }, 1);
    store.upsertChat({ chatId: chat("r"), target: { kind: "router" }, name: "总助", label: "总助" }, 1);
    store.savePost({ ref: { kind: "router_settings" }, chatId: chat("r"), messageId: om("rs_old"), cardId: "c_rs" as FeishuCardId, sequence: 1, state: "final" }, 1);
    expect(store.prunePosts(50)).toBe(2);
    expect(store.postOf({ kind: "message", messageId: 2, part: 0 })?.state).toBe("card_pending");
    expect(store.postOf({ kind: "message", messageId: 4, part: 0 })).not.toBeNull();
    expect(store.postOf({ kind: "chat_policy", pmId: pmA })).toMatchObject({ messageId: om("p_old"), cardId: null, sequence: 2 });
    expect(store.postOf({ kind: "router_settings" })).toMatchObject({ messageId: om("rs_old"), cardId: null, sequence: 1 });
  });

  it("avatarKey / saveAvatarKey 按形象和图片内容哈希存取：哈希对不上（图片换了）当没传过；同一个造型换了颜色是另一个形象", () => {
    expect(store.avatarKey(KIWI, "h1")).toBeNull();
    store.saveAvatarKey(KIWI, "img_1" as FeishuImageKey, "h1", 1);
    store.saveAvatarKey(LIME, "img_2" as FeishuImageKey, "h2", 1);
    expect([store.avatarKey(KIWI, "h1"), store.avatarKey(LIME, "h2")]).toEqual(["img_1", "img_2"]);
    expect(store.avatarKey({ fruit: "kiwi", color: "sky" }, "h1")).toBeNull();
    expect(store.avatarKey(KIWI, "h9")).toBeNull();
    store.saveAvatarKey(KIWI, "img_3" as FeishuImageKey, "h9", 2);
    expect([store.avatarKey(KIWI, "h9"), store.avatarKey(KIWI, "h1")]).toEqual(["img_3", null]);
  });

  it("clearChatAvatars 只把头像是这个形象的群改回没设过，别的形象的群不动；记的是形象键", () => {
    store.upsertChat({ chatId: chat("a"), target: { kind: "pm", pmId: pmA }, name: "小林", label: "小林" }, 1);
    store.upsertChat({ chatId: chat("b"), target: { kind: "pm", pmId: pmB }, name: "阿周", label: "阿周" }, 1);
    store.setChatAvatar(chat("a"), KIWI, 2);
    store.setChatAvatar(chat("b"), LIME, 2);
    store.clearChatAvatars(KIWI, 3);
    expect([store.chatById(chat("a"))?.avatarLook, store.chatById(chat("b"))?.avatarLook]).toEqual([null, LIME]);
    expect(db.get<{ avatar_fruit: string }>("SELECT avatar_fruit FROM feishu_chats WHERE chat_id = ?", chat("b"))?.avatar_fruit).toBe("lime:lime");
    // 0039 之前记的是水果名：读出来当没设过，下一次对齐重设
    db.run("UPDATE feishu_chats SET avatar_fruit = 'lime' WHERE chat_id = ?", chat("b"));
    expect(store.chatById(chat("b"))?.avatarLook).toBeNull();
  });

  it("prunePosts enforces row caps on feishu_posts, feishu_decisions, feishu_router_events and TTL on feishu_router_events", () => {
    fill();
    const now = 1_000_000_000_000;
    const oldTs = now - FEISHU_ROUTER_EVENTS_TTL_MS - 1_000;

    db.transaction(() => {
      for (let i = 0; i < FEISHU_POSTS_MAX_ROWS + 5; i++) {
        db.run(
          `INSERT INTO feishu_posts (ref_kind, ref_id, part, chat_id, message_id, sequence, state, updated_at)
           VALUES ('message', ?, 0, ?, ?, 0, 'final', ?)`,
          100 + i,
          chat("a"),
          om(`p${i}`),
          now - i,
        );
      }
      // Pending card must be spared even when over cap.
      db.run(
        `INSERT INTO feishu_posts (ref_kind, ref_id, part, chat_id, message_id, sequence, state, updated_at)
         VALUES ('message', 999999, 0, ?, ?, 0, 'card_pending', 1)`,
        chat("a"),
        om("pending"),
      );
      for (let i = 0; i < FEISHU_DECISIONS_MAX_ROWS + 4; i++) {
        store.saveDecision({ kind: "ask", askMessageId: 100 + i }, `client-${i}`, "ok", now - i);
      }
      const pmConv = db.get<{ id: number }>("SELECT id FROM conversations WHERE pm_id = ? LIMIT 1", pmA)!;
      db.run(
        "INSERT INTO messages (id, conversation_id, sender, kind, text, dedupe_key, status, created_at, updated_at) VALUES (50001, ?, 'agent', 'text', 'old', 'ask-50001', 'replied', ?, ?)",
        pmConv.id,
        oldTs,
        oldTs,
      );
      db.run(
        "INSERT INTO messages (id, conversation_id, sender, kind, text, dedupe_key, status, created_at, updated_at) VALUES (50002, ?, 'agent', 'text', 'fresh', 'ask-50002', 'replied', ?, ?)",
        pmConv.id,
        now,
        now,
      );
      for (let i = 0; i < FEISHU_ROUTER_EVENTS_MAX_ROWS + 3; i++) {
        db.run("INSERT INTO feishu_router_events (ask_message_id) VALUES (50002)");
      }
      // Insert the TTL-expired ask_message_id event last so it sits inside the newest FEISHU_ROUTER_EVENTS_MAX_ROWS window and is deleted by TTL rather than the row cap.
      db.run("INSERT INTO feishu_router_events (ask_message_id) VALUES (50001)");
    });

    const deleted = store.prunePosts(0, now);
    expect(deleted).toBeGreaterThan(0);
    expect(count("feishu_posts")).toBe(FEISHU_POSTS_MAX_ROWS + 1);
    expect(store.postOf({ kind: "message", messageId: 999999, part: 0 })?.state).toBe("card_pending");
    expect(count("feishu_decisions")).toBe(FEISHU_DECISIONS_MAX_ROWS);
    expect(count("feishu_router_events")).toBe(FEISHU_ROUTER_EVENTS_MAX_ROWS - 1);
    expect(db.get("SELECT id FROM feishu_router_events WHERE ask_message_id = 50001")).toBeUndefined();
  });
});
