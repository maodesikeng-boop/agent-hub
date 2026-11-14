// 项目经理、项目（11-03 起一个项目经理就是一个会话，最多一个项目）、文件夹、性格设定、重试、hub 调用、启动上下文。
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import type { AnyActionRow } from "../../shared/actions.ts";
import type { ConversationId, Message, PmId, SessionId } from "../../shared/domain.ts";
import type { HubArgs, HubCommand } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import type { LedgerErrorCode } from "../../shared/ledger.ts";
import { HUB_CALL_FIELD_MAX_BYTES, MAX_NAME_CHARS, MAX_PERSONA_BYTES } from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { personaFilePath } from "../../shared/paths.ts";
import { bundledModelCatalog, type ModelCatalog } from "../../shared/vendors.ts";
import { listActions, setActionStatus } from "../actions/index.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { contentHash, createResolveFolder, truncateField, writeFileAtomic } from "./files.ts";
import { createLedger } from "./index.ts";
import { DEFAULT_PROJECT_NAME } from "./projects.ts";
import type { LedgerOptions, SqliteLedger } from "./index.ts";

const INITIAL_SEQ = 9_000;
let db: Db;
let root: string;
let dataHome: string;
let personasDir: string;
let work: string;
let now: number;
let ledger: SqliteLedger;
let changes: Change[];
let enqueued: AnyActionRow[];
/** 小林：manage_only；阿周：hands_on。 */
let lin: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };
let zhou: { pmId: PmId; conversationId: ConversationId; sessionId: SessionId };

function options(extra: Partial<LedgerOptions> = {}): LedgerOptions {
  return {
    now: () => now,
    initialSeq: INITIAL_SEQ,
    pmHomeRoot: join(dataHome, "pm-home"),
    personasDir,
    dataHome,
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    ...extra,
  };
}

function folder(name: string): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  return realpathSync.native(dir);
}

beforeEach(() => {
  db = openTestDb();
  root = mkdtempSync(join(tmpdir(), "agent-hub-ledger-m2-"));
  dataHome = join(root, ".agent-hub");
  personasDir = join(dataHome, "state", "personas");
  work = join(root, "work");
  mkdirSync(work, { recursive: true });
  now = 1_000;
  ledger = createLedger(db, options());
  const a = ledger.createPm({ name: "小林", mode: "manage_only", persona: "小林的习惯" });
  const b = ledger.createPm({ name: "阿周", mode: "hands_on", persona: "阿周的习惯" });
  lin = { pmId: a.pm.id, conversationId: a.conversation.id, sessionId: a.sessionId };
  zhou = { pmId: b.pm.id, conversationId: b.conversation.id, sessionId: b.sessionId };
  changes = [];
  enqueued = [];
  ledger.onChange((c) => changes.push(c));
  ledger.onActionEnqueued((a) => enqueued.push(a));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function hub<C extends HubCommand>(sessionId: SessionId, command: C, args: HubArgs<C>) {
  return ledger.hubCall(sessionId, command, args);
}

function expectLedgerError(fn: () => unknown, code: LedgerErrorCode, message?: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LedgerRequestError);
  expect((caught as LedgerRequestError).code).toBe(code);
  if (message) expect((caught as LedgerRequestError).message).toMatch(message);
}

function count(table: string, where = "1 = 1", ...params: (string | number)[]): number {
  return db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...params)!.n;
}

/** 关心的几张表的行数，“什么都没写”就比它。 */
function tableCounts() {
  return ["pms", "conversations", "agent_sessions", "messages", "actions", "projects", "project_folders", "persona_changes", "handoffs"].map(
    (t) => [t, count(t)],
  );
}

function messagesIn(conversationId: ConversationId): Message[] {
  return ledger.snapshot().conversations.find((c) => c.conversation.id === conversationId)!.messages;
}

function hubCalls() {
  return db.all<{ session_id: number; command: string; args: string; ok: number; error_code: string | null; result: string }>(
    "SELECT * FROM hub_calls ORDER BY id",
  );
}

function sessionRow(id: SessionId) {
  return createSessionStore(db).get(id)!;
}

/** 小林在自己的会话里建项目 foo（主文件夹 work/foo）。 */
function createFoo(dir = folder("foo"), caller: SessionId = lin.sessionId) {
  const result = hub(caller, "project.create", { folder: dir });
  return { ...result.data, dir };
}

describe("createPm（M2）", () => {
  it("建项目经理：一个项目经理、一个私聊、一个带 pm_id 的会话、性格设定文件；推 pm.created、conversation.created、session.created", () => {
    now = 2_000;
    const result = ledger.createPm({ name: "  老王 ", mode: "hands_on", persona: "老王的习惯", defaultModel: "" });
    expect(result.pm).toMatchObject({ name: "老王", mode: "hands_on", defaultModel: null, personaFile: personaFilePath(personasDir, result.pm.id) });
    expect(sessionRow(result.sessionId)).toMatchObject({ pmId: result.pm.id, conversationId: result.conversation.id, generation: 1 });
    const file = personaFilePath(personasDir, result.pm.id);
    expect(readFileSync(file, "utf8")).toBe("老王的习惯");
    const row = db.get<{ persona: string; persona_file_hash: string }>("SELECT persona, persona_file_hash FROM pms WHERE id = ?", result.pm.id)!;
    expect(row).toEqual({ persona: "老王的习惯", persona_file_hash: contentHash("老王的习惯") });
    expect(changes.map((c) => c.type)).toEqual(["pm.created", "conversation.created", "session.created"]);
    const created = changes[2]!;
    expect(created.type === "session.created" && created.data.session).toMatchObject({ sessionId: result.sessionId, pmId: result.pm.id, generation: 1, status: "idle" });
    // 建的时候不算修改
    expect(count("persona_changes")).toBe(0);
  });

  it("同名项目经理：conflict，什么都没写、什么都没推", () => {
    const before = tableCounts();
    expectLedgerError(() => ledger.createPm({ name: "小林", mode: "manage_only", persona: "" }), "conflict", /小林/);
    expect(tableCounts()).toEqual(before);
    expect(changes).toEqual([]);
  });

  it("名字不对、模式不对、性格设定太长、模型名太长：invalid，什么都没写", () => {
    const before = tableCounts();
    expectLedgerError(() => ledger.createPm({ name: "  ", mode: "manage_only", persona: "" }), "invalid");
    expectLedgerError(() => ledger.createPm({ name: "a\nb", mode: "manage_only", persona: "" }), "invalid");
    expectLedgerError(() => ledger.createPm({ name: "x", mode: "default" as never, persona: "" }), "invalid");
    expectLedgerError(() => ledger.createPm({ name: "x", mode: "manage_only", persona: "长".repeat(MAX_PERSONA_BYTES) }), "invalid");
    expectLedgerError(() => ledger.createPm({ name: "x", mode: "manage_only", persona: "", defaultModel: "m".repeat(101) }), "invalid");
    expect(tableCounts()).toEqual(before);
  });

  it("建的时候选了主文件夹：同一个事务里建好项目，会话在主文件夹里跑，对话里一条“项目已建好”", () => {
    const dir = folder("wang");
    now = 2_500;
    const result = ledger.createPm({ name: "老王", mode: "manage_only", persona: "", folder: join(work, "wang", "..", "wang") });
    expect(result.project).toMatchObject({ name: "wang", status: "active", pmId: result.pm.id, conversationId: result.conversation.id });
    expect(sessionRow(result.sessionId)).toMatchObject({ cwd: dir, addDirs: [] });
    expect(messagesIn(result.conversation.id)).toEqual([
      expect.objectContaining({ sender: "system", status: null, meta: { event: "project.created", projectId: result.project!.id } }),
    ]);
    expect(changes.map((c) => c.type)).toEqual([
      "pm.created",
      "project.created",
      "conversation.created",
      "session.created",
      "folders.updated",
      "message.created",
    ]);
    // 不选就没有项目，会话在自己的空目录里
    const plain = ledger.createPm({ name: "老李", mode: "manage_only", persona: "" });
    expect(plain.project).toBeNull();
    expect(sessionRow(plain.sessionId).cwd).toBe(join(dataHome, "pm-home", String(plain.pm.id)));
  });

  it("选的文件夹不存在：invalid，项目经理也没建", () => {
    createFoo();
    changes = [];
    const before = tableCounts();
    expectLedgerError(() => ledger.createPm({ name: "老王", mode: "manage_only", persona: "", folder: join(work, "nope") }), "invalid", /文件夹不存在/);
    expect(tableCounts()).toEqual(before);
    expect(changes).toEqual([]);
  });

  it("选的文件夹已是别的项目经理的主文件夹：照样建好，各管各的项目（同一个文件夹可以有多个项目经理）", () => {
    const foo = createFoo();
    const wang = ledger.createPm({ name: "老王", mode: "manage_only", persona: "", folder: foo.dir });
    expect(wang.project).toMatchObject({ name: "foo", pmId: wang.pm.id, status: "active" });
    expect(wang.project!.id).not.toBe(foo.project.id);
    expect(sessionRow(wang.sessionId).cwd).toBe(foo.dir);
    // 小林的项目不受影响
    expect(sessionRow(lin.sessionId).cwd).toBe(foo.dir);
    const snap = ledger.snapshot();
    expect(snap.projects.map((p) => [p.pmId, p.name])).toEqual([
      [lin.pmId, "foo"],
      [wang.pm.id, "foo"],
    ]);
    expect(snap.folders.filter((f) => f.path === foo.dir && f.isMain).map((f) => f.projectId)).toEqual([foo.project.id, wang.project!.id]);
  });
});

