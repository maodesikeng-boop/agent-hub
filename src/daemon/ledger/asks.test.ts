// “等你确定”（hub ask）什么时候算回答了：只有用户在这张卡上回答（点选项、填写），或项目经理自己关掉/替换它。
// 用户在对话里发的普通消息不关任何卡；项目经理每次收到用户消息，都带着账本里当前还在等的卡。
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import { isLedgerWakeup } from "../../shared/attachments.ts";
import { askOf } from "../../shared/domain.ts";
import { ASK_CARD_TELL_USER, ASK_CARD_WHERE } from "../../shared/hub.ts";
import type { ConversationId, MessageId, PmId, SessionId } from "../../shared/domain.ts";
import { ASK_MAX_OPTION_CHARS } from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
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

const itemOf = (messageId: MessageId) => db.get<{ id: number; status: string }>("SELECT id, status FROM router_items WHERE ask_message_id = ?", messageId)!;
const statusOf = (messageId: MessageId) => itemOf(messageId).status;
const answerCard = (messageId: MessageId, note: string) => ledger.answerAsk(messageId, { clientId: `a${++clientSeq}`, note });

/** 项目经理实际收到的这条用户消息：原文前面的说明块 + 原文（handlers.ts 的 session.send 原样交给驱动层）。 */
const receivedBy = (messageId: MessageId) => ledger.deliveryOf(ledger.getMessage(messageId)!);

describe("一张卡只在用户回答这张卡时关掉", () => {
  it("挂两张卡，回答其中一张：另一张仍在等，对话里的卡也没被标成已回答", () => {
    const power = ledger.hubCall(lin.sessionId, "ask", { text: "请接电源", options: ["已接", "不接"] }).data.messageId;
    const standard = ledger.hubCall(lin.sessionId, "ask", { text: "方案标准", options: ["两处都按这个改（推荐）", "只改一处"] }).data.messageId;
    changes = [];
    ledger.answerAsk(standard, { clientId: "click-1", choice: "两处都按这个改（推荐）" });
    expect([statusOf(standard), statusOf(power)]).toEqual(["resolved", "pending"]);
    expect([answered(standard), answered(power)]).toEqual([true, false]);
    expect(changes.flatMap((c) => (c.type === "message.updated" ? [c.data.message.id] : []))).toEqual([standard]);
  });

  it("用户在对话里发普通消息：不关任何独立提问卡", () => {
    const a = ask("要不要发版？");
    const b = ask("用 A 还是 B？");
    post(lin.conversationId, "现在的工具调用支持多工具同步调用吗");
    expect([statusOf(a), statusOf(b)]).toEqual(["pending", "pending"]);
    expect([answered(a), answered(b)]).toEqual([false, false]);
  });

  it("回答别的项目经理的卡、重复提交同一次回答：不串、不重复", () => {
    const a = ask("问 A");
    const b = ask("问 B", zhou);
    const first = ledger.answerAsk(a, { clientId: "same", note: "好" });
    expect(ledger.answerAsk(a, { clientId: "same", note: "好" }).item.id).toBe(first.item.id);
    expect([statusOf(a), statusOf(b)]).toEqual(["resolved", "pending"]);
    expect(() => ledger.answerAsk(a, { clientId: "other", note: "又答" })).toThrow(/已经被处理过/);
  });

  it("选项最长到 hub ask 允许的上限：在卡上点它照样只回答这一张，记下的是完整选项", () => {
    const long = "甲".repeat(ASK_MAX_OPTION_CHARS);
    const id = ledger.hubCall(lin.sessionId, "ask", { text: "选哪个？", options: [long, "乙"] }).data.messageId;
    ledger.answerAsk(id, { clientId: "click-long", choice: long });
    expect(statusOf(id)).toBe("resolved");
    expect(askOf(ledger.getMessage(id)!)?.chosenOption).toBe(long);
  });

  it("没有这张卡：报 not_found", () => {
    expect(() => ledger.answerAsk(999_999, { clientId: "x", note: "好" })).toThrow(/这张卡不在了/);
  });
});

