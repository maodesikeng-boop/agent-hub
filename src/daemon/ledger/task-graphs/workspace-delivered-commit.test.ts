import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskNodeKey } from "../../../shared/domain.ts";
import { migrate, type Db } from "../../store/index.ts";
import { openTestDb } from "../../store/test-helpers.ts";
import type { TaskGraphDbRow, TaskNodeDbRow } from "./types.ts";
import { resolveWorkspacePlan, upstreamDeliveredCommit, type PlanInput, type StepMaps } from "./workspace.ts";

interface SpecStep {
  key: TaskNodeKey;
  review?: boolean;
  skipped?: boolean;
  base?: string | null;
  status?: "pending" | "running" | "waiting" | "done" | "cancelled";
  workerIds?: number[];
  artifactJson?: string | null;
  deps?: TaskNodeKey[];
}

function makeStepMaps(steps: readonly SpecStep[]): StepMaps {
  const byKey = new Map<TaskNodeKey, TaskNodeDbRow>();
  const incoming = new Map<TaskNodeKey, TaskNodeKey[]>();
  const outgoing = new Map<TaskNodeKey, TaskNodeKey[]>();
  steps.forEach((s, i) => {
    byKey.set(s.key, {
      id: i + 1,
      graph_id: 1,
      node_key: s.key,
      title: s.key,
      brief: `brief for ${s.key}`,
      vendor: null,
      model: null,
      effort: null,
      readonly: 0,
      max_time_ms: null,
      confirm: 0,
      review: s.review ? 1 : 0,
      base: s.base ?? null,
      pm_note: null,
      status: s.status ?? "pending",
      waiting_for: null,
      skipped: s.skipped ? 1 : 0,
      sort_order: i,
      active_worker_id: null,
      worker_ids_json: JSON.stringify(s.workerIds ?? []),
      artifact_json: s.artifactJson ?? null,
      gate_question: null,
      gate_options_json: null,
      gate_summary_md: null,
      gate_recommended: null,
      gate_ask_message_id: null,
      decision_json: null,
      created_at: 1000,
      updated_at: 1000,
    });
    incoming.set(s.key, []);
    outgoing.set(s.key, []);
  });
  for (const s of steps) {
    for (const dep of s.deps ?? []) {
      incoming.get(s.key)!.push(dep);
      if (outgoing.has(dep)) outgoing.get(dep)!.push(s.key);
    }
  }
  return { byKey, incoming, outgoing };
}

const GRAPH_ROW: TaskGraphDbRow = {
  id: 1,
  project_id: 1,
  pm_id: 1,
  conversation_id: 1,
  title: "Graph",
  goal: "Goal",
  status: "active",
  origin_msg_id: null,
  created_at: 1000,
  updated_at: 1000,
  completed_at: null,
};

function seedProject(db: Db): void {
  db.run("INSERT INTO pms (id, name, mode, persona, vendor, created_at) VALUES (1, 'PM', 'manage_only', '', 'claude', 1000)");
  db.run("INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (1, 'pm', 1, 'PM', 1000)");
  db.run("INSERT INTO projects (id, pm_id, conversation_id, name, created_at, updated_at) VALUES (1, 1, 1, 'Proj', 1000, 1000)");
}

function seedWorker(
  db: Db,
  opts: {
    id: number;
    branch: string | null;
    worktreePath: string | null;
    baseCommit: string | null;
    workspace?: "worktree" | "main";
  },
): void {
  const convId = 1000 + opts.id;
  db.run("INSERT INTO conversations (id, kind, pm_id, project_id, title, created_at) VALUES (?, 'worker', 1, 1, ?, 1000)", convId, `w-${opts.id}`);
  db.run(
    `INSERT INTO workers (
       id, project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task,
       readonly, workspace, status, branch, worktree_path, base_commit, created_at, updated_at
     ) VALUES (?, 1, 1, 1, ?, ?, 'task', 0, ?, 'ended', ?, ?, ?, 1000, 1000)`,
    opts.id,
    convId,
    `w-${opts.id}`,
    opts.workspace ?? "worktree",
    opts.branch,
    opts.worktreePath,
    opts.baseCommit,
  );
}

