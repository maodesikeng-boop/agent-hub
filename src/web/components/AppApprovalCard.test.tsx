import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { serverInfoFor, type DecideAppApprovalResponse } from "../../shared/index.ts";
import { ApiError, createClient, type HubClient } from "../client.ts";
import { DeviceScope } from "../device-scope.tsx";
import { AppApprovalCard, AppApprovalCardView, type AppApprovalCardProps } from "./AppApprovalCard.tsx";

const app = { workerId: 5, workerTitle: "Check totals", appId: "com.apple.calculator", appName: "Calculator",
  riskLevel: "low", warning: null } as const;

function mount(props: Partial<AppApprovalCardProps> = {}, decide = vi.fn<HubClient["postDecideAppApproval"]>()) {
  const client = { ...createClient(null), postDecideAppApproval: decide };
  render(<DeviceScope client={client} server={serverInfoFor("darwin")}>
    <AppApprovalCard {...app} approvalId={4} text="Let Computer Use control Calculator" {...props} />
  </DeviceScope>);
  return decide;
}

describe("Computer Use app approval card", () => {
  it("shows the app name, exact app id, risk level, Worker number and title, and time left", () => {
    render(<AppApprovalCardView {...app} status="pending" remainingMs={70000} />);
    const card = screen.getByRole("article", { name: "Computer Use app approval" });
    for (const part of ["Calculator", app.appId, "Low risk", "Worker #5", app.workerTitle, "1:10"]) expect(card).toHaveTextContent(part);
  });
  it("posts allow once with a stable clientId and ignores repeat clicks in flight", async () => {
    let fail: (reason: Error) => void = () => {};
    const pending = new Promise<DecideAppApprovalResponse>((_, reject) => { fail = reject; });
    const decide = mount({}, vi.fn().mockReturnValueOnce(pending).mockRejectedValueOnce(new Error("Try again")));
    const allow = screen.getByRole("button", { name: "Allow for this run" });
    act(() => { fireEvent.click(allow); fireEvent.click(allow); });
    expect(decide).toHaveBeenCalledExactlyOnceWith(4, { decision: "allow", clientId: expect.any(String) });
    await act(async () => fail(new Error("Try again")));
    fireEvent.click(allow);
    expect(decide.mock.calls[1]).toEqual(decide.mock.calls[0]);
  });
  it("posts deny", async () => {
    const decide = mount({}, vi.fn().mockResolvedValue({ approval: { status: "denied" } }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(decide).toHaveBeenCalledExactlyOnceWith(4, { decision: "deny", clientId: expect.any(String) });
    expect(await screen.findByRole("status")).toHaveTextContent("Denied");
  });
  it("shows the settled label and no buttons once allowed, denied, expired, or ended", () => {
    for (const label of ["Allowed for this run", "Denied", "Expired", "Ended with the Worker"]) {
      mount({ answered: true, chosenOption: label, closed: label === "Expired" });
      expect(screen.getByRole("status")).toHaveTextContent(label);
      expect(screen.queryByRole("button")).toBeNull();
      cleanup();
    }
  });
  it("shows the server error inline and keeps the buttons", async () => {
    mount({}, vi.fn().mockRejectedValue(new ApiError(409, { code: "conflict", text: "Approval ended", raw: "Approval ended" })));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Approval ended");
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });
});
