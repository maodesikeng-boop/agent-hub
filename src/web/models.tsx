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

export const MODEL_CATALOG_REVALIDATE_MS = 5_000;

const CatalogEnabledContext = createContext(false);

const catalogKey = (client: HubClient) => client.device ?? "";
export const modelsQueryKey = (key: string) => ["models", key] as const;
const refreshUnusableQueryKey = (key: string) => ["models", key, REFRESH_UNUSABLE] as const;

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

export function useModelCatalog(vendor: AgentVendor): ModelCatalog {
  return useModelCatalogs().find((c) => c.vendor === vendor) ?? bundledModelCatalog(vendor);
}

export function useRevalidateModels(): () => void {
  const enabled = useContext(CatalogEnabledContext);
  const client = useClient();
  const qc = useHubQueryClient();
  return () => {
    if (enabled) revalidateCatalogs(qc, client);
  };
}

export function vendorOptionLabel(catalog: ModelCatalog): string {
  const status = AVAILABILITY_LABELS[catalog.availability];
  return status === null ? catalog.label : `${catalog.label} (${status})`;
}

export function useRefreshModelCatalogs(): () => void {
  const enabled = useContext(CatalogEnabledContext);
  const client = useClient();
  const qc = useHubQueryClient();
  const catalogs = useModelCatalogs();
  const anyUnusable = catalogs.some((c) => !isSelectable(c.availability));
  return () => {
    if (!enabled) return;
    if (anyUnusable) refreshUnusableCatalogs(qc, client);
    else revalidateCatalogs(qc, client);
  };
}

export function useVendorChoices(current: AgentVendor): { options: readonly ModelCatalog[]; refreshUnusable: () => void } {
  const catalogs = useModelCatalogs();
  const refreshUnusable = useRefreshModelCatalogs();
  const fallback = bundledModelCatalog(current);
  const options = catalogs.some((c) => c.vendor === current || c.vendor === fallback.vendor) ? catalogs : [...catalogs, fallback];
  const listed = options.filter((c) => isListed(c.availability) || c.vendor === current);
  return {
    options: listed,
    refreshUnusable,
  };
}
