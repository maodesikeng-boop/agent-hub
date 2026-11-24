import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Client, makeEnv, messageById, sleep, waitForStatus, waitUntil, type E2eEnv, type RunningDaemon } from "./harness.ts";

const PROBE = "terminal-write-probe";

let env: E2eEnv;
let db: DatabaseSync | undefined;
afterEach(async () => {
  db?.close();
  db = undefined;
  await env?.cleanup();
});

async function boot(): Promise<{ daemon: RunningDaemon; client: Client; conversationId: number }> {
  const daemon = await env.start();
  const client = await Client.login(daemon);
  const conversationId = (await client.state()).conversations[0]!.conversation.id;
  return { daemon, client, conversationId };
}

function openDb(): DatabaseSync {
  const opened = new DatabaseSync(join(env.home, "state", "hub.sqlite"));
  opened.exec("PRAGMA busy_timeout = 5000");
  return opened;
}

const holdReplied = (store: DatabaseSync) =>
  store.exec(`CREATE TRIGGER hold_replied BEFORE UPDATE OF status ON messages
    WHEN OLD.sender = 'user' AND OLD.text = '${PROBE}' AND NEW.status = 'replied'
    BEGIN SELECT RAISE(ABORT, 'injected terminal write failure'); END`);
const release = (store: DatabaseSync) => store.exec("DROP TRIGGER hold_replied");
const receipts = (store: DatabaseSync) => (store.prepare("SELECT count(*) AS n FROM turn_completions").get() as { n: number }).n;
const probePrompts = () => env.stdinTexts().filter((text) => text.endsWith(PROBE)).length;

async function postHeldProbe(store: DatabaseSync, client: Client, conversationId: number): Promise<number> {
  const control = await client.post(conversationId, "control");
  await waitForStatus(client, control, "replied");
  holdReplied(store);
  const id = await client.post(conversationId, PROBE);
  await waitUntil("pending turn completion receipt", () => (receipts(store) > 0 ? true : undefined));
  const row = store.prepare("SELECT m.status, a.status AS action FROM messages m JOIN actions a ON a.type = 'session.send' AND a.dedupe_key = (CAST(m.session_id AS TEXT) || ':' || CAST(m.id AS TEXT)) WHERE m.id = ?").get(id);
  expect(row).toEqual({ status: "processing", action: "done" });
  expect(probePrompts()).toBe(1);
  return id;
}

async function crash(daemon: RunningDaemon): Promise<void> {
  daemon.child.kill("SIGKILL");
  await daemon.exited;
}

describe("daemon turn completion recovery", { timeout: 60_000 }, () => {
  it("settles after an injected terminal write failure without another turn or a second fake CLI prompt", async () => {
    env = makeEnv();
    env.setScript({ defaultTurn: { steps: [{ text: "ok" }] } });
    const { daemon, client, conversationId } = await boot();
    db = openDb();
    const id = await postHeldProbe(db, client, conversationId);

    release(db);
    await waitForStatus(client, id, "replied");
    expect(receipts(db)).toBe(0);
    expect(probePrompts()).toBe(1);
    expect((await client.state()).health.find((h) => h.module === "store")?.lastError ?? null).toBeNull();
    await daemon.terminate();
  });

  it("recovers a committed receipt after a daemon crash without sending the settled prompt again", async () => {
    env = makeEnv();
    env.setScript({ defaultTurn: { steps: [{ text: "ok" }] } });
    const first = await boot();
    db = openDb();
    const id = await postHeldProbe(db, first.client, first.conversationId);
    await crash(first.daemon);
    release(db);

    const daemon = await env.start();
    const client = first.client.withPort(daemon.port);
    await waitForStatus(client, id, "replied");
    await sleep(500);
    expect(probePrompts()).toBe(1);
    expect(receipts(db)).toBe(0);
    await daemon.terminate();
  });

  it("does not resend a receipted message when its status write still fails at startup", async () => {
    env = makeEnv();
    env.setScript({ defaultTurn: { steps: [{ text: "ok" }] } });
    const first = await boot();
    db = openDb();
    const id = await postHeldProbe(db, first.client, first.conversationId);
    await crash(first.daemon);

    const daemon = await env.start();
    const client = first.client.withPort(daemon.port);
    await sleep(1_500);
    expect(messageById(await client.state(), id)?.status).toBe("processing");
    expect(probePrompts()).toBe(1);
    expect(receipts(db)).toBe(1);

    release(db);
    await waitForStatus(client, id, "replied");
    await sleep(500);
    expect(probePrompts()).toBe(1);
    await daemon.terminate();
  });
});
