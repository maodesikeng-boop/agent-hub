import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import { pendingDecisionsOf } from "../../shared/decisions.ts";
import { askOf, type ConversationId, type PmId, type SessionId } from "../../shared/domain.ts";
import {
  ROUTER_AUDIT_LOG_MAX_ROWS,
  ROUTER_FLEET_DIGEST_MAX_BYTES,
  ROUTER_PENDING_DECISIONS_PER_PM_MAX,
} from "../../shared/limits.ts";
import { openDatabase } from "../store/db.ts";
import type { Db } from "../store/index.ts";
import { migrate } from "../store/migrate.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type LedgerOptions, type SqliteLedger } from "./index.ts";

let root: string;
let dbFile: string;
let db: Db;
let ledger: SqliteLedger;
let changes: Change[];
let now: number;
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId; folder: string };
let zhou: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId; folder: string };

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

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-router-")));
  dbFile = join(root, "hub.sqlite");
  now = 10_000;
  db = openDatabase(dbFile);
  migrate(db);
  ledger = createLedger(db, options());
  changes = [];
  ledger.onChange((c) => changes.push(c));

  const folderA = join(root, "work", "alpha");
  const folderB = join(root, "work", "beta");
  mkdirSync(folderA, { recursive: true });
  mkdirSync(folderB, { recursive: true });

  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "# 风格\n简洁直接\n先测后合" });
  const b = ledger.createPm({ name: "阿周", mode: "hands_on", persona: "负责移动端" });
  lin = { pmId: a.pm.id, conversationId: a.conversation.id, sessionId: a.sessionId, folder: realpathSync.native(folderA) };
  zhou = { pmId: b.pm.id, conversationId: b.conversation.id, sessionId: b.sessionId, folder: realpathSync.native(folderB) };
  ledger.hubCall(lin.sessionId, "project.create", { folder: lin.folder, name: "后端核心", description: "API 与存储" });
  ledger.hubCall(zhou.sessionId, "project.create", { folder: zhou.folder, name: "移动端" });
  changes = [];
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("hub router ask / report / note 与同源桥接", () => {
  it("hub router ask 同时写入对话 AskMeta 与 router_items，并出现在 snapshot.router.items 与 pendingDecisionsOf", () => {
    const res = ledger.hubCall(lin.sessionId, "router.ask", {
      question: "导出 CSV 用同步流还是后台异步任务？",
      options: ["同步流式响应", "后台异步导出"],
      context: "单次最多 5 万行，流式足够在 2 秒内返回。",
    });
    expect(res.data.item).toMatchObject({
      kind: "decision",
      status: "pending",
      pmId: lin.pmId,
      question: "导出 CSV 用同步流还是后台异步任务？",
      options: ["同步流式响应", "后台异步导出"],
      askMessageId: res.data.messageId,
    });

    const msg = ledger.getMessage(res.data.messageId)!;
    expect(askOf(msg)).toEqual({
      needsUser: true,
      options: ["同步流式响应", "后台异步导出"],
    });
    expect(changes.map((c) => c.type)).toEqual(["message.created", "router.item.created"]);

    const snap = { ...ledger.snapshot(), server: { os: "darwin" as const, folderPicker: true, fileActions: true } };
    expect(snap.router.items).toHaveLength(1);
    const decisions = pendingDecisionsOf(snap, "local");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      pmId: lin.pmId,
      pmName: "小林",
      projectName: "后端核心",
      question: "导出 CSV 用同步流还是后台异步任务？",
      source: { kind: "router_item", itemId: res.data.item.id },
    });
  });

  it("支持单 PM 最多 30 张独立待决卡（不卡脖子），第 31 张报错提示 --replace，传 replaceItemId 可平滑替换旧卡", () => {
    const ids: number[] = [];
    for (let i = 1; i <= ROUTER_PENDING_DECISIONS_PER_PM_MAX; i++) {
      now += 10;
      const r = ledger.hubCall(lin.sessionId, "router.ask", {
        question: `待决问题 #${i}`,
        options: ["方案甲", "方案乙"],
      });
      ids.push(r.data.item.id);
    }
    expect(ids).toHaveLength(30);

    expect(() =>
      ledger.hubCall(lin.sessionId, "router.ask", {
        question: "第 31 个问题",
        options: ["甲", "乙"],
      }),
    ).toThrow(/30/);

    const oldAskMsgId = (ledger.snapshot().router.items.find((x) => x.id === ids[0]) as { askMessageId: number }).askMessageId;
    const replaced = ledger.hubCall(lin.sessionId, "router.ask", {
      question: "替换第 1 张的新问题",
      options: ["新甲", "新乙"],
      replaceItemId: ids[0],
    });
    expect(replaced.data.item.status).toBe("pending");
    const oldRow = db.get<{ status: string }>("SELECT status FROM router_items WHERE id = ?", ids[0]!);
    expect(oldRow?.status).toBe("superseded");
    expect(askOf(ledger.getMessage(oldAskMsgId)!)?.answered).toBe(true);
  });

  it("校验字段边界：问题超长、选项少于 2 个或超过 4 个、汇报摘要超长均被拒", () => {
    expect(() =>
      ledger.hubCall(lin.sessionId, "router.ask", {
        question: "问".repeat(161),
        options: ["甲", "乙"],
      }),
    ).toThrow();
    expect(() =>
      ledger.hubCall(lin.sessionId, "router.ask", {
        question: "合法问题",
        options: ["只有一个"],
      }),
    ).toThrow();
    expect(() =>
      ledger.hubCall(lin.sessionId, "router.ask", {
        question: "合法问题",
        options: ["1", "2", "3", "4", "5"],
      }),
    ).toThrow();
    expect(() =>
      ledger.hubCall(lin.sessionId, "router.report", {
        summary: "长".repeat(401),
      }),
    ).toThrow();
  });

  it("一处拍板全端同步：Router 侧 resolve 同步标 AskMeta.answered、唤醒 PM，且相同 clientId 幂等", () => {
    const { item, messageId } = ledger.hubCall(lin.sessionId, "router.ask", {
      question: "缓存淘汰用 LRU 还是 TTL？",
      options: ["LRU", "TTL"],
      context: "读多写少",
    }).data;
    changes = [];

    const first = ledger.resolveRouterItem(item.id, {
      clientId: "resolve-1",
      optionIndex: 0,
      note: "上限设 500",
    });
    expect(first.item).toMatchObject({
      id: item.id,
      kind: "decision",
      status: "resolved",
      resolution: {
        chosenIndex: 0,
        chosenOption: "LRU",
        note: "上限设 500",
        actor: "router",
        clientId: "resolve-1",
      },
    });
    expect(first.messageId).toBeTypeOf("number");
    expect(askOf(ledger.getMessage(messageId)!)).toMatchObject({
      needsUser: true,
      answered: true,
      chosenOption: "LRU",
    });

    const wakeMsg = ledger.getMessage(first.messageId!)!;
    expect(wakeMsg.sender).toBe("user");
    expect(wakeMsg.text).toContain("【Router 拍板】");
    expect(wakeMsg.text).toContain("LRU");
    expect(wakeMsg.text).toContain("上限设 500");

    // 幂等重发：不再多发一条唤醒消息
    changes = [];
    const second = ledger.resolveRouterItem(item.id, {
      clientId: "resolve-1",
      optionIndex: 0,
      note: "上限设 500",
    });
    expect(second.item).toEqual(first.item);
    expect(changes).toEqual([]);
  });

  it("旧 hub ask 自动同事务桥接进 router_items；用户在对话里直接回复同步收起 Router 待决卡（actor = conversation）", () => {
    const askMsgId = ledger.hubCall(lin.sessionId, "ask", {
      text: "发版窗口定在今晚还是明早？",
      options: ["今晚 22:00", "明早 10:00"],
    }).data.messageId;

    const bridged = ledger.snapshot().router.items.find((x) => x.kind === "decision" && x.askMessageId === askMsgId);
    expect(bridged).toBeDefined();
    expect(bridged).toMatchObject({
      kind: "decision",
      status: "pending",
      question: "发版窗口定在今晚还是明早？",
      options: ["今晚 22:00", "明早 10:00"],
    });

    changes = [];
    ledger.postUserMessage({
      conversationId: lin.conversationId,
      clientId: "chat-reply-1",
      text: "明早 10:00 稳妥一点",
    });

    expect(askOf(ledger.getMessage(askMsgId)!)?.answered).toBe(true);
    expect(ledger.snapshot().router.items.find((x) => x.id === bridged!.id)).toBeUndefined();
    const updatedEvent = changes.find((c) => c.type === "router.item.updated" && c.data.item.id === bridged!.id);
    expect(updatedEvent).toBeDefined();
    if (updatedEvent?.type === "router.item.updated" && updatedEvent.data.item.kind === "decision") {
      expect(updatedEvent.data.item.status).toBe("resolved");
      expect(updatedEvent.data.item.resolution).toMatchObject({
        actor: "conversation",
        note: "明早 10:00 稳妥一点",
      });
    }
  });

  it("hub router report、单条归档、全部已读（archive-all）与游标分页正常工作", () => {
    const r1 = ledger.hubCall(lin.sessionId, "router.report", {
      summary: "PR #101 已合入主干",
      links: [{ label: "PR #101", target: "https://github.com/org/repo/pull/101" }],
    }).data.item;
    now += 100;
    const r2 = ledger.hubCall(zhou.sessionId, "router.report", {
      summary: "iOS 冒烟通过",
    }).data.item;
    now += 100;
    const r3 = ledger.hubCall(lin.sessionId, "router.report", {
      summary: "数据库迁移验证完毕",
    }).data.item;

    expect(ledger.snapshot().router.items.filter((x) => x.kind === "report")).toHaveLength(3);

    // 单条归档 r1
    const single = ledger.resolveRouterItem(r1.id, { action: "archive" });
    expect(single.item.status).toBe("archived");
    expect(ledger.snapshot().router.items.filter((x) => x.kind === "report")).toHaveLength(2);

    // 全部已读 r2、r3
    changes = [];
    const batch = ledger.archiveAllRouterReports();
    expect(batch.archivedIds.sort((a, b) => a - b)).toEqual([r2.id, r3.id].sort((a, b) => a - b));
    expect(ledger.snapshot().router.items.filter((x) => x.kind === "report")).toHaveLength(0);
    expect(changes.some((c) => c.type === "router.reports.archived_all")).toBe(true);

    // 游标分页读取已归档历史（每页 2 条）
    const page1 = ledger.listRouterItems(undefined, 2);
    expect(page1.items.map((i) => i.id)).toEqual([r3.id, r2.id]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTypeOf("string");

    const page2 = ledger.listRouterItems(page1.nextCursor!, 2);
    expect(page2.items.map((i) => i.id)).toEqual([r1.id]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it("hub router note 与 router_audit_log 500 行环形上限生效", () => {
    for (let i = 1; i <= 530; i++) {
      now += 1;
      ledger.hubCall(lin.sessionId, "router.note", { text: `阶段进展 #${i}` });
    }
    expect(ledger.snapshot().router.notes).toEqual([
      { pmId: lin.pmId, text: "阶段进展 #530", updatedAt: now },
    ]);
    const count = db.get<{ n: number }>("SELECT count(*) AS n FROM router_audit_log")!.n;
    expect(count).toBeLessThanOrEqual(ROUTER_AUDIT_LOG_MAX_ROWS);

    ledger.hubCall(lin.sessionId, "router.note", { clear: true });
    expect(ledger.snapshot().router.notes).toEqual([]);
  });

  it("DeviceRouterDigest 内存缓存命中与写操作精确失效，且体积严守 24 KB 上限", () => {
    ledger.hubCall(lin.sessionId, "router.note", { text: "正在推进导出模块与权限重构" });
    ledger.hubCall(lin.sessionId, "router.ask", {
      question: "导出文件默认编码用 UTF-8 BOM 吗？",
      options: ["带 BOM（兼容 Excel）", "纯 UTF-8"],
    });

    const d1 = ledger.getRouterDigest();
    const d2 = ledger.getRouterDigest();
    // 未发生写事务时直接命中内存缓存（同一引用）
    expect(d2).toBe(d1);
    expect(d1.pms).toHaveLength(2);
    const linDigest = d1.pms.find((p) => p.pmId === lin.pmId)!;
    expect(linDigest).toMatchObject({
      name: "小林",
      pmNote: "正在推进导出模块与权限重构",
      pendingDecisionCount: 1,
      project: { name: "后端核心", mainFolder: lin.folder },
    });
    expect(Buffer.byteLength(JSON.stringify(d1))).toBeLessThanOrEqual(ROUTER_FLEET_DIGEST_MAX_BYTES);

    // 写操作（如归档阿周）立刻使缓存失效
    now += 50;
    ledger.archivePm(zhou.pmId);
    const d3 = ledger.getRouterDigest();
    expect(d3).not.toBe(d1);
    expect(d3.pms.map((p) => p.pmId)).toEqual([lin.pmId]);
  });

  it("router_commands 创建幂等、状态更新、审计落库与游标分页查询，且按 choice 字符串拍板生效", () => {
    const first = ledger.createRouterCommand({
      clientId: "cmd-1",
      inputText: "@后端核心 帮我看一下慢查询",
      vendor: "claude",
      model: null,
      effort: null,
      status: "planning",
      auditAction: "router.command.submit",
      auditActor: "user",
    });
    expect(first.deduplicated).toBe(false);
    expect(first.command.status).toBe("planning");
    expect(changes.map((c) => c.type)).toEqual(["router.command.created"]);

    // 相同 clientId 幂等返回已有记录，不重复推事件
    changes = [];
    const dup = ledger.createRouterCommand({
      clientId: "cmd-1",
      inputText: "@后端核心 帮我看一下慢查询",
      vendor: "claude",
      model: null,
      effort: null,
      status: "planning",
    });
    expect(dup.deduplicated).toBe(true);
    expect(dup.command.id).toBe(first.command.id);
    expect(changes).toEqual([]);

    now += 25;
    const updated = ledger.updateRouterCommand(first.command.id, {
      status: "dispatched",
      dispatched: [{ deviceId: "self", pmId: lin.pmId, messageId: 1, ok: true, op: "pm.forward", verbatim: true }],
      durationMs: 25,
      auditAction: "router.command.dispatched",
      auditActor: "router_agent",
    });
    expect(updated.status).toBe("dispatched");
    expect(updated.durationMs).toBe(25);
    expect(changes.map((c) => c.type)).toEqual(["router.command.updated"]);

    now += 100;
    const c2 = ledger.createRouterCommand({
      clientId: "cmd-2",
      inputText: "移动端打包进度",
      vendor: "agy",
      model: "gemini-3.1-flash-lite-preview",
      effort: "low",
      status: "answered",
      plan: { intent: "answer", reply: "移动端当前空闲", actions: [{ type: "answer", markdown: "移动端当前空闲" }] },
      durationMs: 420,
    }).command;
    now += 100;
    const c3 = ledger.createRouterCommand({
      clientId: "cmd-3",
      inputText: "测试失败记录",
      vendor: "claude",
      model: "claude-haiku-4-5",
      effort: "low",
      status: "failed",
      error: "设备离线",
      durationMs: 80,
    }).command;

    const p1 = ledger.listRouterCommands(undefined, 2);
    expect(p1.commands.map((c) => c.id)).toEqual([c3.id, c2.id]);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).toBeTypeOf("string");

    const p2 = ledger.listRouterCommands(p1.nextCursor!, 2);
    expect(p2.commands.map((c) => c.id)).toEqual([first.command.id]);
    expect(p2.hasMore).toBe(false);
    expect(p2.nextCursor).toBeNull();

    // /api/router/items/:id/decide 风格：支持按 choice 文本匹配选项
    const { item } = ledger.hubCall(lin.sessionId, "router.ask", {
      question: "日志采样率设多少？",
      options: ["10%", "100%"],
    }).data;
    const decided = ledger.resolveRouterItem(item.id, {
      clientId: "decide-choice-1",
      choice: "100%",
      note: "灰度期全量采",
    });
    expect(decided.item).toMatchObject({
      status: "resolved",
      resolution: { chosenIndex: 1, chosenOption: "100%", note: "灰度期全量采" },
    });
  });

  it("临时 assistant 会话隔离于 snapshot.sessions，且重启恢复自动清理残留会话与卡在 planning 的指令", () => {
    const tempSess = ledger.createRouterAssistantSession({
      vendor: "claude",
      model: "claude-haiku-4-5",
      effort: "low",
      cwd: join(root, ".agent-hub", "state", "router-home"),
    });
    expect(ledger.sessionRole(tempSess.id)).toBe("assistant");
    expect(ledger.snapshot().sessions.some((s) => s.sessionId === tempSess.id)).toBe(false);

    const stuckCmd = ledger.createRouterCommand({
      clientId: "cmd-stuck",
      inputText: "未完成的规划",
      vendor: "claude",
      status: "planning",
    }).command;

    now += 500;
    ledger.recoverAfterRestart();
    expect(ledger.sessionRole(tempSess.id)).toBeNull();
    expect(ledger.getRouterCommand(stuckCmd.id)?.status).toBe("failed");
  });
});
