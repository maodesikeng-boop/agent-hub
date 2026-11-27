import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_VENDORS, VENDOR_LIST } from "../../src/shared/index.ts";
import { VENDOR_PATHS } from "../../src/vendors/paths-registry.ts";
import { shortTmp } from "../e2e/harness.ts";
import { assertIsolatedHome, buildIsolatedEnv, createIsolatedHome } from "./isolation.ts";
import { MOCK_LLM_PROXY_BLACKHOLE_URL, MOCK_LLM_REQUIRE_ENV } from "./limits.ts";
import type { IsolatedHomeConfig } from "./types.ts";
import {
  VENDOR_MOCK_ADAPTERS,
  getVendorMockAdapter,
  listRealCliProbes,
  probeRealCli,
  resolveRequiredRealCliVendors,
} from "./vendors.ts";

const createdHomes: IsolatedHomeConfig[] = [];

afterEach(() => {
  while (createdHomes.length > 0) {
    createdHomes.pop()!.cleanup();
  }
});

describe("unchanged repository rules (regression baseline)", () => {
  it("keeps all 8 registered vendors in VENDOR_LIST with matching VENDOR_PATHS entries", () => {
    expect(AGENT_VENDORS).toHaveLength(8);
    expect(VENDOR_LIST.map((s) => s.id)).toEqual(AGENT_VENDORS);
    for (const vendor of AGENT_VENDORS) {
      expect(VENDOR_PATHS[vendor]).toBeDefined();
      expect(VENDOR_PATHS[vendor].fallbackPaths).toBeTypeOf("function");
    }
  });
});

describe("HOME isolation and egress safety", () => {
  it("refuses real homedir and any path inside real user HOME", () => {
    const real = homedir();
    expect(() => assertIsolatedHome(real, real)).toThrow(/real home|isolated/i);
    expect(() => assertIsolatedHome(join(real, ".claude"), real)).toThrow(/real home|isolated/i);
    expect(() => assertIsolatedHome(join(real, ".agent-hub"), real)).toThrow(/real home|isolated/i);
  });

  it("refuses non-existent subdirectories under a symlinked real HOME and case/NFC variants on APFS and NTFS", () => {
    const scratch = mkdtempSync(join(shortTmp(), "bw-sym-home-"));
    try {
      const targetHome = join(scratch, "real-home-target");
      const linkHome = join(scratch, "linked-home");
      mkdirSync(targetHome, { recursive: true });
      symlinkSync(targetHome, linkHome, "dir");

      expect(() => assertIsolatedHome(join(linkHome, ".claude-nonexistent", "nested"), targetHome)).toThrow(/real home|isolated/i);
      expect(() => assertIsolatedHome(join(targetHome, ".claude-nonexistent", "nested"), linkHome)).toThrow(/real home|isolated/i);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    expect(() =>
      assertIsolatedHome("/users/ALICE.EXAMPLE/.claude-nonexistent", "/Users/alice.example", "darwin"),
    ).toThrow(/real home|isolated/i);
    expect(() =>
      assertIsolatedHome("/Users/cafe\u0301/.claude-nonexistent", "/Users/caf\u00e9", "darwin"),
    ).toThrow(/real home|isolated/i);
    expect(() =>
      assertIsolatedHome("c:\\users\\ALICE\\.claude-nonexistent", "C:\\Users\\alice", "win32"),
    ).toThrow(/real home|isolated/i);
  });

  it("validates cross-platform homeDir against platform-specific paths without host cwd pollution", () => {
    const winEnv = buildIsolatedEnv({
      homeDir: "C:\\Temp\\bw-isolated-home",
      realHome: "C:\\Users\\alice",
      baseEnv: { PATH: "C:\\Windows\\System32" },
      platform: "win32",
    });
    expect(winEnv.HOME).toBe("C:\\Temp\\bw-isolated-home");
    expect(winEnv.USERPROFILE).toBe("C:\\Temp\\bw-isolated-home");
    expect(winEnv.APPDATA).toBe("C:\\Temp\\bw-isolated-home\\AppData\\Roaming");

    expect(() =>
      buildIsolatedEnv({
        homeDir: "c:\\users\\ALICE\\.claude",
        realHome: "C:\\Users\\alice",
        baseEnv: {},
        platform: "win32",
      }),
    ).toThrow(/real home|isolated/i);
  });

  it("creates an isolated home outside real HOME with POSIX socket paths under 104 bytes and removes it on cleanup", () => {
    const iso = createIsolatedHome({ prefix: "bw-iso-test-" });
    createdHomes.push(iso);
    expect(() => assertIsolatedHome(iso.homeDir)).not.toThrow();
    expect(existsSync(iso.homeDir)).toBe(true);
    expect(existsSync(iso.dataDir)).toBe(true);
    expect(existsSync(iso.workDir)).toBe(true);
    if (process.platform !== "win32") {
      expect(Buffer.byteLength(join(iso.dataDir, "run", "admin.sock"))).toBeLessThan(104);
    }

    const root = iso.rootDir;
    iso.cleanup();
    createdHomes.pop();
    expect(existsSync(root)).toBe(false);
  });

  it("scrubs every vendor credential env var and enforces loopback proxy blackhole across darwin, linux, and win32", () => {
    const iso = createIsolatedHome({ prefix: "bw-env-test-" });
    createdHomes.push(iso);

    const pollutedBase: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      ANTHROPIC_API_KEY: "real-anthropic",
      ANTHROPIC_AUTH_TOKEN: "real-token",
      OPENAI_API_KEY: "real-openai",
      CODEX_API_KEY: "real-codex",
      GEMINI_API_KEY: "real-gemini",
      DEEPSEEK_API_KEY: "real-deepseek",
      CURSOR_API_KEY: "real-cursor",
      OPENCODE_API_KEY: "real-opencode",
      KIMI_MODEL_API_KEY: "real-kimi",
      CLAUDECODE: "1",
      HUB_TOKEN: "leaked-hub-token",
      ALL_PROXY: "socks5://10.0.0.1:1080",
      all_proxy: "socks5://10.0.0.1:1080",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      AWS_ACCESS_KEY_ID: "AKIA-REAL",
      AWS_SECRET_ACCESS_KEY: "real-aws-secret",
      AWS_SESSION_TOKEN: "real-aws-session",
      AWS_PROFILE: "prod",
      GOOGLE_API_KEY: "real-google-key",
      GOOGLE_APPLICATION_CREDENTIALS: "/etc/google-creds.json",
      GITHUB_TOKEN: "ghp_real_token",
      GH_TOKEN: "ghp_real_gh_token",
    };

    for (const platform of ["darwin", "linux", "win32"] as const) {
      const env = buildIsolatedEnv({
        homeDir: iso.homeDir,
        baseEnv: pollutedBase,
        vendorEnv: { ANTHROPIC_BASE_URL: "http://127.0.0.1:41234", ANTHROPIC_API_KEY: "dummy-local-key" },
        platform,
      });
      expect(env.HOME).toBe(iso.homeDir);
      expect(env.USERPROFILE).toBe(iso.homeDir);
      expect(env.HTTP_PROXY).toBe(MOCK_LLM_PROXY_BLACKHOLE_URL);
      expect(env.HTTPS_PROXY).toBe(MOCK_LLM_PROXY_BLACKHOLE_URL);
      expect(env.ALL_PROXY).toBe(MOCK_LLM_PROXY_BLACKHOLE_URL);
      expect(env.NO_PROXY).toContain("127.0.0.1");
      if (platform !== "win32") {
        expect(env.all_proxy).toBe(MOCK_LLM_PROXY_BLACKHOLE_URL);
      }
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GEMINI_API_KEY).toBeUndefined();
      expect(env.DEEPSEEK_API_KEY).toBeUndefined();
      expect(env.CURSOR_API_KEY).toBeUndefined();
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.HUB_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
      expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
      expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.AWS_SESSION_TOKEN).toBeUndefined();
      expect(env.AWS_PROFILE).toBeUndefined();
      expect(env.GOOGLE_API_KEY).toBeUndefined();
      expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:41234");
      expect(env.ANTHROPIC_API_KEY).toBe("dummy-local-key");
      if (platform === "win32") {
        expect(env.APPDATA).toBeDefined();
        expect(env.LOCALAPPDATA).toBeDefined();
      }
    }
  });
});

