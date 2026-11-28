// Windows real-OS tests for @microsoft/mxc-sdk ProcessContainer probing, fail-closed rejection without MXC, and live Win11 24H2+ containers.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetOsSandboxCacheForTest,
  wrapInReadonlyOsSandbox,
} from "../../src/daemon/driver/write-scope.ts";
import {
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

describe.skipIf(!isWin32)("Windows 真机：@microsoft/mxc-sdk 探测、无 MXC 失败关闭与 Win11 24H2+ 真容器", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    resetOsSandboxCacheForTest();
    resetVerifiedProtectedRootsForTest();
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it("实跑 @microsoft/mxc-sdk 原生探测并遵守短暂负缓存 TTL；不支持 ProcessContainer 时严格失败关闭", async () => {
    let now = 100_000;
    const first = probeWin32MxcSupport({ forceRefresh: true, now: () => now });
    console.info(
      `[mxc-readonly] host probe: available=${first.available} reason=${first.reason} tier=${first.tier ?? "none"} detail=${first.detail ?? "ok"}`,
    );
    expect(getLastWin32MxcSupportStatus()).toEqual(first);
    expect(WIN_MXC_NEGATIVE_CACHE_TTL_MS).toBeGreaterThan(0);
    expect(WIN_MXC_NEGATIVE_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);

    if (!first.available) {
      now += WIN_MXC_NEGATIVE_CACHE_TTL_MS - 10;
      const cached = probeWin32MxcSupport({ now: () => now });
      expect(cached.checkedAt).toBe(100_000);

      now += 20;
      const refreshed = probeWin32MxcSupport({ now: () => now });
      expect(refreshed.checkedAt).toBe(now);

      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-win-mxc-closed-")));
      cleanups.push(() => removeTreeWithRetry(root));

      const dataDir = join(root, "hub-data");
      const stateDir = join(dataDir, "state");
      const privateTmp = join(root, "ro-tmp");
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(privateTmp, { recursive: true });

      const policy = buildReadonlyPolicy({
        homeDir: realpathSync.native(homedir()),
        stateDir,
        protectedRoots: [dataDir],
      });

      const base = { command: process.execPath, args: ["-e", "process.exit(0)"] };
      const wrapped = wrapInReadonlyOsSandbox(
        base,
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

      expect(wrapped).toEqual({ ...base, osSandboxed: false });
      expect(wrapped.readonlyMode).toBeUndefined();
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
