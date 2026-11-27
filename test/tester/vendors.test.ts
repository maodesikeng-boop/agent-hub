import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VENDOR_LIST, vendorSpec, type AgentVendor } from "../../src/shared/index.ts";
import { VENDOR_PATHS } from "../../src/vendors/paths-registry.ts";
import { AGY_FORCE_FILE_TOKEN_STORAGE_ENV } from "../../src/vendors/agy/paths.ts";
import { coverageLines } from "./cli.ts";
import { installCommandFor, installVendor, loginCommandFor, openGaps, probeVendor, VENDOR_BENCH, type CommandRunner, type ProbeTarget, type VendorReadiness } from "./vendors.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tester-vendors-"));
  dirs.push(dir);
  return dir;
}

describe("VENDOR_BENCH", () => {
  it("has a coverage decision for every vendor in VENDOR_LIST", () => {
    expect(Object.keys(VENDOR_BENCH).sort()).toEqual(VENDOR_LIST.map((v) => v.id).sort());
    for (const recipe of Object.values(VENDOR_BENCH).flatMap(Object.values)) {
      if (recipe.coverage === "accepted_gap") expect(recipe.status).toBe("signed_out");
    }
  });

  it("names only models the vendor accepts (bundled, or custom when the vendor allows custom models)", () => {
    for (const { id: vendor } of VENDOR_LIST) for (const recipe of Object.values(VENDOR_BENCH[vendor])) {
      if (recipe.coverage !== "turn" || recipe.model === null) continue;
      const models = vendorSpec(vendor).models;
      const bundled = models.bundled.some((m) => m.id === recipe.model);
      expect(bundled || models.customModel === true, `${vendor} model ${recipe.model}`).toBe(true);
    }
  });

  it("lists fallback test files that exist for every accepted gap", () => {
    for (const recipe of Object.values(VENDOR_BENCH).flatMap(Object.values)) {
      if (recipe.coverage !== "accepted_gap") continue;
      for (const file of recipe.fallbackTests) expect(existsSync(join(REPO, file)), file).toBe(true);
    }
  });

  it("runs Claude Code on both computers and Codex and Antigravity only on the Mac", () => {
    const turns = (role: "local" | "remote") => VENDOR_LIST.filter(({ id }) => VENDOR_BENCH[id][role].coverage === "turn").map(({ id }) => id);
    expect(turns("local").sort()).toEqual(["agy", "claude", "codex"]);
    expect(turns("remote")).toEqual(["claude"]);
  });
});

describe("installCommandFor and loginCommandFor", () => {
  it("returns the product's installCommand, or windowsInstallCommand on win32", () => {
    expect(installCommandFor("claude", "darwin")).toBe(VENDOR_PATHS.claude.installCommand);
    expect(installCommandFor("claude", "win32")).toBe(VENDOR_PATHS.claude.windowsInstallCommand);
    for (const { id } of VENDOR_LIST) expect(installCommandFor(id, "linux").length).toBeGreaterThan(0);
  });

  it("throws for a vendor that ships no install command on the platform", () => {
    const paths = VENDOR_PATHS.claude as { installCommand?: string };
    const saved = paths.installCommand;
    try {
      delete paths.installCommand;
      expect(() => installCommandFor("claude", "linux")).toThrow(/ships no install command for linux/);
    } finally {
      paths.installCommand = saved;
    }
  });

  it("prefers the product's headlessLoginCommand and falls back to the spec's cli.loginCommand", () => {
    expect(loginCommandFor("codex")).toBe("codex login --device-auth");
    expect(VENDOR_PATHS.claude.headlessLoginCommand).toBeUndefined();
    expect(loginCommandFor("claude")).toBe(vendorSpec("claude").cli.loginCommand);
  });
});

