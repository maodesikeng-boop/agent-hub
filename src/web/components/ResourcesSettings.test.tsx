import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeldResourceItem, ResourceCleanupResponse, ResourceDecisionResponse, ResourcesSnapshot } from "../../shared/index.ts";
import { FakeApi, makeSnapshot } from "../test-utils.ts";
import { ResourcesSettings } from "./ResourcesSettings.tsx";

const HELD_WORKTREE: HeldResourceItem = {
  kind: "worktree",
  targetKey: "42",
  reason: "uncommitted_changes",
  label: "#42 Fix auth flow",
  projectId: 1,
  projectName: "bellwood",
  bytes: 12 * 1024 * 1024,
  detectedAt: 1_760_000_000_000,
  samplePaths: ["src/auth.ts", "src/auth.test.ts"],
  keptAt: null,
  workerId: 42,
  branch: "hub/42-fix-auth",
  worktreePath: "/Users/dev/.agent-hub/worktrees/1/42",
  dirtyCount: 2,
};

function makeResources(held: HeldResourceItem[] = [HELD_WORKTREE]): ResourcesSnapshot {
  const attentionCount = held.filter((h) => h.keptAt === null).length;
  return {
    scannedAt: 1_760_000_000_000,
    database: {
      fileBytes: 18 * 1024 * 1024,
      walBytes: 512 * 1024,
      freelistBytes: 0,
      dbstatAvailable: true,
      tables: [{ table: "messages", bytes: 10 * 1024 * 1024, rows: 12_000, rowLimit: null, warning: false }],
    },
    directories: [
      { id: "worktrees", label: "Worktrees", bytes: 12 * 1024 * 1024, fileCount: 40, maxBytes: null, maxFiles: null, truncated: false, warning: false },
      { id: "sentFiles", label: "Delivered files", bytes: 4 * 1024 * 1024, fileCount: 15, maxBytes: 256 * 1024 * 1024, maxFiles: null, truncated: false, warning: false },
    ],
    branches: [{ projectId: 1, projectName: "bellwood", repoFolder: "/repo", activeCount: 1, mergedCleanableCount: 3, unmergedHeldCount: 0 }],
    processes: { trackedCount: 2, leakedCount: 0 },
    held,
    heldTruncated: false,
    totalDiskBytes: 34 * 1024 * 1024,
    attentionCount,
  };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ResourcesSettings active />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ResourcesSettings", () => {
  it("renders Database, Storage, Worktrees & branches, and Processes overview rows", async () => {
    const api = new FakeApi(makeSnapshot({}));
    api.resources = () => ({ status: 200, body: makeResources([]) });
    api.install();
    renderPanel();

    const overview = await screen.findByRole("region", { name: "Overview" });
    expect(within(overview).getByText("Database")).toBeVisible();
    expect(within(overview).getByText("Storage")).toBeVisible();
    expect(within(overview).getByText("Worktrees & branches")).toBeVisible();
    expect(within(overview).getByText("Processes")).toBeVisible();
    expect(within(overview).getByText("2 tracked")).toBeVisible();
  });

  it("renders unacknowledged held items in Needs attention with Keep and Discard actions", async () => {
    const api = new FakeApi(makeSnapshot({}));
    api.resources = () => ({ status: 200, body: makeResources([HELD_WORKTREE]) });
    api.install();
    renderPanel();

    const attention = await screen.findByRole("region", { name: "Needs attention" });
    expect(within(attention).getByText("#42 Fix auth flow")).toBeVisible();
    expect(within(attention).getByText("Uncommitted changes")).toBeVisible();
    expect(within(attention).getByText("src/auth.ts, src/auth.test.ts")).toBeVisible();
    expect(within(attention).getByRole("button", { name: "Keep" })).toBeVisible();
    expect(within(attention).getByRole("button", { name: "Discard…" })).toBeVisible();
  });

  it("opens a destructive confirmation dialog before executing Discard", async () => {
    const user = userEvent.setup();
    const api = new FakeApi(makeSnapshot({}));
    let current = makeResources([HELD_WORKTREE]);
    const decisionBodies: unknown[] = [];
    api.resources = () => ({ status: 200, body: current });
    api.resourceDecision = (body) => {
      decisionBodies.push(body);
      current = makeResources([]);
      return { status: 200, body: { snapshot: current, removedBytes: 12 * 1024 * 1024 } satisfies ResourceDecisionResponse };
    };
    api.install();
    renderPanel();

    const attention = await screen.findByRole("region", { name: "Needs attention" });
    await user.click(within(attention).getByRole("button", { name: "Discard…" }));
    expect(decisionBodies).toEqual([]);

    const dialog = await screen.findByRole("dialog", { name: "Discard worktree?" });
    await user.click(within(dialog).getByRole("switch", { name: "Also delete branch hub/42-fix-auth" }));
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));

    await waitFor(() => expect(decisionBodies).toEqual([{ kind: "worktree", targetKey: "42", action: "discard", deleteBranch: true }]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull());
  });

  it("moves kept items into the default-collapsed Kept by you group", async () => {
    const user = userEvent.setup();
    const api = new FakeApi(makeSnapshot({}));
    let current = makeResources([HELD_WORKTREE]);
    api.resources = () => ({ status: 200, body: current });
    api.resourceDecision = () => {
      current = makeResources([{ ...HELD_WORKTREE, keptAt: 1_760_000_005_000 }]);
      return { status: 200, body: { snapshot: current, removedBytes: 0 } satisfies ResourceDecisionResponse };
    };
    api.install();
    renderPanel();

    const attention = await screen.findByRole("region", { name: "Needs attention" });
    await user.click(within(attention).getByRole("button", { name: "Keep" }));

    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull());
    const keptRegion = await screen.findByRole("region", { name: "Kept by you" });
    const trigger = within(keptRegion).getByRole("button", { name: /Kept by you/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(within(keptRegion).getByText("#42 Fix auth flow")).toBeVisible();
    expect(within(keptRegion).getByRole("button", { name: "Unkeep" })).toBeVisible();
  });

  it("triggers Refresh and Run cleanup and shows inline errors when a request fails", async () => {
    const user = userEvent.setup();
    const api = new FakeApi(makeSnapshot({}));
    let failCleanup = false;
    api.resources = () => ({ status: 200, body: makeResources([]) });
    api.resourceCleanup = () => {
      if (failCleanup) return { status: 500, body: { error: "cleanup failed" } };
      return {
        status: 200,
        body: {
          snapshot: makeResources([]),
          purgedDbRows: 25,
          reclaimedDbPages: 4,
          removedFiles: 2,
          removedWorktrees: 0,
          removedBranches: 3,
          removedTempDirs: 0,
          reapedProcesses: 0,
        } satisfies ResourceCleanupResponse,
      };
    };
    api.install();
    renderPanel();

    const overview = await screen.findByRole("region", { name: "Overview" });
    await user.click(within(overview).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.callsTo("GET", /^\/api\/resources$/)).toHaveLength(2));
    expect(api.callsTo("GET", /^\/api\/resources$/)[1]?.query.get("refresh")).toBe("1");

    await user.click(within(overview).getByRole("button", { name: "Run cleanup" }));
    expect(await within(overview).findByText("Cleaned 25 DB rows, 2 files, 3 branches")).toBeVisible();

    failCleanup = true;
    await user.click(within(overview).getByRole("button", { name: "Run cleanup" }));
    expect(await screen.findByRole("alert")).toBeVisible();
  });
});
