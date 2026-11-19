// 转发上传到别的设备（比如跨境 SSH 隧道后面的“东京”）：等响应头的时限不能把上传请求体的时间也算进去。
// 时限换成 1 秒（vi.mock），不然要等真的 30 秒。
import { randomUUID } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS } from "../../shared/index.ts";
import type { PeerRecord } from "./store.ts";
import { sleep, startTestDevice, type TestDevice } from "./test-helpers.ts";
import { newPeerToken, sha256Hex } from "./tokens.ts";

const TIMEOUT_MS = vi.hoisted(() => 1_000);
vi.mock("../../shared/index.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), PEER_PROXY_HEADERS_TIMEOUT_MS: TIMEOUT_MS }));

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 假的对方：每 stepMs 才读一块请求体（上行慢），读完才回响应头；stallAfter 块之后再也不读。被取消时像 undici 一样取消请求体。 */
const slowPeer = (stepMs: number, stallAfter = Infinity) =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
    const aborted = new Promise<never>((_ok, fail) =>
      init!.signal!.addEventListener("abort", () => void reader.cancel().finally(() => fail(new Error("aborted"))), { once: true }),
    );
    let received = 0;
    for (let chunks = 0; ; chunks++) {
      if (chunks >= stallAfter) await aborted;
      await Promise.race([sleep(stepMs), aborted]);
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
    }
    return new Response(JSON.stringify({ received }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

async function entryWith(fetch: typeof globalThis.fetch): Promise<{ device: TestDevice; peer: PeerRecord }> {
  const peer: PeerRecord = { id: randomUUID(), name: "东京", platform: "linux", url: "http://127.0.0.1:9", state: "paired", since: Date.now(), inboundTokenSha256: sha256Hex(newPeerToken()), outboundToken: newPeerToken() };
  const device = await startTestDevice({ seed: [peer], serverOptions: { peerProxy: { fetch } } });
  cleanups.push(() => device.close());
  return { device, peer };
}

const upload = ({ device, peer }: { device: TestDevice; peer: PeerRecord }, data: Buffer) =>
  fetch(`${device.url}/d/${peer.id}${API_PATHS.uploads}?name=clip.mp4`, {
    method: "POST",
    headers: { cookie: device.cookie, origin: device.url, "content-type": "application/octet-stream" },
    body: data,
  });

describe("转发上传到慢链路上的设备", () => {
  it("视频传得比等响应头的时限还久，但一直在传：照常转完，不当成对方离线", async () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 1);
    const started = Date.now();
    const res = await upload(await entryWith(slowPeer(60)), data);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ received: data.length });
    expect(Date.now() - started).toBeGreaterThan(TIMEOUT_MS);
  });

  it("对方没读完请求体就回了 413：回完关掉这条连接", async () => {
    const early413 = (async () => new Response(JSON.stringify({ error: "文件太大" }), { status: 413, headers: { "content-type": "application/json" } })) as typeof fetch;
    const { device, peer } = await entryWith(early413);
    const url = new URL(`${device.url}/d/${peer.id}${API_PATHS.uploads}?name=clip.mp4`);
    // fetch 会在连接被关时报 ECONNRESET 丢掉响应，这里直接用 node:http 读响应头
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: { cookie: device.cookie, origin: device.url, "content-type": "application/octet-stream", "content-length": String(64 * 1024 * 1024) } }, resolve);
      req.on("error", () => {});
      req.once("close", () => reject(new Error("没拿到响应")));
      req.write(Buffer.alloc(1024 * 1024, 1));
    });
    expect(response.statusCode).toBe(413);
    expect(response.headers.connection).toBe("close");
    response.destroy();
  });

  it("请求体传到一半就不动了：过了时限回 502 离线", async () => {
    const res = await upload(await entryWith(slowPeer(10, 2)), Buffer.alloc(2 * 1024 * 1024, 1));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("device_offline");
  });

  it("请求体传完了对方迟迟不回：过了时限回 502 离线", async () => {
    const never = (async (_u: string | URL | Request, init?: RequestInit) => {
      const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
      while (!(await reader.read()).done);
      return new Promise<never>((_ok, fail) => init!.signal!.addEventListener("abort", () => fail(new Error("aborted"))));
    }) as typeof fetch;
    const res = await upload(await entryWith(never), Buffer.alloc(1024));
    expect(res.status).toBe(502);
  });
});
