// 模型名单（GET /api/models）：每台设备一份（各台装的 CLI 不一样，联机第 5 节），整个页面共用，第一次有组件要时才拉；
// 拉到之前、拉不到时用打包的名单，界面不报错。哪台设备看外面的 DeviceScope（device-scope.tsx），没有就是入口本机。
// 厂商、模型、思考程度的下拉只看这里（每家厂商一份 ModelCatalog，厂商名、通用思考程度也在里面），页面里不写死厂商的东西。
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AGENT_VENDORS, bundledModelCatalog, isAgentVendor, type AgentVendor, type ModelCatalog } from "../shared/index.ts";
import type { HubClient } from "./client.ts";
import { useClient } from "./device-scope.tsx";

interface CatalogStore {
  /** 按设备（client.device，入口本机是 null 的键 ""）拉到的名单。 */
  catalogs: Readonly<Record<string, ModelCatalog[] | undefined>>;
  /** 第一次有组件要时调；每台只拉一次（拉失败了下次有组件要时再拉）。 */
  load(client: HubClient): void;
}

const CatalogContext = createContext<CatalogStore | null>(null);

const catalogKey = (client: HubClient) => client.device ?? "";

export function ModelCatalogProvider({ children }: { children: ReactNode }) {
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalog[] | undefined>>({});
  const [load] = useState(() => {
    const loading = new Set<string>();
    const loaded = new Set<string>();
    return (client: HubClient) => {
      const key = catalogKey(client);
      if (loading.has(key) || loaded.has(key)) return;
      loading.add(key);
      client.fetchModels().then(
        (res) => {
          loaded.add(key);
          const list = Array.isArray(res?.catalogs) ? res.catalogs.map(complete) : [];
          setCatalogs((prev) => ({ ...prev, [key]: list }));
        },
        () => {
          loading.delete(key);
        },
      );
    };
  });
  const value = useMemo(() => ({ catalogs, load }), [catalogs, load]);
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
  const client = useClient();
  useEffect(() => store?.load(client), [store, client]);
  const catalogs = store?.catalogs[catalogKey(client)];
  return catalogs?.length ? catalogs : BUNDLED;
}

/** 某家厂商的模型名单。 */
export function useModelCatalog(vendor: AgentVendor): ModelCatalog {
  return useModelCatalogs().find((c) => c.vendor === vendor) ?? bundledModelCatalog(vendor);
}
