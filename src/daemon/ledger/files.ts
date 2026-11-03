// 账本碰磁盘的小工具：文件夹路径解析（ResolveFolder 的默认实现）、原子写文件、内容哈希、hub_calls 的截断。
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { utf8Bytes } from "../../shared/domain.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import type { ResolveFolder } from "../../shared/ledger.ts";
import { HUB_CALL_FIELD_MAX_BYTES, MAX_PATH_BYTES } from "../../shared/limits.ts";

/** 开头的 `~` 或 `~/` 换成 userHome；`~别人` 不展开。 */
export function expandHome(path: string, userHome: string): string {
  if (path === "~") return userHome;
  if (path.startsWith("~/")) return join(userHome, path.slice(2));
  return path;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

/** realpath 失败（目录不在了）就退回 path.resolve 之后的字面路径：detach 已经删掉的文件夹用。 */
export function realpathOrLiteral(path: string, userHome: string): string {
  const literal = resolve(expandHome(path.trim(), userHome));
  try {
    return realpathSync.native(literal);
  } catch {
    return literal;
  }
}

export interface ResolveFolderOptions {
  /** 数据目录（~/.agent-hub），里面的文件夹不能挂到项目上。 */
  dataHome: string;
  /** 展开 `~` 用，默认 os.homedir()。 */
  userHome?: string;
}

/**
 * ResolveFolder 的默认实现（见 src/shared/ledger.ts）：展开开头的 ~、必须是绝对路径、realpathSync.native、必须是目录、
 * 不能在数据目录里面（数据目录同样 realpath 之后再比）。不对就抛 LedgerRequestError("invalid", 原因)。
 */
export function createResolveFolder(options: ResolveFolderOptions): ResolveFolder {
  const userHome = options.userHome ?? homedir();
  return (raw) => {
    const trimmed = raw.trim();
    if (trimmed === "") throw new LedgerRequestError("invalid", "文件夹路径是空的");
    if (utf8Bytes(trimmed) > MAX_PATH_BYTES) throw new LedgerRequestError("invalid", `文件夹路径太长（超过 ${MAX_PATH_BYTES} 字节）`);
    const expanded = expandHome(trimmed, userHome);
    if (!isAbsolute(expanded)) throw new LedgerRequestError("invalid", `请写绝对路径（可以用 ~ 开头）：${trimmed}`);
    const literal = resolve(expanded);
    let real: string;
    try {
      real = realpathSync.native(literal);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") throw new LedgerRequestError("invalid", `文件夹不存在，请先建好：${literal}`);
      throw new LedgerRequestError("invalid", `文件夹读不了（${code ?? String(error)}）：${literal}`);
    }
    if (!statSync(real).isDirectory()) throw new LedgerRequestError("invalid", `这不是文件夹，是一个文件：${real}`);
    const dataHome = realpathOrLiteral(options.dataHome, userHome);
    if (real === dataHome || real.startsWith(dataHome.endsWith(sep) ? dataHome : dataHome + sep)) {
      throw new LedgerRequestError("invalid", `不能用 agent-hub 自己的数据目录：${real}`);
    }
    return real;
  };
}

/** 原子写一个文件：同目录下的临时文件 + 改名。目录不在就建（0700），文件 0600。 */
export function writeFileAtomic(file: string, content: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** sha256 十六进制（pms.persona_file_hash 用）。 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 按 UTF-8 字节截在字符边界上，末尾加“…（截断，原长 N 字节）”（见 domain.ts 的 HubCall）。没超就原样返回。 */
export function truncateField(text: string, maxBytes = HUB_CALL_FIELD_MAX_BYTES): string {
  const total = utf8Bytes(text);
  if (total <= maxBytes) return text;
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const n = utf8Bytes(ch);
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return `${out}…（截断，原长 ${total} 字节）`;
}

/** hub_calls.args：每个字符串字段按 truncateField 截断。 */
export function summarizeArgs(args: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = typeof value === "string" ? truncateField(value) : value;
  return out;
}
