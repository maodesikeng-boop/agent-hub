import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHubLedger } from "../../src/daemon/agent-api/fake-ledger.ts";
import { startAgentApi } from "../../src/daemon/agent-api/server.ts";
import { createSessionTokens } from "../../src/daemon/agent-api/tokens.ts";
import { MemorySessionStore } from "../../src/daemon/driver/test-helpers.ts";
import {
  osSandboxAvailable,
  prepareOsSandboxForLaunch,
  resetOsSandboxCacheForTest,
  spawnInWriteScope,
  wrapInReadonlyOsSandbox,
} from "../../src/daemon/driver/write-scope.ts";
import {
  allowWin32WorkerWorktreeAcl,
  denyWin32WorkerPipeAccess,
  ensureWin32ProtectedRootAcl,
  hardenWin32PrivateDirAcl,
  removeTreeWithRetry,
  requireWinHelperBinary,
} from "../../src/daemon/platform/index.ts";
import {
  EMPTY_TOKEN_USAGE,
  buildReadonlyPolicy,
  dataDirReadScope,
  workerWriteScope,
  type AgentSessionRow,
  type DriverEvent,
} from "../../src/shared/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import { createPiDriver } from "../../src/vendors/pi/driver.ts";
import { writeFakePiBinary } from "../../src/vendors/pi/fixtures/fake-pi.ts";
import { writeDiagLog } from "./diag-helper.ts";

const cleanups: Array<() => Promise<void> | void> = [];

function runChildAsync(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code, stdout, stderr });
    });
  });
}

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

