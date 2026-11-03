// M2 W1：项目经理、项目、文件夹、交接、性格设定、重试、hub 调用、启动上下文（m2-plan 第 4 节“W1 账本”的测试表）。
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import type { AnyActionRow } from "../../shared/actions.ts";
import { PM_PERSONA_TEMPLATE, SYSTEM_MESSAGE_PREFIX } from "../../shared/domain.ts";
import type { ConversationId, Message, PmId, SessionId } from "../../shared/domain.ts";
import type { HubArgs, HubCommand } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import type { LedgerErrorCode } from "../../shared/ledger.ts";
import { HUB_CALL_FIELD_MAX_BYTES, MAX_HANDOFF_BYTES, MAX_PERSONA_BYTES } from "../../shared/limits.ts";
import { personaFilePath } from "../../shared/paths.ts";
import { listActions, setActionStatus } from "../actions/index.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { contentHash, createResolveFolder, truncateField, writeFileAtomic } from "./files.ts";
import { createLedger } from "./index.ts";
import type { LedgerOptions, SqliteLedger } from "./index.ts";

const INITIAL_SEQ = 9_000;
let db: Db;
let root: string;
let dataHome: string;
let personasDir: string;
let handoffsDir: string;
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
    handoffsDir,
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
  handoffsDir = join(dataHome, "state", "handoffs");
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

function createFoo(name = "foo", dir = folder(name)) {
  const result = hub(lin.sessionId, "project.create", { name, folder: dir });
  return { ...result.data, groupSessionId: currentGroupSession(result.data.conversation.id), dir };
}

function currentGroupSession(conversationId: ConversationId): SessionId {
  return db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation DESC LIMIT 1", conversationId)!.id;
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
});

describe("建项目", () => {
  it("一句话建项目：项目、主文件夹、群、群会话（cwd 是真实路径）、“项目已建好”、hub_calls 一行，返回文字里有群名", () => {
    const dir = folder("foo");
    now = 3_000;
    // 路径里绕一下，存的是真实路径
    const result = hub(lin.sessionId, "project.create", { name: "foo", folder: join(work, "foo", "..", "foo"), description: "一个项目" });
    const { project, mainFolder, conversation } = result.data;
    expect(project).toMatchObject({ name: "foo", description: "一个项目", status: "active", pmId: lin.pmId, conversationId: conversation.id, createdAt: 3_000 });
    expect(mainFolder).toMatchObject({ projectId: project.id, path: dir, isMain: true, removedAt: null });
    expect(conversation).toMatchObject({ kind: "project_group", pmId: lin.pmId, projectId: project.id, title: "foo" });
    const groupSession = currentGroupSession(conversation.id);
    expect(sessionRow(groupSession)).toMatchObject({ role: "pm", pmId: lin.pmId, cwd: dir, addDirs: [], generation: 1, status: "idle" });
    const [message] = messagesIn(conversation.id);
    expect(message).toMatchObject({ sender: "system", kind: "text", status: null, meta: { event: "project.created", projectId: project.id } });
    expect(message!.text).toContain("项目已建好");
    expect(result.text).toContain("foo");
    expect(hubCalls()).toEqual([
      expect.objectContaining({ session_id: lin.sessionId, command: "project.create", ok: 1, error_code: null, result: result.text }),
    ]);
    expect(changes.map((c) => c.type)).toEqual(["project.created", "conversation.created", "session.created", "folders.updated", "message.created"]);
    // 不登记 session.start：第一条消息来了再起
    expect(listActions(db)).toEqual([]);
    const snap = ledger.snapshot();
    expect(snap.projects).toEqual([project]);
    expect(snap.folders).toEqual([mainFolder]);
  });

  it("界面建项目（actor user）；会话替别的项目经理建 → forbidden；项目经理不存在 → not_found", () => {
    const result = ledger.createProject({ name: "bar", folder: folder("bar"), pmId: zhou.pmId }, { kind: "user" });
    expect(result.project.pmId).toBe(zhou.pmId);
    expect(sessionRow(result.sessionId)).toMatchObject({ pmId: zhou.pmId, conversationId: result.conversation.id });
    expectLedgerError(
      () => ledger.createProject({ name: "baz", folder: folder("baz"), pmId: zhou.pmId }, { kind: "session", sessionId: lin.sessionId }),
      "forbidden",
    );
    expectLedgerError(() => ledger.createProject({ name: "baz", folder: folder("baz"), pmId: 999 }, { kind: "user" }), "not_found");
  });

  it("文件夹不对：不存在、是文件、在数据目录里 → invalid；已是别的项目的主文件夹、重名 → conflict；都什么也没写", () => {
    createFoo();
    writeFileSync(join(work, "a-file"), "x");
    mkdirSync(join(dataHome, "inside"), { recursive: true });
    changes = [];
    const before = tableCounts();
    const callsBefore = hubCalls().length;
    const cases: [string, string, LedgerErrorCode, RegExp][] = [
      ["n1", join(work, "nope"), "invalid", /文件夹不存在，请先建好：.*nope/],
      ["n2", join(work, "a-file"), "invalid", /不是文件夹/],
      ["n3", join(dataHome, "inside"), "invalid", /数据目录/],
      ["n4", dataHome, "invalid", /数据目录/],
      ["n5", join(work, "foo"), "conflict", /主文件夹/],
      ["foo", folder("other"), "conflict", /foo/],
      ["", folder("other"), "invalid", /名字/],
    ];
    for (const [name, dir, code, message] of cases) {
      expectLedgerError(() => hub(lin.sessionId, "project.create", { name, folder: dir }), code, message);
    }
    expect(tableCounts()).toEqual(before);
    expect(changes).toEqual([]);
    // 失败的调用也记一行
    const failed = hubCalls().slice(callsBefore);
    expect(failed.map((c) => [c.ok, c.error_code])).toEqual(cases.map(([, , code]) => [0, code]));
  });

  it("默认的 resolveFolder：展开 ~，相对路径拒绝", () => {
    const resolveFolder = createResolveFolder({ dataHome, userHome: root });
    expect(resolveFolder("~/work")).toBe(realpathSync.native(work));
    expectLedgerError(() => resolveFolder("work"), "invalid", /绝对路径/);
    expectLedgerError(() => resolveFolder(" "), "invalid");
  });
});

