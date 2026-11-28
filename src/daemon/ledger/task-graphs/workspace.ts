// Invariant: Workspace lineage is derived purely from Task Graph edges and step flags (review, skipped, base);
// review and skipped steps are pass-through nodes that never create or contest a mutable worktree.
import { existsSync } from "node:fs";
import type { TaskNodeKey } from "../../../shared/domain.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import type { Db } from "../../store/index.ts";
import { fail } from "../context.ts";
import { readStoredArtifact, workerIdsOf } from "./rows.ts";
import type { KeyAdjacency, StepWorkspacePlan, TaskGraphDbRow, TaskNodeDbRow } from "./types.ts";

export type StepMaps = { byKey: ReadonlyMap<TaskNodeKey, TaskNodeDbRow>; incoming: KeyAdjacency; outgoing: KeyAdjacency };

export interface LineageNode {
  readonly node_key: TaskNodeKey;
  readonly review: number;
  readonly skipped: number;
  readonly base: string | null;
}

export type LineageMaps = {
  byKey: ReadonlyMap<TaskNodeKey, LineageNode>;
  incoming: KeyAdjacency;
  outgoing: KeyAdjacency;
};

export type CodeStepRef =
  | { kind: "none" }
  | { kind: "one"; stepKey: TaskNodeKey }
  | { kind: "many" };

export type StepUpstreamLineage =
  | { kind: "empty" }
  | { kind: "step"; stepKey: TaskNodeKey }
  | { kind: "reviewed_base"; branch: string; sourceStep: CodeStepRef }
  | { kind: "step_and_base"; stepKey: TaskNodeKey; branch: string }
  | { kind: "conflict" };

type ReviewedBaseRef =
  | { kind: "none" }
  | { kind: "implicit" }
  | { kind: "explicit"; branch: string }
  | { kind: "mixed"; branch: string }
  | { kind: "conflict" };

interface InternalLineage {
  readonly codeStep: CodeStepRef;
  readonly reviewedBase: ReviewedBaseRef;
}

const EMPTY_INTERNAL: InternalLineage = { codeStep: { kind: "none" }, reviewedBase: { kind: "none" } };

const isTransparentStep = (node: LineageNode): boolean => node.skipped === 1 || node.review === 1;

function meetCodeStepRef(a: CodeStepRef, b: CodeStepRef): CodeStepRef {
  if (a.kind === "none") return b;
  if (b.kind === "none") return a;
  if (a.kind === "one" && b.kind === "one" && a.stepKey === b.stepKey) return a;
  return { kind: "many" };
}

function meetReviewedBase(a: ReviewedBaseRef, b: ReviewedBaseRef): ReviewedBaseRef {
  if (a.kind === "none") return b;
  if (b.kind === "none") return a;
  if (a.kind === "conflict" || b.kind === "conflict") return { kind: "conflict" };
  if (a.kind === "implicit") {
    return b.kind === "implicit" ? a : { kind: "mixed", branch: b.branch };
  }
  if (b.kind === "implicit") return { kind: "mixed", branch: a.branch };
  if (a.branch !== b.branch) return { kind: "conflict" };
  return a.kind === "mixed" || b.kind === "mixed" ? { kind: "mixed", branch: a.branch } : a;
}

function toStepUpstreamLineage(internal: InternalLineage): StepUpstreamLineage {
  const { codeStep, reviewedBase } = internal;
  if (reviewedBase.kind === "conflict") return { kind: "conflict" };
  if (reviewedBase.kind === "explicit") {
    return { kind: "reviewed_base", branch: reviewedBase.branch, sourceStep: codeStep };
  }
  if (reviewedBase.kind === "mixed") {
    return codeStep.kind === "one"
      ? { kind: "step_and_base", stepKey: codeStep.stepKey, branch: reviewedBase.branch }
      : { kind: "conflict" };
  }
  if (codeStep.kind === "none") return { kind: "empty" };
  if (codeStep.kind === "one") return { kind: "step", stepKey: codeStep.stepKey };
  return { kind: "conflict" };
}

