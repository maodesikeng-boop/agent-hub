// 账本里输入框相关的部分：手打隐藏的命令被拦（方案第 5 节 9）、/compact 在对话里记一行（26）、
// 输入框找对话的会话和目录（composerTarget）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change, ComposerCommand } from "../../shared/api.ts";
import { ConversationNotFoundError, LedgerRequestError } from "../../shared/ledger.ts";
import { systemNoticeText, type ConversationId, type SessionId } from "../../shared/domain.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";
import { CONTEXT_COMPACTED_TEXT } from "./messages.ts";

let db: Db;
let home: string;
let ledger: SqliteLedger;
let changes: Change[];
let conversationId: ConversationId;
let sessionId: SessionId;

beforeEach(() => {
  db = openTestDb();
  home = mkdtempSync(join(tmpdir(), "agent-hub-ledger-composer-"));
  ledger = createLedger(db, { now: () => 1_000, pmHomeRoot: join(home, "pm-home"), worktreesDir: join(home, "worktrees") });
  const created = ledger.createPm({ name: "项目经理", mode: "manage_only", persona: "" });
  conversationId = created.conversation.id;
  sessionId = created.sessionId;
  changes = [];
  ledger.onChange((c) => changes.push(c));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const messageCount = () => db.get<{ n: number }>("SELECT count(*) AS n FROM messages")!.n;
const actionCount = () => db.get<{ n: number }>("SELECT count(*) AS n FROM actions")!.n;

describe("手打隐藏的命令被拦（9）", () => {
  it("/clear、/model：不存、不登记发送，抛 invalid，原因说用什么代替", () => {
    const before = [messageCount(), actionCount()];
    for (const [text, reason] of [
      ["/clear", /开新会话/],
      ["/reset 换个话题", /开新会话/],
      ["/model opus", /资料页/],
      ["/doctor", /终端/],
    ] as const) {
      let error: unknown;
      try {
        ledger.postUserMessage({ conversationId, clientId: text, text });
      } catch (e) {
        error = e;
      }
      expect(error, text).toBeInstanceOf(LedgerRequestError);
      expect((error as LedgerRequestError).code).toBe("invalid");
      expect((error as LedgerRequestError).message).toMatch(reason);
    }
    expect([messageCount(), actionCount()]).toEqual(before);
    expect(changes).toEqual([]);
  });

  it("别的命令和普通话照常发：/compact、/x、不存在的 /foo、前面有空格的 /clear", () => {
    for (const text of ["/compact", "/x 参数", "/foo bar", " /clear", "please /clear"]) {
      expect(ledger.postUserMessage({ conversationId, clientId: text, text }).messageId).toBeGreaterThan(0);
    }
  });
});

describe("手打命令：缓存里是用户自己的就放行（隐藏名单只管厂商自带的）", () => {
  it("knownCommands 给了列表：用户自己的 /debug 放行，builtin 的 /model、列表里没有的 /reset 拦；没缓存（null）按名字拦，问缓存时带会话的厂商和目录", () => {
    let known: ComposerCommand[] | null = [
      { name: "debug", description: "我的 skill" },
      { name: "model", description: "", builtin: true },
    ];
    const asked: unknown[] = [];
    const testDb = openTestDb();
    const withCache = createLedger(testDb, {
      now: () => 1_000,
      pmHomeRoot: join(home, "pm-home2"),
      worktreesDir: join(home, "worktrees2"),
      knownCommands: (session) => {
        asked.push(session);
        return known;
      },
    });
    const pm = withCache.createPm({ name: "项目经理", mode: "manage_only", persona: "" });
    const post = (text: string) => withCache.postUserMessage({ conversationId: pm.conversation.id, clientId: text, text });
    expect(post("/debug 看看").messageId).toBeGreaterThan(0);
    expect(() => post("/model opus")).toThrow(/资料页/);
    expect(() => post("/reset")).toThrow(/开新会话/);
    const target = withCache.composerTarget(pm.conversation.id);
    expect(asked.at(-1)).toMatchObject({ vendor: target.vendor, cwd: target.cwd, addDirs: target.addDirs });
    known = null;
    expect(() => post("/debug 再来")).toThrow(/^\/debug：/);
    testDb.close();
  });
});

describe("/compact（26）", () => {
  it("context.compacted → 对话里一条只给人看的系统消息“已压缩上下文”；同一个事件重放不记两条；这一轮照常标已回复", () => {
    const { messageId } = ledger.postUserMessage({ conversationId, clientId: "c", text: "/compact" });
    ledger.applyDriverEvent(sessionId, { type: "message.delivered", messageIds: [messageId], at: 1 });
    ledger.applyDriverEvent(sessionId, { type: "message.processing", messageIds: [messageId], at: 2 });
    const compacted = { type: "context.compacted" as const, uuid: "cb-1", trigger: "manual", preTokens: 29305, postTokens: 10321, at: 3 };
    ledger.applyDriverEvent(sessionId, compacted);
    ledger.applyDriverEvent(sessionId, compacted);
    ledger.applyDriverEvent(sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [messageId], durationMs: 5000, at: 4 });
    const messages = ledger.snapshot().conversations.find((c) => c.conversation.id === conversationId)!.messages;
    const system = messages.filter((m) => m.sender === "system");
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({ kind: "text", text: CONTEXT_COMPACTED_TEXT, status: null, meta: { event: "context.compacted", sessionId, uuid: "cb-1", trigger: "manual" } });
    expect(systemNoticeText(system[0]!)).toBe("已压缩上下文");
    expect(messages.find((m) => m.id === messageId)?.status).toBe("replied");
    // 不登记发给 agent 的动作（只给人看）
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM actions WHERE type = 'session.send'")!.n).toBe(1);
  });

  it("commands.changed 账本不管", () => {
    ledger.applyDriverEvent(sessionId, { type: "commands.changed", commands: [{ name: "x", description: "" }], at: 1 });
    expect(changes).toEqual([]);
  });
});

describe("composerTarget", () => {
  it("对话最新一代的会话、厂商、目录；“@”搜工作目录和附加文件夹，不搜项目经理带着的 worktrees 目录", () => {
    const sessions = createSessionStore(db);
    const row = sessions.get(sessionId)!;
    db.run(
      "UPDATE agent_sessions SET cwd = ?, add_dirs = ? WHERE id = ?",
      "/repo/main",
      JSON.stringify(["/repo/other", join(home, "worktrees", "1")]),
      sessionId,
    );
    expect(ledger.composerTarget(conversationId)).toEqual({
      sessionId,
      vendor: row.vendor,
      cwd: "/repo/main",
      addDirs: ["/repo/other", join(home, "worktrees", "1")],
      fileRoots: ["/repo/main", "/repo/other"],
    });
  });

  it("对话不存在：ConversationNotFoundError", () => {
    expect(() => ledger.composerTarget(9999)).toThrow(ConversationNotFoundError);
  });
});

it("driver.warning 通过系统消息可见、重放去重，不登记发给 agent 的动作", () => {
  const before = actionCount();
  const warning = { type: "driver.warning", uuid: "budget-1", message: "agy 规则预算告警", at: 1 } as const;
  ledger.applyDriverEvent(sessionId, warning);
  ledger.applyDriverEvent(sessionId, warning);
  const messages = ledger.snapshot().conversations.find((c) => c.conversation.id === conversationId)!.messages;
  expect(messages.filter((m) => m.text.includes("规则预算告警"))).toHaveLength(1);
  expect(systemNoticeText(messages.find((m) => m.text.includes("规则预算告警"))!)).toBe("agy 规则预算告警");
  expect(actionCount()).toBe(before);
});
