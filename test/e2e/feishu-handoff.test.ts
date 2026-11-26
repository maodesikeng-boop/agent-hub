import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startNodeRelay } from "../../src/relay/node/server.ts";
import { API_PATHS, ENV_RELAY_URL, MESH_LEASE_TTL_MS, type AccountStatusView, type DeviceId, type FeishuStatusView } from "../../src/shared/index.ts";
import { E2E_FEISHU_OWNER, startFakeFeishuHub, type FakeFeishuHub } from "./fake-feishu-hub.ts";
import { startFakeGithub } from "./fake-github.ts";
import { Client, makeEnv, MESH_MAIN, shortTmp, waitUntil, type E2eEnv } from "./harness.ts";

async function boot(env: E2eEnv, config: Record<string, string>) {
  const daemon = await env.start({ main: MESH_MAIN, env: config });
  const client = await Client.login(daemon);
  const { id } = JSON.parse(readFileSync(join(env.home, "state", "device.json"), "utf8")) as { id: DeviceId };
  return { daemon, client, id };
}

type Device = Awaited<ReturnType<typeof boot>>;

async function account({ client }: Device): Promise<AccountStatusView> {
  return (await client.get(API_PATHS.account)).json() as Promise<AccountStatusView>;
}

async function approve(first: Device, second: Device) {
  await waitUntil("Tokyo receives Mac's join request", async () => {
    const state = await account(first);
    return state.state === "signed_in" && state.approvals.some((item) => item.requestId === second.id) ? true : undefined;
  });
  expect((await first.client.postJson(API_PATHS.accountApprovalBegin(second.id), {})).status).toBe(200);
  await waitUntil("both devices show the same pairing code", async () => {
    const [a, b] = await Promise.all([account(first), account(second)]);
    const code = a.state === "signed_in" ? a.approvals.find((item) => item.requestId === second.id)?.sas : null;
    return code && b.state === "awaiting_approval" && code === b.approval?.sas ? true : undefined;
  });
  for (const [device, peer] of [[first, second], [second, first]] as const) {
    expect((await device.client.postJson(API_PATHS.accountApprovalAnswer(peer.id), { match: true })).status).toBe(200);
  }
  await waitUntil("Mac signs in", async () => (await account(second)).state === "signed_in" ? true : undefined);
}

async function routerChat({ client }: Device) {
  const state = await (await client.get(API_PATHS.feishu)).json() as FeishuStatusView;
  return state.chats.find((chat) => chat.target.kind === "router")?.chatId;
}

async function commands({ client }: Device) {
  return (await client.snapshot()).router.commands.map((command) => command.clientId);
}

async function waitForHub(device: Device, label: string, hub: FakeFeishuHub) {
  await waitUntil(`${label} is the only Feishu hub`, async () => {
    const [active, ...others] = hub.activeDevices();
    const state = await account(device);
    return state.state === "signed_in" && state.feishuHolder === device.id && active === device.id && others.length === 0 ? true : undefined;
  }, MESH_LEASE_TTL_MS);
}

const dm = (chatId: string, messageId: string, content: string) => ({
  type: "im.message.receive_v1" as const,
  chatType: "p2p" as const,
  senderType: "user" as const,
  senderOpenId: E2E_FEISHU_OWNER,
  messageId, chatId, content,
  createTime: Date.now(),
  mentionedBot: false,
  threadId: null,
  resources: [],
});