// Keep upstream code step and immediate explicit review base orthogonal so an implicit review never inherits an earlier review's explicit base.
function resolveInternalMemo(
  stepKey: TaskNodeKey,
  maps: LineageMaps,
  memo: Map<TaskNodeKey, InternalLineage>,
  visiting = new Set<TaskNodeKey>(),
): InternalLineage {
  const cached = memo.get(stepKey);
  if (cached !== undefined) return cached;
  if (visiting.has(stepKey)) return EMPTY_INTERNAL;
  visiting.add(stepKey);
  let acc: InternalLineage = EMPTY_INTERNAL;
  for (const depKey of maps.incoming.get(stepKey) ?? []) {
    if (acc.codeStep.kind === "many" && acc.reviewedBase.kind === "conflict") break;
    const dep = maps.byKey.get(depKey);
    if (dep === undefined) continue;
    let edge: InternalLineage;
    if (dep.skipped === 1) {
      edge = resolveInternalMemo(dep.node_key, maps, memo, visiting);
    } else if (dep.review === 0) {
      edge = { codeStep: { kind: "one", stepKey: dep.node_key }, reviewedBase: { kind: "implicit" } };
    } else {
      const up = resolveInternalMemo(dep.node_key, maps, memo, visiting);
      edge =
        dep.base !== null
          ? { codeStep: up.codeStep, reviewedBase: { kind: "explicit", branch: dep.base } }
          : { codeStep: up.codeStep, reviewedBase: up.codeStep.kind === "none" ? up.reviewedBase : { kind: "implicit" } };
    }
    acc = {
      codeStep: meetCodeStepRef(acc.codeStep, edge.codeStep),
      reviewedBase: meetReviewedBase(acc.reviewedBase, edge.reviewedBase),
    };
  }
  visiting.delete(stepKey);
  memo.set(stepKey, acc);
  return acc;
}

type ReviewTargetRef =
  | { kind: "none" }
  | { kind: "step"; stepKey: TaskNodeKey }
  | { kind: "branch"; branch: string }
  | { kind: "conflict" };

export function resolveImplicitReviewTarget(stepKey: TaskNodeKey, maps: LineageMaps): ReviewTargetRef {
  const internal = resolveInternalMemo(stepKey, maps, new Map());
  if (internal.codeStep.kind === "one") return { kind: "step", stepKey: internal.codeStep.stepKey };
  if (internal.codeStep.kind === "many") return { kind: "conflict" };
  if (internal.reviewedBase.kind === "explicit") return { kind: "branch", branch: internal.reviewedBase.branch };
  if (internal.reviewedBase.kind === "conflict") return { kind: "conflict" };
  return { kind: "none" };
}

/**
 * Precondition: maps describes a Task Graph's step roles and adjacency lists (may contain dangling keys or cycles).
 * Postcondition: resolves stepKey's upstream workspace lineage across arbitrary DAG fan-out/fan-in diamonds,
 * passing through review and skipped steps and merging incoming paths as a commutative, associative meet-semilattice.
 */
export function resolveStepLineage(stepKey: TaskNodeKey, maps: LineageMaps): StepUpstreamLineage {
  return toStepUpstreamLineage(resolveInternalMemo(stepKey, maps, new Map()));
}

/**
 * Precondition: maps.byKey maps known node keys to step rows.
 * Postcondition: returns the union of workerIdsOf for stepKey and every DAG ancestor reachable via maps.incoming,
 * terminating safely if maps.incoming contains a cycle.
 */
export function collectAncestorWorkerIds(
  stepKey: TaskNodeKey,
  maps: Pick<StepMaps, "byKey" | "incoming">,
): Set<number> {
  const ids = new Set<number>();
  const visited = new Set<TaskNodeKey>();
  const stack: TaskNodeKey[] = [stepKey];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = maps.byKey.get(key);
    if (node !== undefined) {
      for (const id of workerIdsOf(node)) ids.add(id);
    }
    for (const prev of maps.incoming.get(key) ?? []) {
      if (!visited.has(prev)) stack.push(prev);
    }
  }
  return ids;
}

function isStepWorktreeContestedMemo(
  db: Db,
  projectId: number,
  stepKey: TaskNodeKey,
  maps: StepMaps,
  memo: Map<TaskNodeKey, InternalLineage>,
): boolean {
  const queue = [...(maps.outgoing.get(stepKey) ?? [])];
  const visited = new Set<TaskNodeKey>([stepKey]);
  let continuers = 0;
  let head = 0;
  while (head < queue.length) {
    const key = queue[head++]!;
    if (visited.has(key)) continue;
    visited.add(key);
    const n = maps.byKey.get(key);
    if (n === undefined) continue;
    if (isTransparentStep(n)) {
      for (const next of maps.outgoing.get(key) ?? []) {
        if (!visited.has(next)) queue.push(next);
      }
      continue;
    }
    if (continuedWorktreeTarget(db, projectId, n, maps, memo)?.step.node_key === stepKey) {
      continuers++;
      if (continuers > 1) return true;
    }
  }
  return false;
}