describe("建项目（在项目经理的会话里一句话）", () => {
  it("项目挂在项目经理唯一的对话上；会话的工作目录换成主文件夹；对话里“项目已建好”；hub_calls 一行；名字默认是文件夹名", () => {
    const dir = folder("foo");
    now = 3_000;
    const conversationsBefore = count("conversations");
    const sessionsBefore = count("agent_sessions");
    // 路径里绕一下，存的是真实路径
    const result = hub(lin.sessionId, "project.create", { folder: join(work, "foo", "..", "foo"), description: "一个项目" });
    const { project, mainFolder } = result.data;
    expect(project).toMatchObject({ name: "foo", description: "一个项目", status: "active", pmId: lin.pmId, conversationId: lin.conversationId, createdAt: 3_000 });
    expect(mainFolder).toMatchObject({ projectId: project.id, path: dir, isMain: true, removedAt: null });
    // 不另开对话、不另开会话
    expect(count("conversations")).toBe(conversationsBefore);
    expect(count("agent_sessions")).toBe(sessionsBefore);
    expect(sessionRow(lin.sessionId)).toMatchObject({ cwd: dir, addDirs: [], generation: 1, status: "idle" });
    const message = messagesIn(lin.conversationId).at(-1)!;
    expect(message).toMatchObject({ sender: "system", kind: "text", status: null, sessionId: null, meta: { event: "project.created", projectId: project.id } });
    expect(message.text).toContain("项目已建好");
    expect(result.text).toContain("foo");
    expect(hubCalls()).toEqual([
      expect.objectContaining({ session_id: lin.sessionId, command: "project.create", ok: 1, error_code: null, result: result.text }),
    ]);
    expect(changes.map((c) => c.type)).toEqual(["project.created", "folders.updated", "message.created"]);
    // 不登记 session.start：下一条消息前驱动层按新的工作目录重启
    expect(listActions(db)).toEqual([]);
    const snap = ledger.snapshot();
    expect(snap.projects).toEqual([project]);
    expect(snap.folders).toEqual([mainFolder]);
  });

  it("给了 --name 就用它", () => {
    const result = hub(zhou.sessionId, "project.create", { folder: folder("bar"), name: "记账小工具" });
    expect(result.data.project).toMatchObject({ name: "记账小工具", pmId: zhou.pmId, conversationId: zhou.conversationId });
  });

  it("没给名字：默认用文件夹名，超过 40 个字截到 40 个字；文件夹名用不了（主文件夹是 /、带换行）就用固定的名字", () => {
    const long = folder("长".repeat(MAX_NAME_CHARS + 10));
    expect(hub(lin.sessionId, "project.create", { folder: long }).data.project.name).toBe("长".repeat(MAX_NAME_CHARS));
    expect(hub(zhou.sessionId, "project.create", { folder: "/" }).data.project.name).toBe(DEFAULT_PROJECT_NAME);
    const wang = ledger.createPm({ name: "老王", mode: "manage_only", persona: "", folder: folder("a\nb") });
    expect(wang.project!.name).toBe(DEFAULT_PROJECT_NAME);
    // 建项目经理时选的主文件夹走同一条路
    const li = ledger.createPm({ name: "老李", mode: "manage_only", persona: "", folder: folder("名".repeat(MAX_NAME_CHARS + 1)) });
    expect(li.project!.name).toBe("名".repeat(MAX_NAME_CHARS));
  });

  it("只有自己给的名字不对才报“项目名字不对”", () => {
    const before = tableCounts();
    expectLedgerError(() => hub(lin.sessionId, "project.create", { folder: folder("ok"), name: "名".repeat(MAX_NAME_CHARS + 1) }), "invalid", /项目名字不对/);
    expectLedgerError(() => hub(lin.sessionId, "project.create", { folder: folder("ok"), name: "  " }), "invalid", /项目名字不对/);
    expect(tableCounts()).toEqual(before);
  });

  it("已经有项目了又要建：conflict，“一个项目经理只管一个项目，请新建一个项目经理”，什么都没写", () => {
    createFoo();
    changes = [];
    const before = tableCounts();
    expectLedgerError(
      () => hub(lin.sessionId, "project.create", { folder: folder("bar") }),
      "conflict",
      /^一个项目经理只管一个项目，请新建一个项目经理。小林现在管的是“foo”/,
    );
    expect(tableCounts()).toEqual(before);
    expect(changes).toEqual([]);
  });

  it("文件夹不对：不存在、是文件、在数据目录里 → invalid；名字不对 → invalid；都什么也没写", () => {
    createFoo();
    writeFileSync(join(work, "a-file"), "x");
    mkdirSync(join(dataHome, "inside"), { recursive: true });
    changes = [];
    const before = tableCounts();
    const callsBefore = hubCalls().length;
    const cases: [HubArgs<"project.create">, LedgerErrorCode, RegExp][] = [
      [{ folder: join(work, "nope") }, "invalid", /文件夹不存在，请先建好：.*nope/],
      [{ folder: join(work, "a-file") }, "invalid", /不是文件夹/],
      [{ folder: join(dataHome, "inside") }, "invalid", /数据目录/],
      [{ folder: dataHome }, "invalid", /数据目录/],
      [{ folder: folder("other"), name: "a\nb" }, "invalid", /名字/],
    ];
    for (const [args, code, message] of cases) expectLedgerError(() => hub(zhou.sessionId, "project.create", args), code, message);
    expect(tableCounts()).toEqual(before);
    expect(changes).toEqual([]);
    // 失败的调用也记一行
    expect(hubCalls().slice(callsBefore).map((c) => [c.ok, c.error_code])).toEqual(cases.map(([, code]) => [0, code]));
  });

  it("同一个文件夹可以有多个项目经理：别人的主文件夹也能拿来建项目，同名也行；hub status 里各是各的", () => {
    const foo = createFoo();
    changes = [];
    const result = hub(zhou.sessionId, "project.create", { folder: foo.dir });
    expect(result.data.project).toMatchObject({ name: "foo", pmId: zhou.pmId, conversationId: zhou.conversationId });
    expect(result.data.mainFolder).toMatchObject({ path: foo.dir, isMain: true });
    expect(sessionRow(zhou.sessionId).cwd).toBe(foo.dir);
    expect(changes.map((c) => c.type)).toEqual(["project.created", "folders.updated", "message.created"]);
    // 改名后也照样（项目名不要求唯一，网页和 hub status 靠项目经理的名字分）
    const named = ledger.createPm({ name: "老王", mode: "manage_only", persona: "", folder: foo.dir });
    hub(named.sessionId, "project.setup", { command: "pnpm install" });
    const linStatus = hub(lin.sessionId, "status", {});
    const zhouStatus = hub(zhou.sessionId, "status", {});
    expect(linStatus.text).toContain("小林");
    expect(zhouStatus.text).toContain("阿周");
    expect(linStatus.data).toMatchObject({ project: { id: foo.project.id, mainFolder: foo.dir }, setupCommand: null });
    expect(zhouStatus.data).toMatchObject({ project: { id: result.data.project.id, mainFolder: foo.dir }, setupCommand: null });
    // 准备命令按项目各存一份：老王设了不影响小林、阿周
    expect(hub(named.sessionId, "status", {}).data).toMatchObject({ project: { id: named.project!.id }, setupCommand: "pnpm install" });
  });

  it("挂文件夹：别的项目的主文件夹、别的项目挂着的文件夹也能挂", () => {
    const foo = createFoo();
    const shared = folder("shared");
    hub(lin.sessionId, "project.attach", { folder: shared });
    hub(zhou.sessionId, "project.create", { folder: folder("bar") });
    expect(hub(zhou.sessionId, "project.attach", { folder: foo.dir }).data.folder).toMatchObject({ path: foo.dir, isMain: false });
    expect(hub(zhou.sessionId, "project.attach", { folder: shared }).data.folder).toMatchObject({ path: shared, isMain: false });
  });

  it("默认的 resolveFolder：展开 ~，相对路径拒绝", () => {
    const resolveFolder = createResolveFolder({ dataHome, userHome: root });
    expect(resolveFolder("~/work")).toBe(realpathSync.native(work));
    expectLedgerError(() => resolveFolder("work"), "invalid", /绝对路径/);
    expectLedgerError(() => resolveFolder(" "), "invalid");
  });
});

