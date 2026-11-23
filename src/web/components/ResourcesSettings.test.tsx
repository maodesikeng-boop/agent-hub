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
  it("renders plain-language storage overview rows and humanized storage breakdown", async () => {
    const user = userEvent.setup();
    const api = new FakeApi(makeSnapshot({}));
    api.resources = () => ({ status: 200, body: makeResources([]) });
    api.install();
    renderPanel();

    const overview = await screen.findByRole("region", { name: "Summary" });
    expect(within(overview).getByText("Chat & app data")).toBeVisible();
    expect(within(overview).getByText("Files & workspaces")).toBeVisible();
    expect(within(overview).getByText("Worker workspaces")).toBeVisible();
    expect(within(overview).getByText("Background processes")).toBeVisible();
    expect(within(overview).getByText("2 running")).toBeVisible();
    expect(within(overview).getByText("3 ready to clean")).toBeVisible();

    const breakdown = screen.getByRole("region", { name: "Storage breakdown" });
    await user.click(within(breakdown).getByRole("button", { name: /Storage breakdown/ }));
    expect(within(breakdown).getByText("Worker workspaces")).toBeVisible();
    expect(within(breakdown).getByText("Chat messages")).toBeVisible();
    expect(within(breakdown).getByText("12,000 records")).toBeVisible();
  });

  it("renders unacknowledged held items in Needs review with Keep and Delete actions", async () => {
    const api = new FakeApi(makeSnapshot({}));
    api.resources = () => ({ status: 200, body: makeResources([HELD_WORKTREE]) });
    api.install();
    renderPanel();

    const review = await screen.findByRole("region", { name: "Needs review" });
    expect(within(review).getByText("#42 Fix auth flow")).toBeVisible();
    expect(within(review).getByText("Unsaved file edits")).toBeVisible();
    expect(within(review).getByText("src/auth.ts, src/auth.test.ts")).toBeVisible();
    expect(within(review).getByRole("button", { name: "Keep" })).toBeVisible();
    expect(within(review).getByRole("button", { name: "Delete…" })).toBeVisible();
  });

  it("opens a destructive confirmation dialog before executing Delete", async () => {
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

    const review = await screen.findByRole("region", { name: "Needs review" });
    await user.click(within(review).getByRole("button", { name: "Delete…" }));
    expect(decisionBodies).toEqual([]);

    const dialog = await screen.findByRole("dialog", { name: "Delete workspace?" });
    await user.click(within(dialog).getByRole("switch", { name: "Also delete branch hub/42-fix-auth" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(decisionBodies).toEqual([{ kind: "worktree", targetKey: "42", action: "discard", deleteBranch: true }]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs review" })).toBeNull());
  });

  it("moves kept items into the default-collapsed Kept group", async () => {
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

    const review = await screen.findByRole("region", { name: "Needs review" });
    await user.click(within(review).getByRole("button", { name: "Keep" }));

    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs review" })).toBeNull());
    const keptRegion = await screen.findByRole("region", { name: "Kept" });
    const trigger = within(keptRegion).getByRole("button", { name: /Kept/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(within(keptRegion).getByText("#42 Fix auth flow")).toBeVisible();
    expect(within(keptRegion).getByRole("button", { name: "Allow cleanup" })).toBeVisible();
  });

  it("triggers Refresh and Clean up and shows inline errors when a request fails", async () => {
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

    const overview = await screen.findByRole("region", { name: "Summary" });
    await user.click(within(overview).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.callsTo("GET", /^\/api\/resources$/)).toHaveLength(2));
    expect(api.callsTo("GET", /^\/api\/resources$/)[1]?.query.get("refresh")).toBe("1");

    await user.click(within(overview).getByRole("button", { name: "Clean up" }));
    expect(await within(overview).findByText("Cleaned 25 old records, 2 files, 3 branches")).toBeVisible();

    failCleanup = true;
    await user.click(within(overview).getByRole("button", { name: "Clean up" }));
    expect(await screen.findByRole("alert")).toBeVisible();
  });
});
