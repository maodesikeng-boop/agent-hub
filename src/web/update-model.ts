import { useMutation, useQuery, type Query, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { UPDATE_CHECK_RETRY_MS, UPDATE_CHECK_TTL_MS, type InstallerTarget, type UpdateAvailable, type UpdateStatus } from "../shared/index.ts";
import { fetchUpdate, postUpdateCheck } from "./client.ts";
import { useHubQueryClient } from "./query-client.ts";

export const UPDATE_QUERY_KEY = ["update"] as const;
export const UPDATE_DISMISSED_KEY = "agent-hub.update.dismissed";

export const INSTALLER_PLATFORM_LABELS: Readonly<Record<InstallerTarget, string>> = { "macos-arm64": "macOS", "windows-x64": "Windows" };

// The daemon answers "unavailable" as data, so failures must opt into the same short retry it uses for its own cache.
function updateRefreshMs(query: Query<UpdateStatus, Error, UpdateStatus, typeof UPDATE_QUERY_KEY>): number {
  const { status, data } = query.state;
  return status === "error" || data?.status === "unavailable" ? UPDATE_CHECK_RETRY_MS : UPDATE_CHECK_TTL_MS;
}

// Responses can land out of request order; the daemon stamps each check, so the newest stamp wins.
export function newerUpdate(current: UpdateStatus | undefined, incoming: UpdateStatus): UpdateStatus {
  return current !== undefined && current.checkedAt >= incoming.checkedAt ? current : incoming;
}

function updateQueryFn(qc: QueryClient) {
  return async () => {
    const fetched = await fetchUpdate();
    return newerUpdate(qc.getQueryData<UpdateStatus>(UPDATE_QUERY_KEY), fetched);
  };
}

export function useUpdateStatus() {
  const qc = useHubQueryClient();
  return useQuery(
    { queryKey: UPDATE_QUERY_KEY, queryFn: updateQueryFn(qc), staleTime: updateRefreshMs, refetchInterval: updateRefreshMs, refetchOnMount: false, retryOnMount: false },
    qc,
  );
}

export function useCachedUpdateStatus(): UpdateStatus | undefined {
  const qc = useHubQueryClient();
  return useQuery({ queryKey: UPDATE_QUERY_KEY, queryFn: updateQueryFn(qc), enabled: false }, qc).data;
}

export function useCheckForUpdates() {
  const qc = useHubQueryClient();
  return useMutation(
    {
      mutationFn: postUpdateCheck,
      onSuccess: (status) => qc.setQueryData<UpdateStatus>(UPDATE_QUERY_KEY, (current) => newerUpdate(current, status)),
    },
    qc,
  );
}

const dismissListeners = new Set<() => void>();

function readDismissed(): string | null {
  try {
    return localStorage.getItem(UPDATE_DISMISSED_KEY);
  } catch {
    return null;
  }
}

function subscribeDismissed(listener: () => void): () => void {
  dismissListeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === UPDATE_DISMISSED_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    dismissListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function dismissUpdate(version: string): void {
  try {
    localStorage.setItem(UPDATE_DISMISSED_KEY, version);
  } catch {
  }
  for (const listener of dismissListeners) listener();
}

export function useDismissedUpdate(): string | null {
  return useSyncExternalStore(subscribeDismissed, readDismissed, () => null);
}

export function downloadOfferOf(status: UpdateStatus | undefined): UpdateAvailable | null {
  return status?.status === "update_available" && status.installKind === "bundled" ? status : null;
}

export function updateReminderOf(status: UpdateStatus | undefined, dismissed: string | null): UpdateAvailable | null {
  const offer = downloadOfferOf(status);
  return offer !== null && offer.latestVersion !== dismissed ? offer : null;
}

export function useUpdateReminder(): UpdateAvailable | null {
  const { data } = useUpdateStatus();
  return updateReminderOf(data, useDismissedUpdate());
}

export function updateStatusLine(status: UpdateStatus | undefined, failed: boolean): string | undefined {
  if (failed || status?.status === "unavailable") return "Couldn't check for updates";
  if (status?.status === "up_to_date") return "Up to date";
  if (status?.status === "update_available") return `v${status.latestVersion} available`;
  return undefined;
}
