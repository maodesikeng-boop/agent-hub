// agent 发给用户的文件：回复里的 Markdown 链接指向本机文件时，发出时存一份副本（设计见 shared/sent-files.ts）。
// 副本放 <sentFilesDir>/<副本编号>/<文件名>，和上传的文件同一个布局，取文件也用 uploads.ts 的 resolveUpload。
// 副本编号 = hash(文件名 + 内容)：同一个文件多次发（不同消息、不同会话、重启后重放）只存一份，元数据各记各的；内容变了另存一份。
// 只分享允许的文件夹里的普通文件（isShareable），先 realpath 再比对；打开后 fstat 确认，再从同一个文件句柄拷贝，防检查后被换掉。
// （Node 24 在 macOS 上的 COPYFILE_FICLONE 实际不克隆、FICLONE_FORCE 报 ENOSYS，而且按路径拷会重新打开文件，所以直接从句柄拷。）
// 拷贝和 sha256 用 fs/promises 分块异步做（单个最多 MAX_SENT_FILE_BYTES），调用方在开 SQLite 写事务之前等它做完，事务里只写结果。
//
// 哪些链接算“发文件”（不算的不进 meta.files，网页照原样显示）：
// - 路径存在、是普通文件：算。在可分享的文件夹里就存副本（太大的不存），不在就写“不在可分享的文件夹里”；
// - 路径存在、不是普通文件（文件夹、管道）：在可分享的文件夹里写“不是文件”，不在（/、/usr 之类）不算；
// - 路径不存在：用绝对路径（/、file://、~/）写的、而且落在可分享的文件夹里，写“没找到文件”；别的（/login 这种站内链接、
//   不存在的相对路径）不算。
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
  VENDOR_LIST,
} from "../shared/index.ts";
import { resolveUpload, sanitizeFileName } from "./uploads.ts";
import {
  isPathInsideOrEqual,
  normalizePathForComparison,
  openRegularFileNoFollow,
  renameWithWindowsRetry,
} from "./platform/index.ts";

/**
 * 不管允许的文件夹怎么配（项目文件夹是 ~ 或 /、附加了家目录），这些始终不能分享：凭据清单（shared/secret-paths.ts，只读 Worker 也禁读）
 * + 名单里各家厂商的整个配置目录（spec 的 home.dirs，会话记录也不给网页看）。
 * 写家目录下的相对路径，比对时 realpath（是符号链接的按它指向的地方）。
 */
export const SENSITIVE_HOME_PATHS: readonly string[] = [...CREDENTIAL_HOME_PATHS, ...VENDOR_LIST.flatMap((spec) => spec.home.dirs)];
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
  if (process.platform === "win32") {
    return isPathInsideOrEqual(parent, child);
  }
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
 * 在数据目录里的只认 dataExceptions，而且要在 Worker 的读边界之内；其余要在某个允许的文件夹里。sensitive 不传就现算（单个路径判断用）；一条消息里判断多个链接时算一次传下去。
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
  if (dataHome !== null && within(real, dataHome)) {
    // 数据目录里分享的不能超出 Worker 的读边界（shared/write-scope.ts 的 DATA_DIR_READABLE_ENTRIES）：state/、backups/ 等哪怕配进了例外也不分享
    const readable = reals(DATA_DIR_READABLE_ENTRIES.map((entry) => join(dataHome, entry)));
    return readable.some((dir) => within(real, dir)) && reals(scope.dataExceptions).some((dir) => within(real, dir));
  }
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
 * 从句柄分块拷最多 stat.size 个字节到新文件（不存在才建，0600），边拷边算 sha256，修改时间设成原文件的。
 * 拷的时候源文件被截断，就拷到读不出为止：返回实际拷到的字节数。
 */