describe("installVendor", () => {
  const target = (root: string, run: CommandRunner, resolveCli: () => string | null) => ({
    instance: "local" as const,
    userHome: join(root, "home"),
    npmPrefix: join(root, "data", "tools", "npm"),
    path: "/bench/bin:/usr/bin",
    installDir: join(root, "install"),
    platform: "darwin" as const,
    env: { CODEX_HOME: join(root, "home", ".codex") },
    run,
    resolveCli,
  });

  it("runs the install command with HOME and the npm global prefix inside the bench HOME", async () => {
    const root = scratch();
    const seen: Array<{ command: string; env: Record<string, string> }> = [];
    const run: CommandRunner = async (command, env) => (seen.push({ command, env }), { exitCode: 0, stderr: "" });
    const result = await installVendor("deepseek", target(root, run, () => join(root, "data", "tools", "npm", "bin", "dsh")));
    expect(seen[0]!.command).toBe(VENDOR_PATHS.deepseek.installCommand);
    expect(seen[0]!.env).toMatchObject({ HOME: join(root, "home"), npm_config_prefix: join(root, "data", "tools", "npm"), PATH: "/bench/bin:/usr/bin", CODEX_HOME: join(root, "home", ".codex") });
    expect(result).toMatchObject({ vendor: "deepseek", status: "signed_out", acceptedGap: expect.any(String) });
    expect(existsSync(join(root, "install", "deepseek.json"))).toBe(true);
  });

  it("reports install_failed with the exit code and the last 20 stderr lines", async () => {
    const root = scratch();
    const stderr = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = await installVendor("kimi", target(root, async () => ({ exitCode: 7, stderr }), () => null));
    expect(result.status).toBe("install_failed");
    expect(result.detail).toContain("exited 7");
    expect(result.detail).toContain("line 30");
    expect(result.detail).toContain("line 11");
    expect(result.detail).not.toContain("line 10\n");
    expect(result.fix).toContain(VENDOR_PATHS.kimi.installCommand!);
    const missing = await installVendor("pi", target(root, async () => ({ exitCode: 0, stderr: "" }), () => null));
    expect(missing).toMatchObject({ status: "install_failed", detail: expect.stringContaining("exited 0 but the CLI is not inside the bench HOME") });
  });
});

