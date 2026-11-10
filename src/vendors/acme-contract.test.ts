// 假厂商 acme（test/fixtures/vendors/acme/spec.ts）：只在这个测试里加进名单（mock registry.ts 的 VENDOR_LIST），
// 证明“新文件夹 + 名单一项”就够：只看 spec 的整套契约照样过，公共代码推出来的各张表、通用函数都认得它，不用改任何公共文件。
// 守护进程侧（daemon.ts、驱动）P3 才有，到时 acme 也要带上（docs/vendor-plugin-design.md 5.3 节）。
import { describe, expect, it, vi } from "vitest";
import type { AgentVendor } from "../shared/vendors.ts";

const ACME_SPEC_FILE = "test/fixtures/vendors/acme/spec.ts";

vi.mock("./registry.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./registry.ts")>();
  const { default: acme } = await import("../../test/fixtures/vendors/acme/spec.ts");
  return { ...real, VENDOR_LIST: [...real.VENDOR_LIST, acme] };
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
