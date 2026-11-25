import type { PmId } from "../shared/index.ts";
import type { CompletedDay } from "./work-panel-model.ts";

export interface CompletedWorkQuery {
  days: readonly CompletedDay[];
  /** Server total from the newest page, or null before the first page arrives. */
  total: number | null;
  status: "loading" | "error" | "ready";
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

/**
 * Precondition: called in a component inside a DeviceScope; pmId is the panel's PM or null when none is selected.
 * Postcondition: pages GET /api/pms/:id/completed through useInfiniteQuery on the current device, stops offering more
 * after COMPLETED_WORK_MAX_PAGES pages, refetches from the first page when a graph or Worker of this PM finishes, and
 * returns status "ready" with no days for pmId null. Fetching starts only while enabled.
 */
export function useCompletedWork(_pmId: PmId | null, _enabled: boolean): CompletedWorkQuery {
  throw new Error("Not implemented");
}
