import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertCleanTeardown } from "../../test/blind-walkthrough/isolated-app.ts";
import { writeExecutableNodeScript } from "../../test/fake-cli-shim.ts";
import {
  AGENT_VENDORS,
  ENV_HOME,
  ENV_PORT,
  PROCESS_LEDGER_MAX_ENTRIES,
  VENDOR_LIST,
} from "../shared/index.ts";
import { resolveHubPaths } from "../shared/paths.ts";
import { AGY_FORCE_FILE_TOKEN_STORAGE_ENV } from "../vendors/agy/paths.ts";
import { queryAgyModels } from "../vendors/agy/catalog.ts";
import { queryClaudeAuthStatus, queryClaudeControl, queryClaudeInitialize } from "../vendors/claude/catalog.ts";
import { createClaudeForker } from "../vendors/claude/handover.ts";
import { queryClaudeQuota } from "../vendors/claude/quota.ts";
import { queryCodexAppServer } from "../vendors/codex/catalog.ts";
import { createCursorCatalogSource } from "../vendors/cursor/catalog.ts";
import { createOpenCodeCatalogSource } from "../vendors/opencode/catalog.ts";
import { createPiComposer } from "../vendors/pi/composer.ts";
import { createPiForker } from "../vendors/pi/handover.ts";
import { createVendorVersionCache } from "../vendors/_common/setup/version-probe.ts";
import { runShortSubcommand } from "../vendors/_common/setup/file-helpers.ts";
import { createCommandCatalogs } from "./commands-catalog.ts";
import { startDaemon, type RunningDaemon } from "./daemon.ts";
import { closeAndWaitChild, isAlive, killChildAndWait, waitForExit } from "./driver/process.ts";
import { removeTreeWithRetry, spawnOwnedProcess } from "./platform/index.ts";
import { createProcessLedger, installProcessLedger, readLedgerFile, type ProcessLedger } from "./process-ledger.ts";
import { createManagedProviderSecrets, createVendorRuntimeResolver } from "./provider-manager/index.ts";
import { createFetchedQuota } from "./quota/fetched-quota.ts";
import { createProviderQuota } from "./quota/provider-quota.ts";
import { createSelfReload } from "./self-reload.ts";

// Keep temp paths short so macOS Unix sockets stay below the 104-byte path limit.
function shortTmpRoot(): string {
  const base = tmpdir();
  return process.platform !== "win32" && base.length > 40 && existsSync("/tmp") ? "/tmp" : base;
}

function forceKillForTestCleanup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      } catch {
        process.kill(pid, "SIGKILL");
      }
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
  } catch {
  }
}

function readPidFile(file: string): number {
  const raw = readFileSync(file, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`Expected valid PID in ${file}, got ${JSON.stringify(raw)}`);
  }
  return pid;
}

function fakeChildHandle(pid: number) {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  return {
    child: child as unknown as Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once">,
    exit() {
      child.exitCode = 0;
      emitter.emit("exit", 0, null);
    },
  };
}

