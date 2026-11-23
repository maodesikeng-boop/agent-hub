import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_HOME, ENV_MESH_PORT, ENV_PORT, VENDOR_LIST } from "../../src/shared/index.ts";
import { assertNotProduction, assertTestAccount, benchRoot, BenchConfigError, openBench, parseBenchConfig, ProductionGuardError, TESTER_HOME_ENV, type BenchConfig, type InstanceClient } from "./bench.ts";
import { localDaemonEnv } from "./local-instance.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tester-bench-"));
  dirs.push(dir);
  return dir;
}

function config(root: string, over: Partial<BenchConfig> = {}): BenchConfig {
  return {
    version: 1,
    root,
    instances: [
      { name: "mac", role: "local", dataDir: join(root, "local", "home"), userHome: join(root, "local", "user-home"), uiPort: 4417, meshPort: 4421, env: {} },
      { name: "tokyo", role: "remote", deviceId: "dev_remote", sshAlias: "bellwood-tester" },
    ],
    testAccount: { githubLogin: "bench-bot" },
    feishu: { botAppId: "cli_test", driverAppId: "cli_driver" },
    sandboxProject: join(root, "projects", "sandbox"),
    guards: { dataDirs: [join(root, "prod", ".agent-hub")], uiPorts: [4317, 4318], meshPorts: [4320], feishuAppIds: ["cli_prod"], githubLogins: ["Owner"] },
    ...over,
  };
}

const local = (c: BenchConfig) => c.instances[0] as Extract<BenchConfig["instances"][number], { role: "local" }>;

describe("benchRoot", () => {
  it("uses BELLWOOD_TESTER_HOME when set", () => {
    expect(benchRoot({ [TESTER_HOME_ENV]: "/srv/bench" }, "/Users/me")).toBe("/srv/bench");
  });

  it("falls back to .bellwood-tester under the home directory", () => {
    expect(benchRoot({}, "/Users/me")).toBe(join("/Users/me", ".bellwood-tester"));
    expect(benchRoot({ [TESTER_HOME_ENV]: "  " }, "/Users/me")).toBe(join("/Users/me", ".bellwood-tester"));
  });
});