it("processes each Router message once across Tokyo → Mac → Tokyo with a Node relay", async () => {
  const scratch = mkdtempSync(join(shortTmp(), "ah-feishu-"));
  const github = await startFakeGithub();
  const hub = await startFakeFeishuHub();
  const relay = await startNodeRelay({ port: 0, dbFile: join(scratch, "relay.sqlite"), githubApiOrigin: github.origin });
  const tokyoEnv = makeEnv();
  const macEnv = makeEnv();
  const config = { [ENV_RELAY_URL]: `http://127.0.0.1:${relay.port}`, FUSA_TEST_GITHUB: github.origin, FUSA_TEST_FEISHU: hub.origin, FUSA_TEST_LAN: "0" };
  try {
    tokyoEnv.setScript({ defaultTurn: { steps: [{ text: "Tokyo Router response" }] } });
    macEnv.setScript({ defaultTurn: { steps: [{ text: "Mac Router response" }] } });
    let tokyo = await boot(tokyoEnv, config);
    const mac = await boot(macEnv, config);
    expect((await tokyo.client.postJson(API_PATHS.accountLogin, {})).status).toBe(200);
    await waitUntil("Tokyo signs in", async () => (await account(tokyo)).state === "signed_in" ? true : undefined);
    expect((await mac.client.postJson(API_PATHS.accountLogin, {})).status).toBe(200);
    await approve(tokyo, mac);
    expect((await tokyo.client.putJson(API_PATHS.accountPriority, { priority: [tokyo.id, mac.id] })).status).toBe(200);
    for (const { client } of [tokyo, mac]) {
      expect((await client.putJson(API_PATHS.routerSettings, { vendor: "claude", model: null, effort: null })).status).toBe(200);
    }
    expect((await tokyo.client.postJson(API_PATHS.feishuRegistration, {})).status).toBe(200);
    await waitForHub(tokyo, "Tokyo", hub);
    const chatId = await waitUntil("Tokyo binds the Router chat", () => routerChat(tokyo));
    await waitUntil("Mac receives the shared Feishu bot", async () => {
      const status = await (await mac.client.get(API_PATHS.feishu)).json() as FeishuStatusView;
      return status.state === "connected" ? true : undefined;
    });
    const first = dm(chatId, "om_tokyo_first", "First Router request");
    hub.fake.recordMessage(first);
    const replies = () => hub.fake.sent.filter((row) => row.chatId === chatId);
    const beforeM1 = replies().length;
    hub.pushEvent(first);
    await waitUntil("Tokyo posts M1's card", async () =>
      (await commands(tokyo)).includes(`feishu:${first.messageId}`) && replies().length === beforeM1 + 1 ? true : undefined);
    const second = dm(chatId, "om_mac_second", "Second Router request");
    hub.fake.beforeListMessages = async (request) => {
      if (request.container_id === chatId && hub.activeDevices().includes(mac.id)) {
        hub.fake.recordMessage(second);
        hub.fake.beforeListMessages = null;
      }
    };
    expect(await tokyo.daemon.terminate()).toEqual({ code: 0, signal: null });
    await waitForHub(mac, "Mac", hub);
    await waitUntil("Mac catches up M2 from Feishu history and posts a card", async () =>
      (await commands(mac)).includes(`feishu:${second.messageId}`) && replies().length >= beforeM1 + 2 ? true : undefined);
    expect(await commands(mac)).toEqual([`feishu:${second.messageId}`]);

    const readsBeforeReturn = hub.fake.callsOf("message.list").filter((call) => call.container_id === chatId).length;
    tokyo = await boot(tokyoEnv, config);
    await waitForHub(tokyo, "Tokyo after restart", hub);
    await waitUntil("Tokyo reads the shared Router history on return", () =>
      hub.fake.callsOf("message.list").filter((call) => call.container_id === chatId).length > readsBeforeReturn ? true : undefined);
    const barrier = dm(chatId, "om_tokyo_barrier", "Third Router request after Tokyo's catch-up");
    hub.pushEvent(barrier);
    await waitUntil("Tokyo processes the live request after its catch-up lane", async () =>
      (await commands(tokyo)).includes(`feishu:${barrier.messageId}`) && replies().length >= beforeM1 + 3 ? true : undefined);
    const result = { tokyo: await commands(tokyo), mac: await commands(mac), replyCards: replies().slice(beforeM1).map(({ messageId }) => messageId) };
    expect(result.tokyo).toEqual([`feishu:${barrier.messageId}`, `feishu:${first.messageId}`]);
    expect(result.mac).toEqual([`feishu:${second.messageId}`]);
    expect(result.replyCards).toHaveLength(3);
    expect(new Set(result.replyCards).size).toBe(3);
    console.info("Feishu hub handoff: Tokyo → Mac → Tokyo", JSON.stringify(result));
  } finally {
    await Promise.all([tokyoEnv.cleanup(), macEnv.cleanup()]);
    await Promise.all([hub.close(), relay.close(), github.close()]);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
