// agent 发给用户的文件：回复里的 Markdown 链接指向本机文件时，发出时存一份副本（设计见 shared/sent-files.ts）。
// 副本放 <sentFilesDir>/<副本编号>/<文件名>，和上传的文件同一个布局，取文件也用 uploads.ts 的 resolveUpload。
// 副本编号 = hash(消息去重键 + 序号)：重启后同一条消息重放算出同一个编号，命中已有副本，不重复拷、不留孤儿。
// 只分享允许的文件夹里的普通文件（isShareable），先 realpath 再比对；打开后 fstat 确认，再从同一个文件句柄拷贝，防检查后被换掉。
// （Node 24 在 macOS 上的 COPYFILE_FICLONE 实际不克隆、FICLONE_FORCE 报 ENOSYS，而且按路径拷会重新打开文件，所以直接从句柄拷。）
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  LOG_PREFIX,
  MAX_SENT_FILE_BYTES,
  MAX_SENT_FILES_TOTAL_BYTES,
  localLinksOf,
  sentFileMime,
  type LocalHref,
  type MdNode,
  type SentFile,
  type SentFileStatus,
} from "../shared/index.ts";
import { resolveUpload, sanitizeFileName } from "./uploads.ts";

/** 一个会话能分享哪些文件。路径都可以没 realpath 过，比对前统一 realpath。 */
export interface ShareScope {
  /** 副本放哪（paths.ts 的 sentFilesDir）。 */
  sentFilesDir: string;
  /** 相对路径按它解析：会话的工作目录。 */
  cwd: string;
  /** 展开 ~/ 用。 */
  userHome: string;
  /** 允许的文件夹：项目主文件夹、附加文件夹、本项目的 worktrees 目录、uploads、/tmp 和系统临时目录。 */
  roots: string[];
  /** 数据目录：里面只有 dataExceptions 下面的能分享（state/、ui-token、sent-files/ 都不行），哪怕它落在某个允许的文件夹里。 */
  dataHome: string;
  dataExceptions: string[];
}

/** 拷贝时一次读多少。 */
const COPY_CHUNK_BYTES = 1024 * 1024;
/** 拷了一半的副本先放在这种名字的目录里，拷完改名成编号；守护进程启动时清掉残留的（prepareSentFilesDir）。 */
const PARTIAL_PREFIX = ".partial-";

const markdown = unified().use(remarkParse).use(remarkGfm);

/** 副本编号：16 位十六进制（和上传编号一个形状，resolveUpload 认得）。 */
export function sentFileId(dedupeKey: string, index: number): string {
  return createHash("sha256").update(`${dedupeKey}\n${index}`).digest("hex").slice(0, 16);
}

/** 建目录（0700），清掉上次没拷完的残留。守护进程启动时调。 */
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
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** realpath 之后的路径能不能分享：不在任何 .git/ 里；在数据目录里的只认 dataExceptions；其余要在某个允许的文件夹里。 */
export function isShareable(real: string, scope: Pick<ShareScope, "roots" | "dataHome" | "dataExceptions">): boolean {
  if (real.split(sep).includes(".git")) return false;
  const reals = (paths: string[]) => paths.map(realOrNull).filter((p): p is string => p !== null);
  const dataHome = realOrNull(scope.dataHome);
  if (dataHome !== null && within(real, dataHome)) return reals(scope.dataExceptions).some((dir) => within(real, dir));
  return reals(scope.roots).some((dir) => within(real, dir));
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

/** 从句柄拷 size 个字节到新文件（不存在才建，0600），修改时间设成原文件的。 */
function copyFromFd(fd: number, stat: Stats, dest: string): void {
  const out = openSync(dest, "wx", 0o600);
  try {
    const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(1, stat.size)));
    let position = 0;
    while (position < stat.size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (n === 0) break;
      let written = 0;
      while (written < n) written += writeSync(out, buffer, written, n - written);
      position += n;
    }
    futimesSync(out, stat.atime, stat.mtime);
  } finally {
    closeSync(out);
  }
}

