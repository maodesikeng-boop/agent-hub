import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { LRUCache } from "lru-cache";
import { MAX_PATH_BYTES, WORKTREE_BRANCH_CACHE_MAX, WORKTREE_BRANCH_PROBE_TIMEOUT_MS } from "../../shared/limits.ts";

export interface WorktreeBranchProbeOptions {
  maxEntries?: number;
}

export interface WorktreeBranchProbe {
  readBranch(worktreePath: string): Promise<string | null>;
  invalidate(worktreePath?: string): void;
}

async function headPath(worktreePath: string, signal: AbortSignal): Promise<string | null> {
  const dotGit = join(worktreePath, ".git");
  const info = await stat(dotGit);
  if (info.isDirectory()) return join(dotGit, "HEAD");
  if (!info.isFile() || info.size > MAX_PATH_BYTES) return null;
  const pointer = /^gitdir: (.+)$/u.exec((await readFile(dotGit, { encoding: "utf8", signal })).trim())?.[1];
  return pointer ? resolve(worktreePath, pointer.replaceAll("\\", sep), "HEAD") : null;
}

type CachedBranch = { fingerprint: string; branch: string };

export async function readWorktreeBranch(worktreePath: string): Promise<string | null> {
  return createWorktreeBranchProbe().readBranch(worktreePath);
}

export function createWorktreeBranchProbe({ maxEntries = WORKTREE_BRANCH_CACHE_MAX }: WorktreeBranchProbeOptions = {}): WorktreeBranchProbe {
  const cache = new LRUCache<string, CachedBranch>({ max: maxEntries });
  const read = async (worktreePath: string, signal: AbortSignal): Promise<string | null> => {
    try {
      const head = await headPath(worktreePath, signal);
      if (signal.aborted) return null;
      if (head === null) {
        cache.delete(worktreePath);
        return null;
      }
      const info = await stat(head, { bigint: true });
      if (signal.aborted) return null;
      if (!info.isFile() || info.size > MAX_PATH_BYTES) {
        cache.delete(worktreePath);
        return null;
      }
      const fingerprint = `${head}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
      const cached = cache.get(worktreePath);
      if (cached?.fingerprint === fingerprint) return cached.branch;
      cache.delete(worktreePath);
      const branch = /^ref: refs\/heads\/(\S[^\r\n]*)$/u.exec((await readFile(head, { encoding: "utf8", signal })).trim())?.[1];
      if (branch === undefined || signal.aborted) return null;
      cache.set(worktreePath, { fingerprint, branch });
      return branch;
    } catch {
      if (!signal.aborted) cache.delete(worktreePath);
      return null;
    }
  };
  return {
    async readBranch(path) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          read(path, controller.signal),
          new Promise<null>((done) => { timer = setTimeout(() => { controller.abort(); done(null); }, WORKTREE_BRANCH_PROBE_TIMEOUT_MS); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    invalidate(path) {
      if (path === undefined) cache.clear();
      else cache.delete(path);
    },
  };
}
