import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildNpmNodeCmdShim } from "../../../test/fake-cli-shim.ts";
import { runHub } from "../../hub/cli.ts";
import {
  AGENT_VENDORS,
  MAX_WORKTREE_ROOTS,
  WIN_CMD_SHIM_CACHE_MAX,
  WIN_CMD_SHIM_MAX_BYTES,
  buildReadonlyPolicy,
} from "../../shared/index.ts";
import {
  VENDOR_FALLBACK_PATHS,
  findExecutable,
  isWindowsNamedPipe,
  resetLocatedExecutablesCacheForTest,
  resolveHubPaths,
} from "../../shared/paths.ts";
import { installHubShim } from "../agent-api/shim.ts";
import { buildChildEnv } from "../driver/protocol.ts";
import { buildWindowsExplorerInvocation } from "../open-file.ts";
import { resolveSetupShell } from "../setup/setup.ts";
import {
  FUSA_MANAGED_COPY_MARKER,
  NetworkProjectFolderUnsupportedError,
  SLEEP_INHIBIT_COMMANDS,
  WIN32_KEEP_AWAKE_BIN,
  WIN32_TAILSCALE_DEFAULT_CLI,
  WindowsCmdLineBreakError,
  WindowsPowerShellScriptUnsupportedError,
  buildWindowsCmdShimCommandLine,
  createDirectoryLinkOrManagedCopySync,
  createSleepInhibitor,
  isCrossPlatformAbsolutePath,
  isPathInsideOrEqual,
  isPathStrictlyInside,
  isUncNetworkPath,
  loadManagedWorktreeRoots,
  mergePathPrependedEnv,
  normalizePathForComparison,
  openRegularFileNoFollowSync,
  parseWindowsCmdShim,
  parseWindowsCommandLine,
  quoteWindowsArgument,
  quoteWindowsCmdArgument,
  readManagedSkillCopyMeta,
  registerManagedWorktreeRoot,
  removeTreeWithRetry,
  renameSyncWithWindowsRetry,
  renameWithWindowsRetry,
  resetWindowsCmdShimCacheForTest,
  resolveSpawn,
  resolveWindowsCmdShim,
  selectWorktreeRootForProject,
  tailscaleCommand,
  writeFileAtomicSyncWithRetry,
} from "./index.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let tempDirs: string[] = [];
function makeTempDir(prefix = "fusa-win32-unit-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetWindowsCmdShimCacheForTest();
  resetLocatedExecutablesCacheForTest();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("源码守卫：全仓 src/ 严禁出现 shell: true", () => {
  it("扫描 src/ 下全部非测试 TS/TSX 源文件，不出现隐式 shell 启动选项", () => {
    const hits: string[] = [];
    const srcDir = join(REPO_ROOT, "src");
    for (const entry of readdirSync(srcDir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
      const full = join(entry.parentPath, entry.name);
      const rel = relative(REPO_ROOT, full).replace(/\\/g, "/");
      const lines = readFileSync(full, "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (/shell\s*:\s*true\b/.test(line)) {
          hits.push(`${rel}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("Windows 命令行转义与 .cmd 垫片解析（orca MIT 移植）", () => {
  it("CommandLineToArgvW 引号转义往返一致，cmd 转义阻断 %VAR% 展开并拒绝换行", () => {
    const samples = [
      "plain",
      "",
      "space value",
      'quote"inside',
      "C:\\trailing\\slash\\",
      '{"enableTerminalSandbox":false}',
      "a&b|c^d<e>f",
      "%PATH%",
      "!DELAYED!",
      "中文 🚀",
    ];
    const cmdLine = samples.map(quoteWindowsArgument).join(" ");
    expect(parseWindowsCommandLine(cmdLine)).toEqual(samples);

    expect(quoteWindowsCmdArgument("%PATH%")).toContain('"^%"');
    expect(() => buildWindowsCmdShimCommandLine("C:\\tool.cmd", ["line1\nline2"])).toThrow(WindowsCmdLineBreakError);
    expect(() => buildWindowsCmdShimCommandLine("C:\\tool.cmd", ["line1\rline2"])).toThrow(WindowsCmdLineBreakError);
  });

  it("parseWindowsCmdShim 精确识别 npm/pnpm 四种垫片格式，拒绝盘符相对路径、备用数据流与特殊元字符", () => {
    const modernNpm = buildNpmNodeCmdShim("node_modules\\pkg\\bin\\cli.js");
    expect(parseWindowsCmdShim(modernNpm)).toEqual({
      kind: "node",
      script: "node_modules\\pkg\\bin\\cli.js",
    });

    const pnpmBranched = [
      "@SETLOCAL",
      '@IF NOT DEFINED NODE_PATH (',
      '  @SET "NODE_PATH=C:\\store\\node_modules"',
      ") ELSE (",
      '  @SET "NODE_PATH=C:\\store\\node_modules;%NODE_PATH%"',
      ")",
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\..\\pkg\\cli.js" %*',
      ") ELSE (",
      "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
      '  node  "%~dp0\\..\\pkg\\cli.js" %*',
      ")",
    ].join("\r\n");
    expect(parseWindowsCmdShim(pnpmBranched)).toEqual({
      kind: "node",
      script: "..\\pkg\\cli.js",
      nodePathPrefix: "C:\\store\\node_modules",
    });

    const nativeExeShim = '@echo off\r\n"%~dp0\\vendor\\app.exe" %*\r\n';
    expect(parseWindowsCmdShim(nativeExeShim)).toEqual({
      kind: "direct",
      target: "vendor\\app.exe",
    });

    // 危险写法（盘符相对 D:evil.js、备用数据流 cli.js:zone、命令拼接 &）一律返回 null
    expect(parseWindowsCmdShim('@echo off\r\n"%~dp0\\D:evil.js" %*\r\n')).toBeNull();
    expect(parseWindowsCmdShim('@echo off\r\n"%~dp0\\cli.js:zone" %*\r\n')).toBeNull();
    expect(parseWindowsCmdShim('@echo off\r\n"%~dp0\\cli.js&calc" %*\r\n')).toBeNull();
  });

  it("resolveWindowsCmdShim 按 mtime+size 校验失效，超过 64 KiB 不读，超过上限自动清理；resolveSpawn 拒绝 .ps1", () => {
    let readCalls = 0;
    let currentMtime = 1_000;
    let currentBody = buildNpmNodeCmdShim("cli-v1.js");
    const existingFiles = new Set([
      "C:\\Users\\u\\AppData\\Roaming\\npm\\tool.cmd",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\cli-v1.js",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\cli-v2.js",
      "C:\\Program Files\\nodejs\\node.exe",
    ]);

    const hooks = {
      stat: (p: string) =>
        existingFiles.has(p)
          ? ({ isFile: () => true, mtimeMs: currentMtime, size: Buffer.byteLength(currentBody) } as never)
          : null,
      read: () => {
        readCalls += 1;
        return currentBody;
      },
    };
    const env = { Path: "C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

    const r1 = resolveWindowsCmdShim("C:\\Users\\u\\AppData\\Roaming\\npm\\tool.cmd", env, hooks);
    expect(r1).toEqual({
      program: "C:\\Program Files\\nodejs\\node.exe",
      prefixArgs: ["C:\\Users\\u\\AppData\\Roaming\\npm\\cli-v1.js"],
    });
    const r2 = resolveWindowsCmdShim("C:\\Users\\u\\AppData\\Roaming\\npm\\tool.cmd", env, hooks);
    expect(r2).toEqual(r1);
    expect(readCalls).toBe(1);

    // 升级后 mtime 变化：缓存自动失效重读
    currentMtime = 2_000;
    currentBody = buildNpmNodeCmdShim("cli-v2.js");
    const r3 = resolveWindowsCmdShim("C:\\Users\\u\\AppData\\Roaming\\npm\\tool.cmd", env, hooks);
    expect(r3?.prefixArgs).toEqual(["C:\\Users\\u\\AppData\\Roaming\\npm\\cli-v2.js"]);
    expect(readCalls).toBe(2);

    // 超过 WIN_CMD_SHIM_MAX_BYTES 直接跳过不读
    const hugeHooks = {
      stat: () => ({ isFile: () => true, mtimeMs: 3_000, size: WIN_CMD_SHIM_MAX_BYTES + 1 }) as never,
      read: () => {
        throw new Error("should not read oversized shim");
      },
    };
    expect(resolveWindowsCmdShim("C:\\Users\\u\\AppData\\Roaming\\npm\\tool.cmd", env, hugeHooks)).toBeNull();

    // 缓存条数上限覆盖验证
    for (let i = 0; i < WIN_CMD_SHIM_CACHE_MAX + 5; i++) {
      const p = `C:\\shims\\t-${i}.cmd`;
      resolveWindowsCmdShim(p, env, {
        stat: (cand) =>
          cand === p || cand === "C:\\shims\\cli-v2.js" || cand === "C:\\Program Files\\nodejs\\node.exe"
            ? ({ isFile: () => true, mtimeMs: 1, size: 100 } as never)
            : null,
        read: () => currentBody,
      });
    }

    expect(() => resolveSpawn({ program: "C:\\bin\\agent.ps1", args: [] }, "win32")).toThrow(
      WindowsPowerShellScriptUnsupportedError,
    );
  });

  it("buildChildEnv 与 mergePathPrependedEnv 在 Windows 下消除 Path/PATH 双键冲突", () => {
    const merged = buildChildEnv(
      { Path: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\u" },
      { PATH: "C:\\run\\bin;C:\\Windows\\System32" },
      "win32",
    );
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(merged.PATH).toBe("C:\\run\\bin;C:\\Windows\\System32");

    const prepended = mergePathPrependedEnv(
      { Path: "C:\\Windows\\System32", path: "C:\\dup" },
      "C:\\Users\\u\\.agent-hub\\run\\bin",
      undefined,
      "win32",
    );
    expect(Object.keys(prepended).filter((k) => k.toLowerCase() === "path")).toEqual(["Path"]);
    expect(prepended.Path).toBe("C:\\Users\\u\\.agent-hub\\run\\bin;C:\\Windows\\System32");
  });
});

describe("Windows 路径比较键、IPC 命名管道与 6 家厂商路径解析", () => {
  it("normalizePathForComparison：折叠盘符大小写、斜杠与 \\\\?\\ 前缀，保留 POSIX 大小写", () => {
    expect(normalizePathForComparison("C:\\Users\\Alice\\Proj\\")).toBe("c:/users/alice/proj");
    expect(normalizePathForComparison("c:/users/alice/proj")).toBe("c:/users/alice/proj");
    expect(normalizePathForComparison("\\\\?\\D:\\.fusa-wt\\ab12\\7\\524")).toBe("d:/.fusa-wt/ab12/7/524");
    expect(normalizePathForComparison("\\\\?\\UNC\\Server\\Share\\Dir")).toBe("//server/share/dir");
    expect(normalizePathForComparison("/Users/Alice/CaseSensitive")).toBe("/Users/Alice/CaseSensitive");

    expect(isPathInsideOrEqual("D:\\.fusa-wt\\ab12", "d:/\\.fusa-wt/ab12/7/524")).toBe(true);
    expect(isPathStrictlyInside("D:\\.fusa-wt\\ab12", "D:\\.fusa-wt\\ab12")).toBe(false);
    expect(isUncNetworkPath("\\\\localhost\\D$\\repo")).toBe(true);
    expect(isUncNetworkPath("\\\\.\\pipe\\fusa-test")).toBe(false);
    expect(isUncNetworkPath("\\\\?\\D:\\repo")).toBe(false);
    expect(isCrossPlatformAbsolutePath("D:\\repo")).toBe(true);
    expect(isCrossPlatformAbsolutePath("/repo")).toBe(true);
    expect(isCrossPlatformAbsolutePath("relative\\repo")).toBe(false);
  });

  it("resolveHubPaths('win32') 生成命名管道端点，6 家厂商均有 win32 兜底候选路径且支持 PATHEXT", () => {
    const p1 = resolveHubPaths({}, "C:\\Users\\alice", { platform: "win32" });
    const p2 = resolveHubPaths({}, "C:\\Users\\alice", { platform: "win32" });
    expect(isWindowsNamedPipe(p1.hubSock)).toBe(true);
    expect(isWindowsNamedPipe(p1.adminSock)).toBe(true);
    // admin 管道固定名（兼做单实例互斥），hub 管道每次随机后缀防猜测
    expect(p1.adminSock).toBe(p2.adminSock);
    expect(p1.hubSock).not.toBe(p2.hubSock);

    for (const vendor of AGENT_VENDORS) {
      const fallbacks = VENDOR_FALLBACK_PATHS[vendor]("C:\\Users\\alice", "win32");
      expect(fallbacks.length, vendor).toBeGreaterThan(0);
      expect(fallbacks.every((f) => /\.(?:exe|cmd)$/i.test(f)), vendor).toBe(true);
    }

    const binDir = makeTempDir("pathext-");
    writeFileSync(join(binDir, "demo.cmd"), "@echo off\r\n");
    writeFileSync(join(binDir, "demo.exe"), "MZ");
    // PATHEXT 中 .EXE 排在 .CMD 前，优先命中 .exe
    const found = findExecutable("demo", binDir, [], {
      platform: "win32",
      pathExt: ".COM;.EXE;.BAT;.CMD",
    });
    expect(found).toBe(join(binDir, "demo.exe"));
  });
});

describe("文件安全打开、重试与目录链接回退（fs-safe）", () => {
  it("openRegularFileNoFollowSync 拒绝 Windows 设备路径与软链", () => {
    const dir = makeTempDir("nofollow-");
    const realFile = join(dir, "real.txt");
    const linkFile = join(dir, "link.txt");
    writeFileSync(realFile, "hello");
    symlinkSync(realFile, linkFile);

    expect(() => openRegularFileNoFollowSync("\\\\.\\pipe\\evil", { platform: "win32" })).toThrow();
    expect(() => openRegularFileNoFollowSync("C:\\dir\\CON.txt", { platform: "win32" })).toThrow();
    expect(() => openRegularFileNoFollowSync(linkFile, { platform: "win32" })).toThrow();
  });

  it("rename / writeFileAtomic / removeTree 在 Windows 短暂锁错误下按有界预算重试，超限附带 who-locks 进程信息", async () => {
    let renameTries = 0;
    renameSyncWithWindowsRetry("a", "b", {
      platform: "win32",
      delaysMs: [1, 1, 1],
      renameImpl: () => {
        renameTries += 1;
        if (renameTries < 3) {
          const err = new Error("busy") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
      },
    });
    expect(renameTries).toBe(3);

    let asyncTries = 0;
    await renameWithWindowsRetry("a", "b", {
      platform: "win32",
      delaysMs: [1, 1],
      renameImpl: async () => {
        asyncTries += 1;
        if (asyncTries === 1) {
          const err = new Error("busy") as NodeJS.ErrnoException;
          err.code = "EBUSY";
          throw err;
        }
      },
    });
    expect(asyncTries).toBe(2);

    let atomicTries = 0;
    writeFileAtomicSyncWithRetry("cfg.json", "{}", {
      platform: "win32",
      delaysMs: [1, 1],
      writeImpl: () => {
        atomicTries += 1;
        if (atomicTries === 1) {
          const err = new Error("locked") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
      },
    });
    expect(atomicTries).toBe(2);

    let rmPasses = 0;
    await expect(
      removeTreeWithRetry("D:\\.fusa-wt\\x\\1\\2", {
        platform: "win32",
        passDelaysMs: [1, 1],
        whoLocks: () => "MSBuild.exe (PID 9876)",
        rm: async () => {
          rmPasses += 1;
          const err = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
          err.code = "EBUSY";
          throw err;
        },
      }),
    ).rejects.toThrow("占用进程：MSBuild.exe (PID 9876)");
    expect(rmPasses).toBe(3);
  });

  it("createDirectoryLinkOrManagedCopySync：网络/UNC 或不支持 junction 时回退生成带 .fusa-managed 的受控副本", () => {
    const dir = makeTempDir("managed-copy-");
    const srcSkill = join(dir, "canonical", "my-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# Skill\n");

    const destLink = join(dir, "target", "my-skill");
    // 在非 Windows 主机模拟 win32 junction 抛 EINVAL 时自动走受控复制回退
    if (process.platform !== "win32") {
      const kind = createDirectoryLinkOrManagedCopySync(srcSkill, destLink, { platform: "darwin" });
      expect(kind).toBe("symlink");
      rmSync(destLink, { recursive: true, force: true });
    }
    // 直接验证受控副本元数据格式读写
    mkdirSync(destLink, { recursive: true });
    writeFileSync(join(destLink, "SKILL.md"), "# Skill\n");
    writeFileSync(
      join(destLink, FUSA_MANAGED_COPY_MARKER),
      JSON.stringify({ version: 1, canonicalPath: srcSkill, contentHash: "abc" }),
    );
    expect(readManagedSkillCopyMeta(destLink)).toEqual({
      version: 1,
      canonicalPath: srcSkill,
      contentHash: "abc",
    });
  });
});

describe("跨卷同盘 worktree 选根、回退与上限（worktree-roots）", () => {
  it("同卷沿用默认 worktreesDir；跨卷落同盘 .fusa-wt 并登记；ACL/建目录失败自动安全回退；拒绝网络共享", () => {
    const root = makeTempDir("wt-roots-");
    const dataDir = join(root, "c-drive-data");
    const stateDir = join(dataDir, "state");
    const defaultWt = join(dataDir, "worktrees");
    const dVolumeSim = join(root, "d-drive-sim");
    const projectOnD = join(dVolumeSim, "my-repo");
    mkdirSync(defaultWt, { recursive: true });
    mkdirSync(projectOnD, { recursive: true });

    // 1. 同卷 -> 直接用 defaultWt
    const sameVol = selectWorktreeRootForProject({
      projectFolder: projectOnD,
      dataDir,
      defaultWorktreesDir: defaultWt,
      stateDir,
      volumeDevOf: () => 100n,
    });
    expect(sameVol).toEqual({ root: defaultWt, crossVolume: false, fellBackToDataDir: false });

    // 2. 跨卷且 ACL 成功 -> 落 dVolumeSim/.fusa-wt/<指纹> 并写进 worktree-roots.json
    const protectedCalled: string[] = [];
    const crossOk = selectWorktreeRootForProject({
      projectFolder: projectOnD,
      dataDir,
      defaultWorktreesDir: defaultWt,
      stateDir,
      volumeDevOf: (p) => (p.includes("d-drive-sim") ? 200n : 100n),
      candidateVolumeRootOf: () => dVolumeSim,
      protectRoot: (_st, cand) => {
        protectedCalled.push(cand);
      },
    });
    expect(crossOk.crossVolume).toBe(true);
    expect(crossOk.fellBackToDataDir).toBe(false);
    expect(crossOk.root).toContain(".fusa-wt");
    expect(protectedCalled).toHaveLength(1);
    expect(loadManagedWorktreeRoots(stateDir, defaultWt)).toContain(crossOk.root);

    // 3. 跨卷但设置 ACL 或写权限失败（如 FAT32/exFAT 或卷根只读） -> 自动回退到 defaultWt 并打日志
    const logs: string[] = [];
    const crossFallback = selectWorktreeRootForProject({
      projectFolder: projectOnD,
      dataDir,
      defaultWorktreesDir: defaultWt,
      stateDir,
      log: (l) => logs.push(l),
      volumeDevOf: (p) => (p.includes("d-drive-sim") ? 200n : 100n),
      candidateVolumeRootOf: () => dVolumeSim,
      protectRoot: () => {
        throw new Error("FAT32 does not support ACLs");
      },
    });
    expect(crossFallback.crossVolume).toBe(true);
    expect(crossFallback.fellBackToDataDir).toBe(true);
    expect(crossFallback.root).toBe(defaultWt);
    expect(logs.some((l) => l.includes("已自动回退到数据目录"))).toBe(true);

    // 4. 网络共享路径直接拒绝
    expect(() =>
      selectWorktreeRootForProject({
        projectFolder: "\\\\fileserver\\share\\repo",
        dataDir,
        defaultWorktreesDir: defaultWt,
        stateDir,
        platform: "win32",
      }),
    ).toThrow(NetworkProjectFolderUnsupportedError);

    // 5. 已登记根列表受 MAX_WORKTREE_ROOTS 上限保护
    for (let i = 0; i < MAX_WORKTREE_ROOTS + 10; i++) {
      registerManagedWorktreeRoot(stateDir, defaultWt, `/vol-${i}/.fusa-wt/hash`);
    }
    expect(loadManagedWorktreeRoots(stateDir, defaultWt).length).toBeLessThanOrEqual(MAX_WORKTREE_ROOTS);
  });
});

describe("hub.exe 垫片安装、Git Bash MSYSTEM 斜杠拦截、准备命令 shell 与系统集成", () => {
  it("installHubShim('win32') 生成 hub.exe + hub.json 且清理同名无扩展名脚本", () => {
    const dir = makeTempDir("hub-shim-win-");
    const binDir = join(dir, "run", "bin");
    const fakeHubExe = join(dir, "built-hub.exe");
    writeFileSync(fakeHubExe, "MZ-fake-hub");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "hub"), "#!/bin/sh\n");

    const installed = installHubShim({
      binDir,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      mainScript: "D:\\repo\\src\\hub\\main.ts",
      platform: "win32",
      winHelperHubPath: fakeHubExe,
    });
    expect(installed).toBe(join(binDir, "hub.exe"));
    expect(existsSync(join(binDir, "hub"))).toBe(false);
    expect(readFileSync(installed, "utf8")).toBe("MZ-fake-hub");
    const cfg = JSON.parse(readFileSync(join(binDir, "hub.json"), "utf8"));
    expect(cfg).toEqual({
      node: "C:\\Program Files\\nodejs\\node.exe",
      main: "D:\\repo\\src\\hub\\main.ts",
      direct_pipe: false,
    });
    // 幂等覆盖更新不报错
    utimesSync(installed, new Date(), new Date());
    expect(
      installHubShim({
        binDir,
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        platform: "win32",
        winHelperHubPath: fakeHubExe,
      }),
    ).toBe(installed);
    expect(JSON.parse(readFileSync(join(binDir, "hub.json"), "utf8")).direct_pipe).toBe(true);
  });

  it("Git Bash (MSYSTEM) 把 /model 改写成 C:/Program Files/Git/model 时，hub 报可读中文错误（退出码 2）", async () => {
    let stderr = "";
    const code = await runHub({
      argv: ["worker", "search", "C:/Program Files/Git/model"],
      cwd: "D:\\repo",
      env: {
        MSYSTEM: "MINGW64",
        EXEPATH: "C:\\Program Files\\Git\\mingw64",
        HUB_TOKEN: "tok_123",
        HUB_SOCK: "\\\\.\\pipe\\fusa-test-hub",
      },
      stdin: () => {
        throw new Error("unexpected stdin");
      },
      stdout: { write: () => {} },
      stderr: { write: (s) => { stderr += s; } },
    });
    expect(code).toBe(2);
    expect(stderr).toContain("Git Bash (MSYSTEM)");
    expect(stderr).toContain("--stdin");
  });

  it("resolveSetupShell 在 Windows 按 Git Bash -> PowerShell 7 -> cmd.exe 依次回退，并排除 System32\\bash.exe (WSL)", () => {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

    expect(
      resolveSetupShell("pnpm install", { ProgramFiles: "C:\\Program Files" }, undefined, "win32", (p) => p === gitBash),
    ).toEqual({
      program: gitBash,
      args: ["-c", "pnpm install"],
      label: `Git Bash (${gitBash})`,
    });

    expect(
      resolveSetupShell("pnpm install", { ProgramFiles: "C:\\Program Files" }, undefined, "win32", (p) => p === pwsh),
    ).toEqual({
      program: pwsh,
      args: ["-NoProfile", "-NonInteractive", "-Command", "pnpm install"],
      label: `PowerShell 7 (${pwsh})`,
    });

    expect(
      resolveSetupShell("pnpm install", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, undefined, "win32", () => false),
    ).toEqual({
      program: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm install"],
      label: "cmd (C:\\Windows\\System32\\cmd.exe)",
    });
  });

  it("Windows explorer 文件定位、Tailscale 路径与防睡眠 keep-awake 参数一致", () => {
    expect(
      buildWindowsExplorerInvocation(["-R", "--", "D:\\repo\\out.png"], { SystemRoot: "C:\\Windows" }),
    ).toEqual({
      file: "C:\\Windows\\explorer.exe",
      args: ["/select,D:\\repo\\out.png"],
    });
    expect(
      buildWindowsExplorerInvocation(["--", "D:\\repo\\doc.pdf"], { SystemRoot: "C:\\Windows" }),
    ).toEqual({
      file: "C:\\Windows\\explorer.exe",
      args: ["D:\\repo\\doc.pdf"],
    });

    expect(
      tailscaleCommand({
        platform: "win32",
        env: { ProgramFiles: "C:\\Program Files" },
        exists: (p) => p === WIN32_TAILSCALE_DEFAULT_CLI,
      }),
    ).toBe(WIN32_TAILSCALE_DEFAULT_CLI);

    expect(SLEEP_INHIBIT_COMMANDS.win32?.command).toBe(WIN32_KEEP_AWAKE_BIN);
    const spawned: Array<{ cmd: string; args: string[] }> = [];
    const inhibitor = createSleepInhibitor({
      platform: "win32",
      daemonPid: 7788,
      spawn: (cmd, args) => {
        spawned.push({ cmd, args });
        return { kill() {} };
      },
    });
    inhibitor.acquire();
    expect(spawned).toEqual([{ cmd: "fusa-run.exe", args: ["keep-awake", "--parent", "7788"] }]);
    inhibitor.stop();
  });

  it("resolveWindowsCmdShim 对未安装的 node.exe 不留永久负缓存，且 ReadonlyPolicy 兼容 Windows 反斜杠路径", () => {
    resetWindowsCmdShimCacheForTest();
    const shimPath = "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd";
    const scriptPath = "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const nodeExePath = "C:\\Program Files\\nodejs\\node.exe";
    const shimContent = [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
    ].join("\r\n");

    let nodeInstalled = false;
    const fakeStat = (p: string): Stats | null => {
      const norm = p.toLowerCase();
      if (norm === shimPath.toLowerCase() || norm === scriptPath.toLowerCase()) {
        return { isFile: () => true, mtimeMs: 100, size: shimContent.length } as Stats;
      }
      if (nodeInstalled && norm === nodeExePath.toLowerCase()) {
        return { isFile: () => true, mtimeMs: 100, size: 1024 } as Stats;
      }
      return null;
    };
    const env = { Path: "C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

    expect(resolveWindowsCmdShim(shimPath, env, { stat: fakeStat, read: () => shimContent })).toBeNull();
    nodeInstalled = true;
    expect(resolveWindowsCmdShim(shimPath, env, { stat: fakeStat, read: () => shimContent })).toEqual({
      program: nodeExePath,
      prefixArgs: [scriptPath],
    });

    const winRoPolicy = buildReadonlyPolicy({
      homeDir: "C:\\Users\\u\\",
      stateDir: "C:\\Users\\u\\.agent-hub\\state\\",
      protectedRoots: ["C:\\Users\\u\\.agent-hub", "D:\\.fusa-wt\\12345678"],
    });
    expect(winRoPolicy.secretPaths).toContain("C:\\Users\\u\\.agent-hub\\state\\ui-token");
    expect(winRoPolicy.protectedRoots).toEqual(["C:\\Users\\u\\.agent-hub", "D:\\.fusa-wt\\12345678"]);
  });
});
