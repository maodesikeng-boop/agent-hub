import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverInfoFor } from "../shared/index.ts";
import { createClient } from "./client.ts";
import { AppApprovalCard } from "./components/AppApprovalCard.tsx";
import { CompletedTab } from "./components/CompletedTab.tsx";
import { StatusText } from "./components/DeviceBadges.tsx";
import { Notices } from "./components/Notices.tsx";
import { RetryNotice } from "./components/RetryNotice.tsx";
import { ArchiveRemaining, TimeAgo } from "./components/TimeAgo.tsx";
import { DeviceScope } from "./device-scope.tsx";
import { Surface, SurfaceOutlet, SurfaceScope } from "./shell-surfaces.tsx";
import { completedDaysOf } from "./work-panel-model.ts";

const T0 = Date.parse("2026-11-27T12:00:00Z");
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

function Shell({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <SurfaceScope>
      {shown && <SurfaceOutlet id="panel" />}
      <Surface id="panel">{children}</Surface>
    </SurfaceScope>
  );
}

/** Shows `node`, hides it, lets `ms` pass with no timers firing (as a hidden surface drops them), then shows it again. */
function hideFor(node: ReactNode, ms: number, before?: () => void) {
  const view = render(<Shell shown>{node}</Shell>);
  before?.();
  view.rerender(<Shell shown={false}>{node}</Shell>);
  vi.setSystemTime(Date.now() + ms);
  view.rerender(<Shell shown>{node}</Shell>);
  return view;
}

describe("time shown in a surface that was hidden", () => {
  it("drops a retry countdown whose time passed while hidden", () => {
    const info = { attempt: 2, maxRetries: 10, retryAt: T0 + 15_000, errorStatus: null, error: "overloaded" };
    hideFor(<RetryNotice info={info} />, 20_000, () => expect(screen.getByText("in 15s")).toBeInTheDocument());
    expect(screen.queryByText(/^in \d+s$/)).toBeNull();
  });

  it("shows an app approval that expired while hidden as expired, with no buttons", () => {
    const client = createClient(null);
    const card = (
      <DeviceScope client={client} server={serverInfoFor("darwin")}>
        <AppApprovalCard workerId={5} appId="com.apple.calculator" appName="Calculator" riskLevel="low" approvalId={4}
          text="Let Computer Use control Calculator" expiresAt={T0 + 30_000} />
      </DeviceScope>
    );
    hideFor(card, 45_000);
    expect(screen.getByRole("status")).toHaveTextContent("Expired");
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("re-reads the clock as soon as the page becomes visible again", () => {
    const info = { attempt: 2, maxRetries: 10, retryAt: T0 + 30_000, errorStatus: null, error: "overloaded" };
    render(<Shell shown><RetryNotice info={info} /></Shell>);
    vi.setSystemTime(T0 + 20_000);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(screen.getByText("in 10s")).toBeInTheDocument();
  });
});

describe("relative times keep moving while shown", () => {
  it("advances how long a computer has been offline", () => {
    render(<Shell shown><StatusText status="offline" lastOnlineAt={T0} /></Shell>);
    expect(screen.getByText("just now")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5 * MINUTE); });
    expect(screen.getByText("5m ago")).toBeInTheDocument();
  });

  it("shows the current offline age when the surface comes back", () => {
    hideFor(<StatusText status="offline" lastOnlineAt={T0} />, 7 * MINUTE);
    expect(screen.getByText("7m ago")).toBeInTheDocument();
  });

  it("shows a fresh signed-in browser age and archive countdown when the surface comes back", () => {
    hideFor(<><TimeAgo at={T0} />|<ArchiveRemaining archivedAt={T0} /></>, 3 * 24 * 60 * MINUTE);
    expect(screen.getByText("3d ago|Deletes in 4d")).toBeInTheDocument();
  });

  it("advances the offline notice for the open computer", () => {
    render(<Notices health={[]} reconnecting={false} offline={{ name: "Tokyo", lastOnlineAt: T0 }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Tokyo is offline. Showing content from when it disconnected");
    act(() => { vi.advanceTimersByTime(4 * MINUTE); });
    expect(screen.getByRole("status")).toHaveTextContent("Tokyo is offline. Showing content from 4m ago");
  });

  it("moves Completed day headers from Today to Yesterday past midnight", () => {
    const lateEvening = new Date(2026, 10, 25, 23, 58).getTime();
    vi.setSystemTime(lateEvening);
    const days = completedDaysOf([{ total: 1, next: null, items: [
      { kind: "worker", conversationId: 1, workerId: 1, title: "Task A", outcome: "done", finishedAt: lateEvening - MINUTE, prUrl: null },
    ] }]);
    const query = { days, total: 1, status: "ready", error: null, hasMore: false, loadingMore: false, loadMore: vi.fn(), retry: vi.fn() } as const;
    render(<Shell shown><CompletedTab query={query} onOpenWorker={vi.fn()} /></Shell>);
    expect(screen.getByText("Today")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3 * MINUTE); });
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
  });
});
