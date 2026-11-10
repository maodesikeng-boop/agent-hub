// 假厂商 acme（test/fixtures/vendors/acme/spec.ts）：只在这个测试里加进名单（mock registry.ts 的 VENDOR_LIST），
// 证明“新文件夹 + 名单一项”就够：只看 spec 的整套契约照样过，公共代码推出来的各张表、通用函数都认得它，不用改任何公共文件。
// 守护进程侧：acme 的 daemon.ts 只写必需的 createDriver（docs/vendor-plugin-design.md 第 4 节“最小可跑的新厂商”），paths.ts 只有兜底路径；
// mock load.ts 让守护进程按约定路径加载时找到 test/fixtures/vendors/acme/ 下的，推出来的各张登记表都有它、可选项走兜底。
import { describe, expect, it, vi } from "vitest";
import type { AgentVendor } from "../shared/vendors.ts";

const ACME_SPEC_FILE = "test/fixtures/vendors/acme/spec.ts";

vi.mock("./registry.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./registry.ts")>();
  const { default: acme } = await import("../../test/fixtures/vendors/acme/spec.ts");
  return { ...real, VENDOR_LIST: [...real.VENDOR_LIST, acme] };
});

vi.mock("./load.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./load.ts")>();
  return {
    ...real,
    importVendorFile: (id: string, file: "daemon.ts" | "paths.ts") =>
      id !== "acme"
        ? real.importVendorFile(id, file)
        : file === "daemon.ts"
          ? import("../../test/fixtures/vendors/acme/daemon.ts")
          : import("../../test/fixtures/vendors/acme/paths.ts"),
  };
});

// 测试的 setupFiles（test/clean-env.ts）已经经 shared/hub.ts → errors.ts 引过 shared/vendors.ts（那时名单还没加 acme）：
// 清掉模块缓存，下面用到的模块都在 mock 之后重新加载
vi.resetModules();
const { describeSpecContract } = await import("./test-helpers.ts");
const { VENDOR_FALLBACK_PATHS, vendorCatalogWatchFiles } = await import("../shared/paths.ts");
const {
  AGENT_VENDORS,
  ALL_EFFORTS,
  VENDOR_FAILURE_SIGNS,
  VENDOR_HOME_PATHS,
  VENDOR_SPECS,
  agentLaunchArgs,
  bundledModelCatalog,
  checkAgentSetting,
  isAgentVendor,
  modelShortLabel,
  vendorLabel,
} = await import("../shared/vendors.ts");

const { DAEMON_VENDORS, VENDOR_CATALOG_PROBES, composerBaseOf, createVendorCatalogSources, createVendorDrivers } = await import("../daemon/vendors/index.ts");
const { FORKERS } = await import("../daemon/handover/forkers.ts");
const { vendorTranscriptPath } = await import("../daemon/driver/transcript.ts");
const { WRITE_SCOPE_ENFORCERS } = await import("../daemon/driver/write-scope.ts");
const { VENDOR_DAEMONS } = await import("./daemon-registry.ts");
const { default: acmeDaemon } = await import("../../test/fixtures/vendors/acme/daemon.ts");

const acme = "acme" as AgentVendor;

describeSpecContract((id) => (id === "acme" ? ACME_SPEC_FILE : `src/vendors/${id}/spec.ts`));

describe("名单加一项 acme，公共代码就认得它", () => {
  it("编号、派生的各张表都有它，排在名单最后", () => {
    expect(AGENT_VENDORS.at(-1)).toBe("acme");
    expect(isAgentVendor("acme")).toBe(true);
    for (const table of [VENDOR_SPECS, VENDOR_HOME_PATHS, VENDOR_FAILURE_SIGNS, VENDOR_FALLBACK_PATHS]) {
      expect(Object.keys(table)).toEqual([...AGENT_VENDORS]);
    }
    expect(ALL_EFFORTS).toContain("turbo");
  });

  it("旧的平铺形状从分组字段推出来，没写的可选字段走默认", () => {
    expect(VENDOR_SPECS[acme]).toMatchObject({
      label: "Acme Rocket",
      cliCommand: "acme",
      envVar: "AGENT_HUB_ACME",
      loginCommand: "acme login",
      modelFlag: "--model",
      effortFlag: "--reasoning",
      backgroundCommands: false,
      readonlyMode: "os_sandbox",
      explicitDefaultModel: false,
      handoverTokenThreshold: 200_000,
      subagentTools: ["acme_spawn"],
    });
    expect(VENDOR_SPECS[acme]).not.toHaveProperty("quota");
    expect(VENDOR_SPECS[acme]).not.toHaveProperty("shortModelName");
    expect(VENDOR_FAILURE_SIGNS[acme].serviceName).toBe("Acme");
  });

  it("通用函数：校验、启动参数、名单、显示名、兜底路径、盯的文件", () => {
    expect(checkAgentSetting({ vendor: "acme", model: "acme-x", effort: "turbo" })).toBeNull();
    expect(checkAgentSetting({ vendor: "acme", model: null, effort: "max" })).toBe("思考程度只能是 low、high、turbo");
    expect(agentLaunchArgs({ vendor: acme, model: "acme-ultra-9", effort: "low" })).toEqual(["--model", "acme-ultra-9", "--reasoning", "low"]);
    expect(bundledModelCatalog(acme)).toMatchObject({ vendor: "acme", label: "Acme Rocket", customModelExample: "如 acme-ultra-9" });
    expect(vendorLabel("acme")).toBe("Acme Rocket");
    expect(modelShortLabel(acme, "acme-x")).toBe("acme-x");
    expect(VENDOR_FALLBACK_PATHS[acme]("/home/u", "linux")[0]).toBe("/home/u/.local/bin/acme");
    expect(vendorCatalogWatchFiles(acme, "/home/u", {})).toEqual(["/home/u/.acme/token.json", "/home/u/.acme/config.json"]);
  });
});

