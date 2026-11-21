import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeldResourceItem, ResourceDecisionResponse, ResourcesSnapshot } from "../shared/index.ts";
import { LOCAL_DEVICE } from "./devices.ts";
import {
  RESOURCES_QUERY_KEY,
  describeResourcesSummary,
  partitionHeldResources,
  useCachedResourcesSummary,
  useResourcesModel,
} from "./resources-model.ts";
import { FakeApi, makeSnapshot } from "./test-utils.ts";

function makeResourcesSnapshot(over: Partial<ResourcesSnapshot> = {}): ResourcesSnapshot {
  return {
    scannedAt: 1_000,
    database: { fileBytes: 4 * 1024 * 1024, walBytes: 0, freelistBytes: 0, dbstatAvailable: true, tables: [] },
    directories: [],
    branches: [],
    processes: { trackedCount: 1, leakedCount: 0 },
    held: [],
    heldTruncated: false,
    totalDiskBytes: 4 * 1024 * 1024,
    attentionCount: 0,
    ...over,
  };
}

function makeHeldWorktree(over: Partial<Extract<HeldResourceItem, { kind: "worktree" }>> = {}): HeldResourceItem {
  return {
    kind: "worktree",
    targetKey: "12",
    reason: "uncommitted_changes",
    label: "#12 Fix bug",
    projectId: 1,
    projectName: "bellwood",
    bytes: 2 * 1024 * 1024,
    detectedAt: 1_000,
    samplePaths: ["src/a.ts"],
    keptAt: null,
    workerId: 12,
    branch: "hub/12-fix",
    worktreePath: "/tmp/wt/1/12",
    dirtyCount: 1,
    ...over,
  };
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resources-model", () => {
  it("returns the same ResourcesSummary reference when the snapshot object is unchanged", () => {
    const snap = makeResourcesSnapshot();
    const first = describeResourcesSummary(snap);
    expect(describeResourcesSummary(snap)).toBe(first);
    expect(first).toEqual({ summary: "4.0 MB", attention: false, heldCount: 0 });
  });

  it("returns the same PartitionedHeldResources reference when the held array reference is unchanged", () => {
    const held: HeldResourceItem[] = [
      makeHeldWorktree({ targetKey: "1", workerId: 1, keptAt: null }),
      makeHeldWorktree({ targetKey: "2", workerId: 2, keptAt: 5_000 }),
    ];
    const first = partitionHeldResources(held);
    expect(partitionHeldResources(held)).toBe(first);
    expect(first.needsDecision.map((i) => i.targetKey)).toEqual(["1"]);
    expect(first.kept.map((i) => i.targetKey)).toEqual(["2"]);
  });

  it("marks attention true when at least one held item has keptAt === null", () => {
    const withUnkept = makeResourcesSnapshot({ held: [makeHeldWorktree({ keptAt: null })], attentionCount: 1 });
    expect(describeResourcesSummary(withUnkept)).toEqual({ summary: "1 held", attention: true, heldCount: 1 });

    const allKept = makeResourcesSnapshot({ held: [makeHeldWorktree({ keptAt: 2_000 })], attentionCount: 0 });
    expect(describeResourcesSummary(allKept)).toEqual({ summary: "4.0 MB", attention: false, heldCount: 0 });
  });

  it("reads only the React Query cache in useCachedResourcesSummary with zero network requests", () => {
    const api = new FakeApi(makeSnapshot({}));
    api.install();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const cached = makeResourcesSnapshot({ held: [makeHeldWorktree()], attentionCount: 1 });
    qc.setQueryData(RESOURCES_QUERY_KEY(LOCAL_DEVICE), cached);

    const { result } = renderHook(() => useCachedResourcesSummary(LOCAL_DEVICE), { wrapper: makeWrapper(qc) });
    expect(result.current).toEqual({ summary: "1 held", attention: true, heldCount: 1 });
    expect(api.calls).toEqual([]);
  });

  it("prevents a stale in-flight GET from overwriting a newer manual refresh or decision mutation", async () => {
    let resolveInitialGet!: (body: ResourcesSnapshot) => void;
    const staleSnap = makeResourcesSnapshot({
      scannedAt: 100,
      held: [makeHeldWorktree({ targetKey: "12", keptAt: null })],
      attentionCount: 1,
    });
    const freshSnap = makeResourcesSnapshot({
      scannedAt: 200,
      held: [makeHeldWorktree({ targetKey: "12", keptAt: 200 })],
      attentionCount: 0,
    });

    const api = new FakeApi(makeSnapshot({}));
    api.resources = (query) => {
      if (query.get("refresh") === "1") return { status: 200, body: freshSnap };
      return new Promise((resolve) => {
        resolveInitialGet = (body) => resolve({ status: 200, body });
      });
    };
    api.resourceDecision = () => ({
      status: 200,
      body: { snapshot: freshSnap, removedBytes: 0 } satisfies ResourceDecisionResponse,
    });
    api.install();

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useResourcesModel({ deviceKey: LOCAL_DEVICE, enabled: true }), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(resolveInitialGet).toBeDefined());

    await act(async () => {
      await result.current.decide({ kind: "worktree", targetKey: "12", action: "keep" });
    });
    expect(result.current.snapshot?.attentionCount).toBe(0);

    await act(async () => {
      resolveInitialGet(staleSnap);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.snapshot?.scannedAt).toBe(200));
    expect(result.current.snapshot?.attentionCount).toBe(0);
  });
});