describe("upstreamDeliveredCommit artifact.branch matching", () => {
  let db: Db;
  let tmpRoot: string;

  beforeEach(() => {
    db = openTestDb();
    migrate(db);
    seedProject(db);
    tmpRoot = mkdtempSync(join(tmpdir(), "agent-hub-ws-branch-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const makeDir = (name: string): string => {
    const dir = join(tmpRoot, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const planFor = (maps: StepMaps, key: TaskNodeKey): PlanInput => ({
    graphRow: GRAPH_ROW,
    step: maps.byKey.get(key)!,
    ...maps,
  });

  it("matches artifact.branch when graph done overrides the worker branch for explicit review and reviewed_base fix", () => {
    const wtA = makeDir("wt-a");
    seedWorker(db, { id: 1, branch: "feature/a", worktreePath: wtA, baseCommit: "11111111" });

    const maps = makeStepMaps([
      {
        key: "impl",
        status: "done",
        workerIds: [1],
        artifactJson: JSON.stringify({ branch: "  feature/b  ", commit: "bbbb1111" }),
      },
      { key: "revB", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "revC", review: true, base: "feature/c", status: "done", deps: ["impl"] },
      { key: "revFinal", review: true, base: "feature/b", status: "pending", deps: ["revB", "revC"] },
      { key: "fixB", status: "pending", deps: ["revB"] },
    ]);

    expect(upstreamDeliveredCommit(planFor(maps, "revB"), db)).toBe("bbbb1111");
    expect(upstreamDeliveredCommit(planFor(maps, "revFinal"), db)).toBe("bbbb1111");
    expect(upstreamDeliveredCommit(planFor(maps, "revC"), db)).toBeNull();
    expect(resolveWorkspacePlan(db, planFor(maps, "fixB"))).toEqual({ kind: "fork", baseBranch: "feature/b" });
    expect(upstreamDeliveredCommit(planFor(maps, "fixB"), db)).toBe("bbbb1111");
  });

  it("matches artifact.branch when upstream has no worktree worker (worker === null or workspace === main)", () => {
    seedWorker(db, { id: 2, branch: null, worktreePath: null, baseCommit: null, workspace: "main" });

    const noWorker = makeStepMaps([
      {
        key: "impl",
        status: "done",
        workerIds: [],
        artifactJson: JSON.stringify({ branch: "feature/b", commit: "bbbb2222" }),
      },
      { key: "revB", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "revOther", review: true, base: "feature/other", status: "pending", deps: ["impl"] },
      { key: "fixB", status: "pending", deps: ["revB"] },
      { key: "fixStep", status: "pending", deps: ["impl"] },
    ]);

    expect(upstreamDeliveredCommit(planFor(noWorker, "revB"), db)).toBe("bbbb2222");
    expect(upstreamDeliveredCommit(planFor(noWorker, "revB"))).toBe("bbbb2222");
    expect(upstreamDeliveredCommit(planFor(noWorker, "revOther"), db)).toBeNull();
    expect(resolveWorkspacePlan(db, planFor(noWorker, "fixB"))).toEqual({ kind: "fork", baseBranch: "feature/b" });
    expect(upstreamDeliveredCommit(planFor(noWorker, "fixB"), db)).toBe("bbbb2222");
    expect(resolveWorkspacePlan(db, planFor(noWorker, "fixStep"))).toEqual({ kind: "fresh" });
    expect(upstreamDeliveredCommit(planFor(noWorker, "fixStep"), db)).toBeNull();

    const mainFolderWorker = makeStepMaps([
      {
        key: "impl",
        status: "done",
        workerIds: [2],
        artifactJson: JSON.stringify({ branch: "feature/b", commit: "bbbb3333" }),
      },
      { key: "revB", review: true, base: "feature/b", status: "pending", deps: ["impl"] },
    ]);
    expect(upstreamDeliveredCommit(planFor(mainFolderWorker, "revB"), db)).toBe("bbbb3333");

    const blankArtifactBranch = makeStepMaps([
      {
        key: "impl",
        status: "done",
        workerIds: [],
        artifactJson: JSON.stringify({ branch: "   ", commit: "bbbb4444" }),
      },
      { key: "revB", review: true, base: "feature/b", status: "pending", deps: ["impl"] },
    ]);
    expect(upstreamDeliveredCommit(planFor(blankArtifactBranch, "revB"), db)).toBeNull();
  });

  it("blocks cross-branch commit leakage when artifact.branch points away from the worker branch", () => {
    const wtB = makeDir("wt-b");
    seedWorker(db, { id: 3, branch: "feature/b", worktreePath: wtB, baseCommit: "33333333" });

    const overridden = makeStepMaps([
      {
        key: "impl",
        status: "done",
        workerIds: [3],
        artifactJson: JSON.stringify({ branch: "feature/other", commit: "cccc3333" }),
      },
      { key: "revB", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "revImplicit", review: true, status: "done", deps: ["impl"] },
      { key: "revOther", review: true, base: "feature/other", status: "pending", deps: ["impl"] },
      { key: "fixReviewedBase", status: "pending", deps: ["revB"] },
      { key: "fixStepAndBase", status: "pending", deps: ["revB", "revImplicit"] },
      { key: "fixStep", status: "pending", deps: ["revImplicit"] },
    ]);

    expect(upstreamDeliveredCommit(planFor(overridden, "revB"), db)).toBeNull();
    expect(upstreamDeliveredCommit(planFor(overridden, "revImplicit"), db)).toBeNull();
    expect(upstreamDeliveredCommit(planFor(overridden, "revImplicit"))).toBeNull();
    expect(upstreamDeliveredCommit(planFor(overridden, "fixReviewedBase"), db)).toBeNull();
    expect(upstreamDeliveredCommit(planFor(overridden, "fixStepAndBase"), db)).toBeNull();
    expect(upstreamDeliveredCommit(planFor(overridden, "fixStep"), db)).toBeNull();
    expect(upstreamDeliveredCommit(planFor(overridden, "fixStep"))).toBeNull();
    expect(upstreamDeliveredCommit(planFor(overridden, "revOther"), db)).toBe("cccc3333");
  });

  it("keeps delivered commit when artifact.branch matches the worker branch or is whitespace-only, and isolates step_and_base fresh degradation", () => {
    const wtA = makeDir("wt-a-match");
    seedWorker(db, { id: 4, branch: "feature/a", worktreePath: wtA, baseCommit: "44444444" });

    const matched = makeStepMaps([
      {
        key: "impl",
        status: "done",
        workerIds: [4],
        artifactJson: JSON.stringify({ branch: "feature/a", commit: "aaaa4444" }),
      },
      { key: "rev1", review: true, status: "done", deps: ["impl"] },
      { key: "rev2", review: true, status: "done", deps: ["impl"] },
      { key: "revImplicit", review: true, status: "pending", deps: ["rev1", "rev2"] },
      { key: "fix", status: "pending", deps: ["rev1", "rev2"] },
    ]);
    expect(upstreamDeliveredCommit(planFor(matched, "revImplicit"), db)).toBe("aaaa4444");
    expect(upstreamDeliveredCommit(planFor(matched, "fix"), db)).toBe("aaaa4444");

    const blankFallsBackToWorker = makeStepMaps([
      {
        key: "impl",
        status: "done",
        workerIds: [4],
        artifactJson: JSON.stringify({ branch: "   ", commit: "aaaa5555" }),
      },
      { key: "revA", review: true, base: "feature/a", status: "pending", deps: ["impl"] },
      { key: "revImplicit", review: true, status: "pending", deps: ["impl"] },
      { key: "fix", status: "pending", deps: ["impl"] },
    ]);
    expect(upstreamDeliveredCommit(planFor(blankFallsBackToWorker, "revA"), db)).toBe("aaaa5555");
    expect(upstreamDeliveredCommit(planFor(blankFallsBackToWorker, "revImplicit"), db)).toBe("aaaa5555");
    expect(upstreamDeliveredCommit(planFor(blankFallsBackToWorker, "fix"), db)).toBe("aaaa5555");

    // Mixed explicit(feature/b) + implicit(impl on feature/a) degrades fix to fresh off main even when artifact.branch is feature/b.
    const stepAndBaseFresh = makeStepMaps([
      {
        key: "impl",
        status: "done",
        workerIds: [4],
        artifactJson: JSON.stringify({ branch: "feature/b", commit: "bbbb6666" }),
      },
      { key: "revB", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "revImplicit", review: true, status: "done", deps: ["impl"] },
      { key: "fix", status: "pending", deps: ["revB", "revImplicit"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(stepAndBaseFresh, "fix"))).toEqual({ kind: "fresh" });
    expect(upstreamDeliveredCommit(planFor(stepAndBaseFresh, "fix"), db)).toBeNull();
  });
});
