import { describe, it } from "vitest";

describe("PUT /api/pms/:id/pin", () => {
  it.todo("calls setPmPinned with the parsed boolean and returns { pm }");
  it.todo("rejects a body without a boolean pinned with 400 and does not call setPmPinned");
  it.todo("maps conflict and not_found from the ledger to their HTTP statuses");
  it.todo("is reachable for a remote computer through the device proxy");
});
