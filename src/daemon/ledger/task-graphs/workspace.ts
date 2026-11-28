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

const isTransparentStep = (node: LineageNode): boolean => node.skipped === 1 || node.review === 1;

function meetCodeStepRef(a: CodeStepRef, b: CodeStepRef): CodeStepRef {
  if (a.kind === "none") return b;
  if (b.kind === "none") return a;
  if (a.kind === "one" && b.kind === "one" && a.stepKey === b.stepKey) return a;
  return { kind: "many" };
}

function codeStepRefOf(lineage: StepUpstreamLineage): CodeStepRef {
  if (lineage.kind === "empty") return { kind: "none" };
  if (lineage.kind === "step" || lineage.kind === "step_and_base") return { kind: "one", stepKey: lineage.stepKey };
  if (lineage.kind === "reviewed_base") return lineage.sourceStep;
  return { kind: "many" };
}

function meetStepWithReviewedBase(
  stepKey: TaskNodeKey,
  branch: string,
  sourceStep: CodeStepRef,
): StepUpstreamLineage {
  if (sourceStep.kind === "none" || (sourceStep.kind === "one" && sourceStep.stepKey === stepKey)) {
    return { kind: "step_and_base", stepKey, branch };
  }
  return { kind: "conflict" };
}

function meetLineage(a: StepUpstreamLineage, b: StepUpstreamLineage): StepUpstreamLineage {
  if (a.kind === "empty") return b;
  if (b.kind === "empty") return a;
  if (a.kind === "conflict" || b.kind === "conflict") return { kind: "conflict" };

  if (a.kind === "step") {
    if (b.kind === "step") return a.stepKey === b.stepKey ? a : { kind: "conflict" };
    if (b.kind === "reviewed_base") return meetStepWithReviewedBase(a.stepKey, b.branch, b.sourceStep);
    return a.stepKey === b.stepKey ? b : { kind: "conflict" };
  }

  if (a.kind === "reviewed_base") {
    if (b.kind === "step") return meetStepWithReviewedBase(b.stepKey, a.branch, a.sourceStep);
    if (b.kind === "reviewed_base") {
      if (a.branch !== b.branch) return { kind: "conflict" };
      return { kind: "reviewed_base", branch: a.branch, sourceStep: meetCodeStepRef(a.sourceStep, b.sourceStep) };
    }
    if (a.branch !== b.branch) return { kind: "conflict" };
    return meetStepWithReviewedBase(b.stepKey, b.branch, a.sourceStep);
  }

  if (b.kind === "step") return a.stepKey === b.stepKey ? a : { kind: "conflict" };
  if (b.kind === "reviewed_base") {
    if (a.branch !== b.branch) return { kind: "conflict" };
    return meetStepWithReviewedBase(a.stepKey, a.branch, b.sourceStep);
  }
  return a.stepKey === b.stepKey && a.branch === b.branch ? a : { kind: "conflict" };
}

function resolveStepLineageMemo(
  stepKey: TaskNodeKey,
  maps: LineageMaps,
  memo: Map<TaskNodeKey, StepUpstreamLineage>,
  visiting = new Set<TaskNodeKey>(),
): StepUpstreamLineage {
  const cached = memo.get(stepKey);
  if (cached !== undefined) return cached;
  if (visiting.has(stepKey)) return { kind: "empty" };
  visiting.add(stepKey);
  let acc: StepUpstreamLineage = { kind: "empty" };
  for (const depKey of maps.incoming.get(stepKey) ?? []) {
    if (acc.kind === "conflict") break;
    const dep = maps.byKey.get(depKey);
    if (dep === undefined) continue;
    let edgeLineage: StepUpstreamLineage;
    if (!isTransparentStep(dep)) {
      edgeLineage = { kind: "step", stepKey: dep.node_key };
    } else {
      const up = resolveStepLineageMemo(dep.node_key, maps, memo, visiting);
      edgeLineage =
        dep.skipped === 0 && dep.base !== null
          ? { kind: "reviewed_base", branch: dep.base, sourceStep: codeStepRefOf(up) }
          : up;
    }
    acc = meetLineage(acc, edgeLineage);
  }
  visiting.delete(stepKey);
  memo.set(stepKey, acc);
  return acc;
}

/**
 * Precondition: maps describes a Task Graph's step roles and adjacency lists (may contain dangling keys or cycles).
 * Postcondition: resolves stepKey's upstream workspace lineage across arbitrary DAG fan-out/fan-in diamonds,
 * passing through review and skipped steps and merging incoming paths as a commutative, associative meet-semilattice.
 */
