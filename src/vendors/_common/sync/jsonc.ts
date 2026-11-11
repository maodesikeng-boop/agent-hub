// 保留注释、缩进与无关字段（如登录态 oauthAccount）的 JSON / JSONC 读写与局部补丁工具。
import { existsSync, readFileSync, statSync } from "node:fs";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { MAX_VENDOR_SYNC_CONFIG_BYTES } from "../../../shared/index.ts";

export interface JsoncDocument {
  exists: boolean;
  raw: string;
  data: Record<string, unknown>;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualJson(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqualJson(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

export function readJsoncObjectFile(filePath: string): JsoncDocument {
  if (!existsSync(filePath)) {
    return { exists: false, raw: "", data: {} };
  }
  const st = statSync(filePath);
  if (st.size > MAX_VENDOR_SYNC_CONFIG_BYTES) {
    throw new Error(`配置文件过大（超过 ${MAX_VENDOR_SYNC_CONFIG_BYTES} 字节）：${filePath}`);
  }
  const raw = readFileSync(filePath, "utf8");
  if (raw.trim() === "") {
    return { exists: true, raw, data: {} };
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(`解析 JSON/JSONC 失败（${filePath}，错误 ${printParseErrorCode(first.error)}）`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`配置文件顶层必须是 JSON 对象：${filePath}`);
  }
  return { exists: true, raw, data: parsed };
}

/**
 * 局部补丁顶层 `<serversKey>`（默认 `"mcpServers"`）下的单个服务键：
 * - `upsert` 只增补缺失的键：已有同名键一律跳过不动（连条目内部注释、键顺序、本家独有字段都原样保留）；
 * - `removeNames` 是用户在预览里主动取消勾选的键，才会删除；
 * - 顶层其他字段（如账号登录态、个人偏好）与所有行/块注释完整保留；
 * - 若最终无需任何改动（或文件原本不存在且本次无新增项），返回 `null`。
 */
export function patchJsoncMapEntries(input: {
  doc: JsoncDocument;
  mapKey?: string;
  upsert: Readonly<Record<string, Record<string, unknown>>>;
  removeNames: ReadonlySet<string>;
}): string | null {
  const { doc, mapKey = "mcpServers", upsert, removeNames } = input;
  const existingMap = isPlainObject(doc.data[mapKey]) ? (doc.data[mapKey] as Record<string, unknown>) : {};
  const upsertNames = Object.keys(upsert).sort();

  if (!doc.exists && upsertNames.length === 0) {
    return null;
  }

  const baseText = doc.raw.trim() === "" ? "{}\n" : doc.raw;
  const eol = baseText.includes("\r\n") ? "\r\n" : "\n";
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol };

  let current = baseText;
  let mutated = false;

  for (const name of removeNames) {
    if (Object.prototype.hasOwnProperty.call(upsert, name)) continue;
    if (!Object.prototype.hasOwnProperty.call(existingMap, name)) continue;
    const edits = modify(current, [mapKey, name], undefined, { formattingOptions });
    if (edits.length > 0) {
      current = applyEdits(current, edits);
      mutated = true;
    }
  }

  for (const name of upsertNames) {
    // 并集只增补：同名键已存在（不论内容是否相同、是否被禁用、是否带本家独有字段）一律原样保留，绝不覆盖
    if (Object.prototype.hasOwnProperty.call(existingMap, name)) continue;
    const edits = modify(current, [mapKey, name], upsert[name]!, { formattingOptions });
    if (edits.length > 0) {
      current = applyEdits(current, edits);
      mutated = true;
    }
  }

  if (!mutated) return null;
  if (!current.endsWith("\n")) current += eol;
  return current === doc.raw && doc.exists ? null : current;
}
