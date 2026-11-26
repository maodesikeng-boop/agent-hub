import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import { pendingDecisionsOf } from "../../shared/decisions.ts";
import { askOf, type ConversationId, type PmId, type SessionId } from "../../shared/domain.ts";
import { parseCatalogReply } from "../../shared/project-catalog.ts";
import {
  MAX_DESCRIPTION_CHARS,
  PROJECT_CATALOG_ONE_LINER_MAX_CHARS,
  ROUTER_AUDIT_LOG_MAX_ROWS,
  ROUTER_BRIEFINGS_SNAPSHOT_MAX_BYTES,
  ROUTER_COMMAND_MAX_CHARS,
  ROUTER_COMMAND_MAX_RETRIES,
  ROUTER_COMMAND_RETRY_ID_MAX_CHARS,
  ROUTER_COMMANDS_SNAPSHOT_MAX_BYTES,
  ROUTER_CONTEXT_MAX_CHARS,
  ROUTER_FLEET_DIGEST_MAX_BYTES,
  ROUTER_PENDING_DECISIONS_PER_PM_MAX,
  ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX,
  ROUTER_REPLY_MAX_CHARS,
  ROUTER_REPORT_LINK_LABEL_MAX_CHARS,
  ROUTER_REPORT_LINK_TARGET_MAX_CHARS,
  ROUTER_REPORT_LINKS_MAX,
  ROUTER_STREAM_BRIEFINGS_SNAPSHOT_MAX,
  ROUTER_STREAM_PAGE_MAX_BYTES,
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

describe("统一 hub ask 与 router report / note 同源桥接", () => {
  it("hub ask（含 --recommended）同时写入对话 AskMeta 与 router_items，并出现在 snapshot.router.items 与 pendingDecisionsOf", () => {
    const res = ledger.hubCall(lin.sessionId, "ask", {
      text: "导出 CSV 用同步流还是后台异步任务？\n\n单次最多 5 万行，流式足够在 2 秒内返回。",
      options: ["同步流式响应", "后台异步导出"],
      recommended: "后台异步导出",
    });
    expect(res.data.item).toMatchObject({
      kind: "decision",
      status: "pending",
      pmId: lin.pmId,
      question: "导出 CSV 用同步流还是后台异步任务？",
      context: "单次最多 5 万行，流式足够在 2 秒内返回。",
      options: ["同步流式响应", "后台异步导出"],
      askMessageId: res.data.messageId,
    });

    const msg = ledger.getMessage(res.data.messageId)!;
    expect(askOf(msg)).toEqual({
      needsUser: true,
      options: ["同步流式响应", "后台异步导出"],
      recommended: "后台异步导出",
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
      context: "单次最多 5 万行，流式足够在 2 秒内返回。",
      source: { kind: "router_item", itemId: res.data.item!.id, recommended: "后台异步导出" },
    });
  });

  it("支持单 PM 最多 30 张独立待决卡（不卡脖子），第 31 张报错提示 --replace，传 replaceItemId 可平滑替换旧卡", () => {
    const ids: number[] = [];
    for (let i = 1; i <= ROUTER_PENDING_DECISIONS_PER_PM_MAX; i++) {
      now += 10;
      const r = ledger.hubCall(lin.sessionId, "ask", {
        text: `待决问题 #${i}`,
        options: ["方案甲", "方案乙"],
      });
      ids.push(r.data.item!.id);
    }
    expect(ids).toHaveLength(30);

    expect(() =>
      ledger.hubCall(lin.sessionId, "ask", {
        text: "第 31 个问题",
        options: ["甲", "乙"],
      }),
    ).toThrow(/30/);

    const oldAskMsgId = (ledger.snapshot().router.items.find((x) => x.id === ids[0]) as { askMessageId: number }).askMessageId;
    const replaced = ledger.hubCall(lin.sessionId, "ask", {
      text: "替换第 1 张的新问题",
      options: ["新甲", "新乙"],
      replaceItemId: ids[0],
    });
    expect(replaced.data.item!.status).toBe("pending");
    const oldRow = db.get<{ status: string }>("SELECT status FROM router_items WHERE id = ?", ids[0]!);
    expect(oldRow?.status).toBe("superseded");
    expect(askOf(ledger.getMessage(oldAskMsgId)!)?.answered).toBe(true);
  });

  it("校验字段边界：选项少于 2 个或超过 10 个、不存在的推荐项、汇报摘要超长均被拒", () => {
    expect(() =>
      ledger.hubCall(lin.sessionId, "ask", {
        text: "合法问题",
        options: ["甲", "乙"],
        recommended: "丙",
      }),
    ).toThrow();
    expect(() =>
      ledger.hubCall(lin.sessionId, "ask", {
        text: "合法问题",
        options: ["只有一个"],
      }),
    ).toThrow();
    expect(() =>
      ledger.hubCall(lin.sessionId, "ask", {
        text: "合法问题",
        options: Array.from({ length: 11 }, (_, i) => `选项${i}`),
      }),
    ).toThrow();
    expect(() =>
      ledger.hubCall(lin.sessionId, "router.report", {
        summary: "长".repeat(401),
      }),
    ).toThrow();
  });

  it("一处拍板全端同步：Router 侧 resolve 同步标 AskMeta.answered、唤醒 PM，且相同 clientId 幂等", () => {
    const askRes = ledger.hubCall(lin.sessionId, "ask", {
      text: "缓存淘汰用 LRU 还是 TTL？\n\n读多写少",
      options: ["LRU", "TTL"],
    }).data;
    const item = askRes.item!;
    const messageId = askRes.messageId;
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
    expect(wakeMsg).toMatchObject({ sender: "system", meta: { event: "pm.wakeup", source: "router" } });
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
    expect(second).toEqual(first);
    expect(changes).toEqual([]);
  });

  it("旧 hub ask 自动同事务桥接进 router_items；用户在对话里发普通消息不收起它，在卡上回答才收起（actor = router）", () => {
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

    ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "chat-reply-1", text: "明早 10:00 稳妥一点" });
    expect(askOf(ledger.getMessage(askMsgId)!)?.answered).toBeUndefined();
    expect(ledger.snapshot().router.items.find((x) => x.id === bridged!.id)).toMatchObject({ status: "pending" });

    changes = [];
    ledger.answerAsk(askMsgId, { clientId: "card-click-1", choice: "明早 10:00" });
    expect(askOf(ledger.getMessage(askMsgId)!)).toMatchObject({ answered: true, chosenOption: "明早 10:00" });
    expect(ledger.snapshot().router.items.find((x) => x.id === bridged!.id)).toBeUndefined();
    const updatedEvent = changes.find((c) => c.type === "router.item.updated" && c.data.item.id === bridged!.id);
    expect(updatedEvent).toBeDefined();
    if (updatedEvent?.type === "router.item.updated" && updatedEvent.data.item.kind === "decision") {
      expect(updatedEvent.data.item.status).toBe("resolved");
      expect(updatedEvent.data.item.resolution).toMatchObject({ actor: "router", chosenOption: "明早 10:00" });
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

    // 单条归档 r1：读过的简报仍留在快照近窗里（v2 时间流），只是状态变了
    const single = ledger.resolveRouterItem(r1.id, { action: "archive" });
    expect(single.item.status).toBe("archived");
    const unreadOf = () =>
      ledger.snapshot().router.items.filter((x) => x.kind === "report" && x.status === "unread");
    expect(unreadOf()).toHaveLength(2);
    expect(ledger.snapshot().router.items.filter((x) => x.kind === "report")).toHaveLength(3);

    // 全部已读 r2、r3
    changes = [];
    const batch = ledger.archiveAllRouterReports();
    expect(batch.archivedIds.sort((a, b) => a - b)).toEqual([r2.id, r3.id].sort((a, b) => a - b));
    expect(unreadOf()).toHaveLength(0);
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

  it("router_audit_log 500 行环形上限生效", () => {
    for (let i = 1; i <= 530; i++) {
      now += 1;
      ledger.hubCall(lin.sessionId, "router.report", { summary: `阶段进展 #${i}` });
    }
    const count = db.get<{ n: number }>("SELECT count(*) AS n FROM router_audit_log")!.n;
    expect(count).toBeLessThanOrEqual(ROUTER_AUDIT_LOG_MAX_ROWS);
  });

  it("DeviceRouterDigest 内存缓存命中与写操作精确失效，且体积严守 24 KB 上限", () => {
    ledger.hubCall(lin.sessionId, "ask", {
      text: "导出文件默认编码用 UTF-8 BOM 吗？",
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

  it("45 个带满说明、附加文件夹、档案和近况的项目：getRouterDigest 不超 24 KB，省略的记了个数，有待拍板的留着", () => {
    const catalog = parseCatalogReply(
      JSON.stringify({
        oneLiner: "档".repeat(PROJECT_CATALOG_ONE_LINER_MAX_CHARS),
        aliases: Array.from({ length: 8 }, (_, k) => `别名${k}`),
        focus: "焦".repeat(160),
        modules: [{ name: "核心", summary: "流式识别" }],
        decisions: ["采用 UTF-8"],
        openItems: [],
      }),
    )!;
    const created: PmId[] = [lin.pmId, zhou.pmId];
    for (let i = 1; i <= 45; i++) {
      const main = join(root, "repos", `enterprise-workspace-service-${i}`);
      const extra = join(root, "repos", `enterprise-workspace-shared-lib-${i}`);
      mkdirSync(main, { recursive: true });
      mkdirSync(extra, { recursive: true });
      const pm = ledger.createPm({ name: `项目经理-${i}`, mode: "manage_only", persona: "" });
      ledger.hubCall(pm.sessionId, "project.create", { folder: main, name: `enterprise-service-${i}`, description: "说".repeat(MAX_DESCRIPTION_CHARS) });
      ledger.hubCall(pm.sessionId, "project.attach", { folder: extra });
      ledger.hubCall(pm.sessionId, "router.report", { summary: "近".repeat(400) });
      created.push(pm.pm.id);
    }
    for (let job = ledger.projectCatalog.claimCatalog(now); job !== null; job = ledger.projectCatalog.claimCatalog(now)) {
      ledger.projectCatalog.catalogWritten(job, catalog, null);
    }

    // 有待拍板的放最前面建、最早不活跃：省略时也得留着
    ledger.hubCall(lin.sessionId, "ask", { text: "导出默认带 BOM 吗？", options: ["带", "不带"] });

    const digest = ledger.getRouterDigest();
    expect(Buffer.byteLength(JSON.stringify(digest), "utf8")).toBeLessThanOrEqual(ROUTER_FLEET_DIGEST_MAX_BYTES);
    expect(digest.pms.length + (digest.omittedPms ?? 0)).toBe(created.length);
    expect(digest.pms.find((p) => p.pmId === lin.pmId)).toMatchObject({ pendingDecisionCount: 1 });
    for (const pm of digest.pms) expect(pm.project?.catalog?.oneLiner).toBeTruthy();
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
    const item = ledger.hubCall(lin.sessionId, "ask", {
      text: "日志采样率设多少？",
      options: ["10%", "100%"],
    }).data.item!;
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
    // 残留会话是全表最大 id：只标为已结束、不删（删了下一个会话会复用这个号）
    expect(assistantRows()).toEqual([{ id: tempSess.id, status: "ended" }]);
    expect(ledger.snapshot().sessions.some((s) => s.sessionId === tempSess.id)).toBe(false);
    expect(ledger.getRouterCommand(stuckCmd.id)?.status).toBe("failed");
  });
});

function assistantRows(): Array<{ id: number; status: string }> {
  return db.all<{ id: number; status: string }>(
    "SELECT id, status FROM agent_sessions WHERE role = 'assistant' ORDER BY id",
  );
}

function maxSessionId(): number {
  return db.get<{ m: number }>("SELECT MAX(id) AS m FROM agent_sessions")!.m;
}

function newAssistant() {
  return ledger.createRouterAssistantSession({
    vendor: "claude",
    model: "claude-haiku-4-5",
    effort: "low",
    cwd: join(root, ".agent-hub", "state", "router-home"),
  });
}

describe("临时 assistant 会话收尾：agent_sessions.id 只增不退、不膨胀", () => {
  it("连续多轮结束：每轮新号严格递增，已结束的 assistant 行始终最多 1 行（就是全表最大那行）", () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const s = newAssistant();
      ids.push(s.id);
      now += 10;
      ledger.endRouterAssistantSession(s.id);
      expect(assistantRows()).toEqual([{ id: s.id, status: "ended" }]);
      expect(maxSessionId()).toBe(s.id);
    }
    for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
  });

  it("轨道 B 结束后紧接着新建项目经理：拿到的号严格大于刚结束的 assistant 号；下一轮收尾把更早的那行修剪掉", () => {
    const a = newAssistant();
    ledger.endRouterAssistantSession(a.id);
    const pm = ledger.createPm({ name: "新来的", mode: "manage_only", persona: "测试" });
    expect(pm.sessionId).toBeGreaterThan(a.id);

    // 并发两轮：先结束的那轮不是最大行，当场删；后结束的留着
    const b = newAssistant();
    const c = newAssistant();
    expect(b.id).toBeGreaterThan(pm.sessionId);
    expect(c.id).toBeGreaterThan(b.id);
    ledger.endRouterAssistantSession(b.id);
    expect(assistantRows()).toEqual([{ id: c.id, status: "idle" }]);
    ledger.endRouterAssistantSession(c.id);
    expect(assistantRows()).toEqual([{ id: c.id, status: "ended" }]);
    expect(newAssistant().id).toBeGreaterThan(c.id);
  });

  it("重启恢复：残留的 assistant 行标已结束、只留最大那行，重启后新建会话的号依然严格递增", () => {
    const leftover1 = newAssistant();
    const leftover2 = newAssistant();
    const maxBefore = maxSessionId();
    expect(maxBefore).toBe(leftover2.id);

    ledger.close();
    db.close();
    db = openDatabase(dbFile);
    migrate(db);
    ledger = createLedger(db, options());
    ledger.recoverAfterRestart();

    expect(assistantRows()).toEqual([{ id: leftover2.id, status: "ended" }]);
    expect(leftover1.id).toBeLessThan(leftover2.id);
    const pm = ledger.createPm({ name: "重启后", mode: "manage_only", persona: "测试" });
    expect(pm.sessionId).toBeGreaterThan(maxBefore);

    // 再重启一次：最大行已是项目经理会话，残留的那行 assistant 被修剪掉
    ledger.recoverAfterRestart();
    expect(assistantRows()).toEqual([]);
    expect(newAssistant().id).toBeGreaterThan(pm.sessionId);
  });
});

/** 满长的一条简报：400 字正文 + 4 个标题、地址都写满的链接。 */
function fullReport(pm: { sessionId: SessionId }, i: number) {
  return ledger.hubCall(pm.sessionId, "router.report", {
    summary: `${i}`.padEnd(ROUTER_CONTEXT_MAX_CHARS, "报"),
    links: Array.from({ length: ROUTER_REPORT_LINKS_MAX }, (_, k) => ({
      label: `${i}-${k}`.padEnd(ROUTER_REPORT_LINK_LABEL_MAX_CHARS, "链"),
      target: `https://example.com/${i}/${k}/`.padEnd(ROUTER_REPORT_LINK_TARGET_MAX_CHARS, "a"),
    })),
  }).data.item;
}

/** 满长的一条指令：4,000 字原话 + 6,000 字回复。 */
function fullCommand(i: number) {
  const { command } = ledger.createRouterCommand({
    clientId: `full-${i}`,
    inputText: "问".repeat(ROUTER_COMMAND_MAX_CHARS),
    vendor: "claude",
    status: "planning",
  });
  return ledger.updateRouterCommand(command.id, {
    status: "answered",
    plan: { intent: "answer", reply: "答".repeat(ROUTER_REPLY_MAX_CHARS), actions: [], track: "B" },
  });
}

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

describe("v2 快照与简报历史（docs/router-workbench-v2-design.md 第 3.2 节第 6、7 项）", () => {
  it("60 条未读简报 + 5 张待拍板项：5 张待拍板项全在快照里，简报只带最近 30 条", () => {
    const decisions = [];
    for (let i = 0; i < 5; i++) {
      now += 1;
      decisions.push(
        ledger.hubCall(lin.sessionId, "ask", { text: `拍板 ${i}`, options: ["甲", "乙"] }).data.item!,
      );
    }
    const reports = [];
    for (let i = 0; i < 60; i++) {
      now += 1;
      reports.push(ledger.hubCall(zhou.sessionId, "router.report", { summary: `简报 ${i}` }).data.item);
    }
    const items = ledger.snapshot().router.items;
    expect(items.filter((x) => x.kind === "decision").map((x) => x.id).sort((a, b) => a - b)).toEqual(
      decisions.map((d) => d.id),
    );
    const briefings = items.filter((x) => x.kind === "report");
    expect(briefings).toHaveLength(ROUTER_STREAM_BRIEFINGS_SNAPSHOT_MAX);
    expect(briefings.map((x) => x.id)).toEqual(reports.slice(-30).reverse().map((r) => r.id));
    // 合并后仍按 createdAt DESC, id DESC
    const keys = items.map((x) => [x.createdAt, x.id] as const);
    expect(keys).toEqual([...keys].sort((a, b) => b[0] - a[0] || b[1] - a[1]));
  });

  it("读过（archived）的简报仍在快照近窗里；已拍板的不在", () => {
    const r1 = ledger.hubCall(lin.sessionId, "router.report", { summary: "PR 已合并" }).data.item;
    now += 1;
    const ask = ledger.hubCall(lin.sessionId, "ask", { text: "要不要发版？", options: ["要", "不要"] }).data.item!;
    ledger.archiveAllRouterReports();
    ledger.resolveRouterItem(ask.id, { clientId: "c-1", optionIndex: 0 });
    const items = ledger.snapshot().router.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: r1.id, kind: "report", status: "archived" });
  });

  it("快照里的简报有字节上限：满链接简报从新到旧累加不超过 ROUTER_BRIEFINGS_SNAPSHOT_MAX_BYTES，至少 1 条", () => {
    for (let i = 0; i < 40; i++) {
      now += 1;
      fullReport(lin, i);
    }
    const router = ledger.snapshot().router;
    const briefings = router.items.filter((x) => x.kind === "report");
    expect(briefings.length).toBeGreaterThanOrEqual(1);
    expect(briefings.length).toBeLessThan(ROUTER_STREAM_BRIEFINGS_SNAPSHOT_MAX);
    expect(briefings.reduce((n, b) => n + jsonBytes(b), 0)).toBeLessThanOrEqual(ROUTER_BRIEFINGS_SNAPSHOT_MAX_BYTES);
    expect(router.briefingsHasMore).toBe(true);
    expect(router.commandsHasMore).toBe(false);
    // 留下的是最新的那一段
    const newest = ledger.listRouterItems(undefined, 1, "report").items[0]!;
    expect(briefings[0]!.id).toBe(newest.id);
  });

  it("快照里的指令有字节上限：满长回复从新到旧累加不超过 ROUTER_COMMANDS_SNAPSHOT_MAX_BYTES，至少 1 条", () => {
    const made = [];
    for (let i = 0; i < ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX; i++) {
      now += 1;
      made.push(fullCommand(i));
    }
    const router = ledger.snapshot().router;
    const commands = router.commands;
    expect(commands.length).toBeGreaterThanOrEqual(1);
    expect(commands.length).toBeLessThan(ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX);
    expect(commands.reduce((n, c) => n + jsonBytes(c), 0)).toBeLessThanOrEqual(ROUTER_COMMANDS_SNAPSHOT_MAX_BYTES);
    expect(router.commandsHasMore).toBe(true);
    expect(router.briefingsHasMore).toBe(false);
    expect(commands.map((c) => c.id)).toEqual(made.reverse().slice(0, commands.length).map((c) => c.id));
  });

  it("快照分别标记 briefingsHasMore 与 commandsHasMore：全空与正好满条数上限时为 false，超出条数上限时各自独立翻为 true", () => {
    expect(ledger.snapshot().router).toMatchObject({ briefingsHasMore: false, commandsHasMore: false });

    for (let i = 0; i < ROUTER_STREAM_BRIEFINGS_SNAPSHOT_MAX; i++) {
      now += 1;
      ledger.hubCall(lin.sessionId, "router.report", { summary: `短简报 ${i}` });
    }
    for (let i = 0; i < ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX; i++) {
      now += 1;
      ledger.createRouterCommand({ clientId: `exact-${i}`, inputText: `短指令 ${i}`, vendor: "claude", status: "answered" });
    }
    expect(ledger.snapshot().router).toMatchObject({ briefingsHasMore: false, commandsHasMore: false });

    now += 1;
    ledger.hubCall(lin.sessionId, "router.report", { summary: "第 31 条简报" });
    expect(ledger.snapshot().router).toMatchObject({ briefingsHasMore: true, commandsHasMore: false });

    now += 1;
    ledger.createRouterCommand({ clientId: "exact-extra", inputText: "第 11 条指令", vendor: "claude", status: "answered" });
    expect(ledger.snapshot().router).toMatchObject({ briefingsHasMore: true, commandsHasMore: true });
  });

  it("listRouterItems 带 kind=report：任意状态的简报，不含拍板项，能按游标翻页；不带时行为不变", () => {
    const r1 = ledger.hubCall(lin.sessionId, "router.report", { summary: "一" }).data.item;
    now += 1;
    const ask = ledger.hubCall(lin.sessionId, "ask", { text: "选哪个？", options: ["甲", "乙"] }).data.item!;
    now += 1;
    const r2 = ledger.hubCall(zhou.sessionId, "router.report", { summary: "二" }).data.item;
    ledger.resolveRouterItem(r2.id, { action: "archive" });
    now += 1;
    const r3 = ledger.hubCall(lin.sessionId, "router.report", { summary: "三" }).data.item;
    ledger.resolveRouterItem(ask.id, { clientId: "c-2", optionIndex: 1 });

    const page1 = ledger.listRouterItems(undefined, 2, "report");
    expect(page1.items.map((i) => [i.id, i.status])).toEqual([
      [r3.id, "unread"],
      [r2.id, "archived"],
    ]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe(`${page1.items[1]!.createdAt}:${r2.id}`);
    const page2 = ledger.listRouterItems(page1.nextCursor!, 2, "report");
    expect(page2.items.map((i) => i.id)).toEqual([r1.id]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();

    // 不带 kind：照旧只回已拍板 / 已归档的（含拍板项），不含未读简报
    expect(ledger.listRouterItems(undefined, 10).items.map((i) => i.id)).toEqual([ask.id, r2.id].sort((a, b) => b - a));
  });

  it("简报历史单页有字节上限：超了提前截页，游标指向最后一条已给出的，接着翻不丢不重", () => {
    const all = [];
    for (let i = 0; i < 100; i++) {
      now += 1;
      all.push(fullReport(i % 2 === 0 ? lin : zhou, i));
    }
    const page1 = ledger.listRouterItems(undefined, 100, "report");
    expect(page1.items.length).toBeGreaterThanOrEqual(1);
    expect(page1.items.length).toBeLessThan(100);
    expect(jsonBytes(page1)).toBeLessThanOrEqual(ROUTER_STREAM_PAGE_MAX_BYTES);
    expect(page1.hasMore).toBe(true);
    const last = page1.items.at(-1)!;
    expect(page1.nextCursor).toBe(`${last.createdAt}:${last.id}`);

    const seen = [...page1.items];
    let cursor = page1.nextCursor;
    while (cursor !== null) {
      const page = ledger.listRouterItems(cursor, 100, "report");
      expect(jsonBytes(page)).toBeLessThanOrEqual(ROUTER_STREAM_PAGE_MAX_BYTES);
      seen.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(seen.map((i) => i.id)).toEqual(all.reverse().map((r) => r.id));
  });

  it("指令历史单页有字节上限：满长回复超了提前截页，游标指向最后一条已给出的", () => {
    for (let i = 0; i < 30; i++) {
      now += 1;
      fullCommand(i);
    }
    const page1 = ledger.listRouterCommands(undefined, 30);
    expect(page1.commands.length).toBeLessThan(30);
    expect(jsonBytes(page1)).toBeLessThanOrEqual(ROUTER_STREAM_PAGE_MAX_BYTES);
    expect(page1.hasMore).toBe(true);
    const last = page1.commands.at(-1)!;
    expect(page1.nextCursor).toBe(`${last.createdAt}:${last.id}`);
    const page2 = ledger.listRouterCommands(page1.nextCursor!, 30);
    expect(page2.commands[0]!.id).toBe(last.id - 1);
  });
});

describe("claimRouterCommandRetry atomic retry-id ledger", () => {
  it("strips internal usedRetryIds from public views and preserves them across updates and mid-retry restarts", () => {
    const cmd = ledger.createRouterCommand({
      clientId: "claim-cmd-1",
      inputText: "测试原子认领",
      vendor: "claude",
      status: "failed",
      error: "boom",
    }).command;
    changes = [];

    const claimedA = ledger.claimRouterCommandRetry(cmd.id, { retryId: "r-A", fromRetryId: null });
    expect(claimedA).toMatchObject({ status: "planning", error: null, plan: { retryId: "r-A" } });
    expect("usedRetryIds" in (claimedA.plan ?? {})).toBe(false);
    expect(changes).toHaveLength(1);
    const emitted = changes[0]!;
    expect(emitted.type).toBe("router.command.updated");
    if (emitted.type === "router.command.updated") {
      expect("usedRetryIds" in (emitted.data.command.plan ?? {})).toBe(false);
    }

    // Concurrent or immediate repeat while planning is rejected.
    expect(() => ledger.claimRouterCommandRetry(cmd.id, { retryId: "r-B", fromRetryId: "r-A" })).toThrow(/只有失败状态/);

    // Finishing run A via updateRouterCommand must keep usedRetryIds in SQLite while hiding it publicly.
    const failedA = ledger.updateRouterCommand(cmd.id, {
      status: "failed",
      error: "boom A",
      plan: { intent: "answer", reply: "", actions: [], track: "B", retryId: "r-A" },
    });
    expect("usedRetryIds" in (failedA.plan ?? {})).toBe(false);
    expect("usedRetryIds" in (ledger.getRouterCommand(cmd.id)?.plan ?? {})).toBe(false);
    expect("usedRetryIds" in (ledger.listRouterCommands(undefined, 5).commands[0]?.plan ?? {})).toBe(false);
    expect("usedRetryIds" in (ledger.snapshot().router.commands[0]?.plan ?? {})).toBe(false);

    // Claim B, then simulate daemon crash while B is still planning and recover after restart.
    ledger.claimRouterCommandRetry(cmd.id, { retryId: "r-B", fromRetryId: "r-A" });
    ledger.close();
    db.close();
    db = openDatabase(dbFile);
    migrate(db);
    ledger = createLedger(db, options());
    ledger.recoverAfterRestart();

    const recovered = ledger.getRouterCommand(cmd.id);
    expect(recovered).toMatchObject({ status: "failed", plan: { retryId: "r-B" } });
    expect("usedRetryIds" in (recovered?.plan ?? {})).toBe(false);

    expect(() => ledger.claimRouterCommandRetry(cmd.id, { retryId: "r-A", fromRetryId: "r-B" })).toThrow(/已经重试过了/);
    expect(() => ledger.claimRouterCommandRetry(cmd.id, { retryId: "r-B", fromRetryId: "r-A" })).toThrow(/已经重试过了/);
    expect(() => ledger.claimRouterCommandRetry(cmd.id, { retryId: "r-B", fromRetryId: "r-B" })).toThrow(/已经重试过了/);

    const claimedC = ledger.claimRouterCommandRetry(cmd.id, { retryId: "r-C", fromRetryId: "r-B" });
    expect(claimedC).toMatchObject({ status: "planning", plan: { retryId: "r-C" } });
  });

  it("remembers legacy plan.retryId without usedRetryIds and tolerates dirty usedRetryIds arrays", () => {
    const legacy = ledger.createRouterCommand({
      clientId: "claim-legacy",
      inputText: "旧版本遗留数据",
      vendor: "claude",
      status: "failed",
      error: "old fail",
    }).command;
    db.run(
      "UPDATE router_commands SET plan_json = ? WHERE id = ?",
      JSON.stringify({ intent: "answer", reply: "", actions: [], retryId: "legacy-A" }),
      legacy.id,
    );

    ledger.claimRouterCommandRetry(legacy.id, { retryId: "legacy-B", fromRetryId: "legacy-A" });
    ledger.updateRouterCommand(legacy.id, {
      status: "failed",
      error: "fail B",
      plan: { intent: "answer", reply: "", actions: [], retryId: "legacy-B" },
    });
    expect(() => ledger.claimRouterCommandRetry(legacy.id, { retryId: "legacy-A", fromRetryId: "legacy-B" })).toThrow(/已经重试过了/);

    // Dirty entries in stored usedRetryIds are sanitized without crashing or losing valid ids.
    db.run(
      "UPDATE router_commands SET plan_json = ? WHERE id = ?",
      JSON.stringify({
        intent: "answer",
        reply: "",
        actions: [],
        retryId: "legacy-B",
        usedRetryIds: [123, "", "  ", "legacy-A", "legacy-A", null, "legacy-B"],
      }),
      legacy.id,
    );
    expect(() => ledger.claimRouterCommandRetry(legacy.id, { retryId: "legacy-A", fromRetryId: "legacy-B" })).toThrow(/已经重试过了/);
    const ok = ledger.claimRouterCommandRetry(legacy.id, { retryId: "legacy-C", fromRetryId: "legacy-B" });
    expect(ok).toMatchObject({ status: "planning", plan: { retryId: "legacy-C" } });
  });

  it("rejects delivered commands without retryOps, invalid ids, and retries past ROUTER_COMMAND_MAX_RETRIES without mutating state", () => {
    const delivered = ledger.createRouterCommand({
      clientId: "claim-delivered",
      inputText: "已投递不可整条重跑",
      vendor: "claude",
      status: "failed",
      dispatched: [{ deviceId: "self", pmId: lin.pmId, messageId: 1, ok: true }],
      error: "partial",
    }).command;
    expect(() => ledger.claimRouterCommandRetry(delivered.id, { retryId: "r-deliv", fromRetryId: null })).toThrow(/已有目标投递成功/);
    expect(ledger.getRouterCommand(delivered.id)?.status).toBe("failed");

    const cmd = ledger.createRouterCommand({
      clientId: "claim-bounds",
      inputText: "校验与上限",
      vendor: "claude",
      status: "failed",
      error: "boom",
    }).command;
    for (const bad of [
      { retryId: "", fromRetryId: null },
      { retryId: "   ", fromRetryId: null },
      { retryId: "x".repeat(ROUTER_COMMAND_RETRY_ID_MAX_CHARS + 1), fromRetryId: null },
      { retryId: "ok", fromRetryId: "   " },
      { retryId: "ok", fromRetryId: "y".repeat(ROUTER_COMMAND_RETRY_ID_MAX_CHARS + 1) },
    ]) {
      expect(() => ledger.claimRouterCommandRetry(cmd.id, bad)).toThrow(/格式不正确/);
    }

    let prev: string | null = null;
    for (let i = 1; i <= ROUTER_COMMAND_MAX_RETRIES; i++) {
      const id = `r-${i}`;
      ledger.claimRouterCommandRetry(cmd.id, { retryId: id, fromRetryId: prev });
      ledger.updateRouterCommand(cmd.id, {
        status: "failed",
        error: `fail ${i}`,
        plan: { intent: "answer", reply: "", actions: [], retryId: id },
      });
      prev = id;
    }
    expect(() => ledger.claimRouterCommandRetry(cmd.id, { retryId: "r-1", fromRetryId: prev })).toThrow(/已经重试过了/);
    expect(() => ledger.claimRouterCommandRetry(cmd.id, { retryId: "r-overflow", fromRetryId: prev })).toThrow(/重试上限/);
    const raw = JSON.parse(db.get<{ plan_json: string }>("SELECT plan_json FROM router_commands WHERE id = ?", cmd.id)!.plan_json) as {
      usedRetryIds: string[];
    };
    expect(raw.usedRetryIds).toHaveLength(ROUTER_COMMAND_MAX_RETRIES);
    expect(raw.usedRetryIds[0]).toBe("r-1");
  });
});
