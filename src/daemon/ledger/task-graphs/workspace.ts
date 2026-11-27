import { existsSync } from "node:fs";
import type { TaskGraphId, TaskNodeKey } from "../../../shared/domain.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import type { Db } from "../../store/index.ts";
import { fail } from "../context.ts";
import { readStoredArtifact, workerIdsOf } from "./rows.ts";
import { buildGraphMaps } from "./store.ts";
import type { KeyAdjacency, StepWorkspacePlan, TaskGraphDbRow, TaskNodeDbRow } from "./types.ts";

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

function findUpstreamWorktree(db: Db, input: PlanInput): { worker: UpstreamWorker; forked: boolean } | null {
  const { graphRow, step, byKey, incoming, outgoing } = input;
  let cur = step.node_key;
  let forked = false;
  const seen = new Set<TaskNodeKey>();
  while (true) {
    const ups = incoming.get(cur) ?? [];
    if (ups.length !== 1) return null;
    const uKey = ups[0]!;
    if (seen.has(uKey)) return null;
    seen.add(uKey);
    if ((outgoing.get(uKey)?.length ?? 0) > 1) forked = true;
    const u = byKey.get(uKey);
    if (u === undefined) return null;
    if (u.skipped === 1 || u.review === 1) {
      cur = uKey;
      continue;
    }
    const worker = latestWorktreeWorker(db, graphRow.project_id, u);
    return worker === null ? null : { worker, forked };
  }
}

/** Walks the single-parent chain above a step, passing through skipped and review steps. */
function* upstreamChain(input: PlanInput): Generator<TaskNodeDbRow> {
  const { step, byKey, incoming } = input;
  let cur = step.node_key;
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

/** A step after a review with an explicit base continues the reviewed branch, not the trunk. */
function reviewedBaseUpstream(input: PlanInput): string | null {
  for (const u of upstreamChain(input)) {
    if (u.skipped === 1) continue;
    return u.review === 1 ? u.base : null;
  }
  return null;
}

const REPORTED_COMMIT = /\b[0-9a-f]{7,40}\b/i;

/** The commit the nearest finished non-review upstream step reported delivering. */
export function upstreamDeliveredCommit(input: PlanInput): string | null {
  for (const u of upstreamChain(input)) {
    if (u.skipped === 1 || u.review === 1) continue;
    const reported = readStoredArtifact(u.artifact_json).artifact?.commit ?? "";
    return REPORTED_COMMIT.exec(reported)?.[0]?.toLowerCase() ?? null;
  }
  return null;
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
  const { step, byKey, incoming } = input;
  if (step.review === 1) return resolveReviewPlan(db, input);
  if (step.base === "main") return { kind: "fresh" };
  const up = findUpstreamWorktree(db, input);
  if (up === null) {
    const reviewed = reviewedBaseUpstream(input);
    return reviewed === null ? { kind: "fresh" } : { kind: "fork", baseBranch: reviewed };
  }
  const w = up.worker;
  if (!up.forked && w.worktree_path && existsSync(w.worktree_path)) {
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

export function sameVendorReviewHint(db: Db, graphId: TaskGraphId, pmVendor: string): string {
  const { nodeRows, byKey, incoming } = buildGraphMaps(db, graphId);
  const hints: string[] = [];
  for (const n of nodeRows) {
    if (n.review !== 1 || n.status === "done") continue;
    const myVendor = n.vendor ?? pmVendor;
    const sameUp = (incoming.get(n.node_key) ?? []).find((uk) => {
      const u = byKey.get(uk);
      return u !== undefined && (u.vendor ?? pmVendor) === myVendor;
    });
    if (sameUp !== undefined) hints.push(`提醒：审查步骤「${n.node_key}」和上游「${sameUp}」是同一家模型（${myVendor}）。`);
  }
  return hints.length > 0 ? `\n${hints.join(" ")}` : "";
}
