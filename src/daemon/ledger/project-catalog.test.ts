import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationId, PmId, ProjectId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import {
  PROJECT_CATALOG_DIALOG_MAX_CHARS,
  PROJECT_CATALOG_GIVE_UP_MS,
  PROJECT_CATALOG_MIN_INTERVAL_MS,
  PROJECT_CATALOG_REFRESH_DELTA,
  PROJECT_CATALOG_RETRY_BACKOFF_MS,
  PROJECT_CATALOG_ROW_MAX_BYTES,
  PROJECT_CATALOG_USER_CHAR_WEIGHT,
} from "../../shared/limits.ts";
import type { CatalogJob, ProjectCatalog } from "../../shared/project-catalog.ts";
import { openDatabase } from "../store/db.ts";
import type { Db } from "../store/index.ts";
import { migrate } from "../store/migrate.ts";
import { createLedgerContext } from "./context.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type LedgerOptions, type SqliteLedger } from "./index.ts";
import { createLedgerProjectCatalog } from "./project-catalog.ts";
import type { LedgerProjects } from "./projects.ts";

let root: string;
let db: Db;
let ledger: SqliteLedger;
let now: number;
let seq = 0;
let claimable: ReturnType<typeof vi.fn<() => void>>;
type Pm = { pmId: PmId; conversationId: ConversationId; sessionId: SessionId; projectId: ProjectId; folder: string };
let lin: Pm;
let zhou: Pm;

const catalog: ProjectCatalog = {
  oneLiner: "后端 API 与存储",
  aliases: ["后端核心", "core"],
  focus: "导出模块重构",
  modules: [{ name: "导出", summary: "CSV 导出" }],
  decisions: ["用 UTF-8"],
  openItems: [],
};

function options(): LedgerOptions {
  const dataHome = join(root, ".agent-hub");
  return {
    now: () => now,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir: join(dataHome, "worktrees"),
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    onCatalogClaimable: () => claimable(),
  };
}

function newPm(name: string, projectName: string, description?: string): Pm {
  const folder = join(root, "work", name);
  mkdirSync(folder, { recursive: true });
  const created = ledger.createPm({ name, mode: "manage_only", persona: "" });
  const project = ledger.hubCall(created.sessionId, "project.create", {
    folder: realpathSync.native(folder),
    name: projectName,
    ...(description === undefined ? {} : { description }),
  }).data.project;
  return { pmId: created.pm.id, conversationId: created.conversation.id, sessionId: created.sessionId, projectId: project.id, folder: realpathSync.native(folder) };
}

/** 往项目经理对话里直接写一条消息（不经驱动层），返回编号。 */
function say(conversationId: ConversationId, sender: "user" | "agent" | "system", text: string, kind = "text", meta: unknown = null): number {
  now += 1;
  return Number(
    db.run(
      "INSERT INTO messages (conversation_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      conversationId,
      sender,
      kind,
      text,
      meta === null ? null : JSON.stringify(meta),
      `catalog-test-${++seq}`,
      sender === "user" ? "replied" : null,
      now,
      now,
    ).lastInsertRowid,
  );
}

const turnEnded = (sessionId: SessionId) =>
  ledger.applyDriverEvent(sessionId, { type: "turn.ended", at: now, ok: true, interrupted: false, messageIds: [], durationMs: 1 } as DriverEvent);

/** 领到这个项目的活为止（别的项目先领走放一边），找不到返回 null。 */
function claimFor(projectId: ProjectId): CatalogJob | null {
  const others: CatalogJob[] = [];
  try {
    for (;;) {
      const job = ledger.projectCatalog.claimCatalog(now);
      if (job === null) return null;
      if (job.projectId === projectId) return job;
      others.push(job);
    }
  } finally {
    for (const job of others) ledger.projectCatalog.catalogFailed(job, { reason: "shutdown" });
  }
}

/** 把项目的档案写成，返回那份活。 */
function writeFor(pm: Pm, value: ProjectCatalog = catalog): CatalogJob {
  const job = claimFor(pm.projectId)!;
  ledger.projectCatalog.catalogWritten(job, value, null);
  return job;
}

const rowOf = (projectId: ProjectId) =>
  db.get<{ catalog_json: string | null; cut_message_id: number; refreshed_at: number | null; forced: number; attempts: number; next_attempt_at: number | null; last_error: string | null }>(
    "SELECT * FROM project_catalogs WHERE project_id = ?",
    projectId,
  );