describe("文件夹", () => {
  it("挂文件夹（在私聊里调）：多一行、群会话 add_dirs 有它、群里一条系统消息，同时登记给群里 agent 的 session.send", () => {
    const foo = createFoo();
    const extra = folder("extra");
    changes = [];
    enqueued = [];
    const result = hub(lin.sessionId, "project.attach", { project: "foo", folder: extra });
    expect(result.data.folder).toMatchObject({ projectId: foo.project.id, path: extra, isMain: false, removedAt: null });
    expect(count("project_folders", "project_id = ? AND removed_at IS NULL", foo.project.id)).toBe(2);
    expect(sessionRow(foo.groupSessionId).addDirs).toEqual([extra]);
    const message = messagesIn(foo.conversation.id).at(-1)!;
    expect(message).toMatchObject({
      sender: "system",
      status: "queued",
      sessionId: foo.groupSessionId,
      meta: { event: "folder.attached", projectId: foo.project.id, folderId: result.data.folder.id, path: extra },
    });
    expect(message.text.startsWith(SYSTEM_MESSAGE_PREFIX)).toBe(true);
    expect(enqueued).toEqual([
      expect.objectContaining({ type: "session.send", params: { sessionId: foo.groupSessionId, messageId: message.id, source: "system" } }),
    ]);
    expect(changes.map((c) => c.type)).toEqual(["folders.updated", "message.created"]);
    const updated = changes[0]!;
    expect(updated.type === "folders.updated" && updated.data.folders.map((f) => f.path)).toEqual([foo.dir, extra]);
  });

  it("群里最新一代自己挂：系统消息只给人看，不登记发送；已经挂着 → conflict；项目不存在 → not_found；目录不存在 → invalid", () => {
    const foo = createFoo();
    const extra = folder("extra");
    enqueued = [];
    hub(foo.groupSessionId, "project.attach", { project: "foo", folder: extra });
    const message = messagesIn(foo.conversation.id).at(-1)!;
    expect(message).toMatchObject({ status: null, sessionId: null });
    expect(message.text.startsWith(SYSTEM_MESSAGE_PREFIX)).toBe(false);
    expect(enqueued).toEqual([]);
    expectLedgerError(() => hub(lin.sessionId, "project.attach", { project: "foo", folder: extra }), "conflict");
    expectLedgerError(() => hub(lin.sessionId, "project.attach", { project: "foo", folder: foo.dir }), "conflict");
    expectLedgerError(() => hub(lin.sessionId, "project.attach", { project: "nope", folder: extra }), "not_found");
    expectLedgerError(() => hub(lin.sessionId, "project.attach", { project: "foo", folder: join(work, "gone") }), "invalid", /不存在/);
  });

  it("移除文件夹：挂着的标移除时间；主文件夹 invalid；没挂过的 not_found", () => {
    const foo = createFoo();
    const extra = folder("extra");
    hub(lin.sessionId, "project.attach", { project: "foo", folder: extra });
    now = 5_000;
    changes = [];
    const result = hub(lin.sessionId, "project.detach", { project: "foo", folder: extra });
    expect(result.data.folder).toMatchObject({ path: extra, removedAt: 5_000 });
    expect(sessionRow(foo.groupSessionId).addDirs).toEqual([]);
    expect(messagesIn(foo.conversation.id).at(-1)!.meta).toMatchObject({ event: "folder.detached", folderId: result.data.folder.id });
    expect(changes.map((c) => c.type)).toEqual(["folders.updated", "message.created"]);
    expect(ledger.snapshot().folders.map((f) => f.path)).toEqual([foo.dir]);
    expectLedgerError(() => hub(lin.sessionId, "project.detach", { project: "foo", folder: foo.dir }), "invalid", /主文件夹/);
    expectLedgerError(() => hub(lin.sessionId, "project.detach", { project: "foo", folder: extra }), "not_found");
    expectLedgerError(() => hub(lin.sessionId, "project.detach", { project: "foo", folder: folder("never") }), "not_found");
    // 移除后可以再挂
    hub(lin.sessionId, "project.attach", { project: "foo", folder: extra });
    expect(sessionRow(foo.groupSessionId).addDirs).toEqual([extra]);
  });

  it("移除已经从磁盘上删掉的文件夹：按字面路径找到那一行，标移除", () => {
    createFoo();
    const extra = folder("extra");
    hub(lin.sessionId, "project.attach", { project: "foo", folder: extra });
    rmSync(extra, { recursive: true });
    const result = hub(lin.sessionId, "project.detach", { project: "foo", folder: extra });
    expect(result.data.folder).toMatchObject({ path: extra });
    expect(result.data.folder.removedAt).not.toBeNull();
  });

  it("管不着：阿周的会话挂小林的项目 → forbidden，记一行失败的 hub_calls", () => {
    createFoo();
    const before = tableCounts();
    expectLedgerError(() => hub(zhou.sessionId, "project.attach", { project: "foo", folder: folder("extra") }), "forbidden");
    expect(tableCounts()).toEqual(before);
    expect(hubCalls().at(-1)).toMatchObject({ session_id: zhou.sessionId, command: "project.attach", ok: 0, error_code: "forbidden" });
  });
});

