// 联机 P1：state/device.json，每台设备的身份（docs/multi-device-design.md 第 3.2 节）。
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDeviceId } from "../shared/index.ts";
import { defaultDeviceName, loadOrCreateDevice } from "./device.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-device-"));
  file = join(dir, "state", "device.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("device.json", () => {
  it("第一次生成：随机 UUID + 主机名，权限 0600", () => {
    const device = loadOrCreateDevice(file, "mac-mini");
    expect(isDeviceId(device.id)).toBe(true);
    expect(device.name).toBe("mac-mini");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(device);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("之后再读不变（主机名改了也不变）", () => {
    const first = loadOrCreateDevice(file, "mac-mini");
    expect(loadOrCreateDevice(file, "other")).toEqual(first);
  });

  it("两台各生成各的", () => {
    const other = join(dir, "other", "device.json");
    expect(loadOrCreateDevice(file, "a").id).not.toBe(loadOrCreateDevice(other, "a").id);
  });

  it("文件坏了不悄悄换身份（换了别的设备就认不出它），报错说清楚", () => {
    loadOrCreateDevice(file, "a");
    writeFileSync(file, "{oops");
    expect(() => loadOrCreateDevice(file, "a")).toThrow(/device\.json/);
    writeFileSync(file, JSON.stringify({ id: "not-a-uuid", name: "a" }));
    expect(() => loadOrCreateDevice(file, "a")).toThrow(/device\.json/);
  });
});

describe("默认设备名", () => {
  it("去掉 macOS 主机名末尾的 .local；空的给个兜底", () => {
    expect(defaultDeviceName("Mac-Mini.local")).toBe("Mac-Mini");
    expect(defaultDeviceName("ip-172-26-1-2")).toBe("ip-172-26-1-2");
    expect(defaultDeviceName("")).toBe("这台设备");
  });
});
