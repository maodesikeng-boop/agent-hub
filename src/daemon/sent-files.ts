// agent 发给用户的文件：回复里的 Markdown 链接指向本机文件时，发出时存一份副本（设计见 shared/sent-files.ts）。
// 副本放 <sentFilesDir>/<副本编号>/<文件名>，和上传的文件同一个布局，取文件也用 uploads.ts 的 resolveUpload。
// 副本编号 = hash(文件名 + 内容)：同一个文件多次发（不同消息、不同会话、重启后重放）只存一份，元数据各记各的；内容变了另存一份。
// 只分享允许的文件夹里的普通文件（isShareable），先 realpath 再比对；打开后 fstat 确认，再从同一个文件句柄拷贝，防检查后被换掉。
// （Node 24 在 macOS 上的 COPYFILE_FICLONE 实际不克隆、FICLONE_FORCE 报 ENOSYS，而且按路径拷会重新打开文件，所以直接从句柄拷。）
//
// 哪些链接算“发文件”（不算的不进 meta.files，网页照原样显示）：
// - 路径存在、是普通文件：算。在可分享的文件夹里就存副本（太大的不存），不在就写“不在可分享的文件夹里”；
// - 路径存在、不是普通文件（文件夹、管道）：在可分享的文件夹里写“不是文件”，不在（/、/usr 之类）不算；
// - 路径不存在：用绝对路径（/、file://、~/）写的、而且落在可分享的文件夹里，写“没找到文件”；别的（/login 这种站内链接、
//   不存在的相对路径）不算。
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
  statSync,
  utimesSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  AGENT_VENDORS,
  CREDENTIAL_HOME_PATHS,
  LOG_PREFIX,
  MAX_SENT_FILE_BYTES,
  MAX_SENT_FILES_PER_MESSAGE,
  MAX_SENT_FILES_TOTAL_BYTES,
  SENT_FILE_COPY_CHUNK_BYTES,
  localLinksOf,
  locationFallbackPaths,
  sentFileMime,
  type LocalHref,
  type MdNode,
  type SentFile,
  type SentFileStatus,
  VENDOR_HOME_PATHS,
} from "../shared/index.ts";
import { resolveUpload, sanitizeFileName } from "./uploads.ts";

/**
 * 不管允许的文件夹怎么配（项目文件夹是 ~ 或 /、附加了家目录），这些始终不能分享：凭据清单（shared/secret-paths.ts，只读 Worker 也禁读）
 * + 各家厂商（claude、codex、agy）的整个配置目录（vendors.ts 的 VENDOR_HOME_PATHS.dirs，会话记录也不给网页看）。
 * 写家目录下的相对路径，比对时 realpath（是符号链接的按它指向的地方）。
 */
export const SENSITIVE_HOME_PATHS: readonly string[] = [...CREDENTIAL_HOME_PATHS, ...AGENT_VENDORS.flatMap((vendor) => VENDOR_HOME_PATHS[vendor].dirs)];
/** 同上，系统里的（macOS 上 /etc 是 /private/etc 的符号链接，两个都写；/proc 里有进程的环境变量，只有 Linux 有）。 */
const SENSITIVE_SYSTEM_PATHS: readonly string[] = ["/etc", "/private/etc", "/private/var/db", "/proc"];

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

/** 拷了一半的副本先放在这种名字的目录里，拷完改名成编号；守护进程启动时清掉残留的（prepareSentFilesDir）。 */
const PARTIAL_PREFIX = ".partial-";

const markdown = unified().use(remarkParse).use(remarkGfm);

