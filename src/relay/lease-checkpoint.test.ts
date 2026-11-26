import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MeshIdentity } from "../daemon/mesh/identity.ts";
import { DEVICE_A, DEVICE_B, DEVICE_C, makeIdentity } from "../daemon/mesh/test-helpers.ts";
import { RELAY_CHECKPOINT_PER_IP_PER_MINUTE, RELAY_LEASE_CHECKPOINT_MAX_BYTES } from "../shared/limits.ts";
import type { AccountId } from "../shared/mesh.ts";
import { accountIdOf } from "./auth.ts";
import { createRelayAccountRoom } from "./core.ts";
import {
  parseLeaseCheckpointRoute,
  readLeaseCheckpoint,
  writeLeaseCheckpoint,
  type RelayLeaseCheckpointContext,
} from "./lease-checkpoint.ts";
import { startNodeRelay } from "./node/server.ts";
import {
  RELAY_PATHS,
  RELAY_PROTOCOL_VERSION,
  parseRelayLeaseCheckpointPut,
  parseRelayLeaseCheckpointResponse,
  type RelayLeaseCheckpointConflictError,
  type RelayLeaseCheckpointPutResponse,
  type RelayLeaseCheckpointRecord,
} from "./protocol.ts";
import { LOGIN, RELAY_ORIGIN, connect, memoryStorage, registerRequest } from "./test-helpers.ts";

const WORKER_URL = new URL("./cloudflare/worker.ts", import.meta.url).href;
const VALID_CIPHERTEXT = "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB";

interface WorkerModule {
  handleRelayRequest(request: Request, env: unknown): Promise<Response>;
}