describe("文件夹", () => {
  it("挂文件夹：多一行、会话的 add_dirs 有它、对话里一条只给人看的系统消息，不另发给 agent", () => {
    const foo = createFoo();
    const extra = folder("extra");
    changes = [];
    enqueued = [];
    const result = hub(lin.sessionId, "project.attach", { folder: extra });
    expect(result.data.folder).toMatchObject({ projectId: foo.project.id, path: extra, isMain: false, removedAt: null });
    expect(count("project_folders", "project_id = ? AND removed_at IS NULL", foo.project.id)).toBe(2);
    expect(sessionRow(lin.sessionId)).toMatchObject({ cwd: foo.dir, addDirs: [extra] });
    const message = messagesIn(lin.conversationId).at(-1)!;
    expect(message).toMatchObject({
      sender: "system",
      status: null,
      sessionId: null,
      meta: { event: "folder.attached", projectId: foo.project.id, folderId: result.data.folder.id, path: extra },
    });
    expect(enqueued).toEqual([]);
    expect(changes.map((c) => c.type)).toEqual(["folders.updated", "message.created"]);
    const updated = changes[0]!;
    expect(updated.type === "folders.updated" && updated.data.folders.map((f) => f.path)).toEqual([foo.dir, extra]);
  });

  it("已经挂着、挂主文件夹 → conflict；还没有项目 → not_found；目录不存在 → invalid", () => {
    const foo = createFoo();
    const extra = folder("extra");
    hub(lin.sessionId, "project.attach", { folder: extra });
    expectLedgerError(() => hub(lin.sessionId, "project.attach", { folder: extra }), "conflict");
    expectLedgerError(() => hub(lin.sessionId, "project.attach", { folder: foo.dir }), "conflict");
    expectLedgerError(() => hub(zhou.sessionId, "project.attach", { folder: extra }), "not_found", new RegExp(`还没有项目.*${HUB_COMMAND} project create`));
    expectLedgerError(() => hub(zhou.sessionId, "project.detach", { folder: extra }), "not_found", /还没有项目/);
    expectLedgerError(() => hub(lin.sessionId, "project.attach", { folder: join(work, "gone") }), "invalid", /不存在/);
  });

  it("移除文件夹：挂着的标移除时间；主文件夹 invalid；没挂过的 not_found；移除后可以再挂", () => {
    const foo = createFoo();
    const extra = folder("extra");
    hub(lin.sessionId, "project.attach", { folder: extra });
    now = 5_000;
    changes = [];
    const result = hub(lin.sessionId, "project.detach", { folder: extra });
    expect(result.data.folder).toMatchObject({ path: extra, removedAt: 5_000 });
    expect(sessionRow(lin.sessionId).addDirs).toEqual([]);
    expect(messagesIn(lin.conversationId).at(-1)!.meta).toMatchObject({ event: "folder.detached", folderId: result.data.folder.id });
    expect(changes.map((c) => c.type)).toEqual(["folders.updated", "message.created"]);
    expect(ledger.snapshot().folders.map((f) => f.path)).toEqual([foo.dir]);
    expectLedgerError(() => hub(lin.sessionId, "project.detach", { folder: foo.dir }), "invalid", /主文件夹/);
    expectLedgerError(() => hub(lin.sessionId, "project.detach", { folder: extra }), "not_found");
    expectLedgerError(() => hub(lin.sessionId, "project.detach", { folder: folder("never") }), "not_found");
    hub(lin.sessionId, "project.attach", { folder: extra });
    expect(sessionRow(lin.sessionId).addDirs).toEqual([extra]);
  });

  it("移除已经从磁盘上删掉的文件夹：按字面路径找到那一行，标移除", () => {
    createFoo();
    const extra = folder("extra");
    hub(lin.sessionId, "project.attach", { folder: extra });
    rmSync(extra, { recursive: true });
    const result = hub(lin.sessionId, "project.detach", { folder: extra });
    expect(result.data.folder).toMatchObject({ path: extra });
    expect(result.data.folder.removedAt).not.toBeNull();
  });
});

describe("会话状态", () => {
  it("驱动层把会话写成 ended 之后 refreshSessionState：推一条 session.status（ended）；没再变就不重复推", () => {
    createSessionStore(db).update(lin.sessionId, { status: "ended", pid: null });
    changes = [];
    ledger.refreshSessionState(lin.sessionId);
    expect(changes).toEqual([
      expect.objectContaining({ type: "session.status", data: { session: expect.objectContaining({ sessionId: lin.sessionId, status: "ended", activity: "idle" }) } }),
    ]);
    ledger.refreshSessionState(lin.sessionId);
    expect(changes).toHaveLength(1);
    // 不存在的会话：什么也不做
    ledger.refreshSessionState(99_999);
    expect(changes).toHaveLength(1);
  });
});

