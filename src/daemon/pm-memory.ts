import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  LedgerRequestError,
  PM_MEMORY_INDEX_FILE,
  PM_MEMORY_MAX_BYTES,
  PM_MEMORY_MAX_DIR_SCAN,
  PM_MEMORY_MAX_LINES,
  PM_MEMORY_MAX_SUBFILES,
  PM_MEMORY_MAX_SUBFILE_BYTES,
  PM_MEMORY_MAX_TOTAL_BYTES,
  checkPmMemoryFileName,
  utf8Bytes,
  type PmId,
  type PmMemoryFileDetail,
  type PmMemoryFileSummary,
  type PmMemoryFilesList,
} from "../shared/index.ts";
import { pmMemoryDirPath } from "../shared/paths.ts";

/** 顶层 MEMORY.md 超出 200 行或 25 KB 时附在系统提示词截断末尾的单行提示（不含换行）。 */
export const PM_MEMORY_TRUNCATION_HINT =
  "[提示：MEMORY.md 已超出 200 行或 25 KB 自动加载上限，此处已截断；请把具体专题拆到记忆目录同级的 <topic>.md 子文件按需查阅。]";

function codePointUtf8Bytes(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

/**
 * 拼入项目经理系统提示词（或中途性格设定更新说明）前安全截断 MEMORY.md：
 * - 同时满足 <= 200 行且 <= 25 KB（UTF-8）时原样无损返回；
 * - 任一超限时截到前 200 行以内并按完整 Unicode 码点控制在 25 KB 预算内（含末尾单行拆分提示），绝不截出半个多字节字符或孤立代理项。
 */
export function truncatePmMemoryForPrompt(raw: string): { text: string; truncated: boolean } {
  if (raw === "" || raw === PM_MEMORY_TRUNCATION_HINT) return { text: raw, truncated: false };
  const lines = raw.split("\n");
  if (
    raw.endsWith(`\n${PM_MEMORY_TRUNCATION_HINT}`) &&
    lines.length <= PM_MEMORY_MAX_LINES + 1 &&
    utf8Bytes(raw) <= PM_MEMORY_MAX_BYTES
  ) {
    return { text: raw, truncated: false };
  }
  const overLines = lines.length > PM_MEMORY_MAX_LINES;
  if (!overLines && utf8Bytes(raw) <= PM_MEMORY_MAX_BYTES) {
    return { text: raw, truncated: false };
  }

  const candidate = overLines ? lines.slice(0, PM_MEMORY_MAX_LINES).join("\n") : raw;
  const suffix = `\n${PM_MEMORY_TRUNCATION_HINT}`;
  const budgetBytes = Math.max(0, PM_MEMORY_MAX_BYTES - utf8Bytes(suffix));

  if (utf8Bytes(candidate) <= budgetBytes) {
    return {
      text: candidate.length > 0 ? `${candidate}${suffix}` : PM_MEMORY_TRUNCATION_HINT,
      truncated: true,
    };
  }

  let usedBytes = 0;
  let utf16End = 0;
  for (const ch of candidate) {
    const cp = ch.codePointAt(0)!;
    const chBytes = codePointUtf8Bytes(cp);
    if (usedBytes + chBytes > budgetBytes) break;
    usedBytes += chBytes;
    utf16End += ch.length;
  }
  const sliced = candidate.slice(0, utf16End);
  return {
    text: sliced.length > 0 ? `${sliced}${suffix}` : PM_MEMORY_TRUNCATION_HINT,
    truncated: true,
  };
}

function isMissingError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * 解析并校验 `<pmMemoryDir>/<pmId>` 的真实路径，严防目录本身或上层根被替换成符号链接逃逸。
 * `create: false` 时若目录尚未创建则返回 null。
 */
function resolveSafePmDir(pmMemoryDir: string, pmId: PmId, opts: { create: boolean }): string | null {
  try {
    const rootStat = lstatSync(pmMemoryDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new LedgerRequestError("invalid", "PM memory root directory is invalid");
    }
  } catch (err) {
    if (err instanceof LedgerRequestError) throw err;
    if (!isMissingError(err)) throw err;
    if (!opts.create) return null;
    mkdirSync(pmMemoryDir, { recursive: true, mode: 0o700 });
  }

  const realRoot = realpathSync.native(pmMemoryDir);
  const targetDir = pmMemoryDirPath(realRoot, pmId);
  try {
    const dirStat = lstatSync(targetDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new LedgerRequestError("invalid", "PM memory directory cannot be a symlink");
    }
  } catch (err) {
    if (err instanceof LedgerRequestError) throw err;
    if (!isMissingError(err)) throw err;
    if (!opts.create) return null;
    mkdirSync(targetDir, { mode: 0o700 });
  }

  const realDir = realpathSync.native(targetDir);
  if (realDir !== targetDir) {
    throw new LedgerRequestError("invalid", "PM memory directory escaped root");
  }
  return realDir;
}

/** 确保 `<pmMemoryDir>/<pmId>` 存在且非软链，返回 `realpathSync.native` 后的绝对路径（供驱动层挂载 `addDirs`）。 */
export function ensurePmMemoryDir(pmMemoryDir: string, pmId: PmId): string {
  return resolveSafePmDir(pmMemoryDir, pmId, { create: true })!;
}

function assertValidSubfileName(name: string): void {
  const err = checkPmMemoryFileName(name);
  if (err !== null || basename(name) !== name) {
    throw new LedgerRequestError("invalid", err ?? "Invalid memory file name");
  }
}

function atomicWriteRegularFile(realDir: string, fileName: string, content: string): void {
  const target = join(realDir, fileName);
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new LedgerRequestError("invalid", "Memory file cannot be a symlink");
    }
    if (realpathSync.native(target) !== target) {
      throw new LedgerRequestError("invalid", "Memory file escaped PM memory directory");
    }
  } catch (err) {
    if (err instanceof LedgerRequestError) throw err;
    if (!isMissingError(err)) throw err;
  }

  const tmp = join(realDir, `.pm-mem-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // 改名前再查一次目标未在并发窗口内被换成软链
    try {
      const stAfter = lstatSync(target);
      if (stAfter.isSymbolicLink() || !stAfter.isFile()) {
        throw new LedgerRequestError("invalid", "Memory file cannot be a symlink");
      }
    } catch (err) {
      if (err instanceof LedgerRequestError) throw err;
      if (!isMissingError(err)) throw err;
    }
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** 读取顶层 `MEMORY.md`；不存在或为软链时返回 null（软链不跟读）。 */
export function readPmMemoryIndex(pmMemoryDir: string, pmId: PmId): string | null {
  let realDir: string | null;
  try {
    realDir = resolveSafePmDir(pmMemoryDir, pmId, { create: false });
  } catch {
    return null;
  }
  if (realDir === null) return null;
  const target = join(realDir, PM_MEMORY_INDEX_FILE);
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (realpathSync.native(target) !== target) return null;
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

/** 原子写入顶层 `MEMORY.md`（写失败返回 false，不阻断上层数据库事务）。 */
export function writePmMemoryIndex(pmMemoryDir: string, pmId: PmId, content: string): boolean {
  try {
    const realDir = resolveSafePmDir(pmMemoryDir, pmId, { create: true })!;
    atomicWriteRegularFile(realDir, PM_MEMORY_INDEX_FILE, content);
    return true;
  } catch {
    return false;
  }
}

function scanSubfilesInRealDir(realDir: string): PmMemoryFilesList {
  const entries = readdirSync(realDir, { withFileTypes: true });
  const files: PmMemoryFileSummary[] = [];
  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= PM_MEMORY_MAX_DIR_SCAN) break;
    scanned++;
    if (checkPmMemoryFileName(entry.name) !== null) continue;
    const full = join(realDir, entry.name);
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      if (realpathSync.native(full) !== full) continue;
      files.push({
        name: entry.name,
        bytes: st.size,
        updatedAt: Math.trunc(st.mtimeMs),
      });
    } catch {
      // 并发删除或无权限读的项跳过
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  return { files, totalBytes };
}

/** 列出指定项目经理的扁平 `<topic>.md` 子文件（不含 `MEMORY.md`、隐藏文件与软链）。 */
export function listPmMemoryFiles(pmMemoryDir: string, pmId: PmId): PmMemoryFilesList {
  const realDir = resolveSafePmDir(pmMemoryDir, pmId, { create: false });
  if (realDir === null) return { files: [], totalBytes: 0 };
  return scanSubfilesInRealDir(realDir);
}

/** 读取单个 `<topic>.md` 子文件内容与元数据。 */
export function readPmMemoryFile(pmMemoryDir: string, pmId: PmId, name: string): PmMemoryFileDetail {
  assertValidSubfileName(name);
  const realDir = resolveSafePmDir(pmMemoryDir, pmId, { create: false });
  if (realDir === null) {
    throw new LedgerRequestError("not_found", `Memory file not found: ${name}`);
  }
  const target = join(realDir, name);
  let mtimeMs = 0;
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new LedgerRequestError("invalid", "Memory file cannot be a symlink");
    }
    if (realpathSync.native(target) !== target) {
      throw new LedgerRequestError("invalid", "Memory file escaped PM memory directory");
    }
    if (st.size > PM_MEMORY_MAX_TOTAL_BYTES) {
      throw new LedgerRequestError("invalid", "Memory file exceeds maximum readable size");
    }
    mtimeMs = Math.trunc(st.mtimeMs);
  } catch (err) {
    if (err instanceof LedgerRequestError) throw err;
    if (isMissingError(err)) throw new LedgerRequestError("not_found", `Memory file not found: ${name}`);
    throw err;
  }
  const content = readFileSync(target, "utf8");
  return {
    name,
    content,
    bytes: utf8Bytes(content),
    updatedAt: mtimeMs,
  };
}

/** 新建或更新单个 `<topic>.md` 子文件（单文件 <= 64 KB、总数 <= 50、合计 <= 1 MB）。 */
export function writePmMemoryFile(
  pmMemoryDir: string,
  pmId: PmId,
  name: string,
  content: string,
): { file: PmMemoryFileDetail; totalBytes: number } {
  assertValidSubfileName(name);
  const bytes = utf8Bytes(content);
  if (bytes > PM_MEMORY_MAX_SUBFILE_BYTES) {
    throw new LedgerRequestError("invalid", "Memory file must be 64 KB or smaller");
  }

  const realDir = resolveSafePmDir(pmMemoryDir, pmId, { create: true })!;
  const current = scanSubfilesInRealDir(realDir);
  const existing = current.files.find((f) => f.name === name);
  if (!existing && current.files.length >= PM_MEMORY_MAX_SUBFILES) {
    throw new LedgerRequestError("conflict", `At most ${PM_MEMORY_MAX_SUBFILES} memory files per PM`);
  }
  const nextTotalBytes = current.totalBytes - (existing?.bytes ?? 0) + bytes;
  if (nextTotalBytes > PM_MEMORY_MAX_TOTAL_BYTES) {
    throw new LedgerRequestError("invalid", "Total memory files exceed the 1 MB limit");
  }

  atomicWriteRegularFile(realDir, name, content);
  const st = statSync(join(realDir, name));
  return {
    file: {
      name,
      content,
      bytes,
      updatedAt: Math.trunc(st.mtimeMs),
    },
    totalBytes: nextTotalBytes,
  };
}

/** 删除单个 `<topic>.md` 子文件（拦截软链与路径穿越）。 */
export function deletePmMemoryFile(pmMemoryDir: string, pmId: PmId, name: string): void {
  assertValidSubfileName(name);
  const realDir = resolveSafePmDir(pmMemoryDir, pmId, { create: false });
  if (realDir === null) {
    throw new LedgerRequestError("not_found", `Memory file not found: ${name}`);
  }
  const target = join(realDir, name);
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new LedgerRequestError("invalid", "Memory file cannot be a symlink");
    }
    if (realpathSync.native(target) !== target) {
      throw new LedgerRequestError("invalid", "Memory file escaped PM memory directory");
    }
  } catch (err) {
    if (err instanceof LedgerRequestError) throw err;
    if (isMissingError(err)) throw new LedgerRequestError("not_found", `Memory file not found: ${name}`);
    throw err;
  }
  unlinkSync(target);
}
