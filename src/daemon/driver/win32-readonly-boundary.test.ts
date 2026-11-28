import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_VENDORS, type AgentVendor } from "../../shared/vendors.ts";
import { createResolveFolder } from "../ledger/files.ts";
import { createLedger } from "../ledger/ledger.ts";
import { migrate, openDatabase, type Db } from "../store/index.ts";
import { watchSandboxLaunch } from "../watches/launch.ts";
import {
  checkReadonlyWorkerSandbox,
  kernelReadonlySandboxAvailable,
  readonlySandboxUnavailableMessage,
  vendorNeedsOuterReadonlySandbox,
} from "./kernel-readonly.ts";
import {
  BWRAP,
  SANDBOX_EXEC,
  WORKER_NEEDS_OS_SANDBOX_MESSAGE,
  registerWin32MxcReadonlyProvider,
  resetOsSandboxCacheForTest,
  wrapInReadonlyOsSandbox,
  type ReadonlySandboxInput,
  type SpawnCommand,
} from "./write-scope.ts";

const BASE_CMD: SpawnCommand = { command: "/bin/agent", args: ["--flag", "1"] };
const RO_INPUT: ReadonlySandboxInput = {
  tmpDir: "/tmp/bellwood-ro-session",
  stateDir: "C:\\Users\\u\\.agent-hub\\state",
  protectedRoots: ["C:\\Users\\u\\.agent-hub"],
  writableDirs: [],
  writableFileRegexes: [],
  secretPaths: ["C:\\Users\\u\\.ssh"],
  secretGlobs: ["**/.env"],
};

const tempDirs: string[] = [];
const openDbs: Db[] = [];

