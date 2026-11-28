import { existsSync } from "node:fs";
import type { TaskNodeKey } from "../../../shared/domain.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import type { Db } from "../../store/index.ts";
import { fail } from "../context.ts";
import { readStoredArtifact, workerIdsOf } from "./rows.ts";
import type { KeyAdjacency, StepWorkspacePlan, TaskGraphDbRow, TaskNodeDbRow } from "./types.ts";

type StepMaps = { byKey: ReadonlyMap<TaskNodeKey, TaskNodeDbRow>; incoming: KeyAdjacency; outgoing: KeyAdjacency };

type UpstreamWorker = { id: number; worktree_path: string | null; branch: string; base_commit: string };

export interface PlanInput {
  graphRow: TaskGraphDbRow;
  step: TaskNodeDbRow;
  byKey: ReadonlyMap<TaskNodeKey, TaskNodeDbRow>;
  incoming: KeyAdjacency;
  outgoing: KeyAdjacency;
}

function latestWorktreeWorker(db: Db, projectId: number, step: TaskNodeDbRow): UpstreamWorker | null {
  const workerIds = workerIdsOf(step);
  for (let i = workerIds.length - 1; i >= 0; i--) {
    const w = db.get<{
      id: number;
      project_id: number;
      workspace: string;
      worktree_path: string | null;
      branch: string | null;
      base_commit: string | null;
    }>("SELECT id, project_id, workspace, worktree_path, branch, base_commit FROM workers WHERE id = ?", workerIds[i]!);
    if (w === undefined || w.workspace !== "worktree" || w.project_id !== projectId || w.base_commit === null || !w.branch) continue;
    return { id: w.id, worktree_path: w.worktree_path, branch: w.branch, base_commit: w.base_commit };
  }
  return null;
}

/** Walks the single-parent chain above a step. */
function* upstreamChain(startKey: TaskNodeKey, maps: StepMaps): Generator<TaskNodeDbRow> {
  const { byKey, incoming } = maps;
  let cur = startKey;
  const seen = new Set<TaskNodeKey>();
  while (true) {
    const ups = incoming.get(cur) ?? [];
    if (ups.length !== 1 || seen.has(ups[0]!)) return;
    cur = ups[0]!;
    seen.add(cur);
    const u = byKey.get(cur);
    if (u === undefined) return;
    yield u;
  }
}

/** Walks up single-parent edges past skipped and review steps to the step whose worktree a new step would reuse. */
function upstreamWorktreeStep(
  startKey: TaskNodeKey,
  maps: StepMaps,
): { step: TaskNodeDbRow; forked: boolean } | null {
  let forked = false;
  for (const u of upstreamChain(startKey, maps)) {
    if ((maps.outgoing.get(u.node_key)?.length ?? 0) > 1) forked = true;
    if (u.skipped === 1 || u.review === 1) continue;
    return { step: u, forked };
  }
  return null;
}

/** A step after a review with an explicit base continues the reviewed branch, not the trunk or an earlier step's own branch. */
function reviewedBaseUpstream(startKey: TaskNodeKey, maps: StepMaps): string | null {
  for (const u of upstreamChain(startKey, maps)) {
    if (u.skipped === 1) continue;
    return u.review === 1 ? u.base : null;
  }
  return null;
}

const REPORTED_COMMIT = /\b[0-9a-f]{7,40}\b/i;

/** The commit the nearest finished non-review upstream step reported delivering. */
export function upstreamDeliveredCommit(input: PlanInput): string | null {
  for (const u of upstreamChain(input.step.node_key, input)) {
    if (u.skipped === 1 || u.review === 1) continue;
    const reported = readStoredArtifact(u.artifact_json).artifact?.commit ?? "";
    return REPORTED_COMMIT.exec(reported)?.[0]?.toLowerCase() ?? null;
  }
  return null;
}

function findUpstreamWorktree(db: Db, input: PlanInput): { worker: UpstreamWorker; forked: boolean } | null {
  const up = upstreamWorktreeStep(input.step.node_key, input);
  if (up === null) return null;
  const worker = latestWorktreeWorker(db, input.graphRow.project_id, up.step);
  return worker === null ? null : { worker, forked: up.forked };
}

/** Upstream worktree a non-review step continues from, or null when it starts from main or a different reviewed branch. */
function continuedUpstreamWorktree(
  db: Db,
  projectId: number,
  step: TaskNodeDbRow,
  maps: StepMaps,
): { step: TaskNodeDbRow; worker: UpstreamWorker; forked: boolean } | null {
  if (step.review === 1 || step.base === "main") return null;
  const up = upstreamWorktreeStep(step.node_key, maps);
  if (up === null) return null;
  const worker = latestWorktreeWorker(db, projectId, up.step);
  if (worker === null) return null;
  const reviewed = reviewedBaseUpstream(step.node_key, maps);
  if (reviewed !== null && worker.branch !== reviewed) return null;
  return { step: up.step, worker, forked: up.forked };
}

