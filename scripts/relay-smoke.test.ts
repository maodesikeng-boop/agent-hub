import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { startNodeRelay, type RunningNodeRelay } from "../src/relay/node/server.ts";
import { encodeRelayFrame, newRelayToken, parseRelayClientFrame, RELAY_PATHS, RELAY_PROTOCOL_VERSION } from "../src/relay/protocol.ts";
import { parseSmokeCliArgs, runRelaySmoke, waitForRelayHealth } from "./relay-smoke.ts";

describe("scripts/relay-smoke.ts", () => {
  const dirs: string[] = [];
  const nodeRelays: RunningNodeRelay[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const relay of nodeRelays.splice(0)) await relay.close();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("parses CLI arguments and falls back to RELAY_SMOKE_URL", () => {
    expect(parseSmokeCliArgs(["--url", "https://bellwood-relay-staging.bellwood-mesh.workers.dev/path", "--expect-sha", "abc123", "--wait-ms", "15000"])).toEqual({
      kind: "run",
      options: {
        relayUrl: "https://bellwood-relay-staging.bellwood-mesh.workers.dev",
        expectSha: "abc123",
        waitMs: 15000,
        timeoutMs: 10_000,
      },
    });
    expect(parseSmokeCliArgs([], { RELAY_SMOKE_URL: "https://relay.example" })).toEqual({
      kind: "run",
      options: { relayUrl: "https://relay.example", waitMs: 0, timeoutMs: 10_000 },
    });
    expect(parseSmokeCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(() => parseSmokeCliArgs([])).toThrow(/Missing --url/);
    expect(() => parseSmokeCliArgs(["--url", "ftp://relay.example"])).toThrow(/Unsupported relay protocol/);
    expect(() => parseSmokeCliArgs(["--url", "https://relay.example", "--wait-ms=-1"])).toThrow(/Invalid --wait-ms/);
    expect(() => parseSmokeCliArgs(["--url", "https://relay.example", "--timeout-ms=0"])).toThrow(/Invalid --timeout-ms/);
  });

  it("polls /health until the expected buildSha is served", async () => {
    let calls = 0;
    let fakeNow = 1000;
    const delays: number[] = [];
    const fakeFetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response("starting", { status: 503 });
      if (calls === 2) {
        return Response.json({
          ok: true,
          service: "bellwood-relay",
          protocolVersion: RELAY_PROTOCOL_VERSION,
          buildSha: "old-sha",
          versionId: "v1",
          deployedAt: null,
        });
      }
      return Response.json({
        ok: true,
        service: "bellwood-relay",
        protocolVersion: RELAY_PROTOCOL_VERSION,
        buildSha: "new-sha",
        versionId: "v2",
        deployedAt: "2026-11-23T00:00:00Z",
      });
    }) as unknown as typeof fetch;

    const health = await waitForRelayHealth({
      origin: "https://relay.example",
      expectSha: "new-sha",
      waitMs: 5000,
      timeoutMs: 2000,
      fetch: fakeFetch,
      sleep: async (ms) => {
        delays.push(ms);
        fakeNow += ms;
      },
      now: () => fakeNow,
    });
    expect(calls).toBe(3);
    expect(delays).toEqual([1000, 1000]);
    expect(health.buildSha).toBe("new-sha");
  });

  it("verifies all HTTP and WebSocket smoke checks against an HTTP+WS relay contract server", async () => {
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === RELAY_PATHS.health) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        if (req.method === "HEAD") return res.end();
        return res.end(
          JSON.stringify({
            ok: true,
            service: "bellwood-relay",
            protocolVersion: RELAY_PROTOCOL_VERSION,
            buildSha: "smoke-sha-1234",
            versionId: "ver-test",
            deployedAt: "2026-11-23T00:00:00Z",
          }),
        );
      }
      if (req.method === "POST" && path === RELAY_PATHS.register) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "bad_frame" }));
      }
      if (path.endsWith("/control")) {
        res.writeHead(426, { "content-type": "application/json", upgrade: "websocket" });
        return res.end(JSON.stringify({ error: "upgrade_required" }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not_found" }));
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path.includes("/channels/")) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(encodeRelayFrame({ type: "challenge", nonce: newRelayToken() }));
        ws.on("message", (raw) => {
          const parsed = parseRelayClientFrame(raw.toString("utf8"));
          expect(parsed?.type).toBe("hello");
          ws.send(encodeRelayFrame({ type: "error", code: "unknown_device" }));
          ws.close(1008, "unknown_device");
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    servers.push(server);

    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const report = await runRelaySmoke({ relayUrl: origin, expectSha: "smoke-sha-1234" });
    expect(report.origin).toBe(origin);
    expect(report.health.buildSha).toBe("smoke-sha-1234");
    expect(report.checks).toHaveLength(7);

    await expect(runRelaySmoke({ relayUrl: origin, expectSha: "wrong-sha" })).rejects.toThrow(/expected wrong-sha/);
  });

  it("exposes GET and HEAD /health on the Node relay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-smoke-node-"));
    dirs.push(dir);
    const relay = await startNodeRelay({
      port: 0,
      dbFile: join(dir, "relay.sqlite"),
      buildSha: "node-sha-5678",
    });
    nodeRelays.push(relay);
    const origin = `http://127.0.0.1:${relay.port}`;

    const healthRes = await fetch(`${origin}/health`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("cache-control")).toBe("no-store");
    expect(await healthRes.json()).toEqual({
      ok: true,
      service: "bellwood-relay",
      protocolVersion: RELAY_PROTOCOL_VERSION,
      buildSha: "node-sha-5678",
      versionId: null,
      deployedAt: null,
    });
    const headRes = await fetch(`${origin}/health`, { method: "HEAD" });
    expect(headRes.status).toBe(200);
  });
});
