// Invariant: resource selectors cache per input object via WeakMap so memoized UI rows keep stable references, and manual refresh or mutation writes guard the React Query cache with a monotonic generation counter.
import type {
  HeldResourceItem,
  ResourceCleanupResponse,
  ResourceDecisionRequest,
  ResourceDecisionResponse,
  ResourcesSnapshot,
} from "../shared/index.ts";
import type { DeviceKey } from "./devices.ts";
import type { ErrorLike } from "./format.ts";

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

/**
 * Precondition: snapshot is a ResourcesSnapshot or null/undefined.
 * Postcondition: returns a memoized ResourcesSummary (same reference for the same snapshot object) summarizing total disk footprint and whether unacknowledged held items need user action.
 */
export function describeResourcesSummary(snapshot: ResourcesSnapshot | null | undefined): ResourcesSummary {
  throw new Error("Not implemented");
}

/**
 * Precondition: held is the held array from ResourcesSnapshot.
 * Postcondition: returns a WeakMap-cached PartitionedHeldResources splitting items with keptAt === null (needsDecision) from items with keptAt !== null (kept).
 */
export function partitionHeldResources(held: readonly HeldResourceItem[]): PartitionedHeldResources {
  throw new Error("Not implemented");
}

/**
 * Precondition: called inside QueryClientProvider and DeviceScope.
 * Postcondition: reads only the cached ResourcesSnapshot for deviceKey without issuing network requests, returning stable summary references.
 */
export function useCachedResourcesSummary(deviceKey?: DeviceKey): ResourcesSummary {
  throw new Error("Not implemented");
}

/**
 * Precondition: called inside QueryClientProvider and DeviceScope.
 * Postcondition: fetches GET /api/resources when enabled, guards cache writes against stale in-flight GETs using a monotonic generation counter, and exposes refresh, decide, and runCleanup mutations.
 */
export function useResourcesModel(options?: {
  deviceKey?: DeviceKey;
  enabled?: boolean;
}): UseResourcesModelResult {
  throw new Error("Not implemented");
}