const isStepFinished = (step: TaskNodeDbRow): boolean => step.status === "done" || step.status === "cancelled";

/** Whether an active graph may still work in stepKey's worktree: the step is unfinished, or an unfinished downstream step would continue from it. */
export function graphStillUsesStepWorktree(db: Db, projectId: number, maps: StepMaps, stepKey: TaskNodeKey): boolean {
  const step = maps.byKey.get(stepKey);
  if (step === undefined) return false;
  if (!isStepFinished(step)) return true;
  const queue = [...(maps.outgoing.get(stepKey) ?? [])];
  const visited = new Set<TaskNodeKey>();
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const n = maps.byKey.get(key);
    if (n === undefined) continue;
    if (!isStepFinished(n) && continuedUpstreamWorktree(db, projectId, n, maps)?.step.node_key === stepKey) return true;
    queue.push(...(maps.outgoing.get(key) ?? []));
  }
  return false;
}

function resolveReviewPlan(db: Db, input: PlanInput): Extract<StepWorkspacePlan, { kind: "review" }> {
  const { step } = input;
  if (step.base !== null) return { kind: "review", branch: step.base, implWorktreePath: null };
  const up = findUpstreamWorktree(db, input);
  if (up === null) {
    throw fail(
      "invalid",
      `审查步骤「${step.node_key}」找不到被审分支：上一步没有在 worktree 分支上干活的 Worker（比如在主文件夹里干的）。用 ${HUB_COMMAND} graph patch 给它写 "base": "<被审分支>"`,
    );
  }
  return { kind: "review", branch: up.worker.branch, implWorktreePath: up.worker.worktree_path };
}

function chainWorkerIds(step: TaskNodeDbRow, byKey: ReadonlyMap<TaskNodeKey, TaskNodeDbRow>, incoming: KeyAdjacency): Set<number> {
  const ids = new Set<number>(workerIdsOf(step));
  let anc: TaskNodeKey | undefined = step.node_key;
  const visited = new Set<TaskNodeKey>();
  while (anc !== undefined && !visited.has(anc)) {
    visited.add(anc);
    const ancNode = byKey.get(anc);
    if (ancNode !== undefined) for (const id of workerIdsOf(ancNode)) ids.add(id);
    const prevs: readonly TaskNodeKey[] = incoming.get(anc) ?? [];
    anc = prevs.length === 1 ? prevs[0] : undefined;
  }
  return ids;
}

export function resolveWorkspacePlan(db: Db, input: PlanInput): StepWorkspacePlan {
  const { graphRow, step, byKey, incoming } = input;
  if (step.review === 1) return resolveReviewPlan(db, input);
  if (step.base === "main") return { kind: "fresh" };
  const continued = continuedUpstreamWorktree(db, graphRow.project_id, step, input);
  if (continued === null) {
    const reviewed = reviewedBaseUpstream(step.node_key, input);
    return reviewed === null ? { kind: "fresh" } : { kind: "fork", baseBranch: reviewed };
  }
  const w = continued.worker;
  if (!continued.forked && w.worktree_path && existsSync(w.worktree_path)) {
    const chainIds = chainWorkerIds(step, byKey, incoming);
    const otherUsers = db.all<{ id: number }>("SELECT id FROM workers WHERE worktree_path = ?", w.worktree_path);
    if (!otherUsers.some((o) => !chainIds.has(o.id))) {
      return { kind: "inherit", fromWorkerId: w.id, worktreePath: w.worktree_path, branch: w.branch, baseCommit: w.base_commit };
    }
  }
  return { kind: "fork", baseBranch: w.branch };
}

export function findActiveDownstream(
  startKey: TaskNodeKey,
  byKey: ReadonlyMap<TaskNodeKey, TaskNodeDbRow>,
  outgoing: KeyAdjacency,
): TaskNodeKey | null {
  const queue = [...(outgoing.get(startKey) ?? [])];
  const visited = new Set<TaskNodeKey>();
  while (queue.length > 0) {
    const k = queue.shift()!;
    if (visited.has(k)) continue;
    visited.add(k);
    const n = byKey.get(k);
    if (n === undefined) continue;
    if (n.status === "running" || n.active_worker_id !== null) return k;
    queue.push(...(outgoing.get(k) ?? []));
  }
  return null;
}
