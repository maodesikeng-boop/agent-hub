import { describe, expect, it } from "vitest";
import { FEISHU_SELECT_OPTIONS_MAX } from "../../shared/limits.ts";
import { defaultRouterSettings } from "../../shared/router.ts";
import { AGENT_VENDORS, bundledModelCatalog, type ModelCatalog } from "../../shared/vendors.ts";
import {
  buildPmModelSection,
  buildRouterModelSection,
  FEISHU_AUTO_OPTION,
  FEISHU_DEFAULT_OPTION,
  type FeishuPmModelView,
  resolvePmModelEdit,
  resolveRouterModelEdit,
} from "./model-picker.ts";

const catalogs = (patch: Partial<Record<(typeof AGENT_VENDORS)[number], Partial<ModelCatalog>>> = {}): ModelCatalog[] =>
  AGENT_VENDORS.map((vendor) => ({
    ...bundledModelCatalog(vendor),
    availability: "available" as const,
    ...patch[vendor],
  }));

describe("buildPmModelSection 与 resolvePmModelEdit（项目经理模型与思考程度）", () => {
  it("默认状态下给出厂商、模型、思考程度三个下拉，默认项都用 -default 哨兵而不是空串", () => {
    const section = buildPmModelSection(
      { vendor: "claude", model: null, effort: null },
      catalogs({ claude: { defaultModel: "Opus 5.5" } }),
    );
    expect(section.fixedEffortNote).toBeNull();
    expect(section.selects.map((s) => s.field)).toEqual(["vendor", "model", "effort"]);
    const [vendor, model, effort] = section.selects;
    expect(vendor!.initialOption).toBe("claude");
    expect(model!.initialOption).toBe(FEISHU_DEFAULT_OPTION);
    expect(model!.options[0]).toEqual({ label: "Opus 5.5（默认）", value: FEISHU_DEFAULT_OPTION });
    expect(effort!.initialOption).toBe(FEISHU_DEFAULT_OPTION);
    expect(effort!.options[0]).toEqual({ label: "默认", value: FEISHU_DEFAULT_OPTION });
    for (const select of section.selects) {
      for (const option of select.options) expect(option.value).not.toBe("");
    }
  });

  it("agy 老数据里带档位后缀的模型名拆成模型和思考程度；未上榜自定义模型保留在下拉里", () => {
    const agySection = buildPmModelSection({ vendor: "agy", model: "gemini-4-argon-high", effort: null }, catalogs());
    expect(agySection.selects.find((s) => s.field === "model")?.initialOption).toBe("gemini-4-argon");
    expect(agySection.selects.find((s) => s.field === "effort")?.initialOption).toBe("high");

    const customSection = buildPmModelSection({ vendor: "claude", model: "claude-opus-5-5[1m]", effort: "high" }, catalogs());
    const modelSelect = customSection.selects.find((s) => s.field === "model")!;
    expect(modelSelect.initialOption).toBe("claude-opus-5-5[1m]");
    expect(modelSelect.options).toContainEqual({ label: "自定义：claude-opus-5-5[1m]", value: "claude-opus-5-5[1m]" });
  });

  it("没安装的厂商不列（当前正用着它除外，标未安装）；未登录的厂商列出来标未登录；正在切厂商时写明目标厂商", () => {
    const cats = catalogs({
      codex: { availability: "signed_out" },
      cursor: { availability: "not_installed" },
    });
    const section = buildPmModelSection({ vendor: "claude", model: null, effort: null, switchingToVendor: "agy" }, cats);
    const vendorOptions = section.selects.find((s) => s.field === "vendor")!.options;
    expect(vendorOptions.some((o) => o.value === "cursor")).toBe(false);
    expect(vendorOptions.find((o) => o.value === "codex")?.label).toContain("未登录");
    expect(section.summary).toContain("Antigravity");

    const onUninstalled = buildPmModelSection({ vendor: "cursor", model: null, effort: null }, cats);
    expect(onUninstalled.selects.find((s) => s.field === "vendor")!.options.find((o) => o.value === "cursor")?.label).toContain("未安装");
  });

  it("模型只有单档位或无档位时不渲染思考程度下拉，fixedEffortNote 写明不支持调节", () => {
    const cursorSection = buildPmModelSection({ vendor: "cursor", model: null, effort: null }, catalogs());
    expect(cursorSection.selects.map((s) => s.field)).toEqual(["vendor", "model"]);
    expect(cursorSection.fixedEffortNote).toContain("思考程度");

    const singleModel = buildPmModelSection({ vendor: "agy", model: "gpt-oss-120b", effort: null }, catalogs());
    expect(singleModel.selects.map((s) => s.field)).toEqual(["vendor", "model"]);
    expect(singleModel.fixedEffortNote).toContain("思考程度");
  });

  it("动态模型超过 FEISHU_SELECT_OPTIONS_MAX 时封顶，并保留当前选中的模型", () => {
    const many = Array.from({ length: FEISHU_SELECT_OPTIONS_MAX + 40 }, (_, i) => ({
      id: `m-${i}`,
      label: `Model ${i}`,
      description: null,
      efforts: ["low", "high"],
    }));
    const chosen = `m-${FEISHU_SELECT_OPTIONS_MAX + 25}`;
    const section = buildPmModelSection({ vendor: "pi", model: chosen, effort: "low" }, catalogs({ pi: { source: "vendor", models: many } }));
    const modelOptions = section.selects.find((s) => s.field === "model")!.options;
    expect(modelOptions.length).toBeLessThanOrEqual(FEISHU_SELECT_OPTIONS_MAX);
    expect(modelOptions.some((o) => o.value === chosen)).toBe(true);
  });

  it("联动编辑：切厂商清空模型和思考程度；切模型保留兼容思考程度、清掉不兼容或单档模型的思考程度；切未登录厂商回 toast", () => {
    const cats = catalogs({ codex: { availability: "signed_out" } });
    expect(resolvePmModelEdit({ vendor: "claude", model: "sonnet", effort: "high" }, cats, "vendor", "agy")).toEqual({
      ok: true,
      next: { vendor: "agy", model: null, effort: null },
    });
    const denied = resolvePmModelEdit({ vendor: "claude", model: null, effort: null }, cats, "vendor", "codex");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.toast).toContain("登录");

    expect(resolvePmModelEdit({ vendor: "agy", model: "gemini-4-argon", effort: "high" }, cats, "model", "claude-opus-5-5")).toEqual({
      ok: true,
      next: { vendor: "agy", model: "claude-opus-5-5", effort: "high" },
    });
    expect(resolvePmModelEdit({ vendor: "agy", model: "gemini-4-argon", effort: "high" }, cats, "model", "gpt-oss-120b")).toEqual({
      ok: true,
      next: { vendor: "agy", model: "gpt-oss-120b", effort: null },
    });
    expect(resolvePmModelEdit({ vendor: "claude", model: "sonnet", effort: "high" }, cats, "model", FEISHU_DEFAULT_OPTION)).toEqual({
      ok: true,
      next: { vendor: "claude", model: null, effort: "high" },
    });
    expect(resolvePmModelEdit({ vendor: "claude", model: null, effort: "high" }, cats, "effort", FEISHU_DEFAULT_OPTION)).toEqual({
      ok: true,
      next: { vendor: "claude", model: null, effort: null },
    });

    const switching: FeishuPmModelView = { vendor: "codex", model: null, effort: null, switchingToVendor: "codex" };
    const blockedSwitch = resolvePmModelEdit(switching, cats, "vendor", "claude");
    expect(blockedSwitch.ok).toBe(false);
    if (!blockedSwitch.ok) expect(blockedSwitch.toast).toContain("Codex");
    expect(resolvePmModelEdit(switching, cats, "model", "gpt-6-luna")).toEqual({
      ok: true,
      next: { vendor: "codex", model: "gpt-6-luna", effort: null },
    });
  });
});

