import { describe, expect, it, vi } from "vitest";
import { fingerprintOfCertPem } from "../daemon/mesh/identity.ts";
import { DEVICE_A, DEVICE_B, makeIdentity } from "../daemon/mesh/test-helpers.ts";
import { parseAccountId } from "../shared/mesh.ts";
import { accountIdOf, fingerprintOfPem, verifyDeviceSignature, verifyGithubToken } from "./auth.ts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("verifyGithubToken", () => {
  it("GET /user 回 200 时取数字 id 和登录名，请求带 Bearer token", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, { id: 1234, login: "octo" }));
    const login = await verifyGithubToken("gho_secret", { fetch: fetchMock as typeof fetch, apiOrigin: "https://gh.test" });
    expect(login).toEqual({ provider: "github", userId: "1234", login: "octo" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gh.test/user");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer gho_secret");
  });

  it("401、403 回 null", async () => {
    for (const status of [401, 403]) {
      const login = await verifyGithubToken("bad", { fetch: (async () => json(status, { message: "Bad credentials" })) as typeof fetch });
      expect(login).toBeNull();
    }
  });

  it("网络错误和 5xx 抛错，不当成登录失败", async () => {
    await expect(verifyGithubToken("t", { fetch: (async () => json(502, {})) as typeof fetch })).rejects.toThrow();
    await expect(
      verifyGithubToken("t", {
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      }),
    ).rejects.toThrow();
  });
});

describe("accountIdOf", () => {
  it("同一个数字 id 永远得到同一个账号编号，登录名不参与", async () => {
    const a = await accountIdOf({ provider: "github", userId: "1234" });
    const b = await accountIdOf({ provider: "github", userId: "1234", login: "renamed" } as never);
    expect(a).toBe(b);
    expect(await accountIdOf({ provider: "github", userId: "1235" })).not.toBe(a);
  });

  it("结果能被 parseAccountId 认", async () => {
    const id = await accountIdOf({ provider: "github", userId: "42" });
    expect(parseAccountId(id)).toBe(id);
  });
});

describe("fingerprintOfPem", () => {
  it("和守护进程 fingerprintOfCertPem 对同一张证书算出的一样", async () => {
    const identity = await makeIdentity(DEVICE_A);
    expect(await fingerprintOfPem(identity.certPem)).toBe(fingerprintOfCertPem(identity.certPem));
  });

  it("不是 PEM 证书时抛错", async () => {
    const identity = await makeIdentity(DEVICE_A);
    await expect(fingerprintOfPem("hello")).rejects.toThrow();
    await expect(fingerprintOfPem(identity.keyPem)).rejects.toThrow();
    await expect(fingerprintOfPem(identity.certPem + identity.certPem)).rejects.toThrow();
  });
});

describe("verifyDeviceSignature", () => {
  const message = new TextEncoder().encode("register me");

  it("设备私钥签的对得上", async () => {
    const identity = await makeIdentity(DEVICE_A);
    expect(await verifyDeviceSignature(identity.publicKey, message, identity.sign(message))).toBe(true);
  });

  it("消息改一个字节、换一把公钥都回 false", async () => {
    const a = await makeIdentity(DEVICE_A);
    const b = await makeIdentity(DEVICE_B);
    const signature = a.sign(message);
    const tampered = Uint8Array.from(message);
    tampered[3] = tampered[3]! ^ 0x10;
    expect(await verifyDeviceSignature(a.publicKey, tampered, signature)).toBe(false);
    expect(await verifyDeviceSignature(b.publicKey, message, signature)).toBe(false);
  });

  it("公钥或签名格式不对回 false，不抛错", async () => {
    const a = await makeIdentity(DEVICE_A);
    expect(await verifyDeviceSignature("!!!", message, a.sign(message))).toBe(false);
    expect(await verifyDeviceSignature("AAAA", message, a.sign(message))).toBe(false);
    expect(await verifyDeviceSignature(a.publicKey, message, "@@")).toBe(false);
    expect(await verifyDeviceSignature(a.publicKey, message, "AAAA")).toBe(false);
  });
});
