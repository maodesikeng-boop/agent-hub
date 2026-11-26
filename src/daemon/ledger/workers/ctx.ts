import { createWorkerAppApprovals } from "./app-approvals.ts";
import type { AgentSessionRow, PmId, WorkerId } from "../../../shared/domain.ts";
import type { LedgerContext } from "../context.ts";
import { fail } from "../context.ts";
import type { LedgerMessages } from "../messages.ts";
import type { LedgerPersona } from "../persona.ts";
import type { LedgerProjects } from "../projects.ts";
import type { ProjectDbRow, WorkerDbRow } from "../rows.ts";
import type { LedgerSessions } from "../sessions.ts";
import { createWorkerSandboxApprovals } from "./sandbox.ts";
import { createLedgerTurnBackgroundWaits } from "../turn-background-waits.ts";
import { deliverHeldReportIn } from "./reports.ts";
import type { LedgerWorkersOptions, WorkersCtx } from "./types.ts";

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
    backgroundWaits: createLedgerTurnBackgroundWaits(ctx, {
      deliverHeldReportIn: (p, wait, release) => deliverHeldReportIn(w, p, wait, release),
      publishTurnIn: options.turns.publishTurnIn,
    }),
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