describe("交接", () => {
  function assignFoo(caller: SessionId = lin.sessionId, handoff = "发布日期定在周五。") {
    return hub(caller, "project.assign", { project: "foo", to: "阿周", handoff });
  }

  it("交接：交接文件和记录、项目经理换了、群的新一代属于阿周、旧会话 session.end、群里和阿周私聊各一条系统消息", () => {
    const foo = createFoo();
    const extra = folder("extra");
    hub(lin.sessionId, "project.attach", { project: "foo", folder: extra });
    now = 7_000;
    changes = [];
    enqueued = [];
    const result = assignFoo(lin.sessionId, "发布日期定在周五。$HOME `x` \"q\"");
    const { project, handoff, sessionId: newSession } = result.data;
    expect(project).toMatchObject({ pmId: zhou.pmId, updatedAt: 7_000 });
    expect(handoff).toMatchObject({
      projectId: foo.project.id,
      fromSessionId: foo.groupSessionId,
      toSessionId: newSession,
      fromPmId: lin.pmId,
      toPmId: zhou.pmId,
      reason: "reassign",
      createdAt: 7_000,
    });
    expect(handoff.file.startsWith(join(handoffsDir, String(foo.project.id)))).toBe(true);
    expect(readFileSync(handoff.file, "utf8")).toBe("发布日期定在周五。$HOME `x` \"q\"");
    const old = sessionRow(foo.groupSessionId);
    const next = sessionRow(newSession);
    expect(next).toMatchObject({ pmId: zhou.pmId, conversationId: foo.conversation.id, generation: 2, cwd: foo.dir, addDirs: [extra], status: "idle" });
    expect(next.vendorSessionId).not.toBe(old.vendorSessionId);
    expect(enqueued).toContainEqual(expect.objectContaining({ type: "session.end", params: { sessionId: foo.groupSessionId, generation: 1 } }));
    const groupMessage = messagesIn(foo.conversation.id).at(-1)!;
    expect(groupMessage).toMatchObject({
      sender: "system",
      status: null,
      meta: { event: "project.reassigned", projectId: foo.project.id, handoffId: handoff.id, fromPmId: lin.pmId, toPmId: zhou.pmId },
    });
    expect(groupMessage.text).toMatch(/小林.*阿周/);
    const privateMessage = messagesIn(zhou.conversationId).at(-1)!;
    expect(privateMessage).toMatchObject({ sender: "system", status: "queued", sessionId: zhou.sessionId, meta: groupMessage.meta });
    expect(privateMessage.text.startsWith(SYSTEM_MESSAGE_PREFIX)).toBe(true);
    expect(privateMessage.text).toMatch(/小林把 foo 交给了你/);
    expect(enqueued).toContainEqual(
      expect.objectContaining({ type: "session.send", params: { sessionId: zhou.sessionId, messageId: privateMessage.id, source: "system" } }),
    );
    expect(changes.map((c) => c.type)).toEqual(["project.updated", "session.created", "message.created", "message.created"]);
    // 旧会话和新一代的会话状态各带自己的项目经理，网页靠它给消息署名
    const snapshotSessions = ledger.snapshot().sessions;
    expect(snapshotSessions.find((s) => s.sessionId === foo.groupSessionId)).toMatchObject({ pmId: lin.pmId });
    expect(snapshotSessions.find((s) => s.sessionId === newSession)).toMatchObject({ pmId: zhou.pmId });
    // hub_calls 记的是调用者（私聊）
    expect(hubCalls().at(-1)).toMatchObject({ session_id: lin.sessionId, command: "project.assign", ok: 1 });
    // 之后阿周管它，小林管不着了
    expectLedgerError(() => hub(lin.sessionId, "project.attach", { project: "foo", folder: folder("x") }), "forbidden");
  });

  it("同一毫秒里交接两次：两份交接文件都在，不互相覆盖", () => {
    createFoo();
    const first = assignFoo().data.handoff;
    const second = hub(zhou.sessionId, "project.assign", { project: "foo", to: "小林", handoff: "第二份" }).data.handoff;
    expect(second.file).not.toBe(first.file);
    // 文件名带交接编号，靠它保证不撞名，不靠“先看文件在不在”
    expect(basename(first.file)).toMatch(new RegExp(`^${first.id}-`));
    expect(basename(second.file)).toMatch(new RegExp(`^${second.id}-`));
    expect(readFileSync(first.file, "utf8")).toBe("发布日期定在周五。");
    expect(readFileSync(second.file, "utf8")).toBe("第二份");
  });

  it("写交接文件失败：整个命令失败，什么都没写", () => {
    createFoo();
    const before = tableCounts();
    const failing = createLedger(db, options({ writeFileAtomic: () => { throw new Error("disk full"); } }));
    expect(() => failing.hubCall(lin.sessionId, "project.assign", { project: "foo", to: "阿周", handoff: "x" })).toThrow(/disk full/);
    expect(tableCounts()).toEqual(before);
    expect(hubCalls().at(-1)).toMatchObject({ ok: 0, error_code: "internal" });
  });

  it("交接时群里还在排队的消息：改指新一代会话", () => {
    const foo = createFoo();
    const queued = ledger.postUserMessage({ conversationId: foo.conversation.id, clientId: "q", text: "还在排队" }).messageId;
    const { sessionId: newSession } = assignFoo().data;
    expect(ledger.getMessage(queued)!.sessionId).toBe(newSession);
    const action = listActions(db).find((a) => a.type === "session.send" && a.params.messageId === queued)!;
    expect(action.params).toEqual({ sessionId: newSession, messageId: queued, source: "user" });
  });

  it("交接边界：没有正文、交给自己 → invalid；交给不存在的人 → not_found；正文超过 64 KB → invalid；都什么也没写", () => {
    createFoo();
    const before = tableCounts();
    expectLedgerError(() => assignFoo(lin.sessionId, "  \n "), "invalid");
    expectLedgerError(() => hub(lin.sessionId, "project.assign", { project: "foo", to: "小林", handoff: "x" }), "invalid", /自己/);
    expectLedgerError(() => hub(lin.sessionId, "project.assign", { project: "foo", to: "老王", handoff: "x" }), "not_found", /老王/);
    expectLedgerError(() => assignFoo(lin.sessionId, "a".repeat(MAX_HANDOFF_BYTES + 1)), "invalid");
    expectLedgerError(() => hub(lin.sessionId, "project.assign", { project: "nope", to: "阿周", handoff: "x" }), "not_found");
    expectLedgerError(() => assignFoo(zhou.sessionId), "forbidden");
    expect(tableCounts()).toEqual(before);
  });

  it("换人后发消息：用户在群里发一条，session.send 指向新一代会话", () => {
    const foo = createFoo();
    const { sessionId: newSession } = assignFoo().data;
    const id = ledger.postUserMessage({ conversationId: foo.conversation.id, clientId: "after", text: "发布日期是哪天" }).messageId;
    const action = listActions(db).find((a) => a.type === "session.send" && a.params.messageId === id)!;
    expect(action.params.sessionId).toBe(newSession);
  });

  it("停止只停最新一代：旧一代还在跑时用户点停止，只通知新一代；只有旧一代在跑时什么也不做", () => {
    const foo = createFoo();
    const { sessionId: newSession } = assignFoo().data;
    const stops: SessionId[] = [];
    ledger.onStopRequested((e) => stops.push(e.sessionId));
    ledger.applyDriverEvent(foo.groupSessionId, { type: "agent.text", at: 1, uuid: "u1", text: "还在回" });
    ledger.requestStop(foo.conversation.id);
    expect(stops).toEqual([]);
    ledger.applyDriverEvent(newSession, { type: "agent.text", at: 1, uuid: "u2", text: "新一代也在回" });
    ledger.requestStop(foo.conversation.id);
    expect(stops).toEqual([newSession]);
  });
});

