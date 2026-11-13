import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHubLedger } from "../../src/daemon/agent-api/fake-ledger.ts";
import { startAgentApi } from "../../src/daemon/agent-api/server.ts";
import { createSessionTokens } from "../../src/daemon/agent-api/tokens.ts";
import { MemorySessionStore } from "../../src/daemon/driver/test-helpers.ts";
import {
  WIN32_READONLY_FALLBACK_WARNING,
  osSandboxAvailable,
  resetOsSandboxCacheForTest,
  spawnInWriteScope,
  wrapInReadonlyOsSandbox,
} from "../../src/daemon/driver/write-scope.ts";
import {
  allowWin32WorkerWorktreeAcl,
  ensureWin32ProtectedRootAcl,
  hardenWin32PrivateDirAcl,
  removeTreeWithRetry,
  requireWinHelperBinary,
} from "../../src/daemon/platform/index.ts";
import {
  EMPTY_TOKEN_USAGE,
  buildReadonlyPolicy,
  workerWriteScope,
  type AgentSessionRow,
  type DriverEvent,
} from "../../src/shared/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import { createPiDriver } from "../../src/vendors/pi/driver.ts";
import { writeFakePiBinary } from "../../src/vendors/pi/fixtures/fake-pi.ts";
import { writeDiagLog } from "./diag-helper.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  resetOsSandboxCacheForTest();
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch (err) {
      writeDiagLog("sandbox-cleanup", String(err));
    }
  }
});

