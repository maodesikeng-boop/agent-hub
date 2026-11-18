// 飞书设置接口 /api/feishu/*（docs/feishu-design.md）：本机网页能用，参数用 zod 校验，FeishuSetupError 回 400，没开飞书回 unavailable。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_PATHS, type FeishuStatusView } from "../../shared/index.ts";
import { FeishuSetupError, type FeishuSetupService } from "../feishu/setup.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { FakeLedger } from "./fake-ledger.ts";
import { createUiServer } from "./server.ts";
import { testLogin } from "./test-login.ts";

const PORT = 4000;
const db = openTestDb();
const HEADERS = { host: `127.0.0.1:${PORT}`, cookie: testLogin(db, PORT).cookie(), origin: `http://127.0.0.1:${PORT}` };
const STATUS: FeishuStatusView = {
  state: "unconfigured",
  brand: null,
  appId: null,
  botName: null,
  ownerOpenId: null,
  ownerName: null,
  registration: null,
  missing: [],
  lastError: null,
  chats: [],
};

let root: string;
let app: FastifyInstance;
let ledger: FakeLedger;
let calls: { method: string; input?: unknown }[];

const feishu: FeishuSetupService = {
  status: () => STATUS,
  startRegistration: async () => ({ ...STATUS, state: "registering", registration: { url: "https://x", expiresAt: 1 } }),
  cancelRegistration: () => STATUS,
  saveCredentials: async (input) => {
    calls.push({ method: "saveCredentials", input });
    if (input.appSecret === "wrong") throw new FeishuSetupError("凭证不对或应用不可用");
    return { ...STATUS, state: "connecting" };
  },
  issueBindCode: () => ({ code: "123456", expiresAt: 2 }),
  consumeBindCode: () => false,
  setChatPolicy: async (input) => {
    calls.push({ method: "setChatPolicy", input });
    return { chatId: "oc_1" as never, target: { kind: "pm", pmId: input.pmId }, name: "小林", mode: "solo", triggerMode: "auto", guestTier: input.guestTier ?? "chat_only", guestCount: 0, archived: false };
  },
  resync: async () => STATUS,
  disconnect: async (input) => {
    calls.push({ method: "disconnect", input });
    return STATUS;
  },
};

function build(withFeishu: boolean) {
  return createUiServer({
    ledger: ledger.asLedger(),
    token: "test-token-0123456789abcdef",
    staticDir: join(root, "no-static"),
    uploadsDir: join(root, "uploads"),
    sentFilesDir: join(root, "sent-files"),
    port: PORT,
    db,
    ...(withFeishu ? { feishu } : {}),
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "hub-feishu-api-"));
  calls = [];
  ledger = new FakeLedger();
  app = build(true);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

const send = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { ...HEADERS, ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });

describe("/api/feishu/*", () => {
  it("本机网页能看状态、开始和取消扫码、拿绑定码、对齐", async () => {
    expect((await send("GET", API_PATHS.feishu)).json()).toEqual(STATUS);
    expect((await send("POST", API_PATHS.feishuRegistration, {})).json()).toMatchObject({ state: "registering" });
    expect((await send("DELETE", API_PATHS.feishuRegistration)).json()).toEqual(STATUS);
    expect((await send("POST", API_PATHS.feishuBindCode, {})).json()).toEqual({ code: "123456", expiresAt: 2 });
    expect((await send("POST", API_PATHS.feishuResync, {})).statusCode).toBe(200);
  });

  it("手动接入：请求体用 zod 校验，凭证不对回 400 和原因", async () => {
    expect((await send("PUT", API_PATHS.feishuCredentials, { brand: "feishu", appId: "cli_a" })).statusCode).toBe(400);
    expect((await send("PUT", API_PATHS.feishuCredentials, { brand: "qq", appId: "cli_a", appSecret: "s" })).statusCode).toBe(400);
    const bad = await send("PUT", API_PATHS.feishuCredentials, { brand: "feishu", appId: "cli_a", appSecret: "wrong" });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toContain("凭证不对");
    expect((await send("PUT", API_PATHS.feishuCredentials, { brand: "lark", appId: " cli_a ", appSecret: "ok" })).json()).toMatchObject({ state: "connecting" });
    expect(calls.at(-1)).toEqual({ method: "saveCredentials", input: { brand: "lark", appId: "cli_a", appSecret: "ok" } });
  });

  it("改群策略：路径里是项目经理编号，至少给一个字段；断开要写明解不解散群", async () => {
    expect((await send("PUT", API_PATHS.feishuChatPolicy(3), {})).statusCode).toBe(400);
    expect((await send("PUT", API_PATHS.feishuChatPolicy(3), { guestTier: "boss" })).statusCode).toBe(400);
    expect((await send("PUT", API_PATHS.feishuChatPolicy(3), { guestTier: "observer" })).json()).toMatchObject({ guestTier: "observer" });
    expect(calls.at(-1)).toEqual({ method: "setChatPolicy", input: { pmId: 3, guestTier: "observer" } });
    expect((await send("POST", API_PATHS.feishuDisconnect, {})).statusCode).toBe(400);
    expect((await send("POST", API_PATHS.feishuDisconnect, { dissolveChats: true })).statusCode).toBe(200);
    expect(calls.at(-1)).toEqual({ method: "disconnect", input: { dissolveChats: true } });
  });

  it("网页发消息的接口带不进飞书来源：请求体里的 origin 被丢掉，账本收到的没有 origin（访客拦截只认飞书通道写的）", async () => {
    const origin = { kind: "feishu", openId: "ou_owner", name: "张三", role: "owner", mode: "solo", guestTier: "collaborator", context: [] };
    const res = await send("POST", "/api/conversations/1/messages", { clientId: "c1", text: "hi", origin });
    expect(res.statusCode).toBeLessThan(300);
    expect(ledger.posted).toHaveLength(1);
    expect(ledger.posted[0]).not.toHaveProperty("origin");
  });

  it("没开飞书时回 unavailable", async () => {
    await app.close();
    app = build(false);
    await app.ready();
    const res = await send("GET", API_PATHS.feishu);
    expect(res.json().code).toBe("unavailable");
  });
});
