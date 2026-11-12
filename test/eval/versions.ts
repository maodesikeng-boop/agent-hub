// 被测版本就是一个 git 引用（设计第 6 节）：守护进程从那个提交的源码起。用 git archive 导出到评测目录（不在真仓库里建 worktree、
// 不动它的 .git），按提交号缓存；依赖和当前仓库一样时软链当前的 node_modules，不一样时离线装一份。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_KEEP_VERSIONS } from "./limits.ts";

export interface PreparedVersion {
  label: string;
  ref: string;
  commit: string;
  /** 提交的第一行，打印时让人一眼认出是哪一版。 */
  subject: string;
  dir: string;
  daemonMain: string;
}

const gitOut = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

export function resolveRef(repo: string, ref: string): { commit: string; subject: string } {
  const commit = gitOut(repo, "rev-parse", "--verify", `${ref}^{commit}`);
  return { commit, subject: gitOut(repo, "log", "-1", "--format=%s", commit) };
}

export function prepareVersion(sourceRepo: string, versionsDir: string, label: string, ref: string, log: (line: string) => void): PreparedVersion {
  const { commit, subject } = resolveRef(sourceRepo, ref);
  const dir = join(versionsDir, commit.slice(0, 12));
  const ready = join(dir, ".eval-ready");
  if (existsSync(ready)) {
    const now = new Date();
    utimesSync(dir, now, now);
    log(`${label}：${ref} = ${commit.slice(0, 9)}（${subject}），用缓存的源码 ${dir}`);
    return { label, ref, commit, subject, dir, daemonMain: join(dir, "src", "daemon", "main.ts") };
  }
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  log(`${label}：${ref} = ${commit.slice(0, 9)}（${subject}），导出源码到 ${dir}`);
  const archive = spawnSync("git", ["-C", sourceRepo, "archive", "--format=tar", commit], { maxBuffer: 1024 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive ${commit} 失败：${archive.stderr?.toString()}`);
  const untar = spawnSync("tar", ["-x", "-C", tmp], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`解压 ${commit} 失败：${untar.stderr?.toString()}`);
  const lockHere = join(sourceRepo, "pnpm-lock.yaml");
  const sameDeps = existsSync(lockHere) && existsSync(join(sourceRepo, "node_modules")) && readFileSync(join(tmp, "pnpm-lock.yaml"), "utf8") === readFileSync(lockHere, "utf8");
  if (sameDeps) {
    symlinkSync(join(sourceRepo, "node_modules"), join(tmp, "node_modules"));
  } else {
    log(`${label}：依赖和当前仓库不一样，离线装一份（pnpm install --offline）`);
    const install = spawnSync("pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"], { cwd: tmp, stdio: "inherit" });
    if (install.status !== 0) throw new Error(`${label} 的依赖装不上；先在仓库里跑一次 pnpm fetch 再试`);
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  writeFileSync(ready, `${commit}\n`);
  return { label, ref, commit, subject, dir, daemonMain: join(dir, "src", "daemon", "main.ts") };
}

/** 被测版本的源码最多留 EVAL_KEEP_VERSIONS 份，按最近用过的时间留；正在用的（keep）不删。 */
export function pruneVersions(versionsDir: string, keep: readonly string[]): string[] {
  if (!existsSync(versionsDir)) return [];
  const entries = readdirSync(versionsDir)
    .map((name) => ({ name, path: join(versionsDir, name), mtime: statSync(join(versionsDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  for (const [i, e] of entries.entries()) {
    if (keep.includes(e.path) || (i < EVAL_KEEP_VERSIONS && !e.name.includes(".tmp-"))) continue;
    rmSync(e.path, { recursive: true, force: true });
    removed.push(e.path);
  }
  return removed;
}
