import { createWorkerAppApprovals } from "./app-approvals.ts";
import type { AgentSessionRow, PmId, SessionId, WorkerId } from "../../../shared/domain.ts";
import type { LedgerContext } from "../context.ts";
import { fail } from "../context.ts";
import type { LedgerMessages } from "../messages.ts";
import type { LedgerPersona } from "../persona.ts";
import type { LedgerProjects } from "../projects.ts";
import type { ProjectDbRow, WorkerDbRow } from "../rows.ts";
import type { LedgerSessions } from "../sessions.ts";
import { createWorkerSandboxApprovals } from "./sandbox.ts";
import type { AwaitingBackground, BackgroundWait, LedgerWorkersOptions, WorkersCtx } from "./types.ts";

function createAwaitingBackground(db: LedgerContext["db"], now: LedgerContext["now"]): AwaitingBackground {
  const get = (sessionId: SessionId): BackgroundWait | undefined => {
    const row = db.get<{ turn_start: number; turn_end: number | null; direct_chat: number | null; background: number }>(
      `SELECT b.turn_start, d.turn_end, d.direct_chat, b.background FROM worker_background_waits b
       LEFT JOIN worker_background_wait_details d ON b.session_id = d.session_id WHERE b.session_id = ?`, sessionId,
    );
    return row === undefined ? undefined : { turnStart: row.turn_start, turnEnd: row.turn_end, directChat: row.direct_chat === 1, background: row.background === 1 };
  };
  return {
    get,
    set: (sessionId, turn) => {
      db.run(
        "INSERT INTO worker_background_waits (session_id, turn_start, background, created_at) VALUES (?, ?, 1, ?)",
        sessionId,
        turn.turnStart,
        now(),
      );
      if (turn.turnEnd !== null) {
        db.run("INSERT INTO worker_background_wait_details (session_id, turn_end, direct_chat) VALUES (?, ?, ?)", sessionId, turn.turnEnd, turn.directChat ? 1 : 0);
      }
    },
    setBackground: (sessionId, background) => {
      db.run("UPDATE worker_background_waits SET background = ? WHERE session_id = ?", background ? 1 : 0, sessionId);
    },
    take: (sessionId) => {
      const wait = get(sessionId);
      if (wait !== undefined) db.run("DELETE FROM worker_background_waits WHERE session_id = ?", sessionId);
      return wait;
    },
  };
}

export function createWorkersCtx(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  persona: LedgerPersona,
  projects: LedgerProjects,
  options: LedgerWorkersOptions,
): WorkersCtx {
  const w: WorkersCtx = {
    ctx,
    db: ctx.db,
    now: ctx.now,
    write: ctx.write,
    enqueue: ctx.enqueue,
    sessions,
    messages,
    persona,
    projects,
    options,
    appApprovals: createWorkerAppApprovals(() => w, ctx),
    sandboxApprovals: createWorkerSandboxApprovals(() => w, ctx),
    turnStarts: new Map(),
    maxTimeTimers: new Map(),
    awaitingBackground: createAwaitingBackground(ctx.db, ctx.now),
  };
  return w;
}

export const workerRow = (w: WorkersCtx, id: WorkerId): WorkerDbRow | null => w.db.get<WorkerDbRow>("SELECT * FROM workers WHERE id = ?", id) ?? null;

export const projectRow = (w: WorkersCtx, id: number): ProjectDbRow => w.db.get<ProjectDbRow>("SELECT * FROM projects WHERE id = ?", id)!;

export const workerSession = (w: WorkersCtx, worker: WorkerId | WorkerDbRow): AgentSessionRow =>
  w.sessions.currentSession((typeof worker === "number" ? workerRow(w, worker)! : worker).worker_conversation_id)!;

export const mainFolderOf = (w: WorkersCtx, projectId: number): string => w.projects.projectCard(projectRow(w, projectId)).mainFolder;

export function ownWorker(w: WorkersCtx, pmId: PmId, workerId: WorkerId): WorkerDbRow {
  const row = workerRow(w, workerId);
  if (row === null) throw fail("not_found", `没有编号 ${workerId} 的 Worker`);
  if (row.pm_id !== pmId) throw fail("forbidden", `Worker #${workerId} 不是你派的，管不着`);
  return row;
}