describe("性格设定", () => {
  it("改习惯：会话调 persona.edit（新正文、hands_on）→ 文件和模式变了、persona_changes 一行（actor pm）、对话里一条系统消息、推 pm.updated", () => {
    now = 8_000;
    changes = [];
    const result = hub(lin.sessionId, "persona.edit", { text: "以后回复都用列表", mode: "hands_on", reason: "用户要求" });
    const change = result.data.change!;
    expect(change).toMatchObject({
      pmId: lin.pmId,
      actor: "pm",
      sessionId: lin.sessionId,
      textBefore: "小林的习惯",
      textAfter: "以后回复都用列表",
      modeBefore: "manage_only",
      modeAfter: "hands_on",
      reason: "用户要求",
      revertOf: null,
      createdAt: 8_000,
    });
    expect(readFileSync(personaFilePath(personasDir, lin.pmId), "utf8")).toBe("以后回复都用列表");
    expect(db.get("SELECT persona, mode, persona_file_hash FROM pms WHERE id = ?", lin.pmId)).toEqual({
      persona: "以后回复都用列表",
      mode: "hands_on",
      persona_file_hash: contentHash("以后回复都用列表"),
    });
    const message = messagesIn(lin.conversationId).at(-1)!;
    expect(message).toMatchObject({ sender: "system", status: null, meta: { event: "persona.changed", pmId: lin.pmId, personaChangeId: change.id, revertOf: null } });
    expect(message.text).toContain("改了自己的做事习惯");
    expect(changes.map((c) => c.type)).toEqual(["pm.updated", "message.created"]);
    const updated = changes[0]!;
    expect(updated.type === "pm.updated" && updated.data.pm.mode).toBe("hands_on");
    // 只改模式也行；什么都没变 → change null，不写不推
    changes = [];
    expect(hub(lin.sessionId, "persona.edit", { mode: "hands_on" }).data.change).toBeNull();
    expect(changes).toEqual([]);
    const shown = hub(lin.sessionId, "persona.show", {} as never);
    expect(shown.data).toEqual({ text: "以后回复都用列表", mode: "hands_on" });
    expect(shown.text).toBe("模式：自己也干活\n\n以后回复都用列表");
    // 性格设定为空时：persona.show 正常显示，data.text 是空串
    const emptyPm = ledger.createPm({ name: "阿空", mode: "manage_only", persona: "" });
    const emptyShown = hub(emptyPm.sessionId, "persona.show", {} as never);
    expect(emptyShown.data).toEqual({ text: "", mode: "manage_only" });
    expect(emptyShown.text).toBe("模式：只管理\n\n（还没有性格设定）");
  });

  it("界面改性格设定：系统消息发在项目经理的对话里；text、mode 都没给、太长 → invalid；不存在 → not_found；会话改别人的 → forbidden", () => {
    const result = ledger.editPersona(lin.pmId, { text: "新的" }, { kind: "user" });
    expect(result.change).toMatchObject({ actor: "user", sessionId: null, modeBefore: "manage_only", modeAfter: "manage_only" });
    expect(result.persona).toMatchObject({ pmId: lin.pmId, text: "新的", mode: "manage_only", revertableChangeId: result.change!.id });
    expect(messagesIn(lin.conversationId).at(-1)!.meta).toMatchObject({ event: "persona.changed", personaChangeId: result.change!.id });
    expectLedgerError(() => ledger.editPersona(lin.pmId, {}, { kind: "user" }), "invalid");
    expectLedgerError(() => ledger.editPersona(lin.pmId, { text: "长".repeat(MAX_PERSONA_BYTES) }, { kind: "user" }), "invalid");
    expectLedgerError(() => ledger.editPersona(lin.pmId, { mode: "foo" as never }, { kind: "user" }), "invalid");
    expectLedgerError(() => ledger.editPersona(999, { text: "x" }, { kind: "user" }), "not_found");
    expectLedgerError(() => ledger.getPersona(999), "not_found");
    expectLedgerError(() => ledger.editPersona(zhou.pmId, { text: "x" }, { kind: "session", sessionId: lin.sessionId }), "forbidden");
  });

  it("撤销：撤销最近一次恢复原样并多一条 revertOf 记录；再撤销更早的一次 → conflict；撤销本身也能撤销；不存在 → not_found", () => {
    const first = ledger.editPersona(lin.pmId, { text: "第一次" }, { kind: "user" }).change!;
    const second = ledger.editPersona(lin.pmId, { text: "第二次", mode: "hands_on" }, { kind: "user" }).change!;
    changes = [];
    const reverted = ledger.revertPersonaChange(second.id);
    expect(reverted.change).toMatchObject({ actor: "user", revertOf: second.id, textBefore: "第二次", textAfter: "第一次", modeAfter: "manage_only" });
    expect(reverted.persona).toMatchObject({ text: "第一次", mode: "manage_only", revertableChangeId: reverted.change!.id });
    expect(reverted.persona.changes.map((c) => c.id)).toEqual([reverted.change!.id, second.id, first.id]);
    expect(readFileSync(personaFilePath(personasDir, lin.pmId), "utf8")).toBe("第一次");
    expect(messagesIn(lin.conversationId).at(-1)!.meta).toMatchObject({ event: "persona.changed", revertOf: second.id });
    expect(changes.map((c) => c.type)).toEqual(["pm.updated", "message.created"]);
    expectLedgerError(() => ledger.revertPersonaChange(first.id), "conflict", /最近一次/);
    expect(ledger.revertPersonaChange(reverted.change!.id).persona.text).toBe("第二次");
    expectLedgerError(() => ledger.revertPersonaChange(999), "not_found");
  });

  it("手改文件：改 personas/pm-<编号>.md，重新打开账本同步 → 多一条 actor: file 的记录，数据库按文件", () => {
    writeFileSync(personaFilePath(personasDir, lin.pmId), "我手改的");
    const reopened = createLedger(db, options());
    const result = reopened.syncPersonaFiles();
    expect(result).toEqual({ recordedPmIds: [lin.pmId], rewrittenPmIds: [] });
    const persona = reopened.getPersona(lin.pmId);
    expect(persona.text).toBe("我手改的");
    expect(persona.changes[0]).toMatchObject({ actor: "file", textBefore: "小林的习惯", textAfter: "我手改的", sessionId: null });
    expect(db.get("SELECT persona_file_hash AS h FROM pms WHERE id = ?", lin.pmId)).toEqual({ h: contentHash("我手改的") });
    // 再同步一次：没有新变化
    expect(reopened.syncPersonaFiles()).toEqual({ recordedPmIds: [], rewrittenPmIds: [] });
  });

  it("写性格文件失败：数据库已提交、persona_file_hash 没变；下次启动按记录重写文件，不多出 actor: file 的记录", () => {
    const hashBefore = db.get<{ h: string }>("SELECT persona_file_hash AS h FROM pms WHERE id = ?", lin.pmId)!.h;
    const failing = createLedger(
      db,
      options({
        writeFileAtomic: (file, content) => {
          if (file.startsWith(personasDir)) throw new Error("disk full");
          writeFileAtomic(file, content);
        },
      }),
    );
    const result = failing.editPersona(lin.pmId, { text: "写不进文件" }, { kind: "user" });
    expect(result.change).not.toBeNull();
    expect(db.get("SELECT persona, persona_file_hash AS h FROM pms WHERE id = ?", lin.pmId)).toEqual({ persona: "写不进文件", h: hashBefore });
    expect(readFileSync(personaFilePath(personasDir, lin.pmId), "utf8")).toBe("小林的习惯");
    const reopened = createLedger(db, options());
    expect(reopened.syncPersonaFiles()).toEqual({ recordedPmIds: [], rewrittenPmIds: [lin.pmId] });
    expect(readFileSync(personaFilePath(personasDir, lin.pmId), "utf8")).toBe("写不进文件");
    expect(count("persona_changes", "actor = 'file'")).toBe(0);
    expect(db.get("SELECT persona_file_hash AS h FROM pms WHERE id = ?", lin.pmId)).toEqual({ h: contentHash("写不进文件") });
  });

  it("同步的其他情况：M1 升上来正文是 NULL（有文件按文件填、没文件当空的）；文件被删了按数据库重写；从没写成功过的手改按数据库重写", () => {
    db.run("UPDATE pms SET persona = NULL, persona_file_hash = NULL WHERE id = ?", lin.pmId);
    writeFileSync(personaFilePath(personasDir, lin.pmId), "M1 的文件");
    db.run("UPDATE pms SET persona = NULL, persona_file_hash = NULL WHERE id = ?", zhou.pmId);
    rmSync(personaFilePath(personasDir, zhou.pmId));
    // 正文 NULL 时读出来是空串
    expect(ledger.getPersona(zhou.pmId).text).toBe("");
    const third = ledger.createPm({ name: "老王", mode: "manage_only", persona: "老王的" }).pm.id;
    rmSync(personaFilePath(personasDir, third));
    const fourth = ledger.createPm({ name: "老李", mode: "manage_only", persona: "老李的" }).pm.id;
    db.run("UPDATE pms SET persona_file_hash = NULL WHERE id = ?", fourth);
    writeFileSync(personaFilePath(personasDir, fourth), "分不清谁改的");
    const result = ledger.syncPersonaFiles();
    expect(result).toEqual({ recordedPmIds: [], rewrittenPmIds: [zhou.pmId, third, fourth] });
    expect(ledger.getPersona(lin.pmId).text).toBe("M1 的文件");
    expect(ledger.getPersona(zhou.pmId).text).toBe("");
    expect(readFileSync(personaFilePath(personasDir, zhou.pmId), "utf8")).toBe("");
    expect(readFileSync(personaFilePath(personasDir, third), "utf8")).toBe("老王的");
    expect(readFileSync(personaFilePath(personasDir, fourth), "utf8")).toBe("老李的");
    expect(count("persona_changes")).toBe(0);
  });
});

