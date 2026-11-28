import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskNodeKey, WorkerId } from "../../../shared/domain.ts";
import { migrate, type Db } from "../../store/index.ts";
import { openTestDb } from "../../store/test-helpers.ts";
import { createResolveFolder } from "../files.ts";
import { createLedger } from "../index.ts";
import { assertReviewStepsHaveTarget } from "./spec.ts";
import type { TaskGraphDbRow, TaskNodeDbRow } from "./types.ts";
import {
  collectAncestorWorkerIds,
  graphStillUsesStepWorktree,
  isStepWorktreeContested,
  resolveStepLineage,
  resolveWorkspacePlan,
  upstreamDeliveredCommit,
  type CodeStepRef,
  type LineageMaps,
  type LineageNode,
  type PlanInput,
  type StepMaps,
  type StepUpstreamLineage,
} from "./workspace.ts";

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

function makeLineageMaps(steps: readonly SpecStep[]): LineageMaps {
  const byKey = new Map<TaskNodeKey, LineageNode>();
  const incoming = new Map<TaskNodeKey, TaskNodeKey[]>();
  const outgoing = new Map<TaskNodeKey, TaskNodeKey[]>();
  for (const s of steps) {
    byKey.set(s.key, {
      node_key: s.key,
      review: s.review ? 1 : 0,
      skipped: s.skipped ? 1 : 0,
      base: s.base ?? null,
    });
    incoming.set(s.key, []);
    outgoing.set(s.key, []);
  }
  for (const s of steps) {
    for (const dep of s.deps ?? []) {
      incoming.get(s.key)!.push(dep);
      if (outgoing.has(dep)) outgoing.get(dep)!.push(s.key);
    }
  }
  return { byKey, incoming, outgoing };
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

function seedProject(db: Db): { pmId: number; projectId: number; pmConvId: number } {
  db.run("INSERT INTO pms (id, name, mode, persona, vendor, created_at) VALUES (1, 'PM', 'manage_only', '', 'claude', 1000)");
  db.run("INSERT INTO conversations (id, kind, pm_id, title, created_at) VALUES (1, 'pm', 1, 'PM', 1000)");
  db.run("INSERT INTO projects (id, pm_id, conversation_id, name, created_at, updated_at) VALUES (1, 1, 1, 'Proj', 1000, 1000)");
  return { pmId: 1, projectId: 1, pmConvId: 1 };
}

function seedWorker(
  db: Db,
  opts: {
    id: number;
    branch: string | null;
    worktreePath: string | null;
    baseCommit: string | null;
    workspace?: "worktree" | "main";
    status?: "open" | "ended";
  },
): void {
  const convId = 1000 + opts.id;
  db.run("INSERT INTO conversations (id, kind, pm_id, project_id, title, created_at) VALUES (?, 'worker', 1, 1, ?, 1000)", convId, `w-${opts.id}`);
  db.run(
    `INSERT INTO workers (
       id, project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task,
       readonly, workspace, status, branch, worktree_path, base_commit, created_at, updated_at
     ) VALUES (?, 1, 1, 1, ?, ?, 'task', 0, ?, ?, ?, ?, ?, 1000, 1000)`,
    opts.id,
    convId,
    `w-${opts.id}`,
    opts.workspace ?? "worktree",
    opts.status ?? "ended",
    opts.branch,
    opts.worktreePath,
    opts.baseCommit,
  );
}

describe("DAG workspace lineage contract (new behavior, fails before implementation)", () => {
  let db: Db;
  let tmpRoot: string;

  beforeEach(() => {
    db = openTestDb();
    migrate(db);
    seedProject(db);
    tmpRoot = mkdtempSync(join(tmpdir(), "agent-hub-ws-unit-"));
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

  it("S1: resolveStepLineage converges 2-way, 3-way, asymmetric, skipped, and redundant-edge review diamonds to the single upstream code step", () => {
    const twoWay = makeLineageMaps([
      { key: "impl" },
      { key: "rev1", review: true, deps: ["impl"] },
      { key: "rev2", review: true, deps: ["impl"] },
      { key: "fix1", deps: ["rev1", "rev2"] },
    ]);
    expect(resolveStepLineage("fix1", twoWay)).toEqual<StepUpstreamLineage>({ kind: "step", stepKey: "impl" });

    const threeWay = makeLineageMaps([
      { key: "impl" },
      { key: "rev1", review: true, deps: ["impl"] },
      { key: "rev2", review: true, deps: ["impl"] },
      { key: "rev3", review: true, deps: ["impl"] },
      { key: "fix1", deps: ["rev1", "rev2", "rev3"] },
    ]);
    expect(resolveStepLineage("fix1", threeWay)).toEqual<StepUpstreamLineage>({ kind: "step", stepKey: "impl" });

    const asymmetric = makeLineageMaps([
      { key: "impl" },
      { key: "rev1", review: true, deps: ["impl"] },
      { key: "rev1b", review: true, deps: ["rev1"] },
      { key: "rev2", review: true, skipped: true, deps: ["impl"] },
      { key: "skipRoot", skipped: true },
      { key: "fix1", deps: ["rev1b", "rev2", "skipRoot"] },
    ]);
    expect(resolveStepLineage("fix1", asymmetric)).toEqual<StepUpstreamLineage>({ kind: "step", stepKey: "impl" });

    const redundantEdge = makeLineageMaps([
      { key: "impl" },
      { key: "rev1", review: true, deps: ["impl"] },
      { key: "fix1", deps: ["impl", "rev1"] },
    ]);
    expect(resolveStepLineage("fix1", redundantEdge)).toEqual<StepUpstreamLineage>({ kind: "step", stepKey: "impl" });
  });

  it("S4: resolveStepLineage merges explicit review bases as an associative meet-semilattice and detects conflicts", () => {
    const sameBaseStandalone = makeLineageMaps([
      { key: "rev1", review: true, base: "hub/7-pr" },
      { key: "rev2", review: true, base: "hub/7-pr" },
      { key: "fix", deps: ["rev1", "rev2"] },
    ]);
    expect(resolveStepLineage("fix", sameBaseStandalone)).toEqual<StepUpstreamLineage>({
      kind: "reviewed_base",
      branch: "hub/7-pr",
      sourceStep: { kind: "none" } satisfies CodeStepRef,
    });

    const sameBaseWithImpl = makeLineageMaps([
      { key: "impl" },
      { key: "rev1", review: true, base: "hub/7-pr", deps: ["impl"] },
      { key: "rev2", review: true, base: "hub/7-pr", deps: ["impl"] },
      { key: "fix", deps: ["rev1", "rev2"] },
    ]);
    expect(resolveStepLineage("fix", sameBaseWithImpl)).toEqual<StepUpstreamLineage>({
      kind: "reviewed_base",
      branch: "hub/7-pr",
      sourceStep: { kind: "one", stepKey: "impl" },
    });

    const sameBaseTwoImpls = makeLineageMaps([
      { key: "a" },
      { key: "b" },
      { key: "rev1", review: true, base: "hub/7-pr", deps: ["a"] },
      { key: "rev2", review: true, base: "hub/7-pr", deps: ["b"] },
      { key: "rev3", review: true, base: "hub/7-pr", deps: ["a"] },
      { key: "fix", deps: ["rev1", "rev2", "rev3"] },
    ]);
    expect(resolveStepLineage("fix", sameBaseTwoImpls)).toEqual<StepUpstreamLineage>({
      kind: "reviewed_base",
      branch: "hub/7-pr",
      sourceStep: { kind: "many" },
    });

    const mixedImplicitAndExplicit = makeLineageMaps([
      { key: "impl" },
      { key: "rev1", review: true, deps: ["impl"] },
      { key: "rev2", review: true, base: "hub/7-pr", deps: ["impl"] },
      { key: "fix", deps: ["rev1", "rev2"] },
    ]);
    expect(resolveStepLineage("fix", mixedImplicitAndExplicit)).toEqual<StepUpstreamLineage>({
      kind: "step_and_base",
      stepKey: "impl",
      branch: "hub/7-pr",
    });

    const conflictingBases = makeLineageMaps([
      { key: "rev1", review: true, base: "branch-a" },
      { key: "rev2", review: true, base: "branch-b" },
      { key: "fix", deps: ["rev1", "rev2"] },
    ]);
    expect(resolveStepLineage("fix", conflictingBases)).toEqual<StepUpstreamLineage>({ kind: "conflict" });

    const twoImpls = makeLineageMaps([
      { key: "a" },
      { key: "b" },
      { key: "revA", review: true, deps: ["a"] },
      { key: "revB", review: true, deps: ["b"] },
      { key: "merge", deps: ["revA", "revB"] },
    ]);
    expect(resolveStepLineage("merge", twoImpls)).toEqual<StepUpstreamLineage>({ kind: "conflict" });

    const rootOnly = makeLineageMaps([{ key: "solo" }]);
    expect(resolveStepLineage("solo", rootOnly)).toEqual<StepUpstreamLineage>({ kind: "empty" });
  });

  it("S2: collectAncestorWorkerIds traverses multi-round parallel review diamonds and terminates on cycles", () => {
    const maps = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1a", review: true, status: "done", workerIds: [2], deps: ["impl"] },
      { key: "rev1b", review: true, status: "done", workerIds: [3], deps: ["impl"] },
      { key: "fix1", status: "done", workerIds: [4], deps: ["rev1a", "rev1b"] },
      { key: "rev2a", review: true, status: "done", workerIds: [5], deps: ["fix1"] },
      { key: "rev2b", review: true, status: "done", workerIds: [6], deps: ["fix1"] },
      { key: "fix2", status: "pending", workerIds: [7], deps: ["rev2a", "rev2b"] },
    ]);
    expect(collectAncestorWorkerIds("fix2", maps)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));

    const cyclic = makeStepMaps([
      { key: "a", workerIds: [10], deps: ["b"] },
      { key: "b", workerIds: [11], deps: ["a"] },
    ]);
    expect(collectAncestorWorkerIds("a", cyclic)).toEqual(new Set([10, 11]));
  });

  it("S1/S5: isStepWorktreeContested distinguishes parallel reviews and base=main from true competing code continuers", () => {
    const wt = makeDir("wt1");
    seedWorker(db, { id: 1, branch: "hub/1-impl", worktreePath: wt, baseCommit: "aaaa1111" });

    const reviewDiamond = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1", review: true, status: "done", deps: ["impl"] },
      { key: "rev2", review: true, status: "done", deps: ["impl"] },
      { key: "fix1", status: "pending", deps: ["rev1", "rev2"] },
    ]);
    expect(isStepWorktreeContested(db, 1, "impl", reviewDiamond)).toBe(false);

    const siblingMain = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "cont", status: "pending", deps: ["impl"] },
      { key: "nextPr", base: "main", status: "pending", deps: ["impl"] },
    ]);
    expect(isStepWorktreeContested(db, 1, "impl", siblingMain)).toBe(false);

    const directFork = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "fork1", status: "pending", deps: ["impl"] },
      { key: "fork2", status: "pending", deps: ["impl"] },
    ]);
    expect(isStepWorktreeContested(db, 1, "impl", directFork)).toBe(true);

    const reviewPlusSiblingCode = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev", review: true, status: "done", deps: ["impl"] },
      { key: "fix", status: "pending", deps: ["rev"] },
      { key: "other", status: "pending", deps: ["impl"] },
    ]);
    expect(isStepWorktreeContested(db, 1, "impl", reviewPlusSiblingCode)).toBe(true);

    const twoFixesAfterTwoReviews = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1", review: true, status: "done", deps: ["impl"] },
      { key: "rev2", review: true, status: "done", deps: ["impl"] },
      { key: "fix1", status: "pending", deps: ["rev1"] },
      { key: "fix2", status: "pending", deps: ["rev2"] },
    ]);
    expect(isStepWorktreeContested(db, 1, "impl", twoFixesAfterTwoReviews)).toBe(true);
  });

  it("S1/S2/S3: resolveWorkspacePlan, upstreamDeliveredCommit, and graphStillUsesStepWorktree work across multi-round parallel reviews", () => {
    const wt = makeDir("wt-diamond");
    seedWorker(db, { id: 1, branch: "hub/1-impl", worktreePath: wt, baseCommit: "11111111" });

    const round1 = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1], artifactJson: JSON.stringify({ commit: "abcdef123456" }) },
      { key: "rev1a", review: true, status: "done", deps: ["impl"] },
      { key: "rev1b", review: true, status: "done", deps: ["impl"] },
      { key: "fix1", status: "pending", deps: ["rev1a", "rev1b"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(round1, "fix1"))).toEqual({
      kind: "inherit",
      fromWorkerId: 1,
      worktreePath: wt,
      branch: "hub/1-impl",
      baseCommit: "11111111",
    });
    expect(upstreamDeliveredCommit(planFor(round1, "fix1"))).toBe("abcdef123456");
    expect(graphStillUsesStepWorktree(db, 1, round1, "impl")).toBe(true);

    seedWorker(db, { id: 4, branch: "hub/1-impl", worktreePath: wt, baseCommit: "11111111" });
    const round2 = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1], artifactJson: JSON.stringify({ commit: "abcdef123456" }) },
      { key: "rev1a", review: true, status: "done", deps: ["impl"] },
      { key: "rev1b", review: true, status: "done", deps: ["impl"] },
      { key: "fix1", status: "done", workerIds: [4], artifactJson: JSON.stringify({ commit: "fedcba987654" }), deps: ["rev1a", "rev1b"] },
      { key: "rev2a", review: true, status: "done", deps: ["fix1"] },
      { key: "rev2b", review: true, status: "done", deps: ["fix1"] },
      { key: "fix2", status: "pending", deps: ["rev2a", "rev2b"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(round2, "fix2"))).toEqual({
      kind: "inherit",
      fromWorkerId: 4,
      worktreePath: wt,
      branch: "hub/1-impl",
      baseCommit: "11111111",
    });
    expect(upstreamDeliveredCommit(planFor(round2, "fix2"))).toBe("fedcba987654");
    expect(graphStillUsesStepWorktree(db, 1, round2, "fix1")).toBe(true);
  });

  it("S3: graphStillUsesStepWorktree holds impl while parallel reviews are still unfinished before a fix step is patched in", () => {
    const wt = makeDir("wt-hold");
    seedWorker(db, { id: 1, branch: "hub/1-impl", worktreePath: wt, baseCommit: "11111111" });
    const maps = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1", review: true, status: "waiting", deps: ["impl"] },
      { key: "rev2", review: true, status: "running", deps: ["impl"] },
    ]);
    expect(graphStillUsesStepWorktree(db, 1, maps, "impl")).toBe(true);
  });

  it("S4: assertReviewStepsHaveTarget accepts review-after-parallel-reviews and matching reviewed bases", () => {
    expect(() =>
      assertReviewStepsHaveTarget(
        [
          { key: "impl", review: 0, base: null, status: "done", skipped: 0 },
          { key: "rev1", review: 1, base: null, status: "done", skipped: 0 },
          { key: "rev2", review: 1, base: null, status: "done", skipped: 0 },
          { key: "rev3", review: 1, base: null, status: "pending", skipped: 0 },
        ],
        [
          { fromKey: "impl", toKey: "rev1" },
          { fromKey: "impl", toKey: "rev2" },
          { fromKey: "rev1", toKey: "rev3" },
          { fromKey: "rev2", toKey: "rev3" },
        ],
      ),
    ).not.toThrow();

    expect(() =>
      assertReviewStepsHaveTarget(
        [
          { key: "rev1", review: 1, base: "hub/7-pr", status: "done", skipped: 0 },
          { key: "rev2", review: 1, base: "hub/7-pr", status: "done", skipped: 0 },
          { key: "rev3", review: 1, base: null, status: "pending", skipped: 0 },
        ],
        [
          { fromKey: "rev1", toKey: "rev3" },
          { fromKey: "rev2", toKey: "rev3" },
        ],
      ),
    ).not.toThrow();

    expect(() =>
      assertReviewStepsHaveTarget(
        [
          { key: "rev1", review: 1, base: "hub/7-pr", status: "done", skipped: 0 },
          { key: "rev2", review: 1, base: "hub/8-pr", status: "done", skipped: 0 },
          { key: "rev3", review: 1, base: null, status: "pending", skipped: 0 },
        ],
        [
          { fromKey: "rev1", toKey: "rev3" },
          { fromKey: "rev2", toKey: "rev3" },
        ],
      ),
    ).toThrow(/被审分支/);

    expect(() =>
      assertReviewStepsHaveTarget(
        [
          { key: "a", review: 0, base: null, status: "done", skipped: 0 },
          { key: "b", review: 0, base: null, status: "done", skipped: 0 },
          { key: "rev1", review: 1, base: "hub/7-pr", status: "done", skipped: 0 },
          { key: "rev2", review: 1, base: "hub/7-pr", status: "done", skipped: 0 },
          { key: "rev3", review: 1, base: null, status: "pending", skipped: 0 },
        ],
        [
          { fromKey: "a", toKey: "rev1" },
          { fromKey: "b", toKey: "rev2" },
          { fromKey: "rev1", toKey: "rev3" },
          { fromKey: "rev2", toKey: "rev3" },
        ],
      ),
    ).toThrow(/被审分支/);
  });

  it("S9: handles one-month volume (300 Workers, 30,000 messages, 50,000 step logs) and a 15-round consecutive review diamond without exponential blowup", () => {
    const wtScale = makeDir("wt-scale");
    const steps: SpecStep[] = [{ key: "s0", status: "done", workerIds: [1], artifactJson: JSON.stringify({ commit: "0000aaaa" }) }];
    let prev: TaskNodeKey = "s0";
    for (let r = 1; r <= 15; r++) {
      const ra = `r${r}a`;
      const rb = `r${r}b`;
      const next = `s${r}`;
      steps.push(
        { key: ra, review: true, status: "done", deps: [prev] },
        { key: rb, review: true, status: "done", deps: [prev] },
        { key: next, review: true, status: "done", deps: [ra, rb] },
      );
      prev = next;
    }
    steps.push({ key: "finalFix", status: "pending", deps: [prev] });

    db.exec("BEGIN");
    for (let i = 1; i <= 300; i++) {
      seedWorker(db, {
        id: i,
        branch: i === 1 ? "hub/1-impl" : `hub/${i}-old`,
        worktreePath: i === 1 ? wtScale : join(tmpRoot, `gone-${i}`),
        baseCommit: "11111111",
        status: "ended",
      });
    }
    db.exec(`
      WITH RECURSIVE cnt(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM cnt WHERE x < 30000)
      INSERT INTO messages (conversation_id, sender, kind, text, status, dedupe_key, created_at, updated_at)
      SELECT 1001, 'agent', 'text', 'm', 'replied', 'scale-msg:' || x, 1000, 1000 FROM cnt;
    `);
    db.run(
      "INSERT INTO agent_sessions (id, conversation_id, role, worker_id, generation, vendor, vendor_session_id, cwd, add_dirs, status, created_at, updated_at) VALUES (1, 1001, 'worker', 1, 1, 'claude', 'w-1', '/tmp', '[]', 'ended', 1000, 1000)",
    );
    db.exec(`
      WITH RECURSIVE cnt(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM cnt WHERE x < 50000)
      INSERT INTO session_steps (session_id, kind, at, summary)
      SELECT 1, 'tool', 1000, 's' FROM cnt;
    `);
    db.run(
      "INSERT INTO task_graphs (id, project_id, pm_id, conversation_id, title, goal, status, created_at, updated_at) VALUES (1, 1, 1, 1, 'Scale', 'Scale', 'active', 1000, 1000)",
    );
    steps.forEach((s, i) => {
      db.run(
        `INSERT INTO task_graph_steps (
           id, graph_id, node_key, title, brief, review, skipped, base, status, sort_order,
           worker_ids_json, artifact_json, created_at, updated_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1000, 1000)`,
        i + 1,
        s.key,
        s.key,
        `brief ${s.key}`,
        s.review ? 1 : 0,
        s.skipped ? 1 : 0,
        s.base ?? null,
        s.status ?? "pending",
        i,
        JSON.stringify(s.workerIds ?? []),
        s.artifactJson ?? null,
      );
    });
    for (const s of steps) {
      for (const dep of s.deps ?? []) {
        db.run("INSERT INTO task_graph_edges (graph_id, from_key, to_key) VALUES (1, ?, ?)", dep, s.key);
      }
    }
    db.exec("COMMIT");

    const countLookups = <K, V>(source: ReadonlyMap<K, V>) => {
      let reads = 0;
      const map = new Proxy(source, {
        get(target, prop) {
          if (prop === "get") {
            return (key: K) => {
              reads++;
              return target.get(key);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return {
        map,
        take: () => {
          const n = reads;
          reads = 0;
          return n;
        },
      };
    };

    const rawMaps = makeStepMaps(steps);
    const incomingCounter = countLookups(rawMaps.incoming);
    const outgoingCounter = countLookups(rawMaps.outgoing);
    const maps: StepMaps = { byKey: rawMaps.byKey, incoming: incomingCounter.map, outgoing: outgoingCounter.map };

    expect(resolveStepLineage("finalFix", maps)).toEqual<StepUpstreamLineage>({ kind: "step", stepKey: "s0" });
    expect(incomingCounter.take()).toBeLessThanOrEqual(steps.length);
    expect(outgoingCounter.take()).toBe(0);

    expect(resolveWorkspacePlan(db, planFor(maps, "finalFix"))).toEqual({
      kind: "inherit",
      fromWorkerId: 1,
      worktreePath: wtScale,
      branch: "hub/1-impl",
      baseCommit: "11111111",
    });
    expect(incomingCounter.take()).toBeLessThanOrEqual(steps.length * 2);
    expect(outgoingCounter.take()).toBeLessThanOrEqual(steps.length);

    expect(upstreamDeliveredCommit(planFor(maps, "finalFix"))).toBe("0000aaaa");
    expect(incomingCounter.take()).toBeLessThanOrEqual(steps.length);
    expect(outgoingCounter.take()).toBe(0);

    expect(collectAncestorWorkerIds("finalFix", maps)).toEqual(new Set([1]));
    expect(incomingCounter.take()).toBeLessThanOrEqual(steps.length);
    expect(outgoingCounter.take()).toBe(0);

    expect(graphStillUsesStepWorktree(db, 1, maps, "s0")).toBe(true);
    expect(incomingCounter.take()).toBeLessThanOrEqual(steps.length);
    expect(outgoingCounter.take()).toBeLessThanOrEqual(steps.length);

    const dataHome = join(tmpRoot, "scale-data");
    for (const d of ["pm-home", "worktrees", "state/launch", "state/logs/setup"]) {
      mkdirSync(join(dataHome, d), { recursive: true });
    }
    const ledger = createLedger(db, {
      now: () => 2000,
      pmHomeRoot: join(dataHome, "pm-home"),
      dataHome,
      worktreesDir: join(dataHome, "worktrees"),
      launchDir: join(dataHome, "state", "launch"),
      setupLogsDir: join(dataHome, "state", "logs", "setup"),
      userHome: tmpRoot,
      osSandboxed: () => true,
      models: { current: () => null, availability: () => "available" },
      resolveFolder: createResolveFolder({ dataHome, userHome: tmpRoot }),
    });
    try {
      expect(ledger.isWorkerCleanable(1 as WorkerId)).toBe(false);
      db.run("UPDATE task_graph_steps SET status = 'done' WHERE graph_id = 1 AND node_key = 'finalFix'");
      expect(ledger.isWorkerCleanable(1 as WorkerId)).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("S10: tolerates malformed artifact_json, dangling edges, synthetic cycles, missing base_commit, and unrelated worktree users", () => {
    const wt = makeDir("wt-dirty");
    seedWorker(db, { id: 1, branch: "hub/1-impl", worktreePath: wt, baseCommit: "11111111" });
    seedWorker(db, { id: 99, branch: "hub/99-external", worktreePath: wt, baseCommit: "22222222" });

    const dirtyMaps = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1], artifactJson: "{not-json" },
      { key: "rev1", review: true, status: "done", deps: ["impl", "missing-node"] },
      { key: "rev2", review: true, status: "done", deps: ["impl"] },
      { key: "fix1", status: "pending", deps: ["rev1", "rev2"] },
    ]);
    expect(resolveStepLineage("fix1", dirtyMaps)).toEqual<StepUpstreamLineage>({ kind: "step", stepKey: "impl" });
    expect(upstreamDeliveredCommit(planFor(dirtyMaps, "fix1"))).toBeNull();
    // External worker #99 is not an ancestor of fix1, so resolveWorkspacePlan must safely degrade to fork rather than inherit.
    expect(resolveWorkspacePlan(db, planFor(dirtyMaps, "fix1"))).toEqual({ kind: "fork", baseBranch: "hub/1-impl" });

    const cyclic = makeLineageMaps([
      { key: "r1", review: true, deps: ["r2"] },
      { key: "r2", review: true, deps: ["r1"] },
      { key: "fix", deps: ["r1"] },
    ]);
    expect(resolveStepLineage("fix", cyclic)).toEqual<StepUpstreamLineage>({ kind: "empty" });
  });

  it("serial explicit review followed by implicit review does not leak explicit base into review2, fix, or cleanup hold", () => {
    const wt = makeDir("wt-serial-base");
    seedWorker(db, { id: 1, branch: "feature/a", worktreePath: wt, baseCommit: "11111111" });

    const serial = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1], artifactJson: JSON.stringify({ commit: "abcdef1234" }) },
      { key: "rev1", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "rev2", review: true, status: "done", deps: ["rev1"] },
      { key: "fix", status: "pending", deps: ["rev2"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(serial, "rev2"))).toEqual({
      kind: "review",
      branch: "feature/a",
      implWorktreePath: wt,
    });
    expect(resolveStepLineage("fix", serial)).toEqual<StepUpstreamLineage>({ kind: "step", stepKey: "impl" });
    expect(resolveWorkspacePlan(db, planFor(serial, "fix"))).toEqual({
      kind: "inherit",
      fromWorkerId: 1,
      worktreePath: wt,
      branch: "feature/a",
      baseCommit: "11111111",
    });
    expect(graphStillUsesStepWorktree(db, 1, serial, "impl")).toBe(true);
    expect(upstreamDeliveredCommit(planFor(serial, "fix"))).toBe("abcdef1234");

    const holdingDuringReview2 = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "rev2", review: true, status: "running", deps: ["rev1"] },
    ]);
    expect(graphStillUsesStepWorktree(db, 1, holdingDuringReview2, "impl")).toBe(true);
  });

  it("handles all serial and parallel explicit/implicit review base combinations consistently", () => {
    const wtA = makeDir("wt-comb-a");
    const wtB = makeDir("wt-comb-b");
    seedWorker(db, { id: 1, branch: "feature/a", worktreePath: wtA, baseCommit: "11111111" });
    seedWorker(db, { id: 2, branch: "feature/b", worktreePath: wtB, baseCommit: "22222222" });

    // Skipped step after explicit review keeps explicit base; skipped explicit review does not.
    const explicitThenSkipped = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1], artifactJson: JSON.stringify({ commit: "abcdef1234" }) },
      { key: "rev1", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "skip", skipped: true, status: "done", deps: ["rev1"] },
      { key: "fix", status: "pending", deps: ["skip"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(explicitThenSkipped, "fix"))).toEqual({ kind: "fork", baseBranch: "feature/b" });
    expect(graphStillUsesStepWorktree(db, 1, explicitThenSkipped, "impl")).toBe(false);
    expect(upstreamDeliveredCommit(planFor(explicitThenSkipped, "fix"), db)).toBeNull();

    const explicitMatchingThenSkipped = makeStepMaps([
      { key: "impl", status: "done", workerIds: [2], artifactJson: JSON.stringify({ commit: "abcdef1234" }) },
      { key: "rev1", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "skip", skipped: true, status: "done", deps: ["rev1"] },
      { key: "fix", status: "pending", deps: ["skip"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(explicitMatchingThenSkipped, "fix"))).toMatchObject({ kind: "inherit", branch: "feature/b", worktreePath: wtB });
    expect(upstreamDeliveredCommit(planFor(explicitMatchingThenSkipped, "fix"), db)).toBe("abcdef1234");

    const skippedExplicit = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1", review: true, skipped: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "fix", status: "pending", deps: ["rev1"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(skippedExplicit, "fix"))).toMatchObject({ kind: "inherit", branch: "feature/a", worktreePath: wtA });
    expect(graphStillUsesStepWorktree(db, 1, skippedExplicit, "impl")).toBe(true);

    // Explicit -> implicit -> skipped -> fix still inherits impl.
    const explicitImplicitSkipped = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "rev2", review: true, status: "done", deps: ["rev1"] },
      { key: "skip", skipped: true, status: "done", deps: ["rev2"] },
      { key: "fix", status: "pending", deps: ["skip"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(explicitImplicitSkipped, "fix"))).toMatchObject({ kind: "inherit", branch: "feature/a", worktreePath: wtA });
    expect(graphStillUsesStepWorktree(db, 1, explicitImplicitSkipped, "impl")).toBe(true);

    // Explicit -> later explicit overrides base (different branch forks and releases; matching branch inherits and holds).
    const explicitOverrideFork = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "rev2", review: true, base: "feature/c", status: "done", deps: ["rev1"] },
      { key: "fix", status: "pending", deps: ["rev2"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(explicitOverrideFork, "rev2"))).toEqual({ kind: "review", branch: "feature/c", implWorktreePath: null });
    expect(resolveWorkspacePlan(db, planFor(explicitOverrideFork, "fix"))).toEqual({ kind: "fork", baseBranch: "feature/c" });
    expect(graphStillUsesStepWorktree(db, 1, explicitOverrideFork, "impl")).toBe(false);

    const explicitOverrideMatch = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "rev2", review: true, base: "feature/a", status: "done", deps: ["rev1"] },
      { key: "fix", status: "pending", deps: ["rev2"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(explicitOverrideMatch, "fix"))).toMatchObject({ kind: "inherit", branch: "feature/a", worktreePath: wtA });
    expect(graphStillUsesStepWorktree(db, 1, explicitOverrideMatch, "impl")).toBe(true);

    // Parallel explicit reviews converging into an implicit review still target the single upstream code step.
    const parallelExplicitToImplicit = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "rev2", review: true, base: "feature/c", status: "done", deps: ["impl"] },
      { key: "rev3", review: true, status: "done", deps: ["rev1", "rev2"] },
      { key: "fix", status: "pending", deps: ["rev3"] },
    ]);
    expect(() =>
      assertReviewStepsHaveTarget(
        [
          { key: "impl", review: 0, base: null, status: "done", skipped: 0 },
          { key: "rev1", review: 1, base: "feature/b", status: "done", skipped: 0 },
          { key: "rev2", review: 1, base: "feature/c", status: "done", skipped: 0 },
          { key: "rev3", review: 1, base: null, status: "pending", skipped: 0 },
        ],
        [
          { fromKey: "impl", toKey: "rev1" },
          { fromKey: "impl", toKey: "rev2" },
          { fromKey: "rev1", toKey: "rev3" },
          { fromKey: "rev2", toKey: "rev3" },
        ],
      ),
    ).not.toThrow();
    expect(resolveWorkspacePlan(db, planFor(parallelExplicitToImplicit, "rev3"))).toEqual({
      kind: "review",
      branch: "feature/a",
      implWorktreePath: wtA,
    });
    expect(resolveWorkspacePlan(db, planFor(parallelExplicitToImplicit, "fix"))).toMatchObject({ kind: "inherit", branch: "feature/a", worktreePath: wtA });
    expect(graphStillUsesStepWorktree(db, 1, parallelExplicitToImplicit, "impl")).toBe(true);

    // Parallel mixed explicit + implicit directly feeding fix: branch mismatch -> fresh & release; branch match -> inherit & hold.
    const mixedMismatch = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "rev2", review: true, status: "done", deps: ["impl"] },
      { key: "fix", status: "pending", deps: ["rev1", "rev2"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(mixedMismatch, "fix"))).toEqual({ kind: "fresh" });
    expect(graphStillUsesStepWorktree(db, 1, mixedMismatch, "impl")).toBe(false);

    const mixedMatch = makeStepMaps([
      { key: "impl", status: "done", workerIds: [2] },
      { key: "rev1", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "rev2", review: true, status: "done", deps: ["impl"] },
      { key: "fix", status: "pending", deps: ["rev1", "rev2"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(mixedMatch, "fix"))).toMatchObject({ kind: "inherit", branch: "feature/b", worktreePath: wtB });
    expect(graphStillUsesStepWorktree(db, 1, mixedMatch, "impl")).toBe(true);

    // Asymmetric parallel chain: [rev1(base: b) -> rev1b(implicit), rev2(implicit)] -> fix inherits impl.
    const asymmetricReset = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "rev1b", review: true, status: "done", deps: ["rev1"] },
      { key: "rev2", review: true, status: "done", deps: ["impl"] },
      { key: "fix", status: "pending", deps: ["rev1b", "rev2"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(asymmetricReset, "rev1b"))).toEqual({ kind: "review", branch: "feature/a", implWorktreePath: wtA });
    expect(resolveWorkspacePlan(db, planFor(asymmetricReset, "fix"))).toMatchObject({ kind: "inherit", branch: "feature/a", worktreePath: wtA });
    expect(graphStillUsesStepWorktree(db, 1, asymmetricReset, "impl")).toBe(true);

    // Standalone explicit reviews without any upstream code step pass their unanimous target branch to follow-up implicit reviews and fixes.
    expect(() =>
      assertReviewStepsHaveTarget(
        [
          { key: "rev1", review: 1, base: "feature/b", status: "done", skipped: 0 },
          { key: "rev2", review: 1, base: null, status: "pending", skipped: 0 },
        ],
        [{ fromKey: "rev1", toKey: "rev2" }],
      ),
    ).not.toThrow();
    const standaloneChain = makeStepMaps([
      { key: "rev1", review: true, base: "feature/b", status: "done" },
      { key: "rev2", review: true, base: "feature/b", status: "done" },
      { key: "rev3", review: true, status: "done", deps: ["rev1", "rev2"] },
      { key: "rev4", review: true, status: "done", deps: ["rev3"] },
      { key: "fix", status: "pending", deps: ["rev4"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(standaloneChain, "rev3"))).toEqual({
      kind: "review",
      branch: "feature/b",
      implWorktreePath: null,
    });
    expect(resolveWorkspacePlan(db, planFor(standaloneChain, "rev4"))).toEqual({
      kind: "review",
      branch: "feature/b",
      implWorktreePath: null,
    });
    expect(resolveWorkspacePlan(db, planFor(standaloneChain, "fix"))).toEqual({
      kind: "fork",
      baseBranch: "feature/b",
    });
    expect(upstreamDeliveredCommit(planFor(standaloneChain, "rev3"), db)).toBeNull();

    const standaloneConflict = makeStepMaps([
      { key: "rev1", review: true, base: "feature/b", status: "done" },
      { key: "rev2", review: true, base: "feature/c", status: "done" },
      { key: "rev3", review: true, status: "pending", deps: ["rev1", "rev2"] },
    ]);
    expect(() => resolveWorkspacePlan(db, planFor(standaloneConflict, "rev3"))).toThrow(/找不到被审分支/);

    // Explicit branch reviews must only receive upstreamDeliveredCommit when the upstream delivery branch matches the target branch.
    const explicitMismatchFanIn = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1], artifactJson: JSON.stringify({ commit: "aaaa1111" }) },
      { key: "rev1", review: true, base: "feature/b", status: "done", deps: ["impl"] },
      { key: "rev2", review: true, base: "feature/c", status: "done", deps: ["impl"] },
      { key: "rev3", review: true, base: "feature/b", status: "pending", deps: ["rev1", "rev2"] },
      { key: "revImplicit", review: true, status: "pending", deps: ["rev1", "rev2"] },
    ]);
    expect(upstreamDeliveredCommit(planFor(explicitMismatchFanIn, "rev1"), db)).toBeNull();
    expect(upstreamDeliveredCommit(planFor(explicitMismatchFanIn, "rev3"), db)).toBeNull();
    expect(upstreamDeliveredCommit(planFor(explicitMismatchFanIn, "revImplicit"), db)).toBe("aaaa1111");

    const explicitMatchFanIn = makeStepMaps([
      { key: "impl", status: "done", workerIds: [2], artifactJson: JSON.stringify({ commit: "bbbb2222" }) },
      { key: "rev1", review: true, base: "feature/a", status: "done", deps: ["impl"] },
      { key: "rev2", review: true, base: "feature/c", status: "done", deps: ["impl"] },
      { key: "rev3", review: true, base: "feature/b", status: "pending", deps: ["rev1", "rev2"] },
    ]);
    expect(upstreamDeliveredCommit(planFor(explicitMatchFanIn, "rev3"), db)).toBe("bbbb2222");
  });
});