/** 副本编号：16 位十六进制（和上传编号一个形状，resolveUpload 认得），按文件名和内容（sha256 十六进制）算。 */
export function sentFileId(name: string, contentSha256: string): string {
  return createHash("sha256").update(`${name}\u0000${contentSha256}`).digest("hex").slice(0, 16);
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

function realList(paths: readonly string[]): string[] {
  return paths.map((p) => realOrNull(p) ?? p);
}

/** 敏感路径清单（SENSITIVE_HOME_PATHS 放到这个主目录下 + SENSITIVE_SYSTEM_PATHS）realpath 之后的样子；一次分享只算一次，传给 isShareable。 */
export function sensitivePathsOf(userHome: string): string[] {
  const home = realOrNull(userHome) ?? userHome;
  return [...realList(SENSITIVE_HOME_PATHS.map((p) => join(home, p))), ...realList(SENSITIVE_SYSTEM_PATHS)];
}

/**
 * realpath 之后的路径能不能分享：不在敏感路径清单里（sensitivePathsOf）、不在任何 .git/ 里；
 * 在数据目录里的只认 dataExceptions；其余要在某个允许的文件夹里。sensitive 不传就现算（单个路径判断用）；一条消息里判断多个链接时算一次传下去。
 * 边界：硬链接查不出来（项目里一个硬链接指向 ~/.ssh/id_rsa 的同一个 inode，路径看着在项目里）。不拦：agent 本来就有 shell，
 * 能把任何文件 cp 进项目再发；这里防的是误发、被诱导写出敏感路径，不是防 agent 本身。也不查 nlink：nlink>1 会误拦 pnpm 硬链接出来的
 * node_modules 文件，又拦不住 cp。
 */
export function isShareable(
  real: string,
  scope: Pick<ShareScope, "roots" | "dataHome" | "dataExceptions" | "userHome">,
  sensitive: readonly string[] = sensitivePathsOf(scope.userHome),
): boolean {
  if (real.split(sep).includes(".git")) return false;
  if (sensitive.some((dir) => within(real, dir))) return false;
  const reals = (paths: string[]) => paths.map(realOrNull).filter((p): p is string => p !== null);
  const dataHome = realOrNull(scope.dataHome);
  if (dataHome !== null && within(real, dataHome)) return reals(scope.dataExceptions).some((dir) => within(real, dir));
  return reals(scope.roots).some((dir) => within(real, dir));
}

/** 不存在的路径：最近一层存在的上级 realpath，再接上后面几段（/tmp/x/y → /private/tmp/x/y），用来判断它“该在”哪个文件夹里。 */
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

/**
 * 从句柄拷最多 stat.size 个字节到新文件（不存在才建，0600），边拷边算 sha256，修改时间设成原文件的。
 * 拷的时候源文件被截断，就拷到读不出为止：返回实际拷到的字节数。
 */
export function copyFromFd(fd: number, stat: Stats, dest: string): { bytes: number; sha256: string } {
  const out = openSync(dest, "wx", 0o600);
  const hash = createHash("sha256");
  let position = 0;
  try {
    const buffer = Buffer.allocUnsafe(Math.min(SENT_FILE_COPY_CHUNK_BYTES, Math.max(1, stat.size)));
    while (position < stat.size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
      let written = 0;
      while (written < n) written += writeSync(out, buffer, written, n - written);
      position += n;
    }
    futimesSync(out, stat.atime, stat.mtime);
  } finally {
    closeSync(out);
  }
  return { bytes: position, sha256: hash.digest("hex") };
}

/** skip：不算发文件（见文件头的规则），不进 meta.files。 */
type Outcome =
  | { status: "skip" }
  | { status: Exclude<SentFileStatus, "saved">; size: number | null; mtime: number | null }
  | { status: "saved"; id: string; size: number; mtime: number };

const reject = (status: Exclude<SentFileStatus, "saved">, stat?: Stats): Outcome => ({
  status,
  size: stat?.isFile() ? stat.size : null,
  mtime: stat?.mtimeMs ?? null,
});

/** 链接对应的绝对路径：原样找不到文件时，试去掉行号（#L10-L20、:10:5 之类）的写法，都找不到还是原样（记成没找到）。 */
function existingPathOf(href: string, local: LocalHref, scope: Pick<ShareScope, "cwd" | "userHome">): string {
  const path = absolutePathOf(local, scope);
  if (realOrNull(path) !== null) return path;
  for (const candidate of locationFallbackPaths(href, path)) if (realOrNull(candidate) !== null) return candidate;
  return path;
}

/** 处理一个链接：判断、开、拷。budget 是这条消息还能拷多少字节。 */
function shareOne(path: string, local: LocalHref, name: string, budget: number, scope: ShareScope, sensitive: readonly string[]): Outcome {
  const real = realOrNull(path);
  if (real === null) return local.kind !== "relative" && isShareable(looseRealpath(path), scope, sensitive) ? reject("missing") : { status: "skip" };
  let before: Stats;
  try {
    before = statSync(real);
  } catch {
    return { status: "skip" };
  }
  if (!isShareable(real, scope, sensitive)) return before.isFile() ? reject("not_allowed") : { status: "skip" };
  if (!before.isFile()) return reject("not_file", before);
  let fd: number;
  try {
    // O_NOFOLLOW：realpath 之后最后一段又被换成符号链接就打不开；O_NONBLOCK：换成命名管道也不会卡住
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return reject(code === "ENOENT" ? "missing" : code === "ELOOP" ? "not_allowed" : "unreadable");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return reject("not_file", stat);
    // 打开的必须还是检查过的那个文件：检查和 open 之间路径被换掉的，当不在允许的文件夹里
    if (realOrNull(real) !== real || !sameFile(before, stat) || !sameFile(lstatSync(real), stat)) return reject("not_allowed");
    if (stat.size > MAX_SENT_FILE_BYTES || stat.size > budget) return reject("too_large", stat);
    const partial = join(scope.sentFilesDir, `${PARTIAL_PREFIX}${randomBytes(8).toString("hex")}`);
    try {
      mkdirSync(partial, { mode: 0o700 });
      const copied = copyFromFd(fd, stat, join(partial, name));
      const id = sentFileId(name, copied.sha256);
      // 同样的文件已经存过（别的消息发过、重放）：用那一份，这一份扔掉
      if (resolveUpload(scope.sentFilesDir, id) !== null) {
        rmSync(partial, { recursive: true, force: true });
        // 命中已有副本：刷新目录修改时间，刚发过的不会被定期清理（file-cleanup.ts）删掉
        const now = new Date();
        utimesSync(join(scope.sentFilesDir, id), now, now);
      } else renameSync(partial, join(scope.sentFilesDir, id));
      return { status: "saved", id, size: copied.bytes, mtime: stat.mtimeMs };
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      console.error(`${LOG_PREFIX} sent file copy failed: ${path}:`, error);
      return reject("unreadable", stat);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * 找出回复里写成本机路径的链接（shared/sent-files.ts 的 localLinksOf：代码块里的不算、同一个地址只算一次），
 * 按文件头的规则逐个判断、存副本，收满 MAX_SENT_FILES_PER_MESSAGE 个为止（不算的不占名额）。
 * 返回 meta.files；一个都不算返回空数组。不抛错：单个文件出错记成 unreadable。
 */
export function shareLinkedFiles(text: string, scope: ShareScope): SentFile[] {
  if (!text.includes("](") && !text.includes("<")) return [];
  const links = localLinksOf(markdown.parse(text) as MdNode);
  if (links.length === 0) return [];
  const files: SentFile[] = [];
  let used = 0;
  // 敏感清单这条消息里只 realpath 一次（不跨消息缓存：符号链接、主目录随时可能变）
  const sensitive = sensitivePathsOf(scope.userHome);
  for (const { href, local } of links) {
    if (files.length === MAX_SENT_FILES_PER_MESSAGE) break;
    const path = existingPathOf(href, local, scope);
    const name = sanitizeFileName(basename(path));
    let outcome: Outcome;
    try {
      mkdirSync(scope.sentFilesDir, { recursive: true, mode: 0o700 });
      outcome = shareOne(path, local, name, MAX_SENT_FILES_TOTAL_BYTES - used, scope, sensitive);
    } catch (error) {
      console.error(`${LOG_PREFIX} sent file failed: ${path}:`, error);
      outcome = reject("unreadable");
    }
    if (outcome.status === "skip") continue;
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