describe("厂商、模型、思考程度（资料页的 Agent 一栏）", () => {
  it("建项目经理时选：pms、会话那一行都记下；不给就是 Claude Code、默认、默认", () => {
    const made = ledger.createPm({ name: "阿明", mode: "manage_only", persona: "", vendor: "claude", defaultModel: "haiku", effort: "low" });
    expect(made.pm).toMatchObject({ vendor: "claude", defaultModel: "haiku", effort: "low" });
    expect(sessionRow(made.sessionId)).toMatchObject({ vendor: "claude", model: "haiku", effort: "low" });
    expect(ledger.getPersona(made.pm.id)).toMatchObject({ vendor: "claude", model: "haiku", effort: "low" });
    expect(ledger.snapshot().pms.find((p) => p.id === lin.pmId)).toMatchObject({ vendor: "claude", defaultModel: null, effort: null });
    expect(sessionRow(lin.sessionId)).toMatchObject({ vendor: "claude", model: null, effort: null });
    // 空串当默认；完整模型名也行
    const custom = ledger.createPm({ name: "阿亮", mode: "manage_only", persona: "", defaultModel: " claude-opus-5-5 ", effort: "" });
    expect(custom.pm).toMatchObject({ defaultModel: "claude-opus-5-5", effort: null });
  });

  it("建的时候值不对（厂商、模型名的字符和长度、思考程度）：invalid，原因来自清单，什么都没写", () => {
    const before = tableCounts();
    const base = { name: "阿明", mode: "manage_only" as const, persona: "" };
    expectLedgerError(() => ledger.createPm({ ...base, vendor: "unknown" as never }), "invalid", /厂商/);
    expectLedgerError(() => ledger.createPm({ ...base, defaultModel: "claude opus" }), "invalid", /模型名只能用/);
    expectLedgerError(() => ledger.createPm({ ...base, defaultModel: "--resume" }), "invalid", /模型名只能用/);
    expectLedgerError(() => ledger.createPm({ ...base, defaultModel: "m".repeat(101) }), "invalid", /最多 100/);
    expectLedgerError(() => ledger.createPm({ ...base, effort: "huge" }), "invalid", /思考程度只能是 low、medium、high、xhigh、max/);
    expect(tableCounts()).toEqual(before);
  });

  it("资料页改模型、思考程度：pms 和项目经理的会话都改了，修改记录一条（前后都有），对话里一条系统消息，推 pm.updated", () => {
    now = 3_000;
    const { change, persona } = ledger.editPersona(lin.pmId, { model: "haiku", effort: "low" }, { kind: "user" });
    expect(change).toMatchObject({
      actor: "user",
      vendorBefore: "claude",
      vendorAfter: "claude",
      modelBefore: null,
      modelAfter: "haiku",
      effortBefore: null,
      effortAfter: "low",
      textBefore: "小林的习惯",
      textAfter: "小林的习惯",
      modeBefore: "manage_only",
      modeAfter: "manage_only",
    });
    expect(persona).toMatchObject({ vendor: "claude", model: "haiku", effort: "low", text: "小林的习惯", revertableChangeId: change!.id });
    expect(persona.changes[0]).toEqual(change);
    // 会话那一行改了：驱动层下一条消息前比出不一样，--resume 重启
    expect(sessionRow(lin.sessionId)).toMatchObject({ model: "haiku", effort: "low", hasCompletedTurn: false, updatedAt: 3_000 });
    expect(sessionRow(zhou.sessionId)).toMatchObject({ model: null, effort: null });
    expect(messagesIn(lin.conversationId).at(-1)!.text).toBe("你改了小林的设置（模型：默认 → Haiku，思考程度：默认 → low）");
    expect(changes.map((c) => c.type)).toEqual(["pm.updated", "message.created"]);
    expect(changes[0]).toMatchObject({ data: { pm: { id: lin.pmId, vendor: "claude", defaultModel: "haiku", effort: "low" } } });
    // 不登记重启动作：下一条消息前驱动层自己重启
    expect(enqueued).toEqual([]);
  });

  it("系统消息里的模型名用缓存着的模型名单的显示名；名单里没有的原样；还没有名单用打包的", () => {
    let catalog: ModelCatalog | null = {
      ...bundledModelCatalog("claude"),
      source: "vendor",
      defaultEfforts: null,
      models: [
        { id: "claude-opus-4-6", label: "Opus 4.6", description: null, efforts: null },
        { id: "opus", label: "Opus 5.5", description: null, efforts: null },
      ],
    };
    const withCatalog = createLedger(db, options({ modelCatalog: (vendor) => (vendor === "claude" ? catalog : null) }));
    withCatalog.editPersona(lin.pmId, { model: "claude-opus-4-6" }, { kind: "user" });
    expect(messagesIn(lin.conversationId).at(-1)!.text).toBe("你改了小林的设置（模型：默认 → Opus 4.6）");
    withCatalog.editPersona(lin.pmId, { model: "claude-opus-4-1" }, { kind: "user" });
    expect(messagesIn(lin.conversationId).at(-1)!.text).toBe("你改了小林的设置（模型：Opus 4.6 → claude-opus-4-1）");
    withCatalog.editPersona(lin.pmId, { model: "opus" }, { kind: "user" });
    expect(messagesIn(lin.conversationId).at(-1)!.text).toBe("你改了小林的设置（模型：claude-opus-4-1 → Opus 5.5）");
    catalog = null;
    withCatalog.editPersona(lin.pmId, { model: "claude-opus-4-6" }, { kind: "user" });
    expect(messagesIn(lin.conversationId).at(-1)!.text).toBe("你改了小林的设置（模型：Opus → claude-opus-4-6）");
  });

  it("改回默认（null）、自定义完整模型名；和现在一样就什么也不写", () => {
    ledger.editPersona(lin.pmId, { model: "haiku", effort: "max" }, { kind: "user" });
    const back = ledger.editPersona(lin.pmId, { model: null, effort: null }, { kind: "user" });
    expect(back.change).toMatchObject({ modelBefore: "haiku", modelAfter: null, effortBefore: "max", effortAfter: null });
    expect(sessionRow(lin.sessionId)).toMatchObject({ model: null, effort: null });
    const custom = ledger.editPersona(lin.pmId, { model: "claude-sonnet-5-5[1m]" }, { kind: "user" });
    expect(custom.persona).toMatchObject({ model: "claude-sonnet-5-5[1m]", effort: null });
    expect(messagesIn(lin.conversationId).at(-1)!.text).toBe("你改了小林的设置（模型：默认 → claude-sonnet-5-5[1m]）");
    const records = count("persona_changes");
    expect(ledger.editPersona(lin.pmId, { vendor: "claude", model: "claude-sonnet-5-5[1m]", effort: null }, { kind: "user" }).change).toBeNull();
    expect(count("persona_changes")).toBe(records);
  });

  it("agy 老数据存的是完整 ID：资料页只改思考程度，存成 模型 + 新档位（不报冲突）；改了别的不动它", () => {
    const agy = ledger.createPm({ name: "阿亮", mode: "manage_only", persona: "", vendor: "agy", defaultModel: "gemini-4-argon", effort: "high" });
    expect(agy.pm).toMatchObject({ vendor: "agy", defaultModel: "gemini-4-argon", effort: "high" });
    // 老库里存的是完整 ID
    db.run("UPDATE pms SET default_model = ?, effort = NULL WHERE id = ?", "gemini-4-argon-high", agy.pm.id);
    db.run("UPDATE agent_sessions SET model = ?, effort = NULL WHERE id = ?", "gemini-4-argon-high", agy.sessionId);
    const text = ledger.editPersona(agy.pm.id, { text: "新习惯" }, { kind: "user" });
    expect(text.persona).toMatchObject({ model: "gemini-4-argon-high", effort: null });
    const { persona } = ledger.editPersona(agy.pm.id, { effort: "low" }, { kind: "user" });
    expect(persona).toMatchObject({ vendor: "agy", model: "gemini-4-argon", effort: "low" });
    expect(sessionRow(agy.sessionId)).toMatchObject({ model: "gemini-4-argon", effort: "low" });
    // 对话里的系统消息：模型没变不写，思考程度单独一段（老数据里的 high 是从完整 ID 里拆出来的）
    expect(messagesIn(agy.conversation.id).at(-1)!.text).toBe("你改了阿亮的设置（思考程度：high → low）");
  });

  it("agy 只给完整 ID：拆成 模型 + 思考程度；完整 ID 加对不上的思考程度：invalid", () => {
    const made = ledger.createPm({ name: "阿亮", mode: "manage_only", persona: "", vendor: "agy", defaultModel: "gemini-3.8-flash-low", effort: "" });
    expect(made.pm).toMatchObject({ vendor: "agy", defaultModel: "gemini-3.8-flash", effort: "low" });
    const { persona } = ledger.editPersona(made.pm.id, { model: "claude-opus-5-5-medium" }, { kind: "user" });
    expect(persona).toMatchObject({ vendor: "agy", model: "claude-opus-5-5", effort: "medium" });
    expectLedgerError(() => ledger.editPersona(made.pm.id, { model: "gemini-4-argon-low", effort: "high" }, { kind: "user" }), "invalid", /gemini-4-argon-low/);
  });

  it("和性格设定、模式一起改：一条记录；系统消息里写模式和模型的变化", () => {
    const { change } = ledger.editPersona(lin.pmId, { text: "新习惯", mode: "hands_on", model: "opus" }, { kind: "user" });
    expect(change).toMatchObject({ textAfter: "新习惯", modeAfter: "hands_on", modelBefore: null, modelAfter: "opus" });
    expect(messagesIn(lin.conversationId).at(-1)!.text).toBe("你改了小林的性格设定（模式：只管理 → 自己也干活，模型：默认 → Opus）");
  });

  it("值不对：invalid，什么都没写；项目经理自己用 hub 改不了（forbidden）", () => {
    const before = tableCounts();
    expectLedgerError(() => ledger.editPersona(lin.pmId, { model: "a b" }, { kind: "user" }), "invalid", /模型名只能用/);
    expectLedgerError(() => ledger.editPersona(lin.pmId, { effort: "ultra" }, { kind: "user" }), "invalid", /思考程度/);
    expectLedgerError(() => ledger.editPersona(lin.pmId, { vendor: "unknown" as never }, { kind: "user" }), "invalid", /厂商/);
    expectLedgerError(
      () => ledger.editPersona(lin.pmId, { model: "haiku" }, { kind: "session", sessionId: lin.sessionId }),
      "forbidden",
      /只能由用户在资料页改/,
    );
    expectLedgerError(
      () => ledger.editPersona(lin.pmId, { vendor: "codex" }, { kind: "session", sessionId: lin.sessionId }),
      "forbidden",
      /只能由用户在资料页改/,
    );
    expect(tableCounts()).toEqual(before);
    expect(sessionRow(lin.sessionId)).toMatchObject({ model: null, effort: null });
  });

  it("资料页换厂商：空闲时当场秒切（不沿用旧厂商的 model/effort、不插 session.renewed）；在忙时登记 vendor_switch、期间可继续改新厂商设置，改回旧厂商或撤销时标 abandoned", () => {
    let wakes = 0;
    ledger = createLedger(db, options({ onHandoverClaimable: () => wakes++ }));
    ledger.editPersona(lin.pmId, { model: "opus", effort: "max" }, { kind: "user" });
    expect(ledger.getPersona(lin.pmId)).toMatchObject({ vendor: "claude", model: "opus", effort: "max", switchingToVendor: null });

    // 1. 旧会话在忙（有后台任务）时换到 codex（不传 model / effort 时默认取 null，不能沿用 claude 的 opus / max）
    ledger.applyDriverEvent(lin.sessionId, { type: "background.changed", at: now, count: 1 });
    changes = [];
    const switched = ledger.editPersona(lin.pmId, { vendor: "codex" }, { kind: "user" });
    expect(wakes).toBe(0);
    expect(switched.change).toMatchObject({
      vendorBefore: "claude",
      vendorAfter: "codex",
      modelBefore: "opus",
      modelAfter: null,
      effortBefore: "max",
      effortAfter: null,
    });
    expect(switched.persona).toMatchObject({
      vendor: "codex",
      model: null,
      effort: null,
      switchingToVendor: "codex",
    });
    // 换代前 pms 表和当前旧会话保持旧厂商和旧模型
    expect(db.get("SELECT vendor, default_model, effort FROM pms WHERE id = ?", lin.pmId)).toEqual({
      vendor: "claude",
      default_model: "opus",
      effort: "max",
    });
    expect(sessionRow(lin.sessionId)).toMatchObject({ vendor: "claude", model: "opus", effort: "max" });
    expect(db.get("SELECT status, method, auto, to_vendor, to_model, to_effort FROM handovers WHERE conversation_id = ?", lin.conversationId)).toEqual({
      status: "ready",
      method: "vendor_switch",
      auto: 0,
      to_vendor: "codex",
      to_model: null,
      to_effort: null,
    });
    expect(messagesIn(lin.conversationId).at(-1)!.text).toBe(
      "你改了小林的设置（厂商：Claude Code → Codex，模型：Opus → 默认，思考程度：max → 默认）",
    );

    // 换厂商等待期间继续改新厂商下的模型、思考程度和正文
    const refined = ledger.editPersona(lin.pmId, { model: "gpt-6-luna", effort: "high", text: "新习惯" }, { kind: "user" });
    expect(refined.change).toMatchObject({
      vendorBefore: "codex",
      vendorAfter: "codex",
      modelBefore: null,
      modelAfter: "gpt-6-luna",
      effortBefore: null,
      effortAfter: "high",
      textBefore: "小林的习惯",
      textAfter: "新习惯",
    });
    expect(refined.persona).toMatchObject({
      vendor: "codex",
      model: "gpt-6-luna",
      effort: "high",
      text: "新习惯",
      switchingToVendor: "codex",
    });
    // pms 的 persona 更新了，但 vendor / default_model / effort 仍保持旧厂商
    expect(db.get("SELECT persona, vendor, default_model, effort FROM pms WHERE id = ?", lin.pmId)).toEqual({
      persona: "新习惯",
      vendor: "claude",
      default_model: "opus",
      effort: "max",
    });
    expect(db.get("SELECT status, method, auto, to_vendor, to_model, to_effort FROM handovers WHERE conversation_id = ?", lin.conversationId)).toEqual({
      status: "ready",
      method: "vendor_switch",
      auto: 0,
      to_vendor: "codex",
      to_model: "gpt-6-luna",
      to_effort: "high",
    });

    // 改回旧厂商（或撤销）：vendor_switch 行直接标 abandoned，pms 与旧会话同步更新
    const back = ledger.editPersona(lin.pmId, { vendor: "claude", model: "haiku", effort: "low" }, { kind: "user" });
    expect(back.persona).toMatchObject({
      vendor: "claude",
      model: "haiku",
      effort: "low",
      switchingToVendor: null,
    });
    expect(db.get("SELECT vendor, default_model, effort FROM pms WHERE id = ?", lin.pmId)).toEqual({
      vendor: "claude",
      default_model: "haiku",
      effort: "low",
    });
    expect(sessionRow(lin.sessionId)).toMatchObject({ vendor: "claude", model: "haiku", effort: "low" });
    expect(db.get("SELECT status, method, failure_reason, to_vendor, to_model, to_effort FROM handovers WHERE conversation_id = ?", lin.conversationId)).toEqual({
      status: "abandoned",
      method: "vendor_switch",
      failure_reason: "user_message",
      to_vendor: null,
      to_model: null,
      to_effort: null,
    });

    // 2. 空闲时换厂商：当场在同一事务秒切
    ledger.applyDriverEvent(lin.sessionId, { type: "background.changed", at: now, count: 0 });
    const instant = ledger.editPersona(lin.pmId, { vendor: "codex" }, { kind: "user" });
    expect(wakes).toBe(0);
    expect(instant.persona).toMatchObject({
      vendor: "codex",
      model: null,
      effort: null,
      switchingToVendor: null,
    });
    expect(db.get("SELECT vendor, default_model, effort FROM pms WHERE id = ?", lin.pmId)).toEqual({
      vendor: "codex",
      default_model: null,
      effort: null,
    });
    expect(messagesIn(lin.conversationId).some((m) => (m.meta as { event?: string } | null)?.event === "session.renewed")).toBe(false);
  });

  it("老库里不合规的模型名不锁死别的保存：改性格设定、工作方式、只改思考程度都行，模型不动；改模型时才查", () => {
    // 0006 之前模型名只限长度
    db.run("UPDATE pms SET default_model = 'claude opus' WHERE id = ?", lin.pmId);
    db.run("UPDATE agent_sessions SET model = 'claude opus' WHERE id = ?", lin.sessionId);
    expect(ledger.editPersona(lin.pmId, { text: "新习惯" }, { kind: "user" }).persona).toMatchObject({ text: "新习惯", model: "claude opus" });
    expect(ledger.editPersona(lin.pmId, { mode: "hands_on" }, { kind: "user" }).persona).toMatchObject({ mode: "hands_on", model: "claude opus" });
    expect(ledger.editPersona(lin.pmId, { effort: "low" }, { kind: "user" }).persona).toMatchObject({ effort: "low", model: "claude opus" });
    // hub persona edit 也不受影响
    expect(hub(lin.sessionId, "persona.edit", { text: "自己改的" }).data.change).toMatchObject({ textAfter: "自己改的", modelAfter: "claude opus" });
    // 要改模型就得改成合规的
    expectLedgerError(() => ledger.editPersona(lin.pmId, { model: "claude sonnet" }, { kind: "user" }), "invalid", /模型名只能用/);
    expect(ledger.editPersona(lin.pmId, { model: "haiku" }, { kind: "user" }).persona).toMatchObject({ model: "haiku", effort: "low" });
    expect(sessionRow(lin.sessionId)).toMatchObject({ model: "haiku", effort: "low" });
  });

  it("撤销：模型、思考程度一起改回去，会话那一行也改回去；撤销老的只改性格设定的记录不动模型", () => {
    const textOnly = ledger.editPersona(lin.pmId, { text: "改一下" }, { kind: "user" }).change!;
    expect(textOnly).toMatchObject({ modelBefore: null, modelAfter: null });
    const agent = ledger.editPersona(lin.pmId, { model: "haiku", effort: "low" }, { kind: "user" }).change!;
    const reverted = ledger.revertPersonaChange(agent.id);
    expect(reverted.persona).toMatchObject({ model: null, effort: null, text: "改一下" });
    expect(reverted.change).toMatchObject({ revertOf: agent.id, modelBefore: "haiku", modelAfter: null, effortBefore: "low", effortAfter: null });
    expect(sessionRow(lin.sessionId)).toMatchObject({ model: null, effort: null });
    expect(messagesIn(lin.conversationId).at(-1)!.text).toBe("已撤销小林的上一次设置修改（模型：Haiku → 默认，思考程度：low → 默认）");
  });
});

