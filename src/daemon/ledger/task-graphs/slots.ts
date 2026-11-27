import type { TaskGraphId, TaskNode, TaskNodeKey, WorkerId } from "../../../shared/domain.ts";
import { CODE_TRIGGER_PREFIX, type Db } from "../../store/index.ts";
import { CHECKLIST_REMINDER_SQL } from "../checklist-reminders.ts";

// Invariant: after any committed write, each slot on this daemon has at most one holder, and no slot is free while a
// step waits for it. The SLOT_ADMIT_TRIGGER trigger refuses any write that puts a step into running while another step
// holds its slot, and is built from HOLDS_SLOT_SQL each time the ledger opens.

export interface SlotHolder {
  graphId: TaskGraphId;
  nodeKey: TaskNodeKey;
  workerId: WorkerId | null;
}

export type SlotQueue = NonNullable<TaskNode["slotQueue"]>;

export type SlotAdmission = { kind: "admitted" } | ({ kind: "queued"; slot: string } & SlotQueue);

interface SlotStepRow {
  step_id: number;
  graph_id: TaskGraphId;
  node_key: TaskNodeKey;
  active_worker_id: WorkerId | null;
}

/**
 * The one definition of a step `n` holding its slot, whatever its own status says: it runs, or its active Worker has a
 * running turn, background commands, or work it will start without anyone resuming it (a worktree still being created,
 * or input queued, delivered, or being processed). A Worker waiting for sandbox approval holds nothing until approved.
 * Ended graphs leave no step running and no Worker attached.
 */
export const HOLDS_SLOT_SQL =
  "(n.status = 'running' OR (n.active_worker_id IS NOT NULL AND (" +
  "EXISTS (SELECT 1 FROM agent_sessions a WHERE a.worker_id = n.active_worker_id AND (" +
  "EXISTS (SELECT 1 FROM session_background_tasks b WHERE b.session_id = a.id) OR EXISTS (SELECT 1 FROM turns t WHERE t.session_id = a.id AND t.status = 'running'))) " +
  "OR EXISTS (SELECT 1 FROM workers w WHERE w.id = n.active_worker_id AND w.status = 'open' " +
  "AND NOT EXISTS (SELECT 1 FROM worker_sandbox_approvals x WHERE x.worker_id = w.id AND x.status = 'pending') " +
  "AND ((w.workspace = 'worktree' AND w.base_commit IS NULL) OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = w.worker_conversation_id " +
  `AND m.status IN ('queued', 'delivered', 'processing') AND NOT ${CHECKLIST_REMINDER_SQL}))))))`;

export const SLOT_ADMIT_TRIGGER = `${CODE_TRIGGER_PREFIX}task_graph_step_slots_admit`;

/** Postcondition: the ledger refuses any write that moves a step into running while another step holds its slot. */
export function installSlotAdmission(db: Db): void {
  db.exec(`DROP TRIGGER IF EXISTS ${SLOT_ADMIT_TRIGGER};
CREATE TRIGGER ${SLOT_ADMIT_TRIGGER}
BEFORE UPDATE OF status ON task_graph_steps
WHEN NEW.status = 'running' AND OLD.status IS NOT 'running' AND EXISTS (
  SELECT 1 FROM task_graph_step_slots mine
    JOIN task_graph_step_slots s ON s.slot = mine.slot AND s.step_id != mine.step_id
    JOIN task_graph_steps n ON n.id = s.step_id
   WHERE mine.step_id = NEW.id AND ${HOLDS_SLOT_SQL})
BEGIN
  SELECT RAISE(ABORT, 'slot_held');
END;`);
}

// A queued step of an archived PM keeps its row for unarchive but takes no place in line.
const LIVE_PM_SQL = "NOT EXISTS (SELECT 1 FROM pm_archives a WHERE a.pm_id = g.pm_id)";

const holderOf = (row: SlotStepRow): SlotHolder => ({ graphId: row.graph_id, nodeKey: row.node_key, workerId: row.active_worker_id });

function holderRowOf(db: Db, slot: string): SlotStepRow | undefined {
  return db.get<SlotStepRow>(
    `SELECT s.step_id, n.graph_id, n.node_key, n.active_worker_id FROM task_graph_step_slots s JOIN task_graph_steps n ON n.id = s.step_id
      WHERE s.slot = ? AND ${HOLDS_SLOT_SQL} ORDER BY s.step_id LIMIT 1`,
    slot,
  );
}

/** Postcondition: the step holding `slot` on this daemon, across every project, or null when it is free. */
export function slotHolderOf(db: Db, slot: string): SlotHolder | null {
  const row = holderRowOf(db, slot);
  return row === undefined ? null : holderOf(row);
}

/** Steps waiting for `slot`, first in, first out. */
export function slotWaitersOf(db: Db, slot: string): SlotStepRow[] {
  return db.all<SlotStepRow>(
    `SELECT s.step_id, n.graph_id, n.node_key, n.active_worker_id
       FROM task_graph_step_slots s JOIN task_graph_steps n ON n.id = s.step_id JOIN task_graphs g ON g.id = n.graph_id
      WHERE s.slot = ? AND s.queued_at IS NOT NULL AND n.status = 'pending' AND g.status = 'active' AND ${LIVE_PM_SQL}
      ORDER BY s.queued_at, s.step_id`,
    slot,
  );
}

/**
 * The check every path that starts a step or resumes its Worker shares, so it can refuse before any side effect.
 * Postcondition: null when the step has no slot or nobody else holds it; otherwise the slot and its other holder.
 */