describe("probeVendor", () => {
  const provider = (availability: "available" | "signed_out" | "not_installed" | "unknown", installed = availability !== "not_installed") => ({ installed, version: installed ? "2.0" : null, availability, accountSummary: availability === "available" ? "owner@example" : null });
  const local = (root: string, cliPath: string | null) => ({ cliPath, userHome: join(root, "home"), env: {}, installDir: join(root, "install") });

  it("prints the local Claude token path and explicit bench.json mapping", () => {
    const entry = probeVendor("claude", { instance: "local", provider: provider("signed_out"), local: local(scratch(), "/bench/claude"), platform: "darwin" });
    const [line] = coverageLines([entry]);
    expect(line).toContain("secrets/claude-oauth-token");
    expect(line).toContain("bench.json");
    expect(line).toContain('"CLAUDE_CODE_OAUTH_TOKEN": "@secrets/claude-oauth-token"');
  });

  it("reports not_installed when the CLI does not resolve from the bench HOME and PATH, ignoring the developer's own tool directories", () => {
    const root = scratch();
    const entry = probeVendor("codex", { instance: "local", provider: provider("available"), local: local(root, null), platform: "darwin" });
    expect(entry).toMatchObject({ status: "not_installed", fix: expect.stringContaining("vendors install") });
    writeFileSync(join(mkdirSync(join(root, "install"), { recursive: true })!, "codex.json"), JSON.stringify({ vendor: "codex", command: "x", exitCode: 1, stderrTail: "boom", at: "t" }));
    expect(probeVendor("codex", { instance: "local", provider: provider("not_installed"), local: local(root, null), platform: "darwin" })).toMatchObject({ status: "install_failed", detail: expect.stringContaining("boom") });
  });

  it("reports signed_out when the CLI is installed but the daemon reports signed_out or the status command shows no account", () => {
    const root = scratch();
    const entry = probeVendor("pi", { instance: "local", provider: provider("signed_out"), local: local(root, "/b/pi"), platform: "darwin" });
    expect(entry).toMatchObject({ status: "signed_out", fix: expect.stringContaining("No sign-in needed"), acceptedGap: expect.any(String) });
    expect(probeVendor("cursor", { instance: "remote", provider: provider("signed_out"), platform: "linux" }).acceptedGap).toMatch(/cannot use Cursor/);
    expect(probeVendor("opencode", { instance: "local", provider: provider("signed_out"), local: local(root, "/b/opencode"), platform: "darwin" })).toMatchObject({ status: "signed_out", acceptedGap: expect.any(String) });
    const opencodeUnknown = probeVendor("opencode", { instance: "local", provider: provider("unknown"), local: local(root, "/b/opencode"), platform: "darwin" });
    expect(opencodeUnknown.status).toBe("unknown");
    expect(opencodeUnknown.acceptedGap).toBeUndefined();
  });

  it("reports ready only when the CLI resolves, the daemon reports available, and the account is signed in", () => {
    const root = scratch();
    mkdirSync(join(root, "home", ".codex"), { recursive: true });
    writeFileSync(join(root, "home", ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "test-token" } }));
    expect(probeVendor("codex", { instance: "local", provider: provider("available"), local: local(root, "/b/codex"), platform: "darwin" })).toMatchObject({ status: "ready", version: "2.0", detail: "owner@example" });
    expect(probeVendor("codex", { instance: "remote", provider: provider("available"), platform: "linux" }).status).toBe("ready");
    expect(probeVendor("agy", { instance: "local", provider: provider("available"), local: local(root, "/b/agy"), platform: "darwin" }).status).toBe("login_blocked");
    mkdirSync(join(root, "home", ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(root, "home", ".gemini", "antigravity-cli", "antigravity-oauth-token"), JSON.stringify({ token: { refresh_token: "test-token" } }));
    expect(probeVendor("agy", { instance: "local", provider: provider("available"), local: local(root, "/b/agy"), platform: "darwin" }).status).toBe("ready");
    expect(probeVendor("codex", { instance: "local", provider: provider("unknown"), local: local(root, "/b/codex"), platform: "darwin" }).status).toBe("unknown");
  });

  it.each([
    ["claude", ".claude.json", { oauthAccount: { emailAddress: "account@example.test" } }],
    ["codex", ".codex/auth.json", { tokens: { access_token: "" } }],
    ["agy", ".gemini/mcp-oauth-tokens.json", { access_token: "an MCP credential" }],
  ] as const)("blocks %s when only non-login data is in the bench HOME", (vendor, file, contents) => {
    const root = scratch();
    const target = local(root, "/bench/cli");
    const path = join(target.userHome, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(contents));
    expect(probeVendor(vendor, { instance: "local", provider: provider("available"), local: target, platform: "darwin" }).status).toBe("login_blocked");
  });

  it("names the fix command for every non-ready status", () => {
    const root = scratch();
    const targets: ProbeTarget[] = [
      { instance: "remote", provider: null, platform: "linux" },
      { instance: "local", provider: provider("not_installed"), local: local(root, null), platform: "darwin" },
      { instance: "local", provider: provider("signed_out"), local: local(root, "/b/x"), platform: "darwin" },
      { instance: "local", provider: provider("available"), local: local(root, "/b/x"), platform: "darwin" },
    ];
    for (const { id } of VENDOR_LIST) {
      for (const t of targets) {
        const entry = probeVendor(id, t);
        if (entry.status !== "ready") expect(entry.fix.length, `${id} ${entry.status}`).toBeGreaterThan(0);
      }
    }
  });

  it("starts no model turn", () => {
    const entry = probeVendor("claude", { instance: "remote", provider: provider("available"), platform: "linux" });
    expect(entry).not.toBeInstanceOf(Promise);
  });

  it("acceptance S3: includes AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 in macOS agy loginFix so bench sign-in writes file token instead of popping Keychain", () => {
    const entry = probeVendor("agy", { instance: "local", provider: provider("signed_out"), local: local(scratch(), "/bench/agy"), platform: "darwin" });
    expect(entry.fix).toContain(`${AGY_FORCE_FILE_TOKEN_STORAGE_ENV}=1`);
  });
});

describe("openGaps", () => {
  const entry = (vendor: AgentVendor, status: VendorReadiness["status"]): VendorReadiness => ({ vendor, instance: "local", status, version: null, detail: "", fix: "f" });

  it("returns every non-ready entry of a turn vendor", () => {
    const coverage = [entry("claude", "ready"), entry("codex", "signed_out"), entry("agy", "unknown"), entry("pi", "login_blocked")];
    expect(openGaps(coverage).map((e) => e.vendor)).toEqual(["codex", "agy", "pi"]);
  });

  it("leaves out an accepted gap vendor whose status equals its accepted status, while coverage still lists it", () => {
    const coverage = [entry("kimi", "signed_out"), entry("cursor", "signed_out")];
    expect(openGaps(coverage)).toEqual([]);
    expect(coverage).toHaveLength(2);
  });

  it("returns an accepted gap vendor whose status differs from its accepted status, such as install_failed", () => {
    expect(openGaps([entry("deepseek", "install_failed"), entry("opencode", "not_installed"), entry("kimi", "ready")]).map((e) => e.status)).toEqual(["install_failed", "not_installed"]);
  });
});
