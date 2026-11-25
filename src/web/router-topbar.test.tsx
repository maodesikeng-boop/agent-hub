import { describe, expect, it } from "vitest";
import { RouterTopBar, type RouterTopBarProps } from "./components/RouterTopBar.tsx";
import { RouterTopBarPopover, type RouterTopBarPopoverProps } from "./components/RouterTopBarPopover.tsx";
import { RouterTurnRow, type RouterTurnRowProps } from "./components/RouterTurnRow.tsx";
import { PopoverAnchor } from "./ui/popover.tsx";

describe("RouterTopBar", () => {
  it("exposes the planned component contract surface", () => {
    expect(typeof RouterTopBar).toBe("function");
    expect(typeof RouterTopBarPopover).toBe("function");
    expect(RouterTurnRow).toBeDefined();
    expect(PopoverAnchor).toBeDefined();
    type ContractTypes = [RouterTopBarProps, RouterTopBarPopoverProps, RouterTurnRowProps];
    const _typeCheck: ContractTypes | null = null;
    expect(_typeCheck).toBeNull();
  });

  it.todo("renders the centered translucent Message Router input with RouterAvatar in the 40px top bar on desktop conversation views");
  it.todo("switches to the solid focused appearance on focus and blurs back to resting translucent state on Escape when the popover is closed");
  it.todo("keeps the 40px wood top bar empty when hidden on #/router");
  it.todo("does not render in the mobile shell (MOBILE_SHELL_QUERY)");
  it.todo("sends a Router command on Enter without leaving the current PM conversation and opens the anchored reply popover");
  it.todo("shows live Working status, Router Markdown reply, clickable PM and Worker destinations, and inline ForwardReply inside the popover");
  it.todo("focuses the bottom follow-up reply row on popover open and appends follow-up turns into the same popover");
  it.todo("supports Shift+Enter for newlines and Enter to send inside the popover reply row while respecting IME composition");
  it.todo("supports retrying both send_failed and failed server Router turns directly inside the popover");
  it.todo("navigates to #/router, hands off any unsent follow-up draft, and closes the popover when Expand is clicked");
  it.todo("closes the popover on Close button, Escape, outside click, or clicking a destination row without cancelling an in-flight Router command");
  it.todo("keeps the popover open when clicking inside the top-bar input or inside an open FilePreview dialog");
  it.todo("starts a fresh quick-chat view on the next send after closing the popover while all sent turns remain in #/router");
  it.todo("marks the input wrapper [data-no-drag] so clicking it never fires windowDrag, while clicking blank top-bar wood still drags and zooms");
  it.todo("dismisses the Settings page and focuses the Router input when the top-bar input is clicked while Settings is open");
});
