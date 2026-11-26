import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS, VENDOR_LIST } from "../../src/shared/index.ts";
import { ProductionGuardError, type BenchConfig } from "./bench.ts";
import { fakeBench, fakeComputer, providersAll } from "./fake-bench.ts";
import { HISTORY_FILE, LATEST_DIR, readRuns } from "./history.ts";
import { runTester } from "./run.ts";
import type { FlowObservation, FlowRunner, FlowSpec } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tester-run-"));
  dirs.push(dir);
  return dir;
}

function writeConfig(root: string, over: Partial<BenchConfig> = {}): string {
  const file = join(root, "bench.json");
  const config: BenchConfig = {
    version: 1,
    root,
    instances: [
      { name: "mac", role: "local", dataDir: join(root, "local", "home"), userHome: join(root, "local", "user-home"), uiPort: 4417, meshPort: 4421, env: {} },
      { name: "tokyo", role: "remote", deviceId: "dev_tokyo", sshAlias: "bellwood-tester" },
    ],
    testAccount: { githubLogin: "bench-bot" },
    sandboxProject: join(root, "projects", "sandbox"),
    guards: { dataDirs: [join(root, "prod", ".agent-hub")], uiPorts: [4317, 4318], meshPorts: [4320], feishuAppIds: ["cli_prod"], githubLogins: ["Owner"] },
    ...over,
  };
  writeFileSync(file, JSON.stringify(config));
  return file;
}

function flow(id: string, model: "fake" | "real", over: Partial<FlowSpec> = {}): FlowSpec {
  return {
    id,
    area: "mesh",
    title: id,
    story: id,
    boundaries: { feishu: "none", network: "loopback", model, devices: 1 },
    needs: ["local_instance"],
    cadences: ["nightly", "rc", "pr"],
    triggers: ["src/daemon/**"],
    pass: [{ check: "ok", rule: "ok" }],
    evidence: ["out.txt"],
    tolerance: { kind: "consecutive", failures: 2 },
    timeoutMs: 5_000,
    escapes: [],
    ...over,
  };
}

const okRunner: FlowRunner = async (): Promise<FlowObservation> => ({ checks: [{ check: "ok", ok: true, detail: "fine" }], externalErrors: [], metrics: {}, evidence: [] });

