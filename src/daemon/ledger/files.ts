import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { utf8Bytes } from "../../shared/domain.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import type { ResolveFolder } from "../../shared/ledger.ts";
import { HUB_CALL_FIELD_MAX_BYTES } from "../../shared/limits.ts";
import { PRODUCT_ID } from "../../shared/names.ts";
import { assertHubLimit } from "./context.ts";

function expandHome(path: string, userHome: string): string {
  if (path === "~") return userHome;
  if (path.startsWith("~/")) return join(userHome, path.slice(2));
  return path;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

export function realpathOrLiteral(path: string, userHome: string): string {
  const literal = resolve(expandHome(path.trim(), userHome));
  try {
    return realpathSync.native(literal);
  } catch {
    return literal;
  }
}

export interface ResolveFolderOptions {
  dataHome: string;
  userHome?: string;
}

export function createResolveFolder(options: ResolveFolderOptions): ResolveFolder {
  const userHome = options.userHome ?? homedir();
  return (raw) => {
    const trimmed = raw.trim();
    if (trimmed === "") throw new LedgerRequestError("invalid", "文件夹路径是空的");
    assertHubLimit("project.folder", trimmed);
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
      throw new LedgerRequestError("invalid", `不能用 ${PRODUCT_ID} 自己的数据目录：${real}`);
    }
    return real;
  };
}

/** Atomic write through a temp file in the same directory plus rename. */
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

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

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

export function summarizeArgs(args: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = typeof value === "string" ? truncateField(value) : value;
  return out;
}