/**
 * Precondition: stepKey identifies a non-review, non-skipped code step in maps.
 * Postcondition: returns true iff two or more distinct non-review, non-skipped downstream steps (excluding base === "main")
 * resolve to continue stepKey's worktree; parallel review and base === "main" branches do not contest stepKey's worktree.
 */
export function isStepWorktreeContested(db: Db, projectId: number, stepKey: TaskNodeKey, maps: StepMaps): boolean {
  return isStepWorktreeContestedMemo(db, projectId, stepKey, maps, new Map());
}

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

const REPORTED_COMMIT = /\b[0-9a-f]{7,40}\b/i;

function readWorkspaceDelivery(step: TaskNodeDbRow): { branch: string | null; commit: string | null } {
  const { artifact } = readStoredArtifact(step.artifact_json);
  return {
    branch: artifact?.branch?.trim() || null,
    commit: REPORTED_COMMIT.exec(artifact?.commit ?? "")?.[0]?.toLowerCase() ?? null,
  };
}

function deliveredCommitForTarget(
  step: TaskNodeDbRow | undefined,
  targetBranch: string | null,
  projectId: number,
  db?: Db,
): string | null {
  if (step === undefined) return null;
  const { branch, commit } = readWorkspaceDelivery(step);
  if (targetBranch !== null) {
    const deliveredBranch = branch ?? (db === undefined ? null : latestWorktreeWorker(db, projectId, step)?.branch ?? null);
    return deliveredBranch === targetBranch ? commit : null;
  }
  if (db === undefined) {
    return branch === null ? commit : null;
  }
  const worker = latestWorktreeWorker(db, projectId, step);
  if (worker === null) return null;
  return (branch ?? worker.branch) === worker.branch ? commit : null;
}

export function upstreamDeliveredCommit(input: PlanInput, db?: Db): string | null {
  const { graphRow, step } = input;
  const internal = resolveInternalMemo(step.node_key, input, new Map());
  if (step.review === 1) {
    if (internal.codeStep.kind !== "one") return null;
    return deliveredCommitForTarget(input.byKey.get(internal.codeStep.stepKey), step.base, graphRow.project_id, db);
  }
  if (step.base === "main") return null;
  const lineage = toStepUpstreamLineage(internal);
  if (lineage.kind === "step") {
    return deliveredCommitForTarget(input.byKey.get(lineage.stepKey), null, graphRow.project_id, db);
  }
  if (lineage.kind === "step_and_base") {
    if (db === undefined) return null;
    const u = input.byKey.get(lineage.stepKey);
    if (u === undefined) return null;
    const worker = latestWorktreeWorker(db, graphRow.project_id, u);
    if (worker === null || worker.branch !== lineage.branch) return null;
    const { branch, commit } = readWorkspaceDelivery(u);
    return (branch ?? worker.branch) === lineage.branch ? commit : null;
  }
  if (lineage.kind === "reviewed_base" && lineage.sourceStep.kind === "one") {
    return deliveredCommitForTarget(input.byKey.get(lineage.sourceStep.stepKey), lineage.branch, graphRow.project_id, db);
  }
  return null;
}

function continuedWorktreeTarget(
  db: Db,
  projectId: number,
  step: TaskNodeDbRow,
  maps: StepMaps,
  memo: Map<TaskNodeKey, InternalLineage>,
): { step: TaskNodeDbRow; worker: UpstreamWorker } | null {
  if (step.review === 1 || step.skipped === 1 || step.base === "main") return null;
  const lineage = toStepUpstreamLineage(resolveInternalMemo(step.node_key, maps, memo));
  let stepKey: TaskNodeKey | null = null;
  let requiredBranch: string | null = null;
  if (lineage.kind === "step") {
    stepKey = lineage.stepKey;
  } else if (lineage.kind === "reviewed_base" && lineage.sourceStep.kind === "one") {
    stepKey = lineage.sourceStep.stepKey;
    requiredBranch = lineage.branch;
  } else if (lineage.kind === "step_and_base") {
    stepKey = lineage.stepKey;
    requiredBranch = lineage.branch;
  }
  if (stepKey === null) return null;
  const upStep = maps.byKey.get(stepKey);
  if (upStep === undefined) return null;
  const worker = latestWorktreeWorker(db, projectId, upStep);
  if (worker === null) return null;
  if (requiredBranch !== null && worker.branch !== requiredBranch) return null;
  return { step: upStep, worker };
}

