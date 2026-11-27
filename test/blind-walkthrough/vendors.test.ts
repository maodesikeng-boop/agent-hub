import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGY_FORCE_FILE_TOKEN_STORAGE_ENV } from "../../src/vendors/agy/paths.ts";
import { VENDOR_LIST } from "../../src/vendors/registry.ts";
import { listBlindVendorSupport, parseBlindActionResponse, resolveBlindVendorAdapter } from "./vendors.ts";

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

describe("vendors (S13, S14)", () => {
  it("S14: covers every registered AgentVendor in VENDOR_LIST with an explicit mode and reason", () => {
    const matrix = listBlindVendorSupport();
    const registeredIds = VENDOR_LIST.map((v) => v.id);
    expect(Object.keys(matrix).sort()).toEqual([...registeredIds].sort());

    for (const vendorId of registeredIds) {
      const entry = matrix[vendorId];
      expect(entry.vendor).toBe(vendorId);
      expect(["vision_cli", "a11y_cli", "unsupported"]).toContain(entry.mode);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("S14: resolves an adapter with an immutable systemPrompt for supported vendors", () => {
    const blindCwd = makeTempDir("blind-cwd-");
    const blindHome = makeTempDir("blind-home-");
    const systemPrompt = "You are a brand-new user testing an unfamiliar app.";
    const adapter = resolveBlindVendorAdapter({
      vendor: "claude",
      systemPrompt,
      blindCwd,
      blindHomeDir: blindHome,
    });

    expect(adapter.id).toBe("claude");
    expect(adapter.systemPrompt).toBe(systemPrompt);
  });

  it("S13: parses valid JSON responses and converts malformed or truncated vendor output into harness_noise without throwing", () => {
    const validJson = JSON.stringify({
      thought: "I see a button to create a new project.",
      confusion: null,
      action: { kind: "click_label", role: "button", label: "New Project" },
    });
    const parsedValid = parseBlindActionResponse(validJson);
    expect(parsedValid.ok).toBe(true);
    if (parsedValid.ok) {
      expect(parsedValid.response.action).toEqual({ kind: "click_label", role: "button", label: "New Project" });
    }

    const malformedCases = [
      "",
      "Sure! Here is what I would do next without JSON.",
      "{\"thought\":\"half-written",
      JSON.stringify({ thought: "missing action fields", confusion: null, action: { kind: "click_point" } }),
    ];
    for (const raw of malformedCases) {
      const parsed = parseBlindActionResponse(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.noiseReason.length).toBeGreaterThan(0);
      }
    }
  });

  it("rejects out-of-bounds click_point coordinates outside [0, 1000] and accepts normalized coordinates", () => {
    const valid = parseBlindActionResponse(
      JSON.stringify({
        thought: "Clicking the add button using normalized coordinates.",
        confusion: null,
        action: { kind: "click_point", x: 265, y: 88 },
      }),
    );
    expect(valid.ok).toBe(true);

    for (const bad of [
      { kind: "click_point", x: -1, y: 50 },
      { kind: "click_point", x: 1001, y: 50 },
      { kind: "click_point", x: 500, y: 1280 },
    ]) {
      const parsed = parseBlindActionResponse(JSON.stringify({ thought: "bad coords", confusion: null, action: bad }));
      expect(parsed.ok).toBe(false);
    }
  });

  it("isolates agy/claude/codex tool permissions, injects AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1, refuses host HOME, and blocks prompt leaks", async () => {
    const blindCwd = makeTempDir("blind-cwd-");
    const blindHome = makeTempDir("blind-home-");
    const scratch = makeTempDir("blind-stub-");
    const screenshot = join(scratch, "001-before.png");
    writeFileSync(screenshot, "png");
    const dumpPath = join(scratch, "invocation.json");
    const stubPath = join(scratch, "stub-cli.mjs");
    writeFileSync(
      stubPath,
      [
        `#!${process.execPath}`,
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));`,
        `console.log(JSON.stringify({ thought: "ok", confusion: null, action: { kind: "wait", reason: "ok" } }));`,
      ].join("\n"),
      "utf8",
    );
    chmodSync(stubPath, 0o755);

    const fakeHostHome = makeTempDir("blind-fake-host-home-");
    expect(() =>
      resolveBlindVendorAdapter({
        vendor: "agy",
        systemPrompt: "Blind prompt.",
        blindCwd,
        blindHomeDir: fakeHostHome,
        baseEnv: { HOME: fakeHostHome },
        platform: "darwin",
      }),
    ).toThrow(/host|home|isolated/i);

    const obs = {
      stepIndex: 1,
      missionId: "first-launch-orient" as const,
      viewport: { kind: "desktop" as const, width: 1280, height: 800 },
      url: "http://127.0.0.1:4317/",
      screenshotPath: screenshot,
      visualHash: "abc",
      a11yNodes: [],
      a11yText: "[button] \"New project manager\"",
      recentJournal: [],
    };

    const agyAdapter = resolveBlindVendorAdapter({
      vendor: "agy",
      systemPrompt: "Blind prompt.",
      blindCwd,
      blindHomeDir: blindHome,
      baseEnv: { PATH: process.env.PATH, HOME: fakeHostHome },
      platform: "darwin",
      executablePath: stubPath,
    });
    await agyAdapter.decideNext(obs, new AbortController().signal);
    const agyDump = JSON.parse(readFileSync(dumpPath, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(agyDump.env[AGY_FORCE_FILE_TOKEN_STORAGE_ENV]).toBe("1");
    expect(agyDump.env.HOME).toBe(blindHome);
    const settingsIdx = agyDump.argv.indexOf("--settings");
    expect(settingsIdx).toBeGreaterThan(-1);
    const agySettings = JSON.parse(agyDump.argv[settingsIdx + 1]!) as { permissions: { deny: string[] } };
    expect(agySettings.permissions.deny).toContain("command(*)");
    expect(agySettings.permissions.deny.some((rule) => rule.startsWith("read_file("))).toBe(true);

    const claudeAdapter = resolveBlindVendorAdapter({
      vendor: "claude",
      systemPrompt: "Blind prompt.",
      blindCwd,
      blindHomeDir: blindHome,
      baseEnv: { PATH: process.env.PATH, HOME: fakeHostHome },
      platform: "darwin",
      executablePath: stubPath,
    });
    await claudeAdapter.decideNext(obs, new AbortController().signal);
    const claudeDump = JSON.parse(readFileSync(dumpPath, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(claudeDump.argv).toContain("--strict-mcp-config");
    expect(claudeDump.argv).toContain("--no-session-persistence");
    expect(claudeDump.argv).toContain("--disallowedTools");
    expect(claudeDump.env.HOME).toBe(blindHome);

    const codexAdapter = resolveBlindVendorAdapter({
      vendor: "codex",
      systemPrompt: "Blind prompt.",
      blindCwd,
      blindHomeDir: blindHome,
      baseEnv: { PATH: process.env.PATH, HOME: fakeHostHome },
      platform: "darwin",
      executablePath: stubPath,
    });
    await codexAdapter.decideNext(obs, new AbortController().signal);
    const codexDump = JSON.parse(readFileSync(dumpPath, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(codexDump.argv).toContain("--ephemeral");
    expect(codexDump.argv).toContain("--ignore-user-config");
    expect(codexDump.argv).toContain("--sandbox");
    expect(codexDump.env.HOME).toBe(blindHome);

    await expect(
      agyAdapter.decideNext({ ...obs, url: "http://127.0.0.1:4317/auth?token=secret123" }, new AbortController().signal),
    ).rejects.toThrow(/leak|forbidden/i);

    expect(homedir().length).toBeGreaterThan(0);
  });

  it("marks unverified a11y_cli vendors unsupported, blocks all host vendor config dirs, and hardens pi CLI args", async () => {
    const matrix = listBlindVendorSupport();
    const blindCwd = makeTempDir("blind-cwd-");
    const blindHome = makeTempDir("blind-home-");
    const fakeHostHome = makeTempDir("blind-host-");

    for (const vendor of ["deepseek", "cursor", "opencode", "kimi"] as const) {
      expect(matrix[vendor].mode).toBe("unsupported");
      expect(matrix[vendor].supportsImageInput).toBe(false);
      expect(matrix[vendor].reason.trim().length).toBeGreaterThan(0);
      expect(() =>
        resolveBlindVendorAdapter({
          vendor,
          systemPrompt: "Blind prompt.",
          blindCwd,
          blindHomeDir: blindHome,
          baseEnv: { HOME: fakeHostHome },
          platform: "darwin",
        }),
      ).toThrow(/unsupported/i);
    }

    for (const rel of [".kimi-code", ".dsh", ".config/opencode", ".local/share/opencode", ".local/state/opencode", ".opencode", ".config/cursor", ".pi/agent"]) {
      expect(() =>
        resolveBlindVendorAdapter({
          vendor: "agy",
          systemPrompt: "Blind prompt.",
          blindCwd,
          blindHomeDir: join(fakeHostHome, rel),
          baseEnv: { HOME: fakeHostHome },
          platform: "darwin",
        }),
      ).toThrow(/overlaps host vendor config directory/i);
    }

    const scratch = makeTempDir("blind-pi-stub-");
    const dumpPath = join(scratch, "pi-invocation.json");
    const stubPath = join(scratch, "stub-pi.mjs");
    writeFileSync(
      stubPath,
      [
        `#!${process.execPath}`,
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));`,
        `console.log(JSON.stringify({ thought: "ok", confusion: null, action: { kind: "wait", reason: "ok" } }));`,
      ].join("\n"),
      "utf8",
    );
    chmodSync(stubPath, 0o755);

    const piAdapter = resolveBlindVendorAdapter({
      vendor: "pi",
      systemPrompt: "Blind prompt.",
      blindCwd,
      blindHomeDir: blindHome,
      model: "anthropic/claude-sonnet-5-5",
      effort: "low",
      baseEnv: {
        PATH: process.env.PATH,
        HOME: fakeHostHome,
        OPENCODE_API_KEY: "test-opencode-key",
        DEEPSEEK_API_KEY: "test-deepseek-key",
        GH_TOKEN: "should-not-leak",
      },
      platform: "darwin",
      executablePath: stubPath,
    });
    await piAdapter.decideNext(
      {
        stepIndex: 1,
        missionId: "first-launch-orient",
        viewport: { kind: "desktop", width: 1280, height: 800 },
        url: "http://127.0.0.1:4317/",
        screenshotPath: join(scratch, "missing.png"),
        visualHash: "abc",
        a11yNodes: [],
        a11yText: "[button] \"Router\"",
        recentJournal: [],
      },
      new AbortController().signal,
    );
    const piDump = JSON.parse(readFileSync(dumpPath, "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(piDump.argv).toContain("--no-tools");
    expect(piDump.argv).toContain("--no-mcp");
    expect(piDump.argv).toContain("--no-session");
    expect(piDump.argv).toContain("--no-context-files");
    expect(piDump.argv).toContain("--no-extensions");
    expect(piDump.argv).toContain("--model");
    expect(piDump.argv).toContain("anthropic/claude-sonnet-5-5");
    expect(piDump.argv).toContain("--thinking");
    expect(piDump.argv).toContain("low");
    expect(piDump.env.PI_CODING_AGENT_DIR).toBe(join(blindHome, ".pi", "agent"));
    expect(piDump.env.OPENCODE_API_KEY).toBe("test-opencode-key");
    expect(piDump.env.DEEPSEEK_API_KEY).toBe("test-deepseek-key");
    expect(piDump.env.GH_TOKEN).toBeUndefined();
  });
});