afterEach(() => {
  resetOsSandboxCacheForTest();
  while (openDbs.length > 0) openDbs.pop()!.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function createWin32LedgerFixture(opts: { osSandboxed?: () => boolean; readonlyKernelSandboxed?: () => boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fusa-win32-ro-ledger-"));
  tempDirs.push(root);
  const projectDir = join(root, "repo");
  const dataHome = join(root, "hub-data");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(dataHome, { recursive: true });
  const db = openDatabase(":memory:");
  migrate(db);
  openDbs.push(db);
  const ledger = createLedger(db, {
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    worktreesDir: join(dataHome, "worktrees"),
    userHome: root,
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    workerPlatform: "win32",
    osSandboxed: opts.osSandboxed ?? (() => true),
    readonlyKernelSandboxed: opts.readonlyKernelSandboxed ?? (() => false),
  });
  const created = ledger.createPm({ name: "WinPM", vendor: "pi", mode: "manage_only", persona: "" });
  const pmSessionId = created.sessionId;
  ledger.hubCall(pmSessionId, "project.create", { folder: projectDir, name: "Repo" });
  return { ledger, pmSessionId, projectDir, root };
}

describe("Windows strict read-only sandbox boundary (new and changed behavior)", () => {
  it("S6: wrapInReadonlyOsSandbox fails closed on win32 when MXC is unavailable instead of falling back", () => {
    const result = wrapInReadonlyOsSandbox(BASE_CMD, RO_INPUT, "win32", {
      available: true,
      disableWin32Mxc: true,
      stateDir: RO_INPUT.stateDir,
    });
    expect(result).toEqual({ ...BASE_CMD, osSandboxed: false });
    expect("readonlyFallbackWarning" in result).toBe(false);
    expect(result.readonlyMode).toBeUndefined();
  });

  it("S10: throwing MXC availability probe fails closed with osSandboxed: false", () => {
    registerWin32MxcReadonlyProvider({
      available: () => {
        throw new Error("mxc native probe crashed");
      },
      wrapReadonly: () => {
        throw new Error("must not be called");
      },
    });
    const result = wrapInReadonlyOsSandbox(BASE_CMD, RO_INPUT, "win32", { available: true });
    expect(result).toEqual({ ...BASE_CMD, osSandboxed: false });
  });

  it("S11: vendorNeedsOuterReadonlySandbox covers all 8 registered vendors across macOS, Linux, and Windows", () => {
    const expected: Record<AgentVendor, { darwin: boolean; linux: boolean; win32: boolean }> = {
      codex: { darwin: false, linux: false, win32: false },
      claude: { darwin: false, linux: false, win32: true },
      agy: { darwin: true, linux: true, win32: true },
      cursor: { darwin: true, linux: true, win32: true },
      deepseek: { darwin: true, linux: true, win32: true },
      kimi: { darwin: true, linux: true, win32: true },
      opencode: { darwin: true, linux: true, win32: true },
      pi: { darwin: true, linux: true, win32: true },
    };
    expect(Object.keys(expected).sort()).toEqual([...AGENT_VENDORS].sort());
    for (const vendor of AGENT_VENDORS) {
      expect(vendorNeedsOuterReadonlySandbox(vendor, "darwin"), `${vendor} darwin`).toBe(expected[vendor].darwin);
      expect(vendorNeedsOuterReadonlySandbox(vendor, "linux"), `${vendor} linux`).toBe(expected[vendor].linux);
      expect(vendorNeedsOuterReadonlySandbox(vendor, "win32"), `${vendor} win32`).toBe(expected[vendor].win32);
    }
  });

  it("S6 & S11: checkReadonlyWorkerSandbox allows codex native on win32 without MXC and rejects all 7 outer-sandboxed vendors", () => {
    expect(
      checkReadonlyWorkerSandbox({
        vendor: "codex",
        platform: "win32",
        osSandboxed: true,
        readonlyKernelSandboxed: false,
      }),
    ).toEqual({ ok: true, enforcement: "vendor_native" });

    for (const vendor of AGENT_VENDORS.filter((v) => v !== "codex")) {
      const res = checkReadonlyWorkerSandbox({
        vendor,
        platform: "win32",
        osSandboxed: true,
        readonlyKernelSandboxed: false,
      });
      expect(res.ok, `${vendor} must fail closed without MXC`).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("win32_mxc_unavailable");
        expect(res.message).toMatch(/MXC/u);
        expect(res.message).toMatch(/codex/iu);
      }

      const withMxc = checkReadonlyWorkerSandbox({
        vendor,
        platform: "win32",
        osSandboxed: true,
        readonlyKernelSandboxed: true,
      });
      expect(withMxc).toEqual({ ok: true, enforcement: "outer_os_sandbox" });
    }

    const noSandbox = checkReadonlyWorkerSandbox({
      vendor: "pi",
      platform: "linux",
      osSandboxed: false,
      readonlyKernelSandboxed: false,
    });
    expect(noSandbox).toEqual({
      ok: false,
      code: "sandbox_unavailable",
      message: WORKER_NEEDS_OS_SANDBOX_MESSAGE,
    });
  });

  it("S6 & S13: readonlySandboxUnavailableMessage gives Windows MXC guidance on win32 and general sandbox guidance elsewhere", () => {
    const winMsg = readonlySandboxUnavailableMessage("win32");
    expect(winMsg).toMatch(/MXC/u);
    expect(winMsg).toMatch(/24H2/u);
    expect(winMsg).toMatch(/codex/iu);
    expect(readonlySandboxUnavailableMessage("linux")).toBe(WORKER_NEEDS_OS_SANDBOX_MESSAGE);
    expect(readonlySandboxUnavailableMessage("darwin")).toBe(WORKER_NEEDS_OS_SANDBOX_MESSAGE);
  });

  it("S5 & S6: ledger worker.start refuses non-Codex readonly Workers on win32 without MXC while allowing Codex and normal Workers", () => {
    let mxcReady = false;
    const { ledger, pmSessionId } = createWin32LedgerFixture({
      osSandboxed: () => true,
      readonlyKernelSandboxed: () => mxcReady,
    });

    expect(() =>
      ledger.hubCall(pmSessionId, "worker.start", {
        title: "Readonly audit",
        task: "Inspect the repository",
        vendor: "pi",
        readonly: true,
        noWorktree: true,
      }),
    ).toThrow(/MXC/u);

    expect(() =>
      ledger.hubCall(pmSessionId, "worker.start", {
        title: "Claude readonly audit",
        task: "Inspect the repository",
        vendor: "claude",
        readonly: true,
        noWorktree: true,
      }),
    ).toThrow(/MXC/u);

    const codexRo = ledger.hubCall(pmSessionId, "worker.start", {
      title: "Codex readonly audit",
      task: "Inspect the repository",
      vendor: "codex",
      readonly: true,
      noWorktree: true,
    });
    expect("data" in codexRo && codexRo.data).toBeTruthy();

    mxcReady = true;
    const piRoAfterMxc = ledger.hubCall(pmSessionId, "worker.start", {
      title: "Pi readonly after MXC ready",
      task: "Inspect the repository",
      vendor: "pi",
      readonly: true,
      noWorktree: true,
    });
    expect("data" in piRoAfterMxc && piRoAfterMxc.data).toBeTruthy();
  });

  it("S5: Task Graph auto-dispatch of a readonly non-Codex step fails closed on win32 without MXC", () => {
    const { ledger, pmSessionId } = createWin32LedgerFixture({
      osSandboxed: () => true,
      readonlyKernelSandboxed: () => false,
    });
    expect(() =>
      ledger.hubCall(pmSessionId, "graph.create", {
        title: "Readonly audit graph",
        specJson: JSON.stringify({
          goal: "Run a read-only audit step on Windows without MXC",
          steps: [
            {
              key: "audit",
              title: "Audit repo",
              brief: "Inspect repository files without editing",
              vendor: "pi",
              readonly: true,
            },
          ],
        }),
      }),
    ).toThrow(/MXC/u);
  });
});

describe("Windows strict read-only sandbox boundary (unchanged-rule regressions)", () => {
  it("S6 regression: Win32 wrapInReadonlyOsSandbox uses MXC when provider is available", () => {
    registerWin32MxcReadonlyProvider({
      available: () => true,
      wrapReadonly: (base, input) => ({
        command: "node.exe",
        args: ["mxc-runner.ts", "--tmp", input.tmpDir, "--", base.command, ...base.args],
      }),
    });
    const wrapped = wrapInReadonlyOsSandbox(BASE_CMD, RO_INPUT, "win32", { available: true });
    expect(wrapped).toEqual({
      command: "node.exe",
      args: ["mxc-runner.ts", "--tmp", RO_INPUT.tmpDir, "--", BASE_CMD.command, ...BASE_CMD.args],
      osSandboxed: true,
      readonlyMode: "mxc",
    });
  });

  it("S12 regression: macOS wraps in sandbox-exec, Linux wraps in bwrap or fails closed, and kernelReadonlySandboxAvailable is false on win32 without MXC", () => {
    const mac = wrapInReadonlyOsSandbox(BASE_CMD, RO_INPUT, "darwin", { available: true });
    expect(mac.osSandboxed).toBe(true);
    expect(mac.command).toBe(SANDBOX_EXEC);

    const linuxUnavailable = wrapInReadonlyOsSandbox(BASE_CMD, RO_INPUT, "linux", { available: false });
    expect(linuxUnavailable).toEqual({ ...BASE_CMD, osSandboxed: false });

    const linuxAvailable = wrapInReadonlyOsSandbox(BASE_CMD, RO_INPUT, "linux", {
      available: true,
      uid: 1000,
      exists: () => false,
    });
    expect(linuxAvailable.osSandboxed).toBe(true);
    expect(linuxAvailable.command).toBe(BWRAP);

    expect(kernelReadonlySandboxAvailable("win32", { available: true, disableWin32Mxc: true })).toBe(false);
  });

  it("S7 regression: watchSandboxLaunch refuses Windows launches when MXC is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-watch-win32-"));
    tempDirs.push(root);
    const launch = await watchSandboxLaunch(
      {
        dataDir: join(root, "data"),
        stateDir: join(root, "data", "state"),
        tagNonce: "nonce",
        platform: "win32",
        homeDir: root,
        wrap: { disableWin32Mxc: true },
      },
      { command: "echo ok", cwd: root },
      join(root, "tmp"),
    );
    expect(launch).toBeNull();
  });
});
