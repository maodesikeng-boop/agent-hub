// 厂商契约测试（docs/vendor-plugin-design.md 5.3 节）：名单里每一家跑同一套静态检查，不起进程、不联网。
// 只看 spec 的那一半在 test-helpers.ts 的 describeSpecContract（假厂商 acme 也跑它，见 acme-contract.test.ts）；
// 守护进程侧（P3 搬进各家文件夹）：src/vendors/<id>/daemon.ts（daemon-registry.ts 按名单加载）、paths.ts；从它们推出来的
// DAEMON_VENDORS（src/daemon/vendors/index.ts）、FORKERS（src/daemon/handover/forkers.ts）、vendorTranscriptPath（src/daemon/driver/transcript.ts）。
// S9 定为：forker 的 id 所有厂商之间全局唯一（存进数据库 fork_ref，重启后靠它找回是哪个办法）。
//
// 还不能转正的（写成 it.todo，到那一步改成真断言）：
// - S10 后半“readonly 为 os_sandbox 的厂商没有 OS 沙箱时派只读被拒”：现在代码对所有 Worker 一律要求 OS 沙箱
//   （ledger/workers.ts 的 WORKER_NEEDS_OS_SANDBOX_MESSAGE，不分厂商，ledger 测试里测），没有按家的入口；P4 再定要不要按家。
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorTranscriptPath } from "../daemon/driver/transcript.ts";
import { FORKERS } from "../daemon/handover/forkers.ts";
import { DAEMON_VENDORS } from "../daemon/vendors/index.ts";
import { VENDOR_DAEMONS } from "./daemon-registry.ts";
import { VENDOR_PATHS } from "./paths-registry.ts";
import { AGENT_VENDORS, VENDOR_AVAILABILITIES, vendorSpec } from "../shared/vendors.ts";
import { VENDOR_LIST } from "./registry.ts";
import { ROOT, browserUnsafeImports, describeSpecContract, importsOf, otherVendorDirImports, runtimeImportsDeep } from "./test-helpers.ts";

const GARBAGE: readonly unknown[] = [null, undefined, "垃圾", 42, {}, [], { models: "x" }];
const specFileOf = (id: string) => `src/vendors/${id}/spec.ts`;
/** 运行时引了就会和 daemon-registry.ts 的顶层 await 绕成环（卡死）的文件：各家文件夹里只许 import type。 */
const REGISTRY_DERIVED = ["src/vendors/daemon-registry.ts", "src/daemon/vendors/index.ts", "src/daemon/handover/forkers.ts", "src/daemon/driver/transcript.ts"];
/** 一个文件夹下的 .ts（不含测试）。 */
const sourcesIn = (dir: string) =>
  readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => join(relative(ROOT, e.parentPath), e.name).split("\\").join("/"));

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
    for (const table of [VENDOR_DAEMONS, DAEMON_VENDORS, FORKERS]) {
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
    expect(browserUnsafeImports("src/shared/providers.ts")).toEqual([]);
    // 反向确认检查器不是空跑：守护进程路径文件引了 node:* 与各家文件夹，必须被抓出
    expect(browserUnsafeImports("src/shared/paths.ts").length).toBeGreaterThan(0);
    expect(browserUnsafeImports("src/vendors/agy/paths.ts").length).toBeGreaterThan(0);
    expect(otherVendorDirImports("src/daemon/driver/transcript.test.ts").map((i) => i.path)).toEqual(
      expect.arrayContaining(["src/vendors/agy/transcript.ts", "src/vendors/codex/transcript.ts"]),
    );
  });

  it("S1 每个 id 有 src/vendors/<id>/daemon.ts（默认导出带 createDriver）和 paths.ts，daemon-registry.ts 加载的就是它们", async () => {
    for (const { id } of VENDOR_LIST) {
      for (const file of ["daemon.ts", "paths.ts"]) expect(existsSync(join(ROOT, "src/vendors", id, file)), `${id}/${file}`).toBe(true);
      const mod = (await import(`./${id}/daemon.ts`)) as { default: { createDriver?: unknown } };
      expect(typeof mod.default.createDriver, id).toBe("function");
      expect(VENDOR_DAEMONS[id]).toBe(mod.default);
    }
  });

  it("各家文件夹不在运行时引按名单推出来的登记表（会和 daemon-registry.ts 的顶层 await 绕成环），也不引别家文件夹", () => {
    for (const { id } of VENDOR_LIST) {
      for (const file of sourcesIn(`src/vendors/${id}`)) {
        const derived = runtimeImportsDeep(file).filter((i) => i.path !== null && REGISTRY_DERIVED.includes(i.path));
        expect(derived.map((i) => `${i.from} -> ${i.spec}`), file).toEqual([]);
        // 直接引的（经 shared/index.ts 引到名单里各家的 spec.ts 不算）
        const other = importsOf(file).filter((i) => i.path !== null && /^src\/vendors\/[^_/][^/]*\//.test(i.path) && !i.path.startsWith(`src/vendors/${id}/`));
        expect(other.map((i) => i.path), file).toEqual([]);
      }
    }
  });
});

