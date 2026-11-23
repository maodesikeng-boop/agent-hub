import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { serverInfoFor } from "../../shared/index.ts";
import { createClient } from "../client.ts";
import { DeviceScope } from "../device-scope.tsx";
import type { QuotaVendor } from "../selectors.ts";
import { QuotaPopover } from "./QuotaPopover.tsx";

const TEST_SERVER = serverInfoFor("darwin");

const SAMPLE_QUOTA: QuotaVendor[] = [
  {
    id: "v1",
    name: "Provider Alpha",
    exhausted: false,
    windows: [
      { key: "five_hour", short: "5h", percent: 42, resetsAt: Date.now() + 90 * 60_000, warning: false },
      { key: "seven_day", short: "7d", percent: 84, resetsAt: Date.now() + 3 * 24 * 60 * 60_000, warning: true },
    ],
  },
  {
    id: "v2",
    name: "Provider Beta",
    exhausted: true,
    windows: [{ key: "daily", short: "24h", percent: 100, resetsAt: Date.now() + 45 * 60_000, warning: true }],
  },
];

describe("QuotaPopover", () => {
  it("renders a framed Usage header, vendor sections with compact reset metadata, and tone-coded progress bars", async () => {
    const user = userEvent.setup();
    render(
      <DeviceScope client={createClient(null)} server={TEST_SERVER}>
        <QuotaPopover quota={SAMPLE_QUOTA} />
      </DeviceScope>,
    );

    await user.click(screen.getByRole("button", { name: "Usage limit reached" }));
    const dialog = await screen.findByRole("dialog", { name: "Usage" });
    expect(within(dialog).getByRole("heading", { level: 2, name: "Usage" })).toBeVisible();

    const alpha = within(dialog).getByRole("region", { name: "Provider Alpha" });
    expect(within(alpha).getByText("5h")).toBeVisible();
    expect(within(alpha).getByText("42%")).toBeVisible();
    expect(within(alpha).getByText("84%")).toBeVisible();
    expect(within(alpha).getAllByText(/^Resets /)).toHaveLength(2);
    const bar5h = within(alpha).getByRole("progressbar", { name: "5h usage" });
    expect(bar5h.firstElementChild).toHaveClass("bg-rail-ink");
    const bar7d = within(alpha).getByRole("progressbar", { name: "7d usage" });
    expect(bar7d.firstElementChild).toHaveClass("bg-caution");

    const beta = within(dialog).getByRole("region", { name: "Provider Beta" });
    const bar24h = within(beta).getByRole("progressbar", { name: "24h usage" });
    expect(bar24h.firstElementChild).toHaveClass("bg-danger");
    expect(within(beta).getByText("100%")).toHaveClass("text-danger");
  });
});
