// 隧道表 state/tunnels.json（docs/hub-tunnel-design.md 第 5 节）：中心的槽位、连入方的中心配置。块 C、D 只用到槽位分配和中心配置，
// 设备编号（deviceId）由块 B 的配对写。
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TUNNEL_FIRST_SLOT_PORT, TUNNEL_LAST_SLOT_PORT } from "../../shared/limits.ts";
import { TunnelInputError, emptyTunnelTable, keyFingerprint, loadTunnelTable, removeSlot, saveTunnelTable, upsertSlot } from "./table.ts";

const KEY_A = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const KEY_B = "AAAAC3NzaC1lZDI1NTE5AAAAIBhsK3UFdyXPDkN0GMsDdzcuMdUKAxB7m9PiRJEBVSqU";
const KEY_C = "AAAAC3NzaC1lZDI1NTE5AAAAIChsK3UFdyXPDkN0GMsDdzcuMdUKAxB7m9PiRJEBVSqU";

describe("槽位", () => {
  it("从 4401 起取最小的空端口；同名再加保留端口、换钥匙指纹；表不变就是同一个对象内容", () => {
    let table = emptyTunnelTable();
    const a = upsertSlot(table, "mac", keyFingerprint(KEY_A));
    table = a.table;
    expect(a.slot).toEqual({ name: "mac", port: TUNNEL_FIRST_SLOT_PORT, keyFingerprint: keyFingerprint(KEY_A), deviceId: null });
    expect(a.changed).toBe(true);
    const again = upsertSlot(table, "mac", keyFingerprint(KEY_A));
    expect(again.changed).toBe(false);
    expect(again.table).toEqual(table);
    const b = upsertSlot(table, "linux", keyFingerprint(KEY_B));
    table = b.table;
    expect(b.slot.port).toBe(TUNNEL_FIRST_SLOT_PORT + 1);
    // 换钥匙：端口不变
    const rekey = upsertSlot(table, "mac", keyFingerprint(KEY_C));
    expect(rekey.slot.port).toBe(TUNNEL_FIRST_SLOT_PORT);
    expect(rekey.slot.keyFingerprint).toBe(keyFingerprint(KEY_C));
    expect(rekey.changed).toBe(true);
  });

  it("不同设备名用同一把公钥抛 TunnelInputError", () => {
    let table = upsertSlot(emptyTunnelTable(), "mac", keyFingerprint(KEY_A)).table;
    table = upsertSlot(table, "linux", keyFingerprint(KEY_B)).table;
    expect(() => upsertSlot(table, "pi", keyFingerprint(KEY_A))).toThrow(TunnelInputError);
    expect(() => upsertSlot(table, "pi", keyFingerprint(KEY_A))).toThrow("这把公钥已经给 mac 用了");
    expect(() => upsertSlot(table, "mac", keyFingerprint(KEY_B))).toThrow(TunnelInputError);
  });

  it("换钥匙保留设备编号（块 B 写的）", () => {
    let table = upsertSlot(emptyTunnelTable(), "mac", keyFingerprint(KEY_A)).table;
    table = { ...table, slots: table.slots.map((s) => ({ ...s, deviceId: "dev-1" })) };
    expect(upsertSlot(table, "mac", keyFingerprint(KEY_B)).slot.deviceId).toBe("dev-1");
  });

  it("删掉的端口再分配给下一个；删不存在的什么也不变", () => {
    let table = emptyTunnelTable();
    table = upsertSlot(table, "mac", "SHA256:a").table;
    table = upsertSlot(table, "linux", "SHA256:b").table;
    const r = removeSlot(table, "mac");
    expect(r.removed?.port).toBe(TUNNEL_FIRST_SLOT_PORT);
    table = r.table;
    expect(removeSlot(table, "mac")).toEqual({ table, removed: null });
    expect(upsertSlot(table, "pi", "SHA256:c").slot.port).toBe(TUNNEL_FIRST_SLOT_PORT);
  });

  it("端口用完了抛 TunnelInputError", () => {
    let table = emptyTunnelTable();
    for (let port = TUNNEL_FIRST_SLOT_PORT; port <= TUNNEL_LAST_SLOT_PORT; port++) table = upsertSlot(table, `d${port}`, `SHA256:${port}`).table;
    expect(() => upsertSlot(table, "one-more", "SHA256:y")).toThrow(TunnelInputError);
  });

  it("钥匙指纹和 ssh-keygen -lf 一样：SHA256:<base64 不带 =>", () => {
    expect(keyFingerprint(KEY_A)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});

describe("文件", () => {
  it("没有文件 = 空表；写的是 0600，读回来一样", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-tunnel-table-"));
    const file = join(dir, "state", "tunnels.json");
    expect(loadTunnelTable(file)).toEqual(emptyTunnelTable());
    const table = {
      ...upsertSlot(emptyTunnelTable(), "mac", "SHA256:a").table,
      hub: {
        host: "203.0.113.10",
        sshPort: 22,
        user: "agenthub-tunnel",
        hostKey: `ssh-ed25519 ${KEY_A}`,
        listenPort: 4401,
        hubEntryPort: 4319,
        deviceId: null,
        invite: "Xy9_abcdefghijklmnopqr",
      },
    };
    saveTunnelTable(file, table);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadTunnelTable(file)).toEqual(table);
  });

  it("坏文件、不认识的字段值：丢掉坏的行，不让守护进程起不来", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-tunnel-table-"));
    const file = join(dir, "tunnels.json");
    writeFileSync(file, "{not json");
    expect(loadTunnelTable(file)).toEqual(emptyTunnelTable());
    writeFileSync(file, JSON.stringify({ version: 1, slots: [{ name: "mac", port: 4401, keyFingerprint: "SHA256:a", deviceId: null }, { name: "-x", port: 1 }], hub: { host: "-oProxyCommand=x" } }));
    const table = loadTunnelTable(file);
    expect(table.slots.map((s) => s.name)).toEqual(["mac"]);
    expect(table.hub).toBeNull();
    // 原文件没被改
    expect(readFileSync(file, "utf8")).toContain("-oProxyCommand");
  });
});
