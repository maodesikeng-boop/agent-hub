import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GraphDeliveryRow } from "./components/GraphDeliveryRow.tsx";
import { Surface, SurfaceOutlet, SurfaceScope } from "./shell-surfaces.tsx";

const READY_AT = Date.parse("2026-11-27T12:17:50Z");
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(READY_AT + 5_000);
});
afterEach(() => vi.useRealTimers());

function Shell({ panelShown }: { panelShown: boolean }) {
  return (
    <SurfaceScope>
      {panelShown && <SurfaceOutlet id="panel" />}
      <Surface id="panel">
        <GraphDeliveryRow row={{ wait: { kind: "pm" }, since: READY_AT }} />
      </Surface>
    </SurfaceScope>
  );
}

const age = () => screen.getByText("Waiting for the PM").nextElementSibling?.textContent;

it("shows the real wait when a panel that was hidden while the graph finished comes back", () => {
  const view = render(<Shell panelShown={false} />);
  act(() => { vi.advanceTimersByTime(7 * MINUTE); });
  view.rerender(<Shell panelShown />);
  expect(age()).toBe("7m");
});

it("catches up when the page becomes visible again after its timers were held back", () => {
  render(<Shell panelShown />);
  expect(age()).toBe("<1m");
  vi.setSystemTime(READY_AT + 7 * MINUTE + 5_000);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(age()).toBe("7m");
});
