import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { WS_HEARTBEAT_TEXT } from "../shared/index.ts";
import { keepAlive } from "./ws-keepalive.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** 起一个只做保活的服务端，连一个客户端上去。autoPong: false 模拟连接静默断了（对方不回 pong）。 */
async function connect(intervalMs: number, autoPong = true) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => keepAlive(socket, intervalMs));
  cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
  const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, { autoPong });
  cleanups.push(() => client.terminate());
  const frames: string[] = [];
  client.on("message", (data) => frames.push(String(data)));
  const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
  await new Promise((resolve) => client.once("open", resolve));
  return { wss, client, frames, closed };
}

describe("keepAlive：给浏览器那条 WebSocket 保活", () => {
  it("每隔 intervalMs 发一条应用层心跳（浏览器的 JS 收不到 ping，靠它知道连接还通）", async () => {
    const { frames } = await connect(40);
    await expect.poll(() => frames.length, { timeout: 2_000 }).toBeGreaterThanOrEqual(3);
    expect(new Set(frames)).toEqual(new Set([WS_HEARTBEAT_TEXT]));
    expect(Buffer.byteLength(WS_HEARTBEAT_TEXT)).toBeLessThanOrEqual(24);
  });

  it("对方一直回 pong：连接留着", async () => {
    const { wss, frames } = await connect(40);
    await expect.poll(() => frames.length, { timeout: 2_000 }).toBeGreaterThanOrEqual(5);
    expect(wss.clients.size).toBe(1);
  });

  it("上一次 ping 没回 pong（连接静默断了）：服务端断掉这条，不再占着监听", async () => {
    const { wss, closed } = await connect(40, false);
    expect(await closed).toBe(1006);
    await expect.poll(() => wss.clients.size).toBe(0);
  });

  it("连接关了：不再发（定时器跟着停）", async () => {
    const { wss, client, closed } = await connect(40);
    const [server] = [...wss.clients];
    const sent: unknown[] = [];
    const send = server!.send.bind(server);
    server!.send = ((...args: Parameters<typeof send>) => {
      sent.push(args[0]);
      return send(...args);
    }) as typeof send;
    client.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sent).toEqual([]);
  });
});
