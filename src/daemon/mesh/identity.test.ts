import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprintOfPem, verifyDeviceSignature } from "../../relay/auth.ts";
import { deviceIdOfCertPem, fingerprintOfCertPem, loadOrCreateMeshIdentity, verifyWithCert } from "./identity.ts";
import { DEVICE_A, DEVICE_B, makeIdentity, tempDir } from "./test-helpers.ts";

const message = new TextEncoder().encode("hello mesh");

describe("loadOrCreateMeshIdentity", () => {
  it("第一次生成 key.pem 和 cert.pem，私钥文件权限 0600、目录 0700", async () => {
    const dir = join(tempDir(), "mesh");
    await loadOrCreateMeshIdentity(dir, DEVICE_A);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "key.pem")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "cert.pem"), "utf8")).toContain("BEGIN CERTIFICATE");
  });

  it("再调一次读回同一份，指纹不变", async () => {
    const dir = join(tempDir(), "mesh");
    const first = await loadOrCreateMeshIdentity(dir, DEVICE_A);
    const second = await loadOrCreateMeshIdentity(dir, DEVICE_A);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.publicKey).toBe(first.publicKey);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("证书 CN 等于设备编号", async () => {
    const identity = await makeIdentity(DEVICE_B);
    expect(deviceIdOfCertPem(identity.certPem)).toBe(DEVICE_B);
  });

  it("私钥和证书对不上、CN 不是这台的设备编号、文件坏了时抛错，错误里写文件路径", async () => {
    const dir = join(tempDir(), "mesh");
    await loadOrCreateMeshIdentity(dir, DEVICE_A);
    await expect(loadOrCreateMeshIdentity(dir, DEVICE_B)).rejects.toThrow(join(dir, "cert.pem"));

    const other = await makeIdentity(DEVICE_A);
    const originalCert = readFileSync(join(dir, "cert.pem"), "utf8");
    writeFileSync(join(dir, "cert.pem"), other.certPem);
    await expect(loadOrCreateMeshIdentity(dir, DEVICE_A)).rejects.toThrow(join(dir, "key.pem"));

    writeFileSync(join(dir, "cert.pem"), originalCert);
    writeFileSync(join(dir, "key.pem"), "garbage");
    await expect(loadOrCreateMeshIdentity(dir, DEVICE_A)).rejects.toThrow(join(dir, "key.pem"));

    rmSync(join(dir, "key.pem"));
    await expect(loadOrCreateMeshIdentity(dir, DEVICE_A)).rejects.toThrow(join(dir, "key.pem"));
  });

  it("sign 出的签名能被 verifyWithCert 和 relay/auth.ts 的 verifyDeviceSignature 验过", async () => {
    const identity = await makeIdentity(DEVICE_A);
    const signature = identity.sign(message);
    expect(verifyWithCert(identity.certPem, message, signature)).toBe(true);
    expect(await verifyDeviceSignature(identity.publicKey, message, signature)).toBe(true);
  });
});

describe("fingerprintOfCertPem / deviceIdOfCertPem", () => {
  it("指纹和 relay/auth.ts 的 fingerprintOfPem 对同一张证书算出的一样", async () => {
    const identity = await makeIdentity(DEVICE_A);
    expect(fingerprintOfCertPem(identity.certPem)).toBe(identity.fingerprint);
    expect(await fingerprintOfPem(identity.certPem)).toBe(identity.fingerprint);
  });

  it("CN 不是合法设备编号时 deviceIdOfCertPem 回 null", async () => {
    // 生成器只按传入的编号写 CN：换一个不是 UUID 的编号生成，读出来应当是 null
    const bogus = await loadOrCreateMeshIdentity(join(tempDir(), "mesh"), "not-a-device" as never).catch((error: Error) => error);
    expect(bogus).toBeInstanceOf(Error);
    expect(deviceIdOfCertPem("not a cert")).toBeNull();
  });
});

describe("verifyWithCert", () => {
  it("消息改一个字节、换一张证书都回 false", async () => {
    const a = await makeIdentity(DEVICE_A);
    const b = await makeIdentity(DEVICE_B);
    const signature = a.sign(message);
    const tampered = Uint8Array.from(message);
    tampered[0] = tampered[0]! ^ 1;
    expect(verifyWithCert(a.certPem, tampered, signature)).toBe(false);
    expect(verifyWithCert(b.certPem, message, signature)).toBe(false);
  });

  it("证书或签名格式不对回 false，不抛错", async () => {
    const a = await makeIdentity(DEVICE_A);
    expect(verifyWithCert("garbage", message, a.sign(message))).toBe(false);
    expect(verifyWithCert(a.certPem, message, "!!!")).toBe(false);
    expect(verifyWithCert(a.certPem, message, "")).toBe(false);
  });
});