describe("retryMessage", () => {
  it("重试失败消息：状态回到 queued、失败原因清空、推 message.updated、同一行动作重置；replied → conflict；不存在 → not_found", () => {
    const failed = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "f", text: "失败的" }).messageId;
    const action = listActions(db).find((a) => a.type === "session.send" && a.params.messageId === failed)!;
    setActionStatus(db, action.id, { status: "failed", attempts: 3, lastError: "claude_not_found" }, now);
    ledger.onActionFailed(action, "claude_not_found: x");
    expect(ledger.getMessage(failed)).toMatchObject({ status: "failed", failureReason: "claude_not_found: x" });
    changes = [];
    enqueued = [];
    now = 9_500;
    expect(ledger.retryMessage(failed)).toEqual({ messageId: failed });
    const message = ledger.getMessage(failed)!;
    expect(message).toMatchObject({ status: "queued", failureReason: null, updatedAt: 9_500 });
    expect(changes).toEqual([expect.objectContaining({ type: "message.updated", data: { message } })]);
    const actions = listActions(db).filter((a) => a.type === "session.send" && a.params.messageId === failed);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: action.id, status: "pending", attempts: 0, lastError: null, params: { sessionId: lin.sessionId } });
    expect(enqueued.map((a) => a.id)).toEqual([action.id]);
    expect(count("messages")).toBe(1);

    const replied = ledger.postUserMessage({ conversationId: lin.conversationId, clientId: "r", text: "回过的" }).messageId;
    db.run("UPDATE messages SET status = 'replied' WHERE id = ?", replied);
    expectLedgerError(() => ledger.retryMessage(replied), "conflict");
    expectLedgerError(() => ledger.retryMessage(9999), "not_found");
  });

  it("不是用户发的消息（比如“项目已建好”）→ conflict", () => {
    createFoo();
    const system = messagesIn(lin.conversationId).find((m) => m.sender === "system")!;
    db.run("UPDATE messages SET status = 'failed' WHERE id = ?", system.id);
    expectLedgerError(() => ledger.retryMessage(system.id), "conflict");
  });
});

