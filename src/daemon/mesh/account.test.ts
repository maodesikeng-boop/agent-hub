import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAccountService, pollGithubDeviceToken, readAccountFile, requestGithubDeviceCode, writeAccountFile, type AccountFile, type AccountLoginState } from "./account.ts";
import { DEVICE_A, DEVICE_B, FAKE_GITHUB, fakeGithubFetch, makeIdentity, startTestRelay, tempDir, waitFor } from "./test-helpers.ts";

/** 假 GitHub 的设备码登录：按 script 依次回轮询结果。 */
function fakeGithubLogin(script: Array<Record<string, unknown>>, token = "tok_alice") {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${FAKE_GITHUB}/login/device/code`) {
      calls.push({ url, body: String(init?.body) });
      return Response.json({ device_code: "dev-code", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    }
    if (url === `${FAKE_GITHUB}/login/oauth/access_token`) {
      calls.push({ url, body: String(init?.body) });
      const next = script.shift() ?? { error: "authorization_pending" };
      return Response.json(next.access_token === "TOKEN" ? { access_token: token, token_type: "bearer", scope: "" } : next);
    }
    return fakeGithubFetch(input, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const account: AccountFile = {
  version: 1,
  relayUrl: "https://relay.test",
  accountId: "acct_abcdefghijklmnopqrstuvwxyz" as AccountFile["accountId"],
  login: { provider: "github", userId: "1", login: "alice" },
  state: "active",
};

async function service(script: Array<Record<string, unknown>>, options: { relayUrl?: string; githubClientId?: string; logs?: string[] } = {}) {
  const relay = options.relayUrl === undefined ? await startTestRelay() : null;
  const identity = await makeIdentity(DEVICE_A);
  const file = join(tempDir(), "account.json");
  const github = fakeGithubLogin(script);
  const logs = options.logs ?? [];
  const svc = createAccountService({
    file,
    identity,
    device: { id: DEVICE_A, name: "Mac", platform: "darwin" },
    relayUrl: options.relayUrl ?? relay!.url,
    githubClientId: options.githubClientId ?? "Iv1.public",
    fetch: github.fetchImpl,
    githubWebOrigin: FAKE_GITHUB,
    githubApiOrigin: FAKE_GITHUB,
    sleep: async (_ms, signal) => {
      await new Promise((r) => setTimeout(r, 1));
      if (signal.aborted) throw signal.reason;
    },
    log: (line) => logs.push(line),
  });
  const states: AccountLoginState[] = [];
  svc.onChange((s) => states.push(s));
  return { svc, file, github, relay, identity, states, logs };
}

describe("requestGithubDeviceCode / pollGithubDeviceToken", () => {
  it("请求设备码只带 client_id，不带 client_secret", async () => {
    const { fetchImpl, calls } = fakeGithubLogin([]);
    const code = await requestGithubDeviceCode("Iv1.public", { fetch: fetchImpl, webOrigin: FAKE_GITHUB, now: () => 1_000 });
    expect(code).toEqual({ deviceCode: "dev-code", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: 1_000 + 900_000, intervalMs: 5_000 });
    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get("client_id")).toBe("Iv1.public");
    expect(body.has("client_secret")).toBe(false);
    expect(body.get("scope")).toBe("");
  });

  it("authorization_pending、slow_down、access_denied、expired_token 各自分类", async () => {
    const { fetchImpl } = fakeGithubLogin([{ error: "authorization_pending" }, { error: "slow_down", interval: 10 }, { error: "access_denied" }, { error: "expired_token" }, { access_token: "TOKEN" }]);
    const poll = () => pollGithubDeviceToken("Iv1.public", "dev-code", { fetch: fetchImpl, webOrigin: FAKE_GITHUB });
    expect(await poll()).toEqual({ kind: "pending" });
    expect((await poll()).kind).toBe("slow_down");
    expect(await poll()).toEqual({ kind: "denied" });
    expect(await poll()).toEqual({ kind: "expired" });
    expect(await poll()).toEqual({ kind: "token", accessToken: "tok_alice" });
    const broken = fakeGithubLogin([{ error: "device_flow_disabled" }]);
    await expect(pollGithubDeviceToken("Iv1.public", "dev-code", { fetch: broken.fetchImpl, webOrigin: FAKE_GITHUB })).rejects.toThrow("没开设备码登录");
  });

  it("slow_down 时按 GitHub 给的新间隔", async () => {
    const { fetchImpl } = fakeGithubLogin([{ error: "slow_down", interval: 10 }]);
    expect(await pollGithubDeviceToken("Iv1.public", "dev-code", { fetch: fetchImpl, webOrigin: FAKE_GITHUB })).toEqual({ kind: "slow_down", intervalMs: 10_000 });
    const relay = await startTestRelay();
    const identity = await makeIdentity(DEVICE_B);
    const waits: number[] = [];
    const github = fakeGithubLogin([{ error: "slow_down", interval: 11 }, { error: "authorization_pending" }, { access_token: "TOKEN" }]);
    const svc = createAccountService({
      file: join(tempDir(), "account.json"),
      identity,
      device: { id: DEVICE_B, name: "Win", platform: "win32" },
      relayUrl: relay.url,
      githubClientId: "Iv1.public",
      fetch: github.fetchImpl,
      githubWebOrigin: FAKE_GITHUB,
      githubApiOrigin: FAKE_GITHUB,
      sleep: async (ms) => void waits.push(ms),
      log: () => {},
    });
    await svc.startLogin();
    await waitFor(() => svc.state().kind === "signed_in");
    expect(waits).toEqual([5_000, 11_000, 11_000]);
  });
});

describe("readAccountFile / writeAccountFile", () => {
  it("没有文件回 null", () => {
    expect(readAccountFile(join(tempDir(), "account.json"))).toBeNull();
  });

  it("写入后权限 0600，读回相同内容", () => {
    const file = join(tempDir(), "account.json");
    writeAccountFile(file, account);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readAccountFile(file)).toEqual(account);
  });

  it("内容不对时抛错，错误里写文件路径", () => {
    const file = join(tempDir(), "account.json");
    writeFileSync(file, "{");
    expect(() => readAccountFile(file)).toThrow(file);
    writeFileSync(file, JSON.stringify({ ...account, accountId: "nope" }));
    expect(() => readAccountFile(file)).toThrow(file);
  });
});

describe("createAccountService", () => {
  it("startLogin 立刻回 signing_in 和 8 位码", async () => {
    const { svc } = await service([]);
    const state = await svc.startLogin();
    expect(state).toMatchObject({ kind: "signing_in", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device" });
    svc.cancelLogin();
  });

  it("用户授权后登记进中继、写 account.json、变成 signed_in 并通知 onChange", async () => {
    const { svc, file, states } = await service([{ error: "authorization_pending" }, { access_token: "TOKEN" }]);
    await svc.startLogin();
    await waitFor(() => svc.state().kind === "signed_in");
    const state = svc.state() as Extract<AccountLoginState, { kind: "signed_in" }>;
    expect(state.account).toMatchObject({ login: { provider: "github", userId: "1", login: "alice" }, state: "active" });
    expect(readAccountFile(file)).toEqual(state.account);
    expect(states.map((s) => s.kind)).toEqual(["signing_in", "signed_in"]);
  });

  it("登记请求带设备证书、公钥和签名，不带别的令牌", async () => {
    const relay = await startTestRelay();
    const { svc, identity } = await service([{ access_token: "TOKEN" }], { relayUrl: relay.url });
    const seen: unknown[] = [];
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/v1/register")) seen.push(JSON.parse(String(init?.body)));
      return real(input, init);
    });
    try {
      await svc.startLogin();
      await waitFor(() => svc.state().kind === "signed_in");
    } finally {
      spy.mockRestore();
    }
    expect(seen).toHaveLength(1);
    const body = seen[0] as { token: string; device: Record<string, string>; signature: string };
    expect(Object.keys(body).sort()).toEqual(["device", "provider", "signature", "token"]);
    expect(body.token).toBe("tok_alice");
    expect(body.device).toMatchObject({ certPem: identity.certPem, publicKey: identity.publicKey });
  });

  it("GitHub token 不写盘、不进日志、不出现在 state() 里", async () => {
    const logs: string[] = [];
    const { svc, file } = await service([{ access_token: "TOKEN" }], { logs });
    await svc.startLogin();
    await waitFor(() => svc.state().kind === "signed_in");
    expect(readFileSync(file, "utf8")).not.toContain("tok_alice");
    expect(logs.join("\n")).not.toContain("tok_alice");
    expect(JSON.stringify(svc.state())).not.toContain("tok_alice");
  });

  it("用户拒绝或码过期时回到 signed_out，lastError 写原因", async () => {
    const denied = await service([{ error: "access_denied" }]);
    await denied.svc.startLogin();
    await waitFor(() => denied.svc.state().kind === "signed_out");
    expect(denied.svc.lastError()).toContain("拒绝");
    const expired = await service([{ error: "expired_token" }]);
    await expired.svc.startLogin();
    await waitFor(() => expired.svc.state().kind === "signed_out");
    expect(expired.svc.lastError()).toContain("过期");
  });

  it("cancelLogin 后不再轮询", async () => {
    const { svc, github } = await service([]);
    await svc.startLogin();
    await waitFor(() => github.calls.filter((c) => c.url.endsWith("access_token")).length >= 1);
    svc.cancelLogin();
    expect(svc.state().kind).toBe("signed_out");
    const count = github.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(github.calls.length).toBeLessThanOrEqual(count + 1);
    const settled = github.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(github.calls.length).toBe(settled);
  });

  it("logout 删 account.json，设备密钥留着", async () => {
    const { svc, file, identity } = await service([{ access_token: "TOKEN" }]);
    await svc.startLogin();
    await waitFor(() => svc.state().kind === "signed_in");
    await svc.logout();
    expect(existsSync(file)).toBe(false);
    expect(svc.state().kind).toBe("signed_out");
    expect(identity.keyPem).toContain("PRIVATE KEY");
  });

  it("已经登录时再 startLogin 抛错", async () => {
    const { svc } = await service([{ access_token: "TOKEN" }]);
    await svc.startLogin();
    await waitFor(() => svc.state().kind === "signed_in");
    await expect(svc.startLogin()).rejects.toThrow("已经登录");
  });

  it("内置常量为空串时，startLogin 传 relayUrl 与 githubClientId 可完整跑通登录", async () => {
    const relay = await startTestRelay();
    const { svc, github } = await service([{ access_token: "TOKEN" }], { relayUrl: "", githubClientId: "" });
    await expect(svc.startLogin({ relayUrl: relay.url })).rejects.toThrow("FUSA_GITHUB_CLIENT_ID");
    await svc.startLogin({ relayUrl: relay.url, githubClientId: "Iv1.cli" });
    await waitFor(() => svc.state().kind === "signed_in");
    expect(github.calls[0]?.body).toContain("client_id=Iv1.cli");
  });
});