describe("parseBenchConfig", () => {
  it("accepts a complete version 1 config", () => {
    const c = config("/b");
    expect(parseBenchConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
    const { feishu: _feishu, ...withoutFeishu } = c;
    expect(parseBenchConfig(withoutFeishu).feishu).toBeUndefined();
  });

  it("names the first invalid field", () => {
    const c = config("/b");
    expect(() => parseBenchConfig({ ...c, version: 2 })).toThrow(/bench\.json version:/);
    expect(() => parseBenchConfig({ ...c, instances: [{ ...c.instances[0], uiPort: 0 }, c.instances[1]] })).toThrow(/bench\.json instances\.0\.uiPort:/);
    expect(() => parseBenchConfig({ ...c, instances: [c.instances[1]] })).toThrow(/exactly one local instance/);
    expect(() => parseBenchConfig({ ...c, guards: { ...c.guards, githubLogins: "Owner" } })).toThrow(BenchConfigError);
  });

  it("rejects unknown fields", () => {
    expect(() => parseBenchConfig({ ...config("/b"), acceptedGaps: [] })).toThrow(/bench\.json acceptedGaps:/);
    expect(() => parseBenchConfig({ ...config("/b"), guards: { ...config("/b").guards, extra: 1 } })).toThrow(/bench\.json guards\.extra:/);
  });
});

describe("assertNotProduction", () => {
  it("rejects a local data dir equal to a guarded data dir", () => {
    const root = scratch();
    const c = config(root);
    c.guards.dataDirs = [local(c).dataDir];
    expect(() => assertNotProduction(c)).toThrow(ProductionGuardError);
  });

  it("rejects a local data dir inside a guarded data dir and a guarded data dir inside a local one", () => {
    const root = scratch();
    const inside = config(root);
    inside.guards.dataDirs = [join(root, "local")];
    expect(() => assertNotProduction(inside)).toThrow(/dataDir .* overlaps/);
    const outer = config(root);
    outer.guards.dataDirs = [join(local(outer).userHome, ".agent-hub")];
    expect(() => assertNotProduction(outer)).toThrow(/userHome .* overlaps/);
    expect(() => assertNotProduction(config(root))).not.toThrow();
  });

  it("compares paths case-insensitively after resolving symlinks", () => {
    const root = scratch();
    const prod = join(root, "prod");
    mkdirSync(prod, { recursive: true });
    symlinkSync(prod, join(root, "link"));
    const c = config(root);
    c.guards.dataDirs = [prod.toUpperCase()];
    local(c).dataDir = join(root, "link", "home");
    expect(() => assertNotProduction(c)).toThrow(/dataDir .* overlaps/);
  });

  it("rejects a guarded UI port or mesh port", () => {
    const root = scratch();
    const ui = config(root);
    local(ui).uiPort = 4317;
    expect(() => assertNotProduction(ui)).toThrow(/uiPort 4317/);
    const mesh = config(root);
    local(mesh).meshPort = 4320;
    expect(() => assertNotProduction(mesh)).toThrow(/meshPort 4320/);
  });

  it("rejects a test bot app id that is guarded", () => {
    const c = config(scratch());
    c.feishu = { botAppId: "cli_prod", driverAppId: "cli_driver" };
    expect(() => assertNotProduction(c)).toThrow(/cli_prod/);
  });

  it("rejects a test GitHub login that is guarded", () => {
    const c = config(scratch());
    c.testAccount.githubLogin = "owner";
    expect(() => assertNotProduction(c)).toThrow(/guarded production account/);
  });

  it("rejects a local data dir outside the bench root", () => {
    const root = scratch();
    const c = config(root);
    local(c).dataDir = join(scratch(), "elsewhere");
    expect(() => assertNotProduction(c)).toThrow(/outside the bench root/);
  });
});

function fakeClient(githubLogin: string | null): InstanceClient {
  return { name: "mac", account: async () => ({ githubLogin, deviceId: "dev" }) } as unknown as InstanceClient;
}

describe("openBench", () => {
  it("refuses to hand out clients when an instance reports another GitHub login", async () => {
    await expect(assertTestAccount(fakeClient("Owner"), "bench-bot")).rejects.toThrow(ProductionGuardError);
    await expect(assertTestAccount(fakeClient("BENCH-BOT"), "bench-bot")).resolves.toBeUndefined();
    await expect(assertTestAccount(fakeClient(null), "bench-bot")).resolves.toBeUndefined();
  });

  it("reports an unreachable instance as a bench config error, not a product failure", async () => {
    const root = scratch();
    await expect(openBench(config(root), { codeDir: scratch(), mode: "fake" })).rejects.toThrow(BenchConfigError);
  });

  it("starts the local instance from codeDir in the requested CLI mode with its own HOME", () => {
    const root = scratch();
    const c = config(root);
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "secrets", "claude-oauth-token"), "tok\n");
    local(c).env = { CODEX_HOME: join(local(c).userHome, ".codex"), CLAUDE_CODE_OAUTH_TOKEN: "@secrets/claude-oauth-token" };
    const claude = VENDOR_LIST.find((v) => v.id === "claude")!.cli.envVar;
    const real = localDaemonEnv({ config: c, instance: local(c), codeDir: "/code", mode: "real", platform: "darwin", baseEnv: { PATH: `${process.env.HOME}/.local/bin:/usr/bin`, SECRET: "x" } });
    expect(real).toMatchObject({ HOME: local(c).userHome, [ENV_HOME]: local(c).dataDir, [ENV_PORT]: "4417", [ENV_MESH_PORT]: "4421", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(real.SECRET).toBeUndefined();
    expect(real.PATH).not.toContain(`${process.env.HOME}/.local/bin`);
    for (const { cli } of VENDOR_LIST) expect(real[cli.envVar]!.startsWith(root)).toBe(true);
    const fake = localDaemonEnv({ config: c, instance: local(c), codeDir: "/code", mode: "fake", platform: "darwin", baseEnv: {} });
    expect(fake[claude]).toBe("/code/test/fake-claude/fake-claude.ts");
    expect(fake.FAKE_CLAUDE_SCRIPT!.startsWith(root)).toBe(true);
  });
});