describe("性格设定", () => {
  it("改习惯：会话调 persona.edit（新正文、hands_on）→ 文件和模式变了、persona_changes 一行（actor pm）、发起的对话里一条系统消息、推 pm.updated", () => {
    const foo = createFoo();
    now = 8_000;
    changes = [];
    const result = hub(foo.groupSessionId, "persona.edit", { text: "以后回复都用列表", mode: "hands_on", reason: "用户要求" });
    const change = result.data.change!;
    expect(change).toMatchObject({
      pmId: lin.pmId,
      actor: "pm",
      sessionId: foo.groupSessionId,
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
    const message = messagesIn(foo.conversation.id).at(-1)!;
    expect(message).toMatchObject({ sender: "system", status: null, meta: { event: "persona.changed", pmId: lin.pmId, personaChangeId: change.id, revertOf: null } });
    expect(message.text).toContain("改了自己的做事习惯");
    expect(changes.map((c) => c.type)).toEqual(["pm.updated", "message.created"]);
    const updated = changes[0]!;
    expect(updated.type === "pm.updated" && updated.data.pm.mode).toBe("hands_on");
    // 只改模式也行；什么都没变 → change null，不写不推
    changes = [];
    expect(hub(lin.sessionId, "persona.edit", { mode: "hands_on" }).data.change).toBeNull();
    expect(changes).toEqual([]);
    expect(hub(lin.sessionId, "persona.show", {} as never).data).toEqual({ text: "以后回复都用列表", mode: "hands_on" });
  });

  it("界面改性格设定：系统消息发在私聊；text、mode 都没给、太长 → invalid；不存在 → not_found；会话改别人的 → forbidden", () => {
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

  it("同步的其他情况：M1 升上来正文是 NULL（有文件按文件填、没文件用模板）；文件被删了按数据库重写；从没写成功过的手改按数据库重写", () => {
    db.run("UPDATE pms SET persona = NULL, persona_file_hash = NULL WHERE id = ?", lin.pmId);
    writeFileSync(personaFilePath(personasDir, lin.pmId), "M1 的文件");
    db.run("UPDATE pms SET persona = NULL, persona_file_hash = NULL WHERE id = ?", zhou.pmId);
    rmSync(personaFilePath(personasDir, zhou.pmId));
    // 正文 NULL 时读出来是模板
    expect(ledger.getPersona(zhou.pmId).text).toBe(PM_PERSONA_TEMPLATE);
    const third = ledger.createPm({ name: "老王", mode: "manage_only", persona: "老王的" }).pm.id;
    rmSync(personaFilePath(personasDir, third));
    const fourth = ledger.createPm({ name: "老李", mode: "manage_only", persona: "老李的" }).pm.id;
    db.run("UPDATE pms SET persona_file_hash = NULL WHERE id = ?", fourth);
    writeFileSync(personaFilePath(personasDir, fourth), "分不清谁改的");
    const result = ledger.syncPersonaFiles();
    expect(result).toEqual({ recordedPmIds: [], rewrittenPmIds: [zhou.pmId, third, fourth] });
    expect(ledger.getPersona(lin.pmId).text).toBe("M1 的文件");
    expect(ledger.getPersona(zhou.pmId).text).toBe(PM_PERSONA_TEMPLATE);
    expect(readFileSync(personaFilePath(personasDir, zhou.pmId), "utf8")).toBe(PM_PERSONA_TEMPLATE);
    expect(readFileSync(personaFilePath(personasDir, third), "utf8")).toBe("老王的");
    expect(readFileSync(personaFilePath(personasDir, fourth), "utf8")).toBe("老李的");
    expect(count("persona_changes")).toBe(0);
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

  it("重试发给这个对话现在最新一代的会话；不是用户发的消息 → conflict", () => {
    const foo = createFoo();
    const failed = ledger.postUserMessage({ conversationId: foo.conversation.id, clientId: "f", text: "失败的" }).messageId;
    db.run("UPDATE messages SET status = 'failed' WHERE id = ?", failed);
    const { sessionId: newSession } = hub(lin.sessionId, "project.assign", { project: "foo", to: "阿周", handoff: "交接" }).data;
    ledger.retryMessage(failed);
    expect(ledger.getMessage(failed)!.sessionId).toBe(newSession);
    const action = listActions(db).find((a) => a.type === "session.send" && a.params.messageId === failed)!;
    expect(action.params.sessionId).toBe(newSession);
    const system = messagesIn(foo.conversation.id).find((m) => m.sender === "system")!;
    db.run("UPDATE messages SET status = 'failed' WHERE id = ?", system.id);
    expectLedgerError(() => ledger.retryMessage(system.id), "conflict");
  });
});

describe("hubCall 其他命令", () => {
  it("status、pm.list：我是谁、在哪、管哪些项目；所有项目经理和各自的项目", () => {
    const foo = createFoo();
    hub(lin.sessionId, "project.attach", { project: "foo", folder: folder("extra") });
    const status = hub(foo.groupSessionId, "status", {} as never);
    expect(status.data).toMatchObject({
      pm: { id: lin.pmId, name: "小林", mode: "manage_only" },
      sessionId: foo.groupSessionId,
      conversation: { id: foo.conversation.id, kind: "project_group", projectId: foo.project.id },
      projects: [{ id: foo.project.id, name: "foo", mainFolder: foo.dir, otherFolders: [join(work, "extra")].map((p) => realpathSync.native(p)) }],
    });
    expect(status.text).toContain("小林");
    expect(status.text).toContain("foo");
    const list = hub(zhou.sessionId, "pm.list", {} as never);
    expect(list.data.pms).toEqual([
      { id: lin.pmId, name: "小林", mode: "manage_only", projects: ["foo"] },
      { id: zhou.pmId, name: "阿周", mode: "hands_on", projects: [] },
    ]);
    expect(list.text).toContain("阿周");
  });

  it("会话不存在、不是项目经理的会话 → forbidden；长字段在 hub_calls 里截断", () => {
    expectLedgerError(() => hub(999, "status", {} as never), "forbidden");
    const worker = db.run(
      "INSERT INTO agent_sessions (role, vendor_session_id, cwd, created_at, updated_at) VALUES ('worker', 'w-1', '/tmp', 0, 0)",
    ).lastInsertRowid;
    expectLedgerError(() => hub(worker, "status", {} as never), "forbidden");
    createFoo();
    const long = "交".repeat(HUB_CALL_FIELD_MAX_BYTES);
    hub(lin.sessionId, "project.assign", { project: "foo", to: "阿周", handoff: long });
    const args = JSON.parse(hubCalls().at(-1)!.args) as { handoff: string; to: string };
    expect(args.to).toBe("阿周");
    expect(args.handoff).toBe(truncateField(long));
    expect(args.handoff).toMatch(/截断，原长 6144 字节/);
    expect(new TextEncoder().encode(args.handoff.split("…")[0]!).length).toBeLessThanOrEqual(HUB_CALL_FIELD_MAX_BYTES);
  });
});

describe("getLaunchContext", () => {
  it("群会话：项目信息、其他文件夹、最近一份交接；私聊会话：管着的项目名片，没有项目信息", () => {
    const foo = createFoo();
    const extra = folder("extra");
    hub(lin.sessionId, "project.attach", { project: "foo", folder: extra });
    createFoo("bar");
    now = 6_000;
    const { sessionId: newSession, handoff } = hub(lin.sessionId, "project.assign", { project: "foo", to: "阿周", handoff: "周五发布" }).data;
    const group = ledger.getLaunchContext(newSession);
    expect(group).toMatchObject({
      sessionId: newSession,
      role: "pm",
      conversation: { id: foo.conversation.id, kind: "project_group" },
      pm: { id: zhou.pmId, name: "阿周", mode: "hands_on", persona: "阿周的习惯" },
      project: { id: foo.project.id, name: "foo", description: null, mainFolder: foo.dir, otherFolders: [extra] },
      handoff: { id: handoff.id, fromPmName: "小林", text: "周五发布", createdAt: 6_000 },
    });
    // 旧一代还是小林的
    expect(ledger.getLaunchContext(foo.groupSessionId).pm.name).toBe("小林");
    const priv = ledger.getLaunchContext(lin.sessionId);
    expect(priv).toMatchObject({ conversation: { id: lin.conversationId, kind: "pm" }, project: null, handoff: null });
    expect(priv.managedProjects.map((p) => p.name)).toEqual(["bar"]);
    expect(ledger.getLaunchContext(zhou.sessionId).managedProjects.map((p) => p.name)).toEqual(["foo"]);
    // 没交接过的群：handoff null
    const bar = currentGroupSession(db.get<{ conversation_id: number }>("SELECT conversation_id FROM projects WHERE name = 'bar'")!.conversation_id);
    expect(ledger.getLaunchContext(bar).handoff).toBeNull();
    // persona 是 NULL 时兜底成模板
    db.run("UPDATE pms SET persona = NULL WHERE id = ?", lin.pmId);
    expect(ledger.getLaunchContext(lin.sessionId).pm.persona).toBe(PM_PERSONA_TEMPLATE);
    expectLedgerError(() => ledger.getLaunchContext(999), "not_found");
  });

  it("其他文件夹、管着的项目按编号排，顺序固定（不按路径、名字），免得无端触发重启", () => {
    hub(zhou.sessionId, "project.create", { name: "mm", folder: folder("mm") });
    createFoo("zz");
    createFoo("aa");
    const z = folder("z-extra");
    const a = folder("a-extra");
    hub(lin.sessionId, "project.attach", { project: "zz", folder: z });
    hub(lin.sessionId, "project.attach", { project: "zz", folder: a });
    hub(zhou.sessionId, "project.assign", { project: "mm", to: "小林", handoff: "给你了" });
    const first = ledger.getLaunchContext(lin.sessionId);
    expect(first.managedProjects.map((p) => p.name)).toEqual(["mm", "zz", "aa"]);
    expect(first.managedProjects.find((p) => p.name === "zz")!.otherFolders).toEqual([z, a]);
    expect(ledger.getLaunchContext(lin.sessionId)).toEqual(first);
  });
});
