// 网页顶栏预览用的两个导出（resolveRouterModel 本身的用例在 src/daemon/router/model-resolver.test.ts）。
import { describe, expect, it } from "vitest";
import { VENDOR_LIST } from "../vendors/registry.ts";
import { resolveRouterModel, resolveRouterModelPreview, resolveVendorRouterPreset } from "./router-model.ts";
import { bundledModelCatalog, vendorSpec, type AgentVendor, type ModelCatalog, type VendorAvailability } from "./vendors.ts";

function catalogsWith(availability: (vendor: AgentVendor) => VendorAvailability, source: ModelCatalog["source"] = "vendor"): ModelCatalog[] {
  return VENDOR_LIST.map((spec) => ({ ...bundledModelCatalog(spec.id), source, availability: availability(spec.id) }));
}

describe("resolveVendorRouterPreset（某家厂商的总助快模型预设）", () => {
  it("每家都命中自己声明的 routerDefault；不传名单时按打包名单算", () => {
    for (const spec of VENDOR_LIST) {
      expect(resolveVendorRouterPreset(spec.id)).toEqual({ ...spec.models.routerDefault, source: "preset" });
    }
  });

  it("厂商实时名单里没有预设模型时，退到名单的默认模型和它的最低档位", () => {
    const spec = VENDOR_LIST[0]!;
    const fallback = spec.models.bundled.find((m) => m.id !== spec.models.routerDefault.model)!;
    const catalog: ModelCatalog = {
      ...bundledModelCatalog(spec.id),
      source: "vendor",
      models: [{ id: fallback.id, label: fallback.label, description: null, efforts: null }],
      defaultModelId: fallback.id,
    };
    const preset = resolveVendorRouterPreset(spec.id, catalog);
    expect(preset).toMatchObject({ model: fallback.id, source: "catalog_fallback" });
    expect(preset.effort).toBe(catalog.efforts[0] ?? vendorSpec(spec.id).models.efforts[0]);
  });
});

describe("resolveRouterModelPreview（网页预览：服务端状态还没回来时不显示成“全不可用”）", () => {
  const first = VENDOR_LIST[0]!;
  const second = VENDOR_LIST[1]!;

  it("名单还全是打包的、状态 unknown：按都可用预览，Auto 命中第一家的预设", () => {
    const catalogs = catalogsWith(() => "unknown", "bundled");
    expect(resolveRouterModel(null, catalogs).ok).toBe(false);
    expect(resolveRouterModelPreview(null, catalogs)).toMatchObject({
      ok: true,
      vendor: first.id,
      model: first.models.routerDefault.model,
    });
  });

  it("服务端状态回来后和守护进程的判定完全一致：跳过没登录的，指定的那家不可用时回退并带上原因", () => {
    const catalogs = catalogsWith((vendor) => (vendor === first.id ? "signed_out" : vendor === second.id ? "available" : "not_installed"));
    expect(resolveRouterModelPreview(null, catalogs)).toEqual(resolveRouterModel(null, catalogs));
    expect(resolveRouterModelPreview(null, catalogs)).toMatchObject({ ok: true, vendor: second.id });
    const preferred = { vendor: first.id, model: null, effort: null };
    expect(resolveRouterModelPreview(preferred, catalogs)).toEqual(resolveRouterModel(preferred, catalogs));
    expect(resolveRouterModelPreview(preferred, catalogs)).toMatchObject({
      ok: true,
      vendor: second.id,
      fallbackFromPreferred: { vendor: first.id, availability: "signed_out" },
    });
  });

  it("没有一家可用、但有认不出状态（unknown）的：把认不出的当可用预览，不可用的照旧跳过", () => {
    const catalogs = catalogsWith((vendor) => (vendor === first.id ? "signed_out" : vendor === second.id ? "unknown" : "not_installed"));
    expect(resolveRouterModelPreview(null, catalogs)).toMatchObject({ ok: true, vendor: second.id });
  });

  it("全部没装或没登录：预览也是不可用", () => {
    const catalogs = catalogsWith((vendor) => (vendor === first.id ? "signed_out" : "not_installed"));
    expect(resolveRouterModelPreview(null, catalogs)).toMatchObject({ ok: false, code: "needs_sign_in" });
  });
});