type Outcome = { status: Exclude<SentFileStatus, "saved">; size: number | null; mtime: number | null } | { status: "saved"; name: string; size: number; mtime: number };

/** 已经有这个编号的副本（重启重放、上次存完还没入库就关了）：直接用。 */
function existingCopy(sentFilesDir: string, id: string): Outcome | null {
  const copy = resolveUpload(sentFilesDir, id);
  if (copy === null) return null;
  try {
    return { status: "saved", name: copy.name, size: copy.size, mtime: lstatSync(copy.path).mtimeMs };
  } catch {
    return null;
  }
}

/** 处理一个链接：查、开、拷。budget 是这条消息还能拷多少字节。 */
function shareOne(path: string, id: string, name: string, budget: number, scope: ShareScope): Outcome {
  const existing = existingCopy(scope.sentFilesDir, id);
  if (existing !== null) return existing;
  const real = realOrNull(path);
  if (real === null) return { status: "missing", size: null, mtime: null };
  if (!isShareable(real, scope)) return { status: "not_allowed", size: null, mtime: null };
  let fd: number;
  try {
    // O_NOFOLLOW：realpath 之后最后一段又被换成符号链接就打不开；O_NONBLOCK：命名管道不会卡住
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: code === "ENOENT" ? "missing" : code === "ELOOP" ? "not_allowed" : "unreadable", size: null, mtime: null };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { status: "not_file", size: null, mtime: stat.mtimeMs };
    // 打开的必须还是检查过的那个文件：realpath 和 open 之间路径被换掉的，当不在允许的文件夹里
    const now = realOrNull(real);
    if (now !== real || !sameFile(lstatSync(real), stat)) return { status: "not_allowed", size: null, mtime: null };
    if (stat.size > MAX_SENT_FILE_BYTES || stat.size > budget) return { status: "too_large", size: stat.size, mtime: stat.mtimeMs };
    const partial = join(scope.sentFilesDir, `${PARTIAL_PREFIX}${id}-${randomBytes(4).toString("hex")}`);
    try {
      mkdirSync(partial, { recursive: true, mode: 0o700 });
      copyFromFd(fd, stat, join(partial, name));
      renameSync(partial, join(scope.sentFilesDir, id));
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      // 同一个编号被别人先存好了（改名撞上已有目录）就用它
      const raced = existingCopy(scope.sentFilesDir, id);
      if (raced !== null) return raced;
      console.error(`${LOG_PREFIX} sent file copy failed: ${path}:`, error);
      return { status: "unreadable", size: stat.size, mtime: stat.mtimeMs };
    }
    return { status: "saved", name, size: stat.size, mtime: stat.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/**
 * 找出回复里指向本机文件的链接（shared/sent-files.ts 的 localLinksOf：代码块里的不算、去重、最多 10 个），逐个存副本。
 * 返回 meta.files；没有这样的链接返回空数组。不抛错：单个文件出错记成 unreadable。
 */
export function shareLinkedFiles(text: string, dedupeKey: string, scope: ShareScope): SentFile[] {
  const links = localLinksOf(markdown.parse(text) as MdNode);
  if (links.length === 0) return [];
  mkdirSync(scope.sentFilesDir, { recursive: true, mode: 0o700 });
  let used = 0;
  return links.map(({ href, local }, index) => {
    const path = absolutePathOf(local, scope);
    const name = sanitizeFileName(basename(path));
    const id = sentFileId(dedupeKey, index);
    let outcome: Outcome;
    try {
      outcome = shareOne(path, id, name, MAX_SENT_FILES_TOTAL_BYTES - used, scope);
    } catch (error) {
      console.error(`${LOG_PREFIX} sent file failed: ${path}:`, error);
      outcome = { status: "unreadable", size: null, mtime: null };
    }
    if (outcome.status === "saved") {
      used += outcome.size;
      return { href, path, id, name: outcome.name, size: outcome.size, mime: sentFileMime(outcome.name), status: "saved", mtime: outcome.mtime };
    }
    return { href, path, id: null, name, size: outcome.size, mime: sentFileMime(name), status: outcome.status, mtime: outcome.mtime };
  });
}
