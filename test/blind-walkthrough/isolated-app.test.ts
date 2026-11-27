import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_HOME } from "../../src/shared/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import { assertCleanTeardown, buildIsolatedDaemonEnv, createSampleUserProject, launchIsolatedBellwood, stopIsolatedBellwood } from "./isolated-app.ts";

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

describe("isolated-app (S4, S8)", () => {
  it("S8: refuses to launch an isolated daemon inside ~/.agent-hub", async () => {
    const fakeUserHome = makeTempDir("blind-user-home-");
    const realHub = join(fakeUserHome, ".agent-hub");
    mkdirSync(realHub, { recursive: true });

    await expect(
      launchIsolatedBellwood({
        tempRoot: realHub,
        appVendorMode: { kind: "fake" },
        userHome: fakeUserHome,
        baseEnv: {},
      }),
    ).rejects.toThrow(/overlap|isolated|production/i);
  });

  it("creates a realistic sample git repository for cold-start onboarding", () => {
    const parent = makeTempDir("blind-sample-");
    const projectDir = createSampleUserProject(parent);
    expect(existsSync(join(projectDir, ".git"))).toBe(true);
    expect(existsSync(join(projectDir, "README.md"))).toBe(true);
  });

  it("S4: assertCleanTeardown passes when no child PIDs are alive and throws when a live PID remains recorded", () => {
    const isolatedHome = makeTempDir("blind-teardown-");
    const paths = resolveHubPaths({ [ENV_HOME]: isolatedHome }, isolatedHome);
    mkdirSync(paths.stateDir, { recursive: true });

    writeFileSync(paths.childProcessesFile, "[]\n");
    expect(() => assertCleanTeardown(isolatedHome)).not.toThrow();

    writeFileSync(
      paths.childProcessesFile,
      `${JSON.stringify([{ pid: process.pid, purpose: "leaked-test-child", startedAt: 1 }])}\n`,
    );
    expect(() => assertCleanTeardown(isolatedHome)).toThrow(/surviving|alive|pid/i);
  });

  it("S4: starts a real isolated Bellwood instance with loopback folder-picker bridge and stops it cleanly with zero leftover files", async () => {
    const tempRoot = makeTempDir("blind-daemon-");
    const handle = await launchIsolatedBellwood({
      tempRoot,
      appVendorMode: { kind: "fake" },
      folderPickerMode: "bridge_sample_project",
      buildWeb: false,
    });
    try {
      expect(handle.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.isRunning()).toBe(true);
      expect(handle.folderBridgeActive).toBe(true);
      expect(existsSync(handle.sampleProjectDir)).toBe(true);
      const auth = await fetch(handle.loginUrl, { redirect: "manual" });
      const cookie = (auth.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
      const pick = await fetch(`${handle.origin}/api/pick-folder`, {
        method: "POST",
        headers: { cookie, origin: handle.origin, "content-type": "application/json" },
        body: "{}",
      });
      expect(pick.status).toBe(200);
      expect((await pick.json()) as { path: string | null }).toEqual({ path: handle.sampleProjectDir });
    } finally {
      await stopIsolatedBellwood(handle, true);
    }
    expect(handle.isRunning()).toBe(false);
    expect(existsSync(handle.homeDir)).toBe(false);
  }, 60_000);

  it("R2 credential passthrough: forwards only target vendor credential env vars and isolated config home for real appVendorMode", () => {
    const tempRoot = makeTempDir("blind-r2-env-");
    const isolatedVendorHome = makeTempDir("blind-r2-vendor-home-");
    const baseEnv = {
      PATH: "/usr/bin:/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      GEMINI_API_KEY: "gemini-secret",
      OPENCODE_API_KEY: "opencode-secret",
      GH_TOKEN: "github-should-not-pass",
      HUB_TOKEN: "hub-should-not-pass",
    };

    const claudeEnv = buildIsolatedDaemonEnv({
      homeDir: join(tempRoot, "h-claude"),
      userHomeDir: join(tempRoot, "u-claude"),
      scratchDir: join(tempRoot, "s-claude"),
      appVendorMode: { kind: "real", vendor: "claude", isolatedHomeDir: isolatedVendorHome },
      platform: "darwin",
      baseEnv,
      bridge: null,
    });
    expect(claudeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-oauth-secret");
    expect(claudeEnv.ANTHROPIC_API_KEY).toBe("anthropic-secret");
    expect(claudeEnv.CLAUDE_CONFIG_DIR).toBe(join(isolatedVendorHome, ".claude"));
    expect(claudeEnv.GEMINI_API_KEY).toBeUndefined();
    expect(claudeEnv.OPENCODE_API_KEY).toBeUndefined();
    expect(claudeEnv.GH_TOKEN).toBeUndefined();
    expect(claudeEnv.HUB_TOKEN).toBeUndefined();

    const agyEnv = buildIsolatedDaemonEnv({
      homeDir: join(tempRoot, "h-agy"),
      userHomeDir: join(tempRoot, "u-agy"),
      scratchDir: join(tempRoot, "s-agy"),
      appVendorMode: { kind: "real", vendor: "agy", isolatedHomeDir: isolatedVendorHome },
      platform: "darwin",
      baseEnv,
      bridge: null,
    });
    expect(agyEnv.GEMINI_API_KEY).toBe("gemini-secret");
    expect(agyEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(agyEnv.OPENCODE_API_KEY).toBeUndefined();

    const opencodeEnv = buildIsolatedDaemonEnv({
      homeDir: join(tempRoot, "h-oc"),
      userHomeDir: join(tempRoot, "u-oc"),
      scratchDir: join(tempRoot, "s-oc"),
      appVendorMode: { kind: "real", vendor: "opencode", isolatedHomeDir: isolatedVendorHome },
      platform: "darwin",
      baseEnv,
      bridge: null,
    });
    expect(opencodeEnv.OPENCODE_API_KEY).toBe("opencode-secret");
    expect(opencodeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    const fakeEnv = buildIsolatedDaemonEnv({
      homeDir: join(tempRoot, "h-fake"),
      userHomeDir: join(tempRoot, "u-fake"),
      scratchDir: join(tempRoot, "s-fake"),
      appVendorMode: { kind: "fake" },
      platform: "darwin",
      baseEnv,
      bridge: null,
    });
    expect(fakeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(fakeEnv.GEMINI_API_KEY).toBeUndefined();
    expect(fakeEnv.OPENCODE_API_KEY).toBeUndefined();
  });
});
