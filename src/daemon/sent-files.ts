import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync, rmSync, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rm, stat as statAsync, utimes, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  CREDENTIAL_HOME_PATHS,
  DATA_DIR_READABLE_ENTRIES,
  LOG_PREFIX,
  MAX_SENT_FILE_BYTES,
  MAX_SENT_FILE_IO_INFLIGHT,
  MAX_SENT_FILES_PER_MESSAGE,
  MAX_SENT_FILES_TOTAL_BYTES,
  SENT_FILE_COPY_CHUNK_BYTES,
  linkNodesOf,
  localLinksOf,
  locationFallbackPaths,
  sentFileMime,
  type LocalHref,
  type MdNode,
  type SentFile,
  type SentFileStatus,
  type SessionId,
  VENDOR_LIST,
} from "../shared/index.ts";
import { resolveUpload, sanitizeFileName } from "./uploads.ts";
import {
  isPathInsideOrEqual,
  normalizePathForComparison,
  openRegularFileNoFollow,
  renameWithWindowsRetry,
} from "./platform/index.ts";

/** These paths are never shareable regardless of folder config, for example when the project folder is ~ or /. */
export const SENSITIVE_HOME_PATHS: readonly string[] = [...CREDENTIAL_HOME_PATHS, ...VENDOR_LIST.flatMap((spec) => spec.home.dirs)];
/** macOS /etc is a symlink to /private/etc, so both are listed; /proc exposes process environments on Linux. */
const SENSITIVE_SYSTEM_PATHS: readonly string[] = ["/etc", "/private/etc", "/private/var/db", "/proc"];

export interface ShareScope {
  sentFilesDir: string;
  cwd: string;
  userHome: string;
  roots: string[];
  dataHome: string;
  dataExceptions: string[];
  /** Session-private directories inside dataHome (such as a PM's own memory dir) that bypass DATA_DIR_READABLE_ENTRIES; never populated for Workers. */
  privateDataExceptions?: string[];
  io?: { slots: SentFileIoSlots; owner: SessionId };
}

type SentFileIoSlots = ReturnType<typeof createSentFileIoSlots>;

/** A read slot is held from open until the handle closes; aborting does not free it because a read stuck in open() cannot be cancelled. */
export function createSentFileIoSlots(max = MAX_SENT_FILE_IO_INFLIGHT) {
  const inflight = new Set<{ owner: SessionId; signal: AbortSignal | undefined }>();
  return {
    acquire(owner: SessionId, signal: AbortSignal | undefined): (() => void) | null {
      if (signal?.aborted === true || inflight.size >= max) return null;
      for (const slot of inflight) if (slot.owner === owner && slot.signal?.aborted === true) return null;
      const slot = { owner, signal };
      inflight.add(slot);
      return () => inflight.delete(slot);
    },
  };
}

/** Copies land in a temp-named directory and are renamed when complete; startup removes leftovers. */
const PARTIAL_PREFIX = ".partial-";

const markdown = unified().use(remarkParse).use(remarkGfm);

export function sentFileId(name: string, contentSha256: string): string {
  return createHash("sha256").update(`${name}\u0000${contentSha256}`).digest("hex").slice(0, 16);
}

export function prepareSentFilesDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    if (name.startsWith(PARTIAL_PREFIX)) rmSync(join(dir, name), { recursive: true, force: true });
  }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function within(child: string, parent: string): boolean {
  if (process.platform === "win32") {
    return isPathInsideOrEqual(parent, child);
  }
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function realList(paths: readonly string[]): string[] {
  return paths.map((p) => realOrNull(p) ?? p);
}

export function sensitivePathsOf(userHome: string): string[] {
  const home = realOrNull(userHome) ?? userHome;
  return [...realList(SENSITIVE_HOME_PATHS.map((p) => join(home, p))), ...realList(SENSITIVE_SYSTEM_PATHS)];
}

export function isShareable(
  real: string,
  scope: Pick<ShareScope, "roots" | "dataHome" | "dataExceptions" | "privateDataExceptions" | "userHome">,
  sensitive: readonly string[] = sensitivePathsOf(scope.userHome),
): boolean {
  if (real.split(sep).includes(".git")) return false;
  if (sensitive.some((dir) => within(real, dir))) return false;
  const reals = (paths: string[]) => paths.map(realOrNull).filter((p): p is string => p !== null);
  const dataHome = realOrNull(scope.dataHome);
  if (dataHome !== null && within(real, dataHome)) {
    if (scope.privateDataExceptions !== undefined && reals(scope.privateDataExceptions).some((dir) => within(real, dir))) {
      return true;
    }
    // Shares from the data dir may not exceed the Worker read boundary.
    const readable = reals(DATA_DIR_READABLE_ENTRIES.map((entry) => join(dataHome, entry)));
    return readable.some((dir) => within(real, dir)) && reals(scope.dataExceptions).some((dir) => within(real, dir));
  }
  return reals(scope.roots).some((dir) => within(real, dir));
}

function looseRealpath(path: string): string {
  const rest: string[] = [];
  let dir = path;
  for (;;) {
    const real = realOrNull(dir);
    if (real !== null) return join(real, ...rest.reverse());
    const parent = dirname(dir);
    if (parent === dir) return path;
    rest.push(basename(dir));
    dir = parent;
  }
}

function absolutePathOf(local: LocalHref, scope: Pick<ShareScope, "cwd" | "userHome">): string {
  switch (local.kind) {
    case "absolute":
      return resolve(local.path);
    case "home":
      return resolve(scope.userHome, `.${local.path}`);
    case "relative":
      return resolve(scope.cwd, local.path);
  }
}

const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

export async function copyFromHandle(
  source: FileHandle,
  stat: Stats,
  dest: string,
  signal?: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
  const out = await open(dest, "wx", 0o600);
  const hash = createHash("sha256");
  let position = 0;
  try {
    const buffer = Buffer.allocUnsafe(Math.min(SENT_FILE_COPY_CHUNK_BYTES, Math.max(1, stat.size)));
    while (position < stat.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) written += (await out.write(buffer, written, bytesRead - written)).bytesWritten;
      position += bytesRead;
    }
    await out.utimes(stat.atime, stat.mtime);
  } finally {
    await out.close();
  }
  return { bytes: position, sha256: hash.digest("hex") };
}