describe("probe and tracked child process teardown cleanup (acceptance)", () => {
  let root: string;
  const pidFilesToClean: string[] = [];
  const pidsToClean: number[] = [];
  const uninstallers: Array<() => void> = [];
  const daemons: RunningDaemon[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(shortTmpRoot(), "bw-probe-tear-"));
  });

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
      await daemon.stop().catch(() => undefined);
    }
    for (const off of uninstallers.splice(0).reverse()) {
      off();
    }
    for (const pidFile of pidFilesToClean.splice(0)) {
      if (existsSync(pidFile)) {
        try {
          pidsToClean.push(readPidFile(pidFile));
        } catch {
        }
      }
    }
    for (const pid of pidsToClean.splice(0)) {
      if (isAlive(pid)) {
        forceKillForTestCleanup(pid);
        await waitForExit(pid, 5_000);
      }
    }
    await removeTreeWithRetry(root);
  });

  function installIsolatedLedger(name = "child-processes.json"): { ledger: ProcessLedger; file: string } {
    const file = join(root, name);
    const ledger = createProcessLedger({ file });
    uninstallers.push(installProcessLedger(ledger));
    return { ledger, file };
  }

  function makeIsolatedEnv(homeDir: string, userHome: string, overrides: Record<string, string>): Record<string, string> {
    const passthrough = ["PATH", "Path", "SystemRoot", "PATHEXT", "ComSpec", "TMPDIR", "TEMP", "TMP"].flatMap((k) =>
      process.env[k] === undefined ? [] : [[k, process.env[k]!] as const],
    );
    return {
      ...Object.fromEntries(passthrough),
      LANG: "en_US.UTF-8",
      HOME: userHome,
      USERPROFILE: userHome,
      ...(process.platform === "darwin" ? { [AGY_FORCE_FILE_TOKEN_STORAGE_ENV]: "1" } : {}),
      [ENV_HOME]: homeDir,
      [ENV_PORT]: "0",
      ...Object.fromEntries(VENDOR_LIST.map(({ id, cli }) => [cli.envVar, join(root, `missing-${id}`)])),
      ...overrides,
    };
  }

  function writeStubbornClaudeScript(
    name: string,
    mode: "hang_in_flight" | "reply_and_linger" | "reply_and_wait_gate",
    markers: { pidFile: string; repliedFile?: string; eofFile?: string; releaseFile?: string },
  ): string {
    pidFilesToClean.push(markers.pidFile);
    const script = `
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
fs.writeFileSync(${JSON.stringify(markers.pidFile)}, String(process.pid));
const keepAlive = setInterval(() => {}, 1000);
${
  mode === "hang_in_flight"
    ? ""
    : `
rl.on("line", (line) => {
  const req = JSON.parse(line);
  const subtype = req.request && req.request.subtype;
  const response = subtype === "get_usage"
    ? { rate_limits_available: true, rate_limits: { five_hour: { utilization: 20, resets_at: "2099-01-01T00:00:00Z" } } }
    : { models: [{ value: "opus", displayName: "Opus" }] };
  process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response } }) + "\\n");
  ${markers.repliedFile ? `if (subtype === "get_usage" || ${JSON.stringify(mode)} === "reply_and_wait_gate") fs.writeFileSync(${JSON.stringify(markers.repliedFile)}, "replied");` : ""}
});
`
}
${
  mode === "reply_and_wait_gate" && markers.eofFile && markers.releaseFile
    ? `
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(markers.eofFile)}, "eof");
  const poll = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(markers.releaseFile)})) {
      clearInterval(poll);
      clearInterval(keepAlive);
      process.exit(0);
    }
  }, 10);
});
`
    : ""
}
`;
    return writeExecutableNodeScript(join(root, name), script);
  }

  describe("Shared child-settlement primitives (killChildAndWait, closeAndWaitChild)", () => {
    it("killChildAndWait terminates a SIGTERM-ignoring child tree and resolves only after exit", async () => {
      const pidFile = join(root, "kill-wait.pid");
      pidFilesToClean.push(pidFile);
      const bin = writeExecutableNodeScript(
        join(root, "stubborn-sleeper"),
        `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      const { child } = spawnOwnedProcess(bin, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
      await expect.poll(() => existsSync(pidFile), { timeout: 10_000 }).toBe(true);
      const pid = readPidFile(pidFile);
      await killChildAndWait(child);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(isAlive(pid)).toBe(false);
    });

    it("closeAndWaitChild waits for cooperative exit after stdin EOF and escalates immediately on abort", async () => {
      const pidFile = join(root, "coop.pid");
      const eofFile = join(root, "coop.eof");
      const releaseFile = join(root, "coop.release");
      pidFilesToClean.push(pidFile);
      const bin = writeExecutableNodeScript(
        join(root, "coop-child"),
        `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const keepAlive = setInterval(() => {}, 1000);
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(eofFile)}, "eof");
  const poll = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(releaseFile)})) {
      clearInterval(poll);
      clearInterval(keepAlive);
      process.exit(0);
    }
  }, 10);
});
`,
      );
      const { child } = spawnOwnedProcess(bin, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
      await expect.poll(() => existsSync(pidFile), { timeout: 10_000 }).toBe(true);
      const pid = readPidFile(pidFile);
      let settled = false;
      const settling = closeAndWaitChild(child, { graceMs: 5_000 }).then(() => {
        settled = true;
      });
      await expect.poll(() => existsSync(eofFile), { timeout: 10_000 }).toBe(true);
      expect(settled).toBe(false);
      writeFileSync(releaseFile, "go");
      await settling;
      expect(isAlive(pid)).toBe(false);

      const abortPidFile = join(root, "abort-grace.pid");
      pidFilesToClean.push(abortPidFile);
      const stubborn = writeExecutableNodeScript(
        join(root, "stubborn-after-eof"),
        `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(abortPidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      const second = spawnOwnedProcess(stubborn, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] }).child;
      await expect.poll(() => existsSync(abortPidFile), { timeout: 10_000 }).toBe(true);
      const secondPid = readPidFile(abortPidFile);
      const controller = new AbortController();
      const closingSecond = closeAndWaitChild(second, { graceMs: 30_000, signal: controller.signal });
      controller.abort();
      await closingSecond;
      expect(isAlive(secondPid)).toBe(false);
    });
  });

  describe("S1 & S5: Real daemon shutdown leaves zero surviving probe:claude-quota processes", () => {
    it("S1a: stops an in-flight probe:claude-quota during clean daemon.stop() with zero surviving PIDs", async () => {
      const homeDir = join(root, "hub-s1a");
      const userHome = join(root, "user-s1a");
      mkdirSync(userHome, { recursive: true });
      const pidFile = join(root, "s1a-claude.pid");
      const fakeClaude = writeStubbornClaudeScript("fake-claude-s1a", "hang_in_flight", { pidFile });
      const env = makeIsolatedEnv(homeDir, userHome, { AGENT_HUB_CLAUDE: fakeClaude });

      const daemon = await startDaemon({ env, userHome, log: () => {} });
      daemons.push(daemon);
      await expect.poll(() => existsSync(pidFile), { timeout: 15_000 }).toBe(true);
      const probePid = readPidFile(pidFile);
      expect(isAlive(probePid)).toBe(true);

      await daemon.stop();
      daemons.pop();

      expect(isAlive(probePid)).toBe(false);
      expect(readLedgerFile(daemon.paths.childProcessesFile)).toEqual([]);
      expect(() => assertCleanTeardown(homeDir)).not.toThrow();
    }, 30_000);

    it("S1b: stops a probe:claude-quota that already replied but lingers after stdin EOF before daemon.stop() resolves", async () => {
      const homeDir = join(root, "hub-s1b");
      const userHome = join(root, "user-s1b");
      mkdirSync(userHome, { recursive: true });
      const pidFile = join(root, "s1b-claude.pid");
      const repliedFile = join(root, "s1b-claude.replied");
      const fakeClaude = writeStubbornClaudeScript("fake-claude-s1b", "reply_and_linger", { pidFile, repliedFile });
      const env = makeIsolatedEnv(homeDir, userHome, { AGENT_HUB_CLAUDE: fakeClaude });

      const daemon = await startDaemon({ env, userHome, log: () => {} });
      daemons.push(daemon);
      await expect.poll(() => existsSync(repliedFile), { timeout: 15_000 }).toBe(true);
      const probePid = readPidFile(pidFile);

      await daemon.stop();
      daemons.pop();

      expect(isAlive(probePid)).toBe(false);
      expect(readLedgerFile(daemon.paths.childProcessesFile)).toEqual([]);
      expect(() => assertCleanTeardown(homeDir)).not.toThrow();
    }, 30_000);

    it("S5: restarts cleanly on the same AGENT_HUB_HOME mid-probe with zero leftovers after both stops", async () => {
      const homeDir = join(root, "hub-s5");
      const userHome = join(root, "user-s5");
      mkdirSync(userHome, { recursive: true });
      const pidFile = join(root, "s5-claude.pid");
      const fakeClaude = writeStubbornClaudeScript("fake-claude-s5", "hang_in_flight", { pidFile });
      const env = makeIsolatedEnv(homeDir, userHome, { AGENT_HUB_CLAUDE: fakeClaude });

      const first = await startDaemon({ env, userHome, log: () => {} });
      daemons.push(first);
      await expect.poll(() => existsSync(pidFile), { timeout: 15_000 }).toBe(true);
      const firstPid = readPidFile(pidFile);
      await first.stop();
      daemons.pop();
      expect(isAlive(firstPid)).toBe(false);
      expect(() => assertCleanTeardown(homeDir)).not.toThrow();

      const second = await startDaemon({ env, userHome, log: () => {} });
      daemons.push(second);
      await expect.poll(() => existsSync(pidFile) && readPidFile(pidFile) !== firstPid, { timeout: 15_000 }).toBe(true);
      const secondPid = readPidFile(pidFile);
      await second.stop();
      daemons.pop();
      expect(isAlive(secondPid)).toBe(false);
      expect(() => assertCleanTeardown(homeDir)).not.toThrow();
    }, 45_000);
  });

  describe("S2: RPC probes never resolve while their child is still alive", () => {
    it("queryClaudeQuota and queryClaudeInitialize wait for child exit before resolving", async () => {
      const { file } = installIsolatedLedger("claude-rpc.json");
      const pidFile = join(root, "claude-linger.pid");
      const repliedFile = join(root, "claude-linger.replied");
      const fakeClaude = writeStubbornClaudeScript("claude-linger", "reply_and_linger", { pidFile, repliedFile });

      const usage = await queryClaudeQuota({ path: fakeClaude, cwd: root, env: process.env, timeoutMs: 10_000, signal: new AbortController().signal });
      expect(usage?.groups).toHaveLength(1);
      const quotaPid = readPidFile(pidFile);
      expect(isAlive(quotaPid)).toBe(false);
      expect(readLedgerFile(file)).toEqual([]);

      const initPidFile = join(root, "claude-init.pid");
      const initEofFile = join(root, "claude-init.eof");
      const initReleaseFile = join(root, "claude-init.release");
      const coopClaude = writeStubbornClaudeScript("claude-coop", "reply_and_wait_gate", {
        pidFile: initPidFile,
        eofFile: initEofFile,
        releaseFile: initReleaseFile,
      });
      let initResolved = false;
      const initPromise = queryClaudeInitialize({ claudePath: coopClaude, cwd: root, timeoutMs: 10_000 }).then((res) => {
        initResolved = true;
        return res;
      });
      await expect.poll(() => existsSync(initEofFile), { timeout: 10_000 }).toBe(true);
      expect(initResolved).toBe(false);
      writeFileSync(initReleaseFile, "go");
      await initPromise;
      expect(isAlive(readPidFile(initPidFile))).toBe(false);
    });

    it("queryCodexAppServer waits for lingering child exit before resolving", async () => {
      const { file } = installIsolatedLedger("codex-rpc.json");
      const pidFile = join(root, "codex-linger.pid");
      pidFilesToClean.push(pidFile);
      const fakeCodex = writeExecutableNodeScript(
        join(root, "codex-linger"),
        `
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  if (msg.id === 2) console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { data: [] } }));
});
`,
      );
      await queryCodexAppServer({ codexPath: fakeCodex, cwd: root, timeoutMs: 10_000 }, [{ method: "model/list", params: {} }]);
      expect(isAlive(readPidFile(pidFile))).toBe(false);
      expect(readLedgerFile(file)).toEqual([]);
    });

    it("pi composer queryCommands waits for lingering child exit before resolving", async () => {
      const { file } = installIsolatedLedger("pi-rpc.json");
      const pidFile = join(root, "pi-linger.pid");
      pidFilesToClean.push(pidFile);
      const fakePi = writeExecutableNodeScript(
        join(root, "pi-linger"),
        `
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.command === "get_commands" || msg.type === "get_commands") {
    console.log(JSON.stringify({ id: "1", type: "response", command: "get_commands", success: true, data: { commands: [] } }));
  }
});
`,
      );
      const composer = createPiComposer({ executablePath: fakePi, timeoutMs: 10_000 });
      await composer.queryCommands({ cwd: root, addDirs: [] }, new AbortController().signal);
      expect(isAlive(readPidFile(pidFile))).toBe(false);
      expect(readLedgerFile(file)).toEqual([]);
    });
  });

  describe("S3 & S4: Service close() and probe aborts await child exit and handle invalidation", () => {
    it("S3a: ProviderQuota.close() aborts and awaits in-flight Claude, Codex, and Antigravity quota probes", async () => {
      const home = join(root, "quota-close-home");
      mkdirSync(home, { recursive: true });
      const { file } = installIsolatedLedger("quota-close.json");
      const claudePidFile = join(root, "q-claude.pid");
      const codexPidFile = join(root, "q-codex.pid");
      const agyPidFile = join(root, "q-agy.pid");
      const makeHang = (name: string, pidFile: string) => {
        pidFilesToClean.push(pidFile);
        return writeExecutableNodeScript(
          join(root, name),
          `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
        );
      };
      const env = makeIsolatedEnv(join(root, "q-hub"), home, {
        AGENT_HUB_CLAUDE: makeHang("hang-claude", claudePidFile),
        AGENT_HUB_CODEX: makeHang("hang-codex", codexPidFile),
        AGENT_HUB_AGY: makeHang("hang-agy", agyPidFile),
      });
      const paths = resolveHubPaths(env, home, { platform: process.platform });
      const runtime = createVendorRuntimeResolver({
        paths,
        userHome: home,
        baseEnv: env,
        secrets: createManagedProviderSecrets(paths.providerSecretsFile),
      });
      const service = createProviderQuota(runtime);
      const pending = service.get();

      await expect.poll(
        () => existsSync(claudePidFile) && existsSync(codexPidFile) && existsSync(agyPidFile),
        { timeout: 15_000 },
      ).toBe(true);
      const pids = [readPidFile(claudePidFile), readPidFile(codexPidFile), readPidFile(agyPidFile)];

      await service.close();
      for (const pid of pids) expect(isAlive(pid)).toBe(false);
      expect(readLedgerFile(file)).toEqual([]);
      await pending;
    });

    it("S4: FetchedQuota.close() drains previously invalidated probes as well as the current probe", async () => {
      let scope = "account-a";
      let releaseFirst!: () => void;
      let firstSettled = false;
      let calls = 0;
      const quota = createFetchedQuota({
        fingerprint: () => scope,
        query: (signal) => {
          calls += 1;
          if (calls === 1) {
            return new Promise((resolve) => {
              signal.addEventListener("abort", () => {
                releaseFirst = () => {
                  firstSettled = true;
                  resolve({ groups: [] });
                };
              });
            });
          }
          return Promise.resolve({ groups: [] });
        },
      });

      const first = quota.get();
      scope = "account-b";
      const second = quota.get();
      await second;
      expect(firstSettled).toBe(false);

      let closed = false;
      const closing = quota.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      releaseFirst();
      await closing;
      await first;
      expect(firstSettled).toBe(true);
    });

    it("S3b: SelfReloadController.close() waits for an aborted staged web build to finish exiting", async () => {
      let finishBuild!: () => void;
      let buildAborted = false;
      const reload = createSelfReload({
        busyReasons: () => [],
        unresumableReasons: () => [],
        subscribe: () => () => {},
        build: (signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              buildAborted = true;
              finishBuild = () => resolve({ ok: false, reason: "cancelled" });
            });
          }),
        restart: () => {},
        log: () => {},
      });
      reload.request({ build: true, by: "test" });

      let closed = false;
      const closing = reload.close().then(() => {
        closed = true;
      });
      await expect.poll(() => buildAborted, { timeout: 5_000 }).toBe(true);
      expect(closed).toBe(false);
      finishBuild();
      await closing;
      expect(closed).toBe(true);
    });

    it("S3c: Aborting vendor probes and handovers settles only after the child has exited", async () => {
      const makeHang = (name: string) => {
        const pidFile = join(root, `${name}.pid`);
        pidFilesToClean.push(pidFile);
        const bin = writeExecutableNodeScript(
          join(root, name),
          `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
        );
        return { bin, pidFile };
      };

      const cases: Array<{ name: string; run: (bin: string, signal: AbortSignal) => Promise<unknown> }> = [
        { name: "abort-claude-ctrl", run: (bin, signal) => queryClaudeControl({ claudePath: bin, cwd: root, signal, timeoutMs: 15_000 }) },
        { name: "abort-claude-auth", run: (bin, signal) => queryClaudeAuthStatus({ claudePath: bin, cwd: root, signal, timeoutMs: 15_000 }) },
        { name: "abort-agy-models", run: (bin, signal) => queryAgyModels({ agyPath: bin, cwd: root, signal, timeoutMs: 15_000 }) },
        { name: "abort-codex-rpc", run: (bin, signal) => queryCodexAppServer({ codexPath: bin, cwd: root, signal, timeoutMs: 15_000 }, [{ method: "model/list", params: {} }]) },
        { name: "abort-cursor", run: (bin, signal) => createCursorCatalogSource({ path: bin, cwd: root, env: process.env, installed: () => true, timeoutMs: 15_000 }).query(signal) },
        { name: "abort-opencode", run: (bin, signal) => createOpenCodeCatalogSource({ path: bin, cwd: root, env: process.env, installed: () => true }).query(signal) },
        { name: "abort-short-subcmd", run: (bin, signal) => runShortSubcommand(bin, [], { cwd: root, timeoutMs: 15_000, signal }) },
        {
          name: "abort-claude-handover",
          run: (bin, signal) =>
            createClaudeForker().write(
              {
                sessionId: 1,
                vendor: "claude",
                vendorSessionId: "sess-1",
                cwd: root,
                addDirs: [],
                model: null,
                effort: null,
                executablePath: bin,
                launch: { promptFile: join(root, "prompt.md"), env: {}, fingerprint: "test" },
              },
              { forkId: "fork-1", extra: { cwd: root } },
              "write handover",
              signal,
            ),
        },
        {
          name: "abort-pi-handover",
          run: (bin, signal) =>
            createPiForker({ homeDir: root }).write(
              {
                sessionId: 2,
                vendor: "pi",
                vendorSessionId: "sess1",
                cwd: root,
                addDirs: [],
                model: null,
                effort: null,
                executablePath: bin,
                launch: { promptFile: "", env: {}, fingerprint: "test" },
              },
              { forkId: "fork1", extra: { cwd: root } },
              "write handover",
              signal,
            ),
        },
      ];

      for (const testCase of cases) {
        const { bin, pidFile } = makeHang(testCase.name);
        const controller = new AbortController();
        const pending = testCase.run(bin, controller.signal).catch(() => undefined);
        await expect.poll(() => existsSync(pidFile), { timeout: 10_000 }).toBe(true);
        const pid = readPidFile(pidFile);
        controller.abort();
        await pending;
        expect(isAlive(pid), `${testCase.name} left PID ${pid} alive after abort settled`).toBe(false);
      }
    }, 60_000);
  });

  describe("S6, S7, S8: ProcessLedger.shutdown() barrier, queueing, volume, and dirty data", () => {
    it("S6: ProcessLedger.shutdown() reaps live stragglers, kills late-tracked children, and blocks stale startTimeOf writes", async () => {
      const file = join(root, "ledger-s6.json");
      let resolveDelayedStart!: (value: string | null) => void;
      const delayedPidFile = join(root, "s6-delayed.pid");
      const latePidFile = join(root, "s6-late.pid");
      const makeSleeper = (name: string, pidFile: string) => {
        pidFilesToClean.push(pidFile);
        return writeExecutableNodeScript(
          join(root, name),
          `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
        );
      };
      const firstBin = makeSleeper("s6-first", delayedPidFile);
      const lateBin = makeSleeper("s6-late", latePidFile);

      const firstSpawn = spawnOwnedProcess(firstBin, [], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
      await expect.poll(() => existsSync(delayedPidFile), { timeout: 10_000 }).toBe(true);
      const firstPid = readPidFile(delayedPidFile);

      const ledger = createProcessLedger({
        file,
        startTimeOf: (pid) =>
          pid === firstPid
            ? new Promise<string | null>((resolve) => {
                resolveDelayedStart = resolve;
              })
            : Promise.resolve(`T-${pid}`),
      });
      ledger.track(firstSpawn.child, "probe:claude-quota", { detached: firstSpawn.detached });

      const shutdownPromise = ledger.shutdown();
      resolveDelayedStart("T-delayed");
      const reaped = await shutdownPromise;
      expect(reaped.map((entry) => entry.pid)).toContain(firstPid);
      expect(isAlive(firstPid)).toBe(false);
      expect(readLedgerFile(file)).toEqual([]);

      const lateSpawn = spawnOwnedProcess(lateBin, [], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
      await expect.poll(() => existsSync(latePidFile), { timeout: 10_000 }).toBe(true);
      const latePid = readPidFile(latePidFile);
      ledger.track(lateSpawn.child, "probe:late", { detached: lateSpawn.detached });
      await expect.poll(() => isAlive(latePid), { timeout: 10_000 }).toBe(false);
      expect(readLedgerFile(file)).toEqual([]);
    });

    it("S6b: CommandCatalogs.close() cancels queued queries and waits for the active probe child to exit", async () => {
      const pidFile = join(root, "cmd-active.pid");
      pidFilesToClean.push(pidFile);
      const fakePi = writeExecutableNodeScript(
        join(root, "cmd-pi"),
        `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      let queuedStarted = false;
      const commands = createCommandCatalogs({
        vendors: {
          pi: createPiComposer({ executablePath: fakePi, timeoutMs: 15_000 }),
          claude: {
            ...createPiComposer(),
            queryCommands: async () => {
              queuedStarted = true;
              return [];
            },
          },
        },
        queryRunning: async () => null,
        maxConcurrent: 1,
        log: () => {},
      });
      const first = commands.list({ sessionId: 1, vendor: "pi", cwd: root, addDirs: [] });
      const second = commands.list({ sessionId: 2, vendor: "claude", cwd: root, addDirs: [] });
      await expect.poll(() => existsSync(pidFile), { timeout: 10_000 }).toBe(true);
      const pid = readPidFile(pidFile);

      await commands.close();
      await Promise.all([first, second]);
      expect(queuedStarted).toBe(false);
      expect(isAlive(pid)).toBe(false);
    });

    it("S7: ProcessLedger stays bounded across 300 tracked children and clears cleanly on shutdown", async () => {
      const file = join(root, "ledger-s7.json");
      const ledger = createProcessLedger({
        file,
        startTimeOf: async (pid) => `T-${pid}`,
        kill: async () => {},
      });
      const handles = Array.from({ length: 300 }, (_, i) => fakeChildHandle(20_000 + i));
      for (const h of handles) {
        ledger.track(h.child, "probe:volume");
      }
      await ledger.settled();
      expect(ledger.size).toBe(PROCESS_LEDGER_MAX_ENTRIES);
      expect(readLedgerFile(file)).toHaveLength(PROCESS_LEDGER_MAX_ENTRIES);
      for (const h of handles) h.exit();
      const reaped = await ledger.shutdown();
      expect(reaped).toEqual([]);
      expect(ledger.size).toBe(0);
      expect(readLedgerFile(file)).toEqual([]);
    });

    it("S8: ProcessLedger.shutdown() recovers from corrupt state/child-processes.json and writes a clean file", async () => {
      const file = join(root, "ledger-s8.json");
      writeFileSync(file, "{corrupt json");
      const ledger = createProcessLedger({ file, startTimeOf: async () => "T" });
      const reaped = await ledger.shutdown();
      expect(reaped).toEqual([]);
      expect(readLedgerFile(file)).toEqual([]);
    });
  });

  describe("S9 (unchanged-rule regression): All eight registered vendors clean up version probes cleanly on abort", () => {
    it("aborts version probes for every vendor in AGENT_VENDORS with zero surviving PIDs", async () => {
      const versionCache = createVendorVersionCache();
      const controller = new AbortController();
      const pidFiles: Array<{ vendor: string; pidFile: string }> = [];
      const probes: Array<Promise<string | null>> = [];

      for (const vendor of AGENT_VENDORS) {
        const pidFile = join(root, `ver-${vendor}.pid`);
        pidFilesToClean.push(pidFile);
        pidFiles.push({ vendor, pidFile });
        const bin = writeExecutableNodeScript(
          join(root, `bin-${vendor}`),
          `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
        );
        probes.push(versionCache.probe(vendor, bin, { cwd: root, signal: controller.signal, timeoutMs: 15_000 }));
      }

      await expect.poll(() => pidFiles.every(({ pidFile }) => existsSync(pidFile)), { timeout: 15_000 }).toBe(true);
      const pids = pidFiles.map(({ vendor, pidFile }) => ({ vendor, pid: readPidFile(pidFile) }));

      controller.abort();
      await versionCache.waitForIdle();
      await Promise.all(probes);

      for (const { vendor, pid } of pids) {
        expect(isAlive(pid), `version probe for ${vendor} left PID ${pid} alive`).toBe(false);
      }
    }, 30_000);
  });
});
