import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse as parsePath } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FUSA_MANAGED_COPY_MARKER,
  createDirectoryLinkOrManagedCopySync,
  normalizePathForComparison,
  queryWin32WhoLocks,
  removeTreeWithRetry,
  writeFileAtomicSyncWithRetry,
} from "../../src/daemon/platform/index.ts";
import { scopeAllowsWrite, workerWriteScope } from "../../src/shared/index.ts";
import { writeDiagLog } from "./diag-helper.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch (err) {
      writeDiagLog("paths-locks-cleanup", String(err));
    }
  }
});

function pickFreeSubstDrive(): string | null {
  for (const letter of ["Z:", "Y:", "X:", "W:"]) {
    if (!existsSync(`${letter}\\`)) return letter;
  }
  return null;
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

describe.runIf(process.platform === "win32")("Windows 真机集成：盘符/8.3短名/subst/UNC、原子写重试与 who-locks 锁释放重删", () => {
  it("盘符大小写、正反斜杠、\\\\?\\、8.3 短名与 subst 盘经 realpath.native 还原一致；UNC 管理共享拒绝 junction 并自动走受控复制", { timeout: 30_000 }, async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-win-paths-")));
    cleanups.push(() => removeTreeWithRetry(root));

    const dataDir = join(root, "AgentHubData");
    const wtDir = join(dataDir, "worktrees", "1", "9");
    const longDir = join(wtDir, "LongDirectoryNameForShortTest");
    mkdirSync(longDir, { recursive: true });
    const sampleFile = join(longDir, "VeryLongFileNameSample.txt");
    writeFileSync(sampleFile, "hello");

    const scope = workerWriteScope({ role: "worker", dataDir, cwd: wtDir })!;
    expect(scopeAllowsWrite(scope, sampleFile.toLowerCase())).toBe(true);
    expect(scopeAllowsWrite(scope, sampleFile.toUpperCase().replace(/\\/g, "/"))).toBe(true);
    expect(scopeAllowsWrite(scope, `\\\\?\\${sampleFile}`)).toBe(true);

    // 8.3 短名（若所在卷开启了 8dot3name，cmd %~sI 返回短名，realpathSync.native 必须还原回完整长路径）
    const shortOut = execFileSync("cmd.exe", ["/d", "/c", `for %I in ("${sampleFile}") do @echo %~sI`], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (shortOut && existsSync(shortOut)) {
      expect(normalizePathForComparison(realpathSync.native(shortOut))).toBe(
        normalizePathForComparison(sampleFile),
      );
    }

    // subst 虚拟盘：realpathSync.native 还原回底层真实路径
    const substDrive = pickFreeSubstDrive();
    if (substDrive !== null) {
      execFileSync("subst.exe", [substDrive, wtDir], { windowsHide: true });
      cleanups.push(() => {
        try {
          execFileSync("subst.exe", [substDrive, "/d"], { windowsHide: true });
        } catch {
          // Ignore
        }
      });
      const viaSubst = `${substDrive}\\LongDirectoryNameForShortTest\\VeryLongFileNameSample.txt`;
      const unwrapped = realpathSync.native(viaSubst);
      expect(normalizePathForComparison(unwrapped)).toBe(normalizePathForComparison(sampleFile));
      expect(scopeAllowsWrite(scope, unwrapped)).toBe(true);
    }

    // UNC 本机管理共享（\\127.0.0.1\<Drive>$\...）：junction 拒绝网络路径并自动走 .fusa-managed 受控复制
    const driveLetter = parsePath(root).root.slice(0, 1).toUpperCase();
    const relFromRoot = root.slice(parsePath(root).root.length);
    const canonicalSkill = join(root, "canonical-skills", "demo-skill");
    mkdirSync(canonicalSkill, { recursive: true });
    writeFileSync(join(canonicalSkill, "SKILL.md"), "# Demo Skill\n");

    const uncSkill = `\\\\127.0.0.1\\${driveLetter}$\\${relFromRoot}\\canonical-skills\\demo-skill`;
    if (existsSync(uncSkill)) {
      const targetSkill = join(root, "synced-skills", "demo-skill");
      const mode = createDirectoryLinkOrManagedCopySync(uncSkill, targetSkill, { platform: "win32" });
      expect(mode).toBe("managed_copy");
      expect(lstatSync(targetSkill).isSymbolicLink()).toBe(false);
      expect(existsSync(join(targetSkill, FUSA_MANAGED_COPY_MARKER))).toBe(true);
      expect(readFileSync(join(targetSkill, "SKILL.md"), "utf8")).toBe("# Demo Skill\n");
    }
  });

  it("子进程不带 FILE_SHARE_DELETE 短暂独占打开文件：writeFileAtomic 重试成功；删目录遇锁用 who-locks 报出持有进程并在关闭后成功删除", { timeout: 30_000 }, async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-win-locks-")));
    cleanups.push(() => removeTreeWithRetry(root));

    // 1. 子进程不带 FILE_SHARE_DELETE 打开 config.json 200ms，包了重试的 writeFileAtomicSyncWithRetry 成功替换
    const configFile = join(root, "config.json");
    writeFileSync(configFile, '{"v":1}\n');
    const lockReady1 = join(root, "ready1");
    const locker1 = spawn(
      "pwsh.exe",
      [
        "-NoProfile",
        "-Command",
        `$fs = [System.IO.File]::Open('${configFile.replaceAll("'", "''")}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); Set-Content -LiteralPath '${lockReady1.replaceAll("'", "''")}' -Value '1'; Start-Sleep -Milliseconds 150; $fs.Close()`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    cleanups.push(() => {
      locker1.kill();
    });
    const deadline1 = Date.now() + 8_000;
    while (!existsSync(lockReady1) && Date.now() < deadline1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    writeFileAtomicSyncWithRetry(configFile, '{"v":2}\n', { platform: "win32" });
    await waitForChildExit(locker1);
    expect(readFileSync(configFile, "utf8")).toBe('{"v":2}\n');

    // 2. 子进程锁住 worktree 内文件：Restart Manager (who-locks) 准确报出持有者 PID，释放后整遍重删成功
    const wtDir = join(root, "locked-wt");
    mkdirSync(wtDir, { recursive: true });
    const heldFile = join(wtDir, "held.dll");
    writeFileSync(heldFile, "locked-bytes");
    const lockReady2 = join(root, "ready2");
    const releaseFlag = join(root, "release2");

    const locker2 = spawn(
      "pwsh.exe",
      [
        "-NoProfile",
        "-Command",
        `$fs = [System.IO.File]::Open('${heldFile.replaceAll("'", "''")}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); Set-Content -LiteralPath '${lockReady2.replaceAll("'", "''")}' -Value '1'; while (-not (Test-Path -LiteralPath '${releaseFlag.replaceAll("'", "''")}')) { Start-Sleep -Milliseconds 50 }; $fs.Close()`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    cleanups.push(() => {
      writeFileSync(releaseFlag, "1");
      locker2.kill();
    });

    const deadline2 = Date.now() + 8_000;
    while (!existsSync(lockReady2) && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const holders = queryWin32WhoLocks(wtDir);
    expect(holders.some((h) => h.pid === locker2.pid)).toBe(true);

    // 持续占用时短预算删除失败，错误消息里带出持有进程 PID
    await expect(
      removeTreeWithRetry(wtDir, { platform: "win32", passDelaysMs: [20, 40] }),
    ).rejects.toThrow(`PID ${locker2.pid}`);

    // 300ms 后释放句柄，removeTreeWithRetry 在下一遍重试成功删净
    setTimeout(() => {
      writeFileSync(releaseFlag, "1");
    }, 300);
    await removeTreeWithRetry(wtDir, { platform: "win32" });
    expect(existsSync(wtDir)).toBe(false);
    await waitForChildExit(locker2);
  });
});
