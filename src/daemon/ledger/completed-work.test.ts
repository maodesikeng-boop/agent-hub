import { cpSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPLETED_WORK_PAGE_SIZE,
  type CompletedCursor,
  type CompletedWorkItem,
  type ConversationId,
  type PmId,
  type ProjectId,
  type TaskGraphId,
  type WorkerId,
} from "../../shared/index.ts";
import { DEFAULT_MIGRATIONS_DIR, migrate, openDatabase, type Db } from "../store/index.ts";
import { openTestDb, writeMigrationManifest } from "../store/test-helpers.ts";
import { completedWorkPage, recordWorkerEnded } from "./completed-work.ts";
import { createLedger, type SqliteLedger } from "./index.ts";

let root: string;
let db: Db;
let ledger: SqliteLedger;
let clock = 10_000;

beforeEach(() => {
  clock = 10_000;
  root = mkdtempSync(join(tmpdir(), "agent-hub-completed-work-"));
  db = openTestDb();
  ledger = createLedger(db, { pmHomeRoot: join(root, "pm-home"), dataHome: root, now: () => clock });
});

afterEach(() => {
  ledger.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  pmId: PmId;
  projectId: ProjectId;
  pmConvId: ConversationId;
  pmSessionId: number;
}

function createFixture(name = "Lin"): Fixture {
  const { pm, conversation, sessionId } = ledger.createPm({ name, mode: "manage_only", persona: "" });
  const projectId = Number(
    db.run(
      "INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      `proj-${name}`,
      pm.id,
      conversation.id,
      clock,
      clock,
    ).lastInsertRowid,
  );
  return { pmId: pm.id, projectId, pmConvId: conversation.id, pmSessionId: sessionId };
}

function insertEndedWorker(
  f: Fixture,
  opts: {
    title: string;
    endedAt: number;
    reportStatus?: "done" | "problem" | "gave_up" | null;
    prUrl?: string | null;
    legacyReportText?: string;
  },
): { workerId: WorkerId; conversationId: ConversationId } {
  const convId = Number(
    db.run(
      "INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('worker', ?, ?, ?)",
      f.pmId,
      opts.title,
      opts.endedAt,
    ).lastInsertRowid,
  );
  const workerId = Number(
    db.run(
      `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, workspace, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'task', 'main', 'ended', ?, ?)`,
      f.projectId,
      f.pmId,
      f.pmConvId,
      convId,
      opts.title,
      opts.endedAt,
      opts.endedAt,
    ).lastInsertRowid,
  );
  recordWorkerEnded(db, { id: workerId, pmId: f.pmId }, opts.endedAt);
  if (opts.reportStatus !== undefined && opts.reportStatus !== null) {
    const meta = {
      workerId,
      workerConversationId: convId,
      title: opts.title,
      readonly: false,
      event: "report",
      status: opts.reportStatus,
      summary: "summary",
      ...(opts.prUrl !== undefined && opts.prUrl !== null ? { prUrl: opts.prUrl } : {}),
    };
    db.run(
      `INSERT INTO messages (conversation_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'worker', ?, ?, ?, NULL, ?, ?)`,
      f.pmConvId,
      workerId,
      opts.legacyReportText ?? "report body",
      JSON.stringify(meta),
      `worker-report:${workerId}:${opts.endedAt}:${Math.random()}`,
      opts.endedAt,
      opts.endedAt,
    );
  }
  return { workerId, conversationId: convId };
}

function insertFinishedGraph(
  f: Fixture,
  opts: {
    title: string;
    status: "completed" | "cancelled";
    completedAt: number;
    steps: {
      key: string;
      title: string;
      status?: "done" | "pending" | "running";
      skipped?: boolean;
      workerIds?: WorkerId[];
      activeWorkerId?: WorkerId | null;
      prUrl?: string;
    }[];
    edges?: { fromKey: string; toKey: string }[];
  },
): TaskGraphId {
  const graphId = Number(
    db.run(
      `INSERT INTO task_graphs (project_id, pm_id, conversation_id, title, status, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      f.projectId,
      f.pmId,
      f.pmConvId,
      opts.title,
      opts.status,
      opts.completedAt - 100,
      opts.completedAt,
      opts.completedAt,
    ).lastInsertRowid,
  );
  opts.steps.forEach((step, idx) => {
    const status = step.status ?? (opts.status === "completed" ? "done" : "pending");
    const artifactJson = step.prUrl ? JSON.stringify({ prUrl: step.prUrl }) : null;
    db.run(
      `INSERT INTO task_graph_steps (
         graph_id, node_key, title, status, skipped, sort_order,
         active_worker_id, worker_ids_json, artifact_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      graphId,
      step.key,
      step.title,
      status,
      status === "done" && step.skipped ? 1 : 0,
      idx,
      step.activeWorkerId ?? null,
      JSON.stringify(step.workerIds ?? []),
      artifactJson,
      opts.completedAt - 50,
      opts.completedAt,
    );
  });
  for (const edge of opts.edges ?? []) {
    db.run("INSERT INTO task_graph_edges (graph_id, from_key, to_key) VALUES (?, ?, ?)", graphId, edge.fromKey, edge.toKey);
  }
  return graphId;
}

describe("completedWorkPage", () => {
  it("lists finished graphs and finished standalone Workers newest first", () => {
    const f = createFixture();
    insertEndedWorker(f, { title: "Older worker", endedAt: 1_000, reportStatus: "done" });
    insertFinishedGraph(f, {
      title: "Middle graph",
      status: "completed",
      completedAt: 2_000,
      steps: [
        { key: "plan", title: "Plan" },
        { key: "impl", title: "Implement" },
      ],
      edges: [{ fromKey: "plan", toKey: "impl" }],
    });
    insertEndedWorker(f, { title: "Newest worker", endedAt: 3_000, reportStatus: "done" });
    // Active graph must be excluded.
    db.run(
      `INSERT INTO task_graphs (project_id, pm_id, conversation_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Still running', 'active', 4000, 4000)`,
      f.projectId,
      f.pmId,
      f.pmConvId,
    );

    const page = completedWorkPage(db, f.pmId, null, 20);
    expect(page.total).toBe(3);
    expect(page.next).toBeNull();
    expect(page.items.map((item) => [item.kind, item.title, item.finishedAt])).toEqual([
      ["worker", "Newest worker", 3_000],
      ["graph", "Middle graph", 2_000],
      ["worker", "Older worker", 1_000],
    ]);
    const graphItem = page.items[1]!;
    expect(graphItem.kind).toBe("graph");
    if (graphItem.kind === "graph") {
      expect(graphItem.steps).toEqual([
        { key: "plan", title: "Plan", skipped: false, done: true },
        { key: "impl", title: "Implement", skipped: false, done: true },
      ]);
      expect(graphItem.edges).toEqual([{ fromKey: "plan", toKey: "impl" }]);
    }
  });

  it("leaves out Workers that a Task Graph step lists among its workers", () => {
    const f = createFixture();
    const boundViaList = insertEndedWorker(f, { title: "Step worker", endedAt: 2_000, reportStatus: "done" });
    const boundViaActive = insertEndedWorker(f, { title: "Active-bound worker", endedAt: 2_500, reportStatus: "done" });
    const solo = insertEndedWorker(f, { title: "Standalone worker", endedAt: 3_000, reportStatus: "done" });
    insertFinishedGraph(f, {
      title: "Graph with workers",
      status: "completed",
      completedAt: 2_600,
      steps: [
        { key: "s1", title: "S1", workerIds: [boundViaList.workerId] },
        { key: "s2", title: "S2", activeWorkerId: boundViaActive.workerId },
      ],
    });

    const page = completedWorkPage(db, f.pmId, null, 20);
    expect(page.total).toBe(2);
    expect(page.items.map((i) => i.title)).toEqual(["Standalone worker", "Graph with workers"]);
    expect(page.items.some((i) => i.kind === "worker" && i.workerId === solo.workerId)).toBe(true);
  });

  it("pages without overlap or gaps when several items finish in the same millisecond", () => {
    const f = createFixture();
    const t = 5_000;
    insertFinishedGraph(f, { title: "G1", status: "completed", completedAt: t, steps: [{ key: "a", title: "A" }] });
    insertFinishedGraph(f, { title: "G2", status: "completed", completedAt: t, steps: [{ key: "a", title: "A" }] });
    insertEndedWorker(f, { title: "W1", endedAt: t, reportStatus: "done" });
    insertEndedWorker(f, { title: "W2", endedAt: t, reportStatus: "done" });
    insertEndedWorker(f, { title: "W3", endedAt: t, reportStatus: "done" });

    const collected: CompletedWorkItem[] = [];
    let cursor: CompletedCursor | null = null;
    for (let i = 0; i < 10; i++) {
      const page = completedWorkPage(db, f.pmId, cursor, 2);
      expect(page.total).toBe(5);
      collected.push(...page.items);
      cursor = page.next;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    expect(collected.map((i) => i.title)).toEqual(["W3", "W2", "W1", "G2", "G1"]);
  });

  it("counts the whole feed in total on every page", () => {
    const f = createFixture();
    for (let i = 1; i <= 7; i++) {
      insertEndedWorker(f, { title: `W${i}`, endedAt: i * 100, reportStatus: "done" });
    }
    const p1 = completedWorkPage(db, f.pmId, null, 3);
    expect(p1.total).toBe(7);
    expect(p1.items).toHaveLength(3);
    expect(p1.next).not.toBeNull();

    const p2 = completedWorkPage(db, f.pmId, p1.next, 3);
    expect(p2.total).toBe(7);
    expect(p2.items).toHaveLength(3);
    expect(p2.next).not.toBeNull();

    const p3 = completedWorkPage(db, f.pmId, p2.next, 3);
    expect(p3.total).toBe(7);
    expect(p3.items).toHaveLength(1);
    expect(p3.next).toBeNull();
  });

  it("takes a graph's PR from its last step artifact with one and a Worker's PR from its last report", () => {
    const f = createFixture();
    insertFinishedGraph(f, {
      title: "Graph PR",
      status: "completed",
      completedAt: 2_000,
      steps: [
        { key: "s1", title: "Draft", prUrl: "https://github.com/org/repo/pull/101" },
        { key: "s2", title: "Final", prUrl: "https://github.com/org/repo/pull/202" },
        { key: "s3", title: "Review" },
      ],
    });
    const w = insertEndedWorker(f, {
      title: "Worker PR",
      endedAt: 3_000,
      reportStatus: "done",
      prUrl: "https://github.com/org/repo/pull/303",
    });
    // Add a newer report overriding the PR.
    db.run(
      `INSERT INTO messages (conversation_id, worker_id, sender, kind, text, meta, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'system', 'worker', 'second', ?, 'worker-report:override', NULL, 3001, 3001)`,
      f.pmConvId,
      w.workerId,
      JSON.stringify({
        workerId: w.workerId,
        workerConversationId: w.conversationId,
        title: "Worker PR",
        readonly: false,
        event: "report",
        status: "done",
        summary: "done",
        prUrl: "https://github.com/org/repo/pull/404",
      }),
    );

    const page = completedWorkPage(db, f.pmId, null, 10);
    expect(page.items.map((i) => [i.title, i.prUrl])).toEqual([
      ["Worker PR", "https://github.com/org/repo/pull/404"],
      ["Graph PR", "https://github.com/org/repo/pull/202"],
    ]);
  });

  it("marks a cancelled graph and a Worker that ended without a done report as cancelled", () => {
    const f = createFixture();
    insertFinishedGraph(f, {
      title: "Cancelled graph",
      status: "cancelled",
      completedAt: 1_000,
      steps: [
        { key: "s1", title: "Done step", status: "done" },
        { key: "s2", title: "Unfinished step", status: "pending" },
      ],
    });
    insertEndedWorker(f, { title: "No report worker", endedAt: 2_000, reportStatus: null });
    insertEndedWorker(f, { title: "Problem worker", endedAt: 3_000, reportStatus: "problem" });
    insertEndedWorker(f, { title: "Done worker", endedAt: 4_000, reportStatus: "done" });

    const page = completedWorkPage(db, f.pmId, null, 10);
    expect(page.items.map((i) => [i.title, i.outcome])).toEqual([
      ["Done worker", "done"],
      ["Problem worker", "cancelled"],
      ["No report worker", "cancelled"],
      ["Cancelled graph", "cancelled"],
    ]);
    const cancelledGraph = page.items[3]!;
    if (cancelledGraph.kind === "graph") {
      expect(cancelledGraph.steps).toEqual([
        { key: "s1", title: "Done step", skipped: false, done: true },
        { key: "s2", title: "Unfinished step", skipped: false, done: false },
      ]);
    }
  });

  it("clamps limit to COMPLETED_WORK_PAGE_SIZE", () => {
    const f = createFixture();
    for (let i = 1; i <= COMPLETED_WORK_PAGE_SIZE + 5; i++) {
      insertEndedWorker(f, { title: `W${i}`, endedAt: i, reportStatus: "done" });
    }
    const page = completedWorkPage(db, f.pmId, null, COMPLETED_WORK_PAGE_SIZE + 100);
    expect(page.items).toHaveLength(COMPLETED_WORK_PAGE_SIZE);
    expect(page.total).toBe(COMPLETED_WORK_PAGE_SIZE + 5);
    expect(page.next).not.toBeNull();
  });

  it("throws not_found for an unknown PM and invalid for a forged cursor", () => {
    const f = createFixture();
    expect(() => completedWorkPage(db, 999, null, 10)).toThrow(expect.objectContaining({ code: "not_found" }));
    const forged = Buffer.from("9999:worker:1.badmac", "utf8").toString("base64url") as CompletedCursor;
    expect(() => completedWorkPage(db, f.pmId, forged, 10)).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => completedWorkPage(db, f.pmId, "not-a-cursor" as CompletedCursor, 10)).toThrow(
      expect.objectContaining({ code: "invalid" }),
    );
  });
});

describe("recordWorkerEnded", () => {
  it("records the end time when a Worker ends through End, a report, or a failed worktree", () => {
    const f = createFixture();
    // 1. End via hub worker end
    const createLiveWorker = (title: string, workspace: "main" | "worktree") => {
      const convId = Number(
        db.run("INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('worker', ?, ?, ?)", f.pmId, title, clock)
          .lastInsertRowid,
      );
      const branch = workspace === "worktree" ? `hub/${title}` : null;
      const wtPath = workspace === "worktree" ? join(root, title) : null;
      const workerId = Number(
        db.run(
          `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, workspace, branch, worktree_path, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'do it', ?, ?, ?, 'open', ?, ?)`,
          f.projectId,
          f.pmId,
          f.pmConvId,
          convId,
          title,
          workspace,
          branch,
          wtPath,
          clock,
          clock,
        ).lastInsertRowid,
      );
      const sessionId = Number(
        db.run(
          `INSERT INTO agent_sessions (role, conversation_id, worker_id, vendor_session_id, cwd, status, created_at, updated_at, pm_id)
           VALUES ('worker', ?, ?, ?, '/tmp', 'running', ?, ?, NULL)`,
          convId,
          workerId,
          `vs-${workerId}`,
          clock,
          clock,
        ).lastInsertRowid,
      );
      return { workerId, convId, sessionId };
    };

    const w1 = createLiveWorker("Manual end", "main");
    clock = 20_000;
    ledger.hubCall(f.pmSessionId, "worker.end", { workerId: w1.workerId });
    expect(db.get<{ ended_at: number }>("SELECT ended_at FROM worker_endings WHERE worker_id = ?", w1.workerId)?.ended_at).toBe(20_000);

    // 2. End via archive (endOpenWorkersIn)
    const w2 = createLiveWorker("Archived end", "main");
    clock = 30_000;
    ledger.archivePm(f.pmId);
    expect(db.get<{ ended_at: number }>("SELECT ended_at FROM worker_endings WHERE worker_id = ?", w2.workerId)?.ended_at).toBe(30_000);
    ledger.unarchivePm(f.pmId);

    // 3. End via failed worktree.create action
    const w3 = createLiveWorker("Worktree fail", "worktree");
    clock = 40_000;
    ledger.onActionFailed(
      {
        id: 999,
        type: "worktree.create",
        dedupeKey: `worktree:${w3.workerId}`,
        params: { workerId: w3.workerId },
        status: "running",
        attempts: 1,
        nextAttemptAt: 0,
        lastError: null,
        createdAt: clock,
        updatedAt: clock,
      },
      "git worktree add failed",
    );
    expect(db.get<{ ended_at: number }>("SELECT ended_at FROM worker_endings WHERE worker_id = ?", w3.workerId)?.ended_at).toBe(40_000);
  });

  it("keeps the first end time when called twice", () => {
    const f = createFixture();
    const { workerId } = insertEndedWorker(f, { title: "Twice", endedAt: 12_345, reportStatus: "done" });
    recordWorkerEnded(db, { id: workerId, pmId: f.pmId }, 99_999);
    expect(db.get<{ ended_at: number }>("SELECT ended_at FROM worker_endings WHERE worker_id = ?", workerId)?.ended_at).toBe(12_345);
  });
});

describe("0051_completed_feed", () => {
  it("backfills ended Workers from updated_at and reruns without changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-hub-m0051-"));
    const prevMigs = join(dir, "m50");
    cpSync(DEFAULT_MIGRATIONS_DIR, prevMigs, { recursive: true });
    for (const name of readdirSync(prevMigs)) {
      const ver = /^(\d+)_.*\.sql$/.exec(name)?.[1];
      if (ver !== undefined && Number(ver) > 50) unlinkSync(join(prevMigs, name));
    }
    writeMigrationManifest(prevMigs);

    const migDb = openDatabase(join(dir, "upgrade.sqlite"));
    try {
      expect(migrate(migDb, prevMigs).to).toBe(50);
      const pmId = Number(
        migDb.run("INSERT INTO pms (name, mode, created_at) VALUES ('Lin', 'manage_only', 1000)").lastInsertRowid,
      );
      const pmConv = Number(
        migDb.run("INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', ?, 'Lin', 1000)", pmId).lastInsertRowid,
      );
      const projectId = Number(
        migDb.run("INSERT INTO projects (name, pm_id, conversation_id, created_at, updated_at) VALUES ('p', ?, ?, 1000, 1000)", pmId, pmConv)
          .lastInsertRowid,
      );
      const wConv = Number(
        migDb.run("INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('worker', ?, 'Old', 1000)", pmId).lastInsertRowid,
      );
      const wId = Number(
        migDb.run(
          `INSERT INTO workers (project_id, pm_id, pm_conversation_id, worker_conversation_id, title, task, workspace, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'Old', 't', 'main', 'ended', 1000, 7777)`,
          projectId,
          pmId,
          pmConv,
          wConv,
        ).lastInsertRowid,
      );

      const first = migrate(migDb, DEFAULT_MIGRATIONS_DIR);
      expect(first.applied).toContain(51);
      expect(migDb.get<{ ended_at: number }>("SELECT ended_at FROM worker_endings WHERE worker_id = ?", wId)?.ended_at).toBe(7777);

      // Rerun 0051 directly to ensure idempotency.
      migDb.run("UPDATE workers SET updated_at = 8888 WHERE id = ?", wId);
      const second = migrate(migDb, DEFAULT_MIGRATIONS_DIR);
      expect(second.applied).toEqual([]);
      expect(migDb.get<{ ended_at: number }>("SELECT ended_at FROM worker_endings WHERE worker_id = ?", wId)?.ended_at).toBe(7777);
    } finally {
      migDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
