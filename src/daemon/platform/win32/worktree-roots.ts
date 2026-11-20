import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse as parseHostPath, posix, resolve, win32 } from "node:path";
import { MAX_WORKTREE_ROOTS } from "../../../shared/limits.ts";
import { LOG_PREFIX } from "../../../shared/names.ts";
import { ensureWin32ProtectedRootAcl } from "./acl.ts";
import { renameSyncWithWindowsRetry, unlinkDirectoryLinkSync } from "./fs-safe.ts";
import { isUncNetworkPath, normalizePathForComparison } from "./path-key.ts";

export const WORKTREE_ROOTS_REGISTRY_FILE = "worktree-roots.json";
export const SAME_VOLUME_WT_DIR_NAME = ".fusa-wt";

export class NetworkProjectFolderUnsupportedError extends Error {
  constructor(folder: string) {
    super(`项目文件夹位于网络共享路径（${folder}），不支持创建本机隔离 worktree，请将项目复制到本机磁盘（如 C:\\ 或 D:\\）`);
    this.name = "NetworkProjectFolderUnsupportedError";
  }
}

export function worktreeRootsFile(stateDir: string): string {
  return join(stateDir, WORKTREE_ROOTS_REGISTRY_FILE);
}

export function dataDirWorktreeFingerprint(dataDir: string): string {
  return createHash("sha256")
    .update(normalizePathForComparison(dataDir))
    .digest("hex")
    .slice(0, 8);
}

export function loadManagedWorktreeRoots(stateDir: string, defaultWorktreesDir: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    if (!p || p.trim() === "") return;
    const key = normalizePathForComparison(p);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  };
  add(defaultWorktreesDir);
  try {
    const raw = JSON.parse(readFileSync(worktreeRootsFile(stateDir), "utf8")) as { roots?: unknown };
    if (Array.isArray(raw.roots)) {
      for (const item of raw.roots) {
        if (typeof item === "string") add(item);
      }
    }
  } catch {
  }
  return out.slice(0, MAX_WORKTREE_ROOTS);
}

export function registerManagedWorktreeRoot(
  stateDir: string,
  defaultWorktreesDir: string,
  newRoot: string,
): string[] {
  const current = loadManagedWorktreeRoots(stateDir, defaultWorktreesDir);
  const newKey = normalizePathForComparison(newRoot);
  if (current.some((r) => normalizePathForComparison(r) === newKey)) {
    return current;
  }
  const next = [...current, newRoot].slice(-MAX_WORKTREE_ROOTS);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = worktreeRootsFile(stateDir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, roots: next }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    renameSyncWithWindowsRetry(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return next;
}

function extractVolumeRoot(realProjectFolder: string, platform: NodeJS.Platform): string {
  if (platform === "win32" || /^[A-Za-z]:[\\/]/.test(realProjectFolder)) {
    const parsed = win32.parse(realProjectFolder);
    return parsed.root || `${realProjectFolder.slice(0, 2)}\\`;
  }
  const parsed = parseHostPath(realProjectFolder);
  return parsed.root || posix.sep;
}

export interface SelectedWorktreeRoot {
  root: string;
  crossVolume: boolean;
  fellBackToDataDir: boolean;
  fallbackReason?: string;
}

/** UNC and mapped network shares are rejected; cross-volume projects get worktrees under <volume>\.fusa-wt so git worktree stays on one volume. */
export async function selectWorktreeRootForProject(input: {
  projectFolder: string;
  dataDir: string;
  defaultWorktreesDir: string;
  stateDir: string;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
  volumeDevOf?: (realPath: string) => number | bigint;
  candidateVolumeRootOf?: (realProjectFolder: string) => string;
  protectRoot?: (stateDir: string, candidateRoot: string) => Promise<void> | void;
}): Promise<SelectedWorktreeRoot> {
  const platform = input.platform ?? process.platform;
  if (isUncNetworkPath(input.projectFolder)) {
    throw new NetworkProjectFolderUnsupportedError(input.projectFolder);
  }
  const realProject = existsSync(input.projectFolder)
    ? realpathSync.native(input.projectFolder)
    : resolve(input.projectFolder);
  if (isUncNetworkPath(realProject)) {
    throw new NetworkProjectFolderUnsupportedError(realProject);
  }
  const realDataDir = existsSync(input.dataDir)
    ? realpathSync.native(input.dataDir)
    : resolve(input.dataDir);

  const devOf = input.volumeDevOf ?? ((p: string) => statSync(p, { bigint: true }).dev);
  const dataDev = devOf(realDataDir);
  const projectDev = devOf(realProject);

  if (dataDev === projectDev) {
    return {
      root: input.defaultWorktreesDir,
      crossVolume: false,
      fellBackToDataDir: false,
    };
  }

  const volRoot = input.candidateVolumeRootOf
    ? input.candidateVolumeRootOf(realProject)
    : extractVolumeRoot(realProject, platform);
  const joinFn = platform === "win32" || /^[A-Za-z]:[\\/]/.test(volRoot) ? win32.join : join;
  const candidate = joinFn(
    volRoot,
    SAME_VOLUME_WT_DIR_NAME,
    dataDirWorktreeFingerprint(realDataDir),
  );

  try {
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    const probeFile = joinFn(candidate, `.probe-${process.pid}-${randomBytes(4).toString("hex")}`);
    writeFileSync(probeFile, "ok", { encoding: "utf8", mode: 0o600 });
    rmSync(probeFile, { force: true });

    if (input.protectRoot) {
      await input.protectRoot(input.stateDir, candidate);
    } else if (platform === "win32") {
      await ensureWin32ProtectedRootAcl(input.stateDir, candidate);
    }

    const realCandidate = realpathSync.native(candidate);
    registerManagedWorktreeRoot(input.stateDir, input.defaultWorktreesDir, realCandidate);
    return {
      root: realCandidate,
      crossVolume: true,
      fellBackToDataDir: false,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    input.log?.(
      `${LOG_PREFIX} 同卷 worktree 根目录 ${candidate} 无法创建或设置沙箱 ACL（${reason}），已自动回退到数据目录 ${input.defaultWorktreesDir}（跨卷将无法使用 pnpm 硬链接）`,
    );
    return {
      root: input.defaultWorktreesDir,
      crossVolume: true,
      fellBackToDataDir: true,
      fallbackReason: reason,
    };
  }
}

/** The junction keeps PM addDirs and sent-files under the default worktrees dir while Workers use the cross-volume directory directly. */
export function ensureProjectWorktreeBridge(
  defaultProjectWtDir: string,
  actualProjectWtDir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (normalizePathForComparison(defaultProjectWtDir) === normalizePathForComparison(actualProjectWtDir)) {
    return;
  }
  mkdirSync(actualProjectWtDir, { recursive: true });
  mkdirSync(dirname(defaultProjectWtDir), { recursive: true });
  try {
    const st = lstatSync(defaultProjectWtDir);
    if (st.isSymbolicLink()) {
      const realExisting = realpathSync.native(defaultProjectWtDir);
      if (normalizePathForComparison(realExisting) === normalizePathForComparison(actualProjectWtDir)) {
        return;
      }
      unlinkDirectoryLinkSync(defaultProjectWtDir);
    } else if (st.isDirectory()) {
      try {
        rmSync(defaultProjectWtDir, { recursive: false });
      } catch {
        return;
      }
    } else {
      return;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
  }

  try {
    symlinkSync(actualProjectWtDir, defaultProjectWtDir, platform === "win32" ? "junction" : "dir");
  } catch {
  }
}