describe("项目经理收到用户消息时带着账本里当前还在等的卡", () => {
  it("两张卡都在等：原文前面带一块说明，列编号和问题前一段，原文不变", () => {
    const a = ask("要不要发版？");
    const b = ask("用 A 还是 B？\n\nA 快，B 稳");
    const id = post(lin.conversationId, "现在的工具调用支持多工具同步调用吗");
    expect(receivedBy(id)).toEqual({
      prefixes: [
        [
          "【系统：账本里现在还在等用户回答的普通提问卡有 2 张。这条消息不一定在回答它们；用户回答了哪张，用 `" + HUB_COMMAND + " ask close <编号>` 关掉那张，没回答的留着：",
          `- #${itemOf(a).id}「要不要发版？」`,
          `- #${itemOf(b).id}「用 A 还是 B？」`,
          "】",
        ].join("\n"),
      ],
      text: "现在的工具调用支持多工具同步调用吗",
    });
  });

  it("没有卡在等（没问过、已回答、已关掉）：不带说明", () => {
    expect(receivedBy(post(lin.conversationId, "你好"))).toEqual({ prefixes: [], text: "你好" });
    const a = ask("问");
    answerCard(a, "好");
    expect(receivedBy(post(lin.conversationId, "再说一句")).prefixes).toEqual([]);
  });

  it("消息排队着还没送到时某张卡被回答了：送出去的说明按送出那一刻的账本，不带已回答的", () => {
    const a = ask("问 A");
    const b = ask("问 B");
    const id = post(lin.conversationId, "随便说");
    answerCard(a, "好");
    const note = receivedBy(id).prefixes[0]!;
    expect(note).toContain("有 1 张");
    expect(note).toContain(`#${itemOf(b).id}「问 B」`);
    expect(note).not.toContain("问 A");
  });

  it("问题很长只留前一段；卡很多只列前几张，其余写个数", () => {
    for (let i = 1; i <= 12; i++) ask(`第${i}问${"长".repeat(200)}`);
    const note = receivedBy(post(lin.conversationId, "回")).prefixes[0]!;
    expect(note).toContain("有 12 张");
    expect(note).toContain("「第1问");
    expect(note).toContain("「第10问");
    expect(note).not.toContain("「第11问");
    expect(note).toContain("另有 2 张没列出");
    expect(note).not.toContain("长".repeat(100));
  });

  it("别的项目经理的卡不进说明", () => {
    ask("阿周的问题", zhou);
    expect(receivedBy(post(lin.conversationId, "你好")).prefixes).toEqual([]);
  });
});

describe("卡上记下怎么了结的：用户答了什么，或被项目经理关掉", () => {
  it("没选项的卡填一句、有选项的卡点选项加一句：卡上都记下用户的原话", () => {
    const plain = ask("请提供测试账号的邮箱地址");
    const power = ledger.hubCall(lin.sessionId, "ask", { text: "请接电源", options: ["已接", "不接"] }).data.messageId;
    answerCard(plain, "qa-test@example.com");
    ledger.answerAsk(power, { clientId: "both", choice: "不接", note: "开完会再接" });
    expect(askOf(ledger.getMessage(plain)!)).toEqual({ needsUser: true, answered: true, answerNote: "qa-test@example.com" });
    expect(askOf(ledger.getMessage(power)!)).toMatchObject({ answered: true, chosenOption: "不接", answerNote: "开完会再接" });
  });

  it("hub ask close、--replace 关掉的卡：标成已关掉，不带回答", () => {
    const a = ask("问 A");
    const b = ask("问 B");
    ledger.hubCall(lin.sessionId, "ask.close", { itemId: itemOf(a).id });
    ledger.hubCall(lin.sessionId, "ask", { text: "问 B（改过）", replaceItemId: itemOf(b).id });
    expect(askOf(ledger.getMessage(a)!)).toEqual({ needsUser: true, answered: true, closed: true });
    expect(askOf(ledger.getMessage(b)!)).toEqual({ needsUser: true, answered: true, closed: true });
  });
});