export function slotConflictOf(db: Db, stepId: number): { slot: string; holder: SlotHolder } | null {
  const row = db.get<SlotStepRow & { slot: string }>(
    `SELECT s.step_id, n.graph_id, n.node_key, n.active_worker_id, s.slot
       FROM task_graph_step_slots mine
       JOIN task_graph_step_slots s ON s.slot = mine.slot AND s.step_id != mine.step_id
       JOIN task_graph_steps n ON n.id = s.step_id
      WHERE mine.step_id = ? AND ${HOLDS_SLOT_SQL} ORDER BY s.step_id LIMIT 1`,
    stepId,
  );
  return row === undefined ? null : { slot: row.slot, holder: holderOf(row) };
}

export const stepSlotOf = (db: Db, stepId: number): string | null =>
  db.get<{ slot: string }>("SELECT slot FROM task_graph_step_slots WHERE step_id = ?", stepId)?.slot ?? null;

export function writeStepSlot(db: Db, stepId: number, slot: string | null): void {
  if (slot === null) {
    db.run("DELETE FROM task_graph_step_slots WHERE step_id = ?", stepId);
    return;
  }
  db.run(
    `INSERT INTO task_graph_step_slots (step_id, slot) VALUES (?, ?)
       ON CONFLICT(step_id) DO UPDATE SET slot = excluded.slot,
         queued_at = CASE WHEN task_graph_step_slots.slot = excluded.slot THEN task_graph_step_slots.queued_at END`,
    stepId,
    slot,
  );
}

function admissionOf(db: Db, step: { id: number; graphId: TaskGraphId; nodeKey: TaskNodeKey }, slot: string): SlotAdmission {
  const holder = holderRowOf(db, slot);
  if (holder?.step_id === step.id) return { kind: "admitted" };
  const waiters = slotWaitersOf(db, slot);
  const index = waiters.findIndex((w) => w.step_id === step.id);
  const ahead = index === -1 ? waiters.length : index;
  if (holder === undefined && ahead === 0) return { kind: "admitted" };
  // A free slot with older waiters is drained in the next write, so the oldest waiter stands in as the holder.
  return { kind: "queued", slot, position: ahead + 1, holder: holderOf(holder ?? waiters[0]!) };
}

/**
 * The single admission boundary for automatic dispatch, `worker start --node`, retries, and takeovers.
 * Postcondition: `admitted` when the step has no slot or its slot is free; otherwise `queued` with its first-in,
 * first-out position by the time it became ready.
 */
export function admitStep(db: Db, graphId: TaskGraphId, nodeKey: TaskNodeKey): SlotAdmission {
  const row = db.get<{ id: number; slot: string | null }>(
    `SELECT n.id, s.slot FROM task_graph_steps n LEFT JOIN task_graph_step_slots s ON s.step_id = n.id
      WHERE n.graph_id = ? AND n.node_key = ?`,
    graphId,
    nodeKey,
  );
  if (row === undefined || row.slot === null) return { kind: "admitted" };
  return admissionOf(db, { id: row.id, graphId, nodeKey }, row.slot);
}

/** Precondition: the step is `pending` and ready. Keeps its place when it was already queued. */
export function queueStep(db: Db, stepId: number, t: number): void {
  db.run("UPDATE task_graph_step_slots SET queued_at = ? WHERE step_id = ? AND queued_at IS NULL", t, stepId);
}

/** A step whose upstream reopened is no longer ready, so it gives up its place. */
export function unqueueSteps(db: Db, stepIds: readonly number[]): void {
  if (stepIds.length === 0) return;
  db.run(
    "UPDATE task_graph_step_slots SET queued_at = NULL WHERE queued_at IS NOT NULL AND step_id IN (SELECT value FROM json_each(?))",
    JSON.stringify(stepIds),
  );
}

export interface StepSlotView {
  slot: string;
  queue?: SlotQueue;
}

/** Postcondition: one entry per step that names a slot; `queue` is set only while the step waits for it. */
export function slotViewsOf(db: Db, stepIds: readonly number[]): ReadonlyMap<number, StepSlotView> {
  if (stepIds.length === 0) return new Map();
  const rows = db.all<{ step_id: number; slot: string; queued: number }>(
    `SELECT s.step_id, s.slot, s.queued_at IS NOT NULL AND n.status = 'pending' AS queued
       FROM task_graph_step_slots s JOIN task_graph_steps n ON n.id = s.step_id
      WHERE s.step_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(stepIds),
  );
  const views = new Map<number, StepSlotView>();
  const queues = new Map<string, { holder: SlotStepRow | undefined; waiters: SlotStepRow[] }>();
  for (const row of rows) {
    if (row.queued !== 1) {
      views.set(row.step_id, { slot: row.slot });
      continue;
    }
    let queue = queues.get(row.slot);
    if (queue === undefined) {
      queue = { holder: holderRowOf(db, row.slot), waiters: slotWaitersOf(db, row.slot) };
      queues.set(row.slot, queue);
    }
    const index = queue.waiters.findIndex((w) => w.step_id === row.step_id);
    const shown = queue.holder ?? (index > 0 ? queue.waiters[0] : undefined);
    views.set(row.step_id, index === -1 || shown === undefined
      ? { slot: row.slot }
      : { slot: row.slot, queue: { position: index + 1, holder: holderOf(shown) } });
  }
  return views;
}

/** Postcondition: the slots that have a waiting step and no holder; empty on the common path with one index probe. */
export function freeSlotsWithWaiters(db: Db): string[] {
  const slots = db.all<{ slot: string }>("SELECT DISTINCT slot FROM task_graph_step_slots WHERE queued_at IS NOT NULL ORDER BY slot");
  return slots.map((s) => s.slot).filter((slot) => holderRowOf(db, slot) === undefined && slotWaitersOf(db, slot).length > 0);
}
