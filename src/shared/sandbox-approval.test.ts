import { describe, it } from "vitest";

describe("sandbox-approval shared validation", () => {
  describe("eligibleComputerUseCapabilities", () => {
    it.todo("returns Codex static Computer Use capability keys and matching plugin MCP items from inventory");
    it.todo("returns an empty list for vendors without a built-in sandbox (pi, opencode, kimi)");
    it.todo("returns an empty list for vendors with a built-in sandbox that declare no Computer Use capability yet");
  });

  describe("validateNoOuterSandboxRequest (Hard Condition 1)", () => {
    it.todo("accepts Codex on macOS when caps is custom with mcp:cua_repl and PM policy allows it");
    it.todo("rejects with computer_use_not_mounted when WorkerCapabilities mode is inherit");
    it.todo("rejects with computer_use_not_mounted when WorkerCapabilities mode is none");
    it.todo("rejects with computer_use_not_mounted when custom allow list omits Computer Use keys");
    it.todo("rejects with computer_use_disabled_by_policy when project policy disables mcp:cua_repl");
    it.todo("rejects with computer_use_not_installed when inventory does not contain the Computer Use capability");
    it.todo("rejects with readonly_incompatible when readonly is true");
    it.todo("rejects with review_incompatible when review is true");
    it.todo("rejects with vendor_no_builtin_sandbox for pi, opencode, and kimi");
    it.todo("rejects with platform_unsupported on linux and win32");
  });

  describe("resolveOuterSandboxLaunchMode (launch-time defense in depth)", () => {
    it.todo("returns enforced when no approval record exists for the Worker");
    it.todo("returns vendor_only only when approval is approved, worker is open, platform and vendor match, and Computer Use stays enabled");
    it.todo("returns block when approval status is pending, rejected, or revoked");
    it.todo("returns block when worker status is ended even if approval row is stale");
    it.todo("returns block when Computer Use capability was disabled after approval");
    it.todo("returns block when readonly is true");
  });

  describe("card and rejection copy", () => {
    it.todo("includes Worker ID, title, task summary, dropped Bellwood data-dir/credential protection, vendor whole-disk read warning, and single-run expiry");
    it.todo("formats rejection notice naming the Worker for the Project Manager");
  });
});
