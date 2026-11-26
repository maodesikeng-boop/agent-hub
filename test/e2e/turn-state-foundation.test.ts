import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { MessagesPage } from "../../src/shared/api.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { sandboxAllowsNestedSandbox } from "../sandbox-probes.ts";
import { Client, makeEnv, waitForStatus, waitUntil, type E2eEnv } from "./harness.ts";

let env: E2eEnv | undefined;
afterEach(async () => { await env?.cleanup(); });

const brief = "Worker brief that runs a command and then hangs";
const capabilities = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"];

function withDb<T>(e: E2eEnv, read: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(join(e.home, "state", "hub.sqlite"));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

it("records the turn, its tool, and one linked recovery turn across a real daemon restart", { timeout: 90_000 }, async () => {
  const e = env = makeEnv();
  const folder = join(e.dir, "project");
  mkdirSync(folder);
  e.setScript({
    sessions: [{ role: "worker", script: {
      capabilities,
      cancelQueuedOnSigint: true,
      turns: [{ steps: [{ text: "Started" }, { bash: "printf old" }, { waitFile: join(e.dir, "hold") }] }],
      defaultTurn: { steps: [{ text: "Finished after reload" }] },
    } }],
  });
  const boot = () => e.start({
    main: fileURLToPath(new URL("./worker-shutdown-daemon.ts", import.meta.url)),
    env: { E2E_FAKE_WORKER_SANDBOX: sandboxAllowsNestedSandbox() ? "0" : "1" },
  });

  const first = await boot();
  const client = await Client.login(first);
  const pm = await client.createPm({ name: "PM", mode: "manage_only", persona: "", folder });
  await waitForStatus(client, await client.post(pm.conversationId, "Prepare to start the Worker"), "replied");
  const pmSessionId = (await client.state()).sessions.find((s) => s.conversationId === pm.conversationId)!.sessionId;
  const pmPid = e.procsOf(pmSessionId)[0]!.pid;
  expect((await e.runHub(pmPid, ["worker", "start", "--no-worktree", "--title", "Recovery", "--stdin"], { stdin: brief })).code).toBe(0);

  const worker = await waitUntil("Worker ran its command and is holding", () => withDb(e, (db) => {
    const row = db.get<{ id: number; worker_id: number; session_id: number }>(
      "SELECT id, worker_id, session_id FROM messages WHERE sender = 'pm' AND status = 'processing'",
    );
    if (row === undefined) return undefined;
    const done = db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE session_id = ? AND kind = 'tool'", row.session_id)?.n ?? 0;
    return done > 0 ? row : undefined;
  }));
  const tools = withDb(e, (db) => db.all<{ name: string; status: string }>(
    "SELECT tt.name, tt.status FROM turn_tools tt JOIN turns t ON t.id = tt.turn_id WHERE t.session_id = ?", worker.session_id,
  ));
  expect(tools).toEqual([{ name: "Bash", status: "done" }]);

  expect(await first.terminate()).toEqual({ code: 0, signal: null });
  const second = await boot();
  const restarted = client.withPort(second.port);
  writeFileSync(join(e.dir, "hold"), "");
  await waitForStatus(restarted, worker.id, "replied");

  const turns = withDb(e, (db) => db.all<{ id: number; cause: string; outcome: string | null; stop_source: string | null; parent_turn_id: number | null }>(
    "SELECT id, cause, outcome, stop_source, parent_turn_id FROM turns WHERE session_id IN (SELECT id FROM agent_sessions WHERE worker_id = ?) ORDER BY id",
    worker.worker_id,
  ));
  expect(turns).toEqual([
    { id: expect.any(Number), cause: "input", outcome: "interrupted", stop_source: "shutdown", parent_turn_id: null },
    { id: expect.any(Number), cause: "recovery", outcome: "ok", stop_source: null, parent_turn_id: turns[0]!.id },
  ]);
  const resumed = e.procsOf(worker.session_id).at(-1)!;
  expect(e.stdinTextsOf(resumed.pid).filter((text) => text.includes(brief))).toHaveLength(1);

  const page = await (await restarted.get(`/api/conversations/${pm.conversationId}/messages?before=${Number.MAX_SAFE_INTEGER}`)).json() as MessagesPage;
  expect(page.turns?.length).toBeGreaterThan(0);
  expect(page.turns!.every((turn) => turn.status === "ended" && turn.durationMs !== null && turn.durationMs >= 0)).toBe(true);
  expect(await second.terminate()).toEqual({ code: 0, signal: null });
});