describe.runIf(process.platform === "win32")("Windows 真机集成：写受限令牌 + ACL 沙箱与无 MXC 只读 Worker 回退", () => {
  it("fusa-run probe 通过；普通 Worker 拒写 state\\ 与别的 worktree，icacls/takeown/Set-Acl 全败，写本 worktree / %TEMP% / 外部目录与连 hub 管道全通；PM 无沙箱可写 state\\", { timeout: 45_000 }, async () => {
    expect(osSandboxAvailable("win32")).toBe(true);

    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-win-sbx-")));
    cleanups.push(() => removeTreeWithRetry(root));

    const dataDir = join(root, "agent-hub");
    const stateDir = join(dataDir, "state");
    const ownWt = join(dataDir, "worktrees", "1", "524");
    const otherWt = join(dataDir, "worktrees", "1", "525");
    const externalProj = join(root, "external-project");
    const pnpmStore = join(root, ".pnpm-store");

    for (const d of [stateDir, ownWt, otherWt, externalProj, pnpmStore]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(stateDir, "secret.txt"), "protected");
    writeFileSync(join(otherWt, "other.txt"), "untouched");

    ensureWin32ProtectedRootAcl(stateDir, dataDir);
    hardenWin32PrivateDirAcl(stateDir, stateDir);
    allowWin32WorkerWorktreeAcl(stateDir, "524", ownWt);
    allowWin32WorkerWorktreeAcl(stateDir, "525", otherWt);

    // 启动一个真实命名管道供沙箱内 Worker 连接测试
    const paths = resolveHubPaths({}, dataDir);
    const ledger = new FakeHubLedger();
    const tokens = createSessionTokens();
    const api = await startAgentApi({
      ledger,
      tokens,
      runDir: paths.runDir,
      hubSock: paths.hubSock,
    });
    cleanups.push(() => api.close());
    const sessionTok = tokens.issue(524);

    const scope = workerWriteScope({ role: "worker", dataDir, cwd: ownWt })!;
    const probeScript = join(externalProj, "sandbox-check.mjs");
    const reportFile = join(externalProj, "report.json");

    writeFileSync(
      probeScript,
      `
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

const tryWrite = (p) => {
  try {
    writeFileSync(p, "hacked");
    return "wrote";
  } catch (e) {
    return e.code || "err";
  }
};

const stateWrite = tryWrite(${JSON.stringify(join(stateDir, "pwn.txt"))});
const dataRootWrite = tryWrite(${JSON.stringify(join(dataDir, "pwn.txt"))});
const otherWtWrite = tryWrite(${JSON.stringify(join(otherWt, "pwn.txt"))});
const ownWtWrite = tryWrite(${JSON.stringify(join(ownWt, "ok.txt"))});
const extProjWrite = tryWrite(${JSON.stringify(join(externalProj, "ok.txt"))});
const storeWrite = tryWrite(${JSON.stringify(join(pnpmStore, "ok.txt"))});
const tempWrite = tryWrite(join(process.env.TEMP || process.env.TMP, "fusa-sbx-temp-" + process.pid + ".txt"));

const icaclsRes = spawnSync("icacls.exe", [${JSON.stringify(stateDir)}, "/grant", "*S-1-1-0:(F)"], { windowsHide: true });
const takeownRes = spawnSync("takeown.exe", ["/f", ${JSON.stringify(stateDir)}], { windowsHide: true });
const setAclRes = spawnSync(
  "pwsh.exe",
  ["-NoProfile", "-Command", "$acl = Get-Acl -LiteralPath '${stateDir.replaceAll("'", "''")}'; Set-Acl -LiteralPath '${stateDir.replaceAll("'", "''")}' -AclObject $acl"],
  { windowsHide: true },
);
const nulRedir = spawnSync("cmd.exe", ["/d", "/c", "echo ok > NUL"], { windowsHide: true });

const pipeStatus = await new Promise((resolve) => {
  const body = "{}";
  const req = request(
    {
      socketPath: ${JSON.stringify(api.socketPath)},
      method: "POST",
      path: "/hub/status",
      headers: {
        authorization: "Bearer ${sessionTok}",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    },
    (res) => {
      res.resume();
      resolve(res.statusCode);
    },
  );
  req.on("error", (err) => resolve(err.code || err.message));
  req.end(body);
});

writeFileSync(
  ${JSON.stringify(reportFile)},
  JSON.stringify({
    stateWrite,
    dataRootWrite,
    otherWtWrite,
    ownWtWrite,
    extProjWrite,
    storeWrite,
    tempWrite,
    icaclsCode: icaclsRes.status,
    takeownCode: takeownRes.status,
    setAclCode: setAclRes.status,
    nulCode: nulRedir.status,
    pipeStatus,
  }),
);
`,
    );

    const wrapped = spawnInWriteScope(
      "codex",
      { command: process.execPath, args: [probeScript] },
      scope,
      undefined,
      "worker 524",
      "win32",
      { stateDir },
    );
    const run = spawnSync(wrapped.command, wrapped.args, {
      cwd: ownWt,
      encoding: "utf8",
      windowsHide: true,
    });
    if (run.status !== 0) {
      writeDiagLog("worker-sandbox-stderr", `${run.stdout}\n${run.stderr}`);
    }
    expect(run.status, run.stderr).toBe(0);

    const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, unknown>;
    expect(report.stateWrite).not.toBe("wrote");
    expect(report.dataRootWrite).not.toBe("wrote");
    expect(report.otherWtWrite).not.toBe("wrote");
    expect(report.ownWtWrite).toBe("wrote");
    expect(report.extProjWrite).toBe("wrote");
    expect(report.storeWrite).toBe("wrote");
    expect(report.tempWrite).toBe("wrote");
    expect(report.icaclsCode).not.toBe(0);
    expect(report.takeownCode).not.toBe(0);
    expect(report.setAclCode).not.toBe(0);
    expect(report.nulCode).toBe(0);
    expect(report.pipeStatus).toBe(200);

    // PM 会话（无沙箱）正常写 state\ 成功
    const fusaRun = requireWinHelperBinary("fusa-run.exe");
    const pmFile = join(stateDir, "pm-ok.txt");
    const pmRun = spawnSync(
      fusaRun,
      ["--", process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(pmFile)}, "pm-ok")`],
      { encoding: "utf8", windowsHide: true },
    );
    expect(pmRun.status, pmRun.stderr).toBe(0);
    expect(readFileSync(pmFile, "utf8")).toBe("pm-ok");
  });

  it("非 codex 只读 Worker 在无 MXC 环境下绝不硬拒：自动回退为 4.4.2 写受限令牌 + 受保护根禁写 + 工具层禁写，并发出清晰降级告警", { timeout: 30_000 }, async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-win-ro-fallback-")));
    cleanups.push(() => removeTreeWithRetry(root));

    const dataDir = join(root, "agent-hub");
    const stateDir = join(dataDir, "state");
    const wtDir = join(dataDir, "worktrees", "1", "600");
    const tmpRo = join(root, "ro-tmp");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(wtDir, { recursive: true });
    mkdirSync(tmpRo, { recursive: true });

    ensureWin32ProtectedRootAcl(stateDir, dataDir);
    allowWin32WorkerWorktreeAcl(stateDir, "600", wtDir);

    // 1) 验证 --readonly-fallback 内核级效果：连 worktree 目录本身也禁止写入（因为不挂单 Worker 放行 SID）！
    const policy = buildReadonlyPolicy({ homeDir: realpathSync.native(homedir()), stateDir });
    const roWrapped = wrapInReadonlyOsSandbox(
      {
        command: process.execPath,
        args: [
          "-e",
          `
const fs = require("node:fs");
let stateBlocked = false;
let wtBlocked = false;
try { fs.writeFileSync(${JSON.stringify(join(stateDir, "ro.txt"))}, "x"); } catch { stateBlocked = true; }
try { fs.writeFileSync(${JSON.stringify(join(wtDir, "ro.txt"))}, "x"); } catch { wtBlocked = true; }
fs.writeFileSync(${JSON.stringify(join(tmpRo, "result.json"))}, JSON.stringify({ stateBlocked, wtBlocked }));
`,
        ],
      },
      {
        tmpDir: tmpRo,
        stateDir,
        writableDirs: [],
        writableFileRegexes: [],
        secretPaths: policy.secretPaths,
        secretGlobs: policy.secretGlobs,
      },
      "win32",
    );
    expect(roWrapped.osSandboxed).toBe(true);
    expect(roWrapped.readonlyMode).toBe("fallback_write_restricted");
    expect(roWrapped.readonlyFallbackWarning).toBe(WIN32_READONLY_FALLBACK_WARNING);

    const execRes = spawnSync(roWrapped.command, roWrapped.args, { encoding: "utf8", windowsHide: true });
    expect(execRes.status, execRes.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(tmpRo, "result.json"), "utf8"))).toEqual({
      stateBlocked: true,
      wtBlocked: true,
    });

    // 2) 验证真实非 codex 驱动（以 Pi 驱动 + .cmd 垫片为例）启动只读会话不报错、带出工具禁写参数并发射 driver.warning
    const fakePi = writeFakePiBinary(join(root, "pi-bin"), {
      turns: [{ finalText: "只读审查完成" }],
    });
    const store = new MemorySessionStore();
    const sessionRow: AgentSessionRow = {
      id: 600,
      conversationId: 1,
      role: "worker",
      pmId: null,
      workerId: 600,
      vendor: "pi",
      vendorSessionId: "",
      model: null,
      effort: null,
      cwd: wtDir,
      addDirs: [],
      status: "idle",
      pid: null,
      hasCompletedTurn: false,
      generation: 1,
      usage: EMPTY_TOKEN_USAGE,
      lastEventAt: null,
      rateLimit: null,
      createdAt: 1,
      updatedAt: 1,
    };
    store.add(sessionRow);

    const logs: string[] = [];
    const events: DriverEvent[] = [];
    const promptFile = join(root, "prompt.md");
    writeFileSync(promptFile, "只读审查提示词");

    const piDriver = createPiDriver({
      executablePath: fakePi.binPath,
      store,
      log: (l) => logs.push(l),
      env: {
        PATH: `${dirname(process.execPath)};${process.env.PATH ?? process.env.Path ?? ""}`,
        FAKE_PI_LOG: fakePi.logPath,
        FAKE_PI_SCRIPT: fakePi.scriptPath,
      },
      prepareLaunch: async () => ({
        promptFile,
        env: {},
        fingerprint: "ro-fp",
        readonly: policy,
      }),
    });
    cleanups.push(() => piDriver.shutdown());
    piDriver.onEvent((_id, ev) => events.push(ev));

    const sendRes = await piDriver.send(600, {
      messageIds: [1],
      source: "user",
      text: "请只读检查代码",
    });
    expect(sendRes.kind).toBe("written");

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !events.some((e) => e.type === "turn.ended")) {
      await new Promise((r) => setTimeout(r, 40));
    }

    expect(events.some((e) => e.type === "turn.ended" && e.ok)).toBe(true);
    expect(
      events.some(
        (e) => e.type === "driver.warning" && e.message.includes("写受限令牌 + 受保护根拒写 ACL + 工具层只读拦截"),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes("写受限令牌"))).toBe(true);
    const piArgv = fakePi.readLogs().find((e) => Array.isArray(e.argv))?.argv ?? [];
    expect(piArgv).toContain("--exclude-tools");
    expect(piArgv).toContain("edit,write");
    expect(piArgv).toContain("--no-mcp");
  });
});