/** 重启守护进程：同一个库重新建账本（内存队列丢掉）。 */
function restart() {
  ledger.close();
  ledger = createLedger(db, options());
}

/** 建一张一步的任务图、跳过那一步、结束它（hub graph finish 记 forced）。 */
function finishGraph(pm: Pm, title = "导出") {
  const graph = ledger.hubCall(pm.sessionId, "graph.create", { specJson: JSON.stringify({ title, nodes: [{ key: "a", title: "实现" }] }) }).data.graph;
  ledger.hubCall(pm.sessionId, "graph.skip", { graphId: graph.id, nodeKey: "a" });
  ledger.hubCall(pm.sessionId, "graph.finish", { graphId: graph.id, summary: "结束" });
}

/** 库里直接记 forced，再像重启那样扫一遍进队列。 */
function force(pm: Pm) {
  db.run("UPDATE project_catalogs SET forced = 1 WHERE project_id = ?", pm.projectId);
  restart();
  ledger.projectCatalog.scanAtStartup(now);
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-catalog-")));
  now = 1_000_000;
  claimable = vi.fn<() => void>();
  db = openDatabase(join(root, "hub.sqlite"));
  migrate(db);
  ledger = createLedger(db, options());
  lin = newPm("小林", "后端核心", "API 与存储");
  zhou = newPm("阿周", "移动端");
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("project_catalogs 迁移", () => {
  it("迁移后有 project_catalogs 表，删项目时这一行跟着删", () => {
    expect(rowOf(lin.projectId)).toBeDefined();
    ledger.archivePm(lin.pmId);
    ledger.purgeExpiredArchivedPms(now + 365 * 24 * 3_600_000);
    expect(db.get("SELECT id FROM projects WHERE id = ?", lin.projectId)).toBeUndefined();
    expect(rowOf(lin.projectId)).toBeUndefined();
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("迁移后没有 router_pm_notes 表", () => {
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'router_pm_notes'")).toBeUndefined();
  });
});

describe("scanAtStartup", () => {
  it("没有档案的活跃项目全部进队列，返回进队列的个数", () => {
    restart();
    expect(ledger.projectCatalog.hasQueued()).toBe(false);
    expect(ledger.projectCatalog.scanAtStartup(now)).toBe(2);
    expect(claimable).toHaveBeenCalled();
    const claimed = [ledger.projectCatalog.claimCatalog(now)!.projectId, ledger.projectCatalog.claimCatalog(now)!.projectId];
    expect(claimed.sort()).toEqual([lin.projectId, zhou.projectId].sort());
  });

  it("有档案且切点之后加权字数没到门槛的项目不进队列", () => {
    writeFor(lin);
    writeFor(zhou);
    say(lin.conversationId, "user", "短");
    now += PROJECT_CATALOG_MIN_INTERVAL_MS;
    restart();
    expect(ledger.projectCatalog.scanAtStartup(now)).toBe(0);
    expect(ledger.projectCatalog.hasQueued()).toBe(false);
  });

  it("有档案、过了最短间隔且加权字数到门槛的项目进队列", () => {
    writeFor(lin);
    writeFor(zhou);
    say(lin.conversationId, "user", "字".repeat(PROJECT_CATALOG_REFRESH_DELTA / PROJECT_CATALOG_USER_CHAR_WEIGHT));
    now += PROJECT_CATALOG_MIN_INTERVAL_MS;
    restart();
    expect(ledger.projectCatalog.scanAtStartup(now)).toBe(1);
    expect(ledger.projectCatalog.claimCatalog(now)?.projectId).toBe(lin.projectId);
  });

  it("已归档项目、已归档项目经理的项目不进队列", () => {
    ledger.archivePm(zhou.pmId);
    restart();
    expect(ledger.projectCatalog.scanAtStartup(now)).toBe(1);
    expect(ledger.projectCatalog.claimCatalog(now)?.projectId).toBe(lin.projectId);
    expect(ledger.projectCatalog.claimCatalog(now)).toBeNull();
  });
});

describe("afterDriverEvent", () => {
  beforeEach(() => {
    writeFor(lin);
    writeFor(zhou);
    now += PROJECT_CATALOG_MIN_INTERVAL_MS;
    claimable.mockClear();
  });

  it("项目经理会话 turn.ended 且这个项目到期时进队列，提交后调 onCatalogClaimable", () => {
    claimable.mockImplementation(() => expect(db.inTransaction).toBe(false));
    say(lin.conversationId, "user", "字".repeat(PROJECT_CATALOG_REFRESH_DELTA / PROJECT_CATALOG_USER_CHAR_WEIGHT));
    turnEnded(lin.sessionId);
    expect(claimable).toHaveBeenCalledTimes(1);
    expect(ledger.projectCatalog.claimCatalog(now)?.projectId).toBe(lin.projectId);
  });

  it("项目经理会话 turn.ended 但没到期时不进队列，也不叫醒", () => {
    say(lin.conversationId, "user", "字".repeat(PROJECT_CATALOG_REFRESH_DELTA / PROJECT_CATALOG_USER_CHAR_WEIGHT - 1));
    say(lin.conversationId, "agent", "字".repeat(PROJECT_CATALOG_USER_CHAR_WEIGHT - 1));
    turnEnded(lin.sessionId);
    expect(claimable).not.toHaveBeenCalled();
    expect(ledger.projectCatalog.hasQueued()).toBe(false);
  });

  it("Worker、总助会话的事件和项目经理的其他事件什么都不做", () => {
    say(lin.conversationId, "user", "字".repeat(PROJECT_CATALOG_REFRESH_DELTA));
    const worker = ledger.hubCall(lin.sessionId, "worker.start", { title: "查", task: "查一下", noWorktree: true }).data.worker;
    const workerSession = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", worker.id)!.id;
    turnEnded(workerSession);
    const assistant = ledger.createRouterAssistantSession({ vendor: "claude", model: "haiku", effort: "low", cwd: root });
    turnEnded(assistant.id);
    ledger.applyDriverEvent(lin.sessionId, { type: "turn.started", at: now, messageIds: [] } as unknown as DriverEvent);
    expect(claimable).not.toHaveBeenCalled();
    expect(ledger.projectCatalog.hasQueued()).toBe(false);
  });

  it("加权字数只算切点之后 kind = text 的用户和项目经理的话，不算工具、Worker 汇报、系统消息", () => {
    const big = "字".repeat(PROJECT_CATALOG_REFRESH_DELTA);
    say(lin.conversationId, "agent", big, "worker", { summary: "汇报" });
    say(lin.conversationId, "system", big, "system");
    say(lin.conversationId, "agent", big, "tool");
    turnEnded(lin.sessionId);
    expect(ledger.projectCatalog.hasQueued()).toBe(false);
    say(lin.conversationId, "agent", "字".repeat(PROJECT_CATALOG_REFRESH_DELTA));
    turnEnded(lin.sessionId);
    expect(ledger.projectCatalog.hasQueued()).toBe(true);
  });
});

describe("markForcedIn", () => {
  it("建项目的同一个事务里记 forced，新项目马上进队列", () => {
    claimable.mockClear();
    const wang = newPm("小王", "mercury", "会议录音转文字");
    expect(rowOf(wang.projectId)).toMatchObject({ forced: 1, refreshed_at: null });
    expect(claimable).toHaveBeenCalled();
    expect(claimFor(wang.projectId)?.input.project).toMatchObject({ name: "mercury", description: "会议录音转文字" });
  });

  it("hub graph finish 后记 forced，过了最短间隔就进队列，没过的等到间隔再进", () => {
    writeFor(lin);
    writeFor(zhou);
    const writtenAt = now;
    now += 60_000;
    finishGraph(lin);
    expect(rowOf(lin.projectId)?.forced).toBe(1);
    expect(ledger.projectCatalog.claimCatalog(now)).toBeNull();
    now = writtenAt + PROJECT_CATALOG_MIN_INTERVAL_MS;
    const job = ledger.projectCatalog.claimCatalog(now)!;
    expect(job.projectId).toBe(lin.projectId);
    expect(job.input.graphs).toEqual([{ title: "导出", goal: null }]);
  });

  it("项目经理换代（handover switched）后记 forced", () => {
    writeFor(lin);
    now += 10;
    turnEnded(lin.sessionId);
    const { handoverId } = ledger.renewSession(lin.pmId);
    ledger.claimHandover();
    ledger.handoverForked(handoverId, { kind: "native", ref: { forker: "claude", handle: { forkId: "f1" } } });
    ledger.handoverWritten(handoverId, { text: "交接正文", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 } });
    expect(db.get<{ status: string }>("SELECT status FROM handovers WHERE id = ?", handoverId)?.status).toBe("switched");
    expect(rowOf(lin.projectId)?.forced).toBe(1);
  });

  const unitCatalog = () => {
    const ctx = createLedgerContext(db, { now: () => now });
    const projects = { projectCard: () => ({ name: "x", mainFolder: "/x", otherFolders: [] }) } as unknown as LedgerProjects;
    const wake = vi.fn();
    return { ctx, catalogLedger: createLedgerProjectCatalog(ctx, projects, { onCatalogClaimable: wake }), wake };
  };

  it("事务回滚时 forced 不留下", () => {
    writeFor(lin);
    const { ctx, catalogLedger, wake } = unitCatalog();
    expect(() =>
      ctx.write((p) => {
        catalogLedger.markForcedIn(p, lin.projectId, "graph_finished");
        throw new Error("回滚");
      }),
    ).toThrow("回滚");
    expect(rowOf(lin.projectId)?.forced).toBe(0);
    expect(wake).not.toHaveBeenCalled();
    expect(catalogLedger.hasQueued()).toBe(false);
  });

  it("不是活跃项目时静默忽略", () => {
    ledger.archivePm(zhou.pmId);
    db.run("DELETE FROM project_catalogs");
    const { ctx, catalogLedger, wake } = unitCatalog();
    ctx.write((p) => {
      catalogLedger.markForcedIn(p, zhou.projectId, "graph_finished");
      catalogLedger.markForcedIn(p, 9_999, "graph_finished");
    });
    expect(db.all("SELECT * FROM project_catalogs")).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });
});

describe("claimCatalog", () => {
  it("队列空时返回 null，不查库", () => {
    writeFor(lin);
    writeFor(zhou);
    expect(ledger.projectCatalog.hasQueued()).toBe(false);
    const get = vi.spyOn(db, "get");
    const all = vi.spyOn(db, "all");
    expect(ledger.projectCatalog.claimCatalog(now)).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
    get.mockRestore();
    all.mockRestore();
  });

  it("切点记成领活那一刻这个项目对话里最大的消息编号", () => {
    say(lin.conversationId, "user", "第一句");
    const last = say(lin.conversationId, "agent", "回答");
    say(zhou.conversationId, "user", "别的项目");
    expect(claimFor(lin.projectId)?.cutMessageId).toBe(last);
  });

  it("首次建档的输入里 previous 是 null，带最新一份交接和最近原话", () => {
    const from = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ?", lin.conversationId)!.id;
    for (const text of ["旧交接", "新交接"]) {
      db.run(
        "INSERT INTO handovers (conversation_id, from_session_id, auto, status, text, cut_message_id, created_at, updated_at) VALUES (?, ?, 0, 'switched', ?, 1, 0, 0)",
        lin.conversationId,
        from,
        text,
      );
    }
    say(lin.conversationId, "user", "做个导出");
    say(lin.conversationId, "agent", "好的");
    const job = claimFor(lin.projectId)!;
    expect(job.input.previous).toBeNull();
    expect(job.input.handover).toBe("新交接");
    expect(job.input.dialog).toBe("用户：做个导出\n\n项目经理：好的");
    expect(job.input.dialogTruncated).toBe(false);
    expect(job.input.files).toEqual([]);
    expect(job.input.project).toMatchObject({ id: lin.projectId, name: "后端核心", description: "API 与存储", mainFolder: lin.folder });
  });

  it("增量输入只带切点之后的原话、任务图、Worker 汇报和切点之后写成的交接", () => {
    const from = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ?", lin.conversationId)!.id;
    say(lin.conversationId, "user", "老话");
    say(lin.conversationId, "agent", "老汇报", "worker", { summary: "老汇报" });
    db.run(
      "INSERT INTO handovers (conversation_id, from_session_id, auto, status, text, cut_message_id, created_at, updated_at) VALUES (?, ?, 0, 'switched', '老交接', 1, 0, 0)",
      lin.conversationId,
      from,
    );
    const first = writeFor(lin);
    now += PROJECT_CATALOG_MIN_INTERVAL_MS;
    say(lin.conversationId, "user", "新话");
    db.run("UPDATE messages SET worker_id = 3 WHERE id = ?", say(lin.conversationId, "agent", "全文", "worker", { summary: "新汇报" }));
    force(lin);
    const job = claimFor(lin.projectId)!;
    expect(job.input.previous).toEqual(catalog);
    expect(job.input.dialog).toBe("用户：新话");
    expect(job.input.workerReports).toEqual(["Worker #3：新汇报"]);
    expect(job.input.handover).toBeNull();
    expect(job.cutMessageId).toBeGreaterThan(first.cutMessageId);
  });

  it("原话超过 PROJECT_CATALOG_DIALOG_MAX_CHARS 时从新往旧取并标 dialogTruncated", () => {
    say(lin.conversationId, "user", `最早${"旧".repeat(PROJECT_CATALOG_DIALOG_MAX_CHARS)}`);
    say(lin.conversationId, "agent", "最新");
    const job = claimFor(lin.projectId)!;
    expect(job.input.dialogTruncated).toBe(true);
    expect(job.input.dialog.endsWith("项目经理：最新")).toBe(true);
    expect(job.input.dialog).toContain("（前面略）");
    expect(job.input.dialog).not.toContain("最早");
    expect(job.input.dialog.length).toBeLessThanOrEqual(PROJECT_CATALOG_DIALOG_MAX_CHARS + 50);
  });

  it("同一个项目在跑的时候不会被再领一次", () => {
    const job = claimFor(lin.projectId)!;
    finishGraph(lin);
    const again = [ledger.projectCatalog.claimCatalog(now), ledger.projectCatalog.claimCatalog(now)];
    expect(again.map((j) => j?.projectId)).not.toContain(lin.projectId);
    ledger.projectCatalog.catalogWritten(job, catalog, null);
  });
});

describe("catalogWritten", () => {
  it("存档案和用量，切点前移到 job.cutMessageId，forced、失败次数清零，移出队列", () => {
    say(lin.conversationId, "user", "你好");
    const job = claimFor(lin.projectId)!;
    ledger.projectCatalog.catalogFailed(job, { reason: "error" });
    now += PROJECT_CATALOG_RETRY_BACKOFF_MS;
    const retry = claimFor(lin.projectId)!;
    const usage = { input: 1, cacheRead: 0, cacheWrite: 0, output: 2, context: 3 };
    ledger.projectCatalog.catalogWritten(retry, catalog, usage);
    expect(rowOf(lin.projectId)).toMatchObject({ cut_message_id: retry.cutMessageId, refreshed_at: now, forced: 0, attempts: 0, next_attempt_at: null, last_error: null });
    expect(JSON.parse(db.get<{ usage: string }>("SELECT usage FROM project_catalogs WHERE project_id = ?", lin.projectId)!.usage)).toEqual(usage);
    expect(JSON.parse(rowOf(lin.projectId)!.catalog_json!)).toEqual(catalog);
    expect(claimFor(lin.projectId)).toBeNull();
  });

  it("写成后名片缓存失效：getRouterDigest 的 project.catalog 换成新档案", () => {
    const before = ledger.getRouterDigest();
    expect(before.pms.find((p) => p.pmId === lin.pmId)?.project?.catalog).toBeNull();
    writeFor(lin);
    const after = ledger.getRouterDigest();
    expect(after).not.toBe(before);
    expect(after.pms.find((p) => p.pmId === lin.pmId)?.project?.catalog).toEqual({ oneLiner: catalog.oneLiner, aliases: catalog.aliases, focus: catalog.focus, refreshedAt: now });
  });

  it("档案超过 PROJECT_CATALOG_ROW_MAX_BYTES 时按 invalid_reply 失败记，旧档案不动", () => {
    writeFor(lin);
    const old = rowOf(lin.projectId)!;
    now += PROJECT_CATALOG_MIN_INTERVAL_MS;
    force(lin);
    const job = claimFor(lin.projectId)!;
    const huge = { ...catalog, decisions: Array.from({ length: 200 }, () => "大".repeat(100)) };
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(PROJECT_CATALOG_ROW_MAX_BYTES);
    ledger.projectCatalog.catalogWritten(job, huge, null);
    const row = rowOf(lin.projectId)!;
    expect(row).toMatchObject({ catalog_json: old.catalog_json, cut_message_id: old.cut_message_id, refreshed_at: old.refreshed_at, attempts: 1 });
    expect(row.last_error).toMatch(/^invalid_reply/);
  });

  it("项目在写档期间被删或归档时静默忽略", () => {
    const job = claimFor(zhou.projectId)!;
    ledger.archivePm(zhou.pmId);
    expect(() => ledger.projectCatalog.catalogWritten(job, catalog, null)).not.toThrow();
    expect(rowOf(zhou.projectId)?.catalog_json).toBeNull();
    expect(() => ledger.projectCatalog.catalogFailed(job, { reason: "error" })).not.toThrow();
    expect(rowOf(zhou.projectId)?.attempts).toBe(0);
  });
});

describe("catalogFailed", () => {
  it("切点不动，旧档案照旧在名片里", () => {
    const first = writeFor(lin);
    now += PROJECT_CATALOG_MIN_INTERVAL_MS;
    say(lin.conversationId, "user", "新话");
    force(lin);
    ledger.projectCatalog.catalogFailed(claimFor(lin.projectId)!, { reason: "timeout", detail: "超时" });
    expect(rowOf(lin.projectId)?.cut_message_id).toBe(first.cutMessageId);
    expect(ledger.getRouterDigest().pms.find((p) => p.pmId === lin.pmId)?.project?.catalog?.oneLiner).toBe(catalog.oneLiner);
  });

  it("退避从 PROJECT_CATALOG_RETRY_BACKOFF_MS 起每次翻倍", () => {
    ledger.projectCatalog.catalogFailed(claimFor(lin.projectId)!, { reason: "error" });
    expect(rowOf(lin.projectId)?.next_attempt_at).toBe(now + PROJECT_CATALOG_RETRY_BACKOFF_MS);
    expect(claimFor(lin.projectId)).toBeNull();
    now += PROJECT_CATALOG_RETRY_BACKOFF_MS;
    ledger.projectCatalog.catalogFailed(claimFor(lin.projectId)!, { reason: "error" });
    expect(rowOf(lin.projectId)?.next_attempt_at).toBe(now + 2 * PROJECT_CATALOG_RETRY_BACKOFF_MS);
  });

  it("同一切点失败满 PROJECT_CATALOG_MAX_ATTEMPTS 次后隔 PROJECT_CATALOG_GIVE_UP_MS 再试", () => {
    for (let i = 0; i < 3; i++) {
      const job = claimFor(lin.projectId)!;
      ledger.projectCatalog.catalogFailed(job, { reason: "invalid_reply" });
      now = rowOf(lin.projectId)!.next_attempt_at!;
    }
    expect(rowOf(lin.projectId)).toMatchObject({ attempts: 3, next_attempt_at: now });
    const lastFailedAt = now - PROJECT_CATALOG_GIVE_UP_MS;
    expect(lastFailedAt).toBeGreaterThan(0);
    expect(claimFor(lin.projectId)?.projectId).toBe(lin.projectId);
  });

  it("shutdown 不算失败次数、不退避", () => {
    ledger.projectCatalog.catalogFailed(claimFor(lin.projectId)!, { reason: "shutdown" });
    expect(rowOf(lin.projectId)).toMatchObject({ attempts: 0, next_attempt_at: null });
    expect(claimFor(lin.projectId)?.projectId).toBe(lin.projectId);
  });
});

describe("cardOf / detailOf", () => {
  it("还没写成过档案时都返回 null", () => {
    expect(ledger.projectCatalog.cardOf(lin.projectId)).toBeNull();
    expect(ledger.projectCatalog.detailOf(lin.projectId)).toBeNull();
    expect(ledger.projectCatalog.detailOf(9_999)).toBeNull();
  });

  it("detailOf 带上用户写的 projects.description 和写成时刻", () => {
    writeFor(lin);
    expect(ledger.projectCatalog.detailOf(lin.projectId)).toEqual({
      projectId: lin.projectId,
      projectName: "后端核心",
      description: "API 与存储",
      catalog,
      refreshedAt: now,
    });
    ledger.archivePm(lin.pmId);
    expect(ledger.projectCatalog.detailOf(lin.projectId)).toBeNull();
  });

  it("getRouterDigest 的每个项目带 description 和 catalog，不再带 personaSummary、pmNote", () => {
    writeFor(lin);
    const entries = ledger.getRouterDigest().pms;
    const linEntry = entries.find((p) => p.pmId === lin.pmId)!;
    expect(linEntry.project).toMatchObject({ description: "API 与存储", catalog: { oneLiner: catalog.oneLiner } });
    expect(entries.find((p) => p.pmId === zhou.pmId)!.project).toMatchObject({ description: null, catalog: null });
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("personaSummary");
      expect(entry).not.toHaveProperty("pmNote");
    }
  });
});
