import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyActionRow } from "../../shared/actions.ts";
import { systemEventOf, type ConversationId, type Message, type MessageId, type PmId, type SessionId, type TaskGraph, type TaskGraphId, type WorkerId } from "../../shared/domain.ts";
import type { HubResult } from "../../shared/hub.ts";
import { workerSetupLogPath } from "../../shared/paths.ts";
import { REPORT_END, REPORT_START } from "../../shared/worker.ts";
import { addWorktree, resolveBranchTip } from "../git/index.ts";
import { createWorktreeCreateHandler } from "../handlers.ts";
import { createSessionStore, migrate, type Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type SqliteLedger } from "./index.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

export interface ReportFields {
  status: "做完了" | "有问题" | "放弃了";
  summary: string;
  commit?: string;
  pr?: string;
  tests?: string;
  deviation?: string;
  handoff?: string;
  files?: string;
  questions?: string;
}

export function reportBlock(fields: ReportFields): string {
  return [
    REPORT_START,
    `状态: ${fields.status}`,
    `摘要: ${fields.summary}`,
    `提交: ${fields.commit ?? "无"}`,
    `PR: ${fields.pr ?? "无"}`,
    `测试: ${fields.tests ?? "通过"}`,
    `偏离: ${fields.deviation ?? "无"}`,
    ...(fields.handoff !== undefined ? [`交棒: ${fields.handoff}`] : []),
    ...(fields.files !== undefined ? [`文件: ${fields.files}`] : []),
    `问题: ${fields.questions ?? "无"}`,
    REPORT_END,
  ].join("\n");
}

export interface PmHandle {
  pmId: PmId;
  conversationId: ConversationId;
  sessionId: SessionId;
}

export interface PmFrictionFixture {
  root: string;
  repoDir: string;
  db: Db;
  ledger: SqliteLedger;
  lin: PmHandle;
  enqueued: AnyActionRow[];
  clock: { now: number };
  createPm: (name: string) => PmHandle;
  createGraph: (spec: object) => HubResult<"graph.create">;
  patchGraph: (spec: object, graphId?: TaskGraphId) => HubResult<"graph.patch">;
  showGraph: (graphId?: TaskGraphId) => TaskGraph;
  startWorktree: (workerId: WorkerId) => Promise<void>;
  workerSessionOf: (workerId: WorkerId) => { id: SessionId; conversation_id: ConversationId };
  workerTurn: (workerId: WorkerId, replyText: string) => void;
  pmReplyTo: (messageId: MessageId, replyText: string, pm?: PmHandle) => void;
  pmMessages: (conversationId?: ConversationId) => Message[];
  pmSystemMessages: (conversationId?: ConversationId) => Message[];
  close: () => void;
}

