// Windows 真机专项测试：微软官方 `@microsoft/mxc-sdk` ProcessContainer 只读沙箱探测、真容器执行与低版本/Server 自动回退。
// 规则（docs/windows-native-design.md 第 8 节第 4 条）：
// 1. 实跑 `@microsoft/mxc-sdk/v1` 原生探测（无 mock），校验负缓存短暂 TTL 与结构化状态；
// 2. 若当前机器（如 Windows Server CI runner）不支持无 DACL 污染的 ProcessContainer，
//    真容器用例显式标 `it.skip`（汇总中可见“未覆盖”，留待 Win11 24H2+ 真机验收），绝不伪装通过；
// 3. 同时在同一台无 MXC 机器上，不注入任何 mock 直接调用 `wrapInReadonlyOsSandbox`，
//    实跑断言自动平滑回退到「写受限令牌 + 受保护根拒写 ACL + 降级提示」且进程正常执行返回 0，绝不硬拒报错！
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WIN32_READONLY_FALLBACK_WARNING,
  resetOsSandboxCacheForTest,
  wrapInReadonlyOsSandbox,
} from "../../src/daemon/driver/write-scope.ts";
import {
  allowWin32WorkerWorktreeAcl,
  ensureWin32ProtectedRootAcl,
  getLastWin32MxcSupportStatus,
  probeWin32MxcSupport,
  removeTreeWithRetry,
  resetVerifiedProtectedRootsForTest,
} from "../../src/daemon/platform/index.ts";
import { WIN_MXC_NEGATIVE_CACHE_TTL_MS } from "../../src/shared/limits.ts";
import { buildReadonlyPolicy } from "../../src/shared/readonly-policy.ts";

const isWin32 = process.platform === "win32";
const initialMxcProbe = isWin32
  ? probeWin32MxcSupport({ forceRefresh: true })
  : { available: false, reason: "non_win32" as const, warnings: [], nodeVersion: process.versions.node, checkedAt: 0 };

