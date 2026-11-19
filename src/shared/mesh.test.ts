import { describe, expect, it } from "vitest";
import { MESH_SAS_DIGITS, MESH_SAS_NONCE_BYTES } from "./limits.ts";
import { meshSasCode, parseAccountId, parseDeviceFingerprint, pickCenter, type DeviceFingerprint, type MeshSasParty } from "./mesh.ts";

const FP_A = "a".repeat(64) as DeviceFingerprint;
const FP_B = "b".repeat(64) as DeviceFingerprint;
const nonce = (fill: number) => new Uint8Array(MESH_SAS_NONCE_BYTES).fill(fill);

describe("parseAccountId / parseDeviceFingerprint", () => {
  it("acct_ 加 26 位小写 base32 的账号编号认，别的形状回 null", () => {
    expect(parseAccountId("acct_abcdefghijklmnopqrstuvwxyz")).toBe("acct_abcdefghijklmnopqrstuvwxyz");
    expect(parseAccountId("acct_234567abcdefghijklmnopqrst")).toBe("acct_234567abcdefghijklmnopqrst");
    for (const bad of ["acct_ABCDEFGHIJKLMNOPQRSTUVWXYZ", "acct_abc", "acct_abcdefghijklmnopqrstuvwxy1", "abcdefghijklmnopqrstuvwxyz", 42, null]) {
      expect(parseAccountId(bad)).toBeNull();
    }
  });

  it("64 位十六进制指纹认并转成小写，长度不对或带别的字符回 null", () => {
    expect(parseDeviceFingerprint("AB".repeat(32))).toBe("ab".repeat(32));
    for (const bad of ["ab".repeat(31), "ab".repeat(33), "zz".repeat(32), "", undefined]) {
      expect(parseDeviceFingerprint(bad)).toBeNull();
    }
  });
});

describe("pickCenter", () => {
  it("返回中心顺序里第一个在候选集合中的设备", () => {
    expect(pickCenter(["a", "b", "c"], new Set(["a", "b", "c"]))).toBe("a");
  });

  it("排前的不在候选里时跳过它，选下一个", () => {
    expect(pickCenter(["a", "b", "c"], new Set(["c", "b"]))).toBe("b");
  });

  it("候选里有、但不在中心顺序里的设备永远不选", () => {
    expect(pickCenter(["a"], new Set(["x", "y"]))).toBeNull();
    expect(pickCenter(["a", "b"], new Set(["x", "b"]))).toBe("b");
  });

  it("一个候选都没有时回 null", () => {
    expect(pickCenter(["a", "b"], new Set())).toBeNull();
    expect(pickCenter([], new Set(["a"]))).toBeNull();
  });
});

describe("meshSasCode", () => {
  const a: MeshSasParty = { fingerprint: FP_A, nonce: nonce(1) };
  const b: MeshSasParty = { fingerprint: FP_B, nonce: nonce(2) };

  it("结果是 MESH_SAS_DIGITS 位十进制数字，不足补 0", async () => {
    const codes = await Promise.all(Array.from({ length: 64 }, (_, i) => meshSasCode(a, { fingerprint: FP_B, nonce: nonce(i) })));
    for (const code of codes) expect(code).toMatch(new RegExp(`^\\d{${MESH_SAS_DIGITS}}$`));
  });

  it("交换两方的顺序结果相同", async () => {
    expect(await meshSasCode(a, b)).toBe(await meshSasCode(b, a));
  });

  it("任一方的指纹或随机数变了结果就变", async () => {
    const base = await meshSasCode(a, b);
    const variants = [
      meshSasCode({ ...a, nonce: nonce(3) }, b),
      meshSasCode(a, { ...b, nonce: nonce(4) }),
      meshSasCode({ ...a, fingerprint: "c".repeat(64) as DeviceFingerprint }, b),
      meshSasCode(a, { ...b, fingerprint: "d".repeat(64) as DeviceFingerprint }),
    ];
    for (const code of await Promise.all(variants)) expect(code).not.toBe(base);
  });

  it("同样的输入每次结果一样", async () => {
    expect(await meshSasCode(a, b)).toBe(await meshSasCode({ ...a, nonce: nonce(1) }, { ...b, nonce: nonce(2) }));
  });
});
