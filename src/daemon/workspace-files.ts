// 输入框“@”的文件搜索（跟厂商无关；插进输入框的写法由厂商实现的 mention 生成，见 daemon/composer.ts）：
// - 列文件：git 仓库用 `git ls-files --cached --others --exclude-standard`（跳过 .gitignore 里的）；不是 git 仓库的自己遍历，
//   跳过 node_modules 和 .git，不跟符号链接进目录。只列文件，不列文件夹。每个文件夹最多 MAX_WORKSPACE_FILES 个，多了 truncated。
// - 每个文件夹的清单缓存 WORKSPACE_FILES_FRESH_MS；
// - 模糊打分：文件名命中排在路径命中前面，每次最多 MAX_FILE_RESULTS 条。
// 只在给的文件夹里列，搜索词只拿来比，不当路径用，所以 `../../etc` 这类搜不出文件夹外面的东西。
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_FILE_QUERY_CHARS,
  MAX_FILE_RESULTS,
  MAX_WORKSPACE_FILES,
  WORKSPACE_FILES_FRESH_MS,
  WORKSPACE_LIST_TIMEOUT_MS,
} from "../shared/index.ts";

/** 遍历时跳过的目录。 */
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/** 一个文件夹的文件清单：path 是相对它的路径，用 / 分隔。 */
export interface FileList {
  files: string[];
  truncated: boolean;
}

/** 搜到的一个文件。 */
export interface FileMatch {
  root: string;
  /** 相对 root 的路径。 */
  path: string;
}

export interface WorkspaceFilesOptions {
  now?: () => number;
  maxFiles?: number;
  freshMs?: number;
  timeoutMs?: number;
}

export interface WorkspaceFiles {
  /** 在这些文件夹里搜，按匹配程度排好，最多 MAX_FILE_RESULTS 条。文件夹不存在、读不了的当空的。 */
  search(roots: readonly string[], query: string): Promise<{ matches: FileMatch[]; truncated: boolean }>;
}

/** git ls-files 列；不是 git 仓库（或者没装 git）返回 null。 */
function gitListFiles(root: string, maxFiles: number, timeoutMs: number): Promise<FileList | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "core.quotepath=off", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = new Set<string>();
    let rest = "";
    let truncated = false;
    let settled = false;
    const finish = (result: FileList | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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

/** 自己遍历（不是 git 仓库时）：广度优先，跳过 SKIPPED_DIRS，不跟符号链接。 */
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

/** 列一个文件夹里的文件。 */
export async function listWorkspaceFiles(root: string, options: { maxFiles?: number; timeoutMs?: number } = {}): Promise<FileList> {
  const maxFiles = options.maxFiles ?? MAX_WORKSPACE_FILES;
  const timeoutMs = options.timeoutMs ?? WORKSPACE_LIST_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  return (await gitListFiles(root, maxFiles, timeoutMs)) ?? walkFiles(root, maxFiles, deadline);
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * 一个文件和搜索词（已经小写、去空白）的匹配分，越小越前，不匹配是 null：
 * 文件名完全一样 0、开头 1、包含 2、按顺序含这些字 3；路径包含 4、按顺序含 5。搜索词是空的都算 0。
 */
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

/** 搜索词：截到 MAX_FILE_QUERY_CHARS、去首尾空白、小写。 */
export function normalizeFileQuery(query: string): string {
  return [...query].slice(0, MAX_FILE_QUERY_CHARS).join("").trim().toLowerCase();
}

export function createWorkspaceFiles(options: WorkspaceFilesOptions = {}): WorkspaceFiles {
  const now = options.now ?? Date.now;
  const freshMs = options.freshMs ?? WORKSPACE_FILES_FRESH_MS;
  const cache = new Map<string, { list: FileList; at: number }>();
  const inflight = new Map<string, Promise<FileList>>();

  const listOf = async (root: string): Promise<FileList> => {
    const hit = cache.get(root);
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
