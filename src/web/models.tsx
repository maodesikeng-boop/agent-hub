// 模型名单（GET /api/models）：整个页面共用一份，第一次有组件要时才拉；拉到之前、拉不到时用打包的名单，界面不报错。
// 厂商、模型、思考程度的下拉只看这里（每家厂商一份 ModelCatalog，厂商名、通用思考程度也在里面），页面里不写死厂商的东西。
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AGENT_VENDORS, bundledModelCatalog, isAgentVendor, type AgentVendor, type ModelCatalog } from "../shared/index.ts";
import { fetchModels } from "./client.ts";

interface CatalogStore {
  catalogs: ModelCatalog[] | null;
  /** 第一次有组件要时调；只拉一次（拉失败了下次有组件要时再拉）。 */
  load(): void;
}

const CatalogContext = createContext<CatalogStore | null>(null);

export function ModelCatalogProvider({ children }: { children: ReactNode }) {
  const [catalogs, setCatalogs] = useState<ModelCatalog[] | null>(null);
  const [store] = useState(() => {
    let loading = false;
    const s: CatalogStore = {
      catalogs: null,
      load() {
        if (loading || s.catalogs !== null) return;
        loading = true;
        fetchModels().then(
          (res) => {
            s.catalogs = Array.isArray(res?.catalogs) ? res.catalogs.map(complete) : [];
            setCatalogs(s.catalogs);
          },
          () => {
            loading = false;
          },
        );
      },
    };
    return s;
  });
  const value = useMemo(() => ({ catalogs, load: store.load }), [catalogs, store]);
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

/** 老服务端回的名单可能缺新加的字段（厂商名、通用思考程度……）：认识的厂商用打包的补上。 */
function complete(catalog: ModelCatalog): ModelCatalog {
  return isAgentVendor(catalog.vendor) ? { ...bundledModelCatalog(catalog.vendor), ...catalog } : catalog;
}

const BUNDLED: readonly ModelCatalog[] = AGENT_VENDORS.map((v) => bundledModelCatalog(v));

/** 所有厂商的名单（厂商下拉的选项）。拉到之前、拉到的是空的用打包的。没有 Provider（单独渲染组件时）就只用打包的。 */
export function useModelCatalogs(): readonly ModelCatalog[] {
  const store = useContext(CatalogContext);
  useEffect(() => store?.load(), [store]);
  return store?.catalogs?.length ? store.catalogs : BUNDLED;
}

/** 某家厂商的模型名单。 */
export function useModelCatalog(vendor: AgentVendor): ModelCatalog {
  return useModelCatalogs().find((c) => c.vendor === vendor) ?? bundledModelCatalog(vendor);
}