describe.runIf(process.platform === "win32")("Windows 真机集成：受限令牌 + ACL 沙箱（禁写、数据目录禁读）与无 MXC 只读 Worker 回退", () => {
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

    await ensureWin32ProtectedRootAcl(stateDir, dataDir);
    hardenWin32PrivateDirAcl(stateDir, stateDir);
    await allowWin32WorkerWorktreeAcl(stateDir, "524", ownWt);
    await allowWin32WorkerWorktreeAcl(stateDir, "525", otherWt);

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

    // 数据目录读边界：state\ 的令牌、备份读不到，自己会话的启动目录、别的 worktree 读得到，管理管道连不上
    const launchDir = join(stateDir, "launch", "7");
    mkdirSync(launchDir, { recursive: true });
    writeFileSync(join(stateDir, "ui-token"), "UI_TOKEN");
    writeFileSync(join(launchDir, "prompt.md"), "OWN_PROMPT");
    mkdirSync(join(dataDir, "backups", "sync"), { recursive: true });
    writeFileSync(join(dataDir, "backups", "sync", "settings.json.bak"), "BACKUP");
    const scope = workerWriteScope({ role: "worker", dataDir, cwd: ownWt, launchDir })!;
    await prepareOsSandboxForLaunch({ dataDir, stateDir, writeScope: scope, readonly: undefined }, "win32");
    const adminPipe = `\\\\.\\pipe\\fusa-test-admin-${process.pid}`;
    // 改管道 DACL 时 fusa-run 先以客户端身份连上：服务端不主动断开，免得句柄还没改完权限连接就没了
    const adminSockets = new Set<import("node:net").Socket>();
    const adminServer = createNetServer((socket) => {
      adminSockets.add(socket);
      socket.on("close", () => adminSockets.delete(socket));
    });
    await new Promise<void>((resolve) => adminServer.listen(adminPipe, () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of adminSockets) socket.destroy();
          adminServer.close(() => resolve());
        }),
    );
    await denyWin32WorkerPipeAccess(stateDir, adminPipe);
    const probeScript = join(externalProj, "sandbox-check.mjs");
    const reportFile = join(externalProj, "report.json");

    writeFileSync(
      probeScript,
      `
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";

const tryWrite = (p) => {
  try {
    writeFileSync(p, "hacked");
    return "wrote";
  } catch (e) {
    return e.code || "err";
  }
};
const tryRead = (p) => {
  try {
    readFileSync(p);
    return "read";
  } catch (e) {
    return e.code || "err";
  }
};
const uiTokenRead = tryRead(${JSON.stringify(join(stateDir, "ui-token"))});
const backupRead = tryRead(${JSON.stringify(join(dataDir, "backups", "sync", "settings.json.bak"))});
const launchRead = tryRead(${JSON.stringify(join(launchDir, "prompt.md"))});
const otherWtRead = tryRead(${JSON.stringify(join(otherWt, "other.txt"))});
const adminPipe = await new Promise((resolve) => {
  const s = connect(${JSON.stringify(adminPipe)});
  s.on("connect", () => { s.destroy(); resolve("connected"); });
  s.on("error", (e) => resolve(e.code || "err"));
});

const stateWrite = tryWrite(${JSON.stringify(join(stateDir, "pwn.txt"))});
const dataRootWrite = tryWrite(${JSON.stringify(join(dataDir, "pwn.txt"))});
const otherWtWrite = tryWrite(${JSON.stringify(join(otherWt, "pwn.txt"))});
const ownWtWrite = tryWrite(${JSON.stringify(join(ownWt, "ok.txt"))});

// 验证在 worktree 内多级新建嵌套子目录与临时目录中读写删自建文件闭环
let nestedLifecycle = "err";
try {
  const nestedDir = join(${JSON.stringify(ownWt)}, "nested", "sub");
  mkdirSync(nestedDir, { recursive: true });
  const keptFile = join(nestedDir, "kept.txt");
  const ephemeralFile = join(nestedDir, "ephemeral.txt");
  writeFileSync(keptFile, "v1");
  appendFileSync(keptFile, "+v2");
  writeFileSync(ephemeralFile, "tmp");
  rmSync(ephemeralFile);
  if (readFileSync(keptFile, "utf8") === "v1+v2") {
    nestedLifecycle = "ok";
  }
} catch (e) {
  nestedLifecycle = e.code || String(e);
}

const extProjWrite = tryWrite(${JSON.stringify(join(externalProj, "ok.txt"))});
const storeWrite = tryWrite(${JSON.stringify(join(pnpmStore, "ok.txt"))});
let tempWrite = "err";
try {
  const tmpFile = join(process.env.TEMP || process.env.TMP, "fusa-sbx-temp-" + process.pid + ".txt");
  writeFileSync(tmpFile, "tmp-ok");
  if (readFileSync(tmpFile, "utf8") === "tmp-ok") {
    rmSync(tmpFile);
    tempWrite = "wrote";
  }
} catch (e) {
  tempWrite = e.code || "err";
}

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
      path: "/v1/status",
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
    nestedLifecycle,
    extProjWrite,
    storeWrite,
    tempWrite,
    icaclsCode: icaclsRes.status,
    takeownCode: takeownRes.status,
    setAclCode: setAclRes.status,
    nulCode: nulRedir.status,
    pipeStatus,
    uiTokenRead,
    backupRead,
    launchRead,
    otherWtRead,
    adminPipe,
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
    const run = await runChildAsync(wrapped.command, wrapped.args, {
      cwd: ownWt,
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
    expect(report.nestedLifecycle).toBe("ok");
    expect(report.extProjWrite).toBe("wrote");
    expect(report.storeWrite).toBe("wrote");
    expect(report.tempWrite).toBe("wrote");
    expect(report.icaclsCode).not.toBe(0);
    expect(report.takeownCode).not.toBe(0);
    expect(report.setAclCode).not.toBe(0);
    expect(report.nulCode).toBe(0);
    expect(report.pipeStatus).toBe(200);
    expect(report.uiTokenRead).not.toBe("read");
    expect(report.backupRead).not.toBe("read");
    expect(report.launchRead).toBe("read");
    expect(report.otherWtRead).toBe("read");
    expect(report.adminPipe).not.toBe("connected");

    // 兄弟 Worker 525 尝试篡改或删除 Worker 524 新建的嵌套子目录文件必须被拒绝；随后主守护进程可正常删除
    const siblingScope = workerWriteScope({ role: "worker", dataDir, cwd: otherWt })!;
    const keptNestedFile = join(ownWt, "nested", "sub", "kept.txt");
    const siblingWrapped = spawnInWriteScope(
      "codex",
      {
        command: process.execPath,
        args: [
          "-e",
          `try { require("node:fs").writeFileSync(${JSON.stringify(keptNestedFile)}, "tampered"); process.exit(9); } catch { process.exit(0); }`,
        ],
      },
      siblingScope,
      undefined,
      "worker 525",
      "win32",
      { stateDir },
    );
    const siblingRun = spawnSync(siblingWrapped.command, siblingWrapped.args, {
      cwd: otherWt,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(siblingRun.status, siblingRun.stderr).toBe(0);
    expect(readFileSync(keptNestedFile, "utf8")).toBe("v1+v2");
    await removeTreeWithRetry(join(ownWt, "nested"));
    expect(existsSync(join(ownWt, "nested"))).toBe(false);

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

  it("非 codex 只读 Worker 在无 MXC 环境下严格失败关闭：不降级且拒绝启动进程", { timeout: 30_000 }, async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-win-ro-failclosed-")));
    cleanups.push(() => removeTreeWithRetry(root));

    const dataDir = join(root, "agent-hub");
    const stateDir = join(dataDir, "state");
    const wtDir = join(dataDir, "worktrees", "1", "600");
    const extraProtectedRoot = join(root, "cross-vol-fusa-wt");
    const tmpRo = join(root, "ro-tmp");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(wtDir, { recursive: true });
    mkdirSync(extraProtectedRoot, { recursive: true });
    mkdirSync(tmpRo, { recursive: true });

    await ensureWin32ProtectedRootAcl(stateDir, dataDir);
    await allowWin32WorkerWorktreeAcl(stateDir, "600", wtDir);

    const roLaunchDir = join(stateDir, "launch", "600");
    mkdirSync(roLaunchDir, { recursive: true });
    const policy = buildReadonlyPolicy({
      homeDir: realpathSync.native(homedir()),
      stateDir,
      protectedRoots: [dataDir, extraProtectedRoot],
      dataDirScope: dataDirReadScope({ dataDir, launchDir: roLaunchDir, extraReadable: [wtDir] }),
    });
    await prepareOsSandboxForLaunch({ dataDir, stateDir, writeScope: null, readonly: policy }, "win32");
    const base = { command: process.execPath, args: ["-e", "process.exit(0)"] };
    const roWrapped = wrapInReadonlyOsSandbox(
      base,
      {
        tmpDir: tmpRo,
        stateDir,
        protectedRoots: policy.protectedRoots,
        writableDirs: [],
        writableFileRegexes: [],
        secretPaths: policy.secretPaths,
        secretGlobs: policy.secretGlobs,
        ...(policy.dataDirScope ? { dataDirScope: policy.dataDirScope } : {}),
      },
      "win32",
      { disableWin32Mxc: true },
    );
    expect(roWrapped).toEqual({ ...base, osSandboxed: false });
    expect(roWrapped.readonlyMode).toBeUndefined();

    const fakePi = writeFakePiBinary(join(root, "pi-bin"), {
      turns: [{ finalText: "不应执行" }],
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

    const events: DriverEvent[] = [];
    const promptFile = join(root, "prompt.md");
    writeFileSync(promptFile, "只读审查提示词");
    const piTmpDir = join(root, "pi-session-tmp");
    mkdirSync(piTmpDir, { recursive: true });

    const piDriver = createPiDriver({
      executablePath: fakePi.binPath,
      store,
      readonlySpawn: (cmd, input) => wrapInReadonlyOsSandbox(cmd, input, "win32", { disableWin32Mxc: true }),
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
        tmpDir: piTmpDir,
      }),
    });
    cleanups.push(() => piDriver.shutdown());
    piDriver.onEvent((_id, ev) => events.push(ev));

    await expect(
      piDriver.send(600, {
        messageIds: [1],
        source: "user",
        text: "请只读检查代码",
      }),
    ).rejects.toThrow(/MXC/u);

    expect(events.some((e) => e.type === "driver.warning")).toBe(false);
    expect(fakePi.readLogs()).toEqual([]);
  });
});
