// 模型名单（GET /api/models）：整个页面共用一份，第一次有组件要时才拉；拉到之前、拉不到时用打包的名单，界面不报错。
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { bundledModelCatalog, type AgentVendor, type ModelCatalog } from "../shared/index.ts";
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
            s.catalogs = Array.isArray(res?.catalogs) ? res.catalogs : [];
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

/** 某家厂商的模型名单。没有 Provider（单独渲染组件时）就只用打包的。 */
export function useModelCatalog(vendor: AgentVendor): ModelCatalog {
  const store = useContext(CatalogContext);
  useEffect(() => store?.load(), [store]);
  return store?.catalogs?.find((c) => c.vendor === vendor) ?? bundledModelCatalog(vendor);
}