function reviewedWorktreeStepKey(
  db: Db,
  projectId: number,
  reviewStep: TaskNodeDbRow,
  maps: StepMaps,
  memo: Map<TaskNodeKey, InternalLineage>,
): TaskNodeKey | null {
  const codeStep = resolveInternalMemo(reviewStep.node_key, maps, memo).codeStep;
  if (codeStep.kind !== "one") return null;
  const upStep = maps.byKey.get(codeStep.stepKey);
  const worker = upStep === undefined ? null : latestWorktreeWorker(db, projectId, upStep);
  if (worker === null) return null;
  if (reviewStep.base !== null && worker.branch !== reviewStep.base) return null;
  return upStep!.node_key;
}

const isStepFinished = (step: TaskNodeDbRow): boolean => step.status === "done" || step.status === "cancelled";

export function graphStillUsesStepWorktree(db: Db, projectId: number, maps: StepMaps, stepKey: TaskNodeKey): boolean {
  const step = maps.byKey.get(stepKey);
  if (step === undefined) return false;
  if (!isStepFinished(step)) return true;
  const memo = new Map<TaskNodeKey, InternalLineage>();
  const queue = [...(maps.outgoing.get(stepKey) ?? [])];
  const visited = new Set<TaskNodeKey>([stepKey]);
  let head = 0;
  while (head < queue.length) {
    const key = queue[head++]!;
    if (visited.has(key)) continue;
    visited.add(key);
    const n = maps.byKey.get(key);
    if (n === undefined) continue;
    if (!isStepFinished(n)) {
      if (n.review === 1) {
        if (reviewedWorktreeStepKey(db, projectId, n, maps, memo) === stepKey) return true;
      } else if (continuedWorktreeTarget(db, projectId, n, maps, memo)?.step.node_key === stepKey) {
        return true;
      }
    }
    for (const next of maps.outgoing.get(key) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return false;
}

function resolveReviewPlan(db: Db, input: PlanInput): Extract<StepWorkspacePlan, { kind: "review" }> {
  const { graphRow, step } = input;
  if (step.base !== null) return { kind: "review", branch: step.base, implWorktreePath: null };
  const target = resolveImplicitReviewTarget(step.node_key, input);
  if (target.kind === "branch") return { kind: "review", branch: target.branch, implWorktreePath: null };
  const upStep = target.kind === "step" ? input.byKey.get(target.stepKey) : undefined;
  const worker = upStep === undefined ? null : latestWorktreeWorker(db, graphRow.project_id, upStep);
  if (worker === null) {
    throw fail(
      "invalid",
      `审查步骤「${step.node_key}」找不到被审分支：上一步没有在 worktree 分支上干活的 Worker（比如在主文件夹里干的）。用 ${HUB_COMMAND} graph patch 给它写 "base": "<被审分支>"`,
    );
  }
  return { kind: "review", branch: worker.branch, implWorktreePath: worker.worktree_path };
}

export function resolveWorkspacePlan(db: Db, input: PlanInput): StepWorkspacePlan {
  const { graphRow, step } = input;
  if (step.review === 1) return resolveReviewPlan(db, input);
  if (step.base === "main") return { kind: "fresh" };
  const memo = new Map<TaskNodeKey, InternalLineage>();
  const lineage = toStepUpstreamLineage(resolveInternalMemo(step.node_key, input, memo));
  const continued = continuedWorktreeTarget(db, graphRow.project_id, step, input, memo);
  if (continued === null) {
    return lineage.kind === "reviewed_base" ? { kind: "fork", baseBranch: lineage.branch } : { kind: "fresh" };
  }
  const { step: upStep, worker: w } = continued;
  const contested = isStepWorktreeContestedMemo(db, graphRow.project_id, upStep.node_key, input, memo);
  if (!contested && w.worktree_path && existsSync(w.worktree_path)) {
    const ancestorIds = collectAncestorWorkerIds(step.node_key, input);
    const otherUsers = db.all<{ id: number }>("SELECT id FROM workers WHERE worktree_path = ?", w.worktree_path);
    if (!otherUsers.some((o) => !ancestorIds.has(o.id))) {
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
