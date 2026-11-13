// 联机端到端（docs/multi-device-design.md 第 10 节“端到端”）：两个真守护进程（端口 0、不同数据目录），本机回环网址当设备网址（测试入口 LOOPBACK_MAIN）。
// 走网页“设置 → 设备”用的那几个接口：邀请、添加、改名、移除；经入口给第二台发消息、看到回复；第二台停掉 → 离线；
// 再起来（换了端口）→ 它上线时同步过来新网址，经入口自动恢复、带 since 补齐。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_PATHS,
  PEER_DEVICE_HEADER,
  devicePath,
  type DeviceInfo,
  type DeviceInviteResponse,
  type DevicesResponse,
  type StateSnapshot,
  type WsServerMessage,
} from "../../src/shared/index.ts";
import { Client, LOOPBACK_MAIN, agentTexts, makeEnv, waitUntil, type E2eEnv, type RunningDaemon } from "./harness.ts";

let envs: E2eEnv[] = [];
afterEach(async () => {
  await Promise.all(envs.map((e) => e.cleanup()));
  envs = [];
});

async function boot(env: E2eEnv) {
  const daemon = await env.start({ main: LOOPBACK_MAIN });
  const client = await Client.login(daemon);
  const device = JSON.parse(readFileSync(join(env.home, "state", "device.json"), "utf8")) as { id: string; name: string };
  return { daemon, client, id: device.id };
}

async function terminate(daemon: RunningDaemon) {
  daemon.child.kill("SIGTERM");
  return daemon.exited;
}

async function devices(client: Client): Promise<DeviceInfo[]> {
  const res = await client.get(API_PATHS.devices);
  expect(res.status).toBe(200);
  return ((await res.json()) as DevicesResponse).devices;
}

async function send(client: Client, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(client.base + path, {
    method,
    headers: client.headers(body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** 经入口连别的设备的变化推送。 */
async function remoteWs(client: Client, deviceId: string, since: number) {
  const url = `ws://${new URL(client.base).host}${devicePath(deviceId, API_PATHS.ws)}?since=${since}`;
  const socket = new WebSocket(url, { headers: client.headers() });
  const messages: WsServerMessage[] = [];
  socket.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data)) as WsServerMessage));
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (e) => resolve(e.code)));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket error")));
  });
  return { messages, closed, close: () => socket.close() };
}