describe("Unchanged workspace boundaries (regression baseline, passes before and after implementation)", () => {
  let db: Db;
  let tmpRoot: string;

  beforeEach(() => {
    db = openTestDb();
    migrate(db);
    seedProject(db);
    tmpRoot = mkdtempSync(join(tmpdir(), "agent-hub-ws-reg-"));
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

  it("S5: single linear chain impl -> followup inherits worktree and branch", () => {
    const wt = makeDir("wt-linear");
    seedWorker(db, { id: 1, branch: "hub/1-impl", worktreePath: wt, baseCommit: "11111111" });
    const maps = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1], artifactJson: JSON.stringify({ commit: "1234abcd" }) },
      { key: "followup", status: "pending", deps: ["impl"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(maps, "followup"))).toEqual({
      kind: "inherit",
      fromWorkerId: 1,
      worktreePath: wt,
      branch: "hub/1-impl",
      baseCommit: "11111111",
    });
    expect(upstreamDeliveredCommit(planFor(maps, "followup"))).toBe("1234abcd");
  });

  it("S5: explicit base=main on a fan-in step starts fresh and does not hold upstream worktree", () => {
    const wt = makeDir("wt-main");
    seedWorker(db, { id: 1, branch: "hub/1-impl", worktreePath: wt, baseCommit: "11111111" });
    const maps = makeStepMaps([
      { key: "impl", status: "done", workerIds: [1] },
      { key: "rev1", review: true, status: "done", deps: ["impl"] },
      { key: "rev2", review: true, status: "done", deps: ["impl"] },
      { key: "nextPr", base: "main", status: "pending", deps: ["rev1", "rev2"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(maps, "nextPr"))).toEqual({ kind: "fresh" });
    expect(graphStillUsesStepWorktree(db, 1, maps, "impl")).toBe(false);
  });

  it("S5: true parallel multi-implementation fan-in starts fresh without mis-inheriting either branch", () => {
    const wtA = makeDir("wt-a");
    const wtB = makeDir("wt-b");
    seedWorker(db, { id: 1, branch: "hub/1-a", worktreePath: wtA, baseCommit: "11111111" });
    seedWorker(db, { id: 2, branch: "hub/2-b", worktreePath: wtB, baseCommit: "22222222" });

    const directFanIn = makeStepMaps([
      { key: "a", status: "done", workerIds: [1] },
      { key: "b", status: "done", workerIds: [2] },
      { key: "merge", status: "pending", deps: ["a", "b"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(directFanIn, "merge"))).toEqual({ kind: "fresh" });

    const reviewedFanIn = makeStepMaps([
      { key: "a", status: "done", workerIds: [1] },
      { key: "b", status: "done", workerIds: [2] },
      { key: "revA", review: true, status: "done", deps: ["a"] },
      { key: "revB", review: true, status: "done", deps: ["b"] },
      { key: "merge", status: "pending", deps: ["revA", "revB"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(reviewedFanIn, "merge"))).toEqual({ kind: "fresh" });
  });

  it("S5: true parallel code fork root -> [fork1, fork2] forks both continuers", () => {
    const wt = makeDir("wt-root");
    seedWorker(db, { id: 1, branch: "hub/1-root", worktreePath: wt, baseCommit: "11111111" });
    const maps = makeStepMaps([
      { key: "root", status: "done", workerIds: [1] },
      { key: "fork1", status: "pending", deps: ["root"] },
      { key: "fork2", status: "pending", deps: ["root"] },
    ]);
    expect(resolveWorkspacePlan(db, planFor(maps, "fork1"))).toEqual({ kind: "fork", baseBranch: "hub/1-root" });
    expect(resolveWorkspacePlan(db, planFor(maps, "fork2"))).toEqual({ kind: "fork", baseBranch: "hub/1-root" });
  });

  it("S5: assertReviewStepsHaveTarget rejects solo review and multi-impl fan-in review without explicit base", () => {
    expect(() =>
      assertReviewStepsHaveTarget([{ key: "rev", review: 1, base: null, status: "pending", skipped: 0 }], []),
    ).toThrow(/被审分支/);

    expect(() =>
      assertReviewStepsHaveTarget(
        [
          { key: "a", review: 0, base: null, status: "done", skipped: 0 },
          { key: "b", review: 0, base: null, status: "done", skipped: 0 },
          { key: "rev", review: 1, base: null, status: "pending", skipped: 0 },
        ],
        [
          { fromKey: "a", toKey: "rev" },
          { fromKey: "b", toKey: "rev" },
        ],
      ),
    ).toThrow(/被审分支/);
  });
});
