import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checklistOf, MIN_TOOL_STEP_VISIBLE_MS, PM_ARCHIVE_RETENTION_MS, PM_TOOL_MESSAGE_RETENTION_MS, PM_TOOL_MESSAGES_MAX_PER_CONV, type ChecklistUpdate, type Change, type DriverEvent } from "../../shared/index.ts";
import { claudeChecklistFromToolResult, claudeChecklistFromToolUse, createClaudeChecklistState } from "../../vendors/claude/checklist.ts";
import { createSessionStore, type Db } from "../store/index.ts";
import { insertTestSession, openTestDb } from "../store/test-helpers.ts";
import { createLedgerContext } from "./context.ts";
import { createDbTableRetention } from "./db-table-retention.ts";
import { createLedger, type SqliteLedger } from "./index.ts";

let db: Db;
let ledger: SqliteLedger;
let dir: string;
let now: number;
let pm: ReturnType<SqliteLedger["createPm"]>;
let changes: Change[];

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "bellwood-checklist-"));
  db = openTestDb();
  now = 10_000;
  changes = [];
  ledger = createLedger(db, { now: () => now, pmHomeRoot: join(dir, "state", "pm-home"), dataHome: join(dir, "state"), userHome: dir });
  pm = ledger.createPm({ name: "Checklist test", mode: "manage_only", persona: "" });
  ledger.onChange((change) => changes.push(change));
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

const advance = (ms: number) => {
  now += ms;
  vi.advanceTimersByTime(ms);
};
const emit = (event: DriverEvent) => ledger.applyDriverEvent(pm.sessionId, event);
const setChecklist = (uuid: string, update: ChecklistUpdate) => emit({ type: "agent.checklist", uuid, update, at: now });
const checklistRows = () => ledger.messagesBefore(pm.conversation.id, Number.MAX_SAFE_INTEGER).messages.filter((message) => message.kind === "checklist");
const live = () => ledger.snapshot().sessions.find((row) => row.sessionId === pm.sessionId);
const tool = (toolUseId: string, timing: { pending?: true; startedAt?: number } = {}, name = "Read") =>
  ({ type: "agent.tool", at: now, uuid: toolUseId, name, toolUseId, input: {}, ...timing }) satisfies DriverEvent;

const first: ChecklistUpdate = {
  kind: "replace",
  items: [{ id: "step", title: "Read probe", status: "in_progress" }],
};