describe("守护进程侧：acme 只写 createDriver，推出来的登记表都认得它，可选项走兜底", () => {
  it("按约定路径加载到 acme 的 daemon.ts；各张登记表的键和名单一致", () => {
    expect(VENDOR_DAEMONS[acme]).toBe(acmeDaemon);
    for (const table of [VENDOR_DAEMONS, DAEMON_VENDORS, VENDOR_CATALOG_PROBES, FORKERS, WRITE_SCOPE_ENFORCERS]) {
      expect(Object.keys(table)).toEqual([...AGENT_VENDORS]);
    }
  });

  it("输入框走通用实现：认 spec 的命令开头、隐藏名单、压缩命令；命令列表只有压缩命令", async () => {
    const base = composerBaseOf("acme")!;
    expect(base.vendor).toBe("acme");
    expect(base.isCompactCommand("/compact")).toBe(true);
    expect(base.blockReason("/clear", null)).toMatch(/会话由/);
    expect(base.blockReason("/compact", null)).toBeNull();
    expect(base.mention("a b.md")).toBe('@"a b.md"');
    const composer = DAEMON_VENDORS[acme].createComposer({ executablePath: "acme" });
    expect(await composer.queryCommands({ cwd: "/tmp", addDirs: [] }, new AbortController().signal)).toEqual([
      { name: "compact", description: "压缩当前对话上下文", builtin: true },
    ]);
  });

  it("没写 catalog：不给名单来源（用打包的），探测看不出名单、状态 unknown", () => {
    const options = Object.fromEntries(AGENT_VENDORS.map((v) => [v, { path: v, cwd: "/tmp", installed: () => false }]));
    const sources = createVendorCatalogSources(options as Parameters<typeof createVendorCatalogSources>[0]);
    expect(sources[acme]).toBeUndefined();
    expect(Object.keys(sources).toSorted()).toEqual(AGENT_VENDORS.filter((v) => v !== acme).toSorted());
    expect(VENDOR_CATALOG_PROBES[acme].parse({ models: [] })).toBeNull();
    expect(VENDOR_CATALOG_PROBES[acme].availabilityOf({})).toBe("unknown");
  });

  it("没写 forkers、transcriptPath：复制会话的办法是空的（本会话写交接），原始记录找不到", () => {
    expect(FORKERS[acme]).toEqual([]);
    expect(vendorTranscriptPath({ vendor: "acme", vendorSessionId: "s-1", cwd: "/tmp" })).toBeNull();
  });

  it("可写范围一律走外层 OS 沙箱；没写 ownSandboxOffArgs 就不加参数", () => {
    expect(WRITE_SCOPE_ENFORCERS[acme].ownSandboxOffArgs).toEqual([]);
  });

  it("createVendorDrivers 给 acme 也建出驱动；没有程序时起会话报 acme_not_found", async () => {
    const store = { get: () => null, update: () => { throw new Error("unused"); }, listWithProcess: () => [] };
    const deps = Object.fromEntries(
      AGENT_VENDORS.map((v) => [v, { executablePath: `/nonexistent/${v}`, store, prepareLaunch: async () => ({ promptFile: "/x", env: {}, fingerprint: "" }) }]),
    );
    const drivers = createVendorDrivers(deps as unknown as Parameters<typeof createVendorDrivers>[0]);
    expect(Object.keys(drivers)).toEqual([...AGENT_VENDORS]);
    await expect(drivers[acme].start(1 as never)).rejects.toThrow(/acme_not_found/);
    await Promise.all(Object.values(drivers).map((d) => d.shutdown()));
  });
});
