import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeishuDriver, FEISHU_REFRESH_EXPIRED, FeishuApiError, FeishuGuardError, isRecalled, visibleText, writeDriverSecrets, type DriverSecrets } from "./feishu-driver.ts";
import { TESTER_FEISHU_TOKEN_SKEW_MS } from "./limits.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  token: string | null;
  body: Record<string, unknown> | null;
}

interface FakeFeishu {
  calls: Call[];
  fetch: typeof fetch;
  messages: Record<string, unknown[]>;
  onRefresh?: (secretsOnDisk: DriverSecrets) => void;
  refreshError?: { code: number };
  diskAtSend?: DriverSecrets;
}

function fakeFeishu(secretsFile: string): FakeFeishu {
  const state: FakeFeishu = { calls: [], messages: {}, fetch: undefined as unknown as typeof fetch };
  const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
  state.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? null;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    state.calls.push({ method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, token, body });
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-tenant", expire: 7200 }));
    if (url.pathname === "/open-apis/authen/v2/oauth/token") {
      if (state.refreshError) return new Response(JSON.stringify({ code: state.refreshError.code, error: "invalid_grant" }), { status: 400 });
      state.onRefresh?.(JSON.parse(readFileSync(secretsFile, "utf8")) as DriverSecrets);
      return new Response(JSON.stringify({ code: 0, access_token: "u-new", expires_in: 7200, refresh_token: "r-new", refresh_token_expires_in: 365 * 24 * 3600 }));
    }
    if (url.pathname === "/open-apis/im/v1/chats") return ok({ items: [{ chat_id: "oc_group", description: "PM group\nfusa:dev_mac:pm:7" }, { chat_id: "oc_other", description: "" }], has_more: false });
    if (url.pathname === "/open-apis/im/v1/chats/oc_router") return ok({ chat_mode: "p2p" });
    if (url.pathname.startsWith("/open-apis/im/v1/chats/")) return new Response(JSON.stringify({ code: 232011, msg: "not in chat" }), { status: 400 });
    if (url.pathname === "/open-apis/im/v1/messages" && init?.method === "POST") {
      state.diskAtSend = JSON.parse(readFileSync(secretsFile, "utf8")) as DriverSecrets;
      return ok({ message_id: "om_sent" });
    }
    if (url.pathname === "/open-apis/im/v1/messages") {
      const all = state.messages[url.searchParams.get("container_id")!] ?? [];
      const page = Number(url.searchParams.get("page_token") || "0");
      return ok({ items: all.slice(page, page + 1), has_more: page + 1 < all.length, page_token: String(page + 1) });
    }
    if (url.pathname.startsWith("/open-apis/im/v1/messages/")) {
      const id = url.pathname.split("/").at(-1);
      const found = Object.values(state.messages).flat().find((m) => (m as { message_id: string }).message_id === id);
      return ok({ items: found ? [found] : [] });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return state;
}

function setup(tokens: Partial<DriverSecrets["tokens"]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tester-feishu-"));
  dirs.push(dir);
  const botSecretsFile = join(dir, "feishu-secrets.json");
  writeFileSync(botSecretsFile, JSON.stringify({ brand: "feishu", appId: "cli_test", appSecret: "bot-secret" }));
  const driverSecretsFile = join(dir, "feishu-driver.json");
  writeDriverSecrets(driverSecretsFile, { appSecret: "driver-secret", tokens: { accessToken: "u-old", accessExpiresAt: NOW + HOUR, refreshToken: "r-old", refreshExpiresAt: NOW + 300 * 24 * HOUR, ...tokens } });
  const feishu = fakeFeishu(driverSecretsFile);
  let now = NOW;
  const options = { driverAppId: "cli_driver", driverSecretsFile, testBotAppId: "cli_test", botSecretsFile, routerChatIds: async () => ["oc_router", "oc_foreign"], fetch: feishu.fetch, now: () => now };
  return { dir, feishu, options, driverSecretsFile, advance: (ms: number) => (now += ms) };
}

const raw = (id: string, chat: string, sender: "user" | "app", senderId: string, at: number, content: unknown, extra: Record<string, unknown> = {}) => ({
  message_id: id,
  chat_id: chat,
  msg_type: "interactive",
  create_time: String(at),
  update_time: String(at),
  sender: { id: senderId, sender_type: sender },
  body: { content: JSON.stringify(content) },
  ...extra,
});

describe("createFeishuDriver", () => {
  it("refreshes the user token when it expires within TESTER_FEISHU_TOKEN_SKEW_MS", async () => {
    const fresh = setup();
    await createFeishuDriver(fresh.options);
    expect(fresh.feishu.calls.some((c) => c.path === "/open-apis/authen/v2/oauth/token")).toBe(false);
    const stale = setup({ accessExpiresAt: NOW + TESTER_FEISHU_TOKEN_SKEW_MS - 1 });
    await createFeishuDriver(stale.options);
    const refresh = stale.feishu.calls.find((c) => c.path === "/open-apis/authen/v2/oauth/token")!;
    expect(refresh.body).toEqual({ grant_type: "refresh_token", client_id: "cli_driver", client_secret: "driver-secret", refresh_token: "r-old" });
  });

  it("retries the refresh lock when its owner releases it before the age check", async () => {
    const s = setup({ accessExpiresAt: NOW });
    const lock = `${s.driverSecretsFile}.lock`;
    writeFileSync(lock, "");
    const now = vi.fn(s.options.now)
      .mockImplementationOnce(s.options.now)
      .mockImplementationOnce(s.options.now)
      .mockImplementationOnce(() => {
        rmSync(lock);
        return NOW;
      });
    await expect(createFeishuDriver({ ...s.options, now })).resolves.toBeDefined();
    expect(s.feishu.calls.filter((c) => c.path === "/open-apis/authen/v2/oauth/token")).toHaveLength(1);
  });

  it("writes the rotated refresh token to disk before using the new access token", async () => {
    const s = setup({ accessExpiresAt: NOW });
    const driver = await createFeishuDriver(s.options);
    await driver.sendAsUser("oc_group", "hi");
    const saved = JSON.parse(readFileSync(s.driverSecretsFile, "utf8")) as DriverSecrets;
    expect(saved.tokens).toMatchObject({ accessToken: "u-new", refreshToken: "r-new", accessExpiresAt: NOW + 7200 * 1000 });
    const send = s.feishu.calls.find((c) => c.method === "POST" && c.path === "/open-apis/im/v1/messages")!;
    expect(send.token).toBe("u-new");
    expect(s.feishu.diskAtSend?.tokens?.refreshToken).toBe("r-new");
    const refreshIndex = s.feishu.calls.findIndex((c) => c.path === "/open-apis/authen/v2/oauth/token");
    expect(s.feishu.calls.findIndex((c) => c.token === "u-new")).toBeGreaterThan(refreshIndex);
  });

  it("keeps the secrets file at mode 0600", async () => {
    const s = setup({ accessExpiresAt: NOW });
    await createFeishuDriver(s.options);
    expect(statSync(s.driverSecretsFile).mode & 0o777).toBe(0o600);
  });

  it("reports refresh token expiry (code 20037) as a FeishuApiError", async () => {
    const expired = setup({ accessExpiresAt: NOW, refreshExpiresAt: NOW - 1 });
    await expect(createFeishuDriver(expired.options)).rejects.toMatchObject({ code: FEISHU_REFRESH_EXPIRED });
    const revoked = setup({ accessExpiresAt: NOW });
    revoked.feishu.refreshError = { code: FEISHU_REFRESH_EXPIRED };
    await expect(createFeishuDriver(revoked.options)).rejects.toBeInstanceOf(FeishuApiError);
    expect((JSON.parse(readFileSync(revoked.driverSecretsFile, "utf8")) as DriverSecrets).tokens!.refreshToken).toBe("r-old");
  });

  it("refuses a bot secrets file that holds another app", async () => {
    const s = setup();
    await expect(createFeishuDriver({ ...s.options, testBotAppId: "cli_other" })).rejects.toBeInstanceOf(FeishuGuardError);
  });
});

describe("sendAsUser", () => {
  it("refuses a chat the test bot is not a member of with FeishuGuardError", async () => {
    const s = setup();
    const driver = await createFeishuDriver(s.options);
    await expect(driver.sendAsUser("oc_owner_real_group", "hi")).rejects.toBeInstanceOf(FeishuGuardError);
    await expect(driver.sendAsUser("oc_foreign", "hi")).rejects.toBeInstanceOf(FeishuGuardError);
    expect(s.feishu.calls.some((c) => c.method === "POST" && c.path === "/open-apis/im/v1/messages")).toBe(false);
  });

  it("sends with the user token and returns the stored message id", async () => {
    const s = setup();
    const driver = await createFeishuDriver(s.options);
    expect(await driver.sendAsUser("oc_router", "hello")).toBe("om_sent");
    const send = s.feishu.calls.find((c) => c.method === "POST" && c.path === "/open-apis/im/v1/messages")!;
    expect(send).toMatchObject({ token: "u-old", body: { receive_id: "oc_router", msg_type: "text", content: JSON.stringify({ text: "hello" }) } });
    expect(send.query.get("receive_id_type")).toBe("chat_id");
  });
});

describe("listMessages and waitForBotMessage", () => {
  it("reads with the test bot's tenant token and asks for the original card JSON", async () => {
    const s = setup();
    s.feishu.messages.oc_group = [raw("om_1", "oc_group", "app", "cli_test", NOW, { body: { elements: [] } })];
    await (await createFeishuDriver(s.options)).listMessages("oc_group", NOW - 1000);
    const list = s.feishu.calls.find((c) => c.method === "GET" && c.path === "/open-apis/im/v1/messages")!;
    expect(list.token).toBe("t-tenant");
    expect(list.query.get("card_msg_content_type")).toBe("user_card_content");
    expect(list.query.get("sort_type")).toBe("ByCreateTimeAsc");
  });

  it("returns deleted messages with deleted=true", async () => {
    const s = setup();
    s.feishu.messages.oc_group = [raw("om_1", "oc_group", "app", "cli_test", NOW, {}, { deleted: true })];
    const [m] = await (await createFeishuDriver(s.options)).listMessages("oc_group", NOW - 1000);
    expect(m).toMatchObject({ messageId: "om_1", deleted: true, senderType: "app", senderId: "cli_test" });
  });

  it("pages oldest first until no more pages remain", async () => {
    const s = setup();
    s.feishu.messages.oc_group = [1, 2, 3].map((i) => raw(`om_${i}`, "oc_group", "user", "ou_owner", NOW + i, {}));
    const list = await (await createFeishuDriver(s.options)).listMessages("oc_group", NOW);
    expect(list.map((m) => m.messageId)).toEqual(["om_1", "om_2", "om_3"]);
  });

  it("resolves with the first test bot message after the given one that satisfies the predicate", async () => {
    const s = setup();
    s.feishu.messages.oc_group = [
      raw("om_before", "oc_group", "app", "cli_test", NOW - 10, { text: "old" }),
      raw("om_sent", "oc_group", "user", "ou_owner", NOW, { text: "hi" }),
      raw("om_other_bot", "oc_group", "app", "cli_other", NOW + 1, { text: "done" }),
      raw("om_streaming", "oc_group", "app", "cli_test", NOW + 2, { text: "partial" }),
      raw("om_done", "oc_group", "app", "cli_test", NOW + 3, { text: "done" }),
    ];
    const driver = await createFeishuDriver(s.options);
    const hit = await driver.waitForBotMessage("oc_group", "om_sent", (m) => visibleText(m) === "done", 5_000);
    expect(hit.messageId).toBe("om_done");
  });

  it("rejects on timeout with the messages seen so far", async () => {
    const s = setup();
    s.feishu.messages.oc_group = [raw("om_sent", "oc_group", "user", "ou_owner", NOW, { text: "hi" })];
    const driver = await createFeishuDriver(s.options);
    const pending = driver.waitForBotMessage("oc_group", "om_sent", () => true, 0);
    await expect(pending).rejects.toMatchObject({ seen: [expect.objectContaining({ messageId: "om_sent" })] });
  });
});

describe("testChats", () => {
  it("lists the router chat and project groups with device and PM parsed from the group description marker", async () => {
    const s = setup();
    const chats = await (await createFeishuDriver(s.options)).testChats();
    expect(chats).toEqual([
      { chatId: "oc_router", kind: "router" },
      { chatId: "oc_group", kind: "project", deviceId: "dev_mac", pmId: 7 },
      { chatId: "oc_other", kind: "project" },
    ]);
  });
});

describe("isRecalled and visibleText", () => {
  it("treats deleted messages and the recalled placeholder as recalled", () => {
    expect(isRecalled({ deleted: true, content: "{}" })).toBe(true);
    expect(isRecalled({ deleted: false, content: JSON.stringify({ text: "This message was recalled" }) })).toBe(true);
    expect(isRecalled({ deleted: false, content: JSON.stringify({ text: "该消息已撤回" }) })).toBe(true);
    expect(isRecalled({ deleted: false, content: JSON.stringify({ text: "hello" }) })).toBe(false);
  });

  it("extracts card body text and plain text, and returns empty text for media", () => {
    const card = { schema: "2.0", config: { summary: { content: "Done" } }, body: { elements: [{ tag: "markdown", content: "**Done** with `x`" }, { tag: "button", text: { tag: "plain_text", content: "停止" } }] } };
    expect(visibleText({ msgType: "interactive", content: JSON.stringify(card) })).toBe("Done\nDone with x\n停止");
    expect(visibleText({ msgType: "text", content: JSON.stringify({ text: "plain" }) })).toBe("plain");
    expect(visibleText({ msgType: "post", content: JSON.stringify({ title: "T", content: [[{ tag: "text", text: "a" }, { tag: "text", text: "b" }]] }) })).toBe("a\nb");
    expect(visibleText({ msgType: "image", content: JSON.stringify({ image_key: "img" }) })).toBe("");
  });
});
