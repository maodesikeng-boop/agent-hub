import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertBlindPromptClean,
  assertIsolatedWorkspace,
  buildBlindAgentEnv,
  sanitizeAccessibilitySnapshot,
  scanBlindPromptLeaks,
  type RawA11yNode,
} from "./context-barrier.ts";
import { BLIND_A11Y_MAX_NODES, BLIND_A11Y_SNAPSHOT_MAX_CHARS } from "./limits.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("context-barrier (S8, S9, S12, S15)", () => {
  it("S8: rejects ~/.agent-hub, symlinks into ~/.agent-hub, and active AGENT_HUB_HOME", () => {
    const fakeUserHome = makeTempDir("blind-user-home-");
    const realHubHome = join(fakeUserHome, ".agent-hub");
    mkdirSync(join(realHubHome, "state"), { recursive: true });
    const symlinkTarget = join(makeTempDir("blind-link-"), "sneaky-link");
    symlinkSync(realHubHome, symlinkTarget);
    const customHubHome = join(makeTempDir("blind-custom-hub-"), "custom-hub");
    mkdirSync(customHubHome, { recursive: true });

    expect(() => assertIsolatedWorkspace(realHubHome, { userHome: fakeUserHome, env: {} })).toThrow(/overlap|isolated|production/i);
    expect(() => assertIsolatedWorkspace(join(symlinkTarget, "state"), { userHome: fakeUserHome, env: {} })).toThrow(/overlap|isolated|production/i);
    expect(() => assertIsolatedWorkspace(customHubHome, { userHome: fakeUserHome, env: { AGENT_HUB_HOME: customHubHome } })).toThrow(/overlap|isolated|production/i);
  });

  it("S15: accepts isolated temp workspaces across darwin, linux, and win32 while rejecting case-folded collisions", () => {
    const safeTemp = makeTempDir("blind-safe-");
    expect(() => assertIsolatedWorkspace(safeTemp, { userHome: "/Users/alice", env: {}, platform: "darwin" })).not.toThrow();
    expect(() => assertIsolatedWorkspace(safeTemp, { userHome: "/home/alice", env: {}, platform: "linux" })).not.toThrow();
    expect(() => assertIsolatedWorkspace("C:\\Temp\\blind-run-1", { userHome: "C:\\Users\\Alice", env: {}, platform: "win32" })).not.toThrow();
    expect(() => assertIsolatedWorkspace("/USERS/ALICE/.AGENT-HUB/state", { userHome: "/Users/alice", env: {}, platform: "darwin" })).toThrow(/overlap|isolated|production/i);
  });

  it("S9: blocks prompts leaking repo paths, source terms, internal env vars, or test selectors", () => {
    const options = { repoRoot: "/workspace/bellwood-repo", worktreeRoot: "/workspace/wt/1538" };
    const cleanText = "You just opened a desktop workbench app for the first time. Try creating a workspace for /tmp/demo-notes and send a message.";
    expect(scanBlindPromptLeaks(cleanText, options)).toEqual([]);
    expect(() => assertBlindPromptClean(cleanText, options)).not.toThrow();

    const leakyPrompt = [
      "Open /workspace/bellwood-repo/src/web/App.tsx",
      "Check AGENTS.md and click data-testid=\"rail-device-dot-local\"",
      "Inspect AGENT_HUB_HOME and ui-token",
    ].join("\n");
    const leaks = scanBlindPromptLeaks(leakyPrompt, options);
    expect(leaks.length).toBeGreaterThanOrEqual(4);
    expect(() => assertBlindPromptClean(leakyPrompt, options)).toThrow(/leak|forbidden/i);
  });

  it("S9 & S12: strips data-testid and internal attributes from accessibility snapshots and enforces node and character caps", () => {
    const children: RawA11yNode[] = Array.from({ length: BLIND_A11Y_MAX_NODES + 80 }, (_, index) => ({
      role: "button",
      name: `Action ${index} ${"x".repeat(50)}`,
      testId: `secret-testid-${index}`,
      attributes: { "data-testid": `secret-testid-${index}`, "data-internal-id": `row-${index}` },
    }));
    const raw: RawA11yNode = { role: "main", name: "Workbench", testId: "root-workbench", children };
    const sanitized = sanitizeAccessibilitySnapshot(raw);

    expect(sanitized.nodes.length).toBeLessThanOrEqual(BLIND_A11Y_MAX_NODES);
    expect(sanitized.text.length).toBeLessThanOrEqual(BLIND_A11Y_SNAPSHOT_MAX_CHARS);
    expect(sanitized.text).not.toContain("secret-testid");
    expect(sanitized.text).not.toContain("data-testid");
    expect(sanitized.text).not.toContain("data-internal-id");
    expect(sanitized.nodes[0]?.name).toBe("Workbench");
  });

  it("S9 & S15: scrubs Bellwood, GitHub, and SSH variables when building blind-agent environment", () => {
    const blindHome = makeTempDir("blind-home-");
    const env = buildBlindAgentEnv(
      {
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        HUB_TOKEN: "secret-hub-token",
        HUB_SOCK: "/tmp/hub.sock",
        AGENT_HUB_HOME: "/Users/alice/.agent-hub",
        AGENT_HUB_PORT: "4317",
        GH_TOKEN: "ghp_secret",
        GITHUB_TOKEN: "ghp_secret_2",
        SSH_AUTH_SOCK: "/tmp/ssh.sock",
      },
      blindHome,
      "darwin",
    );

    expect(env.HOME).toBe(blindHome);
    expect(env.USERPROFILE).toBe(blindHome);
    expect(env.HUB_TOKEN).toBeUndefined();
    expect(env.HUB_SOCK).toBeUndefined();
    expect(env.AGENT_HUB_HOME).toBeUndefined();
    expect(env.AGENT_HUB_PORT).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });
});