describe.skipIf(!isWin32)("Windows 真机：@microsoft/mxc-sdk 探测、自动平滑回退与 Win11 24H2+ 真容器", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    resetOsSandboxCacheForTest();
    resetVerifiedProtectedRootsForTest();
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it("实跑 @microsoft/mxc-sdk 原生探测并遵守短暂负缓存 TTL；不支持 ProcessContainer 时无 mock 自动平滑回退且正常执行", () => {
    let now = 100_000;
    const first = probeWin32MxcSupport({ forceRefresh: true, now: () => now });
    console.info(
      `[mxc-readonly] host probe: available=${first.available} reason=${first.reason} tier=${first.tier ?? "none"} detail=${first.detail ?? "ok"}`,
    );
    expect(getLastWin32MxcSupportStatus()).toEqual(first);
    expect(WIN_MXC_NEGATIVE_CACHE_TTL_MS).toBeGreaterThan(0);
    expect(WIN_MXC_NEGATIVE_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);

    if (!first.available) {
      // 负缓存 TTL 内命中同一时间戳快照；超过 WIN_MXC_NEGATIVE_CACHE_TTL_MS 后重新探测，更新 checkedAt
      now += WIN_MXC_NEGATIVE_CACHE_TTL_MS - 10;
      const cached = probeWin32MxcSupport({ now: () => now });
      expect(cached.checkedAt).toBe(100_000);

      now += 20;
      const refreshed = probeWin32MxcSupport({ now: () => now });
      expect(refreshed.checkedAt).toBe(now);

      // 在不支持 MXC 的真实机器上（无任何 mock 注入）直接调用 wrapInReadonlyOsSandbox：必须平滑回退且实跑生效！
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-win-mxc-fb-")));
      cleanups.push(() => removeTreeWithRetry(root));

      const dataDir = join(root, "hub-data");
      const stateDir = join(dataDir, "state");
      const wtDir = join(dataDir, "worktrees", "1", "701");
      const privateTmp = join(root, "ro-tmp");
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(wtDir, { recursive: true });
      mkdirSync(privateTmp, { recursive: true });
      writeFileSync(join(wtDir, "readme.txt"), "READ_OK");

      ensureWin32ProtectedRootAcl(stateDir, dataDir);
      allowWin32WorkerWorktreeAcl(stateDir, "701", wtDir);

      const policy = buildReadonlyPolicy({
        homeDir: realpathSync.native(homedir()),
        stateDir,
        protectedRoots: [dataDir],
      });

      const wrapped = wrapInReadonlyOsSandbox(
        {
          command: process.execPath,
          args: [
            "-e",
            `
const fs = require("node:fs");
let stateWriteDenied = false;
let worktreeWriteDenied = false;
try { fs.writeFileSync(${JSON.stringify(join(stateDir, "tamper.txt"))}, "x"); } catch { stateWriteDenied = true; }
try { fs.writeFileSync(${JSON.stringify(join(wtDir, "tamper.txt"))}, "x"); } catch { worktreeWriteDenied = true; }
const readText = fs.readFileSync(${JSON.stringify(join(wtDir, "readme.txt"))}, "utf8");
fs.writeFileSync(${JSON.stringify(join(privateTmp, "probe.json"))}, JSON.stringify({ stateWriteDenied, worktreeWriteDenied, readText }));
`,
          ],
        },
        {
          tmpDir: privateTmp,
          stateDir,
          protectedRoots: policy.protectedRoots,
          writableDirs: [],
          writableFileRegexes: [],
          secretPaths: policy.secretPaths,
          secretGlobs: policy.secretGlobs,
        },
        "win32",
      );

      expect(wrapped.osSandboxed).toBe(true);
      expect(wrapped.readonlyMode).toBe("fallback_write_restricted");
      expect(wrapped.readonlyFallbackWarning).toBe(WIN32_READONLY_FALLBACK_WARNING);

      const res = spawnSync(wrapped.command, wrapped.args, {
        cwd: wtDir,
        env: { ...process.env, TEMP: privateTmp, TMP: privateTmp, TMPDIR: privateTmp },
        encoding: "utf8",
        windowsHide: true,
      });
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(privateTmp, "probe.json"), "utf8"))).toEqual({
        stateWriteDenied: true,
        worktreeWriteDenied: true,
        readText: "READ_OK",
      });
    }
  });

  it.skipIf(!initialMxcProbe.available)(
    "Win11 24H2+ MXC ProcessContainer 真容器只读隔离（待支持 ProcessContainer 的 Win11 24H2+ 真机验收）",
    () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-win-mxc-live-")));
      cleanups.push(() => removeTreeWithRetry(root));

      const dataDir = join(root, "hub-data");
      const stateDir = join(dataDir, "state");
      const wtDir = join(dataDir, "worktrees", "1", "702");
      const privateTmp = join(root, "ro-tmp");
      const secretFile = join(wtDir, ".env");
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(wtDir, { recursive: true });
      mkdirSync(privateTmp, { recursive: true });
      writeFileSync(join(wtDir, "code.txt"), "VISIBLE_CODE");
      writeFileSync(secretFile, "SECRET_TOKEN=top_secret");
      writeFileSync(join(stateDir, "ui-token"), "ui_secret_token_123456");

      const policy = buildReadonlyPolicy({
        homeDir: realpathSync.native(homedir()),
        stateDir,
        protectedRoots: [dataDir],
      });

      const wrapped = wrapInReadonlyOsSandbox(
        {
          command: process.execPath,
          args: [
            "-e",
            `
const fs = require("node:fs");
let wtWriteBlocked = false;
let stateWriteBlocked = false;
let secretReadBlocked = false;
try { fs.writeFileSync(${JSON.stringify(join(wtDir, "write.txt"))}, "x"); } catch { wtWriteBlocked = true; }
try { fs.writeFileSync(${JSON.stringify(join(stateDir, "write.txt"))}, "x"); } catch { stateWriteBlocked = true; }
try { fs.readFileSync(${JSON.stringify(secretFile)}, "utf8"); } catch { secretReadBlocked = true; }
const code = fs.readFileSync(${JSON.stringify(join(wtDir, "code.txt"))}, "utf8");
fs.writeFileSync(${JSON.stringify(join(privateTmp, "live-mxc.json"))}, JSON.stringify({ wtWriteBlocked, stateWriteBlocked, secretReadBlocked, code }));
`,
          ],
        },
        {
          tmpDir: privateTmp,
          stateDir,
          protectedRoots: [dataDir],
          writableDirs: [],
          writableFileRegexes: [],
          secretPaths: [...policy.secretPaths, secretFile],
          secretGlobs: policy.secretGlobs,
        },
        "win32",
      );

      expect(wrapped.osSandboxed).toBe(true);
      expect(wrapped.readonlyMode).toBe("mxc");
      expect(wrapped.readonlyFallbackWarning).toBeUndefined();

      const res = spawnSync(wrapped.command, wrapped.args, {
        cwd: wtDir,
        env: { ...process.env, TEMP: privateTmp, TMP: privateTmp, TMPDIR: privateTmp },
        encoding: "utf8",
        windowsHide: true,
      });
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(privateTmp, "live-mxc.json"), "utf8"))).toEqual({
        wtWriteBlocked: true,
        stateWriteBlocked: true,
        secretReadBlocked: true,
        code: "VISIBLE_CODE",
      });
    },
  );
});
