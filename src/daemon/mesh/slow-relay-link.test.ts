import { createServer as createHttpServer, request as httpRequest, type Agent } from "node:http";
import { connect as netConnect, createServer as createNetServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceId } from "../../shared/api.ts";
import { MESH_HANDSHAKE_TIMEOUT_MS } from "../../shared/limits.ts";
import type { AccountId, MeshDeviceState } from "../../shared/mesh.ts";
import { createMeshDialer, startMeshListener, type MeshDialer } from "./dialer.ts";
import type { MeshIdentity } from "./identity.ts";
import { createRelayClient, registerWithRelay, type RelayClient } from "./relay-client.ts";
import { DEVICE_A, DEVICE_B, fakeGithubFetch, makeIdentity, startTestRelay, tempDir, waitFor } from "./test-helpers.ts";
import { openMeshTrust } from "./trust.ts";

vi.mock("../../shared/limits.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/limits.ts")>()),
  MESH_HANDSHAKE_TIMEOUT_MS: 500,
  MESH_DIAL_TIMEOUT_MS: 4_000,
}));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A relay front that holds back the data channel `slowDevice` opens until `peer`'s channel has been open for twice the handshake timeout, like a link where each new relay connection takes seconds. */
async function startSlowChannelProxy(slowDevice: DeviceId, peer: DeviceId): Promise<{ url: string; setTarget(port: number): void; held(): number }> {
  let target = 0;
  let held = 0;
  let peerChannelOpened = () => {};
  const peerChannel = new Promise<void>((resolve) => (peerChannelOpened = resolve));
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  };
  const server = createNetServer((client) => {
    track(client);
    client.once("data", (head: Buffer) => {
      client.pause();
      const request = head.toString("latin1");
      if (request.includes(`device=${peer}`)) peerChannelOpened();
      const slow = request.includes(`device=${slowDevice}`);
      if (slow) held++;
      const release = slow ? peerChannel.then(() => delay(2 * MESH_HANDSHAKE_TIMEOUT_MS)) : Promise.resolve();
      void release.then(() => {
        if (client.destroyed) return;
        const upstream = netConnect(target, "127.0.0.1");
        track(upstream);
        upstream.write(head);
        client.pipe(upstream).pipe(client);
        client.once("close", () => upstream.destroy());
        upstream.once("close", () => client.destroy());
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        peerChannelOpened();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, setTarget: (port) => (target = port), held: () => held };
}

interface RelayOnlyNode {
  identity: MeshIdentity;
  relay: RelayClient;
  dialer: MeshDialer;
  self: MeshDeviceState | null;
}

async function relayOnlyNode(identity: MeshIdentity, peer: MeshIdentity, relayUrl: string, accountId: AccountId): Promise<RelayOnlyNode> {
  const trust = openMeshTrust(join(tempDir(), "peers.json"), identity, { name: identity.deviceId.slice(0, 4), platform: "linux" });
  trust.add({ id: peer.deviceId, name: peer.deviceId.slice(0, 4), platform: "linux", certPem: peer.certPem, approvedBy: null });
  const relay = createRelayClient({ relayUrl, accountId, identity, candidates: () => [], log: () => {} });
  const http = createHttpServer((req, res) => res.end(`hello from ${identity.deviceId.slice(0, 4)} ${req.url}`));
  const listener = await startMeshListener({ identity, trust, relay, port: 0, host: "127.0.0.1", onConnection: (c) => http.emit("connection", c.socket), log: () => {} });
  const dialer = createMeshDialer({ identity, trust, relay, candidatesOf: () => [], log: () => {} });
  const node: RelayOnlyNode = { identity, relay, dialer, self: null };
  relay.on("self", (state) => (node.self = state));
  cleanups.push(async () => {
    dialer.close();
    await listener.close();
    await relay.close();
    http.close();
  });
  return node;
}

/** Device A reaches the relay over a slow link and device B over a fast one, and both are active, relay-only peers. */
async function slowAndFastPeers(): Promise<{ slow: RelayOnlyNode; fast: RelayOnlyNode; proxy: Awaited<ReturnType<typeof startSlowChannelProxy>> }> {
  const proxy = await startSlowChannelProxy(DEVICE_A, DEVICE_B);
  const relay = await startTestRelay({ publicOrigin: proxy.url });
  proxy.setTarget(Number(new URL(relay.url).port));
  const [a, b] = [await makeIdentity(DEVICE_A), await makeIdentity(DEVICE_B)];
  const register = (identity: MeshIdentity) =>
    registerWithRelay({ relayUrl: proxy.url, githubToken: "tok_alice", identity, device: { id: identity.deviceId, name: identity.deviceId.slice(0, 4), platform: "linux" }, fetch: fakeGithubFetch });
  const { accountId } = await register(a);
  await register(b);
  const slow = await relayOnlyNode(a, b, proxy.url, accountId);
  const fast = await relayOnlyNode(b, a, proxy.url, accountId);
  slow.relay.start();
  await waitFor(() => slow.relay.state() === "connected");
  slow.relay.send({ type: "device.activate", id: DEVICE_B });
  fast.relay.start();
  await waitFor(() => fast.relay.state() === "connected" && fast.self === "active");
  return { slow, fast, proxy };
}

const get = (agent: Agent, path: string) =>
  new Promise<string>((resolve, reject) => {
    const req = httpRequest({ agent, host: "mesh", path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });

describe("relay dial over a link where every new relay connection is slow", () => {
  it("connects when the dialer's own channel reaches the relay after the acceptor's handshake window", async () => {
    const { slow, proxy } = await slowAndFastPeers();

    expect(await get(slow.dialer.agentFor(DEVICE_B), "/digest")).toBe(`hello from ${DEVICE_B.slice(0, 4)} /digest`);
    expect(proxy.held()).toBe(1);
    expect(slow.dialer.linkOf(DEVICE_B)).toBe("relay");
  });
});
