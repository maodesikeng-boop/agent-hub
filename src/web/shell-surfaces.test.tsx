import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import { expect, it, vi } from "vitest";
import { Surface, SurfaceOutlet, SurfaceScope } from "./shell-surfaces.tsx";

function Field({ connected, stop }: { connected: (connected: boolean) => void; stop: () => void }) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    connected(input.current?.isConnected === true);
    return stop;
  }, [connected, stop]);
  return <input aria-label="Draft" ref={input} value={draft} onChange={(event) => setDraft(event.target.value)} />;
}

function Harness({ layout, page = "original", connected, stop }: {
  layout: "wide" | "narrow" | "hidden";
  page?: string;
  connected: (connected: boolean) => void;
  stop: () => void;
}) {
  return (
    <SurfaceScope>
      {layout !== "hidden" && <section key={layout} aria-label={layout}><SurfaceOutlet id="conversation" /></section>}
      <Surface id="conversation" key={page}><Field connected={connected} stop={stop} /></Surface>
    </SurfaceScope>
  );
}

it("moves the same focused control to each outlet without restarting its effects", async () => {
  const connected = vi.fn();
  const stop = vi.fn();
  const { rerender } = render(<Harness layout="wide" connected={connected} stop={stop} />);
  const input = screen.getByRole("textbox", { name: "Draft" });
  expect(connected.mock.calls).toEqual([[true]]);
  fireEvent.change(input, { target: { value: "draft text" } });
  input.focus();
  for (const layout of ["narrow", "wide", "narrow", "wide"] as const) {
    rerender(<Harness layout={layout} connected={connected} stop={stop} />);
    expect(screen.getByRole("region", { name: layout })).toContainElement(input);
    expect(input).toHaveValue("draft text");
    await waitFor(() => expect(input).toHaveFocus());
  }
  expect(stop).not.toHaveBeenCalled();
  expect(connected).toHaveBeenCalledOnce();
});

it("pauses effects while the outlet is missing and resumes with the same draft", () => {
  const connected = vi.fn();
  const stop = vi.fn();
  const view = render(<Harness layout="wide" connected={connected} stop={stop} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "still here" } });
  view.rerender(<Harness layout="hidden" connected={connected} stop={stop} />);
  expect(input).not.toBeInTheDocument();
  expect(stop).toHaveBeenCalledOnce();
  view.rerender(<Harness layout="narrow" connected={connected} stop={stop} />);
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input).toHaveValue("still here");
  expect(connected.mock.calls).toEqual([[true], [true]]);
  view.unmount();
  expect(input).not.toBeInTheDocument();
  expect(stop).toHaveBeenCalledTimes(2);
});

it("gives a new page a fresh editor even when its outlet does not change", () => {
  const connected = vi.fn();
  const stop = vi.fn();
  const { rerender } = render(<Harness layout="wide" connected={connected} stop={stop} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "one page only" } });
  rerender(<Harness page="different" layout="wide" connected={connected} stop={stop} />);
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(input).not.toBeInTheDocument();
});
