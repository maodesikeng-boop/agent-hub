// 厂商契约测试（docs/vendor-plugin-design.md 5.3 节）：名单里每一家跑同一套静态检查，不起进程、不联网。
// 只看 spec 的那一半在 test-helpers.ts 的 describeSpecContract（假厂商 acme 也跑它，见 acme-contract.test.ts）；
// 守护进程侧（P3 前还在原位置）：登记表 DAEMON_VENDORS（src/daemon/vendors/index.ts）、FORKERS（src/daemon/handover/forkers.ts）、
// vendorTranscriptPath（src/daemon/driver/transcript.ts）。
// S9 定为：forker 的 id 所有厂商之间全局唯一（存进数据库 fork_ref，重启后靠它找回是哪个办法）。
//
// 还不能转正的（写成 it.todo，到那一步改成真断言）：
// - S1 有 src/vendors/<id>/daemon.ts 且默认导出带 createDriver：P3。现在按现有位置查（DAEMON_VENDORS、src/daemon/vendors/<id>.ts）。
// - S10 后半“readonly 为 os_sandbox 的厂商没有 OS 沙箱时派只读被拒”：现在代码对所有 Worker 一律要求 OS 沙箱
//   （ledger/workers.ts 的 WORKER_NEEDS_OS_SANDBOX_MESSAGE，不分厂商，ledger 测试里测），没有按家的入口；P4 再定要不要按家。
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorTranscriptPath } from "../daemon/driver/transcript.ts";
import { FORKERS } from "../daemon/handover/forkers.ts";
import { DAEMON_VENDORS } from "../daemon/vendors/index.ts";
import { AGENT_VENDORS, VENDOR_AVAILABILITIES, VENDOR_HOME_PATHS, VENDOR_SPECS } from "../shared/vendors.ts";
import { VENDOR_LIST } from "./registry.ts";
import { ROOT, browserUnsafeImports, describeSpecContract, importsOf } from "./test-helpers.ts";

const GARBAGE: readonly unknown[] = [null, undefined, "垃圾", 42, {}, [], { models: "x" }];
const specFileOf = (id: string) => `src/vendors/${id}/spec.ts`;

describe("厂商名单", () => {
  it("S1 名单和文件夹一一对应：每个 id 有 src/vendors/<id>/spec.ts，registry.ts 引的就是它；没有名单外的厂商文件夹", async () => {
    const registryImports = importsOf("src/vendors/registry.ts").map((i) => i.path);
    for (const spec of VENDOR_LIST) {
      expect(existsSync(join(ROOT, specFileOf(spec.id))), spec.id).toBe(true);
      expect(registryImports).toContain(specFileOf(spec.id));
      const mod = (await import(`./${spec.id}/spec.ts`)) as { default: unknown };
      expect(mod.default, spec.id).toBe(spec);
    }
    const dirs = readdirSync(join(ROOT, "src/vendors"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("__"))
      .map((e) => e.name);
    expect(dirs.toSorted()).toEqual(VENDOR_LIST.map((s) => s.id).toSorted());
  });

  it("各登记表的键和名单一致", () => {
    expect([...AGENT_VENDORS]).toEqual(VENDOR_LIST.map((s) => s.id));
    for (const table of [VENDOR_SPECS, VENDOR_HOME_PATHS, DAEMON_VENDORS, FORKERS]) {
      expect(Object.keys(table).sort()).toEqual([...AGENT_VENDORS].sort());
    }
  });

  it("S9 所有厂商的 forker id 全局唯一（存进 fork_ref，重启后凭它找回）", () => {
    const ids = AGENT_VENDORS.flatMap((v) => FORKERS[v].map((f) => f.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("S2 名单 registry.ts、通用函数 src/shared/vendors.ts 浏览器安全：它们和它们运行时引到的文件都不 import node:*、src/daemon", () => {
    expect(browserUnsafeImports("src/vendors/registry.ts")).toEqual([]);
    expect(browserUnsafeImports("src/vendors/types.ts")).toEqual([]);
    expect(browserUnsafeImports("src/shared/vendors.ts")).toEqual([]);
  });

  it.todo("S1 每个 id 有 src/vendors/<id>/daemon.ts，默认导出带 createDriver（P3）");
});

describeSpecContract(specFileOf);

describe.each(AGENT_VENDORS)("厂商契约（守护进程侧）：%s", (id) => {
  const spec = VENDOR_SPECS[id];
  const daemon = DAEMON_VENDORS[id];

  it("S1（现有位置）守护进程侧有登记、有 createDriver；src/daemon/vendors/<id>.ts 存在", () => {
    expect(typeof daemon.createDriver).toBe("function");
    expect(typeof daemon.createComposer).toBe("function");
    expect(typeof daemon.catalog).toBe("function");
    expect(daemon.base.vendor).toBe(id);
    expect(existsSync(join(ROOT, "src/daemon/vendors", `${id}.ts`))).toBe(true);
  });

  it("S6 压缩命令不会被拦、认得出是压缩", () => {
    const { commandPrefix, compactCommand } = spec.composer;
    expect(daemon.base.isCompactCommand(`${commandPrefix}${compactCommand}`)).toBe(true);
    expect(daemon.base.blockReason(`${commandPrefix}${compactCommand}`, null)).toBeNull();
  });

  it("S8 probe 遇到认不出的回应不抛：parse 给 null，登录状态在 VENDOR_AVAILABILITIES 里", () => {
    for (const raw of GARBAGE) {
      expect(daemon.probe.parse(raw), String(raw)).toBeNull();
      expect(VENDOR_AVAILABILITIES).toContain(daemon.probe.availabilityOf(raw));
    }
    if (daemon.probe.availabilityOfError) {
      for (const err of [new Error("boom"), "boom", null]) expect(VENDOR_AVAILABILITIES).toContain(daemon.probe.availabilityOfError(err));
    }
  });

  it("S9 本家 forker 都有非空 id、kind 是 native 或 copy", () => {
    for (const f of FORKERS[id]) {
      expect(f.id).toMatch(/\S/);
      expect(["native", "copy"]).toContain(f.kind);
    }
  });

  it("S10 原始记录：不存在的会话、不安全的会话 ID 都返回 null 不抛", () => {
    const roots = { home: "/nonexistent/agent-hub-contract-home", env: {} };
    for (const vendorSessionId of ["no-such-session-0000", "../etc/passwd", "", "."]) {
      expect(vendorTranscriptPath({ vendor: id, vendorSessionId, cwd: "/nonexistent/agent-hub-contract-cwd" }, roots)).toBeNull();
    }
  });

  it.todo("S10 readonly 为 os_sandbox 的厂商在没有 OS 沙箱时派只读被拒（现在对所有 Worker 一律要求 OS 沙箱，P4 再按家）");
});
