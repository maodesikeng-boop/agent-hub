import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { sandboxAllowsNestedSandbox } from "../sandbox-probes.ts";
import { Client, makeEnv, waitForStatus, waitUntil, type E2eEnv } from "./harness.ts";

let env: E2eEnv | undefined;
afterEach(async () => { await env?.cleanup(); });

const task = "Worker brief before shutdown";
const followup = "Worker follow-up before shutdown";
const failure = "重启后没能自动重发";
const capabilities = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"];

function withDb<T>(env: E2eEnv, read: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(join(env.home, "state", "hub.sqlite"));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

it.each(["resend", "notify"] as const)(
  "recovers the Worker turn across a real daemon restart (%s)",
  { timeout: 60_000 },
  async (outcome) => {
    const e = env = makeEnv();
    const folder = join(e.dir, "project");
    mkdirSync(folder);
    e.setScript({
      sessions: [{ role: "worker", script: {
        capabilities,
        cancelQueuedOnSigint: true,
        turns: [{ steps: [{ text: "Started" }, { waitFile: join(e.dir, "hold") }] }],
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
    expect((await e.runHub(pmPid, ["worker", "start", "--no-worktree", "--title", "Recovery", "--stdin"], { stdin: task })).code).toBe(0);

    const worker = await waitUntil("Worker brief in progress", () => withDb(e, (db) =>
      db.get<{ id: number; worker_id: number; session_id: number }>("SELECT id, worker_id, session_id FROM messages WHERE sender = 'pm' AND status = 'processing'"),
    ));
    const workerPid = e.procsOf(worker.session_id)[0]!.pid;
    let followupId: number | undefined;
    if (outcome === "resend") {
      expect((await e.runHub(pmPid, ["worker", "send", String(worker.worker_id), "--stdin"], { stdin: followup })).code).toBe(0);
      followupId = await waitUntil("untaken follow-up written to the Worker", () => {
        if (!e.stdinTextsOf(workerPid).includes(followup)) return undefined;
        return withDb(e, (db) => db.get<{ id: number }>(
          "SELECT id FROM messages WHERE session_id = ? AND text = ? AND status = 'delivered'", worker.session_id, followup,
        )?.id);
      });
    }
    expect(await first.terminate()).toEqual({ code: 0, signal: null });
    expect(e.isAlive(workerPid)).toBe(false);
    if (outcome === "notify") {
      // Reproduce a terminal brief left by an older driver without changing the saved turn.
      withDb(e, (db) => db.run("UPDATE messages SET status = 'cancelled' WHERE id = ?", worker.id));
    }

    const second = await boot();
    const restarted = client.withPort(second.port);
    if (followupId !== undefined) {
      const recovered = await waitUntil("recovered Worker writes", () => {
        const process = e.procsOf(worker.session_id)[1];
        if (process === undefined) return undefined;
        const texts = e.stdinTextsOf(process.pid);
        const recovered = texts.join("\n");
        return recovered.includes(task) && recovered.includes(followup) ? recovered : undefined;
      });
      expect(recovered.indexOf(task)).toBeLessThan(recovered.indexOf(followup));
      await waitForStatus(restarted, followupId, "replied");
      const recoveredTurns = withDb(e, (db) => db.all<{ id: number; cause: string; outcome: string; stop_source: string | null; parent_turn_id: number | null }>(
        `SELECT t.id, t.cause, t.outcome, t.stop_source, t.parent_turn_id FROM turns t
         JOIN turn_inputs i ON t.id = i.turn_id WHERE i.message_id = ? ORDER BY t.id`, worker.id,
      ));
      expect(recoveredTurns).toEqual([
        { id: expect.any(Number), cause: "input", outcome: "interrupted", stop_source: "shutdown", parent_turn_id: null },
        { id: expect.any(Number), cause: "recovery", outcome: "ok", stop_source: null, parent_turn_id: recoveredTurns[0]!.id },
      ]);
      const process = e.procsOf(worker.session_id)[1]!;
      expect(e.stdinTextsOf(process.pid).filter((text) => text.includes(task))).toHaveLength(1);
    } else {
      const notice = await waitUntil("failure notice written to the PM", () => {
        const process = e.procsOf(pmSessionId)[1];
        return process === undefined ? undefined : e.stdinTextsOf(process.pid).find((text) => text.includes(failure));
      });
      expect(notice).toContain(`Worker #${worker.worker_id}`);
      expect(e.procsOf(worker.session_id)).toHaveLength(1);
    }
    expect(await second.terminate()).toEqual({ code: 0, signal: null });
  },
);
