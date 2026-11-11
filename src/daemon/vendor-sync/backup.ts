// 跨厂商同步的轮转备份（`<dataDir>/backups/sync/`，受 `MAX_VENDOR_SYNC_BACKUPS` 上限保护）与事务级原子替换/回滚。
import { randomBytes } from "node:crypto";
import writeFileAtomic from "write-file-atomic";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MAX_VENDOR_SYNC_BACKUPS } from "../../shared/index.ts";

export type WriteFileAtomicFn = (targetPath: string, content: string, mode?: number) => void;

export interface PlannedFileWrite {
  configPath: string;
  nextContent: string;
  mode?: number;
}

export type PlannedSymlinkOp =
  | { kind: "link"; linkPath: string; targetValue: string }
  | { kind: "unlink"; linkPath: string };

interface BackedUpFileEntry {
  index: number;
  targetPath: string;
  existed: boolean;
  mode: number;
  backupFile: string | null;
}

interface ReversedSymlinkAction {
  linkPath: string;
  previousTarget: string | null;
}

function formatBackupTimestamp(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/**
 * 原子写文件：用 npm 官方的 `write-file-atomic`（同目录临时文件 → fsync → rename）。
 * 目标是软链时（如 `~/.claude.json` 链到 dotfiles 仓库）它先 realpath，替换真实文件而不是把软链换成普通文件；
 * 已有文件沿用原权限与属主，新文件用 `mode`（默认 0600，配置里有密钥）。
 */
export function writeFileAtomicDefault(targetPath: string, content: string, mode?: number): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const exists = existsSync(targetPath);
  writeFileAtomic.sync(targetPath, content, { encoding: "utf8", fsync: true, ...(exists ? {} : { mode: mode ?? 0o600 }) });
}

/** 淘汰超出 `MAX_VENDOR_SYNC_BACKUPS` 的最老快照目录，防磁盘无限堆积。 */
export function pruneOldSyncBackups(backupsDir: string, maxBackups: number = MAX_VENDOR_SYNC_BACKUPS, keepId?: string): void {
  if (!existsSync(backupsDir)) return;
  const dirs = readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== keepId)
    .map((entry) => entry.name)
    .sort();
  // 本次快照（keepId）不参与淘汰：时钟回拨时它的名字可能排在最前，删了它失败回滚就没有原文可恢复
  const budget = keepId === undefined ? maxBackups : maxBackups - 1;
  while (dirs.length > Math.max(0, budget)) {
    const oldest = dirs.shift()!;
    rmSync(join(backupsDir, oldest), { recursive: true, force: true });
  }
}

function createBackupSnapshot(
  backupsDir: string,
  filePaths: readonly string[],
  nowMs: number,
): { backupId: string; entries: BackedUpFileEntry[] } {
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const backupId = `${formatBackupTimestamp(nowMs)}-${randomBytes(3).toString("hex")}`;
  const snapshotDir = join(backupsDir, backupId);
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });

  const uniquePaths = [...new Set(filePaths)];
  const entries: BackedUpFileEntry[] = [];

  uniquePaths.forEach((targetPath, index) => {
    if (existsSync(targetPath)) {
      const st = statSync(targetPath);
      const backupFile = join(snapshotDir, `file-${index}.bak`);
      copyFileSync(targetPath, backupFile);
      chmodSync(backupFile, 0o600);
      entries.push({
        index,
        targetPath,
        existed: true,
        mode: st.mode & 0o777,
        backupFile,
      });
    } else {
      entries.push({
        index,
        targetPath,
        existed: false,
        mode: 0o600,
        backupFile: null,
      });
    }
  });

  writeFileSync(
    join(snapshotDir, "manifest.json"),
    `${JSON.stringify(
      {
        backupId,
        createdAt: nowMs,
        files: entries.map(({ index, targetPath, existed, mode }) => ({ index, targetPath, existed, mode })),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  pruneOldSyncBackups(backupsDir, MAX_VENDOR_SYNC_BACKUPS, backupId);
  return { backupId, entries };
}

/**
 * 先写入 `<dataDir>/backups/sync/` 轮转备份，再依次执行原子文件替换与逐项软链更新；
 * 任一步骤抛错时立即将所有已改动的配置文件与软链恢复至同步前原状。
 */
export function executeAtomicSyncTransaction(input: {
  backupsDir: string;
  fileWrites: readonly PlannedFileWrite[];
  symlinkOps: readonly PlannedSymlinkOp[];
  nowMs?: number;
  writeFileAtomic?: WriteFileAtomicFn;
}): { backupId: string | null; updatedFiles: number } {
  const { backupsDir, fileWrites, symlinkOps, nowMs = Date.now(), writeFileAtomic = writeFileAtomicDefault } = input;

  if (fileWrites.length === 0 && symlinkOps.length === 0) {
    return { backupId: null, updatedFiles: 0 };
  }

  let backupId: string | null = null;
  let backedUpFiles: BackedUpFileEntry[] = [];
  if (fileWrites.length > 0) {
    const snap = createBackupSnapshot(
      backupsDir,
      fileWrites.map((w) => w.configPath),
      nowMs,
    );
    backupId = snap.backupId;
    backedUpFiles = snap.entries;
  }

  const touchedFiles = new Set<string>();
  const reversedSymlinks: ReversedSymlinkAction[] = [];

  try {
    for (const write of fileWrites) {
      touchedFiles.add(write.configPath);
      writeFileAtomic(write.configPath, write.nextContent, write.mode);
    }

    for (const op of symlinkOps) {
      let previousTarget: string | null = null;
      try {
        const st = lstatSync(op.linkPath);
        if (st.isSymbolicLink()) {
          previousTarget = readlinkSync(op.linkPath);
        }
      } catch {
        // 原路径不存在
      }

      if (op.kind === "link") {
        mkdirSync(dirname(op.linkPath), { recursive: true });
        if (previousTarget !== null) {
          unlinkSync(op.linkPath);
        }
        symlinkSync(op.targetValue, op.linkPath, "dir");
        reversedSymlinks.push({ linkPath: op.linkPath, previousTarget });
      } else {
        if (previousTarget !== null) {
          unlinkSync(op.linkPath);
          reversedSymlinks.push({ linkPath: op.linkPath, previousTarget });
        }
      }
    }

    return { backupId, updatedFiles: fileWrites.length };
  } catch (err) {
    // 1. 逆序回滚已执行的软链变更
    for (let i = reversedSymlinks.length - 1; i >= 0; i--) {
      const action = reversedSymlinks[i]!;
      try {
        try {
          if (lstatSync(action.linkPath).isSymbolicLink()) {
            unlinkSync(action.linkPath);
          }
        } catch {
          // 忽略不存在
        }
        if (action.previousTarget !== null) {
          mkdirSync(dirname(action.linkPath), { recursive: true });
          symlinkSync(action.previousTarget, action.linkPath, "dir");
        }
      } catch {
        // 尽力恢复所有项
      }
    }

    // 2. 用备份快照把已碰过的配置文件逐个原子恢复原状
    for (const entry of backedUpFiles) {
      if (!touchedFiles.has(entry.targetPath)) continue;
      try {
        if (entry.existed && entry.backupFile !== null) {
          const originalContent = readFileSync(entry.backupFile, "utf8");
          writeFileAtomicDefault(entry.targetPath, originalContent, entry.mode);
        } else {
          rmSync(entry.targetPath, { force: true });
        }
      } catch {
        // 尽力恢复其余文件
      }
    }

    throw err;
  }
}
