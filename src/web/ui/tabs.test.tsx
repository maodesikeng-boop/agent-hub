import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tabs, TabsList, TabsTrigger } from "./tabs.tsx";

function TestTabs() {
  const [value, setValue] = useState("a");
  return (
    <Tabs value={value} onValueChange={setValue}>
      <TabsList aria-label="Views">
        <TabsTrigger value="a">A</TabsTrigger>
        <TabsTrigger value="b">B</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function spyTabFocus(): () => (FocusOptions | undefined)[] {
  const spy = vi.spyOn(HTMLElement.prototype, "focus");
  return () => spy.mock.contexts.flatMap((el, i) => ((el as HTMLElement).getAttribute("role") === "tab" ? [spy.mock.calls[i]![0]] : []));
}

describe("TabsTrigger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("focuses a pressed tab without a keyboard focus mark and still selects it", () => {
    render(<TestTabs />);
    const focusCalls = spyTabFocus();
    const b = screen.getByRole("tab", { name: "B" });
    fireEvent.mouseDown(b, { button: 0 });
    expect(b).toHaveFocus();
    expect(b).toHaveAttribute("aria-selected", "true");
    // The first call moves focus; a later focus() on the focused tab keeps its mark.
    expect(focusCalls()[0]).toMatchObject({ focusVisible: false });
  });

  it("leaves arrow-key moves to the browser's keyboard focus mark", async () => {
    render(<TestTabs />);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("tab", { name: "A" })).toHaveFocus();
    const focusCalls = spyTabFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "B" })).toHaveFocus();
    for (const options of focusCalls()) expect(options).not.toMatchObject({ focusVisible: false });
  });

  it("ignores secondary and ctrl presses", () => {
    render(<TestTabs />);
    const focusCalls = spyTabFocus();
    const b = screen.getByRole("tab", { name: "B" });
    fireEvent.mouseDown(b, { button: 2 });
    fireEvent.mouseDown(b, { button: 0, ctrlKey: true });
    expect(focusCalls()).toEqual([]);
    expect(b).toHaveAttribute("aria-selected", "false");
  });
});