type Outcome =
  | { status: "skip" }
  | { status: Exclude<SentFileStatus, "saved">; size: number | null; mtime: number | null }
  | { status: "saved"; id: string; size: number; mtime: number };

const reject = (status: Exclude<SentFileStatus, "saved">, stat?: Stats): Extract<Outcome, { size: number | null }> => ({
  status,
  size: stat?.isFile() ? stat.size : null,
  mtime: stat?.mtimeMs ?? null,
});

/** Retry without a line suffix (#L10-L20, :10:5) when the literal path does not exist. */
function existingPathOf(href: string, local: LocalHref, scope: Pick<ShareScope, "cwd" | "userHome">): string {
  const path = absolutePathOf(local, scope);
  if (realOrNull(path) !== null) return path;
  for (const candidate of locationFallbackPaths(href, path)) if (realOrNull(candidate) !== null) return candidate;
  return path;
}

async function realOrNullAsync(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function shareOne(
  path: string,
  local: LocalHref,
  name: string,
  budget: number,
  scope: ShareScope,
  sensitive: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  const real = await realOrNullAsync(path);
  if (signal?.aborted) return reject("unreadable");
  if (real === null) return local.kind !== "relative" && isShareable(looseRealpath(path), scope, sensitive) ? reject("missing") : { status: "skip" };
  let before: Stats;
  try {
    before = await statAsync(real);
  } catch {
    return { status: "skip" };
  }
  if (signal?.aborted) return reject("unreadable");
  if (!isShareable(real, scope, sensitive)) return before.isFile() ? reject("not_allowed") : { status: "skip" };
  if (!before.isFile()) return reject("not_file", before);
  const release = scope.io === undefined ? () => {} : scope.io.slots.acquire(scope.io.owner, signal);
  if (release === null) return reject("unreadable", before);
  try {
    return await copyOpened(path, real, before, name, budget, scope, signal);
  } finally {
    release();
  }
}

async function copyOpened(
  path: string,
  real: string,
  before: Stats,
  name: string,
  budget: number,
  scope: ShareScope,
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  if (signal?.aborted) return reject("unreadable", before);
  let handle: FileHandle;
  try {
    handle = await openRegularFileNoFollow(real, { nonBlock: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return reject(code === "ENOENT" ? "missing" : code === "ELOOP" ? "not_allowed" : "unreadable");
  }
  try {
    if (signal?.aborted) return reject("unreadable");
    const stat = await handle.stat();
    if (!stat.isFile()) return reject("not_file", stat);
    // The opened file must still be the one that was checked, otherwise a swap between check and open is rejected.
    const currentReal = await realOrNullAsync(real);
    if (
      currentReal === null ||
      normalizePathForComparison(currentReal) !== normalizePathForComparison(real) ||
      !sameFile(before, stat) ||
      !sameFile(await lstat(real), stat)
    ) {
      return reject("not_allowed");
    }
    if (stat.size > MAX_SENT_FILE_BYTES || stat.size > budget) return reject("too_large", stat);
    const partial = join(scope.sentFilesDir, `${PARTIAL_PREFIX}${randomBytes(8).toString("hex")}`);
    try {
      await mkdir(partial, { mode: 0o700 });
      const copied = await copyFromHandle(handle, stat, join(partial, name), signal);
      signal?.throwIfAborted();
      const id = sentFileId(name, copied.sha256);
      const target = join(scope.sentFilesDir, id);
      // The id derives from name and content so identical sends share one copy.
      const published = () => {
        const existing = resolveUpload(scope.sentFilesDir, id);
        return existing !== null && existing.name === name && existing.size === copied.bytes;
      };
      if (!published()) {
        try {
          await renameWithWindowsRetry(partial, target);
          return { status: "saved", id, size: copied.bytes, mtime: stat.mtimeMs };
        } catch (error) {
          // A concurrent request won the rename (ENOTEMPTY, EEXIST, or EPERM on Windows), so use its copy.
          if (!published()) throw error;
        }
      }
      // Touch the directory so file-cleanup.ts does not delete a copy that was just reused.
      await rm(partial, { recursive: true, force: true });
      const now = new Date();
      await utimes(target, now, now);
      return { status: "saved", id, size: copied.bytes, mtime: stat.mtimeMs };
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      if (!signal?.aborted) console.error(`${LOG_PREFIX} sent file copy failed: ${path}:`, error);
      return reject("unreadable", stat);
    }
  } finally {
    await handle.close();
  }
}

export function localLinksIn(text: string): LocalLink[] {
  if (!text.includes("](") && !text.includes("<")) return [];
  return localLinksOf(markdown.parse(text) as MdNode, text);
}

export type LocalLink = { href: string; local: LocalHref };

async function shareLinks(links: readonly LocalLink[], scope: ShareScope, strict: boolean, signal: AbortSignal | undefined): Promise<SentFile[]> {
  const files: SentFile[] = [];
  let used = 0;
  // Resolve the sensitive list once per message and never cache it across messages, because symlinks and home may change.
  const sensitive = sensitivePathsOf(scope.userHome);
  for (const { href, local } of links) {
    if (files.length === MAX_SENT_FILES_PER_MESSAGE) break;
    const path = existingPathOf(href, local, scope);
    const name = sanitizeFileName(basename(path));
    let outcome: Outcome;
    try {
      await mkdir(scope.sentFilesDir, { recursive: true, mode: 0o700 });
      outcome = signal?.aborted ? reject("unreadable") : await shareOne(path, local, name, MAX_SENT_FILES_TOTAL_BYTES - used, scope, sensitive, signal);
    } catch (error) {
      console.error(`${LOG_PREFIX} sent file failed: ${path}:`, error);
      outcome = reject("unreadable");
    }
    if (outcome.status === "skip") {
      if (!strict) continue;
      outcome = reject(realOrNull(path) === null ? "missing" : "not_allowed");
    }
    const base = { href, path, name, mime: sentFileMime(name) };
    if (outcome.status === "saved") {
      used += outcome.size;
      files.push({ ...base, id: outcome.id, size: outcome.size, status: "saved", mtime: outcome.mtime });
    } else {
      files.push({ ...base, id: null, size: outcome.size, status: outcome.status, mtime: outcome.mtime });
    }
  }
  return files;
}

/** On abort, return immediately because reads stuck in open() cannot be cancelled. */
export function unlessAborted<T>(work: Promise<T>, signal: AbortSignal | undefined, onAbort: () => T): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.resolve(onAbort());
  return new Promise<T>((resolve, reject) => {
    const abort = () => resolve(onAbort());
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function shareLinkedFiles(links: readonly LocalLink[], scope: ShareScope, signal?: AbortSignal): Promise<SentFile[]> {
  if (links.length === 0) return Promise.resolve([]);
  return unlessAborted(shareLinks(links, scope, false, signal), signal, () => []);
}

const WIN_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

export function shareFilePaths(paths: readonly string[], scope: ShareScope, signal?: AbortSignal): Promise<SentFile[]> {
  const links = paths.map((path) => ({
    href: path,
    local: { kind: isAbsolute(path) || WIN_ABSOLUTE.test(path) ? "absolute" : "relative", path } as LocalHref,
  }));
  const unreadable = (): SentFile[] =>
    links.slice(0, MAX_SENT_FILES_PER_MESSAGE).map(({ href, local }) => {
      const path = absolutePathOf(local, scope);
      const name = sanitizeFileName(basename(path));
      return { href, path, name, mime: sentFileMime(name), id: null, size: null, status: "unreadable", mtime: null };
    });
  return unlessAborted(shareLinks(links, scope, true, signal), signal, unreadable);
}

export function markdownLinksOf(text: string): { href: string; label: string }[] {
  if (!text.includes("](")) return [];
  const textOf = (node: MdNode): string => node.value ?? (node.children ?? []).map(textOf).join("");
  return linkNodesOf(markdown.parse(text) as MdNode).map((node) => ({
    href: node.url!,
    label: (node.type === "image" ? (node.alt ?? "") : textOf(node)).trim(),
  }));
}
