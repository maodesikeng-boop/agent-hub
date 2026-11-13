// 模型名单（GET /api/models）：每台设备一份（各台装的 CLI 不一样，联机第 5 节），整个页面共用，第一次有组件要时才拉；
// 拉到之前、拉不到时用打包的名单，界面不报错。哪台设备看外面的 DeviceScope（device-scope.tsx），没有就是入口本机。
// 厂商、模型、思考程度的下拉只看这里（每家厂商一份 ModelCatalog，厂商名、通用思考程度也在里面），页面里不写死厂商的东西。
// 名单里带着这台设备上各家的状态（没装、没登录，docs/vendor-availability-design.md）：没装的不列，没登录的灰掉。
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
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
import { useHubQueryClient } from "./query-client.ts";

/** 前端重新拉取 /api/models 的最小间隔（毫秒）：挂载配置界面或打开下拉时若距上次拉取已超此间隔则在后台重拉。 */
export const MODEL_CATALOG_REVALIDATE_MS = 5_000;

const CatalogEnabledContext = createContext(false);

const catalogKey = (client: HubClient) => client.device ?? "";
export const modelsQueryKey = (key: string) => ["models", key] as const;
const refreshUnusableQueryKey = (key: string) => ["models", key, REFRESH_UNUSABLE] as const;

/** 老服务端回的名单可能缺新加的字段（厂商名、通用思考程度、状态……）：认识的厂商用打包的补上（状态补成 unknown，当能用）。 */
function complete(catalog: ModelCatalog): ModelCatalog {
  return isAgentVendor(catalog.vendor) ? { ...bundledModelCatalog(catalog.vendor), ...catalog } : catalog;
}

function parseCatalogs(res: ModelsResponse): ModelCatalog[] {
  return Array.isArray(res?.catalogs) ? res.catalogs.map(complete) : [];
}

async function fetchCatalogs(qc: QueryClient, client: HubClient): Promise<ModelCatalog[]> {
  const key = catalogKey(client);
  try {
    return parseCatalogs(await client.fetchModels());
  } catch {
    return qc.getQueryData<ModelCatalog[]>(modelsQueryKey(key)) ?? [];
  }
}

function revalidateCatalogs(qc: QueryClient, client: HubClient): void {
  const key = catalogKey(client);
  if (qc.isFetching({ queryKey: modelsQueryKey(key) }) > 0) return;
  void qc.prefetchQuery({
    queryKey: modelsQueryKey(key),
    queryFn: () => fetchCatalogs(qc, client),
    staleTime: MODEL_CATALOG_REVALIDATE_MS,
  });
}

function refreshUnusableCatalogs(qc: QueryClient, client: HubClient): void {
  const key = catalogKey(client);
  const state = qc.getQueryState(modelsQueryKey(key));
  if (!state?.dataUpdatedAt || qc.isFetching({ queryKey: modelsQueryKey(key) }) > 0) return;
  void qc
    .fetchQuery({
      queryKey: refreshUnusableQueryKey(key),
      queryFn: async () => {
        const list = parseCatalogs(await client.fetchModels({ refresh: REFRESH_UNUSABLE }));
        qc.setQueryData(modelsQueryKey(key), list);
        return list;
      },
      staleTime: 0,
    })
    .catch(() => {});
}

export function refreshDeviceModels(qc: QueryClient, client: HubClient): void {
  const key = catalogKey(client);
  void qc
    .fetchQuery({
      queryKey: modelsQueryKey(key),
      queryFn: async () => parseCatalogs(await client.fetchModels()),
      staleTime: 0,
    })
    .catch(() => {});
}

export function ModelCatalogProvider({ children }: { children: ReactNode; now?: () => number }) {
  return <CatalogEnabledContext.Provider value={true}>{children}</CatalogEnabledContext.Provider>;
}

const BUNDLED: readonly ModelCatalog[] = AGENT_VENDORS.map((v) => bundledModelCatalog(v));

/**
 * 直接读取服务端真实返回的模型名单（未拉取过时返回 undefined，不回退打包默认名单）。
 * 用于首次启动 0 家可用自动引导检测与手机一级设置页 0 请求缓存摘要。
 */
export function useServerModelCatalogs({
  enabled = true,
  client: explicitClient,
}: {
  enabled?: boolean;
  client?: HubClient;
} = {}): readonly ModelCatalog[] | undefined {
  const contextClient = useClient();
  const client = explicitClient ?? contextClient;
  const qc = useHubQueryClient();
  const key = catalogKey(client);
  const { data } = useQuery(
    {
      queryKey: modelsQueryKey(key),
      queryFn: () => fetchCatalogs(qc, client),
      staleTime: MODEL_CATALOG_REVALIDATE_MS,
      enabled,
    },
    qc,
  );
  return data;
}

/**
 * 所有厂商的名单（厂商下拉的选项）。拉到之前、拉到的是空的用打包的。没有 Provider（单独渲染组件时）就只用缓存里有的或打包的。
 * active 为 false 时不发请求、只读缓存（输入框只在打开 “/” 列表时才要名单，平时打字不拉）。同一份数据返回同一个数组。
 */
export function useModelCatalogs(active = true): readonly ModelCatalog[] {
  const enabled = useContext(CatalogEnabledContext) && active;
  const client = useClient();
  const qc = useHubQueryClient();
  const key = catalogKey(client);
  const { data: catalogs } = useQuery(
    {
      queryKey: modelsQueryKey(key),
      queryFn: () => fetchCatalogs(qc, client),
      staleTime: MODEL_CATALOG_REVALIDATE_MS,
      enabled,
    },
    qc,
  );
  return catalogs?.length ? catalogs : BUNDLED;
}

/** 某家厂商的模型名单。 */
export function useModelCatalog(vendor: AgentVendor): ModelCatalog {
  return useModelCatalogs().find((c) => c.vendor === vendor) ?? bundledModelCatalog(vendor);
}

/** 打开模型下拉时调：距上次拉取满冷却时间就在后台重拉一次 /api/models（本机模型缓存或凭据更新后立即可见）。 */
export function useRevalidateModels(): () => void {
  const enabled = useContext(CatalogEnabledContext);
  const client = useClient();
  const qc = useHubQueryClient();
  return () => {
    if (enabled) revalidateCatalogs(qc, client);
  };
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
  const enabled = useContext(CatalogEnabledContext);
  const client = useClient();
  const qc = useHubQueryClient();
  const catalogs = useModelCatalogs();
  // 老服务端的名单里可能根本没有选着的那家：用打包的补上（状态 unknown）
  const options = catalogs.some((c) => c.vendor === current) ? catalogs : [...catalogs, bundledModelCatalog(current)];
  const listed = options.filter((c) => isListed(c.availability) || c.vendor === current);
  const anyUnusable = catalogs.some((c) => !isSelectable(c.availability));
  return {
    options: listed,
    refreshUnusable: () => {
      if (!enabled) return;
      if (anyUnusable) refreshUnusableCatalogs(qc, client);
      else revalidateCatalogs(qc, client);
    },
  };
}
