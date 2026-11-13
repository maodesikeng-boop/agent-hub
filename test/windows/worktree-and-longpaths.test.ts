import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse as parsePath } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addWorktree, pruneWorktrees, removeWorktree } from "../../src/daemon/git/index.ts";
import {
  allowWin32WorkerWorktreeAcl,
  ensureWin32ProtectedRootAcl,
  removeTreeWithRetry,
  resolveSpawn,
  selectWorktreeRootForProject,
} from "../../src/daemon/platform/index.ts";
import { findExecutable } from "../../src/shared/paths.ts";
import { writeDiagLog } from "./diag-helper.ts";

const cleanupCallbacks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    const fn = cleanupCallbacks.pop()!;
    try {
      await fn();
    } catch (err) {
      writeDiagLog("worktree-cleanup", String(err));
    }
  }
});

function resolveSecondVolumeRoot(): string | null {
  const fromEnv = process.env.FUSA_CI_SECOND_VOLUME?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const cDrive = parsePath(tmpdir()).root.toUpperCase();
  for (const letter of ["D:\\", "E:\\", "V:\\"]) {
    if (letter !== cDrive && existsSync(letter)) {
      try {
        if (statSync(letter, { bigint: true }).dev !== statSync(tmpdir(), { bigint: true }).dev) {
          return letter;
        }
      } catch {
        // Skip inaccessible drive
      }
    }
  }
  return null;
}