describe.skipIf(process.platform === "win32")("联机：回环网址", () => {
  it("正式入口不认回环网址：旧的环境变量开关打不开（只有测试入口能开）", async () => {
    const env = makeEnv();
    envs.push(env);
    const daemon = await env.start({ env: { AGENT_HUB_ALLOW_LOOPBACK_PEERS: "1" } });
    const client = await Client.login(daemon);
    const invite = (await (await send(client, "POST", API_PATHS.deviceInvites)).json()) as DeviceInviteResponse;
    expect(invite.url).toBeNull();
    const res = await send(client, "POST", API_PATHS.devices, { url: "http://127.0.0.1:1", code: "x" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("tailnet");
  }, 30_000);
});

describe.skipIf(process.platform === "win32")("联机：两台守护进程", () => {
  it("配对 → 经入口聊天 → 第二台离线 → 再上线自动恢复并补齐 → 改名 → 移除", async () => {
    const envA = makeEnv();
    const envB = makeEnv();
    envs.push(envA, envB);
    envB.setScript({ defaultTurn: { steps: [{ text: "东京收到" }] } });
    const a = await boot(envA);
    let b = await boot(envB);

    // 1. 邀请（B 上）→ 添加（A 上），和网页“设置 → 设备”一样
    const inviteRes = await send(b.client, "POST", API_PATHS.deviceInvites);
    expect(inviteRes.status).toBe(201);
    const invite = (await inviteRes.json()) as DeviceInviteResponse;
    expect(invite.url).toBe(`http://127.0.0.1:${b.daemon.port}`);
    const added = await send(a.client, "POST", API_PATHS.devices, { url: invite.url, code: invite.code });
    expect(added.status, await added.clone().text()).toBe(201);
    expect(((await added.json()) as DeviceInfo).id).toBe(b.id);
    expect((await devices(a.client)).map((d) => d.id)).toEqual([a.id, b.id]);
    await waitUntil("B 确认配对", async () => ((await devices(b.client)).some((d) => d.id === a.id) ? true : undefined));
    // 令牌只存哈希：A 文件里 B 的那把明文，不在 B 的文件里
    const peersOf = (env: E2eEnv) => JSON.parse(readFileSync(join(env.home, "state", "peers.json"), "utf8")) as { devices: Array<{ outboundToken: string }> };
    const aToB = peersOf(envA).devices[0]!.outboundToken;
    expect(readFileSync(join(envB.home, "state", "peers.json"), "utf8")).not.toContain(aToB);

    // 2. 经入口：拉 B 的快照、开 B 的变化推送、给 B 的项目经理发消息、看到 B 的回复
    const stateRes = await a.client.get(devicePath(b.id, API_PATHS.state));
    expect(stateRes.status).toBe(200);
    const bState = (await stateRes.json()) as StateSnapshot;
    const conversationId = bState.conversations[0]!.conversation.id;
    const ws = await remoteWs(a.client, b.id, bState.seq);
    const post = await send(a.client, "POST", devicePath(b.id, API_PATHS.messages(conversationId)), { clientId: crypto.randomUUID(), text: "你好东京" });
    expect(post.status).toBe(200);
    await waitUntil("B 的回复经入口推过来", () => (ws.messages.some((m) => JSON.stringify(m).includes("东京收到")) ? true : undefined), 15_000);
    expect(agentTexts((await (await a.client.get(devicePath(b.id, API_PATHS.state))).json()) as StateSnapshot, conversationId)).toContain("东京收到");
    expect(envA.stdinTexts()).toEqual([]);
    const lastSeq = Math.max(...ws.messages.map((m) => (m as { seq?: number }).seq ?? 0));

    // 3. B 停掉：经入口的推送断开，接口回 502 device_offline
    expect(await terminate(b.daemon)).toEqual({ code: 0, signal: null });
    await ws.closed;
    const offline = await a.client.get(devicePath(b.id, API_PATHS.state));
    expect(offline.status).toBe(502);
    expect(((await offline.json()) as { code: string }).code).toBe("device_offline");

    // 4. B 再起来（端口变了）：它上线时把自己的新网址同步给 A；A 经入口带 since 补齐
    b = await boot(envB);
    await waitUntil("A 收到 B 的新网址", async () => ((await devices(a.client)).find((d) => d.id === b.id)?.url === `http://127.0.0.1:${b.daemon.port}` ? true : undefined));
    const again = await remoteWs(a.client, b.id, lastSeq);
    const post2 = await send(a.client, "POST", devicePath(b.id, API_PATHS.messages(conversationId)), { clientId: crypto.randomUUID(), text: "又来了" });
    expect(post2.status).toBe(200);
    await waitUntil("恢复后又收到回复", () => (again.messages.filter((m) => JSON.stringify(m).includes("东京收到")).length > 0 ? true : undefined), 15_000);
    again.close();

    // 5. 改名：在 A 上给 B 改名，名字改在 B 那里，两边都看到
    const renamed = await send(a.client, "PATCH", API_PATHS.device(b.id), { name: "东京" });
    expect(renamed.status).toBe(200);
    expect((await devices(b.client))[0]!.name).toBe("东京");
    expect((await devices(a.client)).find((d) => d.id === b.id)!.name).toBe("东京");
    expect(JSON.parse(readFileSync(join(envB.home, "state", "device.json"), "utf8"))).toEqual({ id: b.id, name: "东京" });

    // 6. 移除：两边都删，A 的旧令牌 B 不再认
    expect((await send(a.client, "DELETE", API_PATHS.device(b.id))).status).toBe(204);
    expect((await devices(a.client)).map((d) => d.id)).toEqual([a.id]);
    await waitUntil("B 也删掉 A", async () => ((await devices(b.client)).length === 1 ? true : undefined));
    const stale = await fetch(`http://127.0.0.1:${b.daemon.port}${API_PATHS.state}`, { headers: { authorization: `Bearer ${aToB}`, [PEER_DEVICE_HEADER]: a.id } });
    expect(stale.status).toBe(401);
    expect((await a.client.get(devicePath(b.id, API_PATHS.state))).status).toBe(404);
  }, 60_000);
});
