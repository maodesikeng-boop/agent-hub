// 模型名单（GET /api/models）：每台设备一份（各台装的 CLI 不一样，联机第 5 节），整个页面共用，第一次有组件要时才拉；
// 拉到之前、拉不到时用打包的名单，界面不报错。哪台设备看外面的 DeviceScope（device-scope.tsx），没有就是入口本机。
// 厂商、模型、思考程度的下拉只看这里（每家厂商一份 ModelCatalog，厂商名、通用思考程度也在里面），页面里不写死厂商的东西。
// 名单里带着这台设备上各家的状态（没装、没登录，docs/vendor-availability-design.md）：没装的不列，没登录的灰掉。
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AGENT_VENDORS,
  AVAILABILITY_LABELS,
  bundledModelCatalog,
  isAgentVendor,
  isListed,
  isSelectable,
  REFRESH_UNUSABLE,
  type AgentVendor,
  type ModelCatalog,
  type ModelsResponse,
} from "../shared/index.ts";
import type { HubClient } from "./client.ts";
import { useClient } from "./device-scope.tsx";

interface CatalogStore {
  /** 按设备（client.device，入口本机是 null 的键 ""）拉到的名单。 */
  catalogs: Readonly<Record<string, ModelCatalog[] | undefined>>;
  /** 有组件挂载或打开模型/厂商下拉时调；冷却时间（MODEL_CATALOG_REVALIDATE_MS）内不重复拉，超过则在后台重拉。 */
  load(client: HubClient): void;
  /** 这台有不能用的厂商时，在后台只重问那几家（用户可能刚登录好）；同一台同时只问一次，不让谁等。 */
  refreshUnusable(client: HubClient): void;
}

/** 前端重新拉取 /api/models 的最小间隔（毫秒）：挂载配置界面或打开下拉时若距上次拉取已超此间隔则在后台重拉。 */
export const MODEL_CATALOG_REVALIDATE_MS = 5_000;

const CatalogContext = createContext<CatalogStore | null>(null);

const catalogKey = (client: HubClient) => client.device ?? "";

export function ModelCatalogProvider({ children, now = Date.now }: { children: ReactNode; now?: () => number }) {
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalog[] | undefined>>({});
  const [store] = useState(() => {
    const loading = new Set<string>();
    const loaded = new Set<string>();
    const loadedAt = new Map<string, number>();
    const refreshing = new Set<string>();
    const save = (key: string, res: ModelsResponse) => {
      const list = Array.isArray(res?.catalogs) ? res.catalogs.map(complete) : [];
      setCatalogs((prev) => ({ ...prev, [key]: list }));
    };
    const load = (client: HubClient) => {
      const key = catalogKey(client);
      const last = loadedAt.get(key);
      if (loading.has(key) || refreshing.has(key) || (loaded.has(key) && last !== undefined && now() - last < MODEL_CATALOG_REVALIDATE_MS)) return;
      loading.add(key);
      loadedAt.set(key, now());
      client
        .fetchModels()
        .then(
          (res) => save(key, res),
          () => {},
        )
        .finally(() => {
          loading.delete(key);
          loaded.add(key);
          loadedAt.set(key, now());
        });
    };
    const refreshUnusable = (client: HubClient) => {
      const key = catalogKey(client);
      if (refreshing.has(key) || !loaded.has(key)) return;
      refreshing.add(key);
      client
        .fetchModels({ refresh: REFRESH_UNUSABLE })
        .then(
          (res) => {
            loadedAt.set(key, now());
            save(key, res);
          },
          () => {},
        )
        .finally(() => refreshing.delete(key));
    };
    return { load, refreshUnusable };
  });
  const value = useMemo(() => ({ catalogs, ...store }), [catalogs, store]);
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

/** 老服务端回的名单可能缺新加的字段（厂商名、通用思考程度、状态……）：认识的厂商用打包的补上（状态补成 unknown，当能用）。 */
function complete(catalog: ModelCatalog): ModelCatalog {
  return isAgentVendor(catalog.vendor) ? { ...bundledModelCatalog(catalog.vendor), ...catalog } : catalog;
}

const BUNDLED: readonly ModelCatalog[] = AGENT_VENDORS.map((v) => bundledModelCatalog(v));

/** 所有厂商的名单（厂商下拉的选项）。拉到之前、拉到的是空的用打包的。没有 Provider（单独渲染组件时）就只用打包的。 */
function useModelCatalogs(): readonly ModelCatalog[] {
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

/** 打开模型下拉时调：距上次拉取满冷却时间就在后台重拉一次 /api/models（本机模型缓存或凭据更新后立即可见）。 */
export function useRevalidateModels(): () => void {
  const store = useContext(CatalogContext);
  const client = useClient();
  return () => store?.load(client);
}

/** 下拉里厂商那一项的文字：不能用的后面带英文状态词（Codex (Not signed in)）。 */
export function vendorOptionLabel(catalog: ModelCatalog): string {
  const status = AVAILABILITY_LABELS[catalog.availability];
  return status === null ? catalog.label : `${catalog.label} (${status})`;
}

/**
 * 厂商下拉的选项：这台设备上没装的不列，但现在选着的那家总在（没装也显示，标状态词）。
 * refreshUnusable：打开下拉时调，有不能用的就在后台重问那几家，全可用时按冷却间隔后台重拉名单，下拉不等。
 */
export function useVendorChoices(current: AgentVendor): { options: readonly ModelCatalog[]; refreshUnusable: () => void } {
  const store = useContext(CatalogContext);
  const client = useClient();
  const catalogs = useModelCatalogs();
  // 老服务端的名单里可能根本没有选着的那家：用打包的补上（状态 unknown）
  const options = catalogs.some((c) => c.vendor === current) ? catalogs : [...catalogs, bundledModelCatalog(current)];
  const listed = options.filter((c) => isListed(c.availability) || c.vendor === current);
  const anyUnusable = catalogs.some((c) => !isSelectable(c.availability));
  return {
    options: listed,
    refreshUnusable: () => {
      if (anyUnusable) store?.refreshUnusable(client);
      else store?.load(client);
    },
  };
}
