// 转发上传到别的设备（比如跨网经中继连上的远端设备）：等响应头的时限不能把上传请求体的时间也算进去。
// 时限换成 1 秒（vi.mock），不然要等真的 30 秒。
import { randomUUID } from "node:crypto";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS } from "../../shared/index.ts";
import { approveNode, loginNode, startTestMeshNode, startTestRelay, type TestMeshNode } from "../mesh/test-helpers.ts";
import { sleep, startTestDevice, type TestDevice } from "./test-helpers.ts";

const TIMEOUT_MS = vi.hoisted(() => 1_000);
vi.mock("../../shared/index.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), PEER_PROXY_HEADERS_TIMEOUT_MS: TIMEOUT_MS }));

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 假的对方：每 stepMs 才从组网流里读一块请求体（上行慢），读完才回响应头；stallAfter 块之后暂停再也不读。 */
function slowPeerHandler(stepMs: number, stallAfter = Infinity) {
  return (req: IncomingMessage, res: ServerResponse) => {
    req.pause();
    let received = 0;
    let chunks = 0;
    let timer: NodeJS.Timeout | null = null;
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const pull = () => {
      if (req.destroyed || res.destroyed) return;
      if (chunks >= stallAfter) return;
      timer = setTimeout(() => {
        timer = null;
        if (req.destroyed || res.destroyed) return;
        const chunk = req.read(16 * 1024) as Buffer | null;
        if (chunk !== null) {
          received += chunk.length;
          chunks++;
          pull();
          return;
        }
        if (req.readableEnded) return;
        req.once("readable", pull);
      }, stepMs);
    };
    req.once("end", () => {
      stop();
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ received }));
    });
    req.once("close", stop);
    pull();
  };
}

async function entryWith(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ device: TestDevice; peer: TestMeshNode }> {
  const relay = await startTestRelay();
  const device = await startTestDevice({ relay, lan: false });
  await loginNode(device);
  const peer = await startTestMeshNode(relay, randomUUID(), { lan: false, handler });
  await loginNode(peer);
  await approveNode(device, peer);
  cleanups.push(() => device.close());
  return { device, peer };
}

const upload = ({ device, peer }: { device: TestDevice; peer: TestMeshNode }, data: Buffer) =>
  fetch(`${device.url}/d/${peer.id}${API_PATHS.uploads}?name=clip.mp4`, {
    method: "POST",
    headers: { cookie: device.cookie, origin: device.url, "content-type": "application/octet-stream" },
    body: data,
  });

describe("转发上传到慢链路上的设备", () => {
  it("视频传得比等响应头的时限还久，但一直在传：照常转完，不当成对方离线", async () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 1);
    const started = Date.now();
    const res = await upload(await entryWith(slowPeerHandler(20)), data);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ received: data.length });
    expect(Date.now() - started).toBeGreaterThan(TIMEOUT_MS);
  });

  it("对方没读完请求体就回了 413：回完关掉这条连接", async () => {
    const early413 = (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 413;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "文件太大" }));
    };
    const { device, peer } = await entryWith(early413);
    const url = new URL(`${device.url}/d/${peer.id}${API_PATHS.uploads}?name=clip.mp4`);
    // fetch 会在连接被关时报 ECONNRESET 丢掉响应，这里直接用 node:http 读响应头
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: { cookie: device.cookie, origin: device.url, "content-type": "application/octet-stream", "content-length": String(64 * 1024 * 1024) } }, resolve);
      req.on("error", () => {});
      req.once("close", () => reject(new Error("没拿到响应")));
      // 只发一小块：一次写得完，不会在对方关连接后还往外写，触发 RST 冲掉还没读到的响应
      req.write(Buffer.alloc(1024, 1));
    });
    expect(response.statusCode).toBe(413);
    expect(response.headers.connection).toBe("close");
    response.destroy();
  });

  it("请求体传到一半就不动了：过了时限回 502 离线", async () => {
    const res = await upload(await entryWith(slowPeerHandler(10, 2)), Buffer.alloc(2 * 1024 * 1024, 1));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("device_offline");
  });

  it("请求体传完了对方迟迟不回：过了时限回 502 离线", async () => {
    const res = await upload(
      await entryWith((req) => {
        req.resume();
      }),
      Buffer.alloc(1024),
    );
    expect(res.status).toBe(502);
  });
});
