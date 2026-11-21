import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CHANGE_BUFFER_SIZE, type CreatePmRequest, type WsServerMessage } from "../../src/shared/index.ts";
import { Client, cursorOf, makeEnv, sleep, waitUntil, type E2eEnv } from "./harness.ts";

const SKEWED_MAIN = fileURLToPath(new URL("./skewed-clock-daemon.ts", import.meta.url));

let env: E2eEnv;
afterEach(async () => {
  await env?.cleanup();
});

const pm = (name: string): CreatePmRequest => ({ name, mode: "manage_only", persona: "" });
const createdPm = (messages: readonly WsServerMessage[], pmId: number) => messages.filter((m) => m.type === "pm.created" && m.data.pm.id === pmId);

describe("change stream recovery across daemon restarts", { timeout: 60_000 }, () => {
  it("resyncs an old cursor whose sequence overlaps a new daemon and recovers a PM created while the client was disconnected", async () => {
    env = makeEnv();
    const first = await env.start();
    const firstClient = await Client.login(first);
    for (let i = 0; i < 3; i++) await firstClient.createPm(pm(`Before-${i}`));
    const oldCursor = cursorOf(await firstClient.snapshot());
    expect(await first.terminate()).toEqual({ code: 0, signal: null });

    const second = await env.start();
    const client = await Client.login(second);
    const bootCursor = cursorOf(await client.snapshot());
    expect(bootCursor.bootId).not.toBe(oldCursor.bootId);
    const { pmId: missedId } = await client.createPm(pm("Missed"));
    for (let i = 0; (await client.snapshot()).seq <= oldCursor.seq; i++) await client.createPm(pm(`Filler-${i}`));
    const newSeq = (await client.snapshot()).seq;
    expect(newSeq - oldCursor.seq).toBeLessThan(CHANGE_BUFFER_SIZE);

    const sameBoot = await client.ws({ bootId: bootCursor.bootId, seq: bootCursor.seq });
    await waitUntil("same-boot replay of the missed PM", () => (createdPm(sameBoot.messages, missedId).length === 1 ? true : undefined));
    expect(sameBoot.messages.some((m) => m.type === "resync")).toBe(false);
    sameBoot.close();

    const stale = await client.ws(oldCursor);
    await waitUntil("first frame for the stale cursor", () => stale.messages[0]);
    await sleep(200);
    expect(stale.messages[0]).toEqual({ type: "resync" });
    expect(createdPm(stale.messages, missedId)).toEqual([]);
    stale.close();

    const recovered = await client.snapshot();
    expect(recovered.pms.some((p) => p.id === missedId)).toBe(true);
    const resumed = await client.ws(cursorOf(recovered));
    const { pmId: laterId } = await client.createPm(pm("Later"));
    await waitUntil("live change after recovery", () => (createdPm(resumed.messages, laterId).length > 0 ? true : undefined));
    await sleep(200);
    expect(createdPm(resumed.messages, laterId)).toHaveLength(1);
    expect(resumed.messages.some((m) => m.type === "resync")).toBe(false);
    resumed.close();
  });

  it("starts sequence numbering independently of the wall clock", async () => {
    env = makeEnv();
    const seqs: number[] = [];
    for (const offset of [0, -20, 365 * 24 * 60 * 60 * 1000]) {
      const daemon = await env.start({ main: SKEWED_MAIN, env: { FUSA_TEST_CLOCK_OFFSET_MS: String(offset) } });
      const client = await Client.login(daemon);
      const cursor = cursorOf(await client.snapshot());
      seqs.push(cursor.seq);
      expect(await daemon.terminate()).toEqual({ code: 0, signal: null });
    }
    for (const seq of seqs) expect(seq).toBeLessThan(CHANGE_BUFFER_SIZE);
  });
});