export function createPmFrictionFixture(options: { osSandboxed?: boolean; readonlyKernelSandboxed?: boolean } = {}): PmFrictionFixture {
  const clock = { now: new Date(2026, 10, 20, 9, 0).getTime() };
  const enqueued: AnyActionRow[] = [];
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-pmf-")));
  const dataHome = join(root, "data");
  const pmHomeRoot = join(dataHome, "pm-home");
  const worktreesDir = join(dataHome, "worktrees");
  const launchDir = join(dataHome, "state", "launch");
  const setupLogsDir = join(dataHome, "state", "logs", "setup");
  const repoDir = join(root, "repo");
  for (const d of [pmHomeRoot, worktreesDir, launchDir, setupLogsDir, repoDir]) mkdirSync(d, { recursive: true });
  git(repoDir, "init", "-b", "main");
  writeFileSync(join(repoDir, "README.md"), "# pmf\n");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "initial commit");

  const db = openTestDb();
  migrate(db);
  const ledger = createLedger(db, {
    now: () => clock.now,
    pmHomeRoot,
    dataHome,
    worktreesDir,
    launchDir,
    setupLogsDir,
    userHome: root,
    osSandboxed: () => options.osSandboxed ?? true,
    readonlyKernelSandboxed: () => options.readonlyKernelSandboxed ?? options.osSandboxed ?? true,
    models: { current: () => null, availability: () => "available" },
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
  });
  ledger.onActionEnqueued((a) => enqueued.push(a));
  const createPm = (name: string): PmHandle => {
    const created = ledger.createPm({ name, mode: "manage_only", persona: "", folder: repoDir });
    return { pmId: created.pm.id, conversationId: created.conversation.id, sessionId: created.sessionId };
  };
  const lin = createPm("林经理");
  enqueued.length = 0;

  const startWorktree = async (workerId: WorkerId): Promise<void> => {
    const handler = createWorktreeCreateHandler({
      ledger,
      resolveTip: resolveBranchTip,
      probePr: async () => null,
      addWorktree,
      setup: {
        start: (req) => {
          req.onDone({ kind: "ok", command: req.command, exitCode: 0, signal: null, error: null, timeoutMs: 60_000, durationMs: 50, tail: "ok", logPath: req.logPath, logError: null });
          return true;
        },
      },
      setupLogPath: (id) => workerSetupLogPath(setupLogsDir, id),
    });
    const t = ++clock.now;
    await handler({ id: t, type: "worktree.create", dedupeKey: String(workerId), params: { workerId }, status: "running", attempts: 1, nextAttemptAt: t, lastError: null, createdAt: t, updatedAt: t });
  };

  const workerSessionOf = (workerId: WorkerId) =>
    db.get<{ id: SessionId; conversation_id: ConversationId }>(
      "SELECT id, conversation_id FROM agent_sessions WHERE worker_id = ? ORDER BY generation DESC LIMIT 1",
      workerId,
    )!;

  const workerTurn = (workerId: WorkerId, replyText: string): void => {
    const s = workerSessionOf(workerId);
    const input = db.get<{ id: number }>(
      "SELECT id FROM messages WHERE conversation_id = ? AND sender IN ('pm', 'user') ORDER BY id DESC LIMIT 1",
      s.conversation_id,
    )!;
    const store = createSessionStore(db);
    store.update(s.id, { status: "running", pid: 50_000 + workerId });
    ledger.applyDriverEvent(s.id, { type: "message.delivered", messageIds: [input.id], at: ++clock.now });
    ledger.applyDriverEvent(s.id, { type: "message.processing", messageIds: [input.id], at: ++clock.now });
    ledger.applyDriverEvent(s.id, { type: "agent.text", uuid: `u-${workerId}-${++clock.now}`, text: replyText, at: clock.now });
    ledger.applyDriverEvent(s.id, { type: "turn.ended", ok: true, interrupted: false, messageIds: [input.id], durationMs: 20, at: ++clock.now });
    store.update(s.id, { status: "idle", pid: 50_000 + workerId });
  };

  const pmReplyTo = (messageId: MessageId, replyText: string, pm: PmHandle = lin): void => {
    const store = createSessionStore(db);
    store.update(pm.sessionId, { status: "running", pid: 40_000 + pm.pmId });
    const footer = ledger.deliverySuffix?.(pm.sessionId, [messageId]).agenda;
    ledger.applyDriverEvent(pm.sessionId, { type: "message.delivered", messageIds: [messageId], at: ++clock.now,
      ...(footer === undefined ? {} : { agenda: { messageId, footer } }),
    });
    ledger.applyDriverEvent(pm.sessionId, { type: "message.processing", messageIds: [messageId], at: ++clock.now });
    ledger.applyDriverEvent(pm.sessionId, { type: "agent.text", uuid: `pm-${pm.pmId}-${++clock.now}`, text: replyText, at: clock.now });
    ledger.applyDriverEvent(pm.sessionId, { type: "turn.ended", ok: true, interrupted: false, messageIds: [messageId], durationMs: 20, at: ++clock.now });
    store.update(pm.sessionId, { status: "idle", pid: 40_000 + pm.pmId });
  };

  const pmMessages = (conversationId: ConversationId = lin.conversationId): Message[] =>
    db.all<{ id: number }>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id", conversationId).map((r) => ledger.getMessage(r.id)!);

  return {
    root,
    repoDir,
    db,
    ledger,
    lin,
    enqueued,
    clock,
    createPm,
    createGraph: (spec) => ledger.hubCall(lin.sessionId, "graph.create", { specJson: JSON.stringify(spec) }),
    patchGraph: (spec, graphId) =>
      ledger.hubCall(lin.sessionId, "graph.patch", { ...(graphId === undefined ? {} : { graphId }), specJson: JSON.stringify(spec) }),
    showGraph: (graphId) => ledger.hubCall(lin.sessionId, "graph.show", graphId === undefined ? {} : { graphId }).data.graph,
    startWorktree,
    workerSessionOf,
    workerTurn,
    pmReplyTo,
    pmMessages,
    pmSystemMessages: (conversationId) => pmMessages(conversationId).filter((m) => m.sender === "system" && systemEventOf(m) !== null),
    close: () => {
      ledger.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