describe("hubCall 其他命令", () => {
  it("status：我是谁、项目和文件夹；还没有项目时说怎么建", () => {
    const foo = createFoo();
    const extra = folder("extra");
    hub(lin.sessionId, "project.attach", { folder: extra });
    const status = hub(lin.sessionId, "status", {} as never);
    expect(status.data).toEqual({
      role: "pm",
      pm: { id: lin.pmId, name: "小林", mode: "manage_only" },
      sessionId: lin.sessionId,
      conversationId: lin.conversationId,
      project: { id: foo.project.id, name: "foo", description: null, mainFolder: foo.dir, otherFolders: [extra] },
      setupCommand: null,
    });
    expect(status.text).toContain("小林");
    expect(status.text).toContain(foo.dir);
    expect(status.text).toContain(extra);
    const none = hub(zhou.sessionId, "status", {} as never);
    expect(none.data.project).toBeNull();
    expect(none.text).toMatch(new RegExp(`还没有项目.*${HUB_COMMAND} project create`));
  });

  it("会话不存在、不是项目经理的会话 → forbidden；长字段在 hub_calls 里截断", () => {
    expectLedgerError(() => hub(999, "status", {} as never), "forbidden");
    const worker = db.run(
      "INSERT INTO agent_sessions (role, vendor_session_id, cwd, created_at, updated_at) VALUES ('worker', 'w-1', '/tmp', 0, 0)",
    ).lastInsertRowid;
    expectLedgerError(() => hub(worker, "status", {} as never), "forbidden");
    const long = "习".repeat(HUB_CALL_FIELD_MAX_BYTES);
    hub(lin.sessionId, "persona.edit", { text: long, reason: "用户要求" });
    const args = JSON.parse(hubCalls().at(-1)!.args) as { text: string; reason: string };
    expect(args.reason).toBe("用户要求");
    expect(args.text).toBe(truncateField(long));
    expect(args.text).toMatch(/截断，原长 6144 字节/);
    expect(new TextEncoder().encode(args.text.split("…")[0]!).length).toBeLessThanOrEqual(HUB_CALL_FIELD_MAX_BYTES);
  });
});

