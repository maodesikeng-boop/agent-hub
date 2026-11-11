// Router 极快模型预设契约守卫单测（docs/router-design.md 第 6.1 节）：
// 遍历 VENDOR_LIST 校验每家均声明合法的 models.routerDefault，且档位严格落在该模型允许的 efforts 内。
import { describe, expect, it } from "vitest";
import { bundledModelCatalog, checkAgentSetting, effortsFor } from "../shared/vendors.ts";
import { VENDOR_LIST } from "./registry.ts";
import type { VendorModelsSpec } from "./types.ts";

/** 校验一份 VendorModelsSpec 的 routerDefault 是否符合契约；合法返回 null，否则返回原因。 */
function validateRouterDefaultSpec(models: VendorModelsSpec): string | null {
  const model = models.routerDefault?.model?.trim() ?? "";
  if (model === "") return "routerDefault.model 不能为空";
  const effort = models.routerDefault?.effort?.trim() ?? "";
  if (effort === "") return "routerDefault.effort 不能为空";
  if (!models.efforts.includes(effort)) {
    return `routerDefault.effort (${effort}) 不在厂商通用 efforts (${models.efforts.join(", ")}) 内`;
  }
  const bundledHit = models.bundled.find((m) => m.id === model);
  if (bundledHit !== undefined) {
    const supported = bundledHit.efforts ?? models.efforts;
    if (!supported.includes(effort)) {
      return `routerDefault.effort (${effort}) 不在打包模型 ${model} 支持的 efforts (${supported.join(", ")}) 内`;
    }
  }
  return null;
}

describe("VENDOR_LIST routerDefault 快模型预设契约守卫", () => {
  it("每家厂商均声明非空 routerDefault.model，且 effort 包含在打包模型支持的 efforts 数组内", () => {
    expect(VENDOR_LIST.length).toBeGreaterThanOrEqual(6);
    for (const spec of VENDOR_LIST) {
      expect(validateRouterDefaultSpec(spec.models), spec.id).toBeNull();
      const { model, effort } = spec.models.routerDefault;
      expect(model.trim().length, `${spec.id} model 非空`).toBeGreaterThan(0);
      const bundledEntry = spec.models.bundled.find((m) => m.id === model);
      expect(bundledEntry, `${spec.id} 的 routerDefault.model (${model}) 应在打包目录中存在`).toBeDefined();
      if (bundledEntry !== undefined) {
        const allowedEfforts = bundledEntry.efforts ?? spec.models.efforts;
        expect(allowedEfforts, `${spec.id} (${model}) 支持的 efforts`).toContain(effort);
      }
      const catalog = bundledModelCatalog(spec.id);
      expect(effortsFor(catalog, model), `${spec.id} effortsFor(${model})`).toContain(effort);
      expect(checkAgentSetting({ vendor: spec.id, model, effort }), `${spec.id} checkAgentSetting`).toBeNull();
    }
  });

  it("能准确拦截空模型名或超出打包模型 efforts 子集的非法预设", () => {
    const base: VendorModelsSpec = {
      bundled: [{ id: "fast-1", label: "Fast 1", efforts: ["low", "high"] }],
      customModel: true,
      customModelExample: "fast-1",
      efforts: ["off", "low", "medium", "high"],
      routerDefault: { model: "fast-1", effort: "low" },
    };
    expect(validateRouterDefaultSpec(base)).toBeNull();
    expect(validateRouterDefaultSpec({ ...base, routerDefault: { model: "   ", effort: "low" } })).toMatch(/model 不能为空/);
    expect(validateRouterDefaultSpec({ ...base, routerDefault: { model: "fast-1", effort: "" } })).toMatch(/effort 不能为空/);
    // "off" 在厂商通用 efforts 里，但不在打包模型 fast-1 的 efforts ["low", "high"] 里，必须拦住
    expect(validateRouterDefaultSpec({ ...base, routerDefault: { model: "fast-1", effort: "off" } })).toMatch(/不在打包模型 fast-1 支持的 efforts/);
    expect(validateRouterDefaultSpec({ ...base, routerDefault: { model: "custom-fast", effort: "ultra" } })).toMatch(/不在厂商通用 efforts/);
  });
});