export async function copyFromHandle(source: FileHandle, stat: Stats, dest: string): Promise<{ bytes: number; sha256: string }> {
  const out = await open(dest, "wx", 0o600);
  const hash = createHash("sha256");
  let position = 0;
  try {
    const buffer = Buffer.allocUnsafe(Math.min(SENT_FILE_COPY_CHUNK_BYTES, Math.max(1, stat.size)));
    while (position < stat.size) {
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

/** skip：不算发文件（见文件头的规则），不进 meta.files。 */
type Outcome =
  | { status: "skip" }
  | { status: Exclude<SentFileStatus, "saved">; size: number | null; mtime: number | null }
  | { status: "saved"; id: string; size: number; mtime: number };

const reject = (status: Exclude<SentFileStatus, "saved">, stat?: Stats): Extract<Outcome, { size: number | null }> => ({
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

async function realOrNullAsync(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** 处理一个链接：判断、开、拷。budget 是这条消息还能拷多少字节。 */
async function shareOne(path: string, local: LocalHref, name: string, budget: number, scope: ShareScope, sensitive: readonly string[]): Promise<Outcome> {
  const real = await realOrNullAsync(path);
  if (real === null) return local.kind !== "relative" && isShareable(looseRealpath(path), scope, sensitive) ? reject("missing") : { status: "skip" };
  let before: Stats;
  try {
    before = await statAsync(real);
  } catch {
    return { status: "skip" };
  }
  if (!isShareable(real, scope, sensitive)) return before.isFile() ? reject("not_allowed") : { status: "skip" };
  if (!before.isFile()) return reject("not_file", before);
  let handle: FileHandle;
  try {
    handle = await openRegularFileNoFollow(real, { nonBlock: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return reject(code === "ENOENT" ? "missing" : code === "ELOOP" ? "not_allowed" : "unreadable");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return reject("not_file", stat);
    // 打开的必须还是检查过的那个文件：检查和 open 之间路径被换掉的，当不在允许的文件夹里
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
      const copied = await copyFromHandle(handle, stat, join(partial, name));
      const id = sentFileId(name, copied.sha256);
      // 同样的文件已经存过（别的消息发过、重放）：用那一份，这一份扔掉
      if (resolveUpload(scope.sentFilesDir, id) !== null) {
        await rm(partial, { recursive: true, force: true });
        // 命中已有副本：刷新目录修改时间，刚发过的不会被定期清理（file-cleanup.ts）删掉
        const now = new Date();
        await utimes(join(scope.sentFilesDir, id), now, now);
      } else await renameWithWindowsRetry(partial, join(scope.sentFilesDir, id));
      return { status: "saved", id, size: copied.bytes, mtime: stat.mtimeMs };
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      console.error(`${LOG_PREFIX} sent file copy failed: ${path}:`, error);
      return reject("unreadable", stat);
    }
  } finally {
    await handle.close();
  }
}

/** 回复里写成本机路径的链接（shared/sent-files.ts 的 localLinksOf：代码块里的不算、同一个地址只算一次）。只解析 Markdown，不碰文件。 */
export function localLinksIn(text: string): LocalLink[] {
  if (!text.includes("](") && !text.includes("<")) return [];
  return localLinksOf(markdown.parse(text) as MdNode, text);
}

export type LocalLink = { href: string; local: LocalHref };

/**
 * 按文件头的规则逐个判断、存副本，收满 MAX_SENT_FILES_PER_MESSAGE 个为止。一个一个拷（预算按前面实际拷到的算）。
 * strict 是 false（回复里的链接）：不算发文件的不进结果、不占名额；strict 是 true（--file 指名要发的）：也记一项，写清为什么没存。
 */
async function shareLinks(links: readonly LocalLink[], scope: ShareScope, strict: boolean): Promise<SentFile[]> {
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
      await mkdir(scope.sentFilesDir, { recursive: true, mode: 0o700 });
      outcome = await shareOne(path, local, name, MAX_SENT_FILES_TOTAL_BYTES - used, scope, sensitive);
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

/**
 * 回复里的本机文件链接（localLinksIn 解析出的）按文件头的规则逐个判断、存副本。返回 meta.files；一个都不算返回空数组。
 * 不抛错：单个文件出错记成 unreadable。
 */
export function shareLinkedFiles(links: readonly LocalLink[], scope: ShareScope): Promise<SentFile[]> {
  if (links.length === 0) return Promise.resolve([]);
  return shareLinks(links, scope, false);
}

const WIN_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * hub ask / router report 的 --file：路径原样（不当 Markdown、不做 %xx 解码）按同一套规则存副本。
 * 后置：结果和 paths 一一对应、顺序相同；没存下的写明原因（没找到、不在可分享的文件夹里……）。不抛错。
 */
export function shareFilePaths(paths: readonly string[], scope: ShareScope): Promise<SentFile[]> {
  const links = paths.map((path) => ({
    href: path,
    local: { kind: isAbsolute(path) || WIN_ABSOLUTE.test(path) ? "absolute" : "relative", path } as LocalHref,
  }));
  return shareLinks(links, scope, true);
}

/** 正文里的图片和链接，按文档顺序：地址和给人看的文字（链接的文字、图片的 alt）。代码块里的不算。 */
export function markdownLinksOf(text: string): { href: string; label: string }[] {
  if (!text.includes("](")) return [];
  const textOf = (node: MdNode): string => node.value ?? (node.children ?? []).map(textOf).join("");
  return linkNodesOf(markdown.parse(text) as MdNode).map((node) => ({
    href: node.url!,
    label: (node.type === "image" ? (node.alt ?? "") : textOf(node)).trim(),
  }));
}
