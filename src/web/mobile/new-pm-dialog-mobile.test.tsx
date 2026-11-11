import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CUSTOM_MODEL, DEFAULT_AGENT_VENDOR, serverInfoFor } from "../../shared/index.ts";
import { createClient } from "../client.ts";
import { NewPmDialog, type NewPmDevice } from "../components/NewPmDialog.tsx";
import { LOCAL_DEVICE } from "../devices.ts";
import { FakeApi, makeSnapshot } from "../test-utils.ts";
import { MOBILE_SHELL_QUERY, useIsMobile } from "../useMediaQuery.ts";

function installViewport(mobile: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: mobile && query === MOBILE_SHELL_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

function makeLocalDevice(folderPicker = true): NewPmDevice {
  return {
    key: LOCAL_DEVICE,
    name: "MacBook Pro",
    status: "online",
    client: createClient(null),
    server: { ...serverInfoFor("darwin"), folderPicker },
  };
}

describe("NewPmDialog mobile full-screen & desktop parity", () => {
  let api: FakeApi;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    api = new FakeApi(makeSnapshot());
    api.install();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes useIsMobile matching MOBILE_SHELL_QUERY", () => {
    function Probe() {
      return <output>{String(useIsMobile())}</output>;
    }
    installViewport(true);
    const { unmount } = render(<Probe />);
    expect(screen.getByRole("status")).toHaveTextContent("true");
    unmount();

    installViewport(false);
    render(<Probe />);
    expect(screen.getByRole("status")).toHaveTextContent("false");
  });

  it("renders full-screen safe-area & keyboard-aware layout on mobile with ghost 44px close button and scrollable body", async () => {
    installViewport(true);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <NewPmDialog
        open
        devices={[makeLocalDevice(true)]}
        defaultDevice={LOCAL_DEVICE}
        onOpenChange={onOpenChange}
        onCreated={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "New project manager" });
    expect(dialog).toHaveClass("fixed", "inset-0", "overflow-hidden");
    expect(dialog.className).toContain("pt-[var(--safe-top)]");
    expect(dialog.className).toContain("pb-[max(var(--safe-bottom),var(--kb-inset))]");
    expect(dialog.className).not.toContain("max-w-130");
    expect(dialog.className).not.toContain("w-[calc(100%-48px)]");

    const nameInput = within(dialog).getByRole("textbox", { name: "Name" });
    expect(nameInput).not.toHaveFocus();
    expect(nameInput.className).not.toContain("w-60");

    const folderInput = within(dialog).getByRole("textbox", { name: "Main folder" });
    expect(folderInput.className).not.toContain("w-60");

    const closeBtn = within(dialog).getByRole("button", { name: "Close" });
    expect(closeBtn).toHaveClass("touch-target", "text-muted-foreground");
    expect(closeBtn.className).not.toMatch(/(^|\s)bg-/);
    expect(closeBtn.className).not.toContain("border");

    const body = dialog.querySelector<HTMLElement>('[data-slot="dialog-body"]')!;
    expect(body).toHaveClass("overflow-y-auto", "overflow-x-hidden", "overscroll-y-contain");

    const createBtn = within(dialog).getByRole("button", { name: "Create" });
    expect(body).not.toContainElement(createBtn);
    expect(createBtn.closest('[data-slot="dialog-footer"]')).not.toBeNull();
    expect(createBtn).toHaveClass("w-full", "h-11");

    await user.click(closeBtn);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables autoCapitalize, autoCorrect, and spellCheck on non-prose inputs (Main folder & Custom model)", async () => {
    installViewport(true);
    const user = userEvent.setup();

    render(
      <NewPmDialog
        open
        devices={[makeLocalDevice(false)]}
        defaultDevice={LOCAL_DEVICE}
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "New project manager" });
    const folderInput = within(dialog).getByRole("textbox", { name: "Main folder" });
    expect(folderInput).toHaveAttribute("autocapitalize", "none");
    expect(folderInput).toHaveAttribute("autocorrect", "off");
    expect(folderInput).toHaveAttribute("spellcheck", "false");

    await user.click(within(dialog).getByRole("button", { name: "More settings" }));
    const modelSelect = within(dialog).getByRole("combobox", { name: "Model" });
    await user.selectOptions(modelSelect, CUSTOM_MODEL);

    const customModelInput = within(dialog).getByRole("textbox", { name: "Model name" });
    expect(customModelInput).toHaveAttribute("autocapitalize", "none");
    expect(customModelInput).toHaveAttribute("autocorrect", "off");
    expect(customModelInput).toHaveAttribute("spellcheck", "false");
    expect(customModelInput.className).not.toContain("w-60");
  });

  it("submits NewPmDialog form end-to-end on mobile", async () => {
    installViewport(true);
    const user = userEvent.setup();
    const onCreated = vi.fn();

    render(
      <NewPmDialog
        open
        devices={[makeLocalDevice(false)]}
        defaultDevice={LOCAL_DEVICE}
        onOpenChange={() => {}}
        onCreated={onCreated}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "New project manager" });
    const createBtn = within(dialog).getByRole("button", { name: "Create" });
    expect(createBtn).toBeDisabled();

    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "  Mobile PM  ");
    await user.type(within(dialog).getByRole("textbox", { name: "Main folder" }), "/Users/dev/project");
    await user.click(within(dialog).getByRole("radio", { name: "Hands-on" }));
    await user.click(within(dialog).getByRole("button", { name: "More settings" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Persona" }), "Ship cleanly.");

    expect(createBtn).toBeEnabled();
    await user.click(createBtn);

    await waitFor(() => expect(api.callsTo("POST", /^\/api\/pms$/)).toHaveLength(1));
    expect(api.callsTo("POST", /^\/api\/pms$/)[0]?.body).toEqual({
      name: "Mobile PM",
      folder: "/Users/dev/project",
      mode: "hands_on",
      vendor: DEFAULT_AGENT_VENDOR,
      persona: "Ship cleanly.",
    });
    expect(onCreated).toHaveBeenCalledWith(LOCAL_DEVICE, expect.any(Number));
  });

  it("preserves 100% desktop modal styling, w-60 inputs, autoFocus, and submission when !mobile", async () => {
    installViewport(false);
    const user = userEvent.setup();
    const onCreated = vi.fn();

    render(
      <NewPmDialog
        open
        devices={[makeLocalDevice(true)]}
        defaultDevice={LOCAL_DEVICE}
        onOpenChange={() => {}}
        onCreated={onCreated}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "New project manager" });
    expect(dialog).toHaveClass("max-w-130", "rounded-2xl", "p-6");
    expect(dialog.className).not.toContain("inset-0");

    const nameInput = within(dialog).getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(nameInput).toHaveFocus());
    expect(nameInput).toHaveClass("w-60");

    const folderInput = within(dialog).getByRole("textbox", { name: "Main folder" });
    expect(folderInput).toHaveClass("w-60", "min-w-0");
    expect(folderInput).toHaveAttribute("autocapitalize", "none");
    expect(folderInput).toHaveAttribute("autocorrect", "off");
    expect(folderInput).toHaveAttribute("spellcheck", "false");

    const createBtn = within(dialog).getByRole("button", { name: "Create" });
    expect(createBtn.className).not.toContain("w-full");

    await user.type(nameInput, "Desktop PM");
    await user.click(createBtn);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(LOCAL_DEVICE, expect.any(Number)));
  });
});
