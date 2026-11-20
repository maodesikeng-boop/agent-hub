import { randomBytes } from "node:crypto";
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
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MAX_VENDOR_SYNC_BACKUPS } from "../../shared/index.ts";
import {
  createDirectoryLinkOrManagedCopySync,
  readManagedSkillCopyMeta,
  unlinkDirectoryLinkSync,
  writeFileAtomicSyncWithRetry,
} from "../platform/index.ts";

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
  createdManagedCopy?: boolean;
}

function formatBackupTimestamp(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/** write-file-atomic follows symlinks (such as ~/.claude.json into a dotfiles repo) and replaces the real file with its original mode and owner. */
export function writeFileAtomicDefault(targetPath: string, content: string, mode?: number): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const exists = existsSync(targetPath);
  writeFileAtomicSyncWithRetry(targetPath, content, {
    fsync: true,
    ...(exists ? {} : { mode: mode ?? 0o600 }),
  });
}

export function pruneOldSyncBackups(backupsDir: string, maxBackups: number = MAX_VENDOR_SYNC_BACKUPS, keepId?: string): void {
  if (!existsSync(backupsDir)) return;
  const dirs = readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== keepId)
    .map((entry) => entry.name)
    .sort();
  // Never evict the current snapshot; after a clock rollback it may sort first, and rollback would lose the original.
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

/** Back up first, then apply; any failure restores every touched file and symlink. */
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
      let hadManagedCopy = false;
      try {
        const st = lstatSync(op.linkPath);
        if (st.isSymbolicLink()) {
          previousTarget = readlinkSync(op.linkPath);
        } else if (st.isDirectory()) {
          const meta = readManagedSkillCopyMeta(op.linkPath);
          if (meta !== null) {
            previousTarget = meta.canonicalPath;
            hadManagedCopy = true;
          }
        }
      } catch {
      }

      if (op.kind === "link") {
        mkdirSync(dirname(op.linkPath), { recursive: true });
        if (hadManagedCopy) {
          rmSync(op.linkPath, { recursive: true, force: true });
        } else if (previousTarget !== null) {
          unlinkDirectoryLinkSync(op.linkPath);
        }
        const linkKind = createDirectoryLinkOrManagedCopySync(op.targetValue, op.linkPath);
        reversedSymlinks.push({
          linkPath: op.linkPath,
          previousTarget,
          createdManagedCopy: linkKind === "managed_copy",
        });
      } else {
        if (previousTarget !== null) {
          if (hadManagedCopy) {
            rmSync(op.linkPath, { recursive: true, force: true });
          } else {
            unlinkDirectoryLinkSync(op.linkPath);
          }
          reversedSymlinks.push({ linkPath: op.linkPath, previousTarget });
        }
      }
    }

    return { backupId, updatedFiles: fileWrites.length };
  } catch (err) {
    for (let i = reversedSymlinks.length - 1; i >= 0; i--) {
      const action = reversedSymlinks[i]!;
      try {
        try {
          if (action.createdManagedCopy || readManagedSkillCopyMeta(action.linkPath) !== null) {
            rmSync(action.linkPath, { recursive: true, force: true });
          } else if (lstatSync(action.linkPath).isSymbolicLink()) {
            unlinkDirectoryLinkSync(action.linkPath);
          }
        } catch {
        }
        if (action.previousTarget !== null) {
          mkdirSync(dirname(action.linkPath), { recursive: true });
          createDirectoryLinkOrManagedCopySync(action.previousTarget, action.linkPath);
        }
      } catch {
      }
    }

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
      }
    }

    throw err;
  }
}