describe("项目经理自己关掉卡（hub ask close）", () => {
  it("关掉后：不再在等、对话里的卡标成已回答、之后的用户消息不再带它；别的卡不受影响", () => {
    const a = ask("问 A");
    const b = ask("问 B");
    const result = ledger.hubCall(lin.sessionId, "ask.close", { itemId: itemOf(a).id });
    expect(result.text).toContain(`已关掉卡 #${itemOf(a).id}`);
    expect([statusOf(a), statusOf(b)]).toEqual(["superseded", "pending"]);
    expect([answered(a), answered(b)]).toEqual([true, false]);
    const note = receivedBy(post(lin.conversationId, "好")).prefixes[0]!;
    expect(note).toContain("有 1 张");
    expect(note).toContain("问 B");
  });

  it("只能关自己名下的卡；已经不在等的卡再关：报错说明状态；用户点已被关掉的卡：报冲突", () => {
    const a = ask("问 A");
    const other = ask("阿周的", zhou);
    expect(() => ledger.hubCall(lin.sessionId, "ask.close", { itemId: itemOf(other).id })).toThrow(/不是你的卡/);
    expect(() => ledger.hubCall(lin.sessionId, "ask.close", { itemId: 999_999 })).toThrow(/没有编号 999999 的卡/);
    ledger.hubCall(lin.sessionId, "ask.close", { itemId: itemOf(a).id });
    expect(() => ledger.hubCall(lin.sessionId, "ask.close", { itemId: itemOf(a).id })).toThrow(/已经不在等了/);
    expect(() => answerCard(a, "好")).toThrow(/已被项目经理关掉或替换/);
  });
});

describe("提问卡只认用户回答它的那一次，与别的消息无关", () => {
  it("用户的消息发送失败、被停止都不碰卡", () => {
    const a = ask("问 1");
    const queued = post(lin.conversationId, "用 A");
    ledger.applyDriverEvent(lin.sessionId, { type: "driver.error", code: "invalid_input", message: "炸了", messageIds: [queued], at: now });
    expect(ledger.getMessage(queued)!.status).toBe("failed");
    expect(statusOf(a)).toBe("pending");
  });
});

describe("持久化", () => {
  it("重启守护进程后已回答、没回答的都不变", () => {
    const a = ask("问 1");
    answerCard(a, "好");
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

  it("老数据：拍板唤醒补标 wakeup，人打的字和坏 meta 的行不动（迁移 0036）", () => {
    const card = ask("要不要上线？");
    const typed = post(lin.conversationId, "我先说一句");
    const wake = ledger.answerAsk(card, { clientId: "old-click", note: "上" }).messageId!;
    const broken = post(lin.conversationId, "坏数据");
    db.run("UPDATE messages SET meta = NULL WHERE id = ?", wake);
    db.run("UPDATE messages SET meta = '{not json' WHERE id = ?", broken);
    db.exec("PRAGMA user_version = 35");
    db.close();
    open();
    expect([wake, typed].map((id) => isLedgerWakeup(ledger.getMessage(id)!))).toEqual([true, false]);
    expect(db.get<{ meta: string }>("SELECT meta FROM messages WHERE id = ?", broken)!.meta).toBe("{not json");
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
    answerCard(later, "好");
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
    ledger.answerAsk(id, { clientId: "click-2", choice: "审一个 PR / 分支" });
    expect(askOf(ledger.getMessage(id)!)).toEqual({
      needsUser: true,
      answered: true,
      chosenOption: "审一个 PR / 分支",
      options: ["审一个 PR / 分支", "审本地代码路径"],
    });
    expect(() => ledger.hubCall(lin.sessionId, "ask", { text: "问", options: ["只有一个"] })).toThrow(/选项至少要给 2 个/);
  });
});

describe("回执：提问卡出现在哪", () => {
  it("独立 hub ask 的回执说卡片在对话里、用户直接点选，右栏和总助只在没回答时列着，不引导用户去右栏找", () => {
    const { text } = ledger.hubCall(lin.sessionId, "ask", {
      text: "Vendor sync 要不要改？",
      options: ["改同步", "都不动"],
      recommended: "改同步",
    });
    expect(text).toBe(`已向用户提问：${ASK_CARD_WHERE}。${ASK_CARD_TELL_USER}。等用户回复再继续，别替用户拿主意。`);
    expect(text).toContain("卡片显示在对话里，用户直接在卡上点选");
    expect(text).toContain("回答后自动移走");
    expect(text).toContain("别让用户去右栏找");
  });
});