describe("runTester", () => {
  it("throws on a config that fails the production guards before touching any instance", async () => {
    const root = scratch();
    const config = writeConfig(root);
    const parsed = JSON.parse(readFileSync(config, "utf8")) as BenchConfig;
    (parsed.instances[0] as Extract<BenchConfig["instances"][number], { role: "local" }>).uiPort = 4317;
    writeFileSync(config, JSON.stringify(parsed));
    let opened = false;
    await expect(
      runTester({
        cadence: "nightly",
        benchConfigPath: config,
        codeDir: root,
        open: async () => {
          opened = true;
          throw new Error("should not open");
        },
      }),
    ).rejects.toThrow(ProductionGuardError);
    expect(opened).toBe(false);
  });

  it("appends one record to history and writes summary.md and summary.json under runs/latest", async () => {
    const root = scratch();
    const configPath = writeConfig(root);
    const binDir = join(root, "local", "user-home", ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    for (const { cli } of VENDOR_LIST) writeFileSync(join(binDir, cli.command), "");
    const catalog = [flow("mesh.one", "fake")];
    const { record, summary } = await runTester({
      cadence: "nightly",
      benchConfigPath: configPath,
      codeDir: root,
      catalog,
      runners: { "mesh.one": okRunner },
      open: async (cfg) => fakeBench(cfg, { local: fakeComputer({ providers: providersAll("available", "linux") }) }).bench,
      now: () => new Date("2026-11-23T23:30:00Z"),
    });
    expect(summary.status).toBe("clean");
    expect(record.results).toHaveLength(1);
    const runsDir = join(root, "runs");
    expect(readRuns(join(runsDir, HISTORY_FILE), 10).runs.map((r) => r.runId)).toEqual([record.runId]);
    for (const name of ["summary.md", "summary.json"]) {
      const latest = readFileSync(join(runsDir, LATEST_DIR, name), "utf8");
      const runFile = readFileSync(join(runsDir, record.runId, name), "utf8");
      expect(latest).toBe(runFile);
      expect(latest.length).toBeGreaterThan(0);
    }
  });

  it("runs flows one at a time and groups them by local CLI mode to limit restarts", async () => {
    const root = scratch();
    const configPath = writeConfig(root);
    const catalog = [flow("mesh.fake-a", "fake"), flow("mesh.real-a", "real"), flow("mesh.fake-b", "fake"), flow("mesh.real-b", "real")];
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const runners: Record<string, FlowRunner> = {};
    let handles: ReturnType<typeof fakeBench> | null = null;
    for (const spec of catalog) {
      runners[spec.id] = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(spec.id);
        await Promise.resolve();
        active--;
        return { checks: [{ check: "ok", ok: true, detail: "ok" }], externalErrors: [], metrics: {}, evidence: [] };
      };
    }
    await runTester({
      cadence: "nightly",
      benchConfigPath: configPath,
      codeDir: root,
      catalog,
      runners,
      open: async (cfg, { mode }) => {
        handles = fakeBench(cfg);
        await handles.bench.local().start(mode);
        return handles.bench;
      },
    });
    expect(maxActive).toBe(1);
    expect(order).toEqual(["mesh.fake-a", "mesh.fake-b", "mesh.real-a", "mesh.real-b"]);
    expect(handles!.control.filter((c) => c.startsWith("local ") && !c.startsWith("local stop"))).toEqual(["local start real", "local restart fake", "local restart real"]);
  });

  it("aborts a flow past its timeout and records it as product_fail with reason timeout", async () => {
    const root = scratch();
    const configPath = writeConfig(root);
    const catalog = [flow("mesh.hang", "fake", { timeoutMs: 30 })];
    const { record } = await runTester({
      cadence: "pr",
      changedPaths: ["src/daemon/daemon.ts"],
      benchConfigPath: configPath,
      codeDir: root,
      catalog,
      runners: {
        "mesh.hang": ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
      open: async (cfg) => fakeBench(cfg).bench,
    });
    expect(record.results[0]).toMatchObject({ id: "mesh.hang", verdict: "product_fail", reason: expect.stringMatching(/timeout/) });
  });

  it("records a flow whose needs failed preflight without running it", async () => {
    const root = scratch();
    const configPath = writeConfig(root);
    mkdirSync(join(root, "local", "home"), { recursive: true });
    const signedOut = { ...providersAll("available", "darwin"), providers: providersAll("available", "darwin").providers.map((p) => (p.vendor === "claude" ? { ...p, availability: "signed_out" as const } : p)) };
    const catalog = [
      flow("mesh.needs-remote", "fake", { needs: ["local_instance", "remote_instance"] }),
      flow("model.needs-claude", "real", { area: "model", needs: ["vendor:claude"], perInstance: true }),
    ];
    let ran = 0;
    const spy: FlowRunner = async () => {
      ran++;
      return { checks: [{ check: "ok", ok: true, detail: "ok" }], externalErrors: [], metrics: {}, evidence: [] };
    };
    const { record } = await runTester({
      cadence: "nightly",
      benchConfigPath: configPath,
      codeDir: root,
      catalog,
      runners: { "mesh.needs-remote": spy, "model.needs-claude": spy },
      open: async (cfg) => fakeBench(cfg, { local: fakeComputer({ providers: signedOut }), remote: fakeComputer({ health: [new Error("device_offline")] }) }).bench,
    });
    expect(ran).toBe(0);
    expect(record.results.find((r) => r.id === "mesh.needs-remote")?.verdict).toBe("env_unavailable");
    expect(record.results.find((r) => r.id === "model.needs-claude@local")?.verdict).toBe("not_ready");
    expect(record.results.find((r) => r.id === "model.needs-claude@remote")?.verdict).toBe("not_ready");
    expect(record.preflight.coverage).toHaveLength(VENDOR_LIST.length * 2);
  });

  it("deploys the remote to the local commit for pr and rc runs", async () => {
    const root = scratch();
    const configPath = writeConfig(root);
    const catalog = [flow("mesh.one", "fake")];
    const runWith = async (cadence: "pr" | "rc" | "nightly") => {
      let handles: ReturnType<typeof fakeBench> | null = null;
      await runTester({
        cadence,
        ...(cadence === "pr" ? { changedPaths: ["src/daemon/daemon.ts"] } : {}),
        benchConfigPath: configPath,
        codeDir: root,
        catalog,
        runners: { "mesh.one": okRunner },
        open: async (cfg) => ((handles = fakeBench(cfg)), handles.bench),
      });
      return handles!.control;
    };
    expect(await runWith("pr")).toContain(`remote deploy ${"c".repeat(40)}`);
    expect(await runWith("rc")).toContain(`remote deploy ${"c".repeat(40)}`);
    expect(await runWith("nightly")).not.toContain(`remote deploy ${"c".repeat(40)}`);
  });
});

it("waits for the restarted local daemon to reconnect before a relay flow runs", async () => {
  const root = scratch();
  const configPath = writeConfig(root);
  const spec = flow("feishu.group-check", "fake", { boundaries: { feishu: "real", network: "relay", model: "fake", devices: 2 } });
  const order: string[] = [];
  await runTester({
    cadence: "nightly",
    benchConfigPath: configPath,
    codeDir: root,
    catalog: [spec],
    runners: { [spec.id]: async (ctx) => { order.push("flow"); return okRunner(ctx); } },
    open: async (cfg) => {
      const { bench } = fakeBench(cfg);
      const local = bench.local();
      await local.start("real");
      const originalJson = local.api.json;
      local.api.json = vi.fn().mockImplementation((method, path, ...args) => {
        if (path === API_PATHS.account) {
          const relay = order.includes("connecting") ? "connected" : "connecting";
          order.push(relay);
          return Promise.resolve({ state: "signed_in", relay });
        }
        return originalJson(method, path, ...args);
      });
      return bench;
    },
  });
  expect(order).toEqual(["connecting", "connected", "flow"]);
});
