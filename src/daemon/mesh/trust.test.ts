import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESH_MAX_DEVICES_PER_ACCOUNT } from "../../shared/limits.ts";
import type { MeshIdentity } from "./identity.ts";
import { DEVICE_A, DEVICE_B, DEVICE_C, makeIdentity, tempDir } from "./test-helpers.ts";
import { acceptTrustStatement, openMeshTrust, signTrustStatement, startApproval, type ApprovalSignal, type TrustStatement } from "./trust.ts";

let clock = 1_000;
const now = () => clock;

async function setup() {
  const dir = tempDir();
  const file = join(dir, "peers.json");
  const a = await makeIdentity(DEVICE_A);
  const b = await makeIdentity(DEVICE_B);
  const c = await makeIdentity(DEVICE_C);
  const trust = openMeshTrust(file, a, { name: "Mac", platform: "darwin" }, now);
  return { dir, file, a, b, c, trust };
}

const deviceOf = (identity: MeshIdentity, name = "dev") => ({ id: identity.deviceId, name, platform: "linux", certPem: identity.certPem });

describe("openMeshTrust", () => {
  it("没有 peers.json 时建一张只有本机的表", async () => {
    const { file, trust, a } = await setup();
    expect(trust.list().map((d) => d.id)).toEqual([DEVICE_A]);
    expect(trust.list()[0]).toMatchObject({ name: "Mac", fingerprint: a.fingerprint, approvedBy: null });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("读到 v1 格式时备份成 peers.v1.json，从只有本机的表开始", async () => {
    const dir = tempDir();
    const file = join(dir, "peers.json");
    writeFileSync(file, JSON.stringify({ version: 1, devices: [{ id: DEVICE_B }], removed: [] }));
    const a = await makeIdentity(DEVICE_A);
    const trust = openMeshTrust(file, a, { name: "Mac", platform: "darwin" }, now);
    expect(trust.list().map((d) => d.id)).toEqual([DEVICE_A]);
    expect(JSON.parse(readFileSync(join(dir, "peers.v1.json"), "utf8")).version).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(2);
  });

  it("内容不对时抛错，错误里写文件路径", async () => {
    const dir = tempDir();
    const file = join(dir, "peers.json");
    const a = await makeIdentity(DEVICE_A);
    writeFileSync(file, "{not json");
    expect(() => openMeshTrust(file, a, { name: "Mac", platform: "darwin" })).toThrow(file);
    writeFileSync(file, JSON.stringify({ version: 2, devices: "x", revoked: [] }));
    expect(() => openMeshTrust(file, a, { name: "Mac", platform: "darwin" })).toThrow(file);
  });

  it("verifyPeerCert：指纹在表里且 CN 等于记下的编号才认", async () => {
    const { trust, b, c } = await setup();
    expect(trust.verifyPeerCert(b.certPem)).toBeNull();
    trust.add({ ...deviceOf(b), approvedBy: DEVICE_A });
    expect(trust.verifyPeerCert(b.certPem)?.id).toBe(DEVICE_B);
    expect(trust.verifyPeerCert(c.certPem)).toBeNull();
    expect(trust.verifyPeerCert("garbage")).toBeNull();
  });

  it("verifyPeerCert：指纹在表里但 CN 换成别的设备编号时不认", async () => {
    const { trust, b } = await setup();
    trust.add({ ...deviceOf(b), approvedBy: DEVICE_A });
    // 手改表：把 B 的证书记在 C 的编号下，握手时证书 CN（B）和表里编号（C）对不上
    expect(() => trust.add({ id: DEVICE_C, name: "x", platform: "linux", certPem: b.certPem, approvedBy: DEVICE_A })).toThrow();
    const { file } = await setup();
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.devices.push({ id: DEVICE_C, name: "x", platform: "linux", certPem: b.certPem, fingerprint: b.fingerprint, approvedBy: null, since: 1 });
    writeFileSync(file, JSON.stringify(data));
    const reopened = openMeshTrust(file, await makeIdentity(DEVICE_A), { name: "Mac", platform: "darwin" }, now);
    expect(reopened.verifyPeerCert(b.certPem)).toBeNull();
  });

  it("add 写盘后重新打开还在；表满 MESH_MAX_DEVICES_PER_ACCOUNT 台时抛错", async () => {
    const { file, trust, a, b } = await setup();
    trust.add({ ...deviceOf(b, "Win"), approvedBy: DEVICE_A });
    const reopened = openMeshTrust(file, a, { name: "Mac", platform: "darwin" }, now);
    expect(reopened.get(DEVICE_B)).toMatchObject({ name: "Win", approvedBy: DEVICE_A, fingerprint: b.fingerprint });
    for (let i = reopened.list().length; i < MESH_MAX_DEVICES_PER_ACCOUNT; i++) {
      const id = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
      reopened.add({ ...deviceOf(await makeIdentity(id)), approvedBy: DEVICE_A });
    }
    const extra = await makeIdentity("99999999-0000-4000-8000-000000000000");
    expect(() => reopened.add({ ...deviceOf(extra), approvedBy: DEVICE_A })).toThrow();
  });

  it("remove 记墓碑，不能删本机", async () => {
    const { trust, b } = await setup();
    trust.add({ ...deviceOf(b), approvedBy: DEVICE_A });
    expect(trust.remove(DEVICE_B)).toBe(true);
    expect(trust.isRevoked(b.fingerprint)).toBe(true);
    expect(trust.remove(DEVICE_B)).toBe(false);
    expect(() => trust.remove(DEVICE_A)).toThrow();
  });
});

describe("signTrustStatement / acceptTrustStatement", () => {
  /** 本机 A 信任 B；B 签声明给 A。 */
  async function withSigner() {
    const env = await setup();
    env.trust.add({ ...deviceOf(env.b), approvedBy: DEVICE_A });
    const approveC: TrustStatement = { kind: "approve", device: deviceOf(env.c, "Linux"), by: DEVICE_B, at: clock + 10 };
    return { ...env, approveC };
  }

  it("签名人在本机表里、签名对得上的批准声明把设备加进表", async () => {
    const { trust, b, approveC } = await withSigner();
    expect(acceptTrustStatement(trust, signTrustStatement(approveC, b))).toBe("applied");
    expect(trust.get(DEVICE_C)).toMatchObject({ name: "Linux", approvedBy: DEVICE_B });
    const stranger = await makeIdentity(DEVICE_C);
    expect(() => signTrustStatement(approveC, stranger)).toThrow();
  });

  it("签名人不在表里或签名被改过时回 rejected，表不变", async () => {
    const { trust, b, c, approveC } = await withSigner();
    const byC: TrustStatement = { ...approveC, by: DEVICE_C };
    expect(acceptTrustStatement(trust, signTrustStatement(byC, c))).toBe("rejected");
    const signed = signTrustStatement(approveC, b);
    expect(acceptTrustStatement(trust, { ...signed, statement: { ...approveC, device: { ...approveC.device, name: "Evil" } } })).toBe("rejected");
    expect(trust.get(DEVICE_C)).toBeUndefined();
  });

  it("批准一张已被撤销的证书回 rejected", async () => {
    const { trust, b, approveC } = await withSigner();
    expect(acceptTrustStatement(trust, signTrustStatement(approveC, b))).toBe("applied");
    clock = approveC.at + 100;
    trust.remove(DEVICE_C);
    // 更早的批准（比如离线设备事后转来的）不能把它加回来
    expect(acceptTrustStatement(trust, signTrustStatement(approveC, b))).toBe("rejected");
    expect(trust.get(DEVICE_C)).toBeUndefined();
    // 撤销之后重新批准（at 更晚）可以
    expect(acceptTrustStatement(trust, signTrustStatement({ ...approveC, at: clock + 1 }, b))).toBe("applied");
  });

  it("重复收到同一份声明回 ignored", async () => {
    const { trust, b, approveC } = await withSigner();
    const signed = signTrustStatement(approveC, b);
    expect(acceptTrustStatement(trust, signed)).toBe("applied");
    expect(acceptTrustStatement(trust, signed)).toBe("ignored");
    const revoke = signTrustStatement({ kind: "revoke", device: DEVICE_C, fingerprint: trust.get(DEVICE_C)!.fingerprint, by: DEVICE_B, at: approveC.at + 5 }, b);
    expect(acceptTrustStatement(trust, revoke)).toBe("applied");
    expect(acceptTrustStatement(trust, revoke)).toBe("ignored");
  });

  it("撤销本机的声明回 applied", async () => {
    const { trust, a, b } = await withSigner();
    const revokeSelf = signTrustStatement({ kind: "revoke", device: DEVICE_A, fingerprint: a.fingerprint, by: DEVICE_B, at: clock + 50 }, b);
    expect(acceptTrustStatement(trust, revokeSelf)).toBe("applied");
  });
});

describe("startApproval", () => {
  async function pair(options: { tamper?: (signal: ApprovalSignal, to: "approver" | "joiner") => ApprovalSignal } = {}) {
    const a = await makeIdentity(DEVICE_A);
    const n = await makeIdentity(DEVICE_B);
    const approver = startApproval({ role: "approver", requestId: "r1", self: a, peerDeviceId: DEVICE_B, expiresAt: 10_000 });
    const joiner = startApproval({ role: "joiner", requestId: "r1", self: n, peerDeviceId: DEVICE_A, expiresAt: 10_000 });
    const deliver = async (signals: ApprovalSignal[], to: "approver" | "joiner") => {
      for (const raw of signals) {
        const signal = options.tamper?.(raw, to) ?? raw;
        const replies = await (to === "approver" ? approver : joiner).ceremony.receive(signal);
        await deliver(replies, to === "approver" ? "joiner" : "approver");
      }
    };
    await deliver(approver.first, "joiner");
    return { a, n, approver: approver.ceremony, joiner: joiner.ceremony, deliver };
  }

  it("两边按 offer、commit、reveal、reveal、confirm 走完后都是 approved，核对码相同", async () => {
    const { approver, joiner, deliver, a, n } = await pair();
    expect(approver.sas()).toMatch(/^\d{6}$/);
    expect(joiner.sas()).toBe(approver.sas());
    expect(approver.peerCertPem()).toBe(n.certPem);
    expect(joiner.peerCertPem()).toBe(a.certPem);
    await deliver(approver.confirmLocal(), "joiner");
    await deliver(joiner.confirmLocal(), "approver");
    expect(approver.outcome()).toBe("approved");
    expect(joiner.outcome()).toBe("approved");
  });

  it("只有一边 confirm 时两边都还是 pending", async () => {
    const { approver, joiner, deliver } = await pair();
    await deliver(approver.confirmLocal(), "joiner");
    expect(approver.outcome()).toBe("pending");
    expect(joiner.outcome()).toBe("pending");
  });

  it("中继替换了任一方的证书时两边算出的核对码不同", async () => {
    // 中继拿同编号的另一张证书冒充：编号对得上，证书不同
    const fakeA = await makeIdentity(DEVICE_A);
    const fakeB = await makeIdentity(DEVICE_B);
    const swapOffer = await pair({ tamper: (s) => (s.kind === "offer" ? { ...s, certPem: fakeA.certPem } : s) });
    expect(swapOffer.joiner.sas()).not.toBeNull();
    expect(swapOffer.joiner.sas()).not.toBe(swapOffer.approver.sas());
    const swapCommit = await pair({ tamper: (s) => (s.kind === "commit" ? { ...s, certPem: fakeB.certPem } : s) });
    expect(swapCommit.approver.sas()).not.toBe(swapCommit.joiner.sas());
  });

  it("新设备 reveal 的随机数和 commit 的哈希对不上时 aborted", async () => {
    const other = "A".repeat(43);
    const { approver } = await pair({ tamper: (s, to) => (s.kind === "reveal" && to === "approver" ? { ...s, nonce: other } : s) });
    expect(approver.outcome()).toBe("aborted");
    expect(approver.sas()).toBeNull();
  });

  it("顺序不对（没 offer 就 commit、重复 reveal）时 aborted 并回 abort", async () => {
    const a = await makeIdentity(DEVICE_A);
    const n = await makeIdentity(DEVICE_B);
    const joiner = startApproval({ role: "joiner", requestId: "r1", self: n, peerDeviceId: DEVICE_A, expiresAt: 10_000 }).ceremony;
    expect(await joiner.receive({ kind: "commit", requestId: "r1", certPem: a.certPem, commitment: "x" })).toEqual([{ kind: "abort", requestId: "r1", reason: "bad_signal" }]);
    expect(joiner.outcome()).toBe("aborted");
    const { approver } = await pair();
    expect(await approver.receive({ kind: "reveal", requestId: "r1", nonce: "A".repeat(43) })).toEqual([{ kind: "abort", requestId: "r1", reason: "bad_signal" }]);
    expect(approver.outcome()).toBe("aborted");
  });

  it("重复收到已处理过的同一条消息时回放上次的回复，不打断核对", async () => {
    const a = await makeIdentity(DEVICE_A);
    const n = await makeIdentity(DEVICE_B);
    const started = startApproval({ role: "approver", requestId: "r1", self: a, peerDeviceId: DEVICE_B, expiresAt: 10_000 });
    const approver = started.ceremony;
    const joiner = startApproval({ role: "joiner", requestId: "r1", self: n, peerDeviceId: DEVICE_A, expiresAt: 10_000 }).ceremony;
    const commit = await joiner.receive(started.first[0]!);
    expect(await joiner.receive(started.first[0]!)).toEqual(commit);
    const reveal = await approver.receive(commit[0]!);
    expect(await approver.receive(commit[0]!)).toEqual(reveal);
    const joinerReveal = await joiner.receive(reveal[0]!);
    expect(await joiner.receive(reveal[0]!)).toEqual(joinerReveal);
    expect(await approver.receive(joinerReveal[0]!)).toEqual([]);
    expect(await approver.receive(joinerReveal[0]!)).toEqual([]);
    expect(approver.sas()).toMatch(/^\d{6}$/);
    expect(joiner.sas()).toBe(approver.sas());
    const confirm = approver.confirmLocal();
    expect(await joiner.receive(confirm[0]!)).toEqual([]);
    expect(await joiner.receive(confirm[0]!)).toEqual([]);
    expect(joiner.confirmLocal()).toEqual([{ kind: "confirm", requestId: "r1" }]);
    expect(joiner.outcome()).toBe("approved");
    expect(approver.outcome()).toBe("pending");
  });

  it("同一条消息在上一条还没处理完时又到了，也回放同样的回复", async () => {
    const a = await makeIdentity(DEVICE_A);
    const n = await makeIdentity(DEVICE_B);
    const started = startApproval({ role: "approver", requestId: "r1", self: a, peerDeviceId: DEVICE_B, expiresAt: 10_000 });
    const joiner = startApproval({ role: "joiner", requestId: "r1", self: n, peerDeviceId: DEVICE_A, expiresAt: 10_000 }).ceremony;
    const [commit, again] = await Promise.all([joiner.receive(started.first[0]!), joiner.receive(started.first[0]!)]);
    expect(again).toEqual(commit);
    const reveal = await started.ceremony.receive(commit[0]!);
    const [joinerReveal, repeated] = await Promise.all([joiner.receive(reveal[0]!), joiner.receive(reveal[0]!)]);
    expect(repeated).toEqual(joinerReveal);
    expect(joiner.outcome()).toBe("pending");
    expect(joiner.sas()).toMatch(/^\d{6}$/);
  });

  it("同一步收到内容不同的第二条消息时仍然 aborted", async () => {
    const fakeA = await makeIdentity(DEVICE_A);
    const { joiner, approver } = await pair();
    expect(await joiner.receive({ kind: "offer", requestId: "r1", certPem: fakeA.certPem })).toEqual([{ kind: "abort", requestId: "r1", reason: "bad_signal" }]);
    expect(joiner.outcome()).toBe("aborted");
    expect(approver.outcome()).toBe("pending");
  });

  it("任一条消息因对方不在线丢了，重新上线时两边补发 outstanding 后照样走完，核对码相同", async () => {
    const losses: Array<{ kind: ApprovalSignal["kind"]; to: "approver" | "joiner" }> = [
      { kind: "offer", to: "joiner" },
      { kind: "commit", to: "approver" },
      { kind: "reveal", to: "joiner" },
      { kind: "reveal", to: "approver" },
      { kind: "confirm", to: "joiner" },
    ];
    for (const lost of losses) {
      const a = await makeIdentity(DEVICE_A);
      const n = await makeIdentity(DEVICE_B);
      const started = startApproval({ role: "approver", requestId: "r1", self: a, peerDeviceId: DEVICE_B, expiresAt: 10_000 });
      const approver = started.ceremony;
      const joiner = startApproval({ role: "joiner", requestId: "r1", self: n, peerDeviceId: DEVICE_A, expiresAt: 10_000 }).ceremony;
      let dropped = false;
      const deliver = async (signals: ApprovalSignal[], to: "approver" | "joiner"): Promise<void> => {
        for (const signal of signals) {
          if (!dropped && signal.kind === lost.kind && to === lost.to) {
            dropped = true;
            continue;
          }
          await deliver(await (to === "approver" ? approver : joiner).receive(signal), to === "approver" ? "joiner" : "approver");
        }
      };
      const reconnect = async () => {
        await deliver(approver.outstanding(), "joiner");
        await deliver(joiner.outstanding(), "approver");
      };
      await deliver(started.first, "joiner");
      await reconnect();
      expect({ lost, sas: approver.sas() }).toEqual({ lost, sas: expect.stringMatching(/^\d{6}$/) });
      expect(joiner.sas()).toBe(approver.sas());
      await deliver(approver.confirmLocal(), "joiner");
      await reconnect();
      await deliver(joiner.confirmLocal(), "approver");
      expect({ lost, dropped, approver: approver.outcome(), joiner: joiner.outcome() }).toEqual({ lost, dropped: true, approver: "approved", joiner: "approved" });
    }
  });

  it("outstanding 只补对方可能还缺的消息：核对码出来且本机没确认时什么都不补", async () => {
    const { approver, joiner } = await pair();
    expect(approver.outstanding()).toEqual([]);
    expect(joiner.outstanding().map((s) => s.kind)).toEqual(["reveal"]);
    approver.confirmLocal();
    expect(approver.outstanding()).toEqual([{ kind: "confirm", requestId: "r1" }]);
  });

  it("对方证书的 CN 不是预期的设备编号时 aborted", async () => {
    const c = await makeIdentity(DEVICE_C);
    const { joiner } = await pair({ tamper: (s) => (s.kind === "offer" ? { ...s, certPem: c.certPem } : s) });
    expect(joiner.outcome()).toBe("aborted");
  });

  it("核对码出来之前 confirmLocal 抛错", async () => {
    const a = await makeIdentity(DEVICE_A);
    const { ceremony } = startApproval({ role: "approver", requestId: "r1", self: a, peerDeviceId: DEVICE_B, expiresAt: 10_000 });
    expect(() => ceremony.confirmLocal()).toThrow();
  });

  it("cancel 和过期都变成 aborted，之后再收什么都不变", async () => {
    const { approver, joiner, deliver } = await pair();
    expect(approver.cancel("mismatch")).toEqual([{ kind: "abort", requestId: "r1", reason: "mismatch" }]);
    expect(approver.outcome()).toBe("aborted");
    await deliver([{ kind: "abort", requestId: "r1", reason: "mismatch" }], "joiner");
    expect(joiner.outcome()).toBe("aborted");
    expect(await approver.receive({ kind: "confirm", requestId: "r1" })).toEqual([]);
    expect(approver.outcome()).toBe("aborted");
    const second = await pair();
    expect(second.approver.expire(10_000)).toEqual([]);
    expect(second.approver.expire(10_001)).toEqual([{ kind: "abort", requestId: "r1", reason: "expired" }]);
    expect(second.approver.expire(20_000)).toEqual([]);
    expect(second.approver.outcome()).toBe("aborted");
  });
});