export function resolveStepLineage(stepKey: TaskNodeKey, maps: LineageMaps): StepUpstreamLineage {
  return resolveStepLineageMemo(stepKey, maps, new Map());
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
  memo: Map<TaskNodeKey, StepUpstreamLineage>,
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

export function upstreamDeliveredCommit(input: PlanInput): string | null {
  const lineage = resolveStepLineage(input.step.node_key, input);
  const stepKey =
    lineage.kind === "step" || lineage.kind === "step_and_base"
      ? lineage.stepKey
      : lineage.kind === "reviewed_base" && lineage.sourceStep.kind === "one"
        ? lineage.sourceStep.stepKey
        : null;
  if (stepKey === null) return null;
  const u = input.byKey.get(stepKey);
  if (u === undefined) return null;
  const reported = readStoredArtifact(u.artifact_json).artifact?.commit ?? "";
  return REPORTED_COMMIT.exec(reported)?.[0]?.toLowerCase() ?? null;
}

function continuedWorktreeTarget(
  db: Db,
  projectId: number,
  step: TaskNodeDbRow,
  maps: StepMaps,
  memo: Map<TaskNodeKey, StepUpstreamLineage>,
): { step: TaskNodeDbRow; worker: UpstreamWorker } | null {
  if (step.review === 1 || step.skipped === 1 || step.base === "main") return null;
  const lineage = resolveStepLineageMemo(step.node_key, maps, memo);
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

function resolveReviewedTarget(
  db: Db,
  projectId: number,
  lineage: StepUpstreamLineage,
  maps: StepMaps,
): { branch: string; implWorktreePath: string | null; stepKey: TaskNodeKey | null } | null {
  if (lineage.kind === "step") {
    const upStep = maps.byKey.get(lineage.stepKey);
    const worker = upStep === undefined ? null : latestWorktreeWorker(db, projectId, upStep);
    return worker === null ? null : { branch: worker.branch, implWorktreePath: worker.worktree_path, stepKey: upStep!.node_key };
  }
  if (lineage.kind === "reviewed_base") {
    if (lineage.sourceStep.kind === "one") {
      const upStep = maps.byKey.get(lineage.sourceStep.stepKey);
      const worker = upStep === undefined ? null : latestWorktreeWorker(db, projectId, upStep);
      if (worker !== null && worker.branch === lineage.branch) {
        return { branch: lineage.branch, implWorktreePath: worker.worktree_path, stepKey: upStep!.node_key };
      }
    }
    return { branch: lineage.branch, implWorktreePath: null, stepKey: null };
  }
  if (lineage.kind === "step_and_base") {
    const upStep = maps.byKey.get(lineage.stepKey);
    const worker = upStep === undefined ? null : latestWorktreeWorker(db, projectId, upStep);
    if (worker === null || worker.branch !== lineage.branch) return null;
    return { branch: lineage.branch, implWorktreePath: worker.worktree_path, stepKey: upStep!.node_key };
  }
  return null;
}

function reviewedWorktreeStepKey(
  db: Db,
  projectId: number,
  reviewStep: TaskNodeDbRow,
  maps: StepMaps,
  memo: Map<TaskNodeKey, StepUpstreamLineage>,
): TaskNodeKey | null {
  const lineage = resolveStepLineageMemo(reviewStep.node_key, maps, memo);
  const effectiveLineage: StepUpstreamLineage =
    reviewStep.base === null
      ? lineage
      : { kind: "reviewed_base", branch: reviewStep.base, sourceStep: codeStepRefOf(lineage) };
  return resolveReviewedTarget(db, projectId, effectiveLineage, maps)?.stepKey ?? null;
}

const isStepFinished = (step: TaskNodeDbRow): boolean => step.status === "done" || step.status === "cancelled";

export function graphStillUsesStepWorktree(db: Db, projectId: number, maps: StepMaps, stepKey: TaskNodeKey): boolean {
  const step = maps.byKey.get(stepKey);
  if (step === undefined) return false;
  if (!isStepFinished(step)) return true;
  const memo = new Map<TaskNodeKey, StepUpstreamLineage>();
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
  const resolved = resolveReviewedTarget(db, graphRow.project_id, resolveStepLineage(step.node_key, input), input);
  if (resolved === null) {
    throw fail(
      "invalid",
      `审查步骤「${step.node_key}」找不到被审分支：上一步没有在 worktree 分支上干活的 Worker（比如在主文件夹里干的）。用 ${HUB_COMMAND} graph patch 给它写 "base": "<被审分支>"`,
    );
  }
  return { kind: "review", branch: resolved.branch, implWorktreePath: resolved.implWorktreePath };
}

export function resolveWorkspacePlan(db: Db, input: PlanInput): StepWorkspacePlan {
  const { graphRow, step } = input;
  if (step.review === 1) return resolveReviewPlan(db, input);
  if (step.base === "main") return { kind: "fresh" };
  const memo = new Map<TaskNodeKey, StepUpstreamLineage>();
  const lineage = resolveStepLineageMemo(step.node_key, input, memo);
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