describe("ledger checklists", () => {
  it("stores immutable snapshots, deduplicates updates and ignores subagent checklists", () => {
    setChecklist("first", first);
    setChecklist("same", first);
    emit({ type: "agent.checklist", parentToolUseId: "sub", uuid: "sub", update: { kind: "replace", items: [] }, at: now });
    const detached = insertTestSession(db);
    ledger.applyDriverEvent(detached, { type: "agent.checklist", uuid: "detached", update: first, at: now });
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM messages WHERE kind = 'checklist'")?.count).toBe(1);
    expect(checklistRows()).toHaveLength(1);
    const row = checklistRows()[0]!;
    expect(row).toMatchObject({ sender: "agent", collapsed: true, text: "", meta: {
      checklist: [{ id: "step", title: "Read probe", status: "in_progress", activeTitle: null }],
    } });
    expect(changes).toContainEqual(expect.objectContaining({ type: "message.created", data: { message: row } }));
    setChecklist("clear", { kind: "replace", items: [] });
    setChecklist("first", first);
    setChecklist("finish", { kind: "merge", items: [{ id: "step", status: "completed" }] });
    expect(checklistRows().map(checklistOf)).toEqual([checklistOf(row), []]);
  });

  it("restores a merge baseline across turns and a ledger restart", () => {
    setChecklist("first", first);
    emit({ type: "turn.ended", at: now, messageIds: [], ok: true, interrupted: false, durationMs: 1 });
    ledger.close();
    ledger = createLedger(db, { now: () => now, pmHomeRoot: join(dir, "state", "pm-home"), dataHome: join(dir, "state"), userHome: dir });
    setChecklist("finish", { kind: "merge", items: [{ id: "step", status: "completed" }] });
    expect(checklistRows().map(checklistOf)).toMatchObject([
      [{ title: "Read probe", status: "in_progress" }],
      [{ title: "Read probe", status: "completed" }],
    ]);
  });

  it.each(["age", "count"])("applies a status-only update after PM history is pruned by %s", (limit) => {
    const retention = createDbTableRetention(createLedgerContext(db, { now: () => now }));
    const claude = createClaudeChecklistState();
    claudeChecklistFromToolUse(claude, { toolUseId: "create", name: "TaskCreate", input: { subject: "Read probe" } });
    const created = claudeChecklistFromToolResult(claude, "create", { task: { id: "1" } });
    if (created === null) throw new Error("Missing TaskCreate update");
    setChecklist("create", created);
    expect(checklistRows().map(checklistOf)).toMatchObject([[{ id: "1", title: "Read probe", status: "pending" }]]);

    if (limit === "age") {
      now += PM_TOOL_MESSAGE_RETENTION_MS + 1;
    } else {
      for (let i = 0; i < PM_TOOL_MESSAGES_MAX_PER_CONV; i++) emit(tool(`read-${i}`));
    }
    expect(retention.purgePmToolMessagesBatch(now, 10)).toEqual({ rows: 1, more: false });
    expect(checklistRows()).toEqual([]);

    const started = claudeChecklistFromToolUse(claude, { toolUseId: "start", name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } });
    if (started === null) throw new Error("Missing TaskUpdate update");
    setChecklist("start", started);
    expect(checklistRows().map(checklistOf)).toMatchObject([[{ id: "1", title: "Read probe", status: "in_progress" }]]);
  });

  it("keeps one baseline per session and deletes it when the archived PM is purged", () => {
    setChecklist("first", first);
    setChecklist("finish", { kind: "merge", items: [{ id: "step", status: "completed" }] });
    expect(db.all("SELECT session_id FROM session_checklists")).toEqual([{ session_id: pm.sessionId }]);

    ledger.archivePm(pm.pm.id);
    expect(ledger.purgeExpiredArchivedPms(now + PM_ARCHIVE_RETENTION_MS)).toEqual([pm.pm.id]);
    expect(db.all("SELECT session_id FROM session_checklists")).toEqual([]);
  });

  it("clears the baseline when a session ends and keeps its history", () => {
    setChecklist("first", first);
    createSessionStore(db).update(pm.sessionId, { status: "ended" });
    setChecklist("late", first);
    expect(db.all("SELECT session_id FROM session_checklists")).toEqual([]);
    expect(checklistRows().map(checklistOf)).toMatchObject([[{ title: "Read probe", status: "in_progress" }]]);
  });

  it("does not log a todo tool, preview, or result as Worker process", () => {
    const folder = join(dir, "project");
    mkdirSync(folder);
    ledger.hubCall(pm.sessionId, "project.create", { folder });
    const { worker } = ledger.hubCall(pm.sessionId, "worker.start", {
      title: "Read probe", task: "Check the probe.", vendor: "claude", noWorktree: true,
    }).data;
    const workerSession = db.get<{ id: number; conversation_id: number }>("SELECT id, conversation_id FROM agent_sessions WHERE worker_id = ?", worker.id)!;
    const send = (event: DriverEvent) => ledger.applyDriverEvent(workerSession.id, event);
    send({ type: "turn.started", at: now });
    send({ type: "agent.tool_preview", name: "TaskUpdate", at: now });
    send(tool("todo", { pending: true }, "TaskUpdate"));
    send({ type: "agent.tool_running", toolUseId: "todo", at: now });
    send({ type: "agent.tool_result", toolUseIds: ["todo"], at: now });
    expect(ledger.snapshot().sessions.find(({ sessionId }) => sessionId === workerSession.id)?.step).toEqual({ type: "thinking" });

    send({ type: "agent.checklist", uuid: "worker-list", update: first, at: now });
    send(tool("real"));
    send({ type: "agent.tool_result", toolUseIds: ["todo", "real"], at: now });
    expect(ledger.messagesBefore(workerSession.conversation_id, Number.MAX_SAFE_INTEGER).messages.filter((m) => m.sender === "agent")
      .map(({ kind }) => kind)).toEqual(["checklist", "tool"]);
    expect(db.all<{ tool_use_id: string }>("SELECT tool_use_id FROM session_steps WHERE session_id = ? AND tool_use_id IS NOT NULL ORDER BY id", workerSession.id))
      .toEqual([{ tool_use_id: "real" }, { tool_use_id: "real" }]);
  });
});

describe("live action timing", () => {
  it("orients the clock to execution and keeps the other tool's time after a parallel result", () => {
    emit(tool("first", { startedAt: now - 400 }, "Bash"));
    expect(live()?.stepStartedAt).toBe(now - 400);
    const firstStart = now - 400;
    advance(100);
    emit(tool("second", { pending: true }));
    expect(live()).toMatchObject({ step: { name: "Bash" }, stepStartedAt: firstStart });
    advance(100);
    emit({ type: "agent.tool_running", toolUseId: "second", at: now });
    expect(live()).toMatchObject({ step: { name: "Read" }, stepStartedAt: now });
    advance(100);
    emit({ type: "agent.tool_result", toolUseIds: ["second"], at: now });
    expect(live()).toMatchObject({ step: { name: "Bash" }, stepStartedAt: firstStart });
  });

  it("resets clocks by action, preserves the held clock, and ignores lastEventAt", () => {
    emit({ type: "turn.started", at: now });
    const thinkingAt = now;
    advance(10);
    emit({ type: "agent.thinking", uuid: "thinking", at: now });
    expect(live()?.stepStartedAt).toBe(thinkingAt);
    emit({ type: "agent.text_delta", delta: "I will check.", at: now });
    expect(live()?.stepStartedAt).toBe(now);

    advance(10);
    emit(tool("waiting", { pending: true }));
    expect(live()?.stepStartedAt).toBeNull();
    advance(10);
    emit({ type: "agent.tool_running", toolUseId: "waiting", at: now });
    const executionAt = now;
    createSessionStore(db).update(pm.sessionId, { lastEventAt: now + 1_000 });
    expect(live()?.stepStartedAt).toBe(executionAt);

    advance(10);
    emit({ type: "agent.tool_result", toolUseIds: ["waiting"], at: now });
    expect(live()?.stepStartedAt).toBe(executionAt);
    advance(MIN_TOOL_STEP_VISIBLE_MS);
    expect(live()).toMatchObject({ step: { type: "thinking" }, stepStartedAt: now });
    emit({ type: "turn.ended", at: now, messageIds: [], ok: true, interrupted: false, durationMs: 1 });
    expect(live()).toMatchObject({ activity: "idle", step: null, stepStartedAt: null });
  });
});
