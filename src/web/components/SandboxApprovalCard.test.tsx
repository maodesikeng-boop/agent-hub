import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SANDBOX_APPROVAL } from "../../../test/sandbox-approval-fixture.ts";
import { formatSandboxApprovalCardText, serverInfoFor, type DecideSandboxApprovalResponse } from "../../shared/index.ts";
import { ApiError, createClient, type HubClient } from "../client.ts";
import { DeviceScope } from "../device-scope.tsx";
import { SandboxApprovalCard, type SandboxApprovalCardProps } from "./SandboxApprovalCard.tsx";

function mount(overrides: Partial<SandboxApprovalCardProps> = {}, decide = vi.fn<HubClient["postDecideSandboxApproval"]>()) {
  const client = { ...createClient(null), postDecideSandboxApproval: decide };
  render(<DeviceScope client={client} server={serverInfoFor("darwin")}>
    <SandboxApprovalCard approvalId={4} text={formatSandboxApprovalCardText(SANDBOX_APPROVAL)} {...overrides} />
  </DeviceScope>);
  return decide;
}

describe("Worker sandbox confirmation card", () => {
  it("discloses the Worker, task, readable state, and expiry", () => {
    mount();
    const card = screen.getByRole("article", { name: "Worker sandbox approval" });
    for (const part of ["Worker #5", "Inspect a Calculator window", "state/", "credentials", "until it ends"]) expect(card).toHaveTextContent(part);
  });

  it.each([["Approve this run", "approve"], ["Reject", "reject"]] as const)("sends one request immediately when the user clicks %s", async (label, value) => {
    let finish: (value: DecideSandboxApprovalResponse) => void = () => {};
    const deferred = new Promise<DecideSandboxApprovalResponse>((resolve) => { finish = resolve; });
    const post = mount({}, vi.fn().mockReturnValue(deferred));
    const button = screen.getByRole("button", { name: label });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(4, { decision: value, clientId: expect.any(String) });
    await act(async () => finish({ approval: SANDBOX_APPROVAL, workerStatus: "open" }));
    expect(await screen.findByRole("status")).toHaveTextContent(value === "approve" ? "Approved" : "Rejected");
  });

  it.each(["Approved", "Rejected", "Closed"])("displays %s without action buttons", (status) => {
    mount({ answered: true, chosenOption: status, closed: status === "Closed" });
    expect(screen.getByRole("status")).toHaveTextContent(status);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps both choices available if the decision fails", async () => {
    mount({}, vi.fn().mockRejectedValue(new ApiError(409, { text: "Computer Use is unavailable", code: "conflict", raw: "Computer Use is unavailable" })));
    fireEvent.click(screen.getByRole("button", { name: "Approve this run" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Computer Use is unavailable");
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });
});