describe("8-vendor mock adapter registry and CLI probing", () => {
  it("declares an adapter for every registered vendor in VENDOR_LIST and marks cursor unsupported_protocol", () => {
    expect(Object.keys(VENDOR_MOCK_ADAPTERS).sort()).toEqual([...AGENT_VENDORS].sort());
    for (const vendor of AGENT_VENDORS) {
      const adapter = getVendorMockAdapter(vendor);
      expect(adapter.vendor).toBe(vendor);
      expect(adapter.reason.length).toBeGreaterThan(10);
    }
    expect(getVendorMockAdapter("cursor").support).toBe("unsupported_protocol");
    expect(getVendorMockAdapter("cursor").dialect).toBeNull();
  });

  it("provisions isolated vendor config files inside temp HOME for every supported vendor without touching real HOME", () => {
    const iso = createIsolatedHome({ prefix: "bw-prov-test-" });
    createdHomes.push(iso);
    const mockBaseUrl = "http://127.0.0.1:43210";

    for (const vendor of AGENT_VENDORS) {
      const adapter = getVendorMockAdapter(vendor);
      if (adapter.support === "unsupported_protocol") {
        expect(() => adapter.provision({ homeDir: iso.homeDir, mockBaseUrl })).toThrow(/unsupported|proprietary/i);
        continue;
      }
      const provisioned = adapter.provision({ homeDir: iso.homeDir, mockBaseUrl });
      expect(provisioned.model.length).toBeGreaterThan(0);
      for (const file of provisioned.configFiles) {
        expect(file.startsWith(iso.homeDir)).toBe(true);
        expect(existsSync(file)).toBe(true);
      }
    }
  });

  it("probes all 8 vendors in VENDOR_LIST order and validates BELLWOOD_REQUIRE_REAL_CLI", () => {
    const probes = listRealCliProbes();
    expect(probes.map((p) => p.vendor)).toEqual(AGENT_VENDORS);
    for (const vendor of AGENT_VENDORS) {
      const single = probeRealCli(vendor);
      expect(single.vendor).toBe(vendor);
      expect(typeof single.installed).toBe("boolean");
    }

    expect(resolveRequiredRealCliVendors({ [MOCK_LLM_REQUIRE_ENV]: "codex, pi" })).toEqual(["codex", "pi"]);
    expect(resolveRequiredRealCliVendors({})).toEqual([]);
    expect(() => resolveRequiredRealCliVendors({ [MOCK_LLM_REQUIRE_ENV]: "unknown-vendor" })).toThrow(/unknown vendor/i);
  });
});
