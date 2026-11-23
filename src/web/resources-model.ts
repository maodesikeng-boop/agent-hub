// Invariant: resource selectors cache per input object via WeakMap so memoized UI rows keep stable references, and manual refresh or mutation writes guard the React Query cache with a monotonic generation counter.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
  RESOURCES_INSPECT_TTL_MS,
  type HeldResourceItem,
  type ResourceCleanupResponse,
  type ResourceDecisionRequest,
  type ResourceDecisionResponse,
  type ResourcesSnapshot,
} from "../shared/index.ts";
import { createClient, localClient, type HubClient } from "./client.ts";
import { useClient } from "./device-scope.tsx";
import { LOCAL_DEVICE, type DeviceKey } from "./devices.ts";
import { errorText, type ErrorLike } from "./format.ts";
import { guardedQueryFn, queryGenerationOf, useHubQueryClient } from "./query-client.ts";
import { formatBytes } from "./upload.ts";

export const RESOURCES_QUERY_KEY = (deviceKey: DeviceKey) => ["resources", deviceKey] as const;

export interface ResourcesSummary {
  readonly summary: string | undefined;
  readonly attention: boolean;
  readonly heldCount: number;
}

export interface PartitionedHeldResources {
  readonly needsDecision: readonly HeldResourceItem[];
  readonly kept: readonly HeldResourceItem[];
}

export interface UseResourcesModelResult {
  readonly snapshot: ResourcesSnapshot | null;
  readonly partitioned: PartitionedHeldResources;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly cleaning: boolean;
  readonly decidingKey: string | null;
  readonly loadError: ErrorLike | null;
  readonly actionError: ErrorLike | null;
  readonly refresh: () => void;
  readonly runCleanup: () => void;
  readonly decide: (req: ResourceDecisionRequest) => Promise<ResourceDecisionResponse | null>;
  readonly lastCleanup: ResourceCleanupResponse | null;
}

const EMPTY_SUMMARY: ResourcesSummary = { summary: undefined, attention: false, heldCount: 0 };
const EMPTY_PARTITION: PartitionedHeldResources = { needsDecision: [], kept: [] };

const summaryCache = new WeakMap<ResourcesSnapshot, ResourcesSummary>();
const partitionCache = new WeakMap<readonly HeldResourceItem[], PartitionedHeldResources>();

function generationIdFor(deviceKey: DeviceKey): string {
  return `resources:${deviceKey}`;
}

function clientForDeviceKey(deviceKey: DeviceKey | undefined, contextClient: HubClient): HubClient {
  if (deviceKey === undefined) return contextClient;
  return deviceKey === LOCAL_DEVICE ? localClient : createClient(deviceKey);
}

/**
 * Precondition: snapshot is a ResourcesSnapshot or null/undefined.
 * Postcondition: returns a memoized ResourcesSummary (same reference for the same snapshot object) summarizing total disk footprint and whether unacknowledged held items need user action.
 */
export function describeResourcesSummary(snapshot: ResourcesSnapshot | null | undefined): ResourcesSummary {
  if (snapshot === null || snapshot === undefined) return EMPTY_SUMMARY;
  const cached = summaryCache.get(snapshot);
  if (cached !== undefined) return cached;
  const unacknowledged = snapshot.held.reduce((count, item) => count + (item.keptAt === null ? 1 : 0), 0);
  const attentionCount = Math.max(snapshot.attentionCount, unacknowledged);
  const summary =
    attentionCount > 0
      ? `${attentionCount} to review`
      : formatBytes(snapshot.totalDiskBytes);
  const result: ResourcesSummary = {
    summary,
    attention: attentionCount > 0,
    heldCount: attentionCount,
  };
  summaryCache.set(snapshot, result);
  return result;
}

/**
 * Precondition: held is the held array from ResourcesSnapshot.
 * Postcondition: returns a WeakMap-cached PartitionedHeldResources splitting items with keptAt === null (needsDecision) from items with keptAt !== null (kept).
 */
export function partitionHeldResources(held: readonly HeldResourceItem[]): PartitionedHeldResources {
  if (held.length === 0) return EMPTY_PARTITION;
  const cached = partitionCache.get(held);
  if (cached !== undefined) return cached;
  const needsDecision: HeldResourceItem[] = [];
  const kept: HeldResourceItem[] = [];
  for (const item of held) {
    if (item.keptAt === null) needsDecision.push(item);
    else kept.push(item);
  }
  const result: PartitionedHeldResources = { needsDecision, kept };
  partitionCache.set(held, result);
  return result;
}

/**
 * Precondition: called inside QueryClientProvider and DeviceScope.
 * Postcondition: reads only the cached ResourcesSnapshot for deviceKey without issuing network requests, returning stable summary references.
 */
export function useCachedResourcesSummary(deviceKey?: DeviceKey): ResourcesSummary {
  const qc = useHubQueryClient();
  const contextClient = useClient();
  const key = deviceKey ?? (contextClient.device ?? LOCAL_DEVICE);
  const queryKey = useMemo(() => RESOURCES_QUERY_KEY(key), [key]);
  const client = useMemo(() => clientForDeviceKey(deviceKey, contextClient), [deviceKey, contextClient]);
  const { data } = useQuery(
    {
      queryKey,
      queryFn: () => client.fetchResources(),
      enabled: false,
    },
    qc,
  );
  return describeResourcesSummary(data);
}

/**
 * Precondition: called inside QueryClientProvider and DeviceScope.
 * Postcondition: fetches GET /api/resources once on page load to surface the Settings attention dot without blocking the shell.
 */