describe("personaUpdate（性格设定、模式改了不重启，驱动层下一条前面加说明）", () => {
  it("没改过：版本号 0，什么也没变；getLaunchContext 带上最新的版本号", () => {
    expect(ledger.personaUpdate(lin.sessionId, 0)).toEqual({ revision: 0, vendor: "claude", persona: null, mode: null });
    expect(ledger.getLaunchContext(lin.sessionId).pm.personaRevision).toBe(0);
    const { change } = ledger.editPersona(lin.pmId, { text: "新" }, { kind: "user" });
    expect(ledger.getLaunchContext(lin.sessionId).pm.personaRevision).toBe(change!.id);
  });

  it("用户改了正文、模式：给现在的内容，bySelf 是 false；连改几次只看最新的；从最新的版本号再问什么也没变", () => {
    ledger.editPersona(lin.pmId, { text: "第一版" }, { kind: "user" });
    const { change } = ledger.editPersona(lin.pmId, { text: "第二版", mode: "hands_on" }, { kind: "user" });
    expect(ledger.personaUpdate(lin.sessionId, 0)).toEqual({
      revision: change!.id,
      vendor: "claude",
      persona: { text: "第二版", bySelf: false },
      mode: { mode: "hands_on", bySelf: false },
    });
    expect(ledger.personaUpdate(lin.sessionId, change!.id)).toEqual({ revision: change!.id, vendor: "claude", persona: null, mode: null });
  });

  it("项目经理自己 hub persona edit 改的：bySelf 是 true；中间夹着用户改的就是 false", () => {
    hub(lin.sessionId, "persona.edit", { text: "我记的" });
    expect(ledger.personaUpdate(lin.sessionId, 0)).toMatchObject({ persona: { text: "我记的", bySelf: true }, mode: null });
    ledger.editPersona(lin.pmId, { text: "用户改的" }, { kind: "user" });
    hub(lin.sessionId, "persona.edit", { text: "我又记的" });
    expect(ledger.personaUpdate(lin.sessionId, 0)).toMatchObject({ persona: { text: "我又记的", bySelf: false } });
  });

  it("撤销：算一次修改，按内容比；改了又撤销回 agent 看到的那版，什么也没变（版本号照样前进）", () => {
    const first = ledger.editPersona(lin.pmId, { text: "新" }, { kind: "user" }).change!;
    const revert = ledger.revertPersonaChange(first.id).change!;
    expect(ledger.personaUpdate(lin.sessionId, 0)).toEqual({ revision: revert.id, vendor: "claude", persona: null, mode: null });
    expect(ledger.personaUpdate(lin.sessionId, first.id)).toMatchObject({ revision: revert.id, persona: { text: "小林的习惯", bySelf: false } });
  });

  it("只改了模型：内容都没变（会话那一行变了，驱动层按重启处理）", () => {
    const { change } = ledger.editPersona(lin.pmId, { model: "haiku" }, { kind: "user" });
    expect(ledger.personaUpdate(lin.sessionId, 0)).toEqual({ revision: change!.id, vendor: "claude", persona: null, mode: null });
  });

  it("只看这个项目经理自己的修改；不是项目经理的会话 → null", () => {
    ledger.editPersona(zhou.pmId, { text: "阿周新的" }, { kind: "user" });
    expect(ledger.personaUpdate(lin.sessionId, 0)).toEqual({ revision: 0, vendor: "claude", persona: null, mode: null });
    expect(ledger.personaUpdate(999, 0)).toBeNull();
  });
});

describe("getLaunchContext", () => {
  it("有项目：项目信息和文件夹；还没有项目：project 是 null；persona 是 NULL 时当空串；带当前厂商；会话不存在 → not_found", () => {
    const foo = createFoo();
    const extra = folder("extra");
    hub(lin.sessionId, "project.attach", { folder: extra });
    expect(ledger.getLaunchContext(lin.sessionId)).toEqual({
      sessionId: lin.sessionId,
      role: "pm",
      conversationId: lin.conversationId,
      pm: { id: lin.pmId, name: "小林", mode: "manage_only", vendor: "claude", persona: "小林的习惯", personaRevision: 0 },
      project: { id: foo.project.id, name: "foo", description: null, mainFolder: foo.dir, otherFolders: [extra] },
      worker: null,
    });
    expect(ledger.getLaunchContext(zhou.sessionId)).toMatchObject({ pm: { name: "阿周", mode: "hands_on", vendor: "claude" }, project: null });
    const agyPm = ledger.createPm({ name: "阿吉", mode: "manage_only", vendor: "agy", persona: "" });
    expect(ledger.getLaunchContext(agyPm.sessionId).pm).toEqual({ id: agyPm.pm.id, name: "阿吉", mode: "manage_only", vendor: "agy", persona: "", personaRevision: 0 });
    db.run("UPDATE pms SET persona = NULL WHERE id = ?", lin.pmId);
    expect(ledger.getLaunchContext(lin.sessionId).pm.persona).toBe("");
    expectLedgerError(() => ledger.getLaunchContext(999), "not_found");
  });

  it("附加文件夹按编号排，顺序固定（不按路径），免得无端触发重启", () => {
    createFoo();
    const z = folder("z-extra");
    const a = folder("a-extra");
    hub(lin.sessionId, "project.attach", { folder: z });
    hub(lin.sessionId, "project.attach", { folder: a });
    const first = ledger.getLaunchContext(lin.sessionId);
    expect(first.project!.otherFolders).toEqual([z, a]);
    expect(ledger.getLaunchContext(lin.sessionId)).toEqual(first);
  });
});
