// “等你确定”（hub ask）什么时候算回答了：用户在这个项目经理的对话里发一条消息，守护进程就把之前没回答的提问标成已回答
// （meta.answered），几个标签页、重启后都一致。项目经理自己说的、Worker 的汇报、系统消息、别的对话里的消息都不算。
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import { askOf } from "../../shared/domain.ts";
import type { ConversationId, MessageId, PmId, SessionId } from "../../shared/domain.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { openDatabase } from "../store/db.ts";
import type { Db } from "../store/index.ts";
import { migrate } from "../store/migrate.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import type { LedgerOptions, SqliteLedger } from "./index.ts";

let root: string;
let dbFile: string;
let db: Db;
let ledger: SqliteLedger;
let changes: Change[];
let now: number;
let clientSeq: number;
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
let zhou: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

function options(): LedgerOptions {
  const dataHome = join(root, ".agent-hub");
  return {
    now: () => now,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir: join(dataHome, "worktrees"),
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
  };
}

function open(): void {
  db = openDatabase(dbFile);
  migrate(db);
  ledger = createLedger(db, options());
  changes = [];
  ledger.onChange((c) => changes.push(c));
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-asks-")));
  dbFile = join(root, "hub.sqlite");
  now = 1_000;
  clientSeq = 0;
  open();
  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
  const b = ledger.createPm({ name: "阿周", mode: "manage_only", persona: "" });
  lin = { pmId: a.pm.id, conversationId: a.conversation.id, sessionId: a.sessionId };
  zhou = { pmId: b.pm.id, conversationId: b.conversation.id, sessionId: b.sessionId };
  changes = [];
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const ask = (text: string, who = lin): MessageId => ledger.hubCall(who.sessionId, "ask", { text }).data.messageId;
const post = (conversationId: ConversationId, text = "好的"): MessageId =>
  ledger.postUserMessage({ conversationId, clientId: `c${++clientSeq}`, text }).messageId;
const answered = (id: MessageId): boolean => askOf(ledger.getMessage(id)!)?.answered === true;
const messagesIn = (conversationId: ConversationId) =>
  db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", conversationId).map((r) => ledger.getMessage(r.id)!);

describe("用户发消息就算回答了", () => {
  it("之前没回答的提问都标成已回答，推 message.updated", () => {
    const a = ask("用 A 还是 B？");
    const b = ask("要不要发版？");
    expect([answered(a), answered(b)]).toEqual([false, false]);
    changes = [];
    post(lin.conversationId, "A，发");
    expect([answered(a), answered(b)]).toEqual([true, true]);
    const updated = changes.flatMap((c) => (c.type === "message.updated" ? [c.data.message.id] : []));
    expect(updated.sort()).toEqual([a, b].sort());
    expect(askOf(ledger.getMessage(a)!)).toEqual({ needsUser: true, answered: true });
  });

  it("发消息之后才问的不算回答；已经回答过的不再推变化", () => {
    const a = ask("问 1");
    post(lin.conversationId);
    const b = ask("问 2");
    expect([answered(a), answered(b)]).toEqual([true, false]);
    changes = [];
    post(lin.conversationId);
    const updated = changes.flatMap((c) => (c.type === "message.updated" ? [c.data.message.id] : []));
    expect(updated).toEqual([b]);
  });

  it("同一条消息重发（同一个 clientId）不重复处理", () => {
    const a = ask("问");
    ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "same", text: "好" });
    changes = [];
    ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "same", text: "好" });
    expect(answered(a)).toBe(true);
    expect(changes).toEqual([]);
  });
});

describe("不算回答", () => {
  it("项目经理自己说的话", () => {
    const a = ask("问");
    ledger.applyDriverEvent(lin.sessionId, { type: "agent.text", uuid: "pm-1", text: "我先自己看看", at: now });
    expect(answered(a)).toBe(false);
  });

  it("系统消息（加文件夹）", () => {
    const a = ask("问");
    const folder = join(root, "work", "foo");
    mkdirSync(folder, { recursive: true });
    ledger.hubCall(lin.sessionId, "project.create", { folder: realpathSync.native(folder) });
    const kinds = messagesIn(lin.conversationId).map((m) => m.sender);
    expect(kinds).toContain("system");
    expect(answered(a)).toBe(false);
  });

  it("Worker 的汇报，以及用户在 Worker 的对话里说的话", () => {
    const folder = join(root, "work", "bar");
    mkdirSync(folder, { recursive: true });
    ledger.hubCall(lin.sessionId, "project.create", { folder: realpathSync.native(folder) });
    const worker = ledger.hubCall(lin.sessionId, "worker.start", { title: "修 X", task: "把 X 修好", noWorktree: true }).data.worker;
    const a = ask("问");
    const workerSession = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", worker.id)!.id;
    const task = messagesIn(worker.workerConversationId)[0]!.id;
    for (const type of ["message.delivered", "message.processing"] as const) ledger.applyDriverEvent(workerSession, { type, messageIds: [task], at: now });
    ledger.applyDriverEvent(workerSession, {
      type: "agent.text",
      uuid: "w-1",
      text: `好了\n\n${REPORT_START}\n状态: 做完了\n摘要: 修好了\n提交: 无\n测试: 无\n问题: 无\n${REPORT_END}`,
      at: now,
    });
    ledger.applyDriverEvent(workerSession, { type: "turn.ended", ok: true, interrupted: false, messageIds: [task], durationMs: 10, at: now });
    expect(messagesIn(lin.conversationId).some((m) => m.kind === "worker" && m.meta?.event === "report")).toBe(true);
    expect(answered(a)).toBe(false);
    // 用户直接对 Worker 说：Worker 的对话里是用户消息，项目经理的对话里多一行系统消息，都不算回答这个项目经理的提问
    post(worker.workerConversationId, "顺便把 Y 也改了");
    expect(answered(a)).toBe(false);
  });

  it("用户在别的项目经理的对话里发消息", () => {
    const a = ask("问");
    const b = ask("问", zhou);
    post(zhou.conversationId);
    expect([answered(a), answered(b)]).toEqual([false, true]);
  });
});