function initTempGitRepo(repoDir: string): void {
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["-C", repoDir, "init", "-b", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Fusa CI"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "ci@fusa.local"], { stdio: "ignore" });
  writeFileSync(join(repoDir, "README.md"), "# Test Repo\n");
  execFileSync("git", ["-C", repoDir, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "commit", "-m", "init"], { stdio: "ignore" });
}

describe.runIf(process.platform === "win32")("Windows 真机集成：跨盘同卷 .fusa-wt、pnpm 硬链接与超 260 长路径", () => {
  it("项目在 D 盘、数据目录在 C 盘时默认选 D:\\.fusa-wt\\<指纹>；无权限时回退 C 盘；pnpm 硬链接 nlink > 1；长路径 > 280 可建可删", { timeout: 60_000 }, async () => {
    const secondVol = resolveSecondVolumeRoot();
    expect(secondVol, "Windows CI 应具备与系统盘不同的第二个 NTFS 卷（如 D:\\）").not.toBeNull();
    const volRoot = secondVol!;

    const cDataDir = realpathSync.native(mkdtempSync(join(tmpdir(), "fusa-c-data-")));
    cleanupCallbacks.push(() => removeTreeWithRetry(cDataDir));
    const stateDir = join(cDataDir, "state");
    const defaultWtDir = join(cDataDir, "worktrees");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(defaultWtDir, { recursive: true });

    const dBaseDir = mkdtempSync(join(volRoot, "fusa-d-proj-"));
    cleanupCallbacks.push(() => removeTreeWithRetry(dBaseDir));
    const repoDir = join(dBaseDir, "repo");
    initTempGitRepo(repoDir);

    // 1. 跨卷自动选同卷 D:\.fusa-wt\<指纹>
    const selected = selectWorktreeRootForProject({
      projectFolder: repoDir,
      dataDir: cDataDir,
      defaultWorktreesDir: defaultWtDir,
      stateDir,
    });
    cleanupCallbacks.push(() => removeTreeWithRetry(selected.root));
    expect(selected.crossVolume).toBe(true);
    expect(selected.fellBackToDataDir).toBe(false);
    expect(parsePath(selected.root).root.toUpperCase()).toBe(parsePath(volRoot).root.toUpperCase());
    expect(selected.root.toLowerCase()).toContain(".fusa-wt");

    // 2. 先建空目录设 ACL 再 git worktree add
    const wtPath = join(selected.root, "1", "524");
    const addRes = await addWorktree({
      repoFolder: repoDir,
      worktreePath: wtPath,
      branch: "hub/524-win-wt",
      prepareDir: (dir) => {
        mkdirSync(dir, { recursive: true });
        ensureWin32ProtectedRootAcl(stateDir, cDataDir);
        allowWin32WorkerWorktreeAcl(stateDir, "524", dir);
      },
    });
    expect(addRes.created).toBe(true);
    expect(readFileSync(join(wtPath, "README.md"), "utf8")).toContain("Test Repo");

    // 3. 在同卷 worktree 内执行真实 pnpm install（使用本地包与同卷 store-dir，零外网抖动）验证硬链接 nlink > 1
    const localPkgDir = join(dBaseDir, "local-pkg");
    const storeDir = join(dBaseDir, ".pnpm-store");
    mkdirSync(localPkgDir, { recursive: true });
    writeFileSync(
      join(localPkgDir, "package.json"),
      JSON.stringify({ name: "fusa-local-dep", version: "1.0.0", main: "index.js" }, null, 2),
    );
    writeFileSync(join(localPkgDir, "index.js"), "module.exports = { ok: true };\n");
    const envPath = process.env.PATH ?? process.env.Path ?? "";
    const npmBin = findExecutable("npm", envPath, [], { platform: "win32" }) ?? "npm.cmd";
    const npmSpawn = resolveSpawn({ program: npmBin, args: ["pack", "--quiet"], cwd: localPkgDir }, "win32");
    const packOut = spawnSync(npmSpawn.file, npmSpawn.args, {
      ...npmSpawn.options,
      encoding: "utf8",
    });
    expect(packOut.status, packOut.stderr).toBe(0);
    const tgzName = packOut.stdout.trim().split(/\r?\n/).at(-1)!.trim();
    const tgzPath = join(localPkgDir, tgzName);

    writeFileSync(
      join(wtPath, "package.json"),
      JSON.stringify(
        {
          name: "wt-consumer",
          version: "1.0.0",
          dependencies: { "fusa-local-dep": `file:${tgzPath.replace(/\\/g, "/")}` },
        },
        null,
        2,
      ),
    );
    const pnpmBin = findExecutable("pnpm", envPath, [], { platform: "win32" }) ?? "pnpm.cmd";
    const pnpmSpawn = resolveSpawn(
      {
        program: pnpmBin,
        args: ["install", `--store-dir=${storeDir}`, "--no-frozen-lockfile", "--package-import-method=hardlink"],
        cwd: wtPath,
      },
      "win32",
    );
    const installOut = spawnSync(pnpmSpawn.file, pnpmSpawn.args, {
      ...pnpmSpawn.options,
      encoding: "utf8",
    });
    expect(installOut.status, installOut.stderr).toBe(0);
    const installedFile = join(wtPath, "node_modules", "fusa-local-dep", "index.js");
    expect(existsSync(installedFile)).toBe(true);
    expect(statSync(installedFile).nlink).toBeGreaterThan(1);

    // 4. 超过 260 字符的超长嵌套路径创建、git status 与删除
    const seg = "deep_nested_segment_0123456789abcdef";
    const deepDir = join(wtPath, seg, seg, seg, seg, seg, seg, seg, seg);
    const deepFile = join(deepDir, "ultra_long_filename_exceeding_max_path_260.txt");
    expect(deepFile.length).toBeGreaterThan(280);
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(deepFile, "long-path-ok\n");
    expect(readFileSync(deepFile, "utf8")).toBe("long-path-ok\n");
    rmSync(join(wtPath, seg), { recursive: true, force: true });
    rmSync(join(wtPath, "node_modules"), { recursive: true, force: true });
    rmSync(join(wtPath, "package.json"), { force: true });
    rmSync(join(wtPath, "pnpm-lock.yaml"), { force: true });

    await removeWorktree(repoDir, wtPath);
    await pruneWorktrees(repoDir);
    expect(existsSync(wtPath)).toBe(false);

    // 5. 当同卷受保护根无法设 ACL 时自动回退到 C 盘默认 worktrees 目录
    const fallbackLogs: string[] = [];
    const fallback = selectWorktreeRootForProject({
      projectFolder: repoDir,
      dataDir: cDataDir,
      defaultWorktreesDir: defaultWtDir,
      stateDir,
      log: (l) => fallbackLogs.push(l),
      protectRoot: () => {
        throw new Error("simulated ACL denied on volume root");
      },
    });
    expect(fallback.fellBackToDataDir).toBe(true);
    expect(fallback.root).toBe(defaultWtDir);
    expect(fallbackLogs.some((l) => l.includes("已自动回退到数据目录"))).toBe(true);

    const cWtPath = join(fallback.root, "1", "525");
    const cAdd = await addWorktree({ repoFolder: repoDir, worktreePath: cWtPath, branch: "hub/525-fallback-c" });
    expect(cAdd.created).toBe(true);
    await removeWorktree(repoDir, cWtPath);
  });
});