describeSpecContract(specFileOf);

describe.each(AGENT_VENDORS)("厂商契约（守护进程侧）：%s", (id) => {
  const spec = vendorSpec(id);
  const daemon = DAEMON_VENDORS[id];

  it("S1 推出来的登记表有 createDriver、输入框；输入框是这家的", () => {
    expect(typeof daemon.createDriver).toBe("function");
    expect(typeof daemon.createComposer).toBe("function");
    expect(daemon.base.vendor).toBe(id);
  });

  it("S12 paths.ts 的父会话变量、凭据变量都是大写的环境变量名（准备命令按大写比较）；凭据不把守护进程自己的配置（AGENT_HUB_*）当成这家的", () => {
    const { parentSessionEnv = [], credentialEnv = {} } = VENDOR_PATHS[id];
    for (const name of [...parentSessionEnv, ...(credentialEnv.names ?? []), ...(credentialEnv.prefixes ?? [])]) expect(name, name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    for (const name of credentialEnv.names ?? []) expect(name.startsWith("AGENT_HUB_"), name).toBe(false);
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

  it("S11 全厂商同步适配器：每家都提供 sync，空主目录下只读扫描不抛且不建文件", () => {
    const sync = VENDOR_DAEMONS[id].sync;
    expect(sync).toBeDefined();
    const emptyHome = `/nonexistent/agent-hub-sync-contract-${id}`;
    const result = sync!.scanMcp({ userHome: emptyHome, env: {} });
    expect(result.servers).toEqual({});
    expect(result.nonSyncable).toEqual([]);
    const globalTarget = sync!.skillTarget({ userHome: emptyHome, env: {} }, { kind: "global" });
    expect(["native", "symlink"]).toContain(globalTarget.mode);
  });

  it("S12 全厂商安装与界面内登录适配器：每家都提供 setup，三平台脚本源强制 https://，空主目录下只读 inspectAuth 不抛不建文件", async () => {
    const setup = VENDOR_DAEMONS[id].setup;
    expect(setup).toBeDefined();
    for (const platform of ["darwin", "linux", "win32"]) {
      const recipe = setup!.installRecipe(platform);
      if (recipe.kind === "posix_script" || recipe.kind === "powershell_script") {
        const parsed = new URL(recipe.scriptUrl);
        expect(parsed.protocol, `${id} ${platform}`).toBe("https:");
      } else {
        expect(recipe.packageSpec.trim().length, `${id} ${platform}`).toBeGreaterThan(0);
      }
      const update = setup!.updateRecipe(platform);
      expect(["reinstall", "cli_subcommand"]).toContain(update.kind);
    }
    const emptyHome = `/nonexistent/agent-hub-setup-contract-${id}`;
    const inspected = await setup!.inspectAuth({
      platform: "darwin",
      userHome: emptyHome,
      availability: "not_installed",
      executablePath: () => `/nonexistent/${id}`,
      installed: () => false,
      env: () => ({ HOME: emptyHome }),
      secrets: {
        keys: () => [],
        has: () => false,
        getEnv: () => ({}),
        set: () => {},
        remove: () => {},
        fingerprint: () => "0",
      },
    });
    expect(existsSync(emptyHome)).toBe(false);
    expect(inspected.methods.length).toBeGreaterThan(0);
  });

  it.todo("S10 readonly 为 os_sandbox 的厂商在没有 OS 沙箱时派只读被拒（现在对所有 Worker 一律要求 OS 沙箱，P4 再按家）");
});
