import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LRUCache } from "lru-cache";
import {
  MAX_FILE_QUERY_CHARS,
  MAX_FILE_RESULTS,
  MAX_WORKSPACE_FILE_CACHES,
  MAX_WORKSPACE_FILES,
  WORKSPACE_FILES_FRESH_MS,
  WORKSPACE_LIST_TIMEOUT_MS,
} from "../shared/index.ts";
import { killChildAndWait, termGroupAfterExit } from "./driver/process.ts";
import { GIT_READONLY_ARGS, GIT_READONLY_ENV } from "./git/index.ts";
import { spawnOwnedProcess } from "./platform/index.ts";
import { trackChild } from "./process-ledger.ts";

const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

export interface FileList {
  files: string[];
  truncated: boolean;
}

interface FileMatch {
  root: string;
  path: string;
}

export interface WorkspaceFilesOptions {
  now?: () => number;
  maxFiles?: number;
  freshMs?: number;
  maxCaches?: number;
  timeoutMs?: number;
}

export interface WorkspaceFiles {
  search(roots: readonly string[], query: string): Promise<{ matches: FileMatch[]; truncated: boolean }>;
}

function gitListFiles(root: string, maxFiles: number, timeoutMs: number): Promise<FileList | null> {
  return new Promise((resolve) => {
    let spawned: ReturnType<typeof spawnOwnedProcess>;
    try {
      spawned = spawnOwnedProcess(
        "git",
        [...GIT_READONLY_ARGS, "-c", "core.quotepath=off", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        {
          cwd: root,
          env: { ...process.env, ...GIT_READONLY_ENV },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      resolve(null);
      return;
    }
    const { child, detached } = spawned;
    if (!child.stdout) {
      void killChildAndWait(child).finally(() => resolve(null));
      return;
    }
    trackChild(child, "probe:workspace-files", { detached });
    child.once("exit", () => termGroupAfterExit(child));
    const files = new Set<string>();
    let rest = "";
    let truncated = false;
    let settled = false;
    const finish = (result: FileList | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        void killChildAndWait(child).finally(() => resolve(result));
        return;
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(files.size > 0 ? { files: [...files], truncated: true } : null), timeoutMs);
    child.once("error", () => finish(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const parts = (rest + chunk).split("\0");
      rest = parts.pop() ?? "";
      for (const file of parts) {
        if (file === "") continue;
        if (files.size >= maxFiles && !files.has(file)) {
          truncated = true;
          finish({ files: [...files], truncated });
          return;
        }
        files.add(file);
      }
    });
    child.once("close", (code) => finish(code === 0 ? { files: [...files], truncated } : null));
  });
}

async function walkFiles(root: string, maxFiles: number, deadline: number): Promise<FileList> {
  const files: string[] = [];
  const queue = [""];
  while (queue.length > 0) {
    if (Date.now() > deadline) return { files, truncated: true };
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) queue.push(path);
      } else if (entry.isFile()) {
        if (files.length >= maxFiles) return { files, truncated: true };
        files.push(path);
      }
    }
  }
  return { files, truncated: false };
}

const LSTAT_BATCH = 256;

async function onlyRegularFiles(root: string, files: string[]): Promise<string[]> {
  const kept: string[] = [];
  const candidates = files.filter((f) => !f.endsWith("/"));
  for (let i = 0; i < candidates.length; i += LSTAT_BATCH) {
    const batch = candidates.slice(i, i + LSTAT_BATCH);
    const stats = await Promise.all(batch.map((f) => lstat(join(root, f)).then((s) => s.isFile(), () => false)));
    batch.forEach((f, j) => {
      if (stats[j]) kept.push(f);
    });
  }
  return kept;
}

export async function listWorkspaceFiles(root: string, options: { maxFiles?: number; timeoutMs?: number } = {}): Promise<FileList> {
  const maxFiles = options.maxFiles ?? MAX_WORKSPACE_FILES;
  const timeoutMs = options.timeoutMs ?? WORKSPACE_LIST_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const listed = await gitListFiles(root, maxFiles, timeoutMs);
  if (listed === null) return walkFiles(root, maxFiles, deadline);
  return { files: await onlyRegularFiles(root, listed.files), truncated: listed.truncated };
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

export function fileScore(path: string, query: string): number | null {
  if (query === "") return 0;
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (isSubsequence(query, name)) return 3;
  if (lower.includes(query)) return 4;
  if (isSubsequence(query, lower)) return 5;
  return null;
}

function normalizeFileQuery(query: string): string {
  return [...query].slice(0, MAX_FILE_QUERY_CHARS).join("").trim().toLowerCase();
}

export function createWorkspaceFiles(options: WorkspaceFilesOptions = {}): WorkspaceFiles {
  const now = options.now ?? Date.now;
  const freshMs = options.freshMs ?? WORKSPACE_FILES_FRESH_MS;
  const maxCaches = options.maxCaches ?? MAX_WORKSPACE_FILE_CACHES;
  const cache = new LRUCache<string, { list: FileList; at: number }>({ max: Math.max(1, maxCaches) });
  const inflight = new Map<string, Promise<FileList>>();

  const listOf = async (root: string): Promise<FileList> => {
    const hit = cache.peek(root);
    if (hit && now() - hit.at < freshMs) return hit.list;
    let pending = inflight.get(root);
    if (!pending) {
      pending = listWorkspaceFiles(root, {
        ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })
        .then((list) => {
          cache.set(root, { list, at: now() });
          return list;
        })
        .finally(() => inflight.delete(root));
      inflight.set(root, pending);
    }
    return pending;
  };

  return {
    async search(roots, rawQuery) {
      const query = normalizeFileQuery(rawQuery);
      const lists = await Promise.all([...new Set(roots)].map(async (root) => ({ root, list: await listOf(root) })));
      const scored: Array<FileMatch & { score: number }> = [];
      for (const { root, list } of lists) {
        for (const path of list.files) {
          const score = fileScore(path, query);
          if (score !== null) scored.push({ root, path, score });
        }
      }
      scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return {
        matches: scored.slice(0, MAX_FILE_RESULTS).map(({ root, path }) => ({ root, path })),
        truncated: lists.some((l) => l.list.truncated),
      };
    },
  };
}