let clock = 1_764_136_000_000;
let accountId: AccountId;
let ids: Record<"a" | "b" | "c", MeshIdentity>;
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(async () => {
  clock = 1_764_136_000_000;
  accountId = await accountIdOf(LOGIN);
  ids = {
    a: await makeIdentity(DEVICE_A),
    b: await makeIdentity(DEVICE_B),
    c: await makeIdentity(DEVICE_C),
  };
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function makeContext(overrides: Partial<RelayLeaseCheckpointContext> = {}) {
  let stored: RelayLeaseCheckpointRecord | null = null;
  const ctx: RelayLeaseCheckpointContext = {
    sessionOf: (id) => (id === DEVICE_A ? "aaaaaaaaaaaaaaaaaaaaaa" : id === DEVICE_B ? "bbbbbbbbbbbbbbbbbbbbbb" : null),
    isActive: (id) => id === DEVICE_A || id === DEVICE_B,
    currentHolder: () => ({ holder: DEVICE_A, epoch: 1 }),
    latestEpoch: () => 1,
    storedCheckpoint: () => stored,
    async storeCheckpoint(_name, record) {
      stored = record;
    },
    now: () => clock,
    ...overrides,
  };
  return { ctx, getStored: () => stored, setStored: (next: RelayLeaseCheckpointRecord | null) => (stored = next) };
}

async function createRoomWithTwoActiveDevices() {
  const storage = memoryStorage();
  const room = createRelayAccountRoom({ accountId, relayOrigin: RELAY_ORIGIN, storage, now: () => clock });
  expect(await room.register(LOGIN, registerRequest(ids.a))).not.toHaveProperty("error");
  expect(await room.register(LOGIN, registerRequest(ids.b))).not.toHaveProperty("error");
  expect(await room.register(LOGIN, registerRequest(ids.c))).not.toHaveProperty("error");
  const a = await connect(room, ids.a, accountId);
  await a.send({ type: "device.activate", id: DEVICE_B });
  const b = await connect(room, ids.b, accountId);
  const c = await connect(room, ids.c, accountId);
  return { storage, room, a, b, c };
}

describe("Relay lease checkpoint protocol and route parsing", () => {
  it("validates PUT requests and rejects malformed, unknown-key, or oversized ciphertexts", () => {
    expect(parseRelayLeaseCheckpointPut({ epoch: 2, seq: 5, ciphertext: VALID_CIPHERTEXT })).toEqual({
      epoch: 2,
      seq: 5,
      ciphertext: VALID_CIPHERTEXT,
    });
    expect(parseRelayLeaseCheckpointPut({ epoch: 2, seq: 5, ciphertext: VALID_CIPHERTEXT, extra: true })).toBeNull();
    expect(parseRelayLeaseCheckpointPut({ epoch: -1, seq: 1, ciphertext: VALID_CIPHERTEXT })).toBeNull();
    expect(parseRelayLeaseCheckpointPut({ epoch: 1, seq: 0, ciphertext: VALID_CIPHERTEXT })).toBeNull();
    expect(parseRelayLeaseCheckpointPut({ epoch: 1, seq: 1, ciphertext: "not-a-v1-envelope" })).toBeNull();
    const oversized = `v1.AAAAAAAAAAAAAAAA.${"A".repeat(RELAY_LEASE_CHECKPOINT_MAX_BYTES)}`;
    expect(parseRelayLeaseCheckpointPut({ epoch: 1, seq: 1, ciphertext: oversized })).toBeNull();
  });

  it("validates GET and PUT checkpoint responses including null and populated records", () => {
    expect(parseRelayLeaseCheckpointResponse({ checkpoint: null })).toEqual({ checkpoint: null });
    const record: RelayLeaseCheckpointRecord = {
      epoch: 3,
      seq: 9,
      updatedAt: clock,
      writer: DEVICE_A,
      ciphertext: VALID_CIPHERTEXT,
    };
    expect(parseRelayLeaseCheckpointResponse({ checkpoint: record } satisfies RelayLeaseCheckpointPutResponse)).toEqual({ checkpoint: record });
    const conflictSample: RelayLeaseCheckpointConflictError = { error: "stale_epoch", currentEpoch: 2 };
    expect(conflictSample.error).toBe("stale_epoch");
    expect(parseRelayLeaseCheckpointResponse({ checkpoint: { ...record, writer: "not-a-uuid" } })).toBeNull();
    expect(parseRelayLeaseCheckpointResponse({ unexpected: true })).toBeNull();
  });

  it("parses only valid /v1/accounts/:account/leases/:name/checkpoint paths", () => {
    expect(parseLeaseCheckpointRoute(RELAY_PATHS.leaseCheckpoint(accountId, "feishu"))).toEqual({
      accountId,
      leaseName: "feishu",
    });
    expect(parseLeaseCheckpointRoute(`/v1/accounts/${accountId}/leases/unknown/checkpoint`)).toBeNull();
    expect(parseLeaseCheckpointRoute("/v1/accounts/bad-account/leases/feishu/checkpoint")).toBeNull();
    expect(parseLeaseCheckpointRoute(`/v1/accounts/${accountId}/leases/feishu/checkpoint/extra`)).toBeNull();
  });
});

describe("Relay lease checkpoint room auth, epoch fencing, and hibernation persistence", () => {
  it("enforces active-session auth, holder epoch fencing, and lexicographic (epoch, seq) ordering", async () => {
    const { ctx } = makeContext();
    expect(readLeaseCheckpoint(ctx, { name: "feishu", device: DEVICE_A, session: "wrong_session_token_00" })).toEqual({
      ok: false,
      status: 401,
      error: "unauthorized",
    });
    expect(
      readLeaseCheckpoint(
        makeContext({ isActive: () => false }).ctx,
        { name: "feishu", device: DEVICE_A, session: "aaaaaaaaaaaaaaaaaaaaaa" },
      ),
    ).toEqual({ ok: false, status: 403, error: "not_active" });
    expect(readLeaseCheckpoint(ctx, { name: "feishu", device: DEVICE_A, session: "aaaaaaaaaaaaaaaaaaaaaa" })).toEqual({
      ok: true,
      checkpoint: null,
    });

    const first = await writeLeaseCheckpoint(ctx, {
      name: "feishu",
      device: DEVICE_A,
      session: "aaaaaaaaaaaaaaaaaaaaaa",
      request: { epoch: 1, seq: 1, ciphertext: VALID_CIPHERTEXT },
    });
    expect(first).toEqual({
      ok: true,
      checkpoint: { epoch: 1, seq: 1, updatedAt: clock, writer: DEVICE_A, ciphertext: VALID_CIPHERTEXT },
    });

    const staleSeq = await writeLeaseCheckpoint(ctx, {
      name: "feishu",
      device: DEVICE_A,
      session: "aaaaaaaaaaaaaaaaaaaaaa",
      request: { epoch: 1, seq: 1, ciphertext: VALID_CIPHERTEXT },
    });
    expect(staleSeq).toEqual({ ok: false, status: 409, error: "stale_seq", currentSeq: 1 });

    const { ctx: handoffCtx, setStored } = makeContext({
      currentHolder: () => ({ holder: DEVICE_B, epoch: 2 }),
      latestEpoch: () => 2,
    });
    setStored({ epoch: 1, seq: 4, updatedAt: clock, writer: DEVICE_A, ciphertext: VALID_CIPHERTEXT });

    const staleEpoch = await writeLeaseCheckpoint(handoffCtx, {
      name: "feishu",
      device: DEVICE_A,
      session: "aaaaaaaaaaaaaaaaaaaaaa",
      request: { epoch: 1, seq: 5, ciphertext: VALID_CIPHERTEXT },
    });
    expect(staleEpoch).toEqual({ ok: false, status: 409, error: "stale_epoch", currentEpoch: 2 });

    // A new epoch holder may reset seq (for example after secret rotation) because (2, 1) > (1, 4).
    const nextEpoch = await writeLeaseCheckpoint(handoffCtx, {
      name: "feishu",
      device: DEVICE_B,
      session: "bbbbbbbbbbbbbbbbbbbbbb",
      request: { epoch: 2, seq: 1, ciphertext: VALID_CIPHERTEXT },
    });
    expect(nextEpoch).toEqual({
      ok: true,
      checkpoint: { epoch: 2, seq: 1, updatedAt: clock, writer: DEVICE_B, ciphertext: VALID_CIPHERTEXT },
    });
  });

  it("allows yielding holder flush before lease.release, rejects stale writes after takeover, and survives reload", async () => {
    const { storage, room, a, b, c } = await createRoomWithTwoActiveDevices();
    await a.send({ type: "lease.claim", name: "feishu" });
    const grantA = a.socket.last("lease")!.grant!;
    expect(grantA.holder).toBe(DEVICE_A);
    expect(grantA.epoch).toBe(1);

    // Pending device C cannot read or write checkpoints.
    expect(await room.getLeaseCheckpoint({ name: "feishu", device: DEVICE_C, session: c.session })).toEqual({
      ok: false,
      status: 403,
      error: "not_active",
    });

    // Priority switches to B -> A receives lease.yield while still holding epoch 1.
    await a.send({ type: "priority.set", priority: [DEVICE_B, DEVICE_A] });
    await b.send({ type: "lease.claim", name: "feishu" });
    expect(a.socket.last("lease.yield")).toEqual({ type: "lease.yield", name: "feishu", epoch: 1 });

    // Yielding holder A flushes its final checkpoint before releasing epoch 1.
    const flushed = await room.putLeaseCheckpoint({
      name: "feishu",
      device: DEVICE_A,
      session: a.session,
      request: { epoch: 1, seq: 7, ciphertext: VALID_CIPHERTEXT },
    });
    expect(flushed).toMatchObject({ ok: true, checkpoint: { epoch: 1, seq: 7, writer: DEVICE_A, ciphertext: VALID_CIPHERTEXT } });

    // Now A releases epoch 1 and B receives epoch 2.
    await a.send({ type: "lease.release", name: "feishu", epoch: 1 });
    const grantB = b.socket.last("lease")!.grant!;
    expect(grantB.holder).toBe(DEVICE_B);
    expect(grantB.epoch).toBe(2);

    // B reads the exact checkpoint flushed by A, while stale A is fenced with 409 stale_epoch.
    expect(await room.getLeaseCheckpoint({ name: "feishu", device: DEVICE_B, session: b.session })).toEqual(flushed);
    expect(
      await room.putLeaseCheckpoint({
        name: "feishu",
        device: DEVICE_A,
        session: a.session,
        request: { epoch: 1, seq: 8, ciphertext: VALID_CIPHERTEXT },
      }),
    ).toEqual({ ok: false, status: 409, error: "stale_epoch", currentEpoch: 2 });

    // Reloading into a fresh room (simulating Durable Object hibernation) retains the checkpoint and sends zero unknown v1 WS frames.
    const restored = createRelayAccountRoom({ accountId, relayOrigin: RELAY_ORIGIN, storage, now: () => clock });
    const b2 = await connect(restored, ids.b, accountId);
    expect(RELAY_PROTOCOL_VERSION).toBe(1);
    expect(await restored.getLeaseCheckpoint({ name: "feishu", device: DEVICE_B, session: b2.session })).toMatchObject({
      ok: true,
      checkpoint: { epoch: 1, seq: 7, ciphertext: VALID_CIPHERTEXT },
    });
  });
});

describe("Relay HTTP checkpoint routes on Node relay and Cloudflare Worker", () => {
  it("serves GET/PUT checkpoint over HTTP on Node relay and persists across restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-checkpoint-node-"));
    const dbFile = join(dir, "relay.sqlite");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const relay = await startNodeRelay({
      port: 0,
      dbFile,
      fetch: async () => new Response(JSON.stringify({ id: 1001, login: "octo" }), { status: 200 }),
      now: () => clock,
    });
    cleanups.push(() => relay.close());

    const origin = `http://127.0.0.1:${relay.port}`;
    const reg = registerRequest(ids.a);
    const signedBody = {
      ...reg,
      signature: ids.a.sign(
        new TextEncoder().encode(["fusa-relay-register", RELAY_PROTOCOL_VERSION, origin, "github", DEVICE_A, ids.a.fingerprint].join("\n")),
      ),
    };
    const regRes = await fetch(`${origin}${RELAY_PATHS.register}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signedBody),
    });
    expect(regRes.status).toBe(200);

    // Unauthenticated GET returns 401 rather than 404 or 426.
    const unauth = await fetch(
      `${origin}${RELAY_PATHS.leaseCheckpoint(accountId, "feishu")}?device=${DEVICE_A}&session=aaaaaaaaaaaaaaaaaaaaaa`,
    );
    expect(unauth.status).toBe(401);
  });

  it("rate limits Cloudflare checkpoint routes by CF-Connecting-IP only and ignores spoofed X-Forwarded-For", async () => {
    const workerMod = (await import(WORKER_URL)) as WorkerModule;
    let forwardedCount = 0;
    const fakeEnv = {
      PUBLIC_ORIGIN: RELAY_ORIGIN,
      ACCOUNTS: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async () => {
            forwardedCount++;
            return new Response(JSON.stringify({ checkpoint: null }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      },
    };
    const url = `${RELAY_ORIGIN}${RELAY_PATHS.leaseCheckpoint(accountId, "feishu")}?device=${DEVICE_A}&session=aaaaaaaaaaaaaaaaaaaaaa`;
    for (let i = 0; i < RELAY_CHECKPOINT_PER_IP_PER_MINUTE; i++) {
      const res = await workerMod.handleRelayRequest(
        new Request(url, {
          method: "GET",
          headers: {
            "cf-connecting-ip": "203.0.113.42",
            "x-forwarded-for": `198.51.100.${i % 250}`,
          },
        }),
        fakeEnv,
      );
      expect(res.status).toBe(200);
    }
    const blocked = await workerMod.handleRelayRequest(
      new Request(url, {
        method: "GET",
        headers: {
          "cf-connecting-ip": "203.0.113.42",
          "x-forwarded-for": "198.51.100.251",
        },
      }),
      fakeEnv,
    );
    expect(blocked.status).toBe(429);
    expect(forwardedCount).toBe(RELAY_CHECKPOINT_PER_IP_PER_MINUTE);
  });
});
