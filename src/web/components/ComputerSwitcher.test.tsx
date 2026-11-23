import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_DEVICE } from "../devices.ts";
import type { RailComputer } from "../rail-model.ts";
import { ComputerSwitcher } from "./ComputerSwitcher.tsx";

const COMPUTERS: RailComputer[] = [
  { key: LOCAL_DEVICE, name: "MacBook Pro", platform: "darwin", status: "online", badge: 0 },
  { key: "tokyo", name: "Office Mini", platform: "linux", status: "offline", badge: 3 },
  { key: "win-box", name: "Build Box", platform: "win32", status: "reconnecting", badge: 1 },
];

function Harness({
  variant,
  initialSelected = LOCAL_DEVICE,
  onSelect = vi.fn(),
  onManage = vi.fn(),
}: {
  variant: "popover" | "drawer";
  initialSelected?: string;
  onSelect?: (key: string) => void;
  onManage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ComputerSwitcher
      variant={variant}
      open={open}
      computers={COMPUTERS}
      selected={initialSelected}
      trigger={<button type="button">Switch computer</button>}
      onOpenChange={setOpen}
      onSelect={onSelect}
      onManage={onManage}
    />
  );
}

describe("ComputerSwitcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists every computer with its status, connection, and ask badge, and marks the selected one", async () => {
    const user = userEvent.setup();
    render(<Harness variant="popover" initialSelected={LOCAL_DEVICE} />);
    await user.click(screen.getByRole("button", { name: "Switch computer" }));

    const dialog = await screen.findByRole("dialog", { name: "Computers" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /MacBook Pro.*Online/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /Office Mini.*Offline.*3/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: /Build Box.*Reconnecting.*1/ })).toBeInTheDocument();
  });

  it("selects a computer and closes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness variant="popover" onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "Switch computer" }));
    await user.click(await screen.findByRole("button", { name: /Build Box/ }));
    expect(onSelect).toHaveBeenCalledWith("win-box");
    expect(screen.queryByRole("dialog", { name: "Computers" })).toBeNull();
  });

  it("keeps offline computers selectable", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness variant="popover" onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "Switch computer" }));
    const offlineBtn = await screen.findByRole("button", { name: /Office Mini/ });
    expect(offlineBtn).toBeEnabled();
    await user.click(offlineBtn);
    expect(onSelect).toHaveBeenCalledWith("tokyo");
  });

  it("opens Settings on Computers from Manage computers...", async () => {
    const user = userEvent.setup();
    const onManage = vi.fn();
    render(<Harness variant="popover" onManage={onManage} />);

    await user.click(screen.getByRole("button", { name: "Switch computer" }));
    await user.click(await screen.findByRole("button", { name: "Manage computers..." }));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Computers" })).toBeNull();
  });

  it("renders as a popover on the desktop and a bottom drawer on the phone", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const user = userEvent.setup();
    const { unmount } = render(<Harness variant="popover" />);
    await user.click(screen.getByRole("button", { name: "Switch computer" }));
    expect(document.querySelector("[data-slot='popover-content']")).not.toBeNull();
    expect(document.querySelector("[data-slot='drawer-content']")).toBeNull();
    unmount();

    render(<Harness variant="drawer" />);
    await user.click(screen.getByRole("button", { name: "Switch computer" }));
    expect(document.querySelector("[data-slot='drawer-content']")).not.toBeNull();
  });
});