export function useResourcesAttention(deviceKey: DeviceKey = LOCAL_DEVICE): ResourcesSummary {
  const qc = useHubQueryClient();
  const contextClient = useClient();
  const queryKey = useMemo(() => RESOURCES_QUERY_KEY(deviceKey), [deviceKey]);
  const client = useMemo(() => clientForDeviceKey(deviceKey, contextClient), [deviceKey, contextClient]);
  const genId = generationIdFor(deviceKey);
  const { data } = useQuery(
    {
      queryKey,
      queryFn: guardedQueryFn(qc, genId, queryKey, () => client.fetchResources()),
      staleTime: RESOURCES_INSPECT_TTL_MS,
      refetchOnMount: false,
      retryOnMount: false,
    },
    qc,
  );
  return describeResourcesSummary(data);
}

/**
 * Precondition: called inside QueryClientProvider and DeviceScope.
 * Postcondition: fetches GET /api/resources when enabled, guards cache writes against stale in-flight GETs using a monotonic generation counter, and exposes refresh, decide, and runCleanup mutations.
 */
export function useResourcesModel(options: {
  deviceKey?: DeviceKey;
  enabled?: boolean;
} = {}): UseResourcesModelResult {
  const { deviceKey, enabled = true } = options;
  const qc = useHubQueryClient();
  const contextClient = useClient();
  const effectiveKey = deviceKey ?? (contextClient.device ?? LOCAL_DEVICE);
  const queryKey = useMemo(() => RESOURCES_QUERY_KEY(effectiveKey), [effectiveKey]);
  const client = useMemo(() => clientForDeviceKey(deviceKey, contextClient), [deviceKey, contextClient]);
  const genId = generationIdFor(effectiveKey);

  const [actionError, setActionError] = useState<ErrorLike | null>(null);
  const [decidingKey, setDecidingKey] = useState<string | null>(null);
  const [lastCleanup, setLastCleanup] = useState<ResourceCleanupResponse | null>(null);

  const query = useQuery(
    {
      queryKey,
      queryFn: guardedQueryFn(qc, genId, queryKey, () => client.fetchResources()),
      enabled,
      staleTime: RESOURCES_INSPECT_TTL_MS,
    },
    qc,
  );

  const claimGeneration = useCallback(() => {
    const state = queryGenerationOf(qc, genId);
    state.gen += 1;
    state.latest = state.gen;
    return state.latest;
  }, [qc, genId]);

  const commitSnapshot = useCallback(
    (snapshot: ResourcesSnapshot, ticket: number) => {
      const state = queryGenerationOf(qc, genId);
      if (ticket !== state.latest) return;
      state.gen += 1;
      qc.setQueryData<ResourcesSnapshot>(queryKey, snapshot);
    },
    [qc, genId, queryKey],
  );

  const refreshMutation = useMutation(
    {
      mutationFn: () => client.fetchResources({ refresh: true }),
      onMutate: () => {
        setActionError(null);
        return claimGeneration();
      },
      onSuccess: (snapshot, _vars, ticket) => {
        commitSnapshot(snapshot, ticket);
      },
      onError: (err) => {
        setActionError(errorText(err));
      },
    },
    qc,
  );

  const cleanupMutation = useMutation(
    {
      mutationFn: () => client.postResourceCleanup(),
      onMutate: () => {
        setActionError(null);
        return claimGeneration();
      },
      onSuccess: (res, _vars, ticket) => {
        setLastCleanup(res);
        commitSnapshot(res.snapshot, ticket);
      },
      onError: (err) => {
        setActionError(errorText(err));
      },
    },
    qc,
  );

  const decideMutation = useMutation(
    {
      mutationFn: (req: ResourceDecisionRequest) => client.postResourceDecision(req),
      onMutate: (req) => {
        setActionError(null);
        setDecidingKey(`${req.kind}:${req.targetKey}`);
        return claimGeneration();
      },
      onSuccess: (res, _vars, ticket) => {
        commitSnapshot(res.snapshot, ticket);
      },
      onError: (err) => {
        setActionError(errorText(err));
      },
      onSettled: () => {
        setDecidingKey(null);
      },
    },
    qc,
  );

  const refresh = useCallback(() => {
    if (refreshMutation.isPending) return;
    refreshMutation.mutate();
  }, [refreshMutation]);

  const runCleanup = useCallback(() => {
    if (cleanupMutation.isPending) return;
    cleanupMutation.mutate();
  }, [cleanupMutation]);

  const decide = useCallback(
    async (req: ResourceDecisionRequest): Promise<ResourceDecisionResponse | null> => {
      try {
        return await decideMutation.mutateAsync(req);
      } catch {
        return null;
      }
    },
    [decideMutation],
  );

  const snapshot = query.data ?? null;
  const partitioned = partitionHeldResources(snapshot?.held ?? []);
  const loadError: ErrorLike | null = enabled && query.error && !snapshot ? errorText(query.error) : null;

  return useMemo(
    () => ({
      snapshot,
      partitioned,
      loading: enabled && snapshot === null && query.isFetching,
      refreshing: refreshMutation.isPending,
      cleaning: cleanupMutation.isPending,
      decidingKey,
      loadError,
      actionError,
      refresh,
      runCleanup,
      decide,
      lastCleanup,
    }),
    [
      snapshot,
      partitioned,
      enabled,
      query.isFetching,
      refreshMutation.isPending,
      cleanupMutation.isPending,
      decidingKey,
      loadError,
      actionError,
      refresh,
      runCleanup,
      decide,
      lastCleanup,
    ],
  );
}
