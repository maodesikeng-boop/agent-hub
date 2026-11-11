import { describe, expect, it } from "vitest";
import { bundledModelCatalog, vendorSpec, VENDOR_LIST, type AgentVendor, type ModelCatalog, type VendorAvailability } from "../../shared/index.ts";
import { resolveRouterModel } from "./model-resolver.ts";

function makeCatalog(
  vendor: AgentVendor,
  availability: VendorAvailability,
  overrides: Partial<ModelCatalog> = {},
): ModelCatalog {
  return {
    ...bundledModelCatalog(vendor),
    availability,
    ...overrides,
  };
}

function allCatalogsWith(
  availabilityByVendor: Partial<Record<AgentVendor, VendorAvailability>>,
  overridesByVendor: Partial<Record<AgentVendor, Partial<ModelCatalog>>> = {},
): ModelCatalog[] {
  return VENDOR_LIST.map((spec) =>
    makeCatalog(
      spec.id,
      availabilityByVendor[spec.id] ?? "not_installed",
      overridesByVendor[spec.id],
    ),
  );
}

describe("resolveRouterModel（零厂商分支 Router 模型选型器）", () => {
  const firstVendor = VENDOR_LIST[0]!.id;
  const secondVendor = VENDOR_LIST[1]!.id;
  const thirdVendor = VENDOR_LIST[2]!.id;

  it("显式指定 (vendor, model, effort) 且该厂商可用时优先原样使用（即使排在前面的厂商也可用）", () => {
    const catalogs = allCatalogsWith({
      [firstVendor]: "available",
      [secondVendor]: "available",
    });
    const customModel = vendorSpec(secondVendor).models.bundled[0]!.id;
    const customEffort = vendorSpec(secondVendor).models.efforts.at(-1)!;

    const res = resolveRouterModel(
      { vendor: secondVendor, model: customModel, effort: customEffort },
      catalogs,
    );

    expect(res).toEqual({
      ok: true,
      vendor: secondVendor,
      model: customModel,
      effort: customEffort,
      source: "explicit",
    });
  });

  it("显式指定 (vendor, model) 但未传 effort 时，自动取该模型支持的最低思考档位 efforts[0]", () => {
    const catalogs = allCatalogsWith(
      { [secondVendor]: "available" },
      {
        [secondVendor]: {
          source: "vendor",
          efforts: ["off", "low", "medium", "high"],
          models: [
            { id: "model-narrow", label: "Narrow", description: null, efforts: ["medium", "high"] },
            { id: "model-wide", label: "Wide", description: null, efforts: null },
          ],
        },
      },
    );

    // 模型自身限定了 efforts 子集 ["medium", "high"] → 最低档位取 "medium"
    const narrow = resolveRouterModel({ vendor: secondVendor, model: "model-narrow", effort: null }, catalogs);
    expect(narrow).toEqual({
      ok: true,
      vendor: secondVendor,
      model: "model-narrow",
      effort: "medium",
      source: "explicit",
    });

    // 模型未限定子集（efforts: null）或自定义模型 → 最低档位取通用目录 efforts[0] ("off")
    const custom = resolveRouterModel({ vendor: secondVendor, model: "my-custom-fast" }, catalogs);
    expect(custom).toEqual({
      ok: true,
      vendor: secondVendor,
      model: "my-custom-fast",
      effort: "off",
      source: "explicit",
    });
  });

  it("显式只指定 vendor（model 为空）且该厂商可用时，使用该厂商的 routerDefault", () => {
    const catalogs = allCatalogsWith({
      [firstVendor]: "available",
      [thirdVendor]: "available",
    });
    const preset = vendorSpec(thirdVendor).models.routerDefault;

    const res = resolveRouterModel({ vendor: thirdVendor, model: null, effort: null }, catalogs);
    expect(res).toEqual({
      ok: true,
      vendor: thirdVendor,
      model: preset.model,
      effort: preset.effort,
      source: "explicit",
    });
  });

  it("未指定偏好时，按 VENDOR_LIST 顺序跳过不可用厂商，挑第一家 available 厂商并命中其 routerDefault", () => {
    for (const spec of VENDOR_LIST) {
      const catalogs = allCatalogsWith({ [spec.id]: "available" });
      const res = resolveRouterModel(null, catalogs);
      expect(res, spec.id).toEqual({
        ok: true,
        vendor: spec.id,
        model: spec.models.routerDefault.model,
        effort: spec.models.routerDefault.effort,
        source: "preset",
      });
    }

    // 第一家 signed_out、第二家 unknown、第三家 available → 挑第三家
    const mixed = allCatalogsWith({
      [firstVendor]: "signed_out",
      [secondVendor]: "unknown",
      [thirdVendor]: "available",
    });
    const picked = resolveRouterModel({ vendor: null, model: null, effort: null }, mixed);
    expect(picked).toEqual({
      ok: true,
      vendor: thirdVendor,
      model: vendorSpec(thirdVendor).models.routerDefault.model,
      effort: vendorSpec(thirdVendor).models.routerDefault.effort,
      source: "preset",
    });
  });

  it("实时 ModelCatalog 中不包含 routerDefault.model 时，优雅降级到 defaultModelId ?? models[0].id + 最低思考档位 efforts[0]", () => {
    // 场景 1：有 defaultModelId
    const withDefault = allCatalogsWith(
      { [firstVendor]: "available" },
      {
        [firstVendor]: {
          source: "vendor",
          efforts: ["off", "minimal", "low", "medium", "high"],
          defaultModelId: "alt-provider/model-b",
          models: [
            { id: "alt-provider/model-a", label: "Model A", description: null, efforts: ["off", "low"] },
            { id: "alt-provider/model-b", label: "Model B", description: null, efforts: ["minimal", "medium", "high"] },
          ],
        },
      },
    );
    expect(resolveRouterModel(undefined, withDefault)).toEqual({
      ok: true,
      vendor: firstVendor,
      model: "alt-provider/model-b",
      effort: "minimal",
      source: "catalog_fallback",
    });

    // 场景 2：defaultModelId 为 null，降级到 catalog.models[0].id + 其最低档位
    const withoutDefault = allCatalogsWith(
      { [firstVendor]: "available" },
      {
        [firstVendor]: {
          source: "vendor",
          efforts: ["off", "low", "high"],
          defaultModelId: null,
          models: [
            { id: "alt-provider/first-model", label: "First Model", description: null, efforts: ["low", "high"] },
          ],
        },
      },
    );
    expect(resolveRouterModel(null, withoutDefault)).toEqual({
      ok: true,
      vendor: firstVendor,
      model: "alt-provider/first-model",
      effort: "low",
      source: "catalog_fallback",
    });

    // 场景 3：实时目录包含 routerDefault.model，但实时报出的该模型 efforts 比静态预设更窄时，钳位到实时支持的最低档位
    const presetModel = vendorSpec(firstVendor).models.routerDefault.model;
    const narrowedEfforts = allCatalogsWith(
      { [firstVendor]: "available" },
      {
        [firstVendor]: {
          source: "vendor",
          efforts: ["low", "medium", "high"],
          models: [
            { id: presetModel, label: "Preset Narrowed", description: null, efforts: ["high"] },
          ],
        },
      },
    );
    expect(resolveRouterModel(null, narrowedEfforts)).toEqual({
      ok: true,
      vendor: firstVendor,
      model: presetModel,
      effort: "high",
      source: "preset",
    });
  });

  it("兼容 effortInModelId 厂商传入已带档位后缀的模型 ID，不重复叠加后缀", () => {
    const suffixVendor = VENDOR_LIST.find((s) => s.models.effortInModelId)?.id;
    expect(suffixVendor).toBeDefined();
    if (!suffixVendor) return;

    const spec = vendorSpec(suffixVendor);
    const baseModel = spec.models.routerDefault.model;
    const topEffort = spec.models.efforts.at(-1)!;
    const catalogs = allCatalogsWith({ [suffixVendor]: "available" });

    const res = resolveRouterModel(
      { vendor: suffixVendor, model: `${baseModel}-${topEffort}`, effort: null },
      catalogs,
    );
    expect(res).toEqual({
      ok: true,
      vendor: suffixVendor,
      model: baseModel,
      effort: topEffort,
      source: "explicit",
    });
  });

  it("显式指定的厂商不可用（如 signed_out）但有其他可用厂商时，自动回退至第一家可用厂商并附带 fallbackFromPreferred", () => {
    const catalogs = allCatalogsWith({
      [firstVendor]: "signed_out",
      [secondVendor]: "available",
    });
    const res = resolveRouterModel(
      { vendor: firstVendor, model: vendorSpec(firstVendor).models.routerDefault.model, effort: vendorSpec(firstVendor).models.routerDefault.effort },
      catalogs,
    );
    expect(res).toEqual({
      ok: true,
      vendor: secondVendor,
      model: vendorSpec(secondVendor).models.routerDefault.model,
      effort: vendorSpec(secondVendor).models.routerDefault.effort,
      source: "preset",
      fallbackFromPreferred: {
        vendor: firstVendor,
        availability: "signed_out",
      },
    });
  });

  it("兼容数组、Record 字典与 Map 三种 catalogs 入参结构", () => {
    const cat = makeCatalog(secondVendor, "available");
    const expected = {
      ok: true,
      vendor: secondVendor,
      model: vendorSpec(secondVendor).models.routerDefault.model,
      effort: vendorSpec(secondVendor).models.routerDefault.effort,
      source: "preset",
    };

    expect(resolveRouterModel(null, [cat])).toEqual(expected);
    expect(resolveRouterModel(null, { [secondVendor]: cat })).toEqual(expected);
    expect(resolveRouterModel(null, new Map([[secondVendor, cat]]))).toEqual(expected);
  });

  it("全部厂商不可用时，返回清晰的结构化不可用原因（区分未安装、未登录与偏好厂商状态）", () => {
    // 1. 全部未安装
    const noneInstalled = allCatalogsWith({});
    const resNone = resolveRouterModel(null, noneInstalled);
    expect(resNone.ok).toBe(false);
    if (!resNone.ok) {
      expect(resNone.code).toBe("all_not_installed");
      expect(resNone.preferredVendor).toBeNull();
      expect(resNone.vendors).toHaveLength(VENDOR_LIST.length);
      expect(resNone.message).toContain("安装");
    }

    // 2. 有已安装但未登录的厂商，且用户显式指定过该厂商
    const needsLogin = allCatalogsWith({
      [firstVendor]: "signed_out",
      [secondVendor]: "not_installed",
    });
    const resSignedOut = resolveRouterModel({ vendor: firstVendor, model: null, effort: null }, needsLogin);
    expect(resSignedOut.ok).toBe(false);
    if (!resSignedOut.ok) {
      expect(resSignedOut.code).toBe("needs_sign_in");
      expect(resSignedOut.preferredVendor).toEqual({
        vendor: firstVendor,
        availability: "signed_out",
      });
      expect(resSignedOut.message).toContain(vendorSpec(firstVendor).cli.loginCommand);
    }

    // 3. 空目录（全部 unknown）
    const resEmpty = resolveRouterModel(null, []);
    expect(resEmpty.ok).toBe(false);
    if (!resEmpty.ok) {
      expect(resEmpty.code).toBe("no_available_vendor");
      expect(resEmpty.vendors.every((v) => v.availability === "unknown")).toBe(true);
    }
  });
});