describe("buildRouterModelSection 与 resolveRouterModelEdit（总助模型与思考程度）", () => {
  it("Auto 模式下只画厂商下拉（选中 -auto），summary 写明实际选用的快模型", () => {
    const section = buildRouterModelSection(defaultRouterSettings(), catalogs());
    expect(section.selects.map((s) => s.field)).toEqual(["vendor"]);
    expect(section.selects[0]!.initialOption).toBe(FEISHU_AUTO_OPTION);
    expect(section.selects[0]!.options[0]?.value).toBe(FEISHU_AUTO_OPTION);
    expect(section.summary).toContain("Auto");
    expect(section.summary).toContain("Claude");
    expect(section.fixedEffortNote).toBeNull();
  });

  it("从 Auto 切指定厂商时落到该厂商的快模型预设；切回 -auto 清空三项；切未登录厂商被拦", () => {
    const cats = catalogs({ agy: { availability: "signed_out" } });
    expect(resolveRouterModelEdit(defaultRouterSettings(), cats, "vendor", "codex")).toEqual({
      ok: true,
      next: { vendor: "codex", model: "gpt-6-luna", effort: "low" },
    });
    expect(resolveRouterModelEdit({ vendor: "codex", model: "gpt-6-luna", effort: "high", updatedAt: 1 }, cats, "vendor", FEISHU_AUTO_OPTION)).toEqual({
      ok: true,
      next: { vendor: null, model: null, effort: null },
    });
    const denied = resolveRouterModelEdit(defaultRouterSettings(), cats, "vendor", "agy");
    expect(denied.ok).toBe(false);
  });

  it("指定厂商时给出厂商、模型、思考程度下拉；单档位模型隐藏思考程度下拉并说明固定档位", () => {
    const explicit = buildRouterModelSection({ vendor: "codex", model: "gpt-6-luna", effort: "high", updatedAt: 1 }, catalogs());
    expect(explicit.selects.map((s) => s.field)).toEqual(["vendor", "model", "effort"]);
    expect(explicit.selects.find((s) => s.field === "model")?.initialOption).toBe("gpt-6-luna");
    expect(explicit.selects.find((s) => s.field === "effort")?.initialOption).toBe("high");

    const fixed = buildRouterModelSection({ vendor: "agy", model: "gpt-oss-120b", effort: "medium", updatedAt: 1 }, catalogs());
    expect(fixed.selects.map((s) => s.field)).toEqual(["vendor", "model"]);
    expect(fixed.fixedEffortNote).toContain("思考程度");
  });

  it("总助切模型时保留兼容思考程度，不兼容时回退到新模型首档", () => {
    const cats = catalogs();
    expect(resolveRouterModelEdit({ vendor: "codex", model: "gpt-6.1-sol", effort: "ultra", updatedAt: 1 }, cats, "model", "gpt-5.6-luna")).toEqual({
      ok: true,
      next: { vendor: "codex", model: "gpt-5.6-luna", effort: "low" },
    });
    expect(resolveRouterModelEdit({ vendor: "codex", model: "gpt-6-luna", effort: "high", updatedAt: 1 }, cats, "model", "gpt-6.1-sol")).toEqual({
      ok: true,
      next: { vendor: "codex", model: "gpt-6.1-sol", effort: "high" },
    });
  });
});
