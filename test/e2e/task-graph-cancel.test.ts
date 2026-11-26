import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { API_PATHS, type CancelTaskGraphResponse, type TaskGraph } from "../../src/shared/index.ts";
import { Client, makeEnv, waitForStatus, type E2eEnv } from "./harness.ts";

let env: E2eEnv;
afterEach(async () => {
  await env?.cleanup();
});

async function pmHub(client: Client, conversationId: number) {
  await waitForStatus(client, await client.post(conversationId, "Ready?"), "replied", 20_000);
  const session = (await client.snapshot()).sessions.find((row) => row.conversationId === conversationId)!;
  const pid = env.procsOf(session.sessionId).at(-1)!.pid;
  return async (args: string[], stdin?: string): Promise<string> => {
    const result = await env.runHub(pid, args, stdin === undefined ? {} : { stdin });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
}

async function startGraph() {
  env = makeEnv();
  const folder = join(env.dir, "project");
  mkdirSync(folder);
  env.setScript({
    defaultTurn: { steps: [{ text: "Ready" }] },
    sessions: [{ role: "worker", script: { defaultTurn: { steps: [{ waitFile: join(folder, "finish-worker") }] } } }],
  });
  const daemon = await env.start();
  const client = await Client.login(daemon);
  const { conversationId } = await client.createPm({ name: "PM", mode: "manage_only", persona: "", folder: realpathSync.native(folder) });
  const hub = await pmHub(client, conversationId);
  await hub(["graph", "create", "--stdin"], JSON.stringify({ title: "Cancellation", steps: [
    { key: "plan", title: "Plan", deps: [] },
    { key: "pm", title: "PM", deps: [] },
    { key: "decision", title: "Decision", deps: [] },
    { key: "later", title: "Later", deps: ["plan"] },
    { key: "finished", title: "Finished", deps: [] },
    { key: "skipped", title: "Skipped", deps: [] },
  ] }));
  await hub(["worker", "start", "--node", "plan", "--no-worktree", "--stdin"], "Plan the work");
  await hub(["ask", "--node", "decision", "--option", "Yes", "--option", "No", "--stdin"], "Continue?");
  await hub(["graph", "done", "finished", "--commit", "abc1234"]);
  await hub(["graph", "skip", "skipped"]);
  const [graph] = (await client.snapshot()).activeTaskGraphs;
  expect(Object.fromEntries(graph!.nodes.map(({ key, status, waitingFor }) => [key, [status, waitingFor]]))).toEqual({
    plan: ["running", null], pm: ["waiting", "pm"], decision: ["waiting", "user"], later: ["pending", null],
    finished: ["done", null], skipped: ["done", null],
  });
  return { daemon, client, conversationId, hub, graph: graph!, workerId: graph!.nodes.find((node) => node.key === "plan")!.activeWorkerId! };
}

function stepStates(graphId: number): Record<string, unknown> {
  const db = openDatabase(join(env.home, "state", "hub.sqlite"));
  try {
    const rows = db.all<{ node_key: string; status: string; waiting_for: string | null; active_worker_id: number | null; skipped: number }>(
      "SELECT node_key, status, waiting_for, active_worker_id, skipped FROM task_graph_steps WHERE graph_id = ?", graphId,
    );
    return Object.fromEntries(rows.map(({ node_key, ...state }) => [node_key, state]));
  } finally {
    db.close();
  }
}

function expectStoredCancellation(graphId: number): void {
  const cancelled = { status: "cancelled", waiting_for: null, active_worker_id: null, skipped: 0 };
  const done = { ...cancelled, status: "done" };
  expect.soft(stepStates(graphId)).toEqual({
    plan: cancelled, pm: cancelled, decision: cancelled, later: cancelled, finished: done, skipped: { ...done, skipped: 1 },
  });
}

function expectClosedGraph(graph: TaskGraph, workerId: number): void {
  expect(graph.status).toBe("cancelled");
  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
  expect.soft(byKey.get("plan")).toMatchObject({ status: "cancelled", activeWorkerId: null, workerIds: [workerId] });
  expect.soft(byKey.get("decision")).toMatchObject({ status: "cancelled", waitingFor: null, gateAskPending: true });
  expect(byKey.get("finished")?.artifact?.commit).toBe("abc1234");
  expect(byKey.get("skipped")).toMatchObject({ status: "done", skipped: true });
}

describe("task graph cancellation", { timeout: 60_000 }, () => {
  it("ends workers and persists every unfinished step through CLI cancellation and daemon restart", async () => {
    const { daemon, client, conversationId, hub, graph, workerId } = await startGraph();
    const showArgs = ["graph", "show", String(graph.id)];
    const workerArgs = ["worker", "show", String(workerId)];
    const before = await hub(showArgs);
    expect(before).toContain("[在干] plan");
    await hub(["graph", "cancel", String(graph.id)]);
    const after = await hub(showArgs);
    const worker = await hub(workerArgs);
    console.info(`Before cancellation:\n${before}\nAfter cancellation:\n${after}\nWorker after cancellation:\n${worker}`);
    expect(worker).toContain("已收工");
    expect((await client.snapshot()).activeTaskGraphs).toEqual([]);
    expect.soft(after).toContain(`[已取消] plan：Plan · 经手 Worker #${workerId}`);
    expectStoredCancellation(graph.id);

    expect(await daemon.terminate()).toEqual({ code: 0, signal: null });
    const restarted = await env.start();
    const reconnected = await Client.login(restarted);
    const query = await pmHub(reconnected, conversationId);
    const afterRestart = await query(showArgs);
    const listed = await query(["graph", "list", "--status", "cancelled"]);
    console.info(`After daemon restart:\n${afterRestart}\nCancelled graph list:\n${listed}`);
    expect(afterRestart).toBe(after);
    expect.soft(listed).toContain("[已取消] plan");
    expect(await query(workerArgs)).toContain("已收工");
    expect((await reconnected.snapshot()).activeTaskGraphs).toEqual([]);
    expectStoredCancellation(graph.id);
    expect(await restarted.terminate()).toEqual({ code: 0, signal: null });
  });

  it("returns cancelled steps over HTTP and upgrades a ledger with stale cancelled graphs", async () => {
    const { daemon, client, conversationId, graph, workerId } = await startGraph();
    const cancelled = await client.postJson(API_PATHS.taskGraphCancel(graph.id), { reason: "No longer needed" });
    expect(cancelled.status).toBe(200);
    expectClosedGraph(((await cancelled.json()) as CancelTaskGraphResponse).graph, workerId);
    expect(await daemon.terminate()).toEqual({ code: 0, signal: null });

    const db = openDatabase(join(env.home, "state", "hub.sqlite"));
    try {
      db.transaction(() => {
        for (const node of graph.nodes.filter((node) => node.status !== "done")) {
          db.run("UPDATE task_graph_steps SET status = ?, waiting_for = ? WHERE graph_id = ? AND node_key = ?",
            node.status, node.waitingFor, graph.id, node.key);
        }
        db.exec("PRAGMA user_version = 55");
      });
    } finally {
      db.close();
    }

    const upgraded = await env.start();
    const reconnected = await Client.login(upgraded);
    const query = await pmHub(reconnected, conversationId);
    const shown = await query(["graph", "show", String(graph.id)]);
    const repeated = await reconnected.postJson(API_PATHS.taskGraphCancel(graph.id), {});
    expect(repeated.status).toBe(200);
    const result = (await repeated.json()) as CancelTaskGraphResponse;
    expect(result.messageId).toBeNull();
    expectClosedGraph(result.graph, workerId);
    console.info(`Historical graph after upgrade:\n${shown}`);
    expect.soft(shown).toContain(`[已取消] plan：Plan · 经手 Worker #${workerId}`);
    expectStoredCancellation(graph.id);
    expect(await upgraded.terminate()).toEqual({ code: 0, signal: null });
  });
});
