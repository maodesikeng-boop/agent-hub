// 账号组网端到端（docs/account-mesh-design.md「验收方法」）：本机起一个 Node 中继和三个真守护进程（端口 0、各自数据目录、假的 GitHub 接口）。
// 取代 multi-device.test.ts（邀请码配对那一套随旧配对一起删）。
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startNodeRelay, type RunningNodeRelay } from "../../src/relay/node/server.ts";
import {
  API_PATHS,
  ENV_RELAY_URL,
  MESH_LEASE_TTL_MS,
  devicePath,
  type AccountStatusView,
  type DeviceInfo,
  type DevicesResponse,
  type StateSnapshot,
  type WsServerMessage,
} from "../../src/shared/index.ts";
import { startFakeGithub, type FakeGithub } from "./fake-github.ts";
import { Client, MESH_MAIN, agentTexts, makeEnv, shortTmp, waitUntil, type E2eEnv, type RunningDaemon } from "./harness.ts";

interface NodeHandle {
  env: E2eEnv;
  daemon: RunningDaemon;
  client: Client;
  id: string;
  lan: boolean;
}

describe("账号组网", () => {
  let scratch = "";
  let relayDb = "";
  let github: FakeGithub;
  let relay: RunningNodeRelay;
  let relayUrl = "";
  const relayFrames: Buffer[] = [];
  const relayLogs: string[] = [];
  const envs: E2eEnv[] = [];
  let nodeA: NodeHandle;
  let nodeB: NodeHandle;
  let nodeC: NodeHandle;

  const daemonEnv = (lan: boolean) => ({
    [ENV_RELAY_URL]: relayUrl,
    FUSA_TEST_GITHUB: github.origin,
    FUSA_TEST_LAN: lan ? "1" : "0",
  });

  async function bootNode(env: E2eEnv, lan: boolean): Promise<NodeHandle> {
    const daemon = await env.start({ main: MESH_MAIN, env: daemonEnv(lan) });
    const client = await Client.login(daemon);
    const dev = JSON.parse(readFileSync(join(env.home, "state", "device.json"), "utf8")) as { id: string };
    return { env, daemon, client, id: dev.id, lan };
  }

  async function accountOf(client: Client): Promise<AccountStatusView> {
    const res = await client.get(API_PATHS.account);
    expect(res.status).toBe(200);
    return (await res.json()) as AccountStatusView;
  }

  async function devicesOf(client: Client): Promise<DeviceInfo[]> {
    const res = await client.get(API_PATHS.devices);
    expect(res.status).toBe(200);
    return ((await res.json()) as DevicesResponse).devices;
  }

  async function approveJoiner(approver: NodeHandle, joiner: NodeHandle): Promise<void> {
    await waitUntil("approver sees pending request", async () => {
      const s = await accountOf(approver.client);
      return s.state === "signed_in" && s.approvals.some((a) => a.requestId === joiner.id) ? true : undefined;
    });
    const beginRes = await approver.client.postJson(API_PATHS.accountApprovalBegin(joiner.id), {});
    expect(beginRes.status).toBe(200);
    const sas = await waitUntil("both screens display matching 6-digit SAS", async () => {
      const [sa, sj] = await Promise.all([accountOf(approver.client), accountOf(joiner.client)]);
      const codeA = sa.state === "signed_in" ? sa.approvals.find((a) => a.requestId === joiner.id)?.sas : null;
      const codeJ = sj.state === "awaiting_approval" ? sj.approval?.sas : null;
      if (!codeA || !codeJ) return undefined;
      expect(codeA).toMatch(/^\d{6}$/);
      expect(codeJ).toBe(codeA);
      return codeA;
    });
    expect(sas).toHaveLength(6);

    const [ansJ, ansA] = await Promise.all([
      joiner.client.postJson(API_PATHS.accountApprovalAnswer(approver.id), { match: true }),
      approver.client.postJson(API_PATHS.accountApprovalAnswer(joiner.id), { match: true }),
    ]);
    expect(ansJ.status).toBe(200);
    expect(ansA.status).toBe(200);
    await waitUntil("joiner becomes signed_in", async () => ((await accountOf(joiner.client)).state === "signed_in" ? true : undefined));
  }

  async function remoteWs(client: Client, deviceId: string, since: number) {
    const url = `ws://${new URL(client.base).host}${devicePath(deviceId, API_PATHS.ws)}?since=${since}`;
    const socket = new WebSocket(url, { headers: client.headers() });
    const messages: WsServerMessage[] = [];
    socket.addEventListener("message", (e) => {
      const raw = String(e.data);
      if (raw !== "ping" && raw.startsWith("{")) messages.push(JSON.parse(raw) as WsServerMessage);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("remote websocket error")));
    });
    return { messages, close: () => socket.close() };
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(shortTmp(), "ah-mesh-"));
    relayDb = join(scratch, "relay.sqlite");
    github = await startFakeGithub();
    relay = await startNodeRelay({
      port: 0,
      dbFile: relayDb,
      githubApiOrigin: github.origin,
      debugFrames: true,
      log: (line) => relayLogs.push(line),
      onDataFrame: (bytes) => relayFrames.push(Buffer.from(bytes)),
    });
    relayUrl = `http://127.0.0.1:${relay.port}`;

    const envA = makeEnv();
    const envB = makeEnv();
    const envC = makeEnv();
    envs.push(envA, envB, envC);
    envB.setScript({ defaultTurn: { steps: [{ text: "第二台回复-B778" }] } });
    envC.setScript({ defaultTurn: { steps: [{ text: "第三台回复-C778" }] } });

    [nodeA, nodeB, nodeC] = await Promise.all([
      bootNode(envA, true),
      bootNode(envB, true),
      bootNode(envC, false),
    ]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all(envs.map((e) => e.cleanup()));
    await relay?.close();
    await github?.close();
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  });

  it("三台登录同一账号：第一台直接可用，后两台等批准，核对码一致、两边点一致后出现在三台的设备列表里", async () => {
    expect((await nodeA.client.postJson(API_PATHS.accountLogin, {})).status).toBe(200);
    await waitUntil("A direct signed_in", async () => ((await accountOf(nodeA.client)).state === "signed_in" ? true : undefined));

    expect((await nodeB.client.postJson(API_PATHS.accountLogin, {})).status).toBe(200);
    expect((await nodeC.client.postJson(API_PATHS.accountLogin, {})).status).toBe(200);
    await waitUntil("B awaiting_approval", async () => ((await accountOf(nodeB.client)).state === "awaiting_approval" ? true : undefined));
    await waitUntil("C awaiting_approval", async () => ((await accountOf(nodeC.client)).state === "awaiting_approval" ? true : undefined));

    await approveJoiner(nodeA, nodeB);
    await approveJoiner(nodeA, nodeC);

    const expectedIds = [nodeA.id, nodeB.id, nodeC.id].sort();
    for (const node of [nodeA, nodeB, nodeC]) {
      await waitUntil(`${node.id} sees all 3 devices`, async () => {
        const list = await devicesOf(node.client);
        return list.map((d) => d.id).sort().join(",") === expectedIds.join(",") ? true : undefined;
      });
    }
  });

  it("从第一台的网页经 /d/ 打开另外两台的对话、发消息、收到回复", async () => {
    for (const [peer, secretText, expectedReply] of [
      [nodeB, "发给第二台的明文-B9527", "第二台回复-B778"],
      [nodeC, "发给第三台的密文测试-C9527", "第三台回复-C778"],
    ] as const) {
      const stateRes = await nodeA.client.get(devicePath(peer.id, API_PATHS.state));
      expect(stateRes.status).toBe(200);
      const snap = (await stateRes.json()) as StateSnapshot;
      const convId = snap.conversations[0]!.conversation.id;
      const ws = await remoteWs(nodeA.client, peer.id, snap.seq);
      try {
        const postRes = await nodeA.client.postJson(devicePath(peer.id, API_PATHS.messages(convId)), {
          clientId: crypto.randomUUID(),
          text: secretText,
        });
        expect(postRes.status).toBe(200);
        await waitUntil(`reply from ${peer.id}`, () => (ws.messages.some((m) => JSON.stringify(m).includes(expectedReply)) ? true : undefined), 15_000);
        const updated = (await (await nodeA.client.get(devicePath(peer.id, API_PATHS.state))).json()) as StateSnapshot;
        expect(agentTexts(updated, convId)).toContain(expectedReply);
      } finally {
        ws.close();
      }
    }
  });

  it("回环地址当局域网候选时连法是 lan，屏蔽候选后是 relay，功能一样", async () => {
    const list = await devicesOf(nodeA.client);
    const viewA = list.find((d) => d.id === nodeA.id);
    const viewB = list.find((d) => d.id === nodeB.id);
    const viewC = list.find((d) => d.id === nodeC.id);
    expect(viewA).toMatchObject({ self: true, online: true, link: "local" });
    expect(viewB).toMatchObject({ self: false, online: true, link: "lan" });
    expect(viewC).toMatchObject({ self: false, online: true, link: "relay" });
  });

  it("停掉一台，另两台 MESH_LEASE_TTL_MS 内显示离线；再起来自动恢复", async () => {
    const stoppedAt = Date.now();
    await nodeB.daemon.terminate();
    for (const watcher of [nodeA, nodeC]) {
      await waitUntil(
        `${watcher.id} sees B offline`,
        async () => ((await devicesOf(watcher.client)).find((d) => d.id === nodeB.id)?.online === false ? true : undefined),
        MESH_LEASE_TTL_MS,
      );
    }
    expect(Date.now() - stoppedAt).toBeLessThanOrEqual(MESH_LEASE_TTL_MS);
    const offlineRes = await nodeA.client.get(devicePath(nodeB.id, API_PATHS.state));
    expect(offlineRes.status).toBe(502);

    nodeB = await bootNode(nodeB.env, true);
    for (const watcher of [nodeA, nodeC]) {
      await waitUntil(`${watcher.id} sees B online again`, async () =>
        (await devicesOf(watcher.client)).find((d) => d.id === nodeB.id)?.online === true ? true : undefined,
      );
    }
    const recovered = await nodeA.client.get(devicePath(nodeB.id, API_PATHS.state));
    expect(recovered.status).toBe(200);
  });

  it("移除一台后它的请求被拒，它自己回到未登录", async () => {
    const delRes = await fetch(nodeA.client.base + API_PATHS.device(nodeC.id), {
      method: "DELETE",
      headers: nodeA.client.headers(),
    });
    expect(delRes.status).toBe(204);

    await waitUntil("B drops C from device list", async () =>
      !(await devicesOf(nodeB.client)).some((d) => d.id === nodeC.id) ? true : undefined,
    );
    await waitUntil("C returns to signed_out", async () => ((await accountOf(nodeC.client)).state === "signed_out" ? true : undefined));
    expect(existsSync(join(nodeC.env.home, "state", "account.json"))).toBe(false);

    const afterRemove = await nodeA.client.get(devicePath(nodeC.id, API_PATHS.state));
    expect(afterRemove.status).toBe(404);
  });

  it("中继只见到 TLS 记录：自建中继的数据帧首字节都是 0x17 或握手记录，搜不到消息正文", () => {
    expect(relayFrames.length).toBeGreaterThan(0);
    const validTlsContentTypes = new Set([0x14, 0x15, 0x16, 0x17]);
    const bad = relayFrames.filter((f) => !validTlsContentTypes.has(f[0]!)).map((f) => `${f.length}B:${f.subarray(0, 8).toString("hex")}`);
    expect(bad, relayLogs.filter((l) => l.startsWith("数据帧")).join("\n")).toEqual([]);
    expect(relayFrames.some((f) => f[0] === 0x17)).toBe(true);
    expect(relayLogs.some((l) => l.startsWith("数据帧 ") && l.includes("头8B: 17 "))).toBe(true);

    const combinedWire = Buffer.concat(relayFrames).toString("utf8");
    const dbRaw = readFileSync(relayDb, "utf8");
    for (const secret of ["发给第二台的明文-B9527", "第二台回复-B778", "发给第三台的密文测试-C9527", "第三台回复-C778"]) {
      expect(combinedWire).not.toContain(secret);
      expect(dbRaw).not.toContain(secret);
    }
  });
});

describe("全账号一个飞书机器人（假飞书传输层）", () => {
  it.todo("只有中心顺序排第一的在线设备连长连接");
  it.todo("发到第二台项目群的消息进第二台的账本，只一次");
  it.todo("停掉持有者，MESH_LEASE_TTL_MS + MESH_LEASE_RENEW_MS 内下一台持有并接着收");
  it.todo("排前的设备回来后租约让回给它，期间不丢消息");
  it.todo("第二台离线时群里立刻回离线提示并暂存，第二台上线后送达");
  it.todo("飞书凭证在一台接入后出现在另外两台，中继的日志和存储里搜不到 App Secret");
});
