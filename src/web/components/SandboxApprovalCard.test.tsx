import { describe, it } from "vitest";

describe("SandboxApprovalCard", () => {
  it.todo("renders Worker identity, task summary, dropped outer-sandbox protection warning, and single-run expiry notice");
  it.todo("posts approve or reject to API_PATHS.decideSandboxApproval and prevents double submission while pending");
  it.todo("renders settled approved, rejected, and cancelled states without action buttons");
  it.todo("displays API errors in an alert region when a decision fails");
});
