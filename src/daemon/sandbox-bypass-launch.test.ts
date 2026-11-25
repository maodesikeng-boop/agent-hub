import { describe, it } from "vitest";

describe("no-outer-sandbox launch and driver enforcement", () => {
  it.todo("wraps normal Workers in Bellwood's outer OS sandbox with outerSandbox enforced");
  it.todo("sets outerSandbox vendor_only and skips prepareOsSandbox only when the Worker has an approved open record");
  it.todo("retains LaunchFiles.writeScope for Codex so buildSandboxPolicy emits workspaceWrite excluding protectedRoots and approval callbacks stay active");
  it.todo("spawns Codex without /usr/bin/sandbox-exec when outerSandbox is vendor_only while keeping osSandboxed false");
  it.todo("fails closed in createLaunchPreparer if an approval record is pending, rejected, revoked, or its Computer Use capability was disabled");
  it.todo("never allows vendors without builtInSandbox (pi, opencode, kimi) to omit the outer sandbox wrapper");
});