describe("回答的那条消息后来怎样都不影响", () => {
  it("用户的消息还在排队、发送失败、被停止：提问照样是已回答", () => {
    const a = ask("问 1");
    const queued = post(lin.conversationId, "用 A");
    expect(ledger.getMessage(queued)!.status).toBe("queued");
    expect(answered(a)).toBe(true);
    ledger.applyDriverEvent(lin.sessionId, { type: "driver.error", code: "invalid_input", message: "炸了", messageIds: [queued], at: now });
    expect(ledger.getMessage(queued)!.status).toBe("failed");
    expect(answered(a)).toBe(true);

    const b = ask("问 2");
    const stopped = post(lin.conversationId, "用 B");
    for (const type of ["message.delivered", "message.processing"] as const) ledger.applyDriverEvent(lin.sessionId, { type, messageIds: [stopped], at: now });
    ledger.requestStop(lin.conversationId);
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.ended", ok: false, interrupted: true, messageIds: [stopped], durationMs: 10, at: now });
    expect(ledger.getMessage(stopped)!.status).toBe("stopped");
    expect(answered(b)).toBe(true);
  });
});

describe("持久化", () => {
  it("重启守护进程后已回答、没回答的都不变", () => {
    const a = ask("问 1");
    post(lin.conversationId);
    const b = ask("问 2");
    db.close();
    open();
    expect([answered(a), answered(b)]).toEqual([true, false]);
  });

  it("老数据：点过“知道了”的、之后用户发过消息的都当成已回答，其余照旧没回答（迁移 0009）", () => {
    const dismissed = ask("点过知道了");
    const replied = ask("用户之后发过消息");
    post(lin.conversationId);
    const open1 = ask("还没回");
    const other = ask("别的对话的", zhou);
    // 改成老版本的样子：没有 answered；点过“知道了”的是 dismissed；库停在迁移 0008
    db.run("UPDATE messages SET meta = '{\"needsUser\":true}' WHERE id IN (?, ?, ?)", replied, open1, other);
    db.run("UPDATE messages SET meta = '{\"needsUser\":true,\"dismissed\":true}' WHERE id = ?", dismissed);
    db.exec("PRAGMA user_version = 8");
    db.close();
    open();
    expect([answered(dismissed), answered(replied), answered(open1), answered(other)]).toEqual([true, true, false, false]);
  });

  it("老数据：只点过“知道了”、后面没有用户消息的，迁移后是 answered，dismissed 留着（回滚到旧版本也不会冒出来）", () => {
    const dismissed = ask("只点过知道了");
    const open1 = ask("还没回");
    db.run("UPDATE messages SET meta = '{\"needsUser\":true,\"dismissed\":true}' WHERE id = ?", dismissed);
    db.run("UPDATE messages SET meta = '{\"needsUser\":true}' WHERE id = ?", open1);
    db.exec("PRAGMA user_version = 8");
    db.close();
    open();
    expect([answered(dismissed), answered(open1)]).toEqual([true, false]);
    expect(ledger.getMessage(dismissed)!.meta).toEqual({ needsUser: true, dismissed: true, answered: true });
  });

  it("老数据：meta 不是合法 JSON 的行，迁移照样跑完、这一行不动；之后用户发消息也不受影响", () => {
    const good = ask("好的提问");
    const bad = ask("坏数据");
    db.run("UPDATE messages SET meta = '{\"needsUser\":true}' WHERE id = ?", good);
    db.run("UPDATE messages SET meta = '{not json' WHERE id = ?", bad);
    post(lin.conversationId);
    db.run("UPDATE messages SET meta = '{\"needsUser\":true}' WHERE id = ?", good);
    db.exec("PRAGMA user_version = 8");
    db.close();
    open();
    expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBeGreaterThanOrEqual(9);
    expect(answered(good)).toBe(true);
    expect(db.get<{ meta: string }>("SELECT meta FROM messages WHERE id = ?", bad)!.meta).toBe("{not json");
    const later = ask("迁移后再问");
    post(lin.conversationId);
    expect(answered(later)).toBe(true);
    expect(db.get<{ meta: string }>("SELECT meta FROM messages WHERE id = ?", bad)!.meta).toBe("{not json");
  });

  it("老数据：迁移前读到 dismissed 也当成已回答", () => {
    const a = ask("问");
    db.run("UPDATE messages SET meta = '{\"needsUser\":true,\"dismissed\":true}' WHERE id = ?", a);
    expect(askOf(ledger.getMessage(a)!)).toEqual({ needsUser: true, answered: true });
  });

  it("带 options 的 hub ask 入库保留 options，回答后 answered 与 options 都在；不合法的 options 被拒", () => {
    const id = ledger.hubCall(lin.sessionId, "ask", {
      text: "你想审什么？",
      options: [" 审一个 PR / 分支 ", "审本地代码路径"],
    }).data.messageId;
    expect(askOf(ledger.getMessage(id)!)).toEqual({
      needsUser: true,
      options: ["审一个 PR / 分支", "审本地代码路径"],
    });
    post(lin.conversationId, "审一个 PR / 分支");
    expect(askOf(ledger.getMessage(id)!)).toEqual({
      needsUser: true,
      answered: true,
      options: ["审一个 PR / 分支", "审本地代码路径"],
    });
    expect(() => ledger.hubCall(lin.sessionId, "ask", { text: "问", options: ["只有一个"] })).toThrow(/选项至少要给 2 个/);
  });
});
